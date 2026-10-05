import {assertReadyForExecution} from '../../../packages/policy-engine/src/index.js';
import {ExecutionEngine, assertRescanVerified, type ExecutionContext} from '../../../packages/execution/src/index.js';
import {MockMinioConnector, MockPostgresConnector} from '../../../packages/connectors/src/index.js';
import {event, type DeletionAction, type ExecutionResult, type PlanItem, type Workflow} from '../../../packages/shared/src/index.js';
import {transitionWorkflow} from './state-machine.js';

type VerificationConnector = {verify(customerId: string): Promise<{system: string; remainingMatches: number; verified: boolean; details: string}>};
export type DestructiveActionExecutor = (action: DeletionAction, planHash: string, customerId: string) => Promise<ExecutionResult>;

export function actionFromPlanItem(item: PlanItem): DeletionAction { return {id: item.id, system: item.system, resource: item.table, actionType: item.action === 'delete' ? 'delete' : item.action === 'redact' ? 'anonymize' : 'retain', selector: 'customer_id = $1', reason: 'approved plan', recordCount: item.count, reversible: item.action !== 'delete', risk: item.risk, dependencies: item.dependencyIds, verification: 'rescan connector'}; }

export async function executeApprovedWorkflow(workflow: Workflow, engine = new ExecutionEngine(), postgres: VerificationConnector = new MockPostgresConnector(), minio: VerificationConnector = new MockMinioConnector(), connectorExecutor?: DestructiveActionExecutor) {
  const approval = workflow.approval;
  if (!approval) throw new Error('Execution blocked: human approval missing');
  if (!workflow.state) workflow.state = 'APPROVED';
  if (workflow.state !== 'APPROVED') throw new Error(`Execution blocked: workflow is ${workflow.state}`);
  assertReadyForExecution({state: 'APPROVED', dryRun: workflow.dryRun, discoveryComplete: true, dependenciesComplete: true, planExists: true, sandboxPassed: Boolean((workflow as any).sandboxPassed), backupPassed: Boolean((workflow as any).backupVerified), blastRadiusCalculated: true, policyApproved: true, humanApproved: true, planHashMatches: approval.planHash === workflow.plan.hash, approvalValid: !approval.used && Date.parse(approval.expiresAt) > Date.now() && approval.planHash === workflow.plan.hash});
  const context: ExecutionContext = {approved: true, planHash: workflow.plan.hash, currentPlanHash: workflow.plan.hash, approvalExpiresAt: approval.expiresAt, approvalUsed: false, demoMode: true, authorizationBoundary: 'guarded'};
  const results: ExecutionResult[] = [];
  transitionWorkflow(workflow, 'EXECUTING');
  try {
    for (const item of workflow.plan.items) { const action = actionFromPlanItem(item); results.push(connectorExecutor ? await connectorExecutor(action, workflow.plan.hash, workflow.customerId) : engine.execute(action, context)); }
  } catch (error) {
    transitionWorkflow(workflow, 'EXECUTION_FAILED');
    throw error;
  }
  transitionWorkflow(workflow, 'VERIFYING_DELETION');
  const verification = await Promise.all([postgres.verify(workflow.customerId), minio.verify(workflow.customerId)]);
  try { assertRescanVerified(verification); } catch (error) { transitionWorkflow(workflow, 'VERIFICATION_FAILED'); throw error; }
  approval.used = true;
  workflow.events.push(...results.map(result => event('execution', workflow.requestId, `Action ${result.actionId} completed.`, {planHash: workflow.plan.hash, details: {status: result.status, affectedRecords: result.affectedRecords}})), event('rescan', workflow.requestId, 'Post-execution rescan completed.', {planHash: workflow.plan.hash, details: {postgres: verification[0].verified, minio: verification[1].verified, remainingMatches: 0}}), event('report', workflow.requestId, 'Final audit report sealed.', {planHash: workflow.plan.hash}));
  transitionWorkflow(workflow, 'COMPLETED');
  workflow.plan.status = 'executed'; workflow.stage = 'report'; workflow.status = 'executed';
  (workflow as any).verification = {postgres: verification[0].verified, minio: verification[1].verified, remainingMatches: 0};
  return {workflow, results, verification};
}
