from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Literal, Protocol
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from backend.dependencies.graph import DependencyGraph
from backend.policies.engine import Decision, PolicyResult

ActionType = Literal["DELETE_RECORD", "ANONYMIZE_RECORD", "DELETE_S3_OBJECT", "RETAIN", "NO_ACTION"]


class PlannedAction(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    action_id: UUID = Field(default_factory=uuid4)
    system: str = Field(min_length=1, max_length=100)
    action_type: ActionType
    target: str = Field(min_length=1, max_length=500)
    evidence: dict[str, Any] = Field(min_length=1)
    reason: str = Field(min_length=1)
    reversible: bool
    requires_approval: bool
    expected_effect: str = Field(min_length=1)
    verification_criteria: list[str] = Field(min_length=1)
    rollback_strategy: str = Field(min_length=1)
    policy_decision: str = Field(min_length=1)


class DeletionPlan(BaseModel):
    model_config = ConfigDict(extra="forbid")
    plan_id: UUID = Field(default_factory=uuid4)
    request_id: UUID
    version: int = Field(default=1, ge=1)
    actions: list[PlannedAction]
    plan_hash: str
    generated_at: datetime


class PlannerModel(Protocol):
    async def propose(self, resources: list[Any], graph: DependencyGraph, policies: list[PolicyResult]) -> Any: ...


class DeletionPlanner:
    def __init__(self, model: PlannerModel | None = None):
        self._model = model

    async def plan(self, request_id: UUID, resources: list[Any], graph: DependencyGraph, policies: list[PolicyResult]) -> DeletionPlan:
        actions: list[PlannedAction]
        if self._model is not None:
            proposal = await self._model.propose(resources, graph, policies)
            actions = self._validate_model_actions(proposal, policies)
        else:
            actions = self._fallback(resources, graph, policies)
        return DeletionPlan(request_id=request_id, actions=actions, plan_hash=self._hash_actions(actions), generated_at=datetime.now(timezone.utc))

    def _validate_model_actions(self, proposal: Any, policies: list[PolicyResult]) -> list[PlannedAction]:
        raw_actions = proposal.get("actions") if isinstance(proposal, dict) else proposal
        if not isinstance(raw_actions, list):
            raise ValueError("Planner output must contain an actions list")
        try:
            actions = [PlannedAction.model_validate(item) for item in raw_actions]
        except ValidationError as error:
            raise ValueError(f"Invalid planner action: {error}") from error
        self._assert_policy_bound(actions, policies)
        return actions

    @staticmethod
    def _assert_policy_bound(actions: list[PlannedAction], policies: list[PolicyResult]) -> None:
        denied = {policy.policy_id for policy in policies if policy.decision is Decision.DENY}
        allowed = {policy.policy_id for policy in policies if policy.decision in {Decision.ALLOW, Decision.ALLOW_WITH_APPROVAL}}
        for action in actions:
            if action.policy_decision in denied and action.action_type not in {"RETAIN", "NO_ACTION"}:
                raise ValueError(f"Planner action conflicts with denied policy {action.policy_decision}")
            if action.action_type in {"DELETE_RECORD", "ANONYMIZE_RECORD", "DELETE_S3_OBJECT"} and action.policy_decision not in allowed:
                raise ValueError(f"Planner action lacks an allowing policy decision: {action.policy_decision}")

    @staticmethod
    def _fallback(resources: list[Any], graph: DependencyGraph, policies: list[PolicyResult]) -> list[PlannedAction]:
        policies_by_target = {policy.policy_id: policy for policy in policies}
        actions: list[PlannedAction] = []
        for resource in resources:
            unsafe = resource.resource_id in graph.unsafe_resources
            policy = next((item for item in policies if item.decision is Decision.DENY and item.policy_id == resource.resource_id), None)
            if unsafe or policy:
                action_type: ActionType = "RETAIN"
                decision = policy or PolicyResult(Decision.DENY, "DEPENDENCY_RISK", "Dependency graph marks resource unsafe", "high")
            elif resource.classification == "personal_data":
                action_type = "DELETE_S3_OBJECT" if resource.system.lower() in {"s3", "minio"} else "DELETE_RECORD"
                decision = next((item for item in policies if item.decision in {Decision.ALLOW, Decision.ALLOW_WITH_APPROVAL}), PolicyResult(Decision.ALLOW_WITH_APPROVAL, "DEFAULT_DESTRUCTIVE_REVIEW", "Destructive action requires approval", "high"))
            else:
                action_type = "NO_ACTION"
                decision = PolicyResult(Decision.ALLOW, "DEFAULT_RETENTION", "No deletion strategy applies", "low")
            actions.append(PlannedAction(system=resource.system, action_type=action_type, target=resource.resource_id, evidence=resource.evidence, reason=decision.reason, reversible=action_type in {"RETAIN", "NO_ACTION", "ANONYMIZE_RECORD"}, requires_approval=action_type in {"DELETE_RECORD", "DELETE_S3_OBJECT", "ANONYMIZE_RECORD"}, expected_effect="Resource reaches the selected retention strategy", verification_criteria=["Connector rescan returns the expected post-action state"], rollback_strategy="Restore from the verified request backup" if action_type not in {"RETAIN", "NO_ACTION"} else "No rollback required", policy_decision=decision.policy_id))
        return actions

    @staticmethod
    def _hash_actions(actions: list[PlannedAction]) -> str:
        canonical = json.dumps([action.model_dump(mode="json", exclude={"action_id"}) for action in actions], sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(canonical.encode()).hexdigest()
