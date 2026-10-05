-- Read-only discovery projection used by the PostgreSQL connector.
-- Counts are derived from the seeded tables; no customer values are exposed.
CREATE OR REPLACE VIEW eraseops_customer_footprint AS
SELECT 'customers'::text AS table_name, id AS customer_id, 1::integer AS record_count
FROM customers
UNION ALL
SELECT 'users', customer_id, count(*)::integer FROM users GROUP BY customer_id
UNION ALL
SELECT 'addresses', customer_id, count(*)::integer FROM addresses GROUP BY customer_id
UNION ALL
SELECT 'orders', customer_id, count(*)::integer FROM orders GROUP BY customer_id
UNION ALL
SELECT 'order_items', o.customer_id, count(*)::integer FROM order_items oi JOIN orders o ON o.id = oi.order_id GROUP BY o.customer_id
UNION ALL
SELECT 'payments', o.customer_id, count(*)::integer FROM payments p JOIN orders o ON o.id = p.order_id GROUP BY o.customer_id
UNION ALL
SELECT 'support_tickets', customer_id, count(*)::integer FROM support_tickets GROUP BY customer_id
UNION ALL
SELECT 'support_messages', customer_id, count(*)::integer FROM support_messages GROUP BY customer_id
UNION ALL
SELECT 'analytics_events', customer_id, count(*)::integer FROM analytics_events GROUP BY customer_id
UNION ALL
SELECT 'marketing_profiles', customer_id, count(*)::integer FROM marketing_profiles GROUP BY customer_id
UNION ALL
SELECT 'audit_records', customer_id, count(*)::integer FROM audit_records GROUP BY customer_id;
