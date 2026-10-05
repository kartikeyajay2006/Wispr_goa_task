"""Store deterministic resolved identity mappings."""

from alembic import op
import sqlalchemy as sa

revision = "0003_identity_resolution"
down_revision = "0002_workflow_runs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("uq_customer_identifier", "customer_identifiers", type_="unique")
    op.drop_column("customer_identifiers", "identifier_hash")
    op.drop_column("customer_identifiers", "metadata")
    op.add_column("customer_identifiers", sa.Column("value", sa.String(length=500), nullable=False))
    op.add_column("customer_identifiers", sa.Column("source", sa.String(length=255), nullable=False))
    op.add_column("customer_identifiers", sa.Column("confidence", sa.String(length=50), nullable=False))
    op.add_column("customer_identifiers", sa.Column("evidence", sa.JSON(), nullable=False, server_default=sa.text("'{}'")))
    op.create_unique_constraint("uq_customer_identifier", "customer_identifiers", ["request_id", "identifier_type", "value", "source"])


def downgrade() -> None:
    op.drop_constraint("uq_customer_identifier", "customer_identifiers", type_="unique")
    op.drop_column("customer_identifiers", "evidence")
    op.drop_column("customer_identifiers", "confidence")
    op.drop_column("customer_identifiers", "source")
    op.drop_column("customer_identifiers", "value")
    op.add_column("customer_identifiers", sa.Column("identifier_hash", sa.String(length=255), nullable=False))
    op.add_column("customer_identifiers", sa.Column("metadata", sa.JSON(), nullable=False, server_default=sa.text("'{}'")))
    op.create_unique_constraint("uq_customer_identifier", "customer_identifiers", ["request_id", "identifier_type", "identifier_hash"])
