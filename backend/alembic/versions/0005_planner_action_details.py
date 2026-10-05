"""Store complete deterministic planner action details."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0005_planner_action_details"
down_revision = "0004_demo_connector_tables"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("planned_actions", sa.Column("evidence", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'{}'")))
    op.add_column("planned_actions", sa.Column("expected_effect", sa.Text(), nullable=True))
    op.add_column("planned_actions", sa.Column("verification_criteria", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'[]'")))
    op.add_column("planned_actions", sa.Column("rollback_strategy", sa.Text(), nullable=True))
    op.add_column("planned_actions", sa.Column("policy_decision", sa.String(length=100), nullable=True))


def downgrade() -> None:
    op.drop_column("planned_actions", "policy_decision")
    op.drop_column("planned_actions", "rollback_strategy")
    op.drop_column("planned_actions", "verification_criteria")
    op.drop_column("planned_actions", "expected_effect")
    op.drop_column("planned_actions", "evidence")
