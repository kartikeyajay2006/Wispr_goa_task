import {createHash} from 'node:crypto';
import type {Asset, DataSystem, DeletionAction, Dependency, ExecutionResult, SimulationReport, VerificationResult} from '../../../packages/shared/src/index.js';
import {ruleFor} from '../../../packages/policy-engine/src/retention-policy.js';
import {DemoDataset, isRedacted, seededDataset, type Row} from './dataset.js';
import {maskEmail, maskName} from './masking.js';
import {BACKUP_BUCKET, POSTGRES_SCHEMA, SOURCE_BUCKETS, tableSchema} from './schema.js';

export {DemoDataset, seededDataset, loadDatasetFixture, DEFAULT_DATASET_FILE} from './dataset.js';
export type ConnectorContext = {demoMode: true; allowlistedHosts: string[]; allowlistedBuckets: string[]};
export type BackupResourceEvidence = {resource:string;kind:'database'|'object';records:number;checksum:string};
export type BackupResult = {backupId: string; checksum: string; resources: number; resourceEvidence?: BackupResourceEvidence[]; artifacts?: string[]; failures?: string[]};
export type BackupVerification = {system: string; verified: boolean; reason: string; checked: number};
export type RestoreResult = {system: string; restored: number; details: string};
export type ConnectorExecutionContext = {approved: boolean; customerId?: string; authoritativePlanHash?: string};
export type InventoryEntry = {resource: string; kind: 'table' | 'bucket'; records: number; bytes?: number};
export type CustomerProfile = {customerId: string; displayName?: string; email?: string; region?: string; createdAt?: string};
export interface Connector {
  readonly system: DataSystem;
  discoverCustomerData(customerId: string, ctx: ConnectorContext): Promise<Asset[]>;
  inspectDependencies?(customerId: string): Promise<Dependency[]>;
  previewAction(action: DeletionAction, customerId?: string): Promise<{safe: boolean; affected: number; reason: string}>;
  backupCustomerData(customerId: string, requestId: string): Promise<BackupResult>;
  verifyBackup?(customerId: string, requestId: string, evidence: BackupResourceEvidence[]): Promise<BackupVerification>;
  restoreCustomerData?(customerId: string, requestId: string): Promise<RestoreResult>;
  simulate?(customerId: string, actions: DeletionAction[]): Promise<SimulationReport>;
  execute(action: DeletionAction, planHash: string, ctx: ConnectorExecutionContext): Promise<ExecutionResult>;
  verify(customerId: string): Promise<VerificationResult>;
  listCustomers?(): Promise<string[]>;
  profile?(customerId: string): Promise<CustomerProfile | undefined>;
  inventory?(): Promise<InventoryEntry[]>;
}

const assertDemo = (ctx: ConnectorContext) => { if (!ctx.demoMode) throw new Error('Production credentials are disabled in demo connector'); };
export const assertCustomerId = (customerId: string) => { if (!/^CUST-\d{4}$/.test(customerId)) throw new Error(`Invalid customer ID: ${customerId}`); return customerId; };
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

function assertExecutable(action: DeletionAction, planHash: string, ctx: ConnectorExecutionContext) {
  if (!ctx.approved) throw new Error('Human approval required');
  if (ctx.authoritativePlanHash && ctx.authoritativePlanHash !== planHash) throw new Error('Plan hash mismatch');
  if (!ctx.customerId) throw new Error(`Customer identity required to execute ${action.id}`);
  return assertCustomerId(ctx.customerId);
}

/** Records the policy says must be gone (deletable) or scrubbed (anonymize) but are still present. */
function residualRows(dataset: DemoDataset, customerId: string) {
  const remaining: Array<{table: string; records: number}> = [];
  for (const schema of POSTGRES_SCHEMA) {
    const rule = ruleFor('PostgreSQL', schema.name);
    const rows = dataset.ownedRows(schema.name, customerId);
    const records = rule.classification === 'deletable' ? rows.length : rule.classification === 'anonymize' ? rows.filter(row => schema.piiColumns.some(column => !isRedacted(row[column]))).length : 0;
    if (records) remaining.push({table: schema.name, records});
  }
  return remaining;
}
const residualObjects = (dataset: DemoDataset, customerId: string) => SOURCE_BUCKETS.map(bucket => ({table: bucket, records: dataset.ownedObjects(bucket, customerId).length})).filter(entry => entry.records);
const describeResidual = (entries: Array<{table: string; records: number}>, system: string) => entries.length ? `${plural(entries.reduce((total, entry) => total + entry.records, 0), 'record')} remain in ${system}: ${entries.map(entry => `${entry.table} (${entry.records})`).join(', ')}` : `No residual personal data in ${system}`;

/** Applies a plan to a throwaway copy and proves it is safe before anything real is touched. */
function simulateOnCopy(source: DemoDataset, system: 'PostgreSQL' | 'MinIO', customerId: string, actions: DeletionAction[], apply: (copy: DemoDataset, action: DeletionAction) => number, residual: (copy: DemoDataset) => Array<{table: string; records: number}>): SimulationReport {
  const copy = source.clone();
  const others = copy.fingerprintOthers(customerId);
  const integrityBefore = new Set(copy.integrityViolations().map(item => `${item.table}/${item.rowId}/${item.column}`));
  const failures: string[] = [];
  const warnings: string[] = [];
  let affected = 0;
  for (const action of actions.filter(item => item.system === system)) {
    try { affected += apply(copy, action); } catch (error) { failures.push(`${action.resource}: ${error instanceof Error ? error.message : 'simulated action failed'}`); }
  }
  const newViolations = copy.integrityViolations().filter(item => !integrityBefore.has(`${item.table}/${item.rowId}/${item.column}`));
  const byParent = new Map<string, typeof newViolations>();
  for (const violation of newViolations) byParent.set(`${violation.references} ${violation.missingId}`, [...(byParent.get(`${violation.references} ${violation.missingId}`) ?? []), violation]);
  for (const [parent, violations] of byParent) {
    const foreign = [...new Set(violations.map(item => item.owner).filter(owner => owner !== customerId))];
    const tables = [...new Set(violations.map(item => item.table))].join(', ');
    if (foreign.length) failures.push(`Deleting ${parent} would orphan ${plural(violations.length, 'record')} in ${tables} that belong to unrelated customers (${foreign.map(owner => owner ?? 'unowned').join(', ')})`);
    else failures.push(`Deleting ${parent} would leave ${plural(violations.length, 'retained record')} in ${tables} pointing at a missing row`);
  }
  const changed = copy.changedSince(others);
  if (changed.length) failures.push(`Plan would modify ${plural(changed.length, 'record')} owned by other customers (${changed.slice(0, 3).join(', ')}${changed.length > 3 ? ', …' : ''})`);
  const leftover = residual(copy);
  const residualAfter = leftover.reduce((total, entry) => total + entry.records, 0);
  if (residualAfter) failures.push(`Plan leaves personal data behind: ${describeResidual(leftover, system)}`);
  if (!affected && actions.some(item => item.system === system && item.actionType !== 'retain')) warnings.push(`No ${system} records changed in the simulation`);
  return {
    system, mode: 'dataset-clone', affected, residualAfter, failures, warnings,
    checks: [`Applied ${plural(actions.filter(item => item.system === system).length, 'action')} to an isolated copy (${plural(affected, 'record')} changed)`, 'Referential integrity holds after the plan', 'Records owned by other customers are untouched', 'Rescan of the copy finds no residual personal data'],
  };
}

export class MockPostgresConnector implements Connector {
  readonly system: DataSystem = {id: 'postgres-demo', name: 'PostgreSQL', type: 'postgresql', connectionStatus: 'mock', capabilities: ['discover', 'dependencies', 'preview', 'backup', 'simulate', 'execute', 'verify']};
  constructor(readonly dataset: DemoDataset = seededDataset()) {}

  async discoverCustomerData(customerId: string, ctx: ConnectorContext): Promise<Asset[]> {
    assertDemo(ctx); assertCustomerId(customerId);
    if (!ctx.allowlistedHosts.includes('postgres')) throw new Error('PostgreSQL host is not allowlisted');
    return POSTGRES_SCHEMA.flatMap(schema => {
      const rows = this.dataset.ownedRows(schema.name, customerId);
      if (!rows.length) return [];
      const rule = ruleFor('PostgreSQL', schema.name);
      const ownershipColumn = schema.ownership.kind === 'self' ? 'id' : schema.ownership.column;
      return [{id: `pg:${schema.name}:${customerId}`, system: 'PostgreSQL', table: schema.name, label: rule.label, classification: rule.classification, basis: rule.basis, fields: schema.piiColumns.length ? [...schema.piiColumns] : [ownershipColumn], dependencyIds: schema.foreignKeys.filter(fk => this.dataset.ownedRows(fk.references, customerId).length).map(fk => `pg:${fk.references}:${customerId}`), risk: rule.risk, count: rows.length, recordIds: rows.map(row => row.id)}];
    });
  }

  async inspectDependencies(customerId: string): Promise<Dependency[]> {
    assertCustomerId(customerId);
    const dependencies: Dependency[] = [];
    for (const schema of POSTGRES_SCHEMA) {
      for (const fk of schema.foreignKeys) {
        const parents = new Set(this.dataset.ownedRows(fk.references, customerId).map(row => row.id));
        if (!parents.size) continue;
        const byOwner = new Map<string, Row[]>();
        for (const row of this.dataset.rows(schema.name)) if (parents.has(String(row[fk.column]))) { const owner = this.dataset.ownerOf(schema.name, row) ?? 'unowned'; byOwner.set(owner, [...(byOwner.get(owner) ?? []), row]); }
        for (const [owner, rows] of byOwner) {
          dependencies.push(owner === customerId
            ? {source: `pg:${schema.name}:${customerId}`, target: `pg:${fk.references}:${customerId}`, relationshipType: `${schema.name}.${fk.column} references ${fk.references}`, constraintType: 'foreign_key', required: true, risk: ruleFor('PostgreSQL', schema.name).risk}
            : {source: `pg:${schema.name}:${owner}`, target: `pg:${fk.references}:${customerId}`, relationshipType: `${plural(rows.length, `${schema.name} row`)} owned by ${owner} reference this customer's ${fk.references}`, constraintType: 'business', required: true, risk: 'high'});
        }
      }
      const rule = ruleFor('PostgreSQL', schema.name);
      if (rule.classification === 'retain' && this.dataset.ownedRows(schema.name, customerId).length) dependencies.push({source: `pg:${schema.name}:${customerId}`, target: `policy:${schema.name}`, relationshipType: rule.retention ? `${rule.basis} (${rule.retention})` : rule.basis, constraintType: 'retention', required: true, risk: 'low'});
    }
    return dependencies;
  }

  async previewAction(action: DeletionAction, customerId?: string) {
    const schema = tableSchema(action.resource);
    if (!schema) return {safe: false, affected: 0, reason: `${action.resource} is not a known table`};
    const rule = ruleFor('PostgreSQL', action.resource);
    const affected = customerId ? this.dataset.ownedRows(action.resource, customerId).length : action.recordCount;
    if (action.actionType === 'delete') return {safe: rule.classification === 'deletable', affected, reason: rule.classification === 'deletable' ? `Deletes ${plural(affected, 'row')} by customer ownership` : `Policy classifies ${action.resource} as ${rule.classification}; deletion refused`};
    if (action.actionType === 'anonymize') return {safe: schema.piiColumns.length > 0, affected, reason: schema.piiColumns.length ? `Redacts ${schema.piiColumns.join(', ')}` : `${action.resource} has no personal-data columns to redact`};
    return {safe: true, affected: 0, reason: 'Retained under policy; no mutation'};
  }

  private apply(dataset: DemoDataset, action: DeletionAction, customerId: string) {
    const schema = tableSchema(action.resource);
    if (!schema) throw new Error('PostgreSQL table is not allowlisted');
    const rule = ruleFor('PostgreSQL', action.resource);
    if (action.actionType === 'delete') { if (rule.classification !== 'deletable') throw new Error(`Policy does not allow deleting ${action.resource}`); return dataset.deleteOwnedRows(action.resource, customerId); }
    if (action.actionType === 'anonymize') { if (!schema.piiColumns.length) throw new Error(`${action.resource} has no personal-data columns`); return dataset.redactOwnedRows(action.resource, customerId, schema.piiColumns); }
    return 0;
  }

  async simulate(customerId: string, actions: DeletionAction[]) { assertCustomerId(customerId); return simulateOnCopy(this.dataset, 'PostgreSQL', customerId, actions, (copy, action) => this.apply(copy, action, customerId), copy => residualRows(copy, customerId)); }

  async backupCustomerData(customerId: string, requestId: string): Promise<BackupResult> {
    assertCustomerId(customerId);
    const snapshots = POSTGRES_SCHEMA.map(schema => ({resource: `pg:${schema.name}:${customerId}`, table: schema.name, rows: this.dataset.ownedRows(schema.name, customerId)})).filter(snapshot => snapshot.rows.length);
    const resourceEvidence = snapshots.map(snapshot => ({resource: snapshot.resource, kind: 'database' as const, records: snapshot.rows.length, checksum: sha256(JSON.stringify(snapshot.rows))}));
    const key = `${requestId}/database.json`;
    this.dataset.putObject(BACKUP_BUCKET, {key, customerId, contentType: 'application/json', storageClass: 'STANDARD', lastModified: now(), body: JSON.stringify({requestId, customerId, snapshots})});
    return {backupId: `postgres-backup-${requestId}`, checksum: sha256(JSON.stringify({requestId, customerId, resourceEvidence})), resources: resourceEvidence.reduce((total, item) => total + item.records, 0), resourceEvidence, artifacts: [`${BACKUP_BUCKET}/${key}`], failures: []};
  }

  /** Reads the stored artifact back and recomputes every checksum instead of trusting the manifest. */
  async verifyBackup(customerId: string, requestId: string, evidence: BackupResourceEvidence[]): Promise<BackupVerification> {
    const expected = evidence.filter(item => item.kind === 'database');
    const artifact = this.dataset.getObject(BACKUP_BUCKET, `${requestId}/database.json`);
    if (!artifact) return {system: 'PostgreSQL', verified: !expected.length, reason: expected.length ? 'Database backup artifact is missing' : 'No database records to back up', checked: 0};
    const stored = JSON.parse(artifact.body) as {customerId: string; snapshots: Array<{resource: string; rows: Row[]}>};
    if (stored.customerId !== customerId) return {system: 'PostgreSQL', verified: false, reason: 'Backup artifact belongs to a different customer', checked: 0};
    const mismatched = expected.filter(item => { const snapshot = stored.snapshots.find(entry => entry.resource === item.resource); return !snapshot || sha256(JSON.stringify(snapshot.rows)) !== item.checksum || snapshot.rows.length !== item.records; });
    return {system: 'PostgreSQL', verified: !mismatched.length, reason: mismatched.length ? `Checksum mismatch for ${mismatched.map(item => item.resource).join(', ')}` : `Re-read ${plural(expected.length, 'table snapshot')} and matched every checksum`, checked: expected.length};
  }

  async restoreCustomerData(customerId: string, requestId: string): Promise<RestoreResult> {
    const artifact = this.dataset.getObject(BACKUP_BUCKET, `${requestId}/database.json`);
    if (!artifact) throw new Error(`No database backup exists for request ${requestId}`);
    const stored = JSON.parse(artifact.body) as {customerId: string; snapshots: Array<{table: string; rows: Row[]}>};
    if (stored.customerId !== customerId) throw new Error('Backup artifact belongs to a different customer');
    let restored = 0;
    for (const snapshot of stored.snapshots) restored += this.dataset.upsertRows(snapshot.table, snapshot.rows);
    return {system: 'PostgreSQL', restored, details: `Restored ${plural(restored, 'row')} across ${plural(stored.snapshots.length, 'table')}`};
  }

  async execute(action: DeletionAction, planHash: string, ctx: ConnectorExecutionContext): Promise<ExecutionResult> {
    const customerId = assertExecutable(action, planHash, ctx);
    const startedAt = now();
    if (action.actionType === 'retain') return {actionId: action.id, status: 'skipped', startedAt, completedAt: now(), affectedRecords: 0};
    return {actionId: action.id, status: 'completed', startedAt, completedAt: now(), affectedRecords: this.apply(this.dataset, action, customerId)};
  }

  async verify(customerId: string): Promise<VerificationResult> {
    const remaining = residualRows(this.dataset, assertCustomerId(customerId));
    const total = remaining.reduce((sum, entry) => sum + entry.records, 0);
    return {system: this.system.name, remainingMatches: total, verified: total === 0, details: describeResidual(remaining, 'PostgreSQL')};
  }

  async listCustomers() { return this.dataset.rows('customers').map(row => row.id).sort(); }
  async profile(customerId: string): Promise<CustomerProfile | undefined> { const row = this.dataset.findRow('customers', customerId); return row && {customerId, displayName: maskName(row.name), email: maskEmail(row.email), region: typeof row.region === 'string' ? row.region : undefined, createdAt: typeof row.created_at === 'string' ? row.created_at : undefined}; }
  async inventory(): Promise<InventoryEntry[]> { return POSTGRES_SCHEMA.map(schema => ({resource: schema.name, kind: 'table' as const, records: this.dataset.rows(schema.name).length})); }
}

export class MockMinioConnector implements Connector {
  readonly system: DataSystem = {id: 'minio-demo', name: 'MinIO', type: 'minio', connectionStatus: 'mock', capabilities: ['discover', 'preview', 'backup', 'simulate', 'execute', 'verify']};
  constructor(readonly dataset: DemoDataset = seededDataset()) {}
  async inspectDependencies(customerId: string) { assertCustomerId(customerId); return [] as Dependency[]; }

  async discoverCustomerData(customerId: string, ctx: ConnectorContext): Promise<Asset[]> {
    assertDemo(ctx); assertCustomerId(customerId);
    return SOURCE_BUCKETS.filter(bucket => ctx.allowlistedBuckets.includes(bucket)).flatMap(bucket => {
      const objects = this.dataset.ownedObjects(bucket, customerId);
      if (!objects.length) return [];
      const rule = ruleFor('MinIO', bucket);
      return [{id: `minio:${bucket}:${customerId}`, system: 'MinIO', table: bucket, label: rule.label, classification: rule.classification, basis: rule.basis, fields: ['object_key', 'metadata'], dependencyIds: [], risk: rule.risk, count: objects.length, recordIds: objects.map(object => object.key)}];
    });
  }

  async previewAction(action: DeletionAction, customerId?: string) {
    const known = (SOURCE_BUCKETS as readonly string[]).includes(action.resource);
    const affected = customerId && known ? this.dataset.ownedObjects(action.resource, customerId).length : action.recordCount;
    return {safe: known && action.actionType !== 'anonymize', affected, reason: known ? `Deletes ${plural(affected, 'object')} owned by the customer` : `${action.resource} is not a customer bucket`};
  }

  private apply(dataset: DemoDataset, action: DeletionAction, customerId: string) {
    if (!(SOURCE_BUCKETS as readonly string[]).includes(action.resource)) throw new Error('MinIO bucket is not allowlisted');
    if (action.actionType === 'anonymize') throw new Error('Objects cannot be anonymized in place');
    return action.actionType === 'delete' ? dataset.deleteOwnedObjects(action.resource, customerId) : 0;
  }

  async simulate(customerId: string, actions: DeletionAction[]) { assertCustomerId(customerId); return simulateOnCopy(this.dataset, 'MinIO', customerId, actions, (copy, action) => this.apply(copy, action, customerId), copy => residualObjects(copy, customerId)); }

  async backupCustomerData(customerId: string, requestId: string): Promise<BackupResult> {
    assertCustomerId(customerId);
    const resourceEvidence: BackupResourceEvidence[] = [];
    const failures: string[] = [];
    const artifacts: string[] = [];
    for (const bucket of SOURCE_BUCKETS) for (const object of this.dataset.ownedObjects(bucket, customerId)) {
      if (object.storageClass === 'ARCHIVE') { failures.push(`${bucket}/${object.key} is in ARCHIVE storage and must be restored before it can be backed up`); continue; }
      const key = `${requestId}/${bucket}/${object.key}`;
      this.dataset.putObject(BACKUP_BUCKET, {...object, key, lastModified: now()});
      artifacts.push(`${BACKUP_BUCKET}/${key}`);
      resourceEvidence.push({resource: `minio:${bucket}/${object.key}`, kind: 'object', records: 1, checksum: sha256(object.body)});
    }
    return {backupId: `minio-backup-${requestId}`, checksum: sha256(JSON.stringify({requestId, customerId, resourceEvidence})), resources: resourceEvidence.length, resourceEvidence, artifacts, failures};
  }

  async verifyBackup(_customerId: string, requestId: string, evidence: BackupResourceEvidence[]): Promise<BackupVerification> {
    const expected = evidence.filter(item => item.kind === 'object');
    const mismatched = expected.filter(item => { const [bucket, ...key] = item.resource.replace(/^minio:/, '').split('/'); const copy = this.dataset.getObject(BACKUP_BUCKET, `${requestId}/${bucket}/${key.join('/')}`); return !copy || sha256(copy.body) !== item.checksum; });
    return {system: 'MinIO', verified: !mismatched.length, reason: mismatched.length ? `Backup copy missing or altered for ${mismatched.map(item => item.resource).join(', ')}` : expected.length ? `Re-read ${plural(expected.length, 'backup object')} and matched every checksum` : 'No objects to back up', checked: expected.length};
  }

  async restoreCustomerData(customerId: string, requestId: string): Promise<RestoreResult> {
    const prefix = `${requestId}/`;
    let restored = 0;
    for (const copy of this.dataset.objects(BACKUP_BUCKET).filter(object => object.key.startsWith(prefix) && object.customerId === customerId)) {
      const [bucket, ...key] = copy.key.slice(prefix.length).split('/');
      if (!(SOURCE_BUCKETS as readonly string[]).includes(bucket)) continue;
      this.dataset.putObject(bucket, {...copy, key: key.join('/')});
      restored++;
    }
    return {system: 'MinIO', restored, details: `Restored ${plural(restored, 'object')} from the request backup`};
  }

  async execute(action: DeletionAction, planHash: string, ctx: ConnectorExecutionContext): Promise<ExecutionResult> {
    const customerId = assertExecutable(action, planHash, ctx);
    const startedAt = now();
    if (action.actionType === 'retain') return {actionId: action.id, status: 'skipped', startedAt, completedAt: now(), affectedRecords: 0};
    return {actionId: action.id, status: 'completed', startedAt, completedAt: now(), affectedRecords: this.apply(this.dataset, action, customerId)};
  }

  async verify(customerId: string): Promise<VerificationResult> {
    const remaining = residualObjects(this.dataset, assertCustomerId(customerId));
    const total = remaining.reduce((sum, entry) => sum + entry.records, 0);
    return {system: this.system.name, remainingMatches: total, verified: total === 0, details: describeResidual(remaining, 'MinIO')};
  }

  async listCustomers() { return [...new Set(SOURCE_BUCKETS.flatMap(bucket => this.dataset.objects(bucket).map(object => object.customerId)))].sort(); }
  async inventory(): Promise<InventoryEntry[]> { return [...SOURCE_BUCKETS, BACKUP_BUCKET].map(bucket => ({resource: bucket, kind: 'bucket' as const, records: this.dataset.objects(bucket).length, bytes: this.dataset.objects(bucket).reduce((total, object) => total + Buffer.byteLength(object.body), 0)})); }
}

/** Both mock connectors over one dataset, so a deletion in one is visible to every later scan. */
export const createMockConnectors = (dataset: DemoDataset = seededDataset()) => ({dataset, postgres: new MockPostgresConnector(dataset), minio: new MockMinioConnector(dataset)});
