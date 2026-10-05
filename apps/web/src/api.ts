import {useOperator} from './operator';

export type Classification = 'deletable' | 'anonymize' | 'retain';
export type Risk = 'low' | 'medium' | 'high';
export type PlanAction = 'delete' | 'redact' | 'retain';
export type Stage = 'intake' | 'discovery' | 'footprint' | 'dependencies' | 'classification' | 'plan' | 'sandbox' | 'backup' | 'blast_radius' | 'policy' | 'approval' | 'execution' | 'rescan' | 'report';
export type Asset = {id: string; system: string; table: string; label: string; classification: Classification; basis?: string; fields: string[]; dependencyIds: string[]; risk: Risk; count: number; recordIds?: string[]};
export type PlanItem = Asset & {action: PlanAction};
export type Dependency = {source: string; target: string; relationshipType: string; constraintType: 'foreign_key' | 'retention' | 'business'; required: boolean; risk: Risk};
export type AuditEvent = {id: string; at: string; stage: Stage; sequence: number; actor: string; message: string; requestId: string; planHash?: string; details?: Record<string, unknown>; previousHash: string; eventHash: string; customerId?: string};
export type Simulation = {system: string; mode: string; checks: string[]; failures: string[]; warnings: string[]; affected: number; residualAfter: number};
export type VerificationResult = {system: string; remainingMatches: number; verified: boolean; details: string};
export type ExecutionResult = {actionId: string; status: 'completed' | 'failed' | 'skipped'; startedAt: string; completedAt: string; affectedRecords: number};
export type Workflow = {
  requestId: string; customerId: string; dryRun: boolean; stage: Stage; state?: string;
  status: 'awaiting_approval' | 'ready' | 'executed' | 'blocked';
  plan: {id: string; hash: string; status: string; createdAt: string; version?: number; riskScore?: number; items: PlanItem[]};
  assets: Asset[]; dependencies?: Dependency[];
  blastRadius: {systems: number; records: number; retained: number; anonymized: number; deletable: number};
  events: AuditEvent[];
  approval?: {token: string; expiresAt: string; used: boolean; planHash: string; approvedBy?: string; approvedAt?: string};
  rejection?: {rejectedBy: string; rejectedAt: string; reason?: string};
  request?: {reason: string; requestedBy: string; createdAt: string; scope: string};
  sandbox?: {status: 'passed' | 'failed'; tests: string[]; warnings: string[]; failures: string[]; executedAt: string; simulations?: Simulation[]};
  sandboxPassed?: boolean;
  backup?: {backupId: string; createdAt: string; checksum: string; resources: Array<{resource: string; kind: 'database' | 'object'; records: number; checksum: string}>};
  backupVerified?: boolean;
  backupChecks?: Array<{system: string; verified: boolean; reason: string; checked: number}>;
  backupFailures?: string[];
  executionStartedAt?: string; executionCompletedAt?: string; executionResults?: ExecutionResult[];
  verification?: {postgres: boolean; minio: boolean; remainingMatches: number; results?: VerificationResult[]};
  persistence?: {status: string; error?: string};
};
export type RequestSummary = {requestId: string; customerId: string; createdAt: string; requestedBy?: string; reason?: string; dryRun: boolean; stage: Stage; state?: string; status: Workflow['status']; planHash: string; blastRadius: Workflow['blastRadius']; blockedBy?: string; approvedBy?: string; approvalExpiresAt?: string; recordsChanged: number; residual?: number};
export type Customer = {customerId: string; displayName?: string; email?: string; region?: string; createdAt?: string; footprint: {records: number; resources: number; systems: string[]; deletable: number; anonymize: number; retained: number}; residual: number; status: 'active' | 'erased'; signals: string[]; latestRequest?: {requestId: string; state?: string; status: string; createdAt: string}};
export type Overview = {mode: string; customers: {total: number; erased: number}; records: {managed: number; residual: number; changed: number}; requests: {total: number; awaitingApproval: number; ready: number; executed: number; blocked: number}; audit: {chains: number; verified: number; events: number}; systems: Array<{name: string; type: string; connectionStatus: string}>; recent: RequestSummary[]};
export type System = {id: string; name: string; type: string; connectionStatus: string; capabilities: string[]; mode: string; allowlisted: boolean; inventory: Array<{resource: string; kind: 'table' | 'bucket'; records: number; bytes?: number}>};
export type Policies = {version: string; rules: Array<{system: string; resource: string; label: string; classification: Classification; basis: string; retention?: string; risk: Risk}>; controls: {demoMode: boolean; connectorMode: string; approvalTtlMinutes: number; destructiveRateLimit: {maxAttempts: number; windowSeconds: number}; allowlistedSystems: string[]; allowlistedHosts: string[]; allowlistedBuckets: string[]}; gates: Array<{id: string; title: string; rule: string}>};
export type AuditLog = {events: AuditEvent[]; total: number; chains: Array<{requestId: string; customerId: string; events: number; valid: boolean; reason: string}>};
export type Verification = {requestId: string; customerId: string; checkedAt: string; verified: boolean; results: VerificationResult[]; remainingMatches: number};
export type Report = {reportId: string; requestId: string; customerId: string; status: string; state?: string; planHash: string; generatedAt: string; request?: Workflow['request']; approval?: {approvedBy?: string; approvedAt?: string; expiresAt: string; used: boolean}; rejection?: Workflow['rejection']; actions: Array<{id: string; system: string; resource: string; action: string; planned: number; changed: number; status: string}>; sandbox: {failures: string[]; warnings: string[]; checks: number}; backup: {checks: Array<{system: string; verified: boolean; reason: string}>; failures: string[]}; summary: {systems: number; records: number; deleted: number; anonymized: number; retained: number; impact: string}; metrics: {dataAssetsFound: number; systemsScanned: number; deletionActions: number; safetyChecks: number; policyBlocks: number; residualPii: number; totalExecutionTimeMs: number}; controls: {sandbox: string; backup: string; approval: string; auditEvents: number}; verification: {postgres: boolean; minio: boolean; remainingMatches: number}};
export type Health = {ok: boolean; mode: string; allowlist: string[]};

export class ApiError extends Error { constructor(readonly status: number, message: string) { super(message); } }

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const operator = useOperator.getState().name.trim();
  let response: Response;
  try {
    response = await fetch(path, {method, headers: {'content-type': 'application/json', ...(operator ? {'x-operator-identity': operator} : {})}, body: body === undefined ? undefined : JSON.stringify(body)});
  } catch {
    throw new ApiError(0, 'The EraseOps API is not reachable. Start it with npm run dev.');
  }
  const text = await response.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!response.ok) throw new ApiError(response.status, data?.error ?? `Request failed (${response.status})`);
  return data as T;
}

export const api = {
  health: () => request<Health>('GET', '/health'),
  overview: () => request<Overview>('GET', '/api/overview'),
  customers: () => request<Customer[]>('GET', '/api/customers'),
  systems: () => request<System[]>('GET', '/api/systems'),
  policies: () => request<Policies>('GET', '/api/policies'),
  audit: (limit = 300) => request<AuditLog>('GET', `/api/audit?limit=${limit}`),
  requests: () => request<RequestSummary[]>('GET', '/api/requests'),
  request: (id: string) => request<Workflow>('GET', `/api/requests/${id}`),
  verification: (id: string) => request<Verification>('GET', `/api/requests/${id}/verification`),
  report: (id: string) => request<Report>('GET', `/api/requests/${id}/report`),
  requestAudit: (id: string) => request<{requestId: string; events: AuditEvent[]; chain: {valid: boolean; reason: string}}>('GET', `/api/requests/${id}/audit`),
  create: (input: {customerId: string; reason: string; dryRun: boolean}) => request<Workflow>('POST', '/api/requests', input),
  approve: (id: string, confirmation: string) => request<Workflow>('POST', `/api/requests/${id}/approve`, {confirmation}),
  reject: (id: string, reason?: string) => request<Workflow>('POST', `/api/requests/${id}/reject`, {reason}),
  execute: (id: string, approvalId: string, planHash: string) => request<Workflow>('POST', `/api/requests/${id}/execute-guarded`, {approvalId, planHash}),
  rollback: (id: string) => request<Workflow>('POST', `/api/requests/${id}/rollback`),
  reset: () => request<{ok: boolean; dataset: string}>('POST', '/api/demo/reset'),
};
