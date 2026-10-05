from datetime import datetime, timezone
from uuid import uuid4

from backend.audit.chain import _event_hash, verify_audit_chain


def test_tampering_is_detected():
    request_id = uuid4()
    event_id = uuid4()
    timestamp = datetime.now(timezone.utc)
    event_hash = _event_hash(str(event_id), str(request_id), timestamp.isoformat(), "agent", "resource_discovered", "orders/1", {"status": "ok"}, "GENESIS")
    event = {"event_id": event_id, "request_id": request_id, "timestamp": timestamp, "actor": "agent", "action": "resource_discovered", "target": "orders/1", "result": {"status": "ok"}, "previous_hash": "GENESIS", "event_hash": event_hash}
    assert verify_audit_chain([event])
    event["result"] = {"status": "tampered"}
    assert not verify_audit_chain([event])
