import type {DatasetFixture} from './dataset.js';
import type {QueryExecutor} from './adapters.js';
import type {MinioHttpObjectClient} from './s3-client.js';
import {BACKUP_BUCKET, SOURCE_BUCKETS, parentFirstOrder, tableSchema} from './schema.js';

type ObjectStore = Pick<MinioHttpObjectClient, 'createBucket' | 'list' | 'delete' | 'put'>;

/**
 * Loads the demo fixture into the local PostgreSQL and MinIO services, replacing whatever
 * the previous demo run left behind. Only fixture tables and the allowlisted buckets are touched.
 */
export async function seedLocalSystems(db: QueryExecutor, objects: ObjectStore, fixture: DatasetFixture) {
  if (!db.connect) throw new Error('Seeding needs a pooled PostgreSQL connection');
  const order = parentFirstOrder().filter(table => fixture.tables[table]);
  const client = await db.connect();
  let rows = 0;
  try {
    await client.query('BEGIN', []);
    for (const table of [...order].reverse()) await client.query(`DELETE FROM ${table}`, []);
    for (const table of order) {
      const records = fixture.tables[table];
      if (!tableSchema(table) || !records.length) continue;
      const columns = [...new Set(records.flatMap(record => Object.keys(record)))].filter(column => /^[a-z_]+$/.test(column));
      await client.query(`INSERT INTO ${table} (${columns.join(', ')}) SELECT ${columns.join(', ')} FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb)`, [JSON.stringify(records)]);
      rows += records.length;
    }
    await client.query('COMMIT', []);
  } catch (error) {
    await client.query('ROLLBACK', []);
    throw error;
  } finally { client.release(); }

  let uploaded = 0;
  for (const bucket of [...SOURCE_BUCKETS, BACKUP_BUCKET]) {
    await objects.createBucket(bucket);
    for (const key of await objects.list(bucket, '')) await objects.delete(`${bucket}/${key}`);
    for (const object of fixture.objects[bucket] ?? []) {
      await objects.put(bucket, object.key, object.body, {'customer-id': object.customerId, 'storage-tier': object.storageClass});
      uploaded++;
    }
  }
  return {rows, objects: uploaded};
}
