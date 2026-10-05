"""Create the EraseOps persistence model."""

from alembic import op

from backend.db.base import Base
from backend import models  # noqa: F401 - register all tables

revision = "0001_initial_persistence"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    Base.metadata.create_all(bind=op.get_bind())


def downgrade() -> None:
    Base.metadata.drop_all(bind=op.get_bind())
