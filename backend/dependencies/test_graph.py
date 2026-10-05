from backend.dependencies.graph import build_dependency_graph
from backend.discovery.engine import DiscoveredResourceEvidence


def resource(system: str, kind: str, identifier: str, customer: str, strategy: str = "retain"):
    return DiscoveredResourceEvidence(system, kind, identifier, customer, "personal_data", {"deletion_strategy": strategy}, {"source": f"{kind}.customer_id", "value": customer})


def test_builds_foreign_key_graph_and_nodes():
    resources = [resource("postgres", "customers", "customer-1", "customer-a"), resource("postgres", "orders", "order-1", "customer-a", "delete"), resource("postgres", "invoices", "invoice-1", "customer-a", "retain")]
    graph = build_dependency_graph(resources, [{"table": "orders", "referenced_table": "customers", "constraint_type": "foreign_key", "column_value": "order-1", "referenced_value": "customer-1"}, {"table": "invoices", "referenced_table": "orders", "constraint_type": "foreign_key", "column_value": "invoice-1", "referenced_value": "order-1"}])
    assert len(graph.nodes) == 3
    assert {(edge.source, edge.target) for edge in graph.edges} >= {("order-1", "customer-1"), ("invoice-1", "order-1")}


def test_detects_shared_cross_customer_object():
    resources = [resource("postgres", "customers", "customer-a", "customer-a"), resource("s3", "object", "object-1", "customer-a", "delete")]
    graph = build_dependency_graph(resources, object_ownership=[{"resource_id": "object-1", "owner_resource_id": "customer-a", "customer_ids": ["customer-a", "customer-b"], "shared": True}])
    assert "object-1" in graph.unsafe_resources
    assert graph.edges[-1].risk == "critical"
