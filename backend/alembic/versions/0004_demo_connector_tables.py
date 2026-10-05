"""Create minimal read-only connector demo tables and synthetic seed rows."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0004_demo_connector_tables"
down_revision = "0003_identity_resolution"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table("customers", sa.Column("id", sa.String(255), primary_key=True), sa.Column("email", sa.String(255), nullable=False), sa.Column("phone", sa.String(64)))
    op.create_table("orders", sa.Column("id", sa.String(255), primary_key=True), sa.Column("customer_id", sa.String(255), sa.ForeignKey("customers.id"), nullable=False), sa.Column("total", sa.Numeric(12, 2), nullable=False), sa.Column("status", sa.String(32), nullable=False))
    op.create_table("invoices", sa.Column("id", sa.String(255), primary_key=True), sa.Column("order_id", sa.String(255), sa.ForeignKey("orders.id"), nullable=False), sa.Column("total", sa.Numeric(12, 2), nullable=False), sa.Column("status", sa.String(32), nullable=False))
    op.create_index("ix_orders_customer_id", "orders", ["customer_id"])
    op.create_index("ix_invoices_order_id", "invoices", ["order_id"])
    op.execute(sa.text("INSERT INTO customers (id, email, phone) VALUES (:first_id, :first_email, :first_phone), (:second_id, :second_email, :second_phone)"), {"first_id": "CUST-1042", "first_email": "customer-1042@example.invalid", "first_phone": "+10000001042", "second_id": "CUST-2048", "second_email": "customer-2048@example.invalid", "second_phone": "+10000002048"})
    op.execute(sa.text("INSERT INTO orders (id, customer_id, total, status) VALUES (:first_order, :first_customer, :first_total, :first_status), (:second_order, :second_customer, :second_total, :second_status)"), {"first_order": "ORDER-1042", "first_customer": "CUST-1042", "first_total": 100, "first_status": "open", "second_order": "ORDER-2048", "second_customer": "CUST-2048", "second_total": 200, "second_status": "open"})
    op.execute(sa.text("INSERT INTO invoices (id, order_id, total, status) VALUES (:first_invoice, :first_order, :first_total, :first_status), (:second_invoice, :second_order, :second_total, :second_status)"), {"first_invoice": "INVOICE-1042", "first_order": "ORDER-1042", "first_total": 100, "first_status": "issued", "second_invoice": "INVOICE-2048", "second_order": "ORDER-2048", "second_total": 200, "second_status": "issued"})


def downgrade() -> None:
    op.drop_index("ix_invoices_order_id", table_name="invoices")
    op.drop_index("ix_orders_customer_id", table_name="orders")
    op.drop_table("invoices")
    op.drop_table("orders")
    op.drop_table("customers")
