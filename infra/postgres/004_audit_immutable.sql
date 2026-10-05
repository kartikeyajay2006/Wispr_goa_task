CREATE OR REPLACE FUNCTION eraseops_reject_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'eraseops audit_events is append-only';
END;
$$;

DROP TRIGGER IF EXISTS eraseops_audit_events_immutable ON eraseops_audit_events;
CREATE TRIGGER eraseops_audit_events_immutable
BEFORE UPDATE OR DELETE ON eraseops_audit_events
FOR EACH ROW EXECUTE FUNCTION eraseops_reject_audit_mutation();
