from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from backend.db.base import Base


class BlastRadiusReport(Base):
    __tablename__ = "blast_radius_reports"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    request_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("deletion_requests.id", ondelete="CASCADE"), nullable=False, index=True)
    plan_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("deletion_plans.id", ondelete="CASCADE"), nullable=False, index=True)
    blast_radius_hash: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    report: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    __table_args__ = (UniqueConstraint("request_id", "plan_id", name="uq_blast_radius_request_plan"),)
