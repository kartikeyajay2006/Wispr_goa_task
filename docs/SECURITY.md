# EraseOps security model

EraseOps is a demo of irreversible operations done carefully. These are the controls the code enforces, and where each one lives.

## Boundaries

- **Demo mode only.** `loadConfig` refuses to start unless `DEMO_MODE=true` (`apps/api/src/config.ts`). Connectors refuse contexts without `demoMode`.
- **Allowlists.** Connectors touch only `ALLOWLIST_HOSTS` and `ALLOWLIST_BUCKETS`. Tables come from the schema registry (`packages/connectors/src/schema.ts`); anything else is rejected before a query is built.
- **Metadata at the model boundary.** Discovery, dependency inspection and the MCP tools return table names, counts and record IDs. Values stay inside connectors. Customer names and emails are masked in read models (`packages/connectors/src/masking.ts`).
- **Parameterized SQL.** Every discovery, erasure, rescan and backup query binds the customer as `$1`. Identifiers are taken only from the schema registry, never from request input.

## The path to a destructive action

1. **Policy.** Classification comes from the versioned retention policy (`packages/policy-engine/src/retention-policy.ts`). Unknown resources are retained and flagged.
2. **Sandbox.** Each connector simulates the plan: in mock mode on a cloned dataset, in local mode inside a PostgreSQL transaction that is always rolled back. Orphaned foreign keys, changes to records owned by other customers, or residual personal data block the plan.
3. **Backup.** Every affected row and object is copied, then re-read and checksummed by the connector. Objects that cannot be read (for example `storage-tier: ARCHIVE`) block approval.
4. **Approval.** The operator types the customer ID. The approval binds to the canonical SHA-256 plan hash, records the operator from `x-operator-identity`, expires after `APPROVAL_TTL_MINUTES`, and is single-use. Dry runs cannot be approved.
5. **Guarded execution.** `POST /api/requests/:id/execute-guarded` checks request ID, approval ID and plan hash against the server's own copy (`apps/api/src/destructive-guard.ts`), requires an operator identity, and is rate-limited per operator. The engine re-checks expiry, reuse and selector shape for every action, and the owning connector re-checks the plan hash before mutating anything.
6. **Rescan.** Execution is only `COMPLETED` when every connector reports zero residual personal data. Otherwise the request fails and `POST /api/requests/:id/rollback` restores the request backup.

## Agents

The LangGraph agents (`apps/api/src/agent`) sit outside the destructive path:

- Their tools are the read-only MCP catalog, invoked with `approved: false`. Destructive tool names are never declared to the model, and `runAgentTool` refuses them if a model asks anyway.
- Models receive metadata and masked names only. Customer IDs a model returns are checked against the live customer list.
- The planner opens requests through the same `WorkflowService` as the console, so the sandbox, backup and policy gates are unchanged.
- The run pauses with LangGraph `interrupt()`. Resuming requires the `x-operator-identity` header and the typed customer ID; the executor then approves and executes as that person, through the guarded route and its rate limit.
- Every Claude call opts into server-side refusal fallbacks and checks the stop reason; a refusal or failure falls back to the rule-based twin of that node.

The MCP server (`apps/mcp-server`) applies the same rules: destructive tools need injected authorization whose plan hash and approval ID match, plus the same rate limiter.

## Audit trail

Every workflow event carries a sequence number, the previous event's hash and its own SHA-256 hash (`packages/audit`). `GET /api/audit` and `GET /api/requests/:id/audit` re-verify the chain on every call, so an edited event is reported as a broken link. `infra/postgres/002_audit_chain.sql` and `004_audit_immutable.sql` define an append-only events table whose trigger rejects updates and deletes, for deployments that persist events.

## Out of scope

This repository is not hardened for production: there is no authentication beyond the operator header, and workflows live in memory unless `ERASEROPS_PERSISTENCE=postgres` is set. Never point it at systems holding real personal data.
