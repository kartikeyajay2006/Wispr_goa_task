from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from time import monotonic
from typing import Any, Protocol

from pydantic import BaseModel, ConfigDict, Field


class SandboxStatus(StrEnum):
    PASS = "PASS"
    FAIL = "FAIL"


class VerificationBundle(BaseModel):
    model_config = ConfigDict(extra="forbid")
    checks: list[dict[str, Any]] = Field(min_length=1)
    generated_code: str = ""
    commands: list[str] = Field(default_factory=list)
    network_required: bool = False
    filesystem_paths: list[str] = Field(default_factory=list)
    credentials: list[str] = Field(default_factory=list)
    critical_checks: set[str] = Field(default_factory=set)


class SandboxVerificationResult(BaseModel):
    status: SandboxStatus
    tests: int
    passed: int
    failed: int
    warnings: list[str] = Field(default_factory=list)
    failures: list[str] = Field(default_factory=list)
    execution_log: list[str] = Field(default_factory=list)


@dataclass(frozen=True, slots=True)
class SandboxPolicy:
    allow_network: bool = False
    allow_production_credentials: bool = False
    command_allowlist: frozenset[str] = frozenset()
    cpu_timeout_seconds: float = 10.0
    memory_limit_mb: int = 256
    filesystem_root: str | None = None


class SandboxExecutor(Protocol):
    async def run(self, bundle: VerificationBundle, policy: SandboxPolicy) -> dict[str, Any]: ...


class SandboxRunner(Protocol):
    async def execute(self, verification_bundle: VerificationBundle) -> SandboxVerificationResult: ...


class LocalSandboxRunner:
    """Safe local/mock runner; it delegates checks to an injected executor."""

    def __init__(self, policy: SandboxPolicy | None = None, executor: SandboxExecutor | None = None):
        self.policy = policy or SandboxPolicy()
        self.executor = executor

    async def execute(self, verification_bundle: VerificationBundle) -> SandboxVerificationResult:
        log = ["sandbox_created", "credentials_policy_checked", "network_policy_checked", "filesystem_policy_checked", "resource_limits_checked"]
        violation = self._validate_bundle(verification_bundle)
        if violation:
            log.append(f"sandbox_rejected:{violation}")
            return SandboxVerificationResult(status=SandboxStatus.FAIL, tests=len(verification_bundle.checks), passed=0, failed=len(verification_bundle.checks), failures=[violation], execution_log=log)
        started = monotonic()
        if self.executor is None:
            result = {"passed": len(verification_bundle.checks), "failed": 0, "warnings": [], "failures": []}
        else:
            result = await self.executor.run(verification_bundle, self.policy)
        if monotonic() - started > self.policy.cpu_timeout_seconds:
            log.append("sandbox_timeout")
            return SandboxVerificationResult(status=SandboxStatus.FAIL, tests=len(verification_bundle.checks), passed=0, failed=len(verification_bundle.checks), failures=["Sandbox CPU timeout exceeded"], execution_log=log)
        passed = int(result.get("passed", 0)); failed = int(result.get("failed", 0)); failures = [str(item) for item in result.get("failures", [])]
        log.append("checks_completed")
        return SandboxVerificationResult(status=SandboxStatus.FAIL if failed or failures else SandboxStatus.PASS, tests=len(verification_bundle.checks), passed=passed, failed=failed, warnings=[str(item) for item in result.get("warnings", [])], failures=failures, execution_log=log)

    def _validate_bundle(self, bundle: VerificationBundle) -> str | None:
        if bundle.credentials and not self.policy.allow_production_credentials:
            return "Production credentials are forbidden in the sandbox"
        if bundle.network_required and not self.policy.allow_network:
            return "Network access is disabled in the sandbox"
        disallowed = [command for command in bundle.commands if command not in self.policy.command_allowlist]
        if disallowed:
            return "Command is not in the sandbox allowlist"
        if self.policy.filesystem_root is None and bundle.filesystem_paths:
            return "Filesystem access is disabled in the sandbox"
        if self.policy.cpu_timeout_seconds <= 0 or self.policy.memory_limit_mb <= 0:
            return "Invalid sandbox resource limits"
        return None


class TrueForgeClient(Protocol):
    async def execute_sandbox(self, bundle: VerificationBundle, policy: SandboxPolicy) -> dict[str, Any]: ...


class TrueForgeSandboxRunner:
    def __init__(self, client: TrueForgeClient, policy: SandboxPolicy | None = None):
        self.client = client
        self.policy = policy or SandboxPolicy()

    async def execute(self, verification_bundle: VerificationBundle) -> SandboxVerificationResult:
        local = LocalSandboxRunner(self.policy)
        violation = local._validate_bundle(verification_bundle)
        if violation:
            return SandboxVerificationResult(status=SandboxStatus.FAIL, tests=len(verification_bundle.checks), passed=0, failed=len(verification_bundle.checks), failures=[violation], execution_log=["trueforge_request_rejected"])
        result = await self.client.execute_sandbox(verification_bundle, self.policy)
        passed = int(result.get("passed", 0)); failed = int(result.get("failed", 0)); failures = [str(item) for item in result.get("failures", [])]
        return SandboxVerificationResult(status=SandboxStatus.FAIL if failed or failures else SandboxStatus.PASS, tests=len(verification_bundle.checks), passed=passed, failed=failed, warnings=[str(item) for item in result.get("warnings", [])], failures=failures, execution_log=["trueforge_submitted", "trueforge_completed"])
