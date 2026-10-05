import express from 'express';
import cors from 'cors';
import {Pool} from 'pg';
import {createMockConnectors, seededDataset, type Connector} from '../../../packages/connectors/src/index.js';
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

if (process.env.ERASEROPS_START_SERVER === 'true') loadEnvFile();
const runtimeConfig = loadConfig(process.env);

export const app = express();
app.use(cors({origin: runtimeConfig.corsOrigin === '*' ? true : runtimeConfig.corsOrigin.split(',').map(origin => origin.trim())}));
app.use(express.json({limit: '100kb'}));

const store = new InMemoryRuntimeStore(createMetadataRepository(runtimeConfig));
const localObjectClient = runtimeConfig.connectorMode === 'local' ? new MinioHttpObjectClient(runtimeConfig.minio) : undefined;
const mock = runtimeConfig.connectorMode === 'mock' ? createMockConnectors(seededDataset(runtimeConfig.datasetFile)) : undefined;
const postgres: Connector = mock?.postgres ?? new PostgresLiveConnector(new PostgresAdapter(new Pool({connectionString: runtimeConfig.databaseUrl}), localObjectClient));
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

app.get('/health', (_req, res) => res.json({ok: true, mode: runtimeConfig.connectorMode, allowlist: runtimeConfig.allowlistedSystems}));
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

const resetDemo = route(async () => { await store.clear(); mock?.dataset.reset(); return {ok: true, reset: true, dataset: mock ? 'fixture restored' : 'external systems unchanged'}; });
app.post('/api/demo/reset', resetDemo);
app.post('/api/reset', resetDemo);
app.use('/api', (_req, res) => res.status(404).json({error: 'Unknown API route'}));

if (process.env.ERASEROPS_START_SERVER === 'true') app.listen(runtimeConfig.port, () => console.log(`EraseOps API on http://localhost:${runtimeConfig.port} (demo mode, ${runtimeConfig.connectorMode} connectors)`));
