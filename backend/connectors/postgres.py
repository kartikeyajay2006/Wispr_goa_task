from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


class ReadOnlySession(Protocol):
    async def execute(self, statement: Any, parameters: dict[str, Any] | None = None) -> Any: ...


@dataclass(frozen=True, slots=True)
class RecordEvidence:
    system: str
    table: str
    record_id: str
    customer_id: str
    metadata: dict[str, Any]
    relationship: str | None = None
    classification: str = "personal_data"


@dataclass(frozen=True, slots=True)
class ForeignKeyEvidence:
    table: str
    column: str
    referenced_table: str
    referenced_column: str


class PostgresConnector:
    """Read-only PostgreSQL discovery connector.

    It accepts structured method arguments only. SQL is private to this class;
    caller and model input can never provide SQL fragments or identifiers.
    """

    _tables = frozenset({"customers", "orders", "invoices"})
    _table_columns = {
        "customers": ("id", "email", "phone"),
        "orders": ("id", "customer_id", "total", "status"),
        "invoices": ("id", "order_id", "total", "status"),
    }
    _relationships = {
        "orders": ("customer_id", "customers", "id"),
        "invoices": ("order_id", "orders", "id"),
    }

    def __init__(self, session: ReadOnlySession):
        self._session = session

    async def inspect_schema(self) -> list[dict[str, Any]]:
        statement = text("""
            SELECT table_name, column_name, data_type
            FROM information_schema.columns
            WHERE table_schema = :schema AND table_name = ANY(:tables)
            ORDER BY table_name, ordinal_position
        """)
        result = await self._session.execute(statement, {"schema": "public", "tables": list(self._tables)})
        return [dict(row) for row in result.mappings().all()]

    async def inspect_foreign_keys(self) -> list[ForeignKeyEvidence]:
        statement = text("""
            SELECT tc.table_name AS table_name,
                   kcu.column_name AS column_name,
                   ccu.table_name AS referenced_table,
                   ccu.column_name AS referenced_column
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name
             AND tc.table_schema = kcu.table_schema
            JOIN information_schema.constraint_column_usage ccu
              ON ccu.constraint_name = tc.constraint_name
             AND ccu.table_schema = tc.table_schema
            WHERE tc.constraint_type = 'FOREIGN KEY'
              AND tc.table_schema = :schema
              AND tc.table_name = ANY(:tables)
            ORDER BY tc.table_name, kcu.column_name
        """)
        result = await self._session.execute(statement, {"schema": "public", "tables": list(self._tables)})
        return [ForeignKeyEvidence(**dict(row)) for row in result.mappings().all()]

    async def find_customer_rows(self, customer_id: str) -> list[RecordEvidence]:
        self._validate_customer_id(customer_id)
        rows: list[RecordEvidence] = []
        customer_query = text("SELECT id, email, phone FROM customers WHERE id = :customer_id")
        customer_result = await self._session.execute(customer_query, {"customer_id": customer_id})
        rows.extend(self._evidence("customers", customer_id, customer_result.mappings().all(), "id"))
        orders_query = text("SELECT id, customer_id, total, status FROM orders WHERE customer_id = :customer_id")
        orders_result = await self._session.execute(orders_query, {"customer_id": customer_id})
        orders = orders_result.mappings().all()
        rows.extend(self._evidence("orders", customer_id, orders, "id"))
        order_ids = [row["id"] for row in orders]
        if order_ids:
            invoices_query = text("SELECT id, order_id, total, status FROM invoices WHERE order_id = ANY(:order_ids)")
            invoice_result = await self._session.execute(invoices_query, {"order_ids": order_ids})
            rows.extend(self._evidence("invoices", customer_id, invoice_result.mappings().all(), "id", "orders.order_id"))
        return rows

    async def find_related_rows(self, customer_id: str, resource: str) -> list[RecordEvidence]:
        self._validate_customer_id(customer_id)
        if resource not in self._relationships:
            raise ValueError(f"Unsupported related resource: {resource}")
        if resource == "orders":
            return [row for row in await self.find_customer_rows(customer_id) if row.table == "orders"]
        orders = await self.find_related_rows(customer_id, "orders")
        order_ids = [row.record_id for row in orders]
        if not order_ids:
            return []
        result = await self._session.execute(text("SELECT id, order_id, total, status FROM invoices WHERE order_id = ANY(:order_ids)"), {"order_ids": order_ids})
        return self._evidence("invoices", customer_id, result.mappings().all(), "id", "orders.order_id")

    async def fetch_record_metadata(self, table: str, record_id: str) -> RecordEvidence | None:
        self._validate_table(table)
        columns = ", ".join(self._table_columns[table])
        result = await self._session.execute(text(f"SELECT {columns} FROM {table} WHERE id = :record_id"), {"record_id": record_id})
        rows = result.mappings().all()
        if not rows:
            return None
        row = dict(rows[0])
        customer_id = str(row.get("customer_id") or "")
        return RecordEvidence(system="postgresql", table=table, record_id=str(row["id"]), customer_id=customer_id, metadata=row)

    async def verify_customer_absence(self, customer_id: str) -> dict[str, Any]:
        self._validate_customer_id(customer_id)
        remaining = await self.find_customer_rows(customer_id)
        return {"customer_id": customer_id, "verified": not remaining, "remaining": remaining}

    @classmethod
    def _validate_customer_id(cls, customer_id: str) -> None:
        if not customer_id or not customer_id.strip():
            raise ValueError("customer_id is required")

    @classmethod
    def _validate_table(cls, table: str) -> None:
        if table not in cls._tables:
            raise ValueError(f"Unsupported table: {table}")

    @staticmethod
    def _evidence(table: str, customer_id: str, records: list[Any], id_column: str, relationship: str | None = None) -> list[RecordEvidence]:
        return [RecordEvidence(system="postgresql", table=table, record_id=str(record[id_column]), customer_id=customer_id, metadata=dict(record), relationship=relationship) for record in records]
