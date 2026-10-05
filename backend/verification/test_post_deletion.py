import pytest

from backend.connectors.postgres import RecordEvidence
from backend.identity.resolver import ResolvedIdentifier
from backend.verification.post_deletion import PostDeletionVerifier


class FakePostgres:
    def __init__(self, rows):
        self.rows = rows

    async def search_identifier(self, identifier_type, value):
        return self.rows.get((identifier_type, value), [])


class FakeS3:
    def __init__(self, objects):
        self.objects = objects

    async def discover(self, identifiers):
        return self.objects


@pytest.mark.asyncio
async def test_residual_personal_data_fails_without_retrying():
    identifiers = [ResolvedIdentifier(type="customer_id", value="CUST-1042", source="test", confidence="exact", evidence={})]
    row = RecordEvidence("postgresql", "orders", "ORD-1", "CUST-1042", {"customer_id": "CUST-1042"})
    report = await PostDeletionVerifier(FakePostgres({("customer_id", "CUST-1042"): [row]}), FakeS3([])).verify(identifiers)
    assert report.status == "FAIL"
    assert report.residual_personal_data == 1
    assert report.unexpected_residuals[0].resource_id == "ORD-1"
    assert report.remediation_suggestions


@pytest.mark.asyncio
async def test_no_matching_resources_passes():
    identifiers = [ResolvedIdentifier(type="email", value="person@example.com", source="test", confidence="exact", evidence={})]
    report = await PostDeletionVerifier(FakePostgres({}), FakeS3([])).verify(identifiers)
    assert report.status == "PASS"
    assert report.residual_personal_data == 0
