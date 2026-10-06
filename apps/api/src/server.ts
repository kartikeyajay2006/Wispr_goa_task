import express from 'express';
import cors from 'cors';
import {Pool} from 'pg';
import {createMockConnectors, loadDatasetFixture, seededDataset, type Connector} from '../../../packages/connectors/src/index.js';
import {seedLocalSystems} from '../../../packages/connectors/src/local-seed.js';
import {MinioAdapter, PostgresAdapter} from '../../../packages/connectors/src/adapters.js';
import {MinioHttpObjectClient} from '../../../packages/connectors/src/s3-client.js';
import {MinioLiveConnector, PostgresLiveConnector} from '../../../packages/connectors/src/live.js';
import {verifyBackupManifest, type BackupManifest} from '../../../packages/backup/src/index.js';
import {calculateBlastRadius} from '../../../packages/blast-radius/src/index.js';
import {generateReport, deriveWorkflowMetrics} from '../../../packages/report/src/index.js';
import {generateDeletionPlan} from '../../../packages/workflow/src/planner.js';
import {InMemoryRuntimeStore, createMetadataRepository} from './runtime-store.js';
import {DestructiveRequestGuard} from './destructive-guard.js';
import {loadConfig, loadEnvFile} from './config.js';
import {HttpError, WorkflowService} from './workflow-service.js';
import {auditLog, describePolicies, listCustomers, listRequests, listSystems, overview} from './read-models.js';
import {createAiEngine} from './agent/claude.js';
import {interpretCommand} from './agent/interpret.js';
import {ErasureAgent, type AgentEvent} from './agent/graph.js';

if (process.env.ERASEROPS_START_SERVER === 'true') loadEnvFile();
const runtimeConfig = loadConfig(process.env);

export const app = express();
app.use(cors({origin: runtimeConfig.corsOrigin === '*' ? true : runtimeConfig.corsOrigin.split(',').map(origin => origin.trim())}));
app.use(express.json({limit: '100kb'}));

const store = new InMemoryRuntimeStore(createMetadataRepository(runtimeConfig));
const localObjectClient = runtimeConfig.connectorMode === 'local' ? new MinioHttpObjectClient(runtimeConfig.minio) : undefined;
const mock = runtimeConfig.connectorMode === 'mock' ? createMockConnectors(seededDataset(runtimeConfig.datasetFile)) : undefined;
const pool = runtimeConfig.connectorMode === 'local' ? new Pool({connectionString: runtimeConfig.databaseUrl}) : undefined;
const postgres: Connector = mock?.postgres ?? new PostgresLiveConnector(new PostgresAdapter(pool!, localObjectClient));
const minio: Connector = mock?.minio ?? new MinioLiveConnector(new MinioAdapter(localObjectClient!, runtimeConfig.allowlistedBuckets), runtimeConfig.allowlistedBuckets);
const guard = new DestructiveRequestGuard(runtimeConfig.rateLimit.maxAttempts, runtimeConfig.rateLimit.windowMs);
const ctx = {demoMode: true as const, allowlistedHosts: runtimeConfig.allowlistedHosts, allowlistedBuckets: runtimeConfig.allowlistedBuckets};
export const workflows = new WorkflowService({postgres, minio, store, guard, context: ctx, approvalTtlMs: runtimeConfig.approvalTtlMs});

export function validateGuardedExecutionInput(identity: string | undefined, body: unknown) { const input = body as {approvalId?: unknown; planHash?: unknown} | undefined; if (!identity) throw new Error('Operator identity required'); if (typeof input?.approvalId !== 'string' || typeof input.planHash !== 'string') throw new Error('approvalId and planHash are required'); return {identity, approvalId: input.approvalId, planHash: input.planHash}; }
export const makeWorkflow = (body: unknown, operator?: string) => workflows.create(body, operator);

type Handler = (req: express.Request, res: express.Response) => unknown;
/** Every route funnels errors through one place so status codes stay consistent. */
const route = (handler: Handler) => async (req: express.Request, res: express.Response) => {
  try { const result = await handler(req, res); if (!res.headersSent) res.json(result); }
  catch (error) { res.status(error instanceof HttpError ? error.status : 500).json({error: error instanceof Error ? error.message : 'Unexpected error'}); }
};
const operator = (req: express.Request) => req.header('x-operator-identity') ?? undefined;
const id = (req: express.Request) => String(req.params.id);

const readDeps = {postgres, minio, store, context: ctx, config: runtimeConfig};
export const aiEngine = createAiEngine(runtimeConfig.ai, process.env);
export const agent = new ErasureAgent({engine: aiEngine, workflows, tools: {runtime: {postgres, minio}, customers: () => listCustomers(readDeps)}});
const aiStatus = () => aiEngine.kind === 'claude' ? {engine: 'claude', model: aiEngine.model} : {engine: 'rules', reason: aiEngine.reason};

app.get('/health', (_req, res) => res.json({ok: true, mode: runtimeConfig.connectorMode, allowlist: runtimeConfig.allowlistedSystems}));
app.get('/api/overview', route(() => overview(readDeps)));
app.get('/api/customers', route(() => listCustomers(readDeps)));
app.get('/api/systems', route(() => listSystems(readDeps)));
app.get('/api/policies', route(() => describePolicies(readDeps)));
app.get('/api/audit', route(req => auditLog(readDeps, Math.min(Number(req.query.limit) || 200, 1000))));
app.get('/api/requests', route(() => listRequests(readDeps)));
app.get('/api/assistant/status', (_req, res) => res.json(aiStatus()));
app.post('/api/assistant/interpret', route(async req => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text || text.length > 500) throw new HttpError(400, 'Send the command as "text" (1 to 500 characters)');
  const customers = (await listCustomers(readDeps)).map(({customerId, displayName, region}) => ({customerId, displayName, region}));
  const current = typeof req.body?.requestId === 'string' ? store.get(req.body.requestId) : undefined;
  return interpretCommand(aiEngine, text, customers, current && {requestId: current.requestId, customerId: current.customerId, state: current.state});
}));
app.post('/api/requests', route(async (req, res) => { res.status(201); return workflows.create(req.body, operator(req)); }));
app.get('/api/requests/:id', route(req => workflows.get(id(req))));
app.post('/api/requests/:id/approve', route(req => workflows.approve(id(req), req.body, operator(req))));
app.post('/api/requests/:id/reject', route(req => workflows.reject(id(req), req.body, operator(req))));
// The old endpoint is intentionally inert; destructive work has one guarded route.
app.post('/api/requests/:id/execute', (_req, res) => res.status(410).json({error: 'Legacy execution endpoint disabled; use execute-guarded'}));
app.post('/api/requests/:id/execute-guarded', route(req => workflows.execute(id(req), req.body, operator(req))));
app.post('/api/requests/:id/rollback', route(req => workflows.rollback(id(req), operator(req))));

app.get('/api/requests/:id/blast-radius', route(req => calculateBlastRadius(workflows.get(id(req)).plan.items)));
app.get('/api/requests/:id/report', route(req => generateReport(workflows.get(id(req)))));
app.get('/api/requests/:id/persistence', route(req => store.persistenceStatus(id(req))));
app.get('/api/requests/:id/authoritative', route(async req => { const workflow = await store.loadAuthoritative(id(req)); if (!workflow) throw new HttpError(404, 'Authoritative workflow not found'); return workflow; }));
app.get('/api/requests/:id/metrics', route(req => deriveWorkflowMetrics(workflows.get(id(req)))));
app.get('/api/requests/:id/audit', route(req => { const workflow = workflows.get(id(req)); return {requestId: workflow.requestId, events: workflow.events, chain: store.verify(workflow.requestId)}; }));
app.get('/api/requests/:id/plan', route(req => { const workflow = workflows.get(id(req)); return generateDeletionPlan({requestId: workflow.requestId, customerId: workflow.customerId, assets: workflow.assets, createdAt: workflow.plan.createdAt}); }));
app.get('/api/requests/:id/sandbox', route(req => { const workflow = workflows.get(id(req)); if (!workflow.sandbox) throw new HttpError(404, 'Sandbox result not found'); return workflow.sandbox; }));
app.get('/api/requests/:id/backup', route(req => { const workflow = workflows.get(id(req)); const manifest = workflow.backup as BackupManifest | undefined; if (!manifest) throw new HttpError(404, 'No backup was taken for this request'); return {manifest, verification: verifyBackupManifest(manifest, {requestId: workflow.requestId, customerId: workflow.customerId, planHash: workflow.plan.hash}), checks: workflow.backupChecks ?? [], failures: workflow.backupFailures ?? []}; }));
app.get('/api/requests/:id/verification', route(async req => { const workflow = workflows.get(id(req)); const results = await Promise.all([postgres.verify(workflow.customerId), minio.verify(workflow.customerId)]); return {requestId: workflow.requestId, customerId: workflow.customerId, checkedAt: new Date().toISOString(), verified: results.every(result => result.verified && result.remainingMatches === 0), results, remainingMatches: results.reduce((total, result) => total + result.remainingMatches, 0)}; }));

/** Streams agent events as server-sent events until the run finishes or pauses for a human. */
async function streamEvents(res: express.Response, events: AsyncIterable<AgentEvent>) {
  res.status(200).set({'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'});
  res.flushHeaders();
  // req 'close' fires once the body is read; the response closing is what means the client left.
  let open = true;
  res.on('close', () => { open = false; });
  for await (const event of events) if (open) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end();
}

app.get('/api/agent/runs', (_req, res) => res.json(agent.list()));
app.get('/api/agent/runs/:id', route(req => { const record = agent.record(id(req)); if (!record) throw new HttpError(404, 'Agent run not found'); return record; }));
app.post('/api/agent/runs', async (req, res) => {
  const goal = typeof req.body?.goal === 'string' ? req.body.goal.trim() : '';
  if (!goal || goal.length > 500) return res.status(400).json({error: 'Send the goal as "goal" (1 to 500 characters)'});
  const run = agent.start(goal, operator(req)?.trim() || 'console user');
  await streamEvents(res, run.events);
});
app.post('/api/agent/runs/:id/resume', async (req, res) => {
  const record = agent.record(id(req));
  const who = operator(req)?.trim();
  const action = req.body?.decision;
  if (!record) return res.status(404).json({error: 'Agent run not found'});
  if (!who) return res.status(401).json({error: 'Operator identity required: send the x-operator-identity header'});
  if (record.status !== 'awaiting_approval' || !record.approval) return res.status(409).json({error: `This run is ${record.status.replace('_', ' ')}, not waiting for approval`});
  if (action !== 'approve' && action !== 'reject') return res.status(400).json({error: 'decision must be "approve" or "reject"'});
  if (action === 'approve' && req.body?.confirmation !== record.approval.customerId) return res.status(400).json({error: `Type ${record.approval.customerId} to approve destructive execution`});
  await streamEvents(res, agent.resume(record.threadId, {action, operator: who, confirmation: req.body?.confirmation, reason: typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : undefined}));
});

const resetDemo = route(async () => {
  await store.clear();
  agent.reset();
  if (mock) { mock.dataset.reset(); return {ok: true, reset: true, dataset: 'In-memory dataset restored from the fixture'}; }
  const seeded = await seedLocalSystems(pool!, localObjectClient!, loadDatasetFixture(runtimeConfig.datasetFile));
  return {ok: true, reset: true, dataset: `Reseeded ${seeded.rows} PostgreSQL rows and ${seeded.objects} MinIO objects`};
});
app.post('/api/demo/reset', resetDemo);
app.post('/api/reset', resetDemo);
app.use('/api', (_req, res) => res.status(404).json({error: 'Unknown API route'}));

if (process.env.ERASEROPS_START_SERVER === 'true') app.listen(runtimeConfig.port, () => console.log(`EraseOps API on http://localhost:${runtimeConfig.port} (demo mode, ${runtimeConfig.connectorMode} connectors)`));
