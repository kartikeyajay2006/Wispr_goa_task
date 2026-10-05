CREATE TABLE IF NOT EXISTS eraseops_requests (
  id uuid PRIMARY KEY,
  customer_id text NOT NULL CHECK (customer_id ~ '^CUST-[0-9]{4}$'),
  requested_by text NOT NULL DEFAULT 'operator',
  reason text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS eraseops_plans (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES eraseops_requests(id),
  version integer NOT NULL DEFAULT 1,
  canonical jsonb NOT NULL,
  plan_hash text NOT NULL,
  status text NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, version),
  UNIQUE (request_id, plan_hash)
);
CREATE TABLE IF NOT EXISTS eraseops_approvals (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES eraseops_requests(id),
  plan_hash text NOT NULL,
  approved_by text NOT NULL,
  approved_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('approved','used','expired','rejected')),
  single_use boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS eraseops_execution_results (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES eraseops_requests(id),
  action_id text NOT NULL,
  action_key text NOT NULL,
  status text NOT NULL,
  affected_records integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  error text,
  UNIQUE (request_id, action_key)
);
