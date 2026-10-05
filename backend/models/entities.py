from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, Enum, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.db.base import Base

Status = Enum("pending", "running", "completed", "failed", "blocked", "rejected", name="workflow_status")
ActionStatus = Enum("planned", "approved", "running", "completed", "failed", "skipped", name="action_status")
DecisionStatus = Enum("allow", "deny", "require_approval", name="policy_decision_status")


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)


class DeletionRequest(TimestampMixin, Base):
    __tablename__ = "deletion_requests"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    customer_id: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    status: Mapped[str] = mapped_column(Status, nullable=False, default="pending", index=True)
    requested_by: Mapped[str] = mapped_column(String(255), nullable=False)
    identifiers: Mapped[list[CustomerIdentifier]] = relationship(back_populates="request", cascade="all, delete-orphan")
    resources: Mapped[list[DiscoveredResource]] = relationship(back_populates="request", cascade="all, delete-orphan")
    plans: Mapped[list[DeletionPlan]] = relationship(back_populates="request", cascade="all, delete-orphan")
    approvals: Mapped[list[Approval]] = relationship(back_populates="request", cascade="all, delete-orphan")
    audit_events: Mapped[list[AuditEvent]] = relationship(back_populates="request", cascade="all, delete-orphan")


class CustomerIdentifier(Base):
    __tablename__ = "customer_identifiers"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    request_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("deletion_requests.id", ondelete="CASCADE"), nullable=False, index=True)
    identifier_type: Mapped[str] = mapped_column(String(100), nullable=False)
    value: Mapped[str] = mapped_column(String(500), nullable=False)
    source: Mapped[str] = mapped_column(String(255), nullable=False)
    confidence: Mapped[str] = mapped_column(String(50), nullable=False)
    evidence: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    request: Mapped[DeletionRequest] = relationship(back_populates="identifiers")
    __table_args__ = (UniqueConstraint("request_id", "identifier_type", "value", "source", name="uq_customer_identifier"),)


class DiscoveredResource(Base):
    __tablename__ = "discovered_resources"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    request_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("deletion_requests.id", ondelete="CASCADE"), nullable=False, index=True)
    system: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    resource_type: Mapped[str] = mapped_column(String(100), nullable=False)
    resource_id: Mapped[str] = mapped_column(String(500), nullable=False)
    contains_personal_data: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    classification: Mapped[str | None] = mapped_column(String(100))
    metadata: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    evidence: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    request: Mapped[DeletionRequest] = relationship(back_populates="resources")
    dependencies_from: Mapped[list[ResourceDependency]] = relationship(foreign_keys="ResourceDependency.source_resource_id", back_populates="source_resource", cascade="all, delete-orphan")
    dependencies_to: Mapped[list[ResourceDependency]] = relationship(foreign_keys="ResourceDependency.target_resource_id", back_populates="target_resource", cascade="all, delete-orphan")
    __table_args__ = (Index("ix_resources_request_system", "request_id", "system"), UniqueConstraint("request_id", "system", "resource_id", name="uq_discovered_resource"))


class ResourceDependency(Base):
    __tablename__ = "resource_dependencies"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    source_resource_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("discovered_resources.id", ondelete="CASCADE"), nullable=False, index=True)
    target_resource_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("discovered_resources.id", ondelete="CASCADE"), nullable=False, index=True)
    relationship_type: Mapped[str] = mapped_column(String(100), nullable=False)
    constraint_type: Mapped[str | None] = mapped_column(String(100))
    required: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    risk: Mapped[str | None] = mapped_column(String(50))
    source_resource: Mapped[DiscoveredResource] = relationship(foreign_keys=[source_resource_id], back_populates="dependencies_from")
    target_resource: Mapped[DiscoveredResource] = relationship(foreign_keys=[target_resource_id], back_populates="dependencies_to")
    __table_args__ = (UniqueConstraint("source_resource_id", "target_resource_id", "relationship_type", name="uq_resource_dependency"),)


class DeletionPlan(Base):
    __tablename__ = "deletion_plans"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    request_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("deletion_requests.id", ondelete="CASCADE"), nullable=False, index=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    plan_hash: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    status: Mapped[str] = mapped_column(Status, nullable=False, default="pending")
    generated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    request: Mapped[DeletionRequest] = relationship(back_populates="plans")
    actions: Mapped[list[PlannedAction]] = relationship(back_populates="plan", cascade="all, delete-orphan")
    __table_args__ = (UniqueConstraint("request_id", "version", name="uq_plan_version"),)


class PlannedAction(Base):
    __tablename__ = "planned_actions"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    plan_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("deletion_plans.id", ondelete="CASCADE"), nullable=False, index=True)
    system: Mapped[str] = mapped_column(String(100), nullable=False)
    action_type: Mapped[str] = mapped_column(String(50), nullable=False)
    target: Mapped[str] = mapped_column(String(500), nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    reversible: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    requires_approval: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    status: Mapped[str] = mapped_column(ActionStatus, nullable=False, default="planned", index=True)
    evidence: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    expected_effect: Mapped[str | None] = mapped_column(Text)
    verification_criteria: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    rollback_strategy: Mapped[str | None] = mapped_column(Text)
    policy_decision: Mapped[str | None] = mapped_column(String(100))
    plan: Mapped[DeletionPlan] = relationship(back_populates="actions")


class SandboxRun(Base):
    __tablename__ = "sandbox_runs"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    request_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("deletion_requests.id", ondelete="CASCADE"), nullable=False, index=True)
    plan_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("deletion_plans.id", ondelete="CASCADE"), nullable=False, index=True)
    status: Mapped[str] = mapped_column(Status, nullable=False, default="pending")
    tests: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False, default=list)
    warnings: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    failures: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    executed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class PolicyDecision(Base):
    __tablename__ = "policy_decisions"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    request_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("deletion_requests.id", ondelete="CASCADE"), nullable=False, index=True)
    plan_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("deletion_plans.id", ondelete="SET NULL"), index=True)
    decision: Mapped[str] = mapped_column(DecisionStatus, nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    evaluated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class Approval(Base):
    __tablename__ = "approvals"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    request_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("deletion_requests.id", ondelete="CASCADE"), nullable=False, index=True)
    approver_id: Mapped[str] = mapped_column(String(255), nullable=False)
    plan_hash: Mapped[str] = mapped_column(String(128), nullable=False)
    blast_radius_hash: Mapped[str] = mapped_column(String(128), nullable=False)
    approved_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    status: Mapped[str] = mapped_column(Status, nullable=False, default="pending", index=True)
    request: Mapped[DeletionRequest] = relationship(back_populates="approvals")


class ExecutionResult(Base):
    __tablename__ = "execution_results"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    request_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("deletion_requests.id", ondelete="CASCADE"), nullable=False, index=True)
    action_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("planned_actions.id", ondelete="CASCADE"), nullable=False, index=True)
    status: Mapped[str] = mapped_column(Status, nullable=False)
    affected_records: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    error: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class VerificationResult(Base):
    __tablename__ = "verification_results"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    request_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("deletion_requests.id", ondelete="CASCADE"), nullable=False, index=True)
    system: Mapped[str] = mapped_column(String(100), nullable=False)
    remaining_matches: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    verified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    details: Mapped[str] = mapped_column(Text, nullable=False)
    verified_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class AuditEvent(Base):
    __tablename__ = "audit_events"
    event_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    request_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("deletion_requests.id", ondelete="CASCADE"), nullable=False, index=True)
    actor: Mapped[str] = mapped_column(String(255), nullable=False)
    action: Mapped[str] = mapped_column(String(100), nullable=False)
    target: Mapped[str | None] = mapped_column(String(500))
    result: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    previous_hash: Mapped[str] = mapped_column(String(128), nullable=False)
    event_hash: Mapped[str] = mapped_column(String(128), nullable=False, unique=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False, index=True)
    request: Mapped[DeletionRequest] = relationship(back_populates="audit_events")
    __table_args__ = (Index("ix_audit_request_timestamp", "request_id", "timestamp"),)
