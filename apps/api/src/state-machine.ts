import {assertTransition, type Workflow, type WorkflowState} from '../../../packages/shared/src/index.js';

export function transitionWorkflow(workflow: Workflow, next: WorkflowState) {
  if (workflow.state) assertTransition(workflow.state, next);
  workflow.state = next;
  return workflow;
}

export function initialWorkflowState(sandboxPassed: boolean, backupPassed: boolean): WorkflowState {
  let state: WorkflowState = 'REQUEST_CREATED';
  const advance = (next: WorkflowState) => { state = assertTransition(state, next); };
  advance('DISCOVERING');
  advance('DISCOVERY_COMPLETE');
  advance('ANALYZING_DEPENDENCIES');
  advance('DEPENDENCY_ANALYSIS_COMPLETE');
  advance('GENERATING_PLAN');
  advance('PLAN_READY');
  advance('VERIFYING_IN_SANDBOX');
  if (!sandboxPassed) return advance('SANDBOX_FAILED'), state;
  advance('SANDBOX_PASSED');
  advance('CALCULATING_BLAST_RADIUS');
  advance('BACKING_UP');
  if (!backupPassed) return state;
  advance('READY_FOR_APPROVAL');
  advance('AWAITING_HUMAN_APPROVAL');
  return state;
}
