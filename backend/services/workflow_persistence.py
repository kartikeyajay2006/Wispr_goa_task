from __future__ import annotations

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.workflow import WorkflowRun


async def save_workflow_state(session: AsyncSession, request_id: UUID, state: dict) -> WorkflowRun:
    result = await session.execute(select(WorkflowRun).where(WorkflowRun.request_id == request_id))
    record = result.scalar_one_or_none()
    if record is None:
        record = WorkflowRun(request_id=request_id, state=state, current_status=state["current_status"])
        session.add(record)
    else:
        record.state = state
        record.current_status = state["current_status"]
    await session.commit()
    await session.refresh(record)
    return record


async def load_workflow_state(session: AsyncSession, request_id: UUID) -> dict | None:
    result = await session.execute(select(WorkflowRun).where(WorkflowRun.request_id == request_id))
    record = result.scalar_one_or_none()
    return record.state if record else None
