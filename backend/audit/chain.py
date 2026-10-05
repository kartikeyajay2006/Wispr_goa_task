from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Iterable
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.entities import AuditEvent


class AuditChainError(ValueError):
    pass


def _event_hash(event_id: str, request_id: str, timestamp: str, actor: str, action: str, target: str | None, result: dict[str, Any], previous_hash: str) -> str:
    payload = {"event_id": event_id, "request_id": request_id, "timestamp": timestamp, "actor": actor, "action": action, "target": target, "result": result, "previous_hash": previous_hash}
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()


def verify_audit_chain(events: Iterable[AuditEvent | dict[str, Any]]) -> bool:
    previous = "GENESIS"
    for event in events:
        get = event.get if isinstance(event, dict) else lambda key: getattr(event, key)
        timestamp = get("timestamp")
        timestamp_value = timestamp.isoformat() if isinstance(timestamp, datetime) else str(timestamp)
        if get("previous_hash") != previous:
            return False
        expected = _event_hash(str(get("event_id")), str(get("request_id")), timestamp_value, get("actor"), get("action"), get("target"), get("result"), previous)
        if get("event_hash") != expected:
            return False
        previous = expected
    return True


class AuditLogger:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def record(self, request_id: UUID, actor: str, action: str, target: str | None, result: dict[str, Any]) -> AuditEvent:
        last = (await self.session.execute(select(AuditEvent).where(AuditEvent.request_id == request_id).order_by(AuditEvent.timestamp.desc(), AuditEvent.event_id.desc()).limit(1))).scalar_one_or_none()
        previous_hash = last.event_hash if last else "GENESIS"
        event_id = uuid4()
        timestamp = datetime.now(timezone.utc)
        event_hash = _event_hash(str(event_id), str(request_id), timestamp.isoformat(), actor, action, target, result, previous_hash)
        event = AuditEvent(event_id=event_id, request_id=request_id, timestamp=timestamp, actor=actor, action=action, target=target, result=result, previous_hash=previous_hash, event_hash=event_hash)
        self.session.add(event)
        await self.session.flush()
        return event

    async def verify_request(self, request_id: UUID) -> bool:
        events = (await self.session.execute(select(AuditEvent).where(AuditEvent.request_id == request_id).order_by(AuditEvent.timestamp.asc(), AuditEvent.event_id.asc()))).scalars().all()
        return verify_audit_chain(events)
