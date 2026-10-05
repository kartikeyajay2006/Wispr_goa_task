from __future__ import annotations

from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.risk import BlastRadiusReport
from .blast_radius import BlastRadius


class PostgresBlastRadiusStore:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def save(self, request_id: UUID, plan_id: UUID, report: BlastRadius) -> BlastRadiusReport:
        record = BlastRadiusReport(request_id=request_id, plan_id=plan_id, blast_radius_hash=report.blast_radius_hash, report=report.model_dump(mode="json"))
        self._session.add(record)
        await self._session.flush()
        return record
