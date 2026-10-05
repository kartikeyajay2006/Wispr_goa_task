from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class Decision(StrEnum):
    ALLOW = "ALLOW"
    ALLOW_WITH_APPROVAL = "ALLOW_WITH_APPROVAL"
    DENY = "DENY"
    REQUIRE_REVIEW = "REQUIRE_REVIEW"


@dataclass(frozen=True, slots=True)
class PolicyAction:
    operation: str
    target: str
    system: str
    customer_id: str | None = None
    selector: str | None = None
    affected_resources: int = 0
    shared_resource: bool = False
    cross_customer_impact: bool = False
    contains_financial_invoice: bool = False
    anonymizes_personal_data: bool = False
    explicitly_allowed: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class PolicyContext:
    environment: str
    human_approval_available: bool = False
    elevated_review_available: bool = False


@dataclass(frozen=True, slots=True)
class PolicyResult:
    decision: Decision
    policy_id: str
    reason: str
    severity: str


class PolicyEngine:
    """Pure deterministic policy evaluation; it has no model or connector dependency."""

    def evaluate(self, action: PolicyAction, context: PolicyContext) -> PolicyResult:
        operation = action.operation.strip().upper()
        if operation == "DROP TABLE":
            return PolicyResult(Decision.DENY, "POL-002", "DROP TABLE is never permitted", "critical")
        if operation == "TRUNCATE":
            return PolicyResult(Decision.DENY, "POL-003", "TRUNCATE is never permitted", "critical")
        if operation == "DELETE" and not self._is_scoped(action.selector):
            return PolicyResult(Decision.DENY, "POL-004", "DELETE requires a scoped customer selector", "critical")
        if action.shared_resource:
            return PolicyResult(Decision.DENY, "POL-005", "Shared resources cannot be deleted", "critical")
        if action.cross_customer_impact:
            return PolicyResult(Decision.DENY, "POL-006", "Cross-customer impact is not permitted", "critical")
        if action.contains_financial_invoice:
            if operation == "ANONYMIZE" and action.anonymizes_personal_data:
                return PolicyResult(Decision.ALLOW_WITH_APPROVAL, "POL-007", "Invoice is retained while personal data is anonymized", "high")
            if operation in {"DELETE", "ANONYMIZE"}:
                return PolicyResult(Decision.DENY, "POL-007", "Financial invoices must be retained; only PII anonymization is allowed", "high")
        if action.affected_resources > 100:
            return PolicyResult(Decision.REQUIRE_REVIEW, "POL-008", "Impact exceeds the elevated-review threshold", "high")
        if context.environment.strip().lower() == "production" and operation in {"DELETE", "ANONYMIZE", "TRUNCATE", "DROP TABLE"}:
            return PolicyResult(Decision.ALLOW_WITH_APPROVAL, "POL-001", "Production deletion actions require human approval", "high")
        if not action.explicitly_allowed:
            return PolicyResult(Decision.DENY, "POL-009", "Action is not explicitly allowed by policy", "high")
        if operation in {"DELETE", "ANONYMIZE"}:
            return PolicyResult(Decision.ALLOW_WITH_APPROVAL, "POL-001", "Destructive action requires human approval", "high")
        if operation in {"READ", "INSPECT", "DISCOVER", "VERIFY"}:
            return PolicyResult(Decision.ALLOW, "POL-010", "Read-only action is explicitly allowed", "low")
        return PolicyResult(Decision.DENY, "POL-009", "Action is not explicitly allowed by policy", "high")

    @staticmethod
    def _is_scoped(selector: str | None) -> bool:
        if not selector or not selector.strip():
            return False
        normalized = selector.upper()
        return "CUSTOMER_ID" in normalized and "=" in normalized and "*" not in normalized
