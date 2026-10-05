// Runs against `docker compose up -d`. Enable with: npm run test:integration
import {afterAll, beforeEach, describe, expect, it} from 'vitest';
import {Pool} from 'pg';
import {loadConfig} from '../../../apps/api/src/config.js';
import {MinioAdapter, PostgresAdapter} from './adapters.js';
import {loadDatasetFixture} from './dataset.js';
import {MinioLiveConnector, PostgresLiveConnector} from './live.js';
import {seedLocalSystems} from './local-seed.js';
import {MinioHttpObjectClient} from './s3-client.js';
import type {DeletionAction} from '../../../packages/shared/src/index.js';

const enabled = process.env.ERASEOPS_INTEGRATION === '1';
const config = loadConfig(process.env);
const pool = new Pool({connectionString: config.databaseUrl});
const objects = new MinioHttpObjectClient(config.minio);
const buckets = ['customer-uploads', 'support-attachments', 'exports', 'eraseops-backups'];
const postgres = new PostgresLiveConnector(new PostgresAdapter(pool, objects));
const minio = new MinioLiveConnector(new MinioAdapter(objects, buckets), buckets);
const ctx = {demoMode: true as const, allowlistedHosts: ['postgres'], allowlistedBuckets: buckets};
const hash = 'c'.repeat(64);
const act = (system: string, resource: string, actionType: DeletionAction['actionType']): DeletionAction => ({id: `${system}:${resource}`, system, resource, actionType, selector: 'customer_id = $1', reason: 'integration', recordCount: 0, reversible: false, risk: 'high', dependencies: [], verification: 'rescan'});

describe.skipIf(!enabled)('local PostgreSQL and MinIO connectors', () => {
  beforeEach(async () => { await seedLocalSystems(pool, objects, loadDatasetFixture()); });
  afterAll(async () => { await pool.end(); });

  it('lets PostgreSQL itself block a delete that would orphan other customers, without changing anything', async () => {
    const report = await postgres.simulate('CUST-9001', [act('PostgreSQL', 'organization_members', 'delete'), act('PostgreSQL', 'organizations', 'delete')]);
    expect(report.mode).toBe('transaction-rollback');
    expect(report.failures[0]).toContain('unrelated customers (CUST-9002, CUST-9003)');
    expect((await pool.query('SELECT count(*)::int AS n FROM organization_members')).rows[0].n).toBe(3);
  });

  it('erases, proves, and restores a customer against the real services', async () => {
    const backups = [await postgres.backupCustomerData('CUST-1042', 'it-1042'), await minio.backupCustomerData('CUST-1042', 'it-1042')];
    const evidence = backups.flatMap(backup => backup.resourceEvidence ?? []);
    expect((await postgres.verifyBackup('CUST-1042', 'it-1042', evidence)).verified).toBe(true);
    expect((await minio.verifyBackup('CUST-1042', 'it-1042', evidence)).verified).toBe(true);
    const run = {approved: true, customerId: 'CUST-1042', authoritativePlanHash: hash};
    for (const table of ['users', 'addresses', 'analytics_events', 'marketing_profiles']) await postgres.execute(act('PostgreSQL', table, 'delete'), hash, run);
    for (const table of ['customers', 'support_tickets', 'support_messages']) await postgres.execute(act('PostgreSQL', table, 'anonymize'), hash, run);
    for (const bucket of ['customer-uploads', 'support-attachments', 'exports']) await minio.execute(act('MinIO', bucket, 'delete'), hash, run);
    expect(await postgres.verify('CUST-1042')).toMatchObject({verified: true, remainingMatches: 0});
    expect(await minio.verify('CUST-1042')).toMatchObject({verified: true, remainingMatches: 0});
    expect((await pool.query("SELECT name FROM customers WHERE id = 'CUST-1042'")).rows[0].name).toBe('[redacted]');

    await postgres.restoreCustomerData('CUST-1042', 'it-1042');
    await minio.restoreCustomerData('CUST-1042', 'it-1042');
    expect((await pool.query("SELECT name FROM customers WHERE id = 'CUST-1042'")).rows[0].name).toBe('Mira Kulkarni');
    expect((await postgres.verify('CUST-1042')).remainingMatches).toBe(8);
    expect((await minio.discoverCustomerData('CUST-1042', ctx)).map(asset => asset.count)).toEqual([2, 1, 1]);
  });
});
