from __future__ import annotations

from typing import Literal

from langgraph.graph import END, START, StateGraph

from backend.agents.workflow_state import WorkflowState, WorkflowStatus


def _node(status: WorkflowStatus):
    def transition(state: WorkflowState) -> dict[str, WorkflowStatus]:
        return {"current_status": status}

    return transition


def _sandbox_route(state: WorkflowState) -> Literal["plan_generation", "risk_check", "failed"]:
    result = state.get("sandbox_results") or {}
    if result.get("status") == "failed":
        return "plan_generation"
    if state.get("errors"):
        return "failed"
    return "risk_check"


def _policy_route(state: WorkflowState) -> Literal["blocked", "plan_generation"]:
    if any(decision.get("decision") == "deny" for decision in state.get("policy_decisions", [])):
        return "blocked"
    return "plan_generation"


def _approval_route(state: WorkflowState) -> Literal["failed", "revalidation"]:
    approval = state.get("approval") or {}
    return "failed" if approval.get("status") == "rejected" else "revalidation"


def _revalidation_route(state: WorkflowState) -> Literal["sandbox_verification", "execution", "failed"]:
    if state.get("errors"):
        return "sandbox_verification"
    approval = state.get("approval") or {}
    if approval.get("plan_hash_matches") is False:
        return "sandbox_verification"
    if approval.get("valid") is False:
        return "failed"
    return "execution"


def _execution_route(state: WorkflowState) -> Literal["failed", "post_verify"]:
    return "failed" if any(result.get("status") == "failed" for result in state.get("execution_results", [])) else "post_verify"


def _verification_route(state: WorkflowState) -> Literal["failed", "audit_report"]:
    return "failed" if any(result.get("verified") is False for result in state.get("verification_results", [])) else "audit_report"


def build_workflow_graph():
    graph = StateGraph(WorkflowState)
    graph.add_node("request_received", _node(WorkflowStatus.REQUEST_RECEIVED))
    graph.add_node("identity_resolution", _node(WorkflowStatus.IDENTITY_RESOLUTION))
    graph.add_node("discovery", _node(WorkflowStatus.DISCOVERY))
    graph.add_node("dependency_analysis", _node(WorkflowStatus.DEPENDENCY_ANALYSIS))
    graph.add_node("policy_analysis", _node(WorkflowStatus.POLICY_ANALYSIS))
    graph.add_node("plan_generation", _node(WorkflowStatus.PLAN_GENERATION))
    graph.add_node("sandbox_verification", _node(WorkflowStatus.SANDBOX_VERIFICATION))
    graph.add_node("risk_check", _node(WorkflowStatus.RISK_CHECK))
    graph.add_node("backup_preparation", _node(WorkflowStatus.BACKUP_PREPARATION))
    graph.add_node("blast_radius", _node(WorkflowStatus.BLAST_RADIUS))
    graph.add_node("awaiting_approval", _node(WorkflowStatus.AWAITING_APPROVAL))
    graph.add_node("revalidation", _node(WorkflowStatus.REVALIDATION))
    graph.add_node("execution", _node(WorkflowStatus.EXECUTION))
    graph.add_node("post_verify", _node(WorkflowStatus.POST_VERIFY))
    graph.add_node("audit_report", _node(WorkflowStatus.AUDIT_REPORT))
    graph.add_node("completed", _node(WorkflowStatus.COMPLETED))
    graph.add_node("failed", _node(WorkflowStatus.FAILED))
    graph.add_node("blocked", _node(WorkflowStatus.BLOCKED))

    graph.add_edge(START, "request_received")
    graph.add_edge("request_received", "identity_resolution")
    graph.add_edge("identity_resolution", "discovery")
    graph.add_edge("discovery", "dependency_analysis")
    graph.add_edge("dependency_analysis", "policy_analysis")
    graph.add_conditional_edges("policy_analysis", _policy_route)
    graph.add_edge("plan_generation", "sandbox_verification")
    graph.add_conditional_edges("sandbox_verification", _sandbox_route)
    graph.add_edge("risk_check", "backup_preparation")
    graph.add_edge("backup_preparation", "blast_radius")
    graph.add_edge("blast_radius", "awaiting_approval")
    graph.add_conditional_edges("awaiting_approval", _approval_route)
    graph.add_conditional_edges("revalidation", _revalidation_route)
    graph.add_conditional_edges("execution", _execution_route)
    graph.add_conditional_edges("post_verify", _verification_route)
    graph.add_edge("audit_report", "completed")
    graph.add_edge("failed", END)
    graph.add_edge("blocked", END)
    graph.add_edge("completed", END)
    return graph.compile()


workflow_graph = build_workflow_graph()
