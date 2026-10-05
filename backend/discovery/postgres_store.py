from __future__ import annotations

from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from backend.discovery.engine import DiscoveredResourceEvidence
from backend.models.entities import DiscoveredResource


class PostgresDiscoveryStore:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def save(self, request_id: UUID, resources: list[DiscoveredResourceEvidence]) -> None:
        self._session.add_all([DiscoveredResource(request_id=request_id, system=item.system, resource_type=item.resource_type, resource_id=item.resource_id, contains_personal_data=item.classification == "personal_data", classification=item.classification, metadata=item.metadata, evidence=item.evidence) for item in resources])
        await self._session.flush()
