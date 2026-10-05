from __future__ import annotations

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.entities import CustomerIdentifier
from .resolver import ResolvedIdentifier


class PostgresIdentityStore:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def save(self, request_id: UUID, identifiers: list[ResolvedIdentifier]) -> list[CustomerIdentifier]:
        rows = [CustomerIdentifier(request_id=request_id, identifier_type=item.type, value=item.value, source=item.source, confidence=item.confidence, evidence=item.evidence) for item in identifiers]
        self._session.add_all(rows)
        await self._session.flush()
        return rows

    async def get_for_request(self, request_id: UUID) -> list[CustomerIdentifier]:
        result = await self._session.execute(select(CustomerIdentifier).where(CustomerIdentifier.request_id == request_id).order_by(CustomerIdentifier.id))
        return list(result.scalars().all())
