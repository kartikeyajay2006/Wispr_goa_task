from uuid import uuid4

import pytest

from backend.connectors.postgres import RecordEvidence
from backend.connectors.s3 import ObjectEvidence
from backend.discovery.engine import DataDiscoveryEngine, InMemoryDiscoveryStore
from backend.identity.resolver import ResolvedIdentifier


class FakePostgres:
    async def find_customer_rows(self, customer_id):
        return [RecordEvidence("postgres", "orders", "order-1", customer_id, {"status": "open"}, classification="personal_data")]


class FakeObjects:
    async def discover(self, identifiers):
        customer_id = next(item.value for item in identifiers if item.type == "customer_id")
        return [ObjectEvidence("s3", "uploads", "customer/file.txt", customer_id, {"size": 10}, {"source": "s3://uploads/customer/", "value": "customer/file.txt"})]


@pytest.mark.asyncio
async def test_multi_system_discovery_is_normalized_and_persisted():
    request_id = uuid4()
    store = InMemoryDiscoveryStore()
    identifiers = [ResolvedIdentifier("customer_id", "CUST-1042", "test", "exact", {"source": "test"})]
    resources = await DataDiscoveryEngine(FakePostgres(), FakeObjects(), store).discover(request_id, identifiers)
    assert {resource.system for resource in resources} == {"postgres", "s3"}
    assert all(resource.evidence for resource in resources)
    assert store.records[request_id] == resources


@pytest.mark.asyncio
async def test_discovery_requires_deterministic_customer_identifier():
    with pytest.raises(ValueError, match="customer_id"):
        await DataDiscoveryEngine(FakePostgres(), FakeObjects(), InMemoryDiscoveryStore()).discover(uuid4(), [])
