"""Bind execution results to idempotency and audit events."""
from alembic import op
import sqlalchemy as sa

revision = "0008_controlled_execution"
down_revision = "0007_approval_status"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("execution_results", sa.Column("idempotency_key", sa.String(128), nullable=True))
    op.add_column("execution_results", sa.Column("audit_event_hash", sa.String(128), nullable=True))
    op.create_index("ix_execution_results_idempotency_key", "execution_results", ["idempotency_key"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_execution_results_idempotency_key", table_name="execution_results")
    op.drop_column("execution_results", "audit_event_hash")
    op.drop_column("execution_results", "idempotency_key")
