-- Brings the demo schema in line with infra/fixtures/demo-dataset.json.
-- Rows are loaded by `npm run seed:local` (or POST /api/demo/reset in local mode),
-- so the fixture stays the single source of demo data for mock and local modes.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS region text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at timestamptz;
ALTER TABLE addresses ADD COLUMN IF NOT EXISTS country text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS currency text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS amount numeric;
ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS ticket_id text REFERENCES support_tickets(id);

CREATE TABLE IF NOT EXISTS organizations (id text PRIMARY KEY, owner_customer_id text REFERENCES customers(id), name text, billing_email text);
CREATE TABLE IF NOT EXISTS organization_members (id text PRIMARY KEY, org_id text NOT NULL REFERENCES organizations(id), customer_id text REFERENCES customers(id), role text);

CREATE OR REPLACE VIEW eraseops_customer_footprint AS
SELECT 'customers'::text AS table_name, id AS customer_id, 1::integer AS record_count FROM customers
UNION ALL SELECT 'users', customer_id, count(*)::integer FROM users GROUP BY customer_id
UNION ALL SELECT 'addresses', customer_id, count(*)::integer FROM addresses GROUP BY customer_id
UNION ALL SELECT 'orders', customer_id, count(*)::integer FROM orders GROUP BY customer_id
UNION ALL SELECT 'order_items', o.customer_id, count(*)::integer FROM order_items oi JOIN orders o ON o.id = oi.order_id GROUP BY o.customer_id
UNION ALL SELECT 'payments', o.customer_id, count(*)::integer FROM payments p JOIN orders o ON o.id = p.order_id GROUP BY o.customer_id
UNION ALL SELECT 'support_tickets', customer_id, count(*)::integer FROM support_tickets GROUP BY customer_id
UNION ALL SELECT 'support_messages', customer_id, count(*)::integer FROM support_messages GROUP BY customer_id
UNION ALL SELECT 'analytics_events', customer_id, count(*)::integer FROM analytics_events GROUP BY customer_id
UNION ALL SELECT 'marketing_profiles', customer_id, count(*)::integer FROM marketing_profiles GROUP BY customer_id
UNION ALL SELECT 'audit_records', customer_id, count(*)::integer FROM audit_records GROUP BY customer_id
UNION ALL SELECT 'organizations', owner_customer_id, count(*)::integer FROM organizations GROUP BY owner_customer_id
UNION ALL SELECT 'organization_members', customer_id, count(*)::integer FROM organization_members GROUP BY customer_id;
