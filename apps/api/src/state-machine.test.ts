import {describe, expect, it} from 'vitest';
import {initialWorkflowState, transitionWorkflow} from './state-machine.js';

const workflow = (state: any) => ({state, requestId: 'r', customerId: 'CUST-1042', dryRun: false} as any);

describe('API workflow state machine integration', () => {
  it('derives legal terminal checkpoints for normal and blocked workflows', () => {
    expect(initialWorkflowState(true, true)).toBe('AWAITING_HUMAN_APPROVAL');
    expect(initialWorkflowState(false, true)).toBe('SANDBOX_FAILED');
    expect(initialWorkflowState(true, false)).toBe('BACKING_UP');
  });

  it('allows approval and rejection only from the human checkpoint', () => {
    expect(transitionWorkflow(workflow('AWAITING_HUMAN_APPROVAL'), 'APPROVED').state).toBe('APPROVED');
    expect(transitionWorkflow(workflow('AWAITING_HUMAN_APPROVAL'), 'REJECTED').state).toBe('REJECTED');
    expect(() => transitionWorkflow(workflow('PLAN_READY'), 'COMPLETED')).toThrow('Invalid workflow transition');
  });

  it('models execution verification and failure states', () => {
    const successful = workflow('APPROVED');
    transitionWorkflow(successful, 'EXECUTING');
    transitionWorkflow(successful, 'VERIFYING_DELETION');
    expect(transitionWorkflow(successful, 'COMPLETED').state).toBe('COMPLETED');
    const failed = workflow('EXECUTING');
    expect(transitionWorkflow(failed, 'EXECUTION_FAILED').state).toBe('EXECUTION_FAILED');
  });
});
