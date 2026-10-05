# TrueForge skill boundaries

The local demo expects these logical roles:

- Discovery: read-only metadata discovery across allowlisted connectors.
- Dependency: foreign-key, retention, and cross-customer impact analysis.
- Privacy planner: proposes DELETE, ANONYMIZE, or RETAIN actions.
- Safety: reviews risks and never overrides deterministic policy.
- Verification: runs fixture-only sandbox checks.
- Execution coordinator: requests human approval and invokes structured destructive tools only after policy validation.
- Audit: explains and seals the event trail.

No role receives database credentials, MinIO secrets, arbitrary SQL capability, or unrestricted destructive access.
