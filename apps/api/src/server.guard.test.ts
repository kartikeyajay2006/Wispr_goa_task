import {describe, it, expect} from 'vitest';
import {validateGuardedExecutionInput} from './server.js';

describe('API guarded execution input', () => {
  it('requires an operator identity', () => expect(() => validateGuardedExecutionInput(undefined, {approvalId: 'a', planHash: 'b'})).toThrow('Operator identity required'));
  it('requires explicit approval and plan identities', () => { expect(() => validateGuardedExecutionInput('operator', {})).toThrow('approvalId and planHash are required'); expect(() => validateGuardedExecutionInput('operator', {approvalId: 'a'})).toThrow('approvalId and planHash are required'); });
  it('returns only the structured guarded fields', () => expect(validateGuardedExecutionInput('operator', {approvalId: 'approval-1', planHash: 'a'.repeat(64), arbitrary: 'ignored'})).toEqual({identity: 'operator', approvalId: 'approval-1', planHash: 'a'.repeat(64)}));
});
