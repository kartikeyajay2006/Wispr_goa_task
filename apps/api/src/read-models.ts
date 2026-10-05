import type {AuditEvent, Workflow} from '../../../packages/shared/src/index.js';
import type {Connector, ConnectorContext} from '../../../packages/connectors/src/index.js';
import {RETENTION_POLICY} from '../../../packages/policy-engine/src/retention-policy.js';
import type {EraserOpsConfig} from './config.js';
import type {InMemoryRuntimeStore} from './runtime-store.js';

type Deps = {postgres: Connector; minio: Connector; store: InMemoryRuntimeStore; context: ConnectorContext; config: EraserOpsConfig};

export const requestSummary = (workflow: Workflow) => ({
  requestId: workflow.requestId,
  customerId: workflow.customerId,
  createdAt: workflow.request?.createdAt ?? workflow.plan.createdAt,
  requestedBy: workflow.request?.requestedBy,
  reason: workflow.request?.reason,
  dryRun: workflow.dryRun,
  stage: workflow.stage,
  state: workflow.state,
  status: workflow.status,
  planHash: workflow.plan.hash,
  blastRadius: workflow.blastRadius,
  blockedBy: workflow.status === 'blocked' && workflow.state !== 'REJECTED' && workflow.state !== 'ROLLED_BACK' ? (workflow.sandbox?.failures[0] ?? workflow.backupFailures?.[0] ?? workflow.backupChecks?.find(check => !check.verified)?.reason) : undefined,
  approvedBy: workflow.approval?.approvedBy,
  approvalExpiresAt: workflow.approval && !workflow.approval.used ? workflow.approval.expiresAt : undefined,
  recordsChanged: workflow.executionResults?.reduce((total, result) => total + result.affectedRecords, 0) ?? 0,
  residual: workflow.verification?.remainingMatches,
});

// Callers pass requests in reverse insertion order; the stable sort keeps that order for equal timestamps.
const newestFirst = (a: {createdAt: string}, b: {createdAt: string}) => b.createdAt.localeCompare(a.createdAt);

export function listRequests({store}: Deps) { return store.list().reverse().map(requestSummary).sort(newestFirst); }

/** Every customer the connected systems know about, with a live footprint and residual count. */
export async function listCustomers({postgres, minio, store, context}: Deps) {
  const ids = [...new Set([...await postgres.listCustomers?.() ?? [], ...await minio.listCustomers?.() ?? []])].sort();
  const requests = store.list().reverse();
  return Promise.all(ids.map(async customerId => {
    const [profile, pgAssets, objectAssets, pgResidual, objectResidual, dependencies] = await Promise.all([
      postgres.profile?.(customerId), postgres.discoverCustomerData(customerId, context), minio.discoverCustomerData(customerId, context),
      postgres.verify(customerId), minio.verify(customerId), postgres.inspectDependencies?.(customerId) ?? [],
    ]);
    const assets = [...pgAssets, ...objectAssets];
    const residual = pgResidual.remainingMatches + objectResidual.remainingMatches;
    const latest = requests.filter(workflow => workflow.customerId === customerId).map(requestSummary).sort(newestFirst)[0];
    const shared = dependencies.filter(dependency => dependency.constraintType === 'business');
    return {
      customerId,
      displayName: profile?.displayName,
      email: profile?.email,
      region: profile?.region,
      createdAt: profile?.createdAt,
      footprint: {records: assets.reduce((total, asset) => total + asset.count, 0), resources: assets.length, systems: [...new Set(assets.map(asset => asset.system))], deletable: assets.filter(asset => asset.classification === 'deletable').reduce((total, asset) => total + asset.count, 0), anonymize: assets.filter(asset => asset.classification === 'anonymize').reduce((total, asset) => total + asset.count, 0), retained: assets.filter(asset => asset.classification === 'retain').reduce((total, asset) => total + asset.count, 0)},
      residual,
      status: residual === 0 ? 'erased' as const : 'active' as const,
      signals: [
        ...shared.map(dependency => dependency.relationshipType),
        ...assets.some(asset => asset.classification === 'retain') ? [`${assets.filter(asset => asset.classification === 'retain').length} resources held under retention policy`] : [],
      ],
      latestRequest: latest && {requestId: latest.requestId, state: latest.state, status: latest.status, createdAt: latest.createdAt},
    };
  }));
}

export async function listSystems({postgres, minio, config}: Deps) {
  return Promise.all([postgres, minio].map(async connector => ({
    ...connector.system,
    mode: config.connectorMode,
    allowlisted: config.allowlistedSystems.includes(connector.system.type === 'postgresql' ? 'PostgreSQL' : 'MinIO'),
    inventory: await connector.inventory?.().catch(() => []) ?? [],
  })));
}

export function describePolicies({config}: Deps) {
  return {
    version: RETENTION_POLICY.version,
    rules: RETENTION_POLICY.rules,
    controls: {
      demoMode: config.demoMode,
      connectorMode: config.connectorMode,
      approvalTtlMinutes: config.approvalTtlMs / 60_000,
      destructiveRateLimit: {maxAttempts: config.rateLimit.maxAttempts, windowSeconds: config.rateLimit.windowMs / 1000},
      allowlistedSystems: config.allowlistedSystems,
      allowlistedHosts: config.allowlistedHosts,
      allowlistedBuckets: config.allowlistedBuckets,
    },
    gates: [
      {id: 'sandbox', title: 'Sandbox simulation', rule: 'The plan runs against an isolated copy first. Any orphaned record, change to another customer, or leftover personal data blocks it.'},
      {id: 'backup', title: 'Verified backup', rule: 'Every affected record is backed up, then re-read and checksummed. Objects that cannot be read block approval.'},
      {id: 'approval', title: 'Human approval', rule: `An operator types the customer ID to approve one exact plan hash. Approval expires after ${config.approvalTtlMs / 60_000} minutes and is single-use.`},
      {id: 'guard', title: 'Guarded execution', rule: `Execution needs the matching request, approval and plan hash, plus an operator identity, and is limited to ${config.rateLimit.maxAttempts} attempts per ${config.rateLimit.windowMs / 1000} seconds.`},
      {id: 'rescan', title: 'Proof by rescan', rule: 'After execution every system is rescanned. Any residual personal data fails the request and offers a rollback from backup.'},
    ],
  };
}

export function auditLog({store}: Deps, limit = 200) {
  const workflows = store.list();
  const events = workflows.flatMap(workflow => workflow.events.map((item: AuditEvent) => ({...item, customerId: workflow.customerId}))).sort((a, b) => b.at.localeCompare(a.at) || b.sequence - a.sequence);
  return {
    events: events.slice(0, limit),
    total: events.length,
    chains: workflows.map(workflow => ({requestId: workflow.requestId, customerId: workflow.customerId, events: workflow.events.length, ...store.verify(workflow.requestId)})),
  };
}

export async function overview(deps: Deps) {
  const [customers, systems] = await Promise.all([listCustomers(deps), listSystems(deps)]);
  const requests = listRequests(deps);
  const chains = auditLog(deps, 0).chains;
  const count = (predicate: (request: ReturnType<typeof requestSummary>) => boolean) => requests.filter(predicate).length;
  return {
    mode: deps.config.connectorMode,
    customers: {total: customers.length, erased: customers.filter(customer => customer.status === 'erased').length},
    records: {managed: systems.flatMap(system => system.inventory).filter(entry => entry.resource !== 'eraseops-backups').reduce((total, entry) => total + entry.records, 0), residual: customers.reduce((total, customer) => total + customer.residual, 0), changed: requests.reduce((total, request) => total + request.recordsChanged, 0)},
    requests: {total: requests.length, awaitingApproval: count(request => request.status === 'awaiting_approval' && !request.dryRun), ready: count(request => request.status === 'ready'), executed: count(request => request.status === 'executed'), blocked: count(request => request.status === 'blocked')},
    audit: {chains: chains.length, verified: chains.filter(chain => chain.valid).length, events: chains.reduce((total, chain) => total + chain.events, 0)},
    systems: systems.map(system => ({name: system.name, type: system.type, connectionStatus: system.connectionStatus})),
    recent: requests.slice(0, 6),
  };
}
