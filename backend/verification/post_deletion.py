from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Protocol

from backend.connectors.postgres import RecordEvidence
from backend.connectors.s3 import ObjectEvidence
from backend.identity.resolver import ResolvedIdentifier


class PostDeletionSearch(Protocol):
    async def search_identifier(self, identifier_type: str, value: str) -> list[RecordEvidence]: ...


class PostDeletionObjects(Protocol):
    async def discover(self, identifiers: list[ResolvedIdentifier]) -> list[ObjectEvidence]: ...


@dataclass(frozen=True, slots=True)
class ResidualResource:
    system: str
    resource_type: str
    resource_id: str
    classification: str
    reason: str
    remediation: str


@dataclass(frozen=True, slots=True)
class PostDeletionReport:
    status: str
    residual_personal_data: int
    correctly_retained: tuple[dict[str, Any], ...]
    correctly_anonymized: tuple[dict[str, Any], ...]
    unexpected_residuals: tuple[ResidualResource, ...]
    checks: dict[str, bool]
    remediation_suggestions: tuple[str, ...]


class PostDeletionVerifier:
    """Read-only verification; it never retries or invokes destructive operations."""

    def __init__(self, postgres: PostDeletionSearch, s3: PostDeletionObjects):
        self.postgres = postgres
        self.s3 = s3

    async def verify(self, identifiers: list[ResolvedIdentifier], retained_resources: set[tuple[str, str]] = frozenset(), anonymized_resources: set[tuple[str, str]] = frozenset()) -> PostDeletionReport:
        if not identifiers:
            raise ValueError("At least one resolved identifier is required")
        postgres_results = await asyncio.gather(*(self.postgres.search_identifier(item.type, item.value) for item in identifiers))
        objects = await self.s3.discover(identifiers)
        residuals: list[ResidualResource] = []
        retained: list[dict[str, Any]] = []
        anonymized: list[dict[str, Any]] = []
        seen: set[tuple[str, str]] = set()
        for item in [resource for batch in postgres_results for resource in batch]:
            key = ("postgres", item.record_id)
            if key in seen:
                continue
            seen.add(key)
            payload = {"system": "postgres", "resource_type": item.table, "resource_id": item.record_id, "customer_id": item.customer_id, "metadata": item.metadata}
            if key in retained_resources:
                retained.append(payload)
            elif key in anonymized_resources and self._is_anonymized(item):
                anonymized.append(payload)
            else:
                residuals.append(ResidualResource("postgres", item.table, item.record_id, item.classification, "personal data still matches a resolved identifier", "Review the plan and run a new approved remediation action."))
        for item in objects:
            key = ("s3", item.resource_id)
            if key in seen:
                continue
            seen.add(key)
            payload = {"system": "s3", "resource_type": "object", "resource_id": item.resource_id, "customer_id": item.customer_id, "metadata": item.metadata}
            if key in retained_resources:
                retained.append(payload)
            else:
                residuals.append(ResidualResource("s3", "object", item.resource_id, item.classification, "object still matches a resolved S3 prefix", "Review object ownership and request a new approved deletion."))
        checks = {item.type: not any(item.value in str(resource) for resource in [*residuals]) for item in identifiers}
        checks["all_required_checks"] = all(checks.values()) and not residuals
        suggestions = tuple(dict.fromkeys(resource.remediation for resource in residuals))
        return PostDeletionReport("PASS" if not residuals and all(checks.values()) else "FAIL", len(residuals), tuple(retained), tuple(anonymized), tuple(residuals), checks, suggestions)

    @staticmethod
    def _is_anonymized(resource: RecordEvidence) -> bool:
        values = " ".join(str(value).lower() for value in resource.metadata.values())
        return "redacted" in values or "anonymized" in values or "deleted" in values
