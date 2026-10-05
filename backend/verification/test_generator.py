from uuid import uuid4

import pytest

from backend.dependencies.graph import DependencyGraph
from backend.planning.planner import DeletionPlan, PlannedAction
from .generator import CheckType, VerificationCodeGenerator


def plan(actions):
    return DeletionPlan(request_id=uuid4(), actions=actions, plan_hash="a" * 64, generated_at="2026-01-01T00:00:00Z")


def action(kind):
    return PlannedAction(system="postgres", action_type=kind, target="resource", evidence={"source": "connector"}, reason="policy", reversible=False, requires_approval=True, expected_effect="expected", verification_criteria=["rescan"], rollback_strategy="backup", policy_decision="POL-ALLOW")


def test_generates_required_checks():
    result = VerificationCodeGenerator().generate_checks(plan([action("DELETE_RECORD"), action("ANONYMIZE_RECORD")]), DependencyGraph())
    names = {check.check for check in result.checks}
    assert CheckType.EXPECTED_AFFECTED_ROW_COUNT in names
    assert CheckType.FOREIGN_KEY_INTEGRITY in names
    assert CheckType.NO_ORPHAN_RECORDS in names
    assert CheckType.CROSS_CUSTOMER_IMPACT in names
    assert CheckType.SHARED_OBJECTS_NOT_DELETED in names
    assert CheckType.INVOICES_REMAIN_VALID in names
    assert CheckType.ANONYMIZED_FIELDS_TRANSFORMED in names


def test_generated_code_only_calls_sandbox_context():
    generator = VerificationCodeGenerator()
    checks = generator.generate_checks(plan([action("DELETE_RECORD")]), DependencyGraph())
    source = generator.compile_sandbox_python(checks)
    assert "import " not in source
    assert "subprocess" not in source
    assert "sandbox.check_" in source


def test_generated_code_rejects_unsafe_ast():
    with pytest.raises(ValueError):
        VerificationCodeGenerator._validate_generated_source("def run_checks(sandbox):\n    return open('secret')\n")
