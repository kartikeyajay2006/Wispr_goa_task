import type {Asset, DataSystem, DeletionAction, Dependency, ExecutionResult, VerificationResult} from '../../../packages/shared/src/index.js';

export type ConnectorContext = {demoMode: true; allowlistedHosts: string[]; allowlistedBuckets: string[]};
export type BackupResourceEvidence = {resource:string;kind:'database'|'object';records:number;checksum:string};
export type BackupResult = {backupId: string; checksum: string; resources: number; resourceEvidence?: BackupResourceEvidence[]; artifacts?: string[]};
export interface Connector { readonly system: DataSystem; discoverCustomerData(customerId: string, ctx: ConnectorContext): Promise<Asset[]>; inspectDependencies?(customerId: string): Promise<Dependency[]>; previewAction(action: DeletionAction): Promise<{safe: boolean; affected: number; reason: string}>; backupCustomerData(customerId: string, requestId: string): Promise<BackupResult>; execute(action: DeletionAction, planHash: string, ctx: {approved: boolean}): Promise<ExecutionResult>; verify(customerId: string): Promise<VerificationResult>; }

const assertDemo = (ctx: ConnectorContext) => { if (!ctx.demoMode) throw new Error('Production credentials are disabled in demo connector'); };
export const SEEDED_CUSTOMERS = ['CUST-1042', 'CUST-2088', 'CUST-7001', 'CUST-9001'] as const;
export const assertSeededCustomer = (customerId: string) => { if (!(SEEDED_CUSTOMERS as readonly string[]).includes(customerId)) throw new Error(`Demo customer is not seeded: ${customerId}`); return customerId; };

const postgresAssets = (customerId: string): Asset[] => [
  {id: `pg:customers:${customerId}`, system: 'PostgreSQL', table: 'customers', label: 'Customer profile', classification: 'anonymize', fields: ['name', 'email', 'phone'], dependencyIds: [], risk: 'high', count: 1},
  {id: `pg:users:${customerId}`, system: 'PostgreSQL', table: 'users', label: 'Customer users', classification: 'deletable', fields: ['email', 'name'], dependencyIds: [], risk: 'high', count: 1},
  {id: `pg:addresses:${customerId}`, system: 'PostgreSQL', table: 'addresses', label: 'Saved addresses', classification: 'deletable', fields: ['line1', 'city', 'postal_code'], dependencyIds: [], risk: 'high', count: 2},
  {id: `pg:orders:${customerId}`, system: 'PostgreSQL', table: 'orders', label: 'Order history', classification: 'retain', fields: ['order_id', 'customer_id', 'total'], dependencyIds: [`pg:customers:${customerId}`], risk: 'medium', count: 1},
  {id: `pg:order_items:${customerId}`, system: 'PostgreSQL', table: 'order_items', label: 'Order items', classification: 'retain', fields: ['order_id', 'sku', 'quantity'], dependencyIds: [`pg:orders:${customerId}`], risk: 'low', count: 1},
  {id: `pg:payments:${customerId}`, system: 'PostgreSQL', table: 'payments', label: 'Payment records', classification: 'retain', fields: ['provider_reference', 'billing_email'], dependencyIds: [`pg:orders:${customerId}`], risk: 'high', count: 1},
  {id: `pg:support_tickets:${customerId}`, system: 'PostgreSQL', table: 'support_tickets', label: 'Support tickets', classification: 'anonymize', fields: ['subject', 'status'], dependencyIds: [], risk: 'medium', count: 1},
  {id: `pg:support_messages:${customerId}`, system: 'PostgreSQL', table: 'support_messages', label: 'Support messages', classification: 'anonymize', fields: ['body'], dependencyIds: [`pg:support_tickets:${customerId}`], risk: 'medium', count: 1},
  {id: `pg:analytics_events:${customerId}`, system: 'PostgreSQL', table: 'analytics_events', label: 'Analytics events', classification: 'deletable', fields: ['event_name', 'payload'], dependencyIds: [], risk: 'medium', count: 1},
  {id: `pg:marketing_profiles:${customerId}`, system: 'PostgreSQL', table: 'marketing_profiles', label: 'Marketing profile', classification: 'deletable', fields: ['email', 'preferences'], dependencyIds: [], risk: 'high', count: 1},
  {id: `pg:audit_records:${customerId}`, system: 'PostgreSQL', table: 'audit_records', label: 'Audit records', classification: 'retain', fields: ['event', 'created_at'], dependencyIds: [], risk: 'low', count: 1},
];

export class MockPostgresConnector implements Connector {
  readonly system: DataSystem = {id: 'postgres-demo', name: 'PostgreSQL Demo', type: 'postgresql', connectionStatus: 'mock', capabilities: ['discover', 'preview', 'backup', 'execute', 'verify']};
  async inspectDependencies(customerId: string): Promise<Dependency[]> { assertSeededCustomer(customerId); return customerId === 'CUST-9001' ? [{source: 'customer', target: 'organization', relationshipType: 'shared account', constraintType: 'business', required: true, risk: 'high'}] : []; }
  async discoverCustomerData(customerId: string, ctx: ConnectorContext): Promise<Asset[]> { assertDemo(ctx); assertSeededCustomer(customerId); if (!ctx.allowlistedHosts.includes('postgres')) throw new Error('PostgreSQL host is not allowlisted'); if (customerId === 'CUST-9001') return [{id: 'pg:org:9001', system: 'PostgreSQL', table: 'organizations', label: 'Shared enterprise account', classification: 'retain', fields: ['org_id'], dependencyIds: ['pg:users:9001', 'pg:users:9002'], risk: 'high', count: 1}]; return postgresAssets(customerId); }
  async previewAction(action: DeletionAction) { return {safe: action.actionType !== 'delete' || !action.resource.includes('organizations'), affected: action.recordCount, reason: action.actionType === 'delete' ? 'Mock parameterized delete preview' : 'No destructive mutation requested'}; }
  async backupCustomerData(customerId: string, requestId: string) { const resourceEvidence = postgresAssets(customerId).map(asset => ({resource: asset.id, kind: 'database' as const, records: asset.count, checksum: `mock:${requestId}:${asset.id}:${asset.count}`})); return {backupId: `backup-${requestId}`, checksum: `mock-${customerId}-checksum`, resources: 11, resourceEvidence, artifacts: []}; }
  async execute(action: DeletionAction, _planHash: string, ctx: {approved: boolean}) { if (!ctx.approved) throw new Error('Human approval required'); return {actionId: action.id, status: 'completed' as const, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), affectedRecords: action.recordCount}; }
  async verify(customerId: string) { return {system: this.system.name, remainingMatches: 0, verified: true, details: `Mock rescan completed for ${customerId}`}; }
}

const minioAssets = (customerId: string): Asset[] => [
  {id: `minio:customer-uploads:${customerId}`, system: 'MinIO', table: 'customer-uploads', label: 'Customer uploads', classification: 'deletable', fields: ['object_key', 'metadata'], dependencyIds: [], risk: 'high', count: 2},
  {id: `minio:support-attachments:${customerId}`, system: 'MinIO', table: 'support-attachments', label: 'Support attachments', classification: 'deletable', fields: ['object_key', 'metadata'], dependencyIds: [], risk: 'high', count: 1},
  {id: `minio:exports:${customerId}`, system: 'MinIO', table: 'exports', label: 'Customer exports', classification: 'deletable', fields: ['object_key', 'metadata'], dependencyIds: [], risk: 'high', count: 1},
];

export class MockMinioConnector implements Connector {
  readonly system: DataSystem = {id: 'minio-demo', name: 'MinIO Demo', type: 'minio', connectionStatus: 'mock', capabilities: ['discover', 'preview', 'backup', 'execute', 'verify']};
  async inspectDependencies(customerId: string) { assertSeededCustomer(customerId); return [] as Dependency[]; }
  async discoverCustomerData(customerId: string, ctx: ConnectorContext): Promise<Asset[]> { assertDemo(ctx); assertSeededCustomer(customerId); for (const bucket of ['customer-uploads', 'support-attachments', 'exports']) if (!ctx.allowlistedBuckets.includes(bucket)) throw new Error(`MinIO bucket is not allowlisted: ${bucket}`); return minioAssets(customerId); }
  async previewAction(action: DeletionAction) { return {safe: true, affected: action.recordCount, reason: 'Mock object deletion preview'}; }
  async backupCustomerData(customerId: string, requestId: string) { const resourceEvidence = minioAssets(customerId).map(asset => ({resource: asset.id, kind: 'object' as const, records: asset.count, checksum: `mock:${requestId}:${asset.id}:${asset.count}`})); return {backupId: `backup-${requestId}`, checksum: `mock-${customerId}-objects-checksum`, resources: 4, resourceEvidence, artifacts: []}; }
  async execute(action: DeletionAction, _planHash: string, ctx: {approved: boolean}) { if (!ctx.approved) throw new Error('Human approval required'); return {actionId: action.id, status: 'completed' as const, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), affectedRecords: action.recordCount}; }
  async verify(customerId: string) { return {system: this.system.name, remainingMatches: 0, verified: true, details: `Mock object rescan completed for ${customerId}`}; }
}
