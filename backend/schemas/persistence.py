from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class SchemaBase(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class DeletionRequestCreate(BaseModel):
    customer_id: str = Field(min_length=1, max_length=255)
    requested_by: str = Field(min_length=1, max_length=255)


class DeletionRequestRead(SchemaBase):
    id: UUID
    customer_id: str
    status: str
    requested_by: str
    created_at: datetime
    updated_at: datetime


class CustomerIdentifierCreate(BaseModel):
    type: str = Field(min_length=1, max_length=100)
    value: str = Field(min_length=1, max_length=500)
    source: str = Field(min_length=1, max_length=255)
    confidence: str = Field(min_length=1, max_length=50)
    evidence: dict[str, Any] = Field(default_factory=dict)


class DiscoveredResourceCreate(BaseModel):
    request_id: UUID
    system: str = Field(min_length=1, max_length=100)
    resource_type: str = Field(min_length=1, max_length=100)
    resource_id: str = Field(min_length=1, max_length=500)
    contains_personal_data: bool = False
    classification: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    evidence: dict[str, Any] = Field(default_factory=dict)


class ResourceDependencyCreate(BaseModel):
    source_resource_id: UUID
    target_resource_id: UUID
    relationship_type: str = Field(min_length=1, max_length=100)
    constraint_type: str | None = None
    required: bool = False
    risk: str | None = None


class DeletionPlanCreate(BaseModel):
    request_id: UUID
    version: int = Field(ge=1)
    plan_hash: str = Field(min_length=1, max_length=128)


class PlannedActionCreate(BaseModel):
    plan_id: UUID
    system: str = Field(min_length=1, max_length=100)
    action_type: str = Field(min_length=1, max_length=50)
    target: str = Field(min_length=1, max_length=500)
    reason: str = Field(min_length=1)
    reversible: bool = False
    requires_approval: bool = True
    status: str = "planned"


class ApprovalCreate(BaseModel):
    request_id: UUID
    approver_id: str = Field(min_length=1, max_length=255)
    plan_hash: str = Field(min_length=1, max_length=128)
    blast_radius_hash: str = Field(min_length=1, max_length=128)
    approved_at: datetime
    status: str = "pending"


class AuditEventCreate(BaseModel):
    request_id: UUID
    actor: str = Field(min_length=1, max_length=255)
    action: str = Field(min_length=1, max_length=100)
    target: str | None = Field(default=None, max_length=500)
    result: dict[str, Any] = Field(default_factory=dict)
    previous_hash: str = Field(min_length=1, max_length=128)
    event_hash: str = Field(min_length=1, max_length=128)
