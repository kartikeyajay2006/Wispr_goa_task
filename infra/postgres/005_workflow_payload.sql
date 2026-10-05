ALTER TABLE eraseops_requests
  ADD COLUMN IF NOT EXISTS workflow_payload jsonb;

COMMENT ON COLUMN eraseops_requests.workflow_payload IS
  'Canonical server-generated workflow snapshot; never populated from browser input.';
