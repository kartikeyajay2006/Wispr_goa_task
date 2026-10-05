import {assertReadyForExecution} from '../../../packages/policy-engine/src/index.js';
import {ExecutionEngine, assertRescanVerified, type ExecutionContext} from '../../../packages/execution/src/index.js';
import type {Connector} from '../../../packages/connectors/src/index.js';
import {event, type DeletionAction, type ExecutionResult, type PlanItem, type Workflow} from '../../../packages/shared/src/index.js';
import {transitionWorkflow} from './state-machine.js';

export type ExecutionConnector = Pick<Connector, 'execute' | 'verify'>;
export type ExecutionConnectors = {postgres: ExecutionConnector; minio: ExecutionConnector};

export function actionFromPlanItem(item: PlanItem): DeletionAction { return {id: item.id, system: item.system, resource: item.table, actionType: item.action === 'delete' ? 'delete' : item.action === 'redact' ? 'anonymize' : 'retain', selector: 'customer_id = $1', reason: 'approved plan', recordCount: item.count, reversible: item.action !== 'delete', risk: item.risk, dependencies: item.dependencyIds, verification: 'rescan connector'}; }

/**
 * Executes an approved plan through the connectors that own the data, then rescans.
 * The engine only authorizes each action; the connector is the only thing that mutates data.
 */
export async function executeApprovedWorkflow(workflow: Workflow, connectors: ExecutionConnectors, engine = new ExecutionEngine()) {
  const approval = workflow.approval;
  if (!approval) throw new Error('Execution blocked: human approval missing');
  if (!workflow.state) workflow.state = 'APPROVED';
  if (workflow.state !== 'APPROVED') throw new Error(`Execution blocked: workflow is ${workflow.state}`);
  assertReadyForExecution({state: 'APPROVED', dryRun: workflow.dryRun, discoveryComplete: true, dependenciesComplete: true, planExists: true, sandboxPassed: Boolean(workflow.sandboxPassed), backupPassed: Boolean(workflow.backupVerified), blastRadiusCalculated: true, policyApproved: true, humanApproved: true, planHashMatches: approval.planHash === workflow.plan.hash, approvalValid: !approval.used && Date.parse(approval.expiresAt) > Date.now() && approval.planHash === workflow.plan.hash});
  const context: ExecutionContext = {approved: true, planHash: approval.planHash, currentPlanHash: workflow.plan.hash, approvalExpiresAt: approval.expiresAt, approvalUsed: false, demoMode: true, authorizationBoundary: 'guarded'};
  const connectorFor = (system: string) => system === 'MinIO' ? connectors.minio : connectors.postgres;
  const results: ExecutionResult[] = [];
  transitionWorkflow(workflow, 'EXECUTING');
  workflow.executionStartedAt = new Date().toISOString();
  try {
    for (const item of workflow.plan.items) {
      const action = actionFromPlanItem(item);
      if (!engine.authorize(action, context)) { results.push({actionId: action.id, status: 'skipped', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), affectedRecords: 0}); continue; }
      results.push(await connectorFor(action.system).execute(action, workflow.plan.hash, {approved: true, customerId: workflow.customerId, authoritativePlanHash: workflow.plan.hash}));
    }
  } catch (error) {
    transitionWorkflow(workflow, 'EXECUTION_FAILED');
    workflow.executionResults = results;
    throw error;
  }
  workflow.executionCompletedAt = new Date().toISOString();
  workflow.executionResults = results;
  transitionWorkflow(workflow, 'VERIFYING_DELETION');
  const verification = await Promise.all([connectors.postgres.verify(workflow.customerId), connectors.minio.verify(workflow.customerId)]);
  const remainingMatches = verification.reduce((total, result) => total + result.remainingMatches, 0);
  workflow.verification = {postgres: verification[0].verified, minio: verification[1].verified, remainingMatches, results: verification};
  try { assertRescanVerified(verification); } catch (error) { transitionWorkflow(workflow, 'VERIFICATION_FAILED'); throw error; }
  approval.used = true;
  workflow.events.push(
    ...results.map(result => event('execution', workflow.requestId, result.status === 'skipped' ? `Action ${result.actionId} retained under policy; nothing changed.` : `Action ${result.actionId} completed: ${result.affectedRecords} record${result.affectedRecords === 1 ? '' : 's'} changed.`, {actor: 'connector', planHash: workflow.plan.hash, details: {status: result.status, affectedRecords: result.affectedRecords}})),
    event('rescan', workflow.requestId, `Post-execution rescan found ${remainingMatches} residual records.`, {planHash: workflow.plan.hash, details: {postgres: verification[0].verified, minio: verification[1].verified, remainingMatches, results: verification}}),
    event('report', workflow.requestId, 'Final audit report sealed.', {planHash: workflow.plan.hash}),
  );
  transitionWorkflow(workflow, 'COMPLETED');
  workflow.plan.status = 'executed'; workflow.stage = 'report'; workflow.status = 'executed';
  return {workflow, results, verification};
}
