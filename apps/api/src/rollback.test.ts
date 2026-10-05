import {describe, expect, it} from 'vitest';
import {createMockConnectors} from '../../../packages/connectors/src/index.js';
import {InMemoryRuntimeStore} from './runtime-store.js';
import {DestructiveRequestGuard} from './destructive-guard.js';
import {WorkflowService} from './workflow-service.js';

const context = {demoMode: true as const, allowlistedHosts: ['postgres'], allowlistedBuckets: ['customer-uploads', 'support-attachments', 'exports']};

describe('rollback from the request backup', () => {
  it('restores every deleted row and object after verification fails', async () => {
    const {dataset, postgres, minio} = createMockConnectors();
    // A PostgreSQL connector that deletes addresses but silently skips everything else.
    const partial = Object.assign(Object.create(postgres), {execute: async (action: any, planHash: string, ctx: any) => action.resource === 'addresses' ? postgres.execute(action, planHash, ctx) : {actionId: action.id, status: 'completed', startedAt: 'now', completedAt: 'now', affectedRecords: action.recordCount}});
    const service = new WorkflowService({postgres: partial, minio, store: new InMemoryRuntimeStore(), guard: new DestructiveRequestGuard(), context, approvalTtlMs: 60_000});
    const before = dataset.snapshot();

    const workflow = await service.create({customerId: 'CUST-1042', reason: 'rollback validation', dryRun: false}, 'ops');
    await service.approve(workflow.requestId, {confirmation: 'CUST-1042'}, 'ops');
    await expect(service.execute(workflow.requestId, {approvalId: workflow.approval!.token, planHash: workflow.plan.hash}, 'ops')).rejects.toThrow('Post-execution verification failed');
    expect(workflow.state).toBe('VERIFICATION_FAILED');
    expect(dataset.ownedRows('addresses', 'CUST-1042')).toHaveLength(0);
    expect(dataset.ownedObjects('customer-uploads', 'CUST-1042')).toHaveLength(0);

    const rolledBack = await service.rollback(workflow.requestId, 'ops');
    expect(rolledBack.state).toBe('ROLLED_BACK');
    const after = dataset.snapshot();
    for (const table of Object.keys(before.tables)) expect(new Set(after.tables[table].map(row => JSON.stringify(row)))).toEqual(new Set(before.tables[table].map(row => JSON.stringify(row))));
    for (const bucket of ['customer-uploads', 'support-attachments', 'exports']) expect(after.objects[bucket].map(object => object.key).sort()).toEqual(before.objects[bucket].map(object => object.key).sort());
    expect(rolledBack.events.at(-1)?.message).toContain('ops rolled back from backup: Restored 12 rows across 11 tables; Restored 4 objects');
  });
});
