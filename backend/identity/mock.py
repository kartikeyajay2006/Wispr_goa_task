from __future__ import annotations

from collections.abc import Mapping

from .resolver import ResolvedIdentifier


class MockIdentityLookup:
    """Deterministic test adapter; data must be supplied by the caller."""

    def __init__(self, records: Mapping[str, list[ResolvedIdentifier]]):
        self._records = records

    async def lookup(self, customer_id: str) -> list[ResolvedIdentifier]:
        if customer_id not in self._records:
            raise LookupError(f"No deterministic identity mapping for {customer_id}")
        return list(self._records[customer_id])
