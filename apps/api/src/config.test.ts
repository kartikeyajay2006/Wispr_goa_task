import {describe, it, expect} from 'vitest';
import {loadConfig} from './config.js';

describe('demo guard configuration', () => {
  it('loads explicit local allowlists and connector mode', () => { expect(loadConfig({DEMO_MODE: 'true', CONNECTOR_MODE: 'local', ALLOWLIST_SYSTEMS: 'PostgreSQL, MinIO', ALLOWLIST_HOSTS: 'postgres', ALLOWLIST_BUCKETS: 'customer-uploads,eraseops-backups'})).toEqual({demoMode: true, connectorMode: 'local', allowlistedSystems: ['PostgreSQL', 'MinIO'], allowlistedHosts: ['postgres'], allowlistedBuckets: ['customer-uploads', 'eraseops-backups']}); });
  it('defaults to mock connectors for deterministic local development', () => expect(loadConfig({}).connectorMode).toBe('mock'));
  it('refuses non-demo execution mode', () => expect(() => loadConfig({DEMO_MODE: 'false'})).toThrow('DEMO_MODE must be true'));
});
