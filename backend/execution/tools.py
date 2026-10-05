from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Protocol
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.models.entities import Approval, AuditEvent, DeletionRequest, ExecutionResult, PlannedAction
from backend.models.workflow import WorkflowRun


class ControlledExecutionError(RuntimeError):
    """Raised when an action cannot be proven safe against its approved plan."""


@dataclass(frozen=True, slots=True)
class ExecutionCommand:
    request_id: UUID
    action_id: UUID
    approver_id: str
    plan_hash: str
    blast_radius_hash: str
    expected_target: str
    expected_row_count: int
    customer_id: str
    resource_version: str | None = None


@dataclass(frozen=True, slots=True)
class ExecutionOutcome:
    idempotency_key: str
    status: str
    affected_rows: int
    audit_event_id: UUID


@dataclass(frozen=True, slots=True)
class RevalidationSnapshot:
    target: str
    row_count: int
    customer_id: str
    resource_version: str | None
    blast_radius_hash: str
    plan_hash: str
    approval_plan_hash: str
    approval_blast_radius_hash: str
    schema_fingerprint: str
    approved_schema_fingerprint: str


class RevalidationAdapter(Protocol):
    async def revalidate(self, *, command: ExecutionCommand, plan_hash: str, blast_radius_hash: str) -> RevalidationSnapshot: ...


def revalidation_mismatches(command: ExecutionCommand, snapshot: RevalidationSnapshot) -> dict[str, bool]:
    return {
        "target": snapshot.target == command.expected_target,
        "row_count": snapshot.row_count == command.expected_row_count,
        "customer_scope": snapshot.customer_id == command.customer_id,
        "resource_version": command.resource_version is None or snapshot.resource_version == command.resource_version,
        "blast_radius_hash": snapshot.blast_radius_hash == command.blast_radius_hash,
        "plan_hash": snapshot.plan_hash == command.plan_hash,
        "approval_plan_hash": snapshot.approval_plan_hash == command.plan_hash,
        "approval_blast_radius_hash": snapshot.approval_blast_radius_hash == command.blast_radius_hash,
        "schema_fingerprint": snapshot.schema_fingerprint == snapshot.approved_schema_fingerprint,
    }


class PostgresWriteAdapter(Protocol):
    async def delete_postgres_record(self, *, target: str, customer_id: str, expected_row_count: int, resource_version: str | None) -> int: ...
    async def anonymize_postgres_record(self, *, target: str, customer_id: str, expected_row_count: int, resource_version: str | None) -> int: ...


class S3WriteAdapter(Protocol):
    async def delete_s3_object(self, *, target: str, customer_id: str, expected_row_count: int, resource_version: str | None) -> int: ...


class ControlledExecutionTools:
    """Narrow, approval-bound execution tools. No SQL or shell input is accepted."""

    def __init__(self, session: AsyncSession, postgres: PostgresWriteAdapter, s3: S3WriteAdapter, revalidator: RevalidationAdapter | None = None):
        self.session = session
        self.postgres = postgres
        self.s3 = s3
        self.revalidator = revalidator

    async def delete_postgres_record(self, command: ExecutionCommand) -> ExecutionOutcome:
        return await self._execute(command, "DELETE_RECORD", self.postgres.delete_postgres_record)

    async def anonymize_postgres_record(self, command: ExecutionCommand) -> ExecutionOutcome:
        return await self._execute(command, "ANONYMIZE_RECORD", self.postgres.anonymize_postgres_record)

    async def delete_s3_object(self, command: ExecutionCommand) -> ExecutionOutcome:
        return await self._execute(command, "DELETE_S3_OBJECT", self.s3.delete_s3_object)

    async def _execute(self, command: ExecutionCommand, expected_action: str, operation: Any) -> ExecutionOutcome:
        action = (await self.session.execute(select(PlannedAction).options(selectinload(PlannedAction.plan)).where(PlannedAction.id == command.action_id))).scalar_one_or_none()
        request = await self.session.get(DeletionRequest, command.request_id)
        if request is None or action is None or action.plan is None or action.plan.request_id != command.request_id:
            raise ControlledExecutionError("Request or planned action is not active")
        if request.status in {"completed", "failed", "blocked", "rejected"}:
            raise ControlledExecutionError("Request is not executable")
        if action.action_type != expected_action or action.target != command.expected_target:
            raise ControlledExecutionError("Action type or target is outside the approved plan")
        if action.policy_decision not in {"ALLOW", "ALLOW_WITH_APPROVAL", "ALLOW_WITH_APPROVAL"}:
            raise ControlledExecutionError("Policy does not allow this action")
        approval = (await self.session.execute(select(Approval).where(Approval.request_id == command.request_id, Approval.status == "approved", Approval.plan_hash == command.plan_hash, Approval.blast_radius_hash == command.blast_radius_hash).order_by(Approval.approved_at.desc()).limit(1))).scalar_one_or_none()
        if approval is None or approval.approver_id != command.approver_id or action.plan.plan_hash != command.plan_hash:
            raise ControlledExecutionError("Active approval does not match the command")
        if self.revalidator is None:
            raise ControlledExecutionError("Pre-execution revalidation is not configured")
        snapshot = await self.revalidator.revalidate(command=command, plan_hash=command.plan_hash, blast_radius_hash=command.blast_radius_hash)
        mismatches = revalidation_mismatches(command, snapshot)
        if not all(mismatches.values()):
            await self._return_to_sandbox(request, mismatches)
            raise ControlledExecutionError("Revalidation failed; workflow returned to SANDBOX_VERIFICATION")
        idempotency_key = hashlib.sha256(f"{command.request_id}:{command.action_id}:{command.plan_hash}:{command.blast_radius_hash}".encode()).hexdigest()
        existing = (await self.session.execute(select(ExecutionResult).where(ExecutionResult.idempotency_key == idempotency_key).limit(1))).scalar_one_or_none()
        if existing is not None:
            audit = (await self.session.execute(select(AuditEvent).where(AuditEvent.event_hash == existing.audit_event_hash))).scalar_one()
            return ExecutionOutcome(idempotency_key, existing.status, existing.affected_records, audit.event_id)
        affected = await operation(target=command.expected_target, customer_id=command.customer_id, expected_row_count=command.expected_row_count, resource_version=command.resource_version)
        if affected != command.expected_row_count:
            raise ControlledExecutionError("Observed row count differs from the approved expectation")
        now = datetime.now(timezone.utc)
        previous = (await self.session.execute(select(AuditEvent).where(AuditEvent.request_id == command.request_id).order_by(AuditEvent.timestamp.desc()).limit(1))).scalar_one_or_none()
        previous_hash = previous.event_hash if previous else "GENESIS"
        result_payload = {"status": "completed", "affected_records": affected, "idempotency_key": idempotency_key}
        event_hash = hashlib.sha256(json.dumps({"request_id": str(command.request_id), "action": expected_action, "target": command.expected_target, "result": result_payload, "previous_hash": previous_hash}, sort_keys=True).encode()).hexdigest()
        event = AuditEvent(request_id=command.request_id, actor=command.approver_id, action=expected_action, target=command.expected_target, result=result_payload, previous_hash=previous_hash, event_hash=event_hash, timestamp=now)
        execution = ExecutionResult(request_id=command.request_id, action_id=command.action_id, status="completed", affected_records=affected, completed_at=now, idempotency_key=idempotency_key, audit_event_hash=event_hash)
        self.session.add_all([event, execution])
        await self.session.commit()
        return ExecutionOutcome(idempotency_key, "completed", affected, event.event_id)

    async def _return_to_sandbox(self, request: DeletionRequest, mismatches: dict[str, bool]) -> None:
        run = (await self.session.execute(select(WorkflowRun).where(WorkflowRun.request_id == request.id).limit(1))).scalar_one_or_none()
        if run is not None:
            run.current_status = "SANDBOX_VERIFICATION"
            state = dict(run.state or {})
            state["current_status"] = "SANDBOX_VERIFICATION"
            state["errors"] = ["pre_execution_revalidation_failed"]
            state["revalidation_mismatches"] = [key for key, valid in mismatches.items() if not valid]
            state["approval"] = {"status": "invalidated"}
            run.state = state
        request.status = "pending"
        await self.session.commit()
