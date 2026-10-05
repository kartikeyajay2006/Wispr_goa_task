from __future__ import annotations

import hashlib
import json
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from backend.dependencies.graph import DependencyGraph
from backend.planning.planner import DeletionPlan


class BlastRadius(BaseModel):
    model_config = ConfigDict(extra="forbid")
    systems_affected: int = 0
    database_rows_deleted: int = 0
    database_rows_anonymized: int = 0
    s3_objects_deleted: int = 0
    retained_records: int = 0
    dependencies_affected: int = 0
    other_customers_affected: int = 0
    irreversible_actions: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    blast_radius_hash: str


class BlastRadiusAnalyzer:
    def analyze(self, plan: DeletionPlan, graph: DependencyGraph, connector_metadata: dict[str, dict[str, Any]] | None = None) -> BlastRadius:
        metadata = connector_metadata or {}
        targets = {action.target for action in plan.actions}
        systems = {action.system for action in plan.actions}
        deleted_db = 0
        anonymized_db = 0
        deleted_objects = 0
        retained = 0
        irreversible: list[str] = []
        warnings: list[str] = []
        for action in plan.actions:
            count = int(metadata.get(action.target, {}).get("count", metadata.get(action.target, {}).get("record_count", 1)))
            if action.action_type == "DELETE_RECORD":
                deleted_db += count
                irreversible.append(str(action.action_id))
            elif action.action_type == "ANONYMIZE_RECORD":
                anonymized_db += count
            elif action.action_type == "DELETE_S3_OBJECT":
                deleted_objects += count
                irreversible.append(str(action.action_id))
            elif action.action_type in {"RETAIN", "NO_ACTION"}:
                retained += count
        affected_edges = [edge for edge in graph.edges if edge.source in targets or edge.target in targets]
        other_customers = {graph.nodes[node_id].customer_id for edge in affected_edges for node_id in (edge.source, edge.target) if node_id in graph.nodes and graph.nodes[node_id].customer_id not in {graph.nodes[target].customer_id for target in targets if target in graph.nodes}}
        if other_customers:
            warnings.append("Dependency graph includes resources belonging to other customers")
        if any(edge.risk in {"high", "critical"} for edge in affected_edges):
            warnings.append("High-risk dependencies are affected")
        payload = {"systems_affected": len(systems), "database_rows_deleted": deleted_db, "database_rows_anonymized": anonymized_db, "s3_objects_deleted": deleted_objects, "retained_records": retained, "dependencies_affected": len(affected_edges), "other_customers_affected": len(other_customers), "irreversible_actions": sorted(irreversible), "warnings": sorted(warnings)}
        digest = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        return BlastRadius(**payload, blast_radius_hash=digest)
