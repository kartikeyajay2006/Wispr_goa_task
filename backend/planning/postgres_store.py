from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.entities import DeletionPlan as DeletionPlanRow, PlannedAction as PlannedActionRow
from .planner import DeletionPlan


class PostgresPlanStore:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def save(self, plan: DeletionPlan) -> None:
        plan_row = DeletionPlanRow(id=plan.plan_id, request_id=plan.request_id, version=plan.version, plan_hash=plan.plan_hash, status="pending", generated_at=plan.generated_at)
        self._session.add(plan_row)
        self._session.add_all([PlannedActionRow(id=action.action_id, plan_id=plan.plan_id, system=action.system, action_type=action.action_type, target=action.target, reason=action.reason, reversible=action.reversible, requires_approval=action.requires_approval, status="planned", evidence=action.evidence, expected_effect=action.expected_effect, verification_criteria=action.verification_criteria, rollback_strategy=action.rollback_strategy, policy_decision=action.policy_decision) for action in plan.actions])
        await self._session.flush()
