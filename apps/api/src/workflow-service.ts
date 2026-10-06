import {randomUUID} from 'node:crypto';
import {requestSchema, event, type Asset, type AuditEvent, type Dependency, type Workflow} from '../../../packages/shared/src/index.js';
import type {BackupVerification, Connector, ConnectorContext} from '../../../packages/connectors/src/index.js';
import {createBackupManifest, verifyBackupManifest, type BackupManifest} from '../../../packages/backup/src/index.js';
import {verifyPlanInSandbox} from '../../../packages/sandbox/src/index.js';
import {calculateBlastRadius} from '../../../packages/blast-radius/src/index.js';
import {validateAction} from '../../../packages/policy-engine/src/index.js';
import {generateDeletionPlan} from '../../../packages/workflow/src/planner.js';
import {InMemoryRuntimeStore} from './runtime-store.js';
import {DestructiveRequestGuard} from './destructive-guard.js';
import {actionFromPlanItem, executeApprovedWorkflow} from './execution-service.js';
import {initialWorkflowState, transitionWorkflow} from './state-machine.js';

export class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

export type WorkflowServiceOptions = {
  postgres: Connector;
  minio: Connector;
  store: InMemoryRuntimeStore;
  guard: DestructiveRequestGuard;
  context: ConnectorContext;
  approvalTtlMs: number;
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const requireOperator = (identity: string | undefined) => {
  const operator = identity?.trim();
  if (!operator) throw new HttpError(401, 'Operator identity required: send the x-operator-identity header');
  if (operator.length > 120) throw new HttpError(400, 'Operator identity is too long');
  return operator;
};

export class WorkflowService {
  constructor(private readonly options: WorkflowServiceOptions) {}
  private get connectors() { return [this.options.postgres, this.options.minio]; }

  get(requestId: string) {
    const workflow = this.options.store.get(requestId);
    if (!workflow) throw new HttpError(404, `Request ${requestId} not found`);
    return workflow;
  }

  /** Discovery through backup: everything that must hold before a human is asked to approve. */
  async create(body: unknown, operatorIdentity?: string): Promise<Workflow> {
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) throw new HttpError(400, parsed.error.issues.map(issue => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; '));
    const input = parsed.data;
    const requestedBy = operatorIdentity?.trim() || input.requestedBy;
    const requestId = randomUUID();
    const createdAt = new Date().toISOString();
    const {postgres, minio, context} = this.options;

    const assets: Asset[] = [...await postgres.discoverCustomerData(input.customerId, context), ...await minio.discoverCustomerData(input.customerId, context)];
    if (!assets.length) throw new HttpError(404, `No personal data found for ${input.customerId} in ${this.connectors.map(connector => connector.system.name).join(' or ')}`);
    // A customer whose erasable data is already gone gets a clear answer instead of an empty plan.
    const residual = (await Promise.all(this.connectors.map(connector => connector.verify(input.customerId)))).reduce((total, result) => total + result.remainingMatches, 0);
    if (residual === 0) throw new HttpError(409, `${input.customerId} has no erasable personal data left: everything the policy deletes or redacts is already gone. ${plural(assets.filter(asset => asset.classification === 'retain').reduce((total, asset) => total + asset.count, 0), 'record')} stay under the retention policy.`);
    const dependencies: Dependency[] = [...await postgres.inspectDependencies?.(input.customerId) ?? [], ...await minio.inspectDependencies?.(input.customerId) ?? []];
    const shared = dependencies.filter(dependency => dependency.constraintType === 'business');

    const plan = generateDeletionPlan({requestId, customerId: input.customerId, assets, createdAt});
    const actions = plan.items.map(item => ({...actionFromPlanItem(item), reason: item.basis ?? `deterministic ${item.action} classification`}));
    const simulations = (await Promise.all(this.connectors.map(connector => connector.simulate?.(input.customerId, actions)))).filter(report => report !== undefined);
    const sandbox = verifyPlanInSandbox({customerId: input.customerId, planHash: plan.hash, actions, simulations});
    const policyFailures = actions.flatMap(action => { try { validateAction(action); return []; } catch (error) { return [`${action.id}: ${error instanceof Error ? error.message : 'policy violation'}`]; } });
    if (policyFailures.length) { sandbox.failures.push(...policyFailures); sandbox.status = 'failed'; }
    const sandboxPassed = sandbox.status === 'passed';

    // A backup is only taken for a plan that is safe to run; an unsafe plan never reaches the data.
    let backup: BackupManifest | undefined;
    let backupFailures: string[] = [];
    let backupChecks: BackupVerification[] = [];
    let backupVerified = false;
    let backupReason = 'Skipped because the sandbox blocked the plan';
    if (sandboxPassed) {
      const results = await Promise.all(this.connectors.map(connector => connector.backupCustomerData(input.customerId, requestId)));
      const evidence = results.flatMap(result => result.resourceEvidence ?? []);
      backupFailures = results.flatMap(result => result.failures ?? []);
      backup = createBackupManifest({requestId, customerId: input.customerId, planHash: plan.hash, resources: evidence});
      const manifestCheck = verifyBackupManifest(backup, {requestId, customerId: input.customerId, planHash: plan.hash});
      backupChecks = (await Promise.all(this.connectors.map(connector => connector.verifyBackup?.(input.customerId, requestId, evidence)))).filter(check => check !== undefined);
      backupVerified = !backupFailures.length && manifestCheck.verified && backupChecks.every(check => check.verified);
      backupReason = backupFailures[0] ?? (manifestCheck.verified ? backupChecks.find(check => !check.verified)?.reason : manifestCheck.reason) ?? `Backup of ${plural(evidence.length, 'resource')} re-read and verified`;
      backup.verified = backupVerified;
    }

    const blast = calculateBlastRadius(plan.items);
    const systems = [...new Set(assets.map(asset => asset.system))];
    const records = assets.reduce((total, asset) => total + asset.count, 0);
    const events: AuditEvent[] = [
      event('intake', requestId, `Erasure request for ${input.customerId} accepted from ${requestedBy}${input.dryRun ? ' as a dry run' : ''}.`, {actor: 'operator', details: {reason: input.reason, scope: input.scope, dryRun: input.dryRun}}),
      event('discovery', requestId, `Scanned ${this.connectors.map(connector => connector.system.name).join(' and ')} through allowlisted connectors.`, {actor: 'connector', details: {systems: this.connectors.map(connector => ({name: connector.system.name, mode: connector.system.connectionStatus})), secretsRedacted: true}}),
      event('footprint', requestId, `Found ${plural(records, 'record')} in ${plural(assets.length, 'resource')} across ${plural(systems.length, 'system')}.`, {details: {assetCount: assets.length, records, systems}}),
      event('dependencies', requestId, shared.length ? `${plural(shared.length, 'shared dependency')} on other customers detected.` : `Dependency graph resolved: ${plural(dependencies.filter(dependency => dependency.constraintType === 'foreign_key').length, 'foreign key')}, ${plural(dependencies.filter(dependency => dependency.constraintType === 'retention').length, 'retention hold')}.`, {details: {dependencyCount: dependencies.length, shared: shared.map(dependency => dependency.relationshipType)}}),
      event('classification', requestId, `Policy classified ${plural(plan.deletedItems.length, 'resource')} for deletion, ${plan.anonymizedItems.length} for redaction, ${plan.retainedItems.length} retained.`, {actor: 'policy-engine', details: {delete: plan.deletedItems, redact: plan.anonymizedItems, retain: plan.retainedItems}}),
      event('plan', requestId, `Canonical plan v${plan.version} hashed (${plan.hash.slice(0, 12)}…).`, {planHash: plan.hash, details: {riskScore: plan.riskScore}}),
      event('sandbox', requestId, sandboxPassed ? `Sandbox passed: ${plural(sandbox.tests.length, 'check')} on an isolated copy.` : `Sandbox blocked the plan: ${sandbox.failures[0]}`, {actor: 'policy-engine', planHash: plan.hash, details: {failures: sandbox.failures, warnings: sandbox.warnings}}),
    ];
    if (sandboxPassed) events.push(event('backup', requestId, backupVerified ? backupReason : `Backup failed; approval blocked. ${backupReason}`, {actor: 'connector', planHash: plan.hash, details: {backupId: backup?.backupId, failures: backupFailures, checks: backupChecks}}));
    const blocked = !sandboxPassed || !backupVerified;
    if (!blocked) events.push(
      event('blast_radius', requestId, `Blast radius: ${blast.recordsDeleted} deleted, ${blast.recordsAnonymized} redacted, ${blast.recordsRetained} retained (${blast.estimatedImpact} impact).`, {planHash: plan.hash, details: blast as unknown as Record<string, unknown>}),
      event('policy', requestId, input.dryRun ? 'Policy engine approved the plan for review only; dry runs never execute.' : 'Policy engine approved the plan for a human checkpoint.', {actor: 'policy-engine', planHash: plan.hash}),
      event('approval', requestId, input.dryRun ? 'Dry run complete. Create a live request to execute this plan.' : 'Paused for explicit human approval of the exact plan hash.', {planHash: plan.hash}),
    );

    const workflow: Workflow = {
      requestId, customerId: input.customerId, dryRun: input.dryRun,
      stage: !sandboxPassed ? 'sandbox' : !backupVerified ? 'backup' : 'approval',
      state: initialWorkflowState(sandboxPassed, backupVerified),
      status: blocked ? 'blocked' : 'awaiting_approval',
      plan, assets, dependencies,
      blastRadius: {systems: blast.affectedSystems, records: blast.affectedRecords, retained: blast.recordsRetained, anonymized: blast.recordsAnonymized, deletable: blast.recordsDeleted},
      events,
      request: {reason: input.reason, requestedBy, createdAt, scope: input.scope},
      sandbox, sandboxPassed, backup, backupVerified, backupChecks, backupFailures,
    };
    this.options.store.set(requestId, workflow);
    return workflow;
  }

  async approve(requestId: string, body: {confirmation?: unknown} | undefined, identity: string | undefined) {
    const operator = requireOperator(identity);
    const workflow = this.get(requestId);
    if (body?.confirmation !== workflow.customerId) throw new HttpError(400, `Type ${workflow.customerId} to approve destructive execution`);
    if (workflow.dryRun) throw new HttpError(409, 'Dry-run requests are review-only; create a live request to execute this plan');
    // An approval that expired before anyone executed it can be renewed for the same plan hash; otherwise the request would be stuck.
    const renewing = workflow.state === 'APPROVED' && workflow.approval && !workflow.approval.used && Date.parse(workflow.approval.expiresAt) <= Date.now();
    if (!renewing && (workflow.stage !== 'approval' || workflow.plan.status !== 'pending_approval')) throw new HttpError(409, workflow.state === 'APPROVED' ? 'This plan is already approved and its approval is still valid; execute it before it expires' : `Cannot approve a request in ${workflow.state ?? workflow.stage}`);
    const approvedAt = new Date();
    workflow.approval = {token: randomUUID(), expiresAt: new Date(approvedAt.getTime() + this.options.approvalTtlMs).toISOString(), used: false, planHash: workflow.plan.hash, approvedBy: operator, approvedAt: approvedAt.toISOString()};
    if (!renewing) transitionWorkflow(workflow, 'APPROVED');
    workflow.plan.status = 'approved'; workflow.stage = 'execution'; workflow.status = 'ready';
    this.options.store.append(requestId, {stage: 'approval', message: `${operator} ${renewing ? 'renewed the expired approval for' : 'approved'} plan ${workflow.plan.hash.slice(0, 12)}…; approval expires ${workflow.approval.expiresAt}.`, actor: 'operator', planHash: workflow.plan.hash, details: {approvalId: workflow.approval.token, approvedBy: operator}});
    await this.persist(requestId);
    return workflow;
  }

  async reject(requestId: string, body: {reason?: unknown} | undefined, identity: string | undefined) {
    const operator = requireOperator(identity);
    const workflow = this.get(requestId);
    if (workflow.stage !== 'approval' || workflow.plan.status !== 'pending_approval') throw new HttpError(409, `Cannot reject a request in ${workflow.state ?? workflow.stage}`);
    const reason = typeof body?.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 500) : undefined;
    transitionWorkflow(workflow, 'REJECTED');
    workflow.plan.status = 'rejected'; workflow.stage = 'report'; workflow.status = 'blocked';
    workflow.rejection = {rejectedBy: operator, rejectedAt: new Date().toISOString(), reason};
    this.options.store.append(requestId, {stage: 'report', message: `${operator} rejected the plan${reason ? `: ${reason}` : ''}. No destructive action ran.`, actor: 'operator', planHash: workflow.plan.hash, details: {rejectedBy: operator, reason}});
    await this.persist(requestId);
    return workflow;
  }

  async execute(requestId: string, body: unknown, identity: string | undefined) {
    const operator = requireOperator(identity);
    const input = body as {approvalId?: unknown; planHash?: unknown} | undefined;
    if (typeof input?.approvalId !== 'string' || typeof input.planHash !== 'string') throw new HttpError(400, 'approvalId and planHash are required');
    const workflow = this.get(requestId);
    if (!workflow.approval) throw new HttpError(409, 'Execution blocked: human approval missing');
    try {
      this.options.guard.authorize({identity: operator, requestId, approvalId: input.approvalId, planHash: input.planHash, authoritativeRequestId: workflow.requestId, authoritativeApprovalId: workflow.approval.token, authoritativePlanHash: workflow.plan.hash});
      this.options.store.append(requestId, {stage: 'execution', message: `${operator} started guarded execution of ${plural(workflow.plan.items.length, 'action')}.`, actor: 'operator', planHash: workflow.plan.hash});
      await executeApprovedWorkflow(workflow, {postgres: this.options.postgres, minio: this.options.minio});
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Execution blocked';
      if (workflow.state === 'EXECUTION_FAILED' || workflow.state === 'VERIFICATION_FAILED') this.options.store.append(requestId, {stage: workflow.state === 'EXECUTION_FAILED' ? 'execution' : 'rescan', message: `${message}. Roll back from the request backup to restore the data.`, planHash: workflow.plan.hash});
      await this.persist(requestId).catch(() => undefined);
      throw new HttpError(409, message);
    }
    await this.persist(requestId);
    return workflow;
  }

  /** Restores the request backup after a failed execution or verification. */
  async rollback(requestId: string, identity: string | undefined) {
    const operator = requireOperator(identity);
    const workflow = this.get(requestId);
    if (workflow.state !== 'EXECUTION_FAILED' && workflow.state !== 'VERIFICATION_FAILED') throw new HttpError(409, `Rollback is only available after a failed execution (request is ${workflow.state ?? workflow.stage})`);
    const results = await Promise.all(this.connectors.map(connector => connector.restoreCustomerData ? connector.restoreCustomerData(workflow.customerId, requestId) : Promise.resolve({system: connector.system.name, restored: 0, details: 'Connector cannot restore'})));
    transitionWorkflow(workflow, 'ROLLED_BACK');
    workflow.stage = 'report'; workflow.status = 'blocked'; workflow.plan.status = 'rejected';
    this.options.store.append(requestId, {stage: 'report', message: `${operator} rolled back from backup: ${results.map(result => result.details).join('; ')}.`, actor: 'operator', planHash: workflow.plan.hash, details: {results}});
    await this.persist(requestId);
    return workflow;
  }

  private async persist(requestId: string) {
    try { await this.options.store.persist(requestId); } catch (error) { throw new HttpError(503, error instanceof Error ? error.message : 'Persistence failed'); }
  }
}
