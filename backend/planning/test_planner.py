from uuid import uuid4

import pytest

from backend.discovery.engine import DiscoveredResourceEvidence
from backend.dependencies.graph import DependencyGraph
from backend.policies.engine import Decision, PolicyResult
from .planner import DeletionPlanner


def resource(system="postgres", identifier="row-1", classification="personal_data"):
    return DiscoveredResourceEvidence(system, "record", identifier, "customer", classification, {}, {"source": "connector", "value": identifier})


@pytest.mark.asyncio
async def test_fallback_plan_is_structured_and_deterministic():
    plan = await DeletionPlanner().plan(uuid4(), [resource()], DependencyGraph(), [PolicyResult(Decision.ALLOW_WITH_APPROVAL, "POL-1", "review", "high")])
    assert plan.actions[0].action_type == "DELETE_RECORD"
    assert plan.actions[0].requires_approval is True
    assert len(plan.plan_hash) == 64


@pytest.mark.asyncio
async def test_unsafe_resource_is_retained():
    graph = DependencyGraph(nodes={}, edges=[])
    from backend.dependencies.graph import DependencyNode, DependencyEdge
    graph.nodes["row-1"] = DependencyNode("postgres", "record", "row-1", "customer", "personal_data", None, "delete")
    graph.nodes["parent"] = DependencyNode("postgres", "record", "parent", "customer", "business", None, "retain")
    graph.edges.append(DependencyEdge("row-1", "parent", "ownership", "shared", "critical"))
    plan = await DeletionPlanner().plan(uuid4(), [resource()], graph, [])
    assert plan.actions[0].action_type == "RETAIN"


@pytest.mark.asyncio
async def test_invalid_llm_action_is_rejected():
    class Model:
        async def propose(self, resources, graph, policies):
            return {"actions": [{"action_type": "UNSUPPORTED", "system": "postgres", "target": "x"}]}
    with pytest.raises(ValueError, match="Invalid planner action"):
        await DeletionPlanner(Model()).plan(uuid4(), [resource()], DependencyGraph(), [])
