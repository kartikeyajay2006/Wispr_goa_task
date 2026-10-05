"""Persist blast-radius hashes for approval binding."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0006_blast_radius_reports"
down_revision = "0005_planner_action_details"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "blast_radius_reports",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("request_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("plan_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("blast_radius_hash", sa.String(length=128), nullable=False),
        sa.Column("report", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["plan_id"], ["deletion_plans.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["request_id"], ["deletion_requests.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("request_id", "plan_id", name="uq_blast_radius_request_plan"),
    )
    op.create_index("ix_blast_radius_reports_request_id", "blast_radius_reports", ["request_id"])
    op.create_index("ix_blast_radius_reports_plan_id", "blast_radius_reports", ["plan_id"])
    op.create_index("ix_blast_radius_reports_blast_radius_hash", "blast_radius_reports", ["blast_radius_hash"])


def downgrade() -> None:
    op.drop_index("ix_blast_radius_reports_blast_radius_hash", table_name="blast_radius_reports")
    op.drop_index("ix_blast_radius_reports_plan_id", table_name="blast_radius_reports")
    op.drop_index("ix_blast_radius_reports_request_id", table_name="blast_radius_reports")
    op.drop_table("blast_radius_reports")
