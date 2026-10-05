"""Persist LangGraph workflow checkpoints."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0002_workflow_runs"
down_revision = "0001_initial_persistence"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "workflow_runs",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("request_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("current_status", sa.String(length=64), nullable=False),
        sa.Column("state", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["request_id"], ["deletion_requests.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("request_id"),
    )
    op.create_index("ix_workflow_runs_request_id", "workflow_runs", ["request_id"], unique=False)
    op.create_index("ix_workflow_runs_current_status", "workflow_runs", ["current_status"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_workflow_runs_current_status", table_name="workflow_runs")
    op.drop_index("ix_workflow_runs_request_id", table_name="workflow_runs")
    op.drop_table("workflow_runs")
