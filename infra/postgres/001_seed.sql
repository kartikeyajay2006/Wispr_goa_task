CREATE TABLE IF NOT EXISTS customers (id text primary key, email text, name text);
CREATE TABLE IF NOT EXISTS orders (id text primary key, customer_id text references customers(id), total numeric, created_at timestamptz default now());
CREATE TABLE IF NOT EXISTS support_messages (id text primary key, customer_id text references customers(id), body text);
CREATE TABLE IF NOT EXISTS audit_records (id text primary key, customer_id text, event text, created_at timestamptz default now());
INSERT INTO customers VALUES ('CUST-1042','demo-1042@example.invalid','Demo Customer') ON CONFLICT DO NOTHING;
INSERT INTO orders VALUES ('ORD-1042-01','CUST-1042',129.00) ON CONFLICT DO NOTHING;
INSERT INTO support_messages VALUES ('MSG-1042-01','CUST-1042','Demo support message') ON CONFLICT DO NOTHING;
INSERT INTO audit_records VALUES ('AUD-1042-01','CUST-1042','retention record') ON CONFLICT DO NOTHING;
