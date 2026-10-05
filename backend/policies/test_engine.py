import pytest

from .engine import Decision, PolicyAction, PolicyContext, PolicyEngine


def action(**overrides):
    values = {"operation": "READ", "target": "customers", "system": "postgres", "explicitly_allowed": True}
    values.update(overrides)
    return PolicyAction(**values)


def context(**overrides):
    values = {"environment": "development"}
    values.update(overrides)
    return PolicyContext(**values)


@pytest.mark.parametrize("operation,policy", [("DROP TABLE", "POL-002"), ("TRUNCATE", "POL-003")])
def test_irreversible_ddl_is_denied(operation, policy):
    result = PolicyEngine().evaluate(action(operation=operation), context())
    assert result.decision is Decision.DENY and result.policy_id == policy


def test_unscoped_delete_is_denied():
    result = PolicyEngine().evaluate(action(operation="DELETE", selector=None), context())
    assert result.decision is Decision.DENY and result.policy_id == "POL-004"


def test_shared_resource_is_denied():
    result = PolicyEngine().evaluate(action(operation="DELETE", selector="customer_id = :customer_id", shared_resource=True), context())
    assert result.decision is Decision.DENY and result.policy_id == "POL-005"


def test_cross_customer_impact_is_denied():
    result = PolicyEngine().evaluate(action(operation="DELETE", selector="customer_id = :customer_id", cross_customer_impact=True), context())
    assert result.decision is Decision.DENY and result.policy_id == "POL-006"


def test_invoice_may_only_be_anonymized():
    engine = PolicyEngine()
    allowed = engine.evaluate(action(operation="ANONYMIZE", target="invoice", contains_financial_invoice=True, anonymizes_personal_data=True), context())
    denied = engine.evaluate(action(operation="DELETE", target="invoice", contains_financial_invoice=True), context())
    assert allowed.decision is Decision.ALLOW_WITH_APPROVAL
    assert denied.decision is Decision.DENY


def test_large_impact_requires_review():
    result = PolicyEngine().evaluate(action(operation="DELETE", selector="customer_id = :customer_id", affected_resources=101), context())
    assert result.decision is Decision.REQUIRE_REVIEW and result.policy_id == "POL-008"


def test_production_destructive_action_requires_approval():
    result = PolicyEngine().evaluate(action(operation="DELETE", selector="customer_id = :customer_id"), context(environment="production"))
    assert result.decision is Decision.ALLOW_WITH_APPROVAL and result.policy_id == "POL-001"


def test_explicit_read_action_is_allowed():
    result = PolicyEngine().evaluate(action(operation="READ"), context())
    assert result.decision is Decision.ALLOW


def test_unknown_action_is_denied_by_default():
    result = PolicyEngine().evaluate(action(operation="CUSTOM_MUTATION", explicitly_allowed=False), context())
    assert result.decision is Decision.DENY and result.policy_id == "POL-009"
