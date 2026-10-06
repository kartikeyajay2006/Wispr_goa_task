import {describe, expect, it, vi, afterEach} from 'vitest';
import {createMockConnectors} from '../../../packages/connectors/src/index.js';
import {InMemoryRuntimeStore} from './runtime-store.js';
import {DestructiveRequestGuard} from './destructive-guard.js';
import {WorkflowService} from './workflow-service.js';

const context = {demoMode: true as const, allowlistedHosts: ['postgres'], allowlistedBuckets: ['customer-uploads', 'support-attachments', 'exports']};
const service = (guard = new DestructiveRequestGuard()) => { const {postgres, minio} = createMockConnectors(); return new WorkflowService({postgres, minio, store: new InMemoryRuntimeStore(), guard, context, approvalTtlMs: 60_000}); };
afterEach(() => vi.useRealTimers());

describe('approval lifecycle', () => {
  it('renews an approval that expired before execution, then executes', async () => {
    const workflows = service();
    const workflow = await workflows.create({customerId: 'CUST-1042', reason: 'renewal check', dryRun: false}, 'ops');
    await workflows.approve(workflow.requestId, {confirmation: 'CUST-1042'}, 'ops');
    await expect(workflows.approve(workflow.requestId, {confirmation: 'CUST-1042'}, 'ops')).rejects.toThrow('already approved and its approval is still valid');
    const firstToken = workflow.approval!.token;
    vi.useFakeTimers({now: Date.now() + 2 * 60_000, toFake: ['Date']});
    await expect(workflows.execute(workflow.requestId, {approvalId: firstToken, planHash: workflow.plan.hash}, 'ops')).rejects.toThrow('approval invalid, expired, or used');
    const renewed = await workflows.approve(workflow.requestId, {confirmation: 'CUST-1042'}, 'dpo');
    expect(renewed.state).toBe('APPROVED');
    expect(renewed.approval).toMatchObject({approvedBy: 'dpo', used: false});
    expect(renewed.approval!.token).not.toBe(firstToken);
    expect(renewed.events.at(-1)!.message).toContain('dpo renewed the expired approval');
    const done = await workflows.execute(workflow.requestId, {approvalId: renewed.approval!.token, planHash: workflow.plan.hash}, 'dpo');
    expect(done.state).toBe('COMPLETED');
  });

  it('refuses to open a request for a customer who is already erased', async () => {
    const workflows = service();
    const workflow = await workflows.create({customerId: 'CUST-4410', reason: 'first erasure', dryRun: false}, 'ops');
    await workflows.approve(workflow.requestId, {confirmation: 'CUST-4410'}, 'ops');
    await workflows.execute(workflow.requestId, {approvalId: workflow.approval!.token, planHash: workflow.plan.hash}, 'ops');
    await expect(workflows.create({customerId: 'CUST-4410', reason: 'second erasure', dryRun: false}, 'ops')).rejects.toMatchObject({status: 409, message: expect.stringContaining('no erasable personal data left')});
  });

  it('tells the operator when the execution rate limit resets', () => {
    const guard = new DestructiveRequestGuard(1, 30_000);
    const input = {identity: 'ops', requestId: 'r', approvalId: 'a', planHash: 'a'.repeat(64), authoritativeRequestId: 'r', authoritativeApprovalId: 'a', authoritativePlanHash: 'a'.repeat(64)};
    guard.authorize(input, 1_000);
    expect(() => guard.authorize(input, 11_000)).toThrow('rate limit exceeded: ops can try again in 20s');
  });
});
