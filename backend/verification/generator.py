from __future__ import annotations

import ast
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from backend.dependencies.graph import DependencyGraph
from backend.planning.planner import DeletionPlan


class CheckType(StrEnum):
    EXPECTED_AFFECTED_ROW_COUNT = "expected_affected_row_count"
    FOREIGN_KEY_INTEGRITY = "foreign_key_integrity"
    NO_ORPHAN_RECORDS = "no_orphan_records"
    CROSS_CUSTOMER_IMPACT = "cross_customer_impact"
    SHARED_OBJECTS_NOT_DELETED = "shared_objects_not_deleted"
    INVOICES_REMAIN_VALID = "invoices_remain_valid"
    ANONYMIZED_FIELDS_TRANSFORMED = "anonymized_fields_transformed"


class VerificationCheck(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    check: CheckType
    expected: int | bool | str
    target: str | None = None
    parameters: dict[str, Any] = Field(default_factory=dict)


class VerificationPlan(BaseModel):
    model_config = ConfigDict(extra="forbid")
    checks: list[VerificationCheck]


class VerificationCodeGenerator:
    """Builds structured checks and safe code for a restricted sandbox context."""

    def generate_checks(self, plan: DeletionPlan, graph: DependencyGraph) -> VerificationPlan:
        deleted = sum(1 for action in plan.actions if action.action_type in {"DELETE_RECORD", "DELETE_S3_OBJECT"})
        checks = [
            VerificationCheck(check=CheckType.EXPECTED_AFFECTED_ROW_COUNT, expected=deleted, parameters={"plan_hash": plan.plan_hash}),
            VerificationCheck(check=CheckType.FOREIGN_KEY_INTEGRITY, expected=True),
            VerificationCheck(check=CheckType.NO_ORPHAN_RECORDS, expected=True),
            VerificationCheck(check=CheckType.CROSS_CUSTOMER_IMPACT, expected=0),
            VerificationCheck(check=CheckType.SHARED_OBJECTS_NOT_DELETED, expected=True),
            VerificationCheck(check=CheckType.INVOICES_REMAIN_VALID, expected=True),
        ]
        if any(action.action_type == "ANONYMIZE_RECORD" for action in plan.actions):
            checks.append(VerificationCheck(check=CheckType.ANONYMIZED_FIELDS_TRANSFORMED, expected=True))
        return VerificationPlan(checks=checks)

    def compile_sandbox_python(self, verification_plan: VerificationPlan) -> str:
        lines = ["def run_checks(sandbox):", "    results = []"]
        methods = {
            CheckType.EXPECTED_AFFECTED_ROW_COUNT: "check_expected_affected_row_count",
            CheckType.FOREIGN_KEY_INTEGRITY: "check_foreign_key_integrity",
            CheckType.NO_ORPHAN_RECORDS: "check_no_orphan_records",
            CheckType.CROSS_CUSTOMER_IMPACT: "check_cross_customer_impact",
            CheckType.SHARED_OBJECTS_NOT_DELETED: "check_shared_objects_not_deleted",
            CheckType.INVOICES_REMAIN_VALID: "check_invoices_remain_valid",
            CheckType.ANONYMIZED_FIELDS_TRANSFORMED: "check_anonymized_fields_transformed",
        }
        for check in verification_plan.checks:
            method = methods[check.check]
            expected = repr(check.expected)
            parameters = repr(check.parameters)
            lines.append(f"    results.append(sandbox.{method}(expected={expected}, parameters={parameters}))")
        lines.append("    return results")
        source = "\n".join(lines) + "\n"
        self._validate_generated_source(source)
        return source

    @staticmethod
    def _validate_generated_source(source: str) -> None:
        tree = ast.parse(source)
        for node in ast.walk(tree):
            if isinstance(node, (ast.Import, ast.ImportFrom, ast.Call)):
                if isinstance(node, ast.Call) and not (isinstance(node.func, ast.Attribute) and ((isinstance(node.func.value, ast.Name) and node.func.value.id == "sandbox") or (isinstance(node.func.value, ast.Name) and node.func.value.id == "results" and node.func.attr == "append"))):
                    raise ValueError("Generated verification code may only call the sandbox context")
                if isinstance(node, (ast.Import, ast.ImportFrom)):
                    raise ValueError("Generated verification code cannot import modules")
