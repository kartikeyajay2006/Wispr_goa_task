import {describe, it, expect} from 'vitest';
import {createHash} from 'node:crypto';
import {PostgresAdapter, MinioAdapter} from './adapters.js';
import {PostgresLiveConnector, MinioLiveConnector} from './live.js';

const ctx = {demoMode: true as const, allowlistedHosts: ['postgres'], allowlistedBuckets: ['customer-uploads', 'support-attachments', 'exports']};
describe('local connector implementations', () => {
  it('runs PostgreSQL discovery through the real adapter contract', async () => { const connector = new PostgresLiveConnector(new PostgresAdapter({query: async () => ({rows: [{table_name: 'customers', record_count: 1}]})})); const assets = await connector.discoverCustomerData('CUST-1042', ctx); expect(connector.system.connectionStatus).toBe('connected'); expect(assets[0].id).toBe('pg:customers:CUST-1042'); });
  it('backs up each object under its bucket and checksums the real content', async () => {
    const copies: string[] = [];
    const bodies: Record<string, string> = {};
    const client = {list: async (bucket: string, prefix: string) => bucket === 'eraseops-backups' ? [] : [`${prefix}file.txt`], copy: async (source: string, target: string) => { copies.push(`${source}->${target}`); bodies[target] = `content of ${source}`; }, delete: async () => {}, get: async (bucket: string, key: string) => bodies[`${bucket}/${key}`] ?? `content of ${bucket}/${key}`, head: async () => ({})};
    const connector = new MinioLiveConnector(new MinioAdapter(client, ['customer-uploads', 'support-attachments', 'exports']), ['customer-uploads', 'support-attachments', 'exports']);
    const result = await connector.backupCustomerData('CUST-1042', 'request-1');
    expect(result.resources).toBe(3);
    expect(copies).toContain('customer-uploads/CUST-1042/file.txt->eraseops-backups/request-1/customer-uploads/CUST-1042/file.txt');
    expect(result.resourceEvidence?.[0].checksum).toBe(createHash('sha256').update('content of customer-uploads/CUST-1042/file.txt').digest('hex'));
    expect(await connector.verifyBackup('CUST-1042', 'request-1', result.resourceEvidence!)).toMatchObject({verified: true, checked: 3});
    bodies['eraseops-backups/request-1/exports/CUST-1042-file.txt'] = 'tampered';
    expect((await connector.verifyBackup('CUST-1042', 'request-1', result.resourceEvidence!)).verified).toBe(false);
  });
  it('refuses to back up archived objects or to fake a checksum it cannot compute', async () => {
    const archived = new MinioAdapter({list: async (_bucket, prefix) => [`${prefix}old.txt`], copy: async () => {}, delete: async () => {}, get: async () => 'x', head: async () => ({'storage-tier': 'ARCHIVE'})}, ['customer-uploads']);
    expect((await archived.backupCustomerObjects('CUST-7001', 'request-2')).failures).toEqual(['customer-uploads/CUST-7001/old.txt is in ARCHIVE storage and must be restored before it can be backed up']);
    const blind = new MinioAdapter({list: async () => [], copy: async () => {}, delete: async () => {}}, ['customer-uploads']);
    await expect(blind.backupCustomerObjects('CUST-1042', 'request-3')).rejects.toThrow('cannot read objects');
  });
});
