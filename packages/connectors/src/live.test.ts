import {describe, it, expect} from 'vitest';
import {PostgresAdapter, MinioAdapter} from './adapters.js';
import {PostgresLiveConnector, MinioLiveConnector} from './live.js';

const ctx = {demoMode: true as const, allowlistedHosts: ['postgres'], allowlistedBuckets: ['customer-uploads', 'support-attachments', 'exports']};
describe('local connector implementations', () => {
  it('runs PostgreSQL discovery through the real adapter contract', async () => { const connector = new PostgresLiveConnector(new PostgresAdapter({query: async () => ({rows: [{table_name: 'customers', record_count: 1}]})})); const assets = await connector.discoverCustomerData('CUST-1042', ctx); expect(connector.system.connectionStatus).toBe('connected'); expect(assets[0].id).toBe('pg:customers:CUST-1042'); });
  it('copies all configured MinIO buckets into the request backup namespace', async () => { const copies: string[] = []; const adapter = new MinioAdapter({list: async (_bucket, prefix) => [`${prefix}file.txt`], copy: async (source, target) => { copies.push(`${source}->${target}`); }, delete: async () => {}}, ['customer-uploads', 'support-attachments', 'exports']); const connector = new MinioLiveConnector(adapter, ['customer-uploads', 'support-attachments', 'exports']); const result = await connector.backupCustomerData('CUST-1042', 'request-1'); expect(result.resources).toBe(3); expect(copies).toHaveLength(3); expect(copies.every(copy => copy.includes('eraseops-backups/request-1'))).toBe(true); });
});
