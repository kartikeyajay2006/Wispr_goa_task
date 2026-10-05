import {describe, it, expect} from 'vitest';
import {ExecutionEngine, ExecutionLedger, assertRescanVerified} from './index';

describe('execution ledger', () => {
  it('records each action once per plan', () => { const ledger = new ExecutionLedger(); const result = {actionId: 'a', status: 'completed' as const, startedAt: 'now', completedAt: 'later', affectedRecords: 1}; expect(ledger.record('h', result)).toBe(result); expect(ledger.record('h', {...result, affectedRecords: 99})).toBe(result); expect(ledger.all()).toHaveLength(1); });
});

const action = {id: 'a', system: 'PostgreSQL', resource: 'customers', actionType: 'delete' as const, selector: 'customer_id = $1', reason: 'erasure', recordCount: 1, reversible: false, risk: 'high' as const, dependencies: [], verification: 'rescan'};
const good = {approved: true, planHash: 'h', currentPlanHash: 'h', approvalExpiresAt: new Date(Date.now() + 60_000).toISOString(), approvalUsed: false, demoMode: true as const, authorizationBoundary: 'guarded' as const};

describe('execution boundary', () => {
  it('requires the guarded authorization boundary', () => expect(() => new ExecutionEngine().execute(action, {...good, authorizationBoundary: undefined})).toThrow('Guarded authorization'));
  it('requires approval', () => expect(() => new ExecutionEngine().execute(action, {...good, approved: false})).toThrow('Human approval'));
  it('rejects changed plan hash', () => expect(() => new ExecutionEngine().execute(action, {...good, currentPlanHash: 'changed'})).toThrow('does not match'));
  it('rejects expired approval', () => expect(() => new ExecutionEngine().execute(action, {...good, approvalExpiresAt: new Date(Date.now() - 1).toISOString()})).toThrow('expired'));
  it('is idempotent on retry', () => { const e = new ExecutionEngine(); expect(e.execute(action, good).status).toBe('completed'); expect(e.execute(action, good).status).toBe('skipped'); });
  it('blocks completion when any system has remaining matches', () => expect(() => assertRescanVerified([{system: 'PostgreSQL', remainingMatches: 0, verified: true}, {system: 'MinIO', remainingMatches: 2, verified: false}])).toThrow('MinIO=2'));
});
