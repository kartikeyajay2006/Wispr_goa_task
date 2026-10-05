from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable


@dataclass(frozen=True, slots=True)
class DependencyNode:
    system: str
    resource_type: str
    resource_id: str
    customer_id: str
    personal_data_classification: str
    retention_requirement: str | None
    deletion_strategy: str | None


@dataclass(frozen=True, slots=True)
class DependencyEdge:
    source: str
    target: str
    relationship_type: str
    constraint: str | None
    risk: str


@dataclass(slots=True)
class DependencyGraph:
    nodes: dict[str, DependencyNode] = field(default_factory=dict)
    edges: list[DependencyEdge] = field(default_factory=list)

    def add_node(self, node: DependencyNode) -> None:
        self.nodes[node.resource_id] = node

    def add_edge(self, edge: DependencyEdge) -> None:
        if edge.source in self.nodes and edge.target in self.nodes and edge not in self.edges:
            self.edges.append(edge)

    @property
    def unsafe_resources(self) -> set[str]:
        return {edge.source for edge in self.edges if edge.risk in {"high", "critical"}} | {edge.target for edge in self.edges if edge.risk == "critical"}


class DependencyGraphBuilder:
    def build(self, resources: Iterable[Any], foreign_keys: Iterable[Any] = (), object_ownership: Iterable[dict[str, Any]] = ()) -> DependencyGraph:
        graph = DependencyGraph()
        resources = list(resources)
        for resource in resources:
            metadata = dict(getattr(resource, "metadata", {}) or {})
            graph.add_node(DependencyNode(system=resource.system, resource_type=resource.resource_type, resource_id=resource.resource_id, customer_id=resource.customer_id, personal_data_classification=resource.classification, retention_requirement=metadata.get("retention_requirement"), deletion_strategy=metadata.get("deletion_strategy")))
        self._add_foreign_key_edges(graph, foreign_keys)
        self._add_ownership_edges(graph, object_ownership)
        self._mark_orphan_risks(graph)
        return graph

    @staticmethod
    def _add_foreign_key_edges(graph: DependencyGraph, foreign_keys: Iterable[Any]) -> None:
        for foreign_key in foreign_keys:
            table = _value(foreign_key, "table_name", "table")
            referenced_table = _value(foreign_key, "referenced_table")
            source = _find_resource(graph, table, _value(foreign_key, "column_value"))
            target = _find_resource(graph, referenced_table, _value(foreign_key, "referenced_value"))
            if not source or not target:
                continue
            graph.add_edge(DependencyEdge(source=source.resource_id, target=target.resource_id, relationship_type="foreign_key", constraint=_value(foreign_key, "constraint_type", "constraint"), risk="high" if source.deletion_strategy == "delete" or target.deletion_strategy == "delete" else "medium"))

    @staticmethod
    def _add_ownership_edges(graph: DependencyGraph, ownership_records: Iterable[dict[str, Any]]) -> None:
        for ownership in ownership_records:
            object_id = ownership.get("resource_id")
            owner_id = ownership.get("owner_resource_id")
            node = graph.nodes.get(object_id)
            owner = graph.nodes.get(owner_id) if owner_id else None
            if not node or not owner:
                continue
            owners = set(ownership.get("customer_ids", []))
            cross_customer = len(owners) > 1 or (owners and owner.customer_id not in owners)
            graph.add_edge(DependencyEdge(source=node.resource_id, target=owner.resource_id, relationship_type="ownership", constraint="shared" if ownership.get("shared") or cross_customer else "exclusive", risk="critical" if cross_customer else "high"))

    @staticmethod
    def _mark_orphan_risks(graph: DependencyGraph) -> None:
        incoming = {edge.target for edge in graph.edges}
        for node in list(graph.nodes.values()):
            if node.deletion_strategy == "delete" and node.resource_id not in incoming:
                continue
            if node.deletion_strategy == "delete" and not any(edge.source == node.resource_id for edge in graph.edges):
                graph.edges.append(DependencyEdge(source=node.resource_id, target=node.resource_id, relationship_type="orphan_risk", constraint="no_dependents", risk="medium"))


def _value(item: Any, *names: str) -> str | None:
    for name in names:
        if isinstance(item, dict) and item.get(name) is not None:
            return str(item[name])
        value = getattr(item, name, None)
        if value is not None:
            return str(value)
    return None


def _find_resource(graph: DependencyGraph, resource_type: str | None, resource_id: str | None):
    if resource_id and resource_id in graph.nodes:
        return graph.nodes[resource_id]
    return next((node for node in graph.nodes.values() if node.resource_type == resource_type), None)


def build_dependency_graph(resources, foreign_keys=(), object_ownership=()) -> DependencyGraph:
    return DependencyGraphBuilder().build(resources, foreign_keys, object_ownership)
