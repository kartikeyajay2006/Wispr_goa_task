from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.audit.chain import verify_audit_chain
from backend.db.session import get_session
from backend.models.entities import AuditEvent, DeletionRequest

router = APIRouter(prefix="/requests", tags=["audit"])


@router.get("/{request_id}/audit")
async def get_audit(request_id: UUID, session: AsyncSession = Depends(get_session)):
    if await session.get(DeletionRequest, request_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Request not found")
    events = (await session.execute(select(AuditEvent).where(AuditEvent.request_id == request_id).order_by(AuditEvent.timestamp.asc(), AuditEvent.event_id.asc()))).scalars().all()
    return {"request_id": str(request_id), "valid": verify_audit_chain(events), "events": [{"event_id": str(event.event_id), "request_id": str(event.request_id), "timestamp": event.timestamp.isoformat(), "actor": event.actor, "action": event.action, "target": event.target, "result": event.result, "previous_hash": event.previous_hash, "event_hash": event.event_hash} for event in events]}
