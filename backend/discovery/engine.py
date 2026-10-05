from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Protocol
from uuid import UUID

from backend.connectors.postgres import PostgresConnector, RecordEvidence
from backend.connectors.s3 import ObjectEvidence, S3Connector
from backend.identity.resolver import ResolvedIdentifier


@dataclass(frozen=True, slots=True)
class DiscoveredResourceEvidence:
    system: str
    resource_type: str
    resource_id: str
    customer_id: str
    classification: str
    metadata: dict[str, Any]
    evidence: dict[str, Any]


class DiscoveryStore(Protocol):
    async def save(self, request_id: UUID, resources: list[DiscoveredResourceEvidence]) -> None: ...


class DataDiscoveryEngine:
    def __init__(self, postgres: PostgresConnector, s3: S3Connector, store: DiscoveryStore):
        self._postgres = postgres
        self._s3 = s3
        self._store = store

    async def discover(self, request_id: UUID, identifiers: list[ResolvedIdentifier]) -> list[DiscoveredResourceEvidence]:
        postgres_resources, object_resources = await self._discover_connectors(identifiers)
        normalized = [self._normalize_postgres(resource) for resource in postgres_resources]
        normalized.extend(self._normalize_object(resource) for resource in object_resources)
        if any(not resource.evidence for resource in normalized):
            raise ValueError("Connector returned a resource without evidence")
        await self._store.save(request_id, normalized)
        return normalized

    async def _discover_connectors(self, identifiers: list[ResolvedIdentifier]) -> tuple[list[RecordEvidence], list[ObjectEvidence]]:
        customer_id = next((item.value for item in identifiers if item.type == "customer_id"), None)
        if not customer_id:
            raise ValueError("A deterministic customer_id identifier is required")
        import asyncio
        return await asyncio.gather(self._postgres.find_customer_rows(customer_id), self._s3.discover(identifiers))

    @staticmethod
    def _normalize_postgres(resource: RecordEvidence) -> DiscoveredResourceEvidence:
        return DiscoveredResourceEvidence(system="postgres", resource_type=resource.table, resource_id=resource.record_id, customer_id=resource.customer_id, classification=resource.classification, metadata=resource.metadata, evidence={"source": f"{resource.table}.customer_id", "value": resource.customer_id, "relationship": resource.relationship})

    @staticmethod
    def _normalize_object(resource: ObjectEvidence) -> DiscoveredResourceEvidence:
        return DiscoveredResourceEvidence(system=resource.system, resource_type="object", resource_id=resource.resource_id, customer_id=resource.customer_id, classification=resource.classification, metadata=resource.metadata, evidence=resource.evidence)


class InMemoryDiscoveryStore:
    """Test adapter; production persistence is supplied by the caller."""

    def __init__(self):
        self.records: dict[UUID, list[DiscoveredResourceEvidence]] = {}

    async def save(self, request_id: UUID, resources: list[DiscoveredResourceEvidence]) -> None:
        self.records[request_id] = list(resources)
