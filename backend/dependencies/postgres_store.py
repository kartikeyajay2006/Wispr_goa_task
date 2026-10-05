from __future__ import annotations

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.dependencies.graph import DependencyGraph
from backend.models.entities import DiscoveredResource, ResourceDependency


class PostgresDependencyStore:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def save(self, request_id: UUID, graph: DependencyGraph) -> None:
        result = await self._session.execute(select(DiscoveredResource).where(DiscoveredResource.request_id == request_id))
        resource_ids = {resource.resource_id: resource.id for resource in result.scalars().all()}
        rows = []
        for edge in graph.edges:
            source_id = resource_ids.get(edge.source)
            target_id = resource_ids.get(edge.target)
            if source_id is None or target_id is None:
                continue
            rows.append(ResourceDependency(source_resource_id=source_id, target_resource_id=target_id, relationship_type=edge.relationship_type, constraint_type=edge.constraint, required=edge.risk in {"high", "critical"}, risk=edge.risk))
        self._session.add_all(rows)
        await self._session.flush()
