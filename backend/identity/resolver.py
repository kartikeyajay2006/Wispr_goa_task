from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol


@dataclass(frozen=True, slots=True)
class ResolvedIdentifier:
    type: str
    value: str
    source: str
    confidence: str
    evidence: dict[str, Any]


class IdentityLookup(Protocol):
    async def lookup(self, customer_id: str) -> list[ResolvedIdentifier]:
        """Return only deterministic mappings for a customer identifier."""


class IdentityResolver:
    def __init__(self, lookup: IdentityLookup):
        self._lookup = lookup

    async def resolve(self, customer_id: str) -> list[ResolvedIdentifier]:
        if not customer_id or not customer_id.strip():
            raise ValueError("customer_id is required")
        identifiers = await self._lookup.lookup(customer_id)
        unique: dict[tuple[str, str, str], ResolvedIdentifier] = {}
        for identifier in identifiers:
            key = (identifier.type, identifier.value, identifier.source)
            unique.setdefault(key, identifier)
        return list(unique.values())
