import {describe, it, expect} from 'vitest';
import {loadConfig} from './config.js';

describe('demo guard configuration', () => {
  it('loads explicit local allowlists and connector mode', () => {
    const config = loadConfig({DEMO_MODE: 'true', CONNECTOR_MODE: 'local', ALLOWLIST_SYSTEMS: 'PostgreSQL, MinIO', ALLOWLIST_HOSTS: 'postgres', ALLOWLIST_BUCKETS: 'customer-uploads,eraseops-backups'});
    expect(config).toMatchObject({demoMode: true, connectorMode: 'local', allowlistedSystems: ['PostgreSQL', 'MinIO'], allowlistedHosts: ['postgres'], allowlistedBuckets: ['customer-uploads', 'eraseops-backups']});
  });
  it('defaults to mock connectors for deterministic local development', () => expect(loadConfig({}).connectorMode).toBe('mock'));
  it('refuses non-demo execution mode', () => expect(() => loadConfig({DEMO_MODE: 'false'})).toThrow('DEMO_MODE must be true'));
  it('reads port, approval window, and rate limits from the environment', () => {
    const config = loadConfig({API_PORT: '4100', APPROVAL_TTL_MINUTES: '5', DESTRUCTIVE_RATE_LIMIT: '7', DESTRUCTIVE_RATE_WINDOW_SECONDS: '30', CORS_ORIGIN: 'http://localhost:5173'});
    expect(config.port).toBe(4100);
    expect(config.approvalTtlMs).toBe(5 * 60_000);
    expect(config.rateLimit).toEqual({maxAttempts: 7, windowMs: 30_000});
    expect(config.corsOrigin).toBe('http://localhost:5173');
  });
  it('rejects malformed numeric settings instead of silently falling back', () => expect(() => loadConfig({API_PORT: 'not-a-port'})).toThrow());
});
