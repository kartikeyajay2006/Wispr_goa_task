import pytest

from .postgres import PostgresConnector


class Result:
    def __init__(self, rows):
        self.rows = rows

    def mappings(self):
        return self

    def all(self):
        return self.rows


class ReadOnlyFakeSession:
    def __init__(self):
        self.calls = []

    async def execute(self, statement, parameters=None):
        self.calls.append((str(statement), parameters))
        sql = str(statement)
        if "FROM customers" in sql:
            return Result([{"id": "CUST-1042", "email": "masked@example.test", "phone": "masked"}])
        if "FROM orders" in sql:
            return Result([{"id": "ORDER-1", "customer_id": "CUST-1042", "total": 10, "status": "open"}])
        if "FROM invoices" in sql:
            return Result([{"id": "INV-1", "order_id": "ORDER-1", "total": 10, "status": "open"}])
        return Result([])


@pytest.mark.asyncio
async def test_find_customer_rows_is_parameterized_and_read_only():
    session = ReadOnlyFakeSession()
    result = await PostgresConnector(session).find_customer_rows("CUST-1042")
    assert {row.table for row in result} == {"customers", "orders", "invoices"}
    assert all("CUST-1042" not in sql for sql, _ in session.calls)
    assert all(params and "customer_id" in params or "order_ids" in params for _, params in session.calls)
    assert all(not sql.lstrip().upper().startswith(("INSERT", "UPDATE", "DELETE", "DROP", "ALTER")) for sql, _ in session.calls)


@pytest.mark.asyncio
async def test_related_rows_are_structured():
    result = await PostgresConnector(ReadOnlyFakeSession()).find_related_rows("CUST-1042", "invoices")
    assert result[0].relationship == "orders.order_id"
    assert result[0].record_id == "INV-1"


@pytest.mark.asyncio
async def test_unknown_table_is_rejected():
    with pytest.raises(ValueError):
        await PostgresConnector(ReadOnlyFakeSession()).fetch_record_metadata("customer; DROP TABLE customers", "1")


@pytest.mark.asyncio
async def test_absence_result_is_structured():
    class Empty(ReadOnlyFakeSession):
        async def execute(self, statement, parameters=None):
            self.calls.append((str(statement), parameters))
            return Result([])

    result = await PostgresConnector(Empty()).verify_customer_absence("CUST-2048")
    assert result == {"customer_id": "CUST-2048", "verified": True, "remaining": []}
