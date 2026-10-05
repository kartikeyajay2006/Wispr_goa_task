import {createHash} from 'node:crypto';
import type {Asset, DataSystem, DeletionAction, Dependency, ExecutionResult, VerificationResult} from '../../../packages/shared/src/index.js';
import type {ConnectorContext, BackupResult} from './index.js';
import {PostgresAdapter, MinioAdapter} from './adapters.js';

export type LiveExecutionContext = {approved: boolean; customerId: string; authoritativePlanHash?: string};

export class PostgresLiveConnector {
  readonly system: DataSystem = {id: 'postgres-local', name: 'PostgreSQL Local', type: 'postgresql', connectionStatus: 'connected', capabilities: ['discover', 'dependencies', 'preview', 'backup', 'execute', 'verify']};
  constructor(private readonly adapter: PostgresAdapter) {}
  async discoverCustomerData(customerId: string, ctx: ConnectorContext): Promise<Asset[]> { if (!ctx.demoMode) throw new Error('Production credentials are disabled in local connector mode'); if (!ctx.allowlistedHosts.includes('postgres')) throw new Error('PostgreSQL host is not allowlisted'); return this.adapter.discover(customerId); }
  inspectDependencies(customerId: string): Promise<Dependency[]> { return this.adapter.inspectDependencies(customerId); }
  previewAction(action: DeletionAction) { return this.adapter.previewAction(action); }
  backupCustomerData(customerId: string, requestId: string): Promise<BackupResult> { return this.adapter.backupCustomerData(customerId, requestId); }
  async execute(action: DeletionAction, planHash: string, ctx: LiveExecutionContext): Promise<ExecutionResult> { const authoritativePlanHash = ctx.authoritativePlanHash ?? planHash; const result = await this.adapter.executeForCustomer(ctx.customerId, action, planHash, {approved: ctx.approved, authoritativePlanHash}); return result; }
  verify(customerId: string): Promise<VerificationResult> { return this.adapter.verify(customerId); }
}

export class MinioLiveConnector {
  readonly system: DataSystem = {id: 'minio-local', name: 'MinIO Local', type: 'minio', connectionStatus: 'connected', capabilities: ['discover', 'preview', 'backup', 'execute', 'verify']};
  constructor(private readonly adapter: MinioAdapter, private readonly allowedBuckets: readonly string[]) {}
  async discoverCustomerData(customerId: string, ctx: ConnectorContext): Promise<Asset[]> { if (!ctx.demoMode) throw new Error('Production credentials are disabled in local connector mode'); return this.adapter.discover(customerId); }
  inspectDependencies(_customerId: string): Promise<Dependency[]> { return Promise.resolve([]); }
  previewAction(action: DeletionAction) { return Promise.resolve({safe: action.actionType !== 'delete' || this.allowedBuckets.includes(action.resource), affected: action.recordCount, reason: 'MinIO structured object preview'}); }
  async backupCustomerData(customerId: string, requestId: string): Promise<BackupResult> { let resources = 0; const resourceEvidence: NonNullable<BackupResult['resourceEvidence']> = []; for (const bucket of ['customer-uploads', 'support-attachments', 'exports']) { if (!this.allowedBuckets.includes(bucket)) continue; const prefix = bucket === 'exports' ? customerId : `${customerId}/`; const keys = await this.adapter.listKeys(bucket, prefix); await this.adapter.backup(bucket, prefix, `eraseops-backups/${requestId}`); resources += keys.length; resourceEvidence.push(...keys.map(key => ({resource: `minio:${bucket}:${key}`, kind: 'object' as const, records: 1, checksum: createHash('sha256').update(`${requestId}:${bucket}:${key}`).digest('hex')}))); } const checksum = createHash('sha256').update(JSON.stringify({requestId, customerId, resourceEvidence})).digest('hex'); return {backupId: `minio-backup-${requestId}`, checksum, resources, resourceEvidence}; }
  async execute(action: DeletionAction, planHash: string, ctx: LiveExecutionContext): Promise<ExecutionResult> { const startedAt = new Date().toISOString(); const result = await this.adapter.deleteCustomerBucketObjects(ctx.customerId, action.resource, ctx.approved, planHash, ctx.authoritativePlanHash ?? planHash); return {actionId: action.id, status: 'completed', startedAt, completedAt: new Date().toISOString(), affectedRecords: result.deleted}; }
  verify(customerId: string): Promise<VerificationResult> { return this.adapter.verify(customerId); }
}
