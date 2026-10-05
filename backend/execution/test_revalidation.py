from uuid import uuid4

from backend.execution.tools import ExecutionCommand, RevalidationSnapshot, revalidation_mismatches


def test_changed_database_state_fails_revalidation():
    command = ExecutionCommand(uuid4(), uuid4(), "approver", "plan-1", "radius-1", "orders/ORD-1", 1, "CUST-1042", "v1")
    snapshot = RevalidationSnapshot("orders/ORD-1", 2, "CUST-1042", "v2", "radius-2", "plan-1", "plan-1", "radius-1", "schema-2", "schema-1")
    mismatches = revalidation_mismatches(command, snapshot)
    assert mismatches["row_count"] is False
    assert mismatches["resource_version"] is False
    assert mismatches["blast_radius_hash"] is False
    assert mismatches["schema_fingerprint"] is False


def test_unchanged_approved_state_passes_revalidation():
    command = ExecutionCommand(uuid4(), uuid4(), "approver", "plan-1", "radius-1", "orders/ORD-1", 1, "CUST-1042", "v1")
    snapshot = RevalidationSnapshot("orders/ORD-1", 1, "CUST-1042", "v1", "radius-1", "plan-1", "plan-1", "radius-1", "schema-1", "schema-1")
    assert all(revalidation_mismatches(command, snapshot).values())
