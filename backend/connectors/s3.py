from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from backend.identity.resolver import ResolvedIdentifier


class ObjectStoreClient(Protocol):
    async def list_objects(self, bucket: str, prefix: str) -> list[dict[str, Any]]: ...


@dataclass(frozen=True, slots=True)
class ObjectEvidence:
    system: str
    bucket: str
    resource_id: str
    customer_id: str
    metadata: dict[str, Any]
    evidence: dict[str, Any]
    classification: str = "personal_data"


class S3Connector:
    """Read-only S3 discovery adapter; object listings come from the client."""

    def __init__(self, client: ObjectStoreClient, allowed_buckets: tuple[str, ...]):
        self._client = client
        self._allowed_buckets = frozenset(allowed_buckets)

    async def discover(self, identifiers: list[ResolvedIdentifier]) -> list[ObjectEvidence]:
        customer_id = next((item.value for item in identifiers if item.type == "customer_id"), None)
        prefixes = [item.value for item in identifiers if item.type in {"s3_object_prefix", "s3_prefix"}]
        if not customer_id or not prefixes:
            return []
        resources: list[ObjectEvidence] = []
        for bucket in sorted(self._allowed_buckets):
            for prefix in prefixes:
                for obj in await self._client.list_objects(bucket, prefix):
                    key = str(obj["key"])
                    resources.append(ObjectEvidence(system="s3", bucket=bucket, resource_id=key, customer_id=customer_id, metadata=dict(obj), evidence={"source": f"s3://{bucket}/{prefix}", "value": key}))
        return resources
