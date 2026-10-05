CREATE TABLE IF NOT EXISTS eraseops_audit_events (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  timestamp timestamptz NOT NULL,
  actor text NOT NULL CHECK (actor IN ('system','operator','policy-engine','connector')),
  stage text NOT NULL,
  message text NOT NULL,
  plan_hash text,
  previous_hash text NOT NULL,
  event_hash text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (request_id, sequence),
  UNIQUE (request_id, event_hash)
);
CREATE INDEX IF NOT EXISTS eraseops_audit_request_sequence ON eraseops_audit_events(request_id, sequence);
