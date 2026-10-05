import pytest

from .runner import LocalSandboxRunner, SandboxPolicy, SandboxStatus, VerificationBundle


def bundle(**values):
    defaults = {"checks": [{"check": "foreign_key_integrity", "expected": True}]}
    defaults.update(values)
    return VerificationBundle(**defaults)


@pytest.mark.asyncio
async def test_local_runner_returns_structured_pass():
    result = await LocalSandboxRunner().execute(bundle())
    assert result.model_dump(exclude={"execution_log"}) == {"status": "PASS", "tests": 1, "passed": 1, "failed": 0, "warnings": [], "failures": []}
    assert result.execution_log


@pytest.mark.asyncio
@pytest.mark.parametrize("values,expected", [({"credentials": ["write-token"]}, "Production credentials"), ({"network_required": True}, "Network access"), ({"commands": ["rm"]}, "allowlist"), ({"filesystem_paths": ["/data"]}, "Filesystem")])
async def test_local_runner_rejects_unsafe_capabilities(values, expected):
    result = await LocalSandboxRunner().execute(bundle(**values))
    assert result.status is SandboxStatus.FAIL
    assert expected in result.failures[0]


@pytest.mark.asyncio
async def test_critical_check_failure_stops_with_fail():
    class FailingExecutor:
        async def run(self, bundle, policy):
            return {"passed": 0, "failed": 1, "failures": ["critical check failed"], "warnings": []}

    result = await LocalSandboxRunner(executor=FailingExecutor()).execute(bundle())
    assert result.status is SandboxStatus.FAIL
    assert result.failed == 1
