# EraserOps

EraserOps is a local-only demo for autonomous data deletion with deterministic policy gates and human approval. It discovers a seeded CUST-1042 footprint across controlled PostgreSQL and MinIO connectors, classifies records, hashes a canonical plan, verifies in a sandbox, calculates blast radius, pauses for approval, executes approved operations, rescans, and seals an audit report.

## Run

```bash
npm install
npm run dev
```

The controlled MCP transport can be started separately with `npm run dev:mcp`; it exposes the catalog over stdio and denies destructive calls unless the host injects explicit authorization.

Open http://localhost:5173. Docker infrastructure is optional for deterministic mock mode:

```bash
docker compose up -d
```

To use the seeded PostgreSQL and MinIO services through the concrete connector adapters, run the API with `CONNECTOR_MODE=local`. This remains demo-only and requires the local Docker services plus `DATABASE_URL`, `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, and `MINIO_SECRET_KEY`.

To exercise PostgreSQL metadata persistence, start Docker Desktop first and run the API with `ERASEROPS_PERSISTENCE=postgres` and `DATABASE_URL=postgres://eraseops:eraseops@localhost:5432/eraseops`. The default demo mode remains in-memory and does not require the daemon.

## Safety invariants

- Demo mode only permits explicitly allowlisted local systems; no AWS or production credentials are required.
- The model boundary is metadata-only in this demo: no raw customer values, credentials, or unrestricted connection details are exposed.
- The plan is canonicalized and SHA-256 hashed; approval binds to the exact hash, expires, and is single-use.
- Approval, sandbox, backup, policy, and plan-hash checks are revalidated before execution.
- Mock connectors are the default for deterministic development. `CONNECTOR_MODE=local` enables the parameterized PostgreSQL adapter and SigV4-signed MinIO client against explicitly allowlisted local services; production infrastructure remains unsupported.

## Verify

```bash
npm run typecheck
npm test
npm run build
```

The test suite covers deterministic hashing, approval expiry/reuse, plan mutation, sandbox and backup failures, allowlist rejection, connector parameterization, destructive-tool identity, rate limiting, and audit-chain tamper detection. Full socket-level HTTP tests remain environment-dependent.

API observability endpoints include `GET /api/requests/:id/persistence` for repository health, `GET /api/requests/:id/authoritative` for the server-generated workflow snapshot, `GET /api/requests/:id/metrics` for assets, systems, safety checks, policy blocks, and residual-PII metrics, `GET /api/requests/:id/audit` for the hash-chain event trail and verification result, `GET /api/requests/:id/plan` for the deterministic versioned plan projection, `GET /api/requests/:id/backup` for the manifest and fresh identity/checksum verification, and `GET /api/requests/:id/verification` for fresh PostgreSQL/MinIO rescans. The centralized execution boundary is available at `POST /api/requests/:id/execute-guarded`; it requires exact request, approval, and plan identity plus the `x-operator-identity` header. The controlled demo can be reset with `POST /api/demo/reset`.

## Demo scenarios

- `CUST-1042`: approve the exact plan, execute mock connector actions, rescan, and review the final report.
- `CUST-2088`: review a valid plan and choose **Reject plan**; no destructive action is invoked.
- `CUST-9001`: the dependency/sandbox gate blocks a shared-account deletion before approval.
- `CUST-7001`: backup verification fails and the workflow never reaches approval.

TrueForge integration contract: `trueforge/agent-config/eraseops-orchestrator.json`. The runtime remains optional for the demo; the deterministic policy engine and structured MCP boundary remain authoritative.

## Architecture

```mermaid
flowchart LR
  U[Operator / voice command] --> W[EraseOps Web UI]
  W --> A[EraseOps API]
  A --> P[Deterministic Policy Engine]
  A --> C[Connector Boundary]
  C --> PG[(PostgreSQL demo)]
  C --> M[(MinIO demo)]
  P --> S[Sandbox verification]
  S --> B[Backup manifest]
  B --> H[Human approval]
  H --> X[Guarded execution]
  X --> C
  X --> V[Post-deletion verification]
  V --> R[Hash-chained audit report]
```

```mermaid
stateDiagram-v2
  [*] --> REQUEST_CREATED
  REQUEST_CREATED --> DISCOVERING
  DISCOVERING --> DISCOVERY_COMPLETE
  DISCOVERY_COMPLETE --> ANALYZING_DEPENDENCIES
  ANALYZING_DEPENDENCIES --> DEPENDENCY_ANALYSIS_COMPLETE
  DEPENDENCY_ANALYSIS_COMPLETE --> GENERATING_PLAN
  GENERATING_PLAN --> PLAN_READY
  PLAN_READY --> VERIFYING_IN_SANDBOX
  VERIFYING_IN_SANDBOX --> SANDBOX_PASSED
  VERIFYING_IN_SANDBOX --> SANDBOX_FAILED
  SANDBOX_PASSED --> CALCULATING_BLAST_RADIUS
  CALCULATING_BLAST_RADIUS --> BACKING_UP
  BACKING_UP --> AWAITING_HUMAN_APPROVAL
  AWAITING_HUMAN_APPROVAL --> APPROVED
  AWAITING_HUMAN_APPROVAL --> REJECTED
  APPROVED --> EXECUTING
  EXECUTING --> VERIFYING_DELETION
  VERIFYING_DELETION --> COMPLETED
  VERIFYING_DELETION --> VERIFICATION_FAILED
  SANDBOX_FAILED --> ROLLED_BACK
  REJECTED --> ROLLED_BACK
  VERIFICATION_FAILED --> ROLLED_BACK
```

PostgreSQL persistence schemas are initialized lexicographically from `infra/postgres/001_seed.sql` through `007_customer_footprint.sql`. The final migration creates the metadata-only discovery projection used by the PostgreSQL adapter. The API defaults to its in-memory repository; setting `ERASEROPS_PERSISTENCE=postgres` selects the guarded PostgreSQL metadata repository. The demo still refuses production credentials and destructive live infrastructure.
