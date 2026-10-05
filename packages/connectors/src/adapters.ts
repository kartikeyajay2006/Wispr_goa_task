import {createHash} from 'node:crypto';
import type {Asset, DeletionAction, ExecutionResult} from '../../../packages/shared/src/index.js';
import type {BackupResourceEvidence} from './index.js';
import {ruleFor} from '../../../packages/policy-engine/src/retention-policy.js';
import {POSTGRES_SCHEMA, SOURCE_BUCKETS, objectPrefixFor, tableSchema} from './schema.js';

export type QueryExecutor = {query<T = unknown>(sql: string, params: readonly unknown[]): Promise<{rows: T[]}>};
export type BackupWriter = {put(bucket: string, key: string, body: string): Promise<void>};
const assertCustomerId = (customerId: string) => { if (!/^CUST-\d{4}$/.test(customerId)) throw new Error('Customer identifier is invalid'); };
const allowedTables = new Set(POSTGRES_SCHEMA.map(schema => schema.name));
const deletableTables = new Set(['customers', 'users', 'addresses', 'order_items', 'support_tickets', 'support_messages', 'analytics_events', 'marketing_profiles', 'organization_members', 'organizations']);
const anonymizableTables = new Set(['customers', 'users', 'orders', 'payments', 'support_tickets', 'support_messages', 'marketing_profiles']);

export class PostgresAdapter {
  constructor(private readonly db: QueryExecutor, private readonly backupWriter?: BackupWriter) {}
  async discover(customerId: string): Promise<Asset[]> { assertCustomerId(customerId); const result = await this.db.query<{table_name: string; record_count: number}>('SELECT table_name, record_count FROM eraseops_customer_footprint WHERE customer_id = $1', [customerId]); return result.rows.filter(row => allowedTables.has(row.table_name) && row.record_count > 0).map(row => { const rule = ruleFor('PostgreSQL', row.table_name); const schema = tableSchema(row.table_name)!; return {id: `pg:${row.table_name}:${customerId}`, system: 'PostgreSQL', table: row.table_name, label: rule.label, classification: rule.classification, basis: rule.basis, fields: schema.piiColumns.length ? [...schema.piiColumns] : [schema.ownership.kind === 'self' ? 'id' : schema.ownership.column], dependencyIds: [], risk: rule.risk, count: row.record_count}; }); }
  async inspectDependencies(customerId: string) { assertCustomerId(customerId); return this.discover(customerId).then(assets => assets.filter(asset => ['order_items', 'payments'].includes(asset.table)).map(asset => ({source: asset.id, target: `pg:orders:${customerId}`, relationshipType: 'foreign key', constraintType: 'foreign_key' as const, required: true, risk: asset.risk}))); }
  private assertPlan(approved: boolean, planHash: string, authoritativePlanHash: string) { if (!approved) throw new Error('Human approval required'); if (!/^[a-f0-9]{64}$/.test(planHash) || planHash !== authoritativePlanHash) throw new Error('Plan hash mismatch'); }
  private assertTable(table: string) { if (!allowedTables.has(table)) throw new Error('PostgreSQL table is not allowlisted'); }
  async previewAction(action: DeletionAction) { this.assertTable(action.resource); const safe = action.actionType !== 'delete' || deletableTables.has(action.resource); return {safe, affected: action.recordCount, reason: safe ? 'Parameterized structured action preview' : 'Resource is retained or requires anonymization'}; }
  async deleteCustomerRecords(customerId: string, table: string, approved: boolean, planHash: string, authoritativePlanHash: string) { assertCustomerId(customerId); this.assertPlan(approved, planHash, authoritativePlanHash); this.assertTable(table); if (!deletableTables.has(table)) throw new Error('PostgreSQL resource is not deletable'); const ownerColumn: Record<string, string> = {customers: 'id', organizations: 'owner_customer_id'}; const query = table === 'order_items' ? 'DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE customer_id = $1) RETURNING 1' : `DELETE FROM ${table} WHERE ${ownerColumn[table] ?? 'customer_id'} = $1 RETURNING 1`; const result = await this.db.query<{affected: number}>(query, [customerId]); return {deleted: result.rows.length}; }
  async anonymizeCustomerRecords(customerId: string, approved: boolean, planHash: string, authoritativePlanHash: string, table = 'customers') { assertCustomerId(customerId); this.assertPlan(approved, planHash, authoritativePlanHash); this.assertTable(table); if (!anonymizableTables.has(table)) throw new Error('PostgreSQL resource is not anonymizable'); const statements: Record<string, string> = {customers: "UPDATE customers SET name = '[redacted]', email = '[redacted]' WHERE id = $1 RETURNING 1", users: "UPDATE users SET name = '[redacted]', email = '[redacted]' WHERE customer_id = $1 RETURNING 1", orders: 'UPDATE orders SET customer_id = NULL WHERE customer_id = $1 RETURNING 1', payments: "UPDATE payments p SET billing_email = '[redacted]' FROM orders o WHERE p.order_id = o.id AND o.customer_id = $1 RETURNING 1", support_tickets: "UPDATE support_tickets SET subject = '[redacted]' WHERE customer_id = $1 RETURNING 1", support_messages: "UPDATE support_messages SET body = '[redacted]' WHERE customer_id = $1 RETURNING 1", marketing_profiles: "UPDATE marketing_profiles SET email = '[redacted]', preferences = '{}'::jsonb WHERE customer_id = $1 RETURNING 1"}; const result = await this.db.query<{affected: number}>(statements[table], [customerId]); return {anonymized: result.rows.length}; }
  async backupCustomerData(customerId: string, requestId: string) {
    const assets = await this.discover(customerId);
    const exportQuery: Record<string, string> = {
      customers: 'SELECT id, email, name FROM customers WHERE id = $1',
      users: 'SELECT id, customer_id, email, name FROM users WHERE customer_id = $1',
      addresses: 'SELECT id, customer_id, line1, city, postal_code FROM addresses WHERE customer_id = $1',
      orders: 'SELECT id, customer_id, total, created_at FROM orders WHERE customer_id = $1',
      order_items: 'SELECT oi.id, oi.order_id, oi.sku, oi.quantity FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.customer_id = $1',
      payments: 'SELECT p.id, p.order_id, p.provider_reference, p.billing_email FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.customer_id = $1',
      support_tickets: 'SELECT id, customer_id, subject, status FROM support_tickets WHERE customer_id = $1',
      support_messages: 'SELECT id, customer_id, body FROM support_messages WHERE customer_id = $1',
      analytics_events: 'SELECT id, customer_id, event_name, payload FROM analytics_events WHERE customer_id = $1',
      marketing_profiles: 'SELECT id, customer_id, email, preferences FROM marketing_profiles WHERE customer_id = $1',
      audit_records: 'SELECT id, customer_id, event, created_at FROM audit_records WHERE customer_id = $1',
    };
    const snapshots: Array<{resource: string; records: number; rows: unknown[]}> = [];
    const resourceEvidence: BackupResourceEvidence[] = [];
    for (const asset of assets) {
      const result = await this.db.query<{payload?: unknown}>(`SELECT COALESCE(jsonb_agg(to_jsonb(snapshot)), '[]'::jsonb) AS payload FROM (${exportQuery[asset.table]}) snapshot`, [customerId]);
      const payload = result.rows[0]?.payload;
      const rows = Array.isArray(payload) ? payload : [];
      const serialized = JSON.stringify(rows);
      snapshots.push({resource: asset.id, records: asset.count, rows});
      resourceEvidence.push({resource: asset.id, kind: 'database', records: asset.count, checksum: createHash('sha256').update(serialized).digest('hex')});
    }
    const checksum = createHash('sha256').update(JSON.stringify({requestId, customerId, resourceEvidence})).digest('hex');
    const artifact = `${requestId}/database.json`;
    if (this.backupWriter) await this.backupWriter.put('eraseops-backups', artifact, JSON.stringify({requestId, customerId, checksum, snapshots}));
    return {backupId: `postgres-backup-${requestId}`, checksum, resources: assets.reduce((total, asset) => total + asset.count, 0), resourceEvidence, artifacts: this.backupWriter ? [artifact] : []};
  }
  async executeForCustomer(customerId: string, action: DeletionAction, planHash: string, ctx: {approved: boolean; authoritativePlanHash: string}): Promise<ExecutionResult> { assertCustomerId(customerId); const startedAt = new Date().toISOString(); const result = action.actionType === 'delete' ? await this.deleteCustomerRecords(customerId, action.resource, ctx.approved, planHash, ctx.authoritativePlanHash) : action.actionType === 'anonymize' ? await this.anonymizeCustomerRecords(customerId, ctx.approved, planHash, ctx.authoritativePlanHash, action.resource) : {anonymized: 0}; return {actionId: action.id, status: 'completed', startedAt, completedAt: new Date().toISOString(), affectedRecords: 'deleted' in result ? result.deleted : result.anonymized}; }
  async verify(customerId: string) { assertCustomerId(customerId); const result = await this.db.query<{remaining: number}>('SELECT COALESCE(SUM(record_count), 0)::integer AS remaining FROM eraseops_customer_footprint WHERE customer_id = $1 AND table_name IN (\'users\',\'addresses\',\'analytics_events\',\'marketing_profiles\')', [customerId]); return {system: 'PostgreSQL', remainingMatches: result.rows[0]?.remaining ?? 0, verified: (result.rows[0]?.remaining ?? 0) === 0, details: 'Parameterized metadata-only rescan'}; }
}

export type ObjectClient = {list(bucket: string, prefix: string): Promise<string[]>; copy(source: string, target: string): Promise<void>; delete(key: string): Promise<void>};
export class MinioAdapter {
  private readonly sourceBuckets = SOURCE_BUCKETS;
  constructor(private readonly client: ObjectClient, private readonly allowedBuckets: readonly string[]) {}
  private assertBucket(bucket: string) { if (!this.allowedBuckets.includes(bucket)) throw new Error('MinIO bucket is not allowlisted'); }
  private prefixFor(bucket: string, customerId: string) { return objectPrefixFor(bucket, customerId); }
  private assertBackupTarget(targetPrefix: string) { if (!/^eraseops-backups\/[^/]+\/?$/.test(targetPrefix)) throw new Error('Backup target must use the eraseops-backups namespace'); }
  private assertSafeKey(key: string) { if (key.split('/').includes('..')) throw new Error('Backup object key contains a path traversal segment'); }
  private assertPlan(approved: boolean, planHash: string, authoritativePlanHash: string) { if (!approved) throw new Error('Human approval required'); if (!/^[a-f0-9]{64}$/.test(planHash) || planHash !== authoritativePlanHash) throw new Error('Plan hash mismatch'); }
  async discover(customerId: string) { assertCustomerId(customerId); const assets: Asset[] = []; for (const bucket of this.sourceBuckets) { if (!this.allowedBuckets.includes(bucket)) continue; const keys = await this.client.list(bucket, this.prefixFor(bucket, customerId)); if (!keys.length) continue; const rule = ruleFor('MinIO', bucket); assets.push({id: `minio:${bucket}:${customerId}`, system: 'MinIO', table: bucket, label: rule.label, classification: rule.classification, basis: rule.basis, fields: ['object_key', 'metadata'], dependencyIds: [], risk: rule.risk, count: keys.length, recordIds: keys}); } return assets; }
  async listKeys(bucket: string, prefix: string) { this.assertBucket(bucket); const keys = await this.client.list(bucket, prefix); keys.forEach(key => this.assertSafeKey(key)); return keys; }
  async backup(bucket: string, prefix: string, targetPrefix: string) { this.assertBucket(bucket); this.assertBackupTarget(targetPrefix); const keys = await this.client.list(bucket, prefix); const destination = targetPrefix.replace(/\/+$/, ''); for (const key of keys) { this.assertSafeKey(key); await this.client.copy(`${bucket}/${key}`, `${destination}/${key.replace(/^\/+/, '')}`); } return {copied: keys.length}; }
  async deleteCustomerBucketObjects(customerId: string, bucket: string, approved: boolean, planHash: string, authoritativePlanHash: string) { assertCustomerId(customerId); this.assertPlan(approved, planHash, authoritativePlanHash); this.assertBucket(bucket); let deleted = 0; for (const key of await this.client.list(bucket, this.prefixFor(bucket, customerId))) { this.assertSafeKey(key); await this.client.delete(`${bucket}/${key}`); deleted++; } return {deleted}; }
  async deleteCustomerObjects(customerId: string, approved: boolean, planHash: string, authoritativePlanHash: string) { assertCustomerId(customerId); this.assertPlan(approved, planHash, authoritativePlanHash); let deleted = 0; for (const bucket of this.sourceBuckets) { if (!this.allowedBuckets.includes(bucket)) continue; deleted += (await this.deleteCustomerBucketObjects(customerId, bucket, true, planHash, authoritativePlanHash)).deleted; } return {deleted}; }
  async verify(customerId: string) { assertCustomerId(customerId); let remainingMatches = 0; for (const bucket of this.sourceBuckets) { if (!this.allowedBuckets.includes(bucket)) continue; remainingMatches += (await this.client.list(bucket, this.prefixFor(bucket, customerId))).length; } return {system: 'MinIO', remainingMatches, verified: remainingMatches === 0, details: 'Allowlisted object rescan across customer buckets'}; }
}
