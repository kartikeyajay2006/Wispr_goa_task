import {createHash} from 'node:crypto';
import type {Asset, DeletionAction, Dependency, ExecutionResult, SimulationReport} from '../../../packages/shared/src/index.js';
import type {BackupResourceEvidence} from './index.js';
import {ruleFor} from '../../../packages/policy-engine/src/retention-policy.js';
import {maskEmail, maskName} from './masking.js';
import {BACKUP_BUCKET, POSTGRES_SCHEMA, REDACTED, SOURCE_BUCKETS, objectPrefixFor, ownedRowsSql, ownerColumnSql, parentFirstOrder, tableSchema} from './schema.js';

export type SqlRunner = {query<T = unknown>(sql: string, params: readonly unknown[]): Promise<{rows: T[]}>};
/** A pg.Pool or anything query-shaped; `connect` enables transactions for simulation and restore. */
export type QueryExecutor = SqlRunner & {connect?(): Promise<SqlRunner & {release(): void}>};
export type BackupWriter = {put(bucket: string, key: string, body: string): Promise<void>; get?(bucket: string, key: string): Promise<string>};
const jsonColumns = new Set(['analytics_events.payload', 'marketing_profiles.preferences']);
const assertCustomerId = (customerId: string) => { if (!/^CUST-\d{4}$/.test(customerId)) throw new Error('Customer identifier is invalid'); };
const allowedTables = new Set(POSTGRES_SCHEMA.map(schema => schema.name));
const deletableTables = new Set(['customers', 'users', 'addresses', 'order_items', 'support_tickets', 'support_messages', 'analytics_events', 'marketing_profiles', 'organization_members', 'organizations']);
const anonymizableTables = new Set(['customers', 'users', 'orders', 'payments', 'support_tickets', 'support_messages', 'marketing_profiles']);

export class PostgresAdapter {
  constructor(private readonly db: QueryExecutor, private readonly backupWriter?: BackupWriter) {}
  async discover(customerId: string): Promise<Asset[]> {
    assertCustomerId(customerId);
    const result = await this.db.query<{table_name: string; record_count: number}>('SELECT table_name, record_count FROM eraseops_customer_footprint WHERE customer_id = $1', [customerId]);
    const counts = new Map(result.rows.filter(row => allowedTables.has(row.table_name) && Number(row.record_count) > 0).map(row => [row.table_name, Number(row.record_count)]));
    return POSTGRES_SCHEMA.filter(schema => counts.has(schema.name)).map(schema => {
      const rule = ruleFor('PostgreSQL', schema.name);
      return {id: `pg:${schema.name}:${customerId}`, system: 'PostgreSQL', table: schema.name, label: rule.label, classification: rule.classification, basis: rule.basis, fields: schema.piiColumns.length ? [...schema.piiColumns] : [schema.ownership.kind === 'self' ? 'id' : schema.ownership.column], dependencyIds: schema.foreignKeys.filter(fk => counts.has(fk.references)).map(fk => `pg:${fk.references}:${customerId}`), risk: rule.risk, count: counts.get(schema.name)!};
    });
  }

  /** Foreign keys inside the footprint, rows of other customers that point at it, and retention holds. */
  async inspectDependencies(customerId: string): Promise<Dependency[]> {
    assertCustomerId(customerId);
    const assets = await this.discover(customerId);
    const present = new Set(assets.map(asset => asset.table));
    const dependencies: Dependency[] = [];
    for (const asset of assets) {
      for (const fk of tableSchema(asset.table)!.foreignKeys) {
        if (fk.references === 'customers' && asset.table !== 'organizations') continue;
        dependencies.push({source: asset.id, target: `pg:${fk.references}:${customerId}`, relationshipType: 'foreign key', constraintType: 'foreign_key', required: true, risk: asset.risk});
      }
    }
    dependencies.push(...await this.crossCustomerReferences(this.db, customerId, present));
    for (const asset of assets) { const rule = ruleFor('PostgreSQL', asset.table); if (rule.classification === 'retain') dependencies.push({source: asset.id, target: `policy:${asset.table}`, relationshipType: rule.retention ? `${rule.basis} (${rule.retention})` : rule.basis, constraintType: 'retention', required: true, risk: 'low'}); }
    return dependencies;
  }

  /** Rows owned by other customers whose foreign keys point at rows owned by this customer. */
  private async crossCustomerReferences(db: SqlRunner, customerId: string, present: Set<string>): Promise<Dependency[]> {
    const dependencies: Dependency[] = [];
    for (const child of POSTGRES_SCHEMA) for (const fk of child.foreignKeys) {
      if (fk.references === 'customers' || !present.has(fk.references)) continue;
      const childOwner = ownerColumnSql(child.name, 'c');
      if (!childOwner) continue;
      const result = await db.query<{owner: string; references: number}>(`SELECT ${childOwner} AS owner, count(*)::integer AS references FROM ${child.name} c WHERE c.${fk.column} IN (${ownedRowsSql(fk.references, 't.id')}) AND ${childOwner} IS DISTINCT FROM $1 GROUP BY ${childOwner}`, [customerId]);
      for (const row of result.rows) dependencies.push({source: `pg:${child.name}:${row.owner}`, target: `pg:${fk.references}:${customerId}`, relationshipType: `${row.references} ${child.name} row${row.references === 1 ? '' : 's'} owned by ${row.owner} ${row.references === 1 ? 'references' : 'reference'} this customer's ${fk.references}`, constraintType: 'business', required: true, risk: 'high'});
    }
    return dependencies;
  }

  private assertPlan(approved: boolean, planHash: string, authoritativePlanHash: string) { if (!approved) throw new Error('Human approval required'); if (!/^[a-f0-9]{64}$/.test(planHash) || planHash !== authoritativePlanHash) throw new Error('Plan hash mismatch'); }
  private assertTable(table: string) { if (!allowedTables.has(table)) throw new Error('PostgreSQL table is not allowlisted'); }
  async previewAction(action: DeletionAction) { this.assertTable(action.resource); const safe = action.actionType !== 'delete' || (deletableTables.has(action.resource) && ruleFor('PostgreSQL', action.resource).classification === 'deletable'); return {safe, affected: action.recordCount, reason: safe ? 'Parameterized structured action preview' : 'Resource is retained or requires anonymization'}; }

  private deleteSql(table: string) {
    const ownership = tableSchema(table)!.ownership;
    if (ownership.kind === 'via') { const parent = tableSchema(ownership.table)!; const parentOwner = parent.ownership.kind === 'column' ? parent.ownership.column : 'id'; return `DELETE FROM ${table} t USING ${ownership.table} p WHERE p.id = t.${ownership.column} AND p.${parentOwner} = $1 RETURNING 1`; }
    return `DELETE FROM ${table} t WHERE ${ownerColumnSql(table, 't')} = $1 RETURNING 1`;
  }
  private anonymizeSql(table: string) {
    const schema = tableSchema(table)!;
    const columns = schema.piiColumns.filter(column => !jsonColumns.has(`${table}.${column}`));
    const assignments = schema.piiColumns.map(column => jsonColumns.has(`${table}.${column}`) ? `${column} = '{}'::jsonb` : `${column} = '${REDACTED}'`).join(', ');
    const pending = columns.length ? ` AND (${columns.map(column => `t.${column} IS DISTINCT FROM '${REDACTED}'`).join(' OR ')})` : '';
    return `UPDATE ${table} t SET ${assignments} WHERE ${ownerColumnSql(table, 't')} = $1${pending} RETURNING 1`;
  }
  private async runAction(db: SqlRunner, customerId: string, action: DeletionAction) {
    this.assertTable(action.resource);
    if (action.actionType === 'delete') { if (!deletableTables.has(action.resource) || ruleFor('PostgreSQL', action.resource).classification !== 'deletable') throw new Error('PostgreSQL resource is not deletable'); return (await db.query(this.deleteSql(action.resource), [customerId])).rows.length; }
    if (action.actionType === 'anonymize') { if (!anonymizableTables.has(action.resource)) throw new Error('PostgreSQL resource is not anonymizable'); return (await db.query(this.anonymizeSql(action.resource), [customerId])).rows.length; }
    return 0;
  }

  async deleteCustomerRecords(customerId: string, table: string, approved: boolean, planHash: string, authoritativePlanHash: string) { assertCustomerId(customerId); this.assertPlan(approved, planHash, authoritativePlanHash); this.assertTable(table); if (!deletableTables.has(table)) throw new Error('PostgreSQL resource is not deletable'); return {deleted: (await this.db.query<{affected: number}>(this.deleteSql(table), [customerId])).rows.length}; }
  async anonymizeCustomerRecords(customerId: string, approved: boolean, planHash: string, authoritativePlanHash: string, table = 'customers') { assertCustomerId(customerId); this.assertPlan(approved, planHash, authoritativePlanHash); this.assertTable(table); if (!anonymizableTables.has(table)) throw new Error('PostgreSQL resource is not anonymizable'); return {anonymized: (await this.db.query<{affected: number}>(this.anonymizeSql(table), [customerId])).rows.length}; }

  async backupCustomerData(customerId: string, requestId: string) {
    const assets = await this.discover(customerId);
    const snapshots: Array<{resource: string; table: string; records: number; rows: unknown[]}> = [];
    const resourceEvidence: BackupResourceEvidence[] = [];
    for (const asset of assets) {
      const result = await this.db.query<{payload?: unknown}>(`SELECT COALESCE(jsonb_agg(to_jsonb(snapshot) ORDER BY snapshot.id), '[]'::jsonb) AS payload FROM (${ownedRowsSql(asset.table)}) snapshot`, [customerId]);
      const payload = result.rows[0]?.payload;
      const rows = Array.isArray(payload) ? payload : [];
      snapshots.push({resource: asset.id, table: asset.table, records: asset.count, rows});
      resourceEvidence.push({resource: asset.id, kind: 'database', records: asset.count, checksum: createHash('sha256').update(JSON.stringify(rows)).digest('hex')});
    }
    const checksum = createHash('sha256').update(JSON.stringify({requestId, customerId, resourceEvidence})).digest('hex');
    const artifact = `${requestId}/database.json`;
    if (this.backupWriter) await this.backupWriter.put(BACKUP_BUCKET, artifact, JSON.stringify({requestId, customerId, checksum, snapshots}));
    return {backupId: `postgres-backup-${requestId}`, checksum, resources: assets.reduce((total, asset) => total + asset.count, 0), resourceEvidence, artifacts: this.backupWriter ? [artifact] : [], failures: [] as string[]};
  }

  private async readBackup(customerId: string, requestId: string) {
    if (!this.backupWriter?.get) throw new Error('No backup store is configured for PostgreSQL');
    const stored = JSON.parse(await this.backupWriter.get(BACKUP_BUCKET, `${requestId}/database.json`)) as {customerId: string; snapshots: Array<{resource: string; table: string; rows: Array<Record<string, unknown>>}>};
    if (stored.customerId !== customerId) throw new Error('Backup artifact belongs to a different customer');
    return stored;
  }
  async verifyBackup(customerId: string, requestId: string, evidence: BackupResourceEvidence[]) {
    const expected = evidence.filter(item => item.kind === 'database');
    if (!expected.length) return {system: 'PostgreSQL', verified: true, reason: 'No database records to back up', checked: 0};
    try {
      const stored = await this.readBackup(customerId, requestId);
      const mismatched = expected.filter(item => { const snapshot = stored.snapshots.find(entry => entry.resource === item.resource); return !snapshot || createHash('sha256').update(JSON.stringify(snapshot.rows)).digest('hex') !== item.checksum; });
      return {system: 'PostgreSQL', verified: !mismatched.length, reason: mismatched.length ? `Checksum mismatch for ${mismatched.map(item => item.resource).join(', ')}` : `Re-read ${expected.length} table snapshot${expected.length === 1 ? '' : 's'} and matched every checksum`, checked: expected.length};
    } catch (error) { return {system: 'PostgreSQL', verified: false, reason: error instanceof Error ? error.message : 'Backup could not be read', checked: 0}; }
  }

  /** Re-inserts backed-up rows, parents first, overwriting redacted values with the originals. */
  async restoreCustomerData(customerId: string, requestId: string) {
    const stored = await this.readBackup(customerId, requestId);
    const order = parentFirstOrder();
    const snapshots = [...stored.snapshots].sort((a, b) => order.indexOf(a.table) - order.indexOf(b.table));
    let restored = 0;
    await this.inTransaction(async db => {
      for (const snapshot of snapshots) {
        this.assertTable(snapshot.table);
        if (!snapshot.rows.length) continue;
        const columns = Object.keys(snapshot.rows[0]).filter(column => /^[a-z_]+$/.test(column));
        const updates = columns.filter(column => column !== 'id').map(column => `${column} = EXCLUDED.${column}`).join(', ');
        await db.query(`INSERT INTO ${snapshot.table} (${columns.join(', ')}) SELECT ${columns.join(', ')} FROM jsonb_populate_recordset(NULL::${snapshot.table}, $1::jsonb) ON CONFLICT (id) DO UPDATE SET ${updates}`, [JSON.stringify(snapshot.rows)]);
        restored += snapshot.rows.length;
      }
    });
    return {system: 'PostgreSQL', restored, details: `Restored ${restored} row${restored === 1 ? '' : 's'} across ${snapshots.length} table${snapshots.length === 1 ? '' : 's'}`};
  }

  private async inTransaction<T>(work: (db: SqlRunner) => Promise<T>, commit = true): Promise<T> {
    if (!this.db.connect) throw new Error('PostgreSQL executor cannot open a transaction');
    const client = await this.db.connect();
    try { await client.query('BEGIN', []); const result = await work(client); await client.query(commit ? 'COMMIT' : 'ROLLBACK', []); return result; }
    catch (error) { await client.query('ROLLBACK', []); throw error; }
    finally { client.release(); }
  }

  private async residual(db: SqlRunner, customerId: string) {
    const remaining: Array<{table: string; records: number}> = [];
    for (const schema of POSTGRES_SCHEMA) {
      const classification = ruleFor('PostgreSQL', schema.name).classification;
      if (classification === 'retain') continue;
      const textColumns = schema.piiColumns.filter(column => !jsonColumns.has(`${schema.name}.${column}`));
      if (classification === 'anonymize' && !textColumns.length) continue;
      const filter = classification === 'anonymize' ? ` AND (${textColumns.map(column => `t.${column} IS DISTINCT FROM '${REDACTED}'`).join(' OR ')})` : '';
      const result = await db.query<{remaining: number}>(`SELECT count(*)::integer AS remaining FROM (${ownedRowsSql(schema.name)}${filter}) owned`, [customerId]);
      const records = Number(result.rows[0]?.remaining ?? 0);
      if (records) remaining.push({table: schema.name, records});
    }
    return remaining;
  }

  /** Runs the plan inside a transaction that is always rolled back, so PostgreSQL itself enforces every constraint. */
  async simulate(customerId: string, actions: DeletionAction[]): Promise<SimulationReport> {
    assertCustomerId(customerId);
    const pgActions = actions.filter(action => action.system === 'PostgreSQL');
    const failures: string[] = [];
    let affected = 0;
    let residualAfter = 0;
    const present = new Set(pgActions.map(action => action.resource));
    try {
      await this.inTransaction(async db => {
        const shared = await this.crossCustomerReferences(db, customerId, present);
        const othersBefore = await this.othersChecksum(db, customerId);
        for (const action of pgActions) {
          await db.query('SAVEPOINT eraseops_action', []);
          try { affected += await this.runAction(db, customerId, action); await db.query('RELEASE SAVEPOINT eraseops_action', []); }
          catch (error) {
            await db.query('ROLLBACK TO SAVEPOINT eraseops_action', []);
            const blockers = shared.filter(dependency => dependency.target === `pg:${action.resource}:${customerId}`);
            failures.push(blockers.length ? `Deleting ${action.resource} would orphan records that belong to unrelated customers (${blockers.map(dependency => dependency.source.split(':').at(-1)).join(', ')}): ${error instanceof Error ? error.message : 'constraint violation'}` : `${action.resource}: ${error instanceof Error ? error.message : 'simulated action failed'}`);
          }
        }
        if (await this.othersChecksum(db, customerId) !== othersBefore) failures.push('Plan would modify records owned by other customers');
        const leftover = await this.residual(db, customerId);
        residualAfter = leftover.reduce((total, entry) => total + entry.records, 0);
        if (residualAfter) failures.push(`Plan leaves personal data behind: ${leftover.map(entry => `${entry.table} (${entry.records})`).join(', ')}`);
      }, false);
    } catch (error) { failures.push(`Simulation could not run: ${error instanceof Error ? error.message : 'unknown error'}`); }
    return {system: 'PostgreSQL', mode: 'transaction-rollback', affected, residualAfter, failures, warnings: [], checks: [`Ran ${pgActions.length} action${pgActions.length === 1 ? '' : 's'} inside a transaction that was rolled back (${affected} row${affected === 1 ? '' : 's'} changed)`, 'PostgreSQL enforced every foreign-key constraint', 'Records owned by other customers are untouched', 'Rescan inside the transaction finds no residual personal data']};
  }

  private async othersChecksum(db: SqlRunner, customerId: string) {
    const parts: string[] = [];
    for (const schema of POSTGRES_SCHEMA) {
      const owner = ownerColumnSql(schema.name, 't');
      if (!owner) continue;
      const result = await db.query<{digest: string | null}>(`SELECT md5(string_agg(to_jsonb(t)::text, '' ORDER BY t.id)) AS digest FROM ${schema.name} t WHERE ${owner} IS DISTINCT FROM $1`, [customerId]);
      parts.push(`${schema.name}:${result.rows[0]?.digest ?? ''}`);
    }
    return parts.join('|');
  }

  async executeForCustomer(customerId: string, action: DeletionAction, planHash: string, ctx: {approved: boolean; authoritativePlanHash: string}): Promise<ExecutionResult> { assertCustomerId(customerId); const startedAt = new Date().toISOString(); if (action.actionType === 'retain') return {actionId: action.id, status: 'skipped', startedAt, completedAt: new Date().toISOString(), affectedRecords: 0}; const result = action.actionType === 'delete' ? await this.deleteCustomerRecords(customerId, action.resource, ctx.approved, planHash, ctx.authoritativePlanHash) : await this.anonymizeCustomerRecords(customerId, ctx.approved, planHash, ctx.authoritativePlanHash, action.resource); return {actionId: action.id, status: 'completed', startedAt, completedAt: new Date().toISOString(), affectedRecords: 'deleted' in result ? result.deleted : result.anonymized}; }
  async verify(customerId: string) { assertCustomerId(customerId); const remaining = await this.residual(this.db, customerId); const total = remaining.reduce((sum, entry) => sum + entry.records, 0); return {system: 'PostgreSQL', remainingMatches: total, verified: total === 0, details: total ? `${total} record${total === 1 ? '' : 's'} remain in PostgreSQL: ${remaining.map(entry => `${entry.table} (${entry.records})`).join(', ')}` : 'No residual personal data in PostgreSQL'}; }
  async listCustomers() { return (await this.db.query<{id: string}>('SELECT id FROM customers ORDER BY id', [])).rows.map(row => row.id); }
  async profile(customerId: string) { assertCustomerId(customerId); const row = (await this.db.query<{name: string | null; email: string | null; region: string | null; created_at: string | null}>('SELECT name, email, region, created_at FROM customers WHERE id = $1', [customerId])).rows[0]; return row && {customerId, displayName: maskName(row.name), email: maskEmail(row.email), region: row.region ?? undefined, createdAt: row.created_at ? new Date(row.created_at).toISOString() : undefined}; }
  async inventory() { const result = await this.db.query<{table_name: string; records: number}>('SELECT table_name, SUM(record_count)::integer AS records FROM eraseops_customer_footprint GROUP BY table_name', []); const counts = new Map(result.rows.map(row => [row.table_name, Number(row.records)])); return POSTGRES_SCHEMA.map(schema => ({resource: schema.name, kind: 'table' as const, records: counts.get(schema.name) ?? 0})); }
}

export type ObjectClient = {list(bucket: string, prefix: string): Promise<string[]>; copy(source: string, target: string): Promise<void>; delete(key: string): Promise<void>; get?(bucket: string, key: string): Promise<string>; head?(bucket: string, key: string): Promise<Record<string, string>>; put?(bucket: string, key: string, body: string, metadata?: Record<string, string>): Promise<void>; createBucket?(bucket: string): Promise<void>};
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
  private sha(body: string) { return createHash('sha256').update(body).digest('hex'); }
  private requireReads() { if (!this.client.get) throw new Error('MinIO client cannot read objects, so backups cannot be checksummed'); return this.client.get.bind(this.client); }

  /** Copies each customer object into eraseops-backups/<request>/<bucket>/<key>, hashing the real content. */
  async backupCustomerObjects(customerId: string, requestId: string) {
    assertCustomerId(customerId);
    if (!/^[A-Za-z0-9-]+$/.test(requestId)) throw new Error('Backup request identifier is invalid');
    const read = this.requireReads();
    const resourceEvidence: BackupResourceEvidence[] = [];
    const failures: string[] = [];
    const artifacts: string[] = [];
    for (const bucket of this.sourceBuckets) {
      if (!this.allowedBuckets.includes(bucket)) continue;
      for (const key of await this.listKeys(bucket, this.prefixFor(bucket, customerId))) {
        const metadata = await this.client.head?.(bucket, key) ?? {};
        if (metadata['storage-tier']?.toUpperCase() === 'ARCHIVE') { failures.push(`${bucket}/${key} is in ARCHIVE storage and must be restored before it can be backed up`); continue; }
        const body = await read(bucket, key);
        const target = `${BACKUP_BUCKET}/${requestId}/${bucket}/${key}`;
        await this.client.copy(`${bucket}/${key}`, target);
        artifacts.push(target);
        resourceEvidence.push({resource: `minio:${bucket}/${key}`, kind: 'object', records: 1, checksum: this.sha(body)});
      }
    }
    return {backupId: `minio-backup-${requestId}`, checksum: this.sha(JSON.stringify({requestId, customerId, resourceEvidence})), resources: resourceEvidence.length, resourceEvidence, artifacts, failures};
  }
  async verifyBackupObjects(requestId: string, evidence: BackupResourceEvidence[]) {
    const expected = evidence.filter(item => item.kind === 'object');
    const read = this.requireReads();
    const mismatched: string[] = [];
    for (const item of expected) {
      const location = item.resource.replace(/^minio:/, '');
      this.assertSafeKey(location);
      try { if (this.sha(await read(BACKUP_BUCKET, `${requestId}/${location}`)) !== item.checksum) mismatched.push(item.resource); } catch { mismatched.push(item.resource); }
    }
    return {system: 'MinIO', verified: !mismatched.length, reason: mismatched.length ? `Backup copy missing or altered for ${mismatched.join(', ')}` : expected.length ? `Re-read ${expected.length} backup object${expected.length === 1 ? '' : 's'} and matched every checksum` : 'No objects to back up', checked: expected.length};
  }
  async restoreCustomerObjects(customerId: string, requestId: string) {
    assertCustomerId(customerId);
    let restored = 0;
    for (const bucket of this.sourceBuckets) {
      if (!this.allowedBuckets.includes(bucket)) continue;
      for (const key of await this.client.list(BACKUP_BUCKET, `${requestId}/${bucket}/${this.prefixFor(bucket, customerId)}`)) {
        this.assertSafeKey(key);
        await this.client.copy(`${BACKUP_BUCKET}/${key}`, `${bucket}/${key.slice(`${requestId}/${bucket}/`.length)}`);
        restored++;
      }
    }
    return {system: 'MinIO', restored, details: `Restored ${restored} object${restored === 1 ? '' : 's'} from the request backup`};
  }
  /** Object stores have no transactions: the simulation lists exactly what each delete would remove. */
  async simulateDeletes(customerId: string, actions: DeletionAction[]): Promise<SimulationReport> {
    assertCustomerId(customerId);
    const failures: string[] = [];
    let affected = 0;
    const planned = new Set(actions.filter(action => action.system === 'MinIO' && action.actionType === 'delete').map(action => action.resource));
    for (const action of actions.filter(item => item.system === 'MinIO')) {
      if (!this.allowedBuckets.includes(action.resource)) { failures.push(`${action.resource}: bucket is not allowlisted`); continue; }
      if (action.actionType === 'anonymize') { failures.push(`${action.resource}: objects cannot be anonymized in place`); continue; }
      const keys = await this.listKeys(action.resource, this.prefixFor(action.resource, customerId));
      const foreign = keys.filter(key => !key.startsWith(this.prefixFor(action.resource, customerId)));
      if (foreign.length) failures.push(`${action.resource}: ${foreign.length} listed objects are outside the customer prefix`);
      affected += keys.length;
    }
    let residualAfter = 0;
    for (const bucket of this.sourceBuckets) if (this.allowedBuckets.includes(bucket) && !planned.has(bucket)) residualAfter += (await this.client.list(bucket, this.prefixFor(bucket, customerId))).length;
    if (residualAfter) failures.push(`Plan leaves ${residualAfter} customer object${residualAfter === 1 ? '' : 's'} behind`);
    return {system: 'MinIO', mode: 'object-listing', affected, residualAfter, failures, warnings: [], checks: [`Listed ${affected} object${affected === 1 ? '' : 's'} the plan would delete`, 'Every listed key sits under the customer prefix', 'No customer bucket is left out of the plan']};
  }
  async listCustomerIds() { const ids = new Set<string>(); for (const bucket of this.sourceBuckets) if (this.allowedBuckets.includes(bucket)) for (const key of await this.client.list(bucket, '')) { const match = key.match(/^CUST-\d{4}/); if (match) ids.add(match[0]); } return [...ids].sort(); }
  async inventory() { return Promise.all([...this.sourceBuckets, BACKUP_BUCKET].filter(bucket => this.allowedBuckets.includes(bucket)).map(async bucket => ({resource: bucket, kind: 'bucket' as const, records: (await this.client.list(bucket, '')).length}))); }
  async verify(customerId: string) { assertCustomerId(customerId); let remainingMatches = 0; for (const bucket of this.sourceBuckets) { if (!this.allowedBuckets.includes(bucket)) continue; remainingMatches += (await this.client.list(bucket, this.prefixFor(bucket, customerId))).length; } return {system: 'MinIO', remainingMatches, verified: remainingMatches === 0, details: 'Allowlisted object rescan across customer buckets'}; }
}
