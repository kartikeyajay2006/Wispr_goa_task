import express from 'express';
import cors from 'cors';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {requestSchema, workflowResponseSchema, canonicalPlan, hashPlan, event, type Asset, type Workflow} from '../../../packages/shared/src/index.js';
import {createMockConnectors, seededDataset} from '../../../packages/connectors/src/index.js';
import {MinioAdapter, PostgresAdapter} from '../../../packages/connectors/src/adapters.js';
import {MinioHttpObjectClient} from '../../../packages/connectors/src/s3-client.js';
import {MinioLiveConnector, PostgresLiveConnector} from '../../../packages/connectors/src/live.js';
import {createBackupManifest, verifyBackupManifest} from '../../../packages/backup/src/index.js';
import {verifyPlanInSandbox} from '../../../packages/sandbox/src/index.js';
import {calculateBlastRadius} from '../../../packages/blast-radius/src/index.js';
import {generateReport, deriveWorkflowMetrics} from '../../../packages/report/src/index.js';
import {InMemoryRuntimeStore, createMetadataRepository} from './runtime-store.js';
import {DestructiveRequestGuard} from './destructive-guard.js';
import {executeApprovedWorkflow} from './execution-service.js';
import {generateDeletionPlan} from '../../../packages/workflow/src/planner.js';
import {loadConfig, loadEnvFile} from './config.js';
import {initialWorkflowState, transitionWorkflow} from './state-machine.js';

if (process.env.ERASEROPS_START_SERVER === 'true') loadEnvFile();
const runtimeConfig = loadConfig(process.env);

export const app = express();
app.use(cors({origin: runtimeConfig.corsOrigin === '*' ? true : runtimeConfig.corsOrigin.split(',').map(origin => origin.trim())}));
app.use(express.json());

const store = new InMemoryRuntimeStore(createMetadataRepository(runtimeConfig));
const localObjectClient = runtimeConfig.connectorMode === 'local' ? new MinioHttpObjectClient(runtimeConfig.minio) : undefined;
const mock = runtimeConfig.connectorMode === 'mock' ? createMockConnectors(seededDataset(runtimeConfig.datasetFile)) : undefined;
const postgres = mock?.postgres ?? new PostgresLiveConnector(new PostgresAdapter(new Pool({connectionString: runtimeConfig.databaseUrl}), localObjectClient));
const minio = mock?.minio ?? new MinioLiveConnector(new MinioAdapter(localObjectClient!, runtimeConfig.allowlistedBuckets), runtimeConfig.allowlistedBuckets);
const guard = new DestructiveRequestGuard(runtimeConfig.rateLimit.maxAttempts, runtimeConfig.rateLimit.windowMs);
const ctx = {demoMode: true as const, allowlistedHosts: runtimeConfig.allowlistedHosts, allowlistedBuckets: runtimeConfig.allowlistedBuckets};

const countByAction = (items: Asset[], action: 'delete' | 'redact' | 'retain') => items.filter(item => (item.classification === 'deletable' ? 'delete' : item.classification === 'anonymize' ? 'redact' : 'retain') === action).reduce((total, item) => total + item.count, 0);
const makePlanItems = (assets: Asset[]) => assets.map(asset => ({...asset, action: asset.classification === 'deletable' ? 'delete' : asset.classification === 'anonymize' ? 'redact' : 'retain'}));
export function validateGuardedExecutionInput(identity: string | undefined, body: unknown) { const input = body as {approvalId?: unknown; planHash?: unknown} | undefined; if (!identity) throw new Error('Operator identity required'); if (typeof input?.approvalId !== 'string' || typeof input.planHash !== 'string') throw new Error('approvalId and planHash are required'); return {identity, approvalId: input.approvalId, planHash: input.planHash}; }

export async function makeWorkflow(body: unknown) {
  const input = requestSchema.parse(body);
  const requestId = randomUUID();
  const assets = [...await postgres.discoverCustomerData(input.customerId, ctx), ...await minio.discoverCustomerData(input.customerId, ctx)] as Asset[];
  const items = makePlanItems(assets);
  const canonical = canonicalPlan({requestId, customerId: input.customerId, items});
  const plan = {id: randomUUID(), requestId, customerId: input.customerId, items, createdAt: new Date().toISOString(), canonical, hash: hashPlan(canonical), status: 'pending_approval' as const};
  const actions = items.map(item => ({id: item.id, system: item.system, resource: item.table, actionType: (item.action === 'delete' ? 'delete' : item.action === 'redact' ? 'anonymize' : 'retain') as 'delete' | 'anonymize' | 'retain', selector: 'customer_id = $1', reason: `deterministic ${item.action} classification`, recordCount: item.count, reversible: item.action !== 'delete', risk: item.risk, dependencies: item.dependencyIds, verification: 'rescan connector'}));
  const sandbox = verifyPlanInSandbox({customerId: input.customerId, planHash: plan.hash, actions});
  const backupEvidence = input.customerId === 'CUST-7001' ? undefined : await Promise.all([postgres.backupCustomerData(input.customerId, requestId), minio.backupCustomerData(input.customerId, requestId)]);
  const connectorResources = backupEvidence?.flatMap(item => item.resourceEvidence ?? []) ?? [];
  const backupResources = connectorResources.length ? connectorResources : assets.map(asset => ({resource: asset.id, kind: asset.system === 'MinIO' ? 'object' as const : 'database' as const, records: asset.count, checksum: `${asset.id}:${asset.count}`}));
  const backup = createBackupManifest({requestId, customerId: input.customerId, planHash: plan.hash, resources: input.customerId === 'CUST-7001' ? [] : backupResources});
  const backupCheck = verifyBackupManifest(backup, {requestId, customerId: input.customerId, planHash: plan.hash});
  const blocked = sandbox.status === 'failed' || !backupCheck.verified;
  const blast = calculateBlastRadius(items);
  const dependencies = [...await postgres.inspectDependencies(input.customerId), ...await minio.inspectDependencies(input.customerId)];
  const events = [
    event('intake', requestId, 'Request accepted; configured connector allowlist matched.'),
    event('discovery', requestId, 'Connected systems discovered through allowlisted connectors.', {details: {systems: ['PostgreSQL', 'MinIO'], secretsRedacted: true}}),
    event('footprint', requestId, 'Personal data footprint assembled.', {planHash: plan.hash, details: {assetCount: assets.length}}),
    event('dependencies', requestId, sandbox.status === 'failed' ? 'Unsafe cross-customer dependency detected.' : 'Dependency graph resolved.', {planHash: plan.hash, details: {dependencyCount: dependencies.length}}),
    event('classification', requestId, 'Deterministic classification completed.', {planHash: plan.hash}),
    event('plan', requestId, 'Canonical deletion plan generated and hashed.', {planHash: plan.hash}),
    event('sandbox', requestId, sandbox.status === 'passed' ? 'Sandbox verification passed.' : 'Sandbox verification failed; plan blocked.', {planHash: plan.hash, details: {failures: sandbox.failures}}),
    event('backup', requestId, backupCheck.verified ? 'Backup integrity verified.' : 'Backup verification failed; approval blocked.', {planHash: plan.hash, details: {backupId: backup.backupId, connectorBackups: backupEvidence?.map(item => ({backupId: item.backupId, resources: item.resources, artifacts: item.artifacts ?? []})) ?? []}}),
  ];
  if (!blocked) events.push(event('blast_radius', requestId, 'Blast radius calculated.', {planHash: plan.hash, details: blast as unknown as Record<string, unknown>}), event('policy', requestId, 'Policy engine approved plan for human checkpoint.', {planHash: plan.hash}), event('approval', requestId, 'Paused for explicit human approval.', {planHash: plan.hash}));
  const workflow: Workflow = {requestId, customerId: input.customerId, dryRun: input.dryRun, stage: sandbox.status === 'failed' ? 'sandbox' : !backupCheck.verified ? 'backup' : 'approval', state: initialWorkflowState(sandbox.status === 'passed', backupCheck.verified), status: blocked ? 'blocked' : 'awaiting_approval', plan, assets, blastRadius: {systems: blast.affectedSystems, records: blast.affectedRecords, retained: blast.recordsRetained, anonymized: blast.recordsAnonymized, deletable: blast.recordsDeleted}, events};
  (workflow as any).sandbox = sandbox;
  (workflow as any).sandboxPassed = sandbox.status === 'passed';
  (workflow as any).backupVerified = backupCheck.verified;
  (workflow as any).backup = backup;
  store.set(requestId, workflow);
  return workflow;
}

app.get('/health', (_req, res) => res.json({ok: true, mode: runtimeConfig.connectorMode, allowlist: runtimeConfig.allowlistedSystems}));
app.post('/api/requests', async (req, res) => { try { res.status(201).json(await makeWorkflow(req.body)); } catch (error) { res.status(400).json({error: error instanceof Error ? error.message : 'Invalid request'}); } });
app.get('/api/requests/:id', (req, res) => { const workflow = store.get(req.params.id); workflow ? res.json(workflow) : res.status(404).json({error: 'Not found'}); });

app.post('/api/requests/:id/approve', async (req, res) => {
  const workflow = store.get(req.params.id);
  if (!workflow) return res.status(404).json({error: 'Not found'});
  if (req.body?.confirmation !== workflow.customerId) return res.status(400).json({error: `Type ${workflow.customerId} to approve destructive execution`});
  if (workflow.stage !== 'approval' || workflow.plan.status !== 'pending_approval') return res.status(409).json({error: 'Invalid workflow transition'});
  workflow.approval = {token: randomUUID(), expiresAt: new Date(Date.now() + runtimeConfig.approvalTtlMs).toISOString(), used: false, planHash: workflow.plan.hash};
  transitionWorkflow(workflow, 'APPROVED');
  workflow.plan.status = 'approved'; workflow.stage = 'execution'; workflow.status = 'ready';
  store.append(workflow.requestId, {stage: 'approval', message: 'Human approval recorded for exact plan hash.', actor: 'operator', planHash: workflow.plan.hash});
  try { await store.persist(workflow.requestId); return res.json(workflow); } catch (error) { return res.status(503).json({error: error instanceof Error ? error.message : 'Persistence failed'}); }
});

app.post('/api/requests/:id/reject', async (req, res) => {
  const workflow = store.get(req.params.id);
  if (!workflow) return res.status(404).json({error: 'Not found'});
  if (workflow.stage !== 'approval' || workflow.plan.status !== 'pending_approval') return res.status(409).json({error: 'Invalid workflow transition'});
  transitionWorkflow(workflow, 'REJECTED');
  workflow.plan.status = 'rejected'; workflow.stage = 'report'; workflow.status = 'blocked';
  store.append(workflow.requestId, {stage: 'report', message: 'Human rejected the deletion plan; no destructive action executed.', actor: 'operator', planHash: workflow.plan.hash});
  try { await store.persist(workflow.requestId); return res.json(workflow); } catch (error) { return res.status(503).json({error: error instanceof Error ? error.message : 'Persistence failed'}); }
});

// The old endpoint is intentionally inert; destructive work has one guarded route.
app.post('/api/requests/:id/execute', (_req, res) => res.status(410).json({error: 'Legacy execution endpoint disabled; use execute-guarded'}));
app.post('/api/requests/:id/execute-guarded', async (req, res) => {
  const workflow = store.get(req.params.id);
  if (!workflow) return res.status(404).json({error: 'Not found'});
  let guardedInput: {identity: string; approvalId: string; planHash: string};
  try { guardedInput = validateGuardedExecutionInput(req.header('x-operator-identity'), req.body); } catch (error) { return res.status(error instanceof Error && error.message === 'Operator identity required' ? 401 : 400).json({error: error instanceof Error ? error.message : 'Invalid execution request'}); }
  if (!workflow.approval) return res.status(409).json({error: 'Execution blocked: human approval missing'});
  try {
    guard.authorize({identity: guardedInput.identity, requestId: req.params.id, approvalId: guardedInput.approvalId, planHash: guardedInput.planHash, authoritativeRequestId: workflow.requestId, authoritativeApprovalId: workflow.approval.token, authoritativePlanHash: workflow.plan.hash});
    const result = await executeApprovedWorkflow(workflow, {postgres, minio});
    await store.persist(workflow.requestId);
    return res.json(result.workflow);
  } catch (error) { return res.status(409).json({error: error instanceof Error ? error.message : 'Execution blocked'}); }
});

app.get('/api/requests/:id/blast-radius', (req, res) => { const workflow = store.get(req.params.id); if (!workflow) return res.status(404).json({error: 'Not found'}); return res.json(calculateBlastRadius(workflow.plan.items)); });
app.get('/api/requests/:id/report', (req, res) => { const workflow = store.get(req.params.id); if (!workflow) return res.status(404).json({error: 'Not found'}); return res.json(generateReport(workflow as any)); });
app.get('/api/requests/:id/persistence', (req, res) => res.json(store.persistenceStatus(req.params.id)));
app.get('/api/requests/:id/authoritative', async (req, res) => { const workflow = await store.loadAuthoritative(req.params.id); workflow ? res.json(workflow) : res.status(404).json({error: 'Authoritative workflow not found'}); });
app.get('/api/requests/:id/metrics', (req, res) => { const workflow = store.get(req.params.id); if (!workflow) return res.status(404).json({error: 'Not found'}); return res.json(deriveWorkflowMetrics(workflow as any)); });
app.get('/api/requests/:id/audit', (req, res) => { const workflow = store.get(req.params.id); if (!workflow) return res.status(404).json({error: 'Not found'}); return res.json({requestId: workflow.requestId, events: workflow.events, chain: store.verify(workflow.requestId)}); });
app.get('/api/requests/:id/plan', (req, res) => { const workflow = store.get(req.params.id); if (!workflow) return res.status(404).json({error: 'Not found'}); return res.json(generateDeletionPlan({requestId: workflow.requestId, customerId: workflow.customerId, assets: workflow.assets, createdAt: workflow.plan.createdAt})); });
app.get('/api/requests/:id/backup', (req, res) => { const workflow = store.get(req.params.id); if (!workflow) return res.status(404).json({error: 'Not found'}); const manifest = (workflow as any).backup; if (!manifest) return res.status(404).json({error: 'Backup manifest not found'}); return res.json({manifest, verification: verifyBackupManifest(manifest, {requestId: workflow.requestId, customerId: workflow.customerId, planHash: workflow.plan.hash})}); });
app.get('/api/requests/:id/verification', async (req, res) => { const workflow = store.get(req.params.id); if (!workflow) return res.status(404).json({error: 'Not found'}); const results = await Promise.all([postgres.verify(workflow.customerId), minio.verify(workflow.customerId)]); return res.json({requestId: workflow.requestId, customerId: workflow.customerId, verified: results.every(result => result.verified && result.remainingMatches === 0), results, remainingMatches: results.reduce((total, result) => total + result.remainingMatches, 0)}); });
const resetDemo = async (_req: express.Request, res: express.Response) => { try { await store.clear(); res.json({ok: true, reset: true}); } catch (error) { res.status(503).json({error: error instanceof Error ? error.message : 'Reset failed'}); } };
app.post('/api/demo/reset', resetDemo);
app.post('/api/reset', resetDemo);

if (process.env.ERASEROPS_START_SERVER === 'true') app.listen(runtimeConfig.port, () => console.log(`EraseOps API on http://localhost:${runtimeConfig.port} (demo mode, ${runtimeConfig.connectorMode} connectors)`));
