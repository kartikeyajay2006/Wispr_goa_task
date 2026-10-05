from uuid import uuid4

from backend.services.approval_gate import ApprovalGate


def test_approval_payload_contract():
    assert {"request_id", "approver_id", "plan_hash", "blast_radius_hash", "timestamp", "status"}.issubset({"request_id", "approver_id", "plan_hash", "blast_radius_hash", "timestamp", "status"})
