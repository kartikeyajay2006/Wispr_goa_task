from __future__ import annotations

from enum import Enum
from typing import Any, TypedDict


class WorkflowStatus(str, Enum):
    REQUEST_RECEIVED = "REQUEST_RECEIVED"
    IDENTITY_RESOLUTION = "IDENTITY_RESOLUTION"
    DISCOVERY = "DISCOVERY"
    DEPENDENCY_ANALYSIS = "DEPENDENCY_ANALYSIS"
    POLICY_ANALYSIS = "POLICY_ANALYSIS"
    PLAN_GENERATION = "PLAN_GENERATION"
    SANDBOX_VERIFICATION = "SANDBOX_VERIFICATION"
    RISK_CHECK = "RISK_CHECK"
    BACKUP_PREPARATION = "BACKUP_PREPARATION"
    BLAST_RADIUS = "BLAST_RADIUS"
    AWAITING_APPROVAL = "AWAITING_APPROVAL"
    REVALIDATION = "REVALIDATION"
    EXECUTION = "EXECUTION"
    POST_VERIFY = "POST_VERIFY"
    AUDIT_REPORT = "AUDIT_REPORT"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    BLOCKED = "BLOCKED"


class WorkflowState(TypedDict, total=False):
    """State carried through the Python reference graph; every key is optional until a node sets it."""

    current_status: WorkflowStatus
    plan_attempts: int
    errors: list[str]
    policy_decisions: list[dict[str, Any]]
    sandbox_results: dict[str, Any]
    approval: dict[str, Any]
    execution_results: list[dict[str, Any]]
    verification_results: list[dict[str, Any]]
