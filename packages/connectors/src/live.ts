import type {Asset, DataSystem, DeletionAction, Dependency, ExecutionResult, SimulationReport, VerificationResult} from '../../../packages/shared/src/index.js';
import type {BackupResourceEvidence, BackupResult, BackupVerification, ConnectorContext, InventoryEntry, RestoreResult} from './index.js';
import {PostgresAdapter, MinioAdapter} from './adapters.js';

export type LiveExecutionContext = {approved: boolean; customerId?: string; authoritativePlanHash?: string};
const requireCustomer = (ctx: LiveExecutionContext, action: DeletionAction) => { if (!ctx.customerId) throw new Error(`Customer identity required to execute ${action.id}`); return ctx.customerId; };

export class PostgresLiveConnector {
  readonly system: DataSystem = {id: 'postgres-local', name: 'PostgreSQL', type: 'postgresql', connectionStatus: 'connected', capabilities: ['discover', 'dependencies', 'preview', 'backup', 'simulate', 'execute', 'verify', 'restore']};
  constructor(private readonly adapter: PostgresAdapter) {}
  async discoverCustomerData(customerId: string, ctx: ConnectorContext): Promise<Asset[]> { if (!ctx.demoMode) throw new Error('Production credentials are disabled in local connector mode'); if (!ctx.allowlistedHosts.includes('postgres')) throw new Error('PostgreSQL host is not allowlisted'); return this.adapter.discover(customerId); }
  inspectDependencies(customerId: string): Promise<Dependency[]> { return this.adapter.inspectDependencies(customerId); }
  previewAction(action: DeletionAction) { return this.adapter.previewAction(action); }
  backupCustomerData(customerId: string, requestId: string): Promise<BackupResult> { return this.adapter.backupCustomerData(customerId, requestId); }
  verifyBackup(customerId: string, requestId: string, evidence: BackupResourceEvidence[]): Promise<BackupVerification> { return this.adapter.verifyBackup(customerId, requestId, evidence); }
  restoreCustomerData(customerId: string, requestId: string): Promise<RestoreResult> { return this.adapter.restoreCustomerData(customerId, requestId); }
  simulate(customerId: string, actions: DeletionAction[]): Promise<SimulationReport> { return this.adapter.simulate(customerId, actions); }
  async execute(action: DeletionAction, planHash: string, ctx: LiveExecutionContext): Promise<ExecutionResult> { return this.adapter.executeForCustomer(requireCustomer(ctx, action), action, planHash, {approved: ctx.approved, authoritativePlanHash: ctx.authoritativePlanHash ?? planHash}); }
  verify(customerId: string): Promise<VerificationResult> { return this.adapter.verify(customerId); }
  listCustomers() { return this.adapter.listCustomers(); }
  profile(customerId: string) { return this.adapter.profile(customerId); }
  inventory(): Promise<InventoryEntry[]> { return this.adapter.inventory(); }
}

export class MinioLiveConnector {
  readonly system: DataSystem = {id: 'minio-local', name: 'MinIO', type: 'minio', connectionStatus: 'connected', capabilities: ['discover', 'preview', 'backup', 'simulate', 'execute', 'verify', 'restore']};
  constructor(private readonly adapter: MinioAdapter, private readonly allowedBuckets: readonly string[]) {}
  async discoverCustomerData(customerId: string, ctx: ConnectorContext): Promise<Asset[]> { if (!ctx.demoMode) throw new Error('Production credentials are disabled in local connector mode'); return this.adapter.discover(customerId); }
  inspectDependencies(_customerId: string): Promise<Dependency[]> { return Promise.resolve([]); }
  previewAction(action: DeletionAction) { return Promise.resolve({safe: action.actionType !== 'delete' || this.allowedBuckets.includes(action.resource), affected: action.recordCount, reason: 'MinIO structured object preview'}); }
  backupCustomerData(customerId: string, requestId: string): Promise<BackupResult> { return this.adapter.backupCustomerObjects(customerId, requestId); }
  verifyBackup(_customerId: string, requestId: string, evidence: BackupResourceEvidence[]): Promise<BackupVerification> { return this.adapter.verifyBackupObjects(requestId, evidence); }
  restoreCustomerData(customerId: string, requestId: string): Promise<RestoreResult> { return this.adapter.restoreCustomerObjects(customerId, requestId); }
  simulate(customerId: string, actions: DeletionAction[]): Promise<SimulationReport> { return this.adapter.simulateDeletes(customerId, actions); }
  async execute(action: DeletionAction, planHash: string, ctx: LiveExecutionContext): Promise<ExecutionResult> { const startedAt = new Date().toISOString(); if (action.actionType === 'retain') return {actionId: action.id, status: 'skipped', startedAt, completedAt: startedAt, affectedRecords: 0}; const result = await this.adapter.deleteCustomerBucketObjects(requireCustomer(ctx, action), action.resource, ctx.approved, planHash, ctx.authoritativePlanHash ?? planHash); return {actionId: action.id, status: 'completed', startedAt, completedAt: new Date().toISOString(), affectedRecords: result.deleted}; }
  verify(customerId: string): Promise<VerificationResult> { return this.adapter.verify(customerId); }
  listCustomers() { return this.adapter.listCustomerIds(); }
  inventory(): Promise<InventoryEntry[]> { return this.adapter.inventory(); }
}
