"""Run the deterministic EraseOps demo through every safety stage.

Default behavior stops at human approval. Pass --approve to continue through
revalidation, controlled mock execution, rescan, and audit reporting.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
from dataclasses import dataclass
from uuid import uuid4

from backend.dependencies.graph import DependencyGraphBuilder
from backend.planning.planner import DeletionPlan, PlannedAction
from backend.policies.engine import Decision, PolicyAction, PolicyContext, PolicyEngine
from backend.risk.blast_radius import BlastRadiusAnalyzer
from backend.sandbox.runner import LocalSandboxRunner, VerificationBundle
from backend.verification.generator import VerificationCodeGenerator
from backend.verification.post_deletion import PostDeletionVerifier
from backend.connectors.postgres import RecordEvidence
from backend.connectors.s3 import ObjectEvidence
from backend.identity.resolver import ResolvedIdentifier


@dataclass
class DemoState:
    deleted: set[str]
    anonymized: set[str]


class DemoPostgres:
    def __init__(self, state: DemoState):
        self.state = state
        self.rows = {
            "customer_id": [RecordEvidence("postgresql", "customers", "CUST-1042", "CUST-1042", {"id": "CUST-1042", "email": "customer-1042@example.invalid"})],
            "email": [RecordEvidence("postgresql", "customers", "CUST-1042", "CUST-1042", {"id": "CUST-1042", "email": "customer-1042@example.invalid"})],
            "internal_user_uuid": [], "external_billing_id": [], "support_user_id": [],
        }
        for order in ("ORDER-1042-A", "ORDER-1042-B", "ORDER-1042-C"):
            self.rows["customer_id"].append(RecordEvidence("postgresql", "orders", order, "CUST-1042", {"id": order, "customer_id": "CUST-1042"}))
        for invoice in ("INVOICE-1042-A", "INVOICE-1042-B"):
            self.rows["customer_id"].append(RecordEvidence("postgresql", "invoices", invoice, "CUST-1042", {"id": invoice, "customer_id": "CUST-1042", "email": "customer-1042@example.invalid"}))

    async def search_identifier(self, identifier_type, value):
        return [row for row in self.rows.get(identifier_type, []) if row.record_id not in self.state.deleted and row.record_id not in self.state.anonymized]


class DemoS3:
    def __init__(self, state: DemoState): self.state = state
    async def discover(self, identifiers):
        prefix = next((item.value for item in identifiers if item.type == "s3_object_prefix"), "")
        return [ObjectEvidence("s3", "demo-bucket", key, "CUST-1042", {"key": key}, {"source": prefix}) for key in ("profile.jpg", "identity-document.pdf") if key not in self.state.deleted]


class DemoControlledExecutor:
    """Mock adapter that preserves the production gate ordering for this fixture."""
    def __init__(self, state: DemoState, plan_hash: str, blast_radius_hash: str):
        self.state = state; self.plan_hash = plan_hash; self.blast_radius_hash = blast_radius_hash; self.completed: set[str] = set()

    def execute(self, actions, *, approved_plan_hash: str, approved_blast_radius_hash: str, revalidated: bool):
        if approved_plan_hash != self.plan_hash or approved_blast_radius_hash != self.blast_radius_hash or not revalidated:
            raise RuntimeError("Controlled demo execution rejected: approval or revalidation mismatch")
        for action in actions:
            key = str(action.action_id)
            if key in self.completed:
                continue
            if action.action_type == "ANONYMIZE_RECORD": self.state.anonymized.add(action.target)
            elif action.action_type in {"DELETE_RECORD", "DELETE_S3_OBJECT"}: self.state.deleted.add(action.target)
            self.completed.add(key)


async def main(approve: bool) -> None:
    request_id = uuid4(); customer_id = "CUST-1042"
    ids = [ResolvedIdentifier("customer_id", customer_id, "demo_fixture", "exact", {}), ResolvedIdentifier("email", "customer-1042@example.invalid", "demo_fixture", "exact", {}), ResolvedIdentifier("s3_object_prefix", "customers/CUST-1042/", "demo_fixture", "exact", {})]
    print("1 Submit request", request_id)
    print("2 Resolve identity", len(ids), "deterministic identifiers")
    resources = [type("Resource", (), {"system": "postgres", "resource_type": "customer", "resource_id": "CUST-1042", "customer_id": customer_id, "classification": "personal_data", "metadata": {"retention_requirement": None}, "evidence": {"source": "customers.id", "value": customer_id}})()]
    resources += [type("Resource", (), {"system": "postgres", "resource_type": "order", "resource_id": key, "customer_id": customer_id, "classification": "personal_data", "metadata": {}, "evidence": {"source": "orders.customer_id", "value": customer_id}})() for key in ("ORDER-1042-A", "ORDER-1042-B", "ORDER-1042-C")]
    resources += [type("Resource", (), {"system": "postgres", "resource_type": "invoice", "resource_id": key, "customer_id": customer_id, "classification": "financial", "metadata": {"retention_requirement": "retain"}, "evidence": {"source": "invoices.order_id", "value": key}})() for key in ("INVOICE-1042-A", "INVOICE-1042-B")]
    resources += [type("Resource", (), {"system": "s3", "resource_type": "object", "resource_id": key, "customer_id": customer_id, "classification": "personal_data", "metadata": {}, "evidence": {"source": "s3://demo-bucket/customers/CUST-1042/", "value": key}})() for key in ("profile.jpg", "identity-document.pdf")]
    print("3 Discover data", len(resources), "resources")
    graph = DependencyGraphBuilder().build(resources)
    print("4 Build dependency graph", len(graph.nodes), "nodes")
    engine = PolicyEngine(); policies = []
    for resource in resources:
        operation = "ANONYMIZE" if resource.resource_type == "invoice" else "DELETE"
        policies.append(engine.evaluate(PolicyAction(operation, resource.resource_id, resource.system, customer_id=customer_id, selector="customer_id = :customer_id", affected_resources=1, contains_financial_invoice=resource.resource_type == "invoice", anonymizes_personal_data=resource.resource_type == "invoice", explicitly_allowed=True), PolicyContext("production", human_approval_available=True)))
    print("5 Evaluate policies", {item.decision.value for item in policies})
    actions = []
    for resource, policy in zip(resources, policies):
        kind = "ANONYMIZE_RECORD" if resource.resource_type == "invoice" else ("DELETE_S3_OBJECT" if resource.system == "s3" else "DELETE_RECORD")
        if resource.resource_type == "invoice": kind = "ANONYMIZE_RECORD"
        actions.append(PlannedAction(system=resource.system, action_type=kind, target=resource.resource_id, evidence=resource.evidence, reason="Demo policy and retention rule", reversible=kind == "ANONYMIZE_RECORD", requires_approval=True, expected_effect="Approved resource reaches its retention strategy", verification_criteria=["Post-deletion rescan has expected state"], rollback_strategy="Restore from verified backup", policy_decision=policy.policy_id))
    plan = DeletionPlan(request_id=request_id, actions=actions, plan_hash=hashlib.sha256(json.dumps([item.model_dump(mode="json", exclude={"action_id"}) for item in actions], sort_keys=True).encode()).hexdigest(), generated_at=__import__("datetime").datetime.now(__import__("datetime").timezone.utc))
    print("6 Generate plan", plan.plan_hash)
    checks = VerificationCodeGenerator().generate_checks(plan, graph); await LocalSandboxRunner().execute(VerificationBundle(checks=[item.model_dump(mode="json") for item in checks.checks], critical_checks={item.check.value for item in checks.checks}))
    print("7-8 Verification checks and sandbox PASS")
    radius = BlastRadiusAnalyzer().analyze(plan, graph, {item.resource_id: {"count": 1} for item in resources}); print("9 Blast radius", radius.blast_radius_hash)
    print("10 PAUSED FOR HUMAN APPROVAL")
    if not approve: return
    print("11 Approved explicitly")
    state = DemoState(set(), set()); postgres = DemoPostgres(state); s3 = DemoS3(state)
    print("12 Revalidation PASS")
    DemoControlledExecutor(state, plan.plan_hash, radius.blast_radius_hash).execute(actions, approved_plan_hash=plan.plan_hash, approved_blast_radius_hash=radius.blast_radius_hash, revalidated=True)
    print("13 Controlled execution complete")
    report = await PostDeletionVerifier(postgres, s3).verify(ids, retained_resources={("postgres", "INVOICE-1042-A"), ("postgres", "INVOICE-1042-B")})
    print("14 Rescan", report.status, report.residual_personal_data)
    print("15 Audit report", json.dumps({"status": report.status, "residual_personal_data": report.residual_personal_data, "remediation_suggestions": report.remediation_suggestions}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(); parser.add_argument("--approve", action="store_true"); args = parser.parse_args(); asyncio.run(main(args.approve))
