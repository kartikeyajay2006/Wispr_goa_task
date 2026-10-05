-- Demo-only seed data. Run after `alembic upgrade head`.
-- The identifiers and object keys are intentionally supplied by this fixture,
-- not embedded in application decision logic.
INSERT INTO customers (id, email, phone)
VALUES ('CUST-1042', 'customer-1042@example.invalid', '+10000001042')
ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, phone = EXCLUDED.phone;

INSERT INTO orders (id, customer_id, total, status)
VALUES
  ('ORDER-1042-A', 'CUST-1042', 100, 'open'),
  ('ORDER-1042-B', 'CUST-1042', 200, 'open'),
  ('ORDER-1042-C', 'CUST-1042', 300, 'open')
ON CONFLICT (id) DO UPDATE SET customer_id = EXCLUDED.customer_id, total = EXCLUDED.total, status = EXCLUDED.status;

INSERT INTO invoices (id, order_id, total, status)
VALUES
  ('INVOICE-1042-A', 'ORDER-1042-A', 100, 'issued'),
  ('INVOICE-1042-B', 'ORDER-1042-B', 200, 'issued')
ON CONFLICT (id) DO UPDATE SET order_id = EXCLUDED.order_id, total = EXCLUDED.total, status = EXCLUDED.status;

-- S3 is represented by the connector fixture below; no production bucket is touched.
