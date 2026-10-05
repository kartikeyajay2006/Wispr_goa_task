import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {POSTGRES_SCHEMA, REDACTED, SOURCE_BUCKETS, tableSchema} from './schema.js';

export type Row = {id: string; [column: string]: unknown};
export type StoredObject = {key: string; customerId: string; contentType: string; storageClass: 'STANDARD' | 'ARCHIVE'; lastModified: string; body: string};
export type DatasetFixture = {version: number; description?: string; tables: Record<string, Row[]>; objects: Record<string, StoredObject[]>};
export type Fingerprint = {kind: 'row' | 'object'; container: string; id: string; digest: string};
export type IntegrityViolation = {table: string; rowId: string; column: string; references: string; missingId: string; owner?: string};

export const DEFAULT_DATASET_FILE = fileURLToPath(new URL('../../../infra/fixtures/demo-dataset.json', import.meta.url));
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
export const isRedacted = (value: unknown) => value === null || value === undefined || value === REDACTED || (typeof value === 'object' && Object.keys(value as object).length === 0);
const redact = (value: unknown) => typeof value === 'object' && value !== null ? {} : REDACTED;

export function loadDatasetFixture(path = DEFAULT_DATASET_FILE): DatasetFixture {
  const fixture = JSON.parse(readFileSync(path, 'utf8')) as DatasetFixture;
  if (!fixture || typeof fixture.tables !== 'object' || typeof fixture.objects !== 'object') throw new Error(`Dataset fixture at ${path} must contain "tables" and "objects"`);
  return fixture;
}

/**
 * An in-memory stand-in for the PostgreSQL and MinIO systems. Mock connectors read and
 * mutate it, so discovery, deletion, backup and rescans all observe the same real state.
 */
export class DemoDataset {
  private tables = new Map<string, Row[]>();
  private buckets = new Map<string, StoredObject[]>();
  private readonly seed: DatasetFixture;

  constructor(seed: DatasetFixture) { this.seed = structuredClone(seed); this.reset(); }
  static fromFile(path?: string) { return new DemoDataset(loadDatasetFixture(path)); }

  reset() {
    this.tables = new Map(Object.entries(structuredClone(this.seed.tables)));
    this.buckets = new Map(Object.entries(structuredClone(this.seed.objects)));
  }
  clone() { return new DemoDataset(this.snapshot()); }
  snapshot(): DatasetFixture { return {version: this.seed.version, description: this.seed.description, tables: Object.fromEntries(structuredClone([...this.tables])), objects: Object.fromEntries(structuredClone([...this.buckets]))}; }

  tableNames() { return [...this.tables.keys()]; }
  bucketNames() { return [...this.buckets.keys()]; }
  rows(table: string): readonly Row[] { return this.tables.get(table) ?? []; }
  objects(bucket: string): readonly StoredObject[] { return this.buckets.get(bucket) ?? []; }
  findRow(table: string, id: string) { return this.rows(table).find(row => row.id === id); }
  getObject(bucket: string, key: string) { return this.objects(bucket).find(object => object.key === key); }

  ownerOf(table: string, row: Row, depth = 0): string | undefined {
    const schema = tableSchema(table);
    if (!schema || depth > 4) return undefined;
    if (schema.ownership.kind === 'self') return row.id;
    const value = row[schema.ownership.column];
    if (typeof value !== 'string') return undefined;
    if (schema.ownership.kind === 'column') return value;
    const parent = this.findRow(schema.ownership.table, value);
    return parent ? this.ownerOf(schema.ownership.table, parent, depth + 1) : undefined;
  }
  ownedRows(table: string, customerId: string) { return this.rows(table).filter(row => this.ownerOf(table, row) === customerId); }
  ownedObjects(bucket: string, customerId: string) { return this.objects(bucket).filter(object => object.customerId === customerId); }

  customerIds() {
    const ids = new Set<string>();
    for (const schema of POSTGRES_SCHEMA) for (const row of this.rows(schema.name)) { const owner = this.ownerOf(schema.name, row); if (owner) ids.add(owner); }
    for (const bucket of SOURCE_BUCKETS) for (const object of this.objects(bucket)) ids.add(object.customerId);
    return [...ids].sort();
  }

  deleteOwnedRows(table: string, customerId: string) {
    const owned = new Set(this.ownedRows(table, customerId).map(row => row.id));
    this.tables.set(table, this.rows(table).filter(row => !owned.has(row.id)));
    return owned.size;
  }
  redactOwnedRows(table: string, customerId: string, columns: readonly string[]) {
    let changed = 0;
    for (const row of this.ownedRows(table, customerId)) {
      if (columns.every(column => isRedacted(row[column]))) continue;
      for (const column of columns) row[column] = redact(row[column]);
      changed++;
    }
    return changed;
  }
  insertRows(table: string, rows: Row[]) {
    const existing = this.rows(table);
    const ids = new Set(existing.map(row => row.id));
    const restored = rows.filter(row => !ids.has(row.id));
    this.tables.set(table, [...existing, ...structuredClone(restored)]);
    return restored.length;
  }
  deleteOwnedObjects(bucket: string, customerId: string) {
    const before = this.objects(bucket).length;
    this.buckets.set(bucket, this.objects(bucket).filter(object => object.customerId !== customerId));
    return before - this.objects(bucket).length;
  }
  putObject(bucket: string, object: StoredObject) {
    this.buckets.set(bucket, [...this.objects(bucket).filter(item => item.key !== object.key), structuredClone(object)]);
  }

  /** Every foreign-key value that points at a row which no longer exists. */
  integrityViolations(): IntegrityViolation[] {
    const violations: IntegrityViolation[] = [];
    for (const schema of POSTGRES_SCHEMA) for (const fk of schema.foreignKeys) {
      const parents = new Set(this.rows(fk.references).map(row => row.id));
      for (const row of this.rows(schema.name)) {
        const value = row[fk.column];
        if (typeof value === 'string' && !parents.has(value)) violations.push({table: schema.name, rowId: row.id, column: fk.column, references: fk.references, missingId: value, owner: this.ownerOf(schema.name, row)});
      }
    }
    return violations;
  }

  /** Content hashes of every record and object that does not belong to the customer. */
  fingerprintOthers(customerId: string): Fingerprint[] {
    const prints: Fingerprint[] = [];
    for (const schema of POSTGRES_SCHEMA) for (const row of this.rows(schema.name)) if (this.ownerOf(schema.name, row) !== customerId) prints.push({kind: 'row', container: schema.name, id: row.id, digest: sha256(JSON.stringify(row))});
    for (const bucket of SOURCE_BUCKETS) for (const object of this.objects(bucket)) if (object.customerId !== customerId) prints.push({kind: 'object', container: bucket, id: object.key, digest: sha256(object.body)});
    return prints;
  }
  /** Re-reads the same locations in this dataset and returns those that were removed or modified. */
  changedSince(prints: readonly Fingerprint[]) {
    return prints.filter(print => {
      const row = print.kind === 'row' ? this.findRow(print.container, print.id) : undefined;
      const object = print.kind === 'object' ? this.getObject(print.container, print.id) : undefined;
      const digest = row ? sha256(JSON.stringify(row)) : object ? sha256(object.body) : undefined;
      return digest !== print.digest;
    }).map(print => `${print.container}/${print.id}`);
  }
}

let shared: DemoDataset | undefined;
/** The default dataset, loaded once from `infra/fixtures/demo-dataset.json` (or the given file). */
export function seededDataset(path?: string) {
  if (path) return DemoDataset.fromFile(path);
  shared ??= DemoDataset.fromFile();
  return shared.clone();
}
