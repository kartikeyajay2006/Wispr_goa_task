CREATE TABLE IF NOT EXISTS users (id text PRIMARY KEY, customer_id text REFERENCES customers(id), email text, name text);
CREATE TABLE IF NOT EXISTS addresses (id text PRIMARY KEY, customer_id text REFERENCES customers(id), line1 text, city text, postal_code text);
CREATE TABLE IF NOT EXISTS order_items (id text PRIMARY KEY, order_id text REFERENCES orders(id), sku text, quantity integer NOT NULL);
CREATE TABLE IF NOT EXISTS payments (id text PRIMARY KEY, order_id text REFERENCES orders(id), provider_reference text, billing_email text);
CREATE TABLE IF NOT EXISTS support_tickets (id text PRIMARY KEY, customer_id text REFERENCES customers(id), subject text, status text);
CREATE TABLE IF NOT EXISTS analytics_events (id text PRIMARY KEY, customer_id text REFERENCES customers(id), event_name text, payload jsonb);
CREATE TABLE IF NOT EXISTS marketing_profiles (id text PRIMARY KEY, customer_id text REFERENCES customers(id), email text, preferences jsonb);

INSERT INTO users VALUES ('USR-1042-01','CUST-1042','demo-1042@example.invalid','Demo Customer') ON CONFLICT DO NOTHING;
INSERT INTO addresses VALUES ('ADDR-1042-01','CUST-1042','42 Demo Lane','Goa','403001'),('ADDR-1042-02','CUST-1042','7 Synthetic Road','Goa','403002') ON CONFLICT DO NOTHING;
INSERT INTO order_items VALUES ('ITEM-1042-01','ORD-1042-01','DEMO-SKU',1) ON CONFLICT DO NOTHING;
INSERT INTO payments VALUES ('PAY-1042-01','ORD-1042-01','demo-provider-ref','demo-1042@example.invalid') ON CONFLICT DO NOTHING;
INSERT INTO support_tickets VALUES ('TKT-1042-01','CUST-1042','Synthetic support request','open') ON CONFLICT DO NOTHING;
INSERT INTO analytics_events VALUES ('EVT-1042-01','CUST-1042','demo_login','{"synthetic":true}') ON CONFLICT DO NOTHING;
INSERT INTO marketing_profiles VALUES ('MKT-1042-01','CUST-1042','demo-1042@example.invalid','{"email":false}') ON CONFLICT DO NOTHING;
