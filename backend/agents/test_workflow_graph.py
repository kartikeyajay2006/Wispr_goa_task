from backend.agents.workflow_graph import build_workflow_graph
from backend.agents.workflow_state import WorkflowStatus

APPROVED = {"status": "approved", "valid": True, "plan_hash_matches": True}


def run(**state):
    return build_workflow_graph().invoke(state)


def test_happy_path_reaches_completed():
    final = run(sandbox_results={"status": "passed"}, approval=APPROVED, execution_results=[{"status": "completed"}], verification_results=[{"verified": True}])
    assert final["current_status"] == WorkflowStatus.COMPLETED
    assert final["plan_attempts"] == 1


def test_policy_denial_blocks_before_planning():
    final = run(policy_decisions=[{"decision": "deny"}])
    assert final["current_status"] == WorkflowStatus.BLOCKED
    assert "plan_attempts" not in final


def test_persistent_sandbox_failure_ends_instead_of_looping():
    final = run(sandbox_results={"status": "failed"}, approval=APPROVED)
    assert final["current_status"] == WorkflowStatus.FAILED
    assert final["plan_attempts"] == 2


def test_rejection_and_stale_plan_hash_fail():
    assert run(sandbox_results={"status": "passed"}, approval={"status": "rejected"})["current_status"] == WorkflowStatus.FAILED
    assert run(sandbox_results={"status": "passed"}, approval={**APPROVED, "plan_hash_matches": False})["current_status"] == WorkflowStatus.FAILED


def test_failed_rescan_fails_the_run():
    final = run(sandbox_results={"status": "passed"}, approval=APPROVED, execution_results=[{"status": "completed"}], verification_results=[{"verified": False}])
    assert final["current_status"] == WorkflowStatus.FAILED
