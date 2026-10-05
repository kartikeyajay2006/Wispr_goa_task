import {describe, expect, it} from 'vitest';
import {executeApprovedWorkflow} from './execution-service.js';
import {createMockConnectors} from '../../../packages/connectors/src/index.js';
import {actionForClassification} from '../../../packages/policy-engine/src/retention-policy.js';

const ctx = {demoMode: true as const, allowlistedHosts: ['postgres'], allowlistedBuckets: ['customer-uploads', 'support-attachments', 'exports']};
const hash = 'a'.repeat(64);

async function approvedWorkflow(customerId = 'CUST-1042') {
  const connectors = createMockConnectors();
  const assets = [...await connectors.postgres.discoverCustomerData(customerId, ctx), ...await connectors.minio.discoverCustomerData(customerId, ctx)];
  const workflow: any = {requestId: '00000000-0000-4000-8000-000000000021', customerId, dryRun: false, stage: 'execution', status: 'ready', state: 'APPROVED', plan: {id: 'p', requestId: '00000000-0000-4000-8000-000000000021', customerId, createdAt: 'now', items: assets.map(asset => ({...asset, action: actionForClassification(asset.classification)})), canonical: 'c', hash, status: 'approved'}, assets, blastRadius: {systems: 2, records: 0, retained: 0, anonymized: 0, deletable: 0}, events: [], approval: {token: '00000000-0000-4000-8000-000000000022', expiresAt: new Date(Date.now() + 60000).toISOString(), used: false, planHash: hash}, sandboxPassed: true, backupVerified: true};
  return {workflow, connectors};
}

describe('API execution service', () => {
  it('mutates the connected systems and proves nothing personal remains', async () => {
    const {workflow, connectors} = await approvedWorkflow();
    const result = await executeApprovedWorkflow(workflow, connectors);
    expect(result.workflow.status).toBe('executed');
    expect(result.workflow.state).toBe('COMPLETED');
    expect(result.workflow.verification).toMatchObject({postgres: true, minio: true, remainingMatches: 0});
    expect(result.results.find(item => item.actionId === 'pg:addresses:CUST-1042')).toMatchObject({status: 'completed', affectedRecords: 2});
    expect(result.results.find(item => item.actionId === 'pg:orders:CUST-1042')).toMatchObject({status: 'skipped', affectedRecords: 0});
    const rediscovered = await connectors.postgres.discoverCustomerData('CUST-1042', ctx);
    expect(rediscovered.map(asset => asset.table).sort()).toEqual(['audit_records', 'customers', 'order_items', 'orders', 'payments', 'support_messages', 'support_tickets']);
    expect(connectors.dataset.findRow('customers', 'CUST-1042')).toMatchObject({name: '[redacted]', email: '[redacted]'});
    expect(await connectors.minio.discoverCustomerData('CUST-1042', ctx)).toEqual([]);
    expect(workflow.approval.used).toBe(true);
  });
  it('leaves other customers untouched', async () => {
    const {workflow, connectors} = await approvedWorkflow();
    const before = connectors.dataset.fingerprintOthers('CUST-1042');
    await executeApprovedWorkflow(workflow, connectors);
    expect(connectors.dataset.changedSince(before)).toEqual([]);
  });
  it('refuses a changed approval plan hash', async () => { const {workflow, connectors} = await approvedWorkflow(); workflow.approval.planHash = 'b'.repeat(64); await expect(executeApprovedWorkflow(workflow, connectors)).rejects.toThrow('plan hash mismatch'); });
  it('fails verification when a connector reports success without removing data', async () => {
    const {workflow, connectors} = await approvedWorkflow();
    const silent = {...connectors.postgres, verify: connectors.postgres.verify.bind(connectors.postgres), execute: async (action: any) => ({actionId: action.id, status: 'completed' as const, startedAt: 'now', completedAt: 'now', affectedRecords: action.recordCount})};
    await expect(executeApprovedWorkflow(workflow, {postgres: silent, minio: connectors.minio})).rejects.toThrow('Post-execution verification failed: PostgreSQL=');
    expect(workflow.state).toBe('VERIFICATION_FAILED');
    expect(workflow.status).toBe('ready');
    expect(workflow.plan.status).toBe('approved');
    expect(workflow.approval.used).toBe(false);
  });
});
