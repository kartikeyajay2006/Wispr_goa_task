import {describe, expect, it} from 'vitest';
import {createMockConnectors, DemoDataset, loadDatasetFixture} from './index.js';
import type {DeletionAction} from '../../../packages/shared/src/index.js';

const ctx = {demoMode: true as const, allowlistedHosts: ['postgres'], allowlistedBuckets: ['customer-uploads', 'support-attachments', 'exports']};
const action = (system: string, resource: string, actionType: DeletionAction['actionType']): DeletionAction => ({id: `${system}:${resource}`, system, resource, actionType, selector: 'customer_id = $1', reason: 'test', recordCount: 0, reversible: actionType !== 'delete', risk: 'high', dependencies: [], verification: 'rescan'});
const execCtx = (customerId: string) => ({approved: true, customerId, authoritativePlanHash: 'a'.repeat(64)});

describe('stateful demo dataset', () => {
  it('loads every customer from the fixture rather than a hardcoded list', async () => {
    const {postgres, minio} = createMockConnectors();
    const fixtureIds = loadDatasetFixture().tables.customers.map(row => row.id).sort();
    expect(await postgres.listCustomers()).toEqual(fixtureIds);
    expect(fixtureIds.length).toBeGreaterThanOrEqual(8);
    expect(await minio.listCustomers()).toContain('CUST-1042');
  });

  it('discovers footprints from rows and objects, with record identifiers as evidence', async () => {
    const {postgres, minio} = createMockConnectors();
    const pg = await postgres.discoverCustomerData('CUST-1042', ctx);
    const objects = await minio.discoverCustomerData('CUST-1042', ctx);
    expect(pg).toHaveLength(11);
    expect(objects.map(asset => [asset.table, asset.count])).toEqual([['customer-uploads', 2], ['support-attachments', 1], ['exports', 1]]);
    expect(pg.find(asset => asset.table === 'addresses')?.recordIds).toEqual(['ADDR-1042-01', 'ADDR-1042-02']);
    expect(JSON.stringify(pg)).not.toContain('@example.invalid');
  });

  it('reports real residual data before execution and none after', async () => {
    const {postgres} = createMockConnectors();
    const before = await postgres.verify('CUST-1042');
    expect(before.verified).toBe(false);
    expect(before.remainingMatches).toBe(8);
    for (const table of ['users', 'addresses', 'analytics_events', 'marketing_profiles']) await postgres.execute(action('PostgreSQL', table, 'delete'), 'a'.repeat(64), execCtx('CUST-1042'));
    for (const table of ['customers', 'support_tickets', 'support_messages']) await postgres.execute(action('PostgreSQL', table, 'anonymize'), 'a'.repeat(64), execCtx('CUST-1042'));
    expect(await postgres.verify('CUST-1042')).toMatchObject({verified: true, remainingMatches: 0});
  });

  it('refuses execution without approval, customer identity, or a matching plan hash', async () => {
    const {postgres} = createMockConnectors();
    const del = action('PostgreSQL', 'users', 'delete');
    await expect(postgres.execute(del, 'a'.repeat(64), {approved: false, customerId: 'CUST-1042'})).rejects.toThrow('Human approval');
    await expect(postgres.execute(del, 'a'.repeat(64), {approved: true})).rejects.toThrow('Customer identity required');
    await expect(postgres.execute(del, 'a'.repeat(64), {approved: true, customerId: 'CUST-1042', authoritativePlanHash: 'b'.repeat(64)})).rejects.toThrow('Plan hash mismatch');
    await expect(postgres.execute(action('PostgreSQL', 'orders', 'delete'), 'a'.repeat(64), execCtx('CUST-1042'))).rejects.toThrow('Policy does not allow deleting orders');
  });

  it('cannot back up an archived object, so the backup gate fails for that customer', async () => {
    const {minio} = createMockConnectors();
    const backup = await minio.backupCustomerData('CUST-7001', 'req-7001');
    expect(backup.failures).toEqual(['customer-uploads/CUST-7001/contract-2021.txt is in ARCHIVE storage and must be restored before it can be backed up']);
    const healthy = await minio.backupCustomerData('CUST-1042', 'req-1042');
    expect(healthy.failures).toEqual([]);
    expect(healthy.resources).toBe(4);
  });

  it('re-reads backup artifacts and detects tampering', async () => {
    const {postgres, dataset} = createMockConnectors();
    const backup = await postgres.backupCustomerData('CUST-1042', 'req-1');
    expect(await postgres.verifyBackup('CUST-1042', 'req-1', backup.resourceEvidence!)).toMatchObject({verified: true, checked: 11});
    const artifact = dataset.getObject('eraseops-backups', 'req-1/database.json')!;
    dataset.putObject('eraseops-backups', {...artifact, body: artifact.body.replace('ADDR-1042-02', 'ADDR-1042-99')});
    const tampered = await postgres.verifyBackup('CUST-1042', 'req-1', backup.resourceEvidence!);
    expect(tampered.verified).toBe(false);
    expect(tampered.reason).toContain('pg:addresses:CUST-1042');
  });

  it('simulates a plan on a copy and catches deletions that would orphan other customers', async () => {
    const {postgres, dataset} = createMockConnectors();
    const report = await postgres.simulate('CUST-9001', [action('PostgreSQL', 'organization_members', 'delete'), action('PostgreSQL', 'organizations', 'delete'), action('PostgreSQL', 'users', 'delete'), action('PostgreSQL', 'addresses', 'delete'), action('PostgreSQL', 'analytics_events', 'delete'), action('PostgreSQL', 'customers', 'anonymize')]);
    expect(report.mode).toBe('dataset-clone');
    expect(report.failures.join(' ')).toContain('organizations ORG-501 would orphan 2 records in organization_members that belong to unrelated customers (CUST-9002, CUST-9003)');
    expect(dataset.findRow('organizations', 'ORG-501')).toBeDefined();
  });

  it('passes simulation for a member whose data is not shared', async () => {
    const {postgres} = createMockConnectors();
    const report = await postgres.simulate('CUST-9002', [action('PostgreSQL', 'users', 'delete'), action('PostgreSQL', 'analytics_events', 'delete'), action('PostgreSQL', 'organization_members', 'delete'), action('PostgreSQL', 'customers', 'anonymize')]);
    expect(report.failures).toEqual([]);
    expect(report.residualAfter).toBe(0);
  });

  it('flags a plan that would leave personal data behind', async () => {
    const {postgres} = createMockConnectors();
    const report = await postgres.simulate('CUST-1042', [action('PostgreSQL', 'users', 'delete')]);
    expect(report.failures.some(failure => failure.startsWith('Plan leaves personal data behind'))).toBe(true);
  });

  it('resets to the fixture after mutation', async () => {
    const dataset = DemoDataset.fromFile();
    dataset.deleteOwnedRows('users', 'CUST-1042');
    expect(dataset.ownedRows('users', 'CUST-1042')).toHaveLength(0);
    dataset.reset();
    expect(dataset.ownedRows('users', 'CUST-1042')).toHaveLength(1);
  });
});
