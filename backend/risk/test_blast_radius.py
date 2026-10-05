from uuid import uuid4

from backend.dependencies.graph import DependencyEdge, DependencyGraph, DependencyNode
from backend.planning.planner import DeletionPlan, PlannedAction
from .blast_radius import BlastRadiusAnalyzer


def make_plan(count=2):
    action = PlannedAction(system="postgres", action_type="DELETE_RECORD", target="order-1", evidence={"source": "connector"}, reason="approved", reversible=False, requires_approval=True, expected_effect="delete", verification_criteria=["rescan"], rollback_strategy="restore backup", policy_decision="POL-ALLOW")
    return DeletionPlan(request_id=uuid4(), actions=[action], plan_hash="a" * 64, generated_at="2026-01-01T00:00:00Z")


def test_counts_and_hashes_blast_radius():
    graph = DependencyGraph(nodes={"order-1": DependencyNode("postgres", "orders", "order-1", "customer-a", "personal_data", None, "delete")}, edges=[])
    report = BlastRadiusAnalyzer().analyze(make_plan(), graph, {"order-1": {"count": 2}})
    assert report.database_rows_deleted == 2
    assert report.systems_affected == 1
    assert len(report.blast_radius_hash) == 64


def test_hash_changes_when_connector_metadata_changes():
    graph = DependencyGraph(nodes={}, edges=[])
    analyzer = BlastRadiusAnalyzer()
    first = analyzer.analyze(make_plan(), graph, {"order-1": {"count": 1}})
    second = analyzer.analyze(make_plan(), graph, {"order-1": {"count": 2}})
    assert first.blast_radius_hash != second.blast_radius_hash


def test_shared_dependency_adds_warning_and_other_customer_impact():
    graph = DependencyGraph(nodes={"order-1": DependencyNode("postgres", "orders", "order-1", "customer-a", "personal_data", None, "delete"), "shared": DependencyNode("postgres", "account", "shared", "customer-b", "business", "retain", "retain")}, edges=[DependencyEdge("order-1", "shared", "foreign_key", "shared", "critical")])
    report = BlastRadiusAnalyzer().analyze(make_plan(), graph, {"order-1": {"count": 1}})
    assert report.other_customers_affected == 1
    assert report.warnings
