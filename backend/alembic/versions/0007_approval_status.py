"""Allow approval lifecycle states beyond the workflow enum."""

from alembic import op

revision = "0007_approval_status"
down_revision = "0006_blast_radius_reports"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE approvals ALTER COLUMN status TYPE VARCHAR(32) "
        "USING status::text"
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE approvals ALTER COLUMN status TYPE workflow_status "
        "USING status::workflow_status"
    )
