from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.entities import Approval, DeletionPlan, DeletionRequest, DiscoveredResource
from backend.models.risk import BlastRadiusReport
from backend.models.entities import SandboxRun


class ApprovalGate:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def current_review(self, request_id: UUID) -> dict:
        request = await self.session.get(DeletionRequest, request_id)
        if request is None:
            raise LookupError("Request not found")
        plan_result = await self.session.execute(select(DeletionPlan).where(DeletionPlan.request_id == request_id).order_by(DeletionPlan.version.desc()).limit(1))
        plan = plan_result.scalar_one_or_none()
        if plan is None:
            raise LookupError("Deletion plan not found")
        report_result = await self.session.execute(select(BlastRadiusReport).where(BlastRadiusReport.request_id == request_id, BlastRadiusReport.plan_id == plan.id).limit(1))
        report = report_result.scalar_one_or_none()
        resources_result = await self.session.execute(select(DiscoveredResource).where(DiscoveredResource.request_id == request_id).order_by(DiscoveredResource.id))
        resources = list(resources_result.scalars().all())
        sandbox_result = await self.session.execute(select(SandboxRun).where(SandboxRun.request_id == request_id, SandboxRun.plan_id == plan.id).order_by(SandboxRun.executed_at.desc().nullslast()).limit(1))
        sandbox = sandbox_result.scalar_one_or_none()
        approval_result = await self.session.execute(select(Approval).where(Approval.request_id == request_id).order_by(Approval.approved_at.desc()).limit(1))
        approval = approval_result.scalar_one_or_none()
        if approval and (approval.plan_hash != plan.plan_hash or report is None or approval.blast_radius_hash != report.blast_radius_hash) and approval.status == "approved":
            approval.status = "invalidated"
            await self.session.commit()
        actions = [{"id": str(action.id), "system": action.system, "action_type": action.action_type, "target": action.target, "reason": action.reason, "reversible": action.reversible, "requires_approval": action.requires_approval, "status": action.status} for action in plan.actions]
        return {"request": {"id": str(request.id), "customer_id": request.customer_id, "requested_by": request.requested_by, "status": request.status}, "discovered_data": [{"id": str(resource.id), "system": resource.system, "resource_type": resource.resource_type, "resource_id": resource.resource_id, "classification": resource.classification, "metadata": resource.metadata_json, "evidence": resource.evidence} for resource in resources], "plan": {"id": str(plan.id), "version": plan.version, "plan_hash": plan.plan_hash, "actions": actions}, "sandbox_verification": {"status": sandbox.status, "tests": sandbox.tests, "warnings": sandbox.warnings, "failures": sandbox.failures} if sandbox else None, "blast_radius": report.report if report else None, "warnings": (report.report.get("warnings", []) if report else []) + (sandbox.warnings if sandbox else []), "retained_data": [action for action in actions if action["action_type"] in {"RETAIN", "NO_ACTION"}], "irreversible_actions": [action for action in actions if not action["reversible"]], "approval": self._approval_payload(approval)}

    async def approve(self, request_id: UUID, approver_id: str, plan_hash: str, blast_radius_hash: str) -> dict:
        review = await self.current_review(request_id)
        current_plan_hash = review["plan"]["plan_hash"]
        current_blast_hash = (review["blast_radius"] or {}).get("blast_radius_hash")
        if plan_hash != current_plan_hash or blast_radius_hash != current_blast_hash:
            raise ValueError("Approval hashes do not match the current plan and blast radius")
        approval = Approval(request_id=request_id, approver_id=approver_id, plan_hash=plan_hash, blast_radius_hash=blast_radius_hash, approved_at=datetime.now(timezone.utc), status="approved")
        self.session.add(approval)
        await self.session.flush()
        return self._approval_payload(approval)

    async def reject(self, request_id: UUID, approver_id: str) -> dict:
        if await self.session.get(DeletionRequest, request_id) is None:
            raise LookupError("Request not found")
        approval = Approval(request_id=request_id, approver_id=approver_id, plan_hash="rejected", blast_radius_hash="rejected", approved_at=datetime.now(timezone.utc), status="rejected")
        self.session.add(approval)
        await self.session.flush()
        return self._approval_payload(approval)

    @staticmethod
    def _approval_payload(approval: Approval | None) -> dict | None:
        if approval is None:
            return None
        return {"request_id": str(approval.request_id), "approver_id": approval.approver_id, "plan_hash": approval.plan_hash, "blast_radius_hash": approval.blast_radius_hash, "timestamp": approval.approved_at.isoformat(), "status": approval.status}
