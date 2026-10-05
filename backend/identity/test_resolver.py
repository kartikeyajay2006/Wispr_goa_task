import pytest

from .mock import MockIdentityLookup
from .resolver import IdentityResolver, ResolvedIdentifier


def identifier(identifier_type: str, value: str, source: str = "test") -> ResolvedIdentifier:
    return ResolvedIdentifier(type=identifier_type, value=value, source=source, confidence="exact", evidence={"method": "test-fixture"})


@pytest.mark.asyncio
async def test_valid_customer() -> None:
    lookup = MockIdentityLookup({"customer-a": [identifier("email", "a@example.test")]})
    assert await IdentityResolver(lookup).resolve("customer-a") == [identifier("email", "a@example.test")]


@pytest.mark.asyncio
async def test_unknown_customer() -> None:
    resolver = IdentityResolver(MockIdentityLookup({}))
    try:
        await resolver.resolve("unknown")
    except LookupError:
        return
    raise AssertionError("unknown customers must fail deterministic resolution")


@pytest.mark.asyncio
async def test_multiple_identifiers() -> None:
    records = [identifier("internal_user_uuid", "user-a"), identifier("email", "a@example.test"), identifier("phone", "+10000000000"), identifier("s3_prefix", "customer-a/")]
    assert await IdentityResolver(MockIdentityLookup({"customer-a": records})).resolve("customer-a") == records


@pytest.mark.asyncio
async def test_duplicate_identifiers_are_deduplicated() -> None:
    item = identifier("email", "a@example.test")
    result = await IdentityResolver(MockIdentityLookup({"customer-a": [item, item]})).resolve("customer-a")
    assert result == [item]
