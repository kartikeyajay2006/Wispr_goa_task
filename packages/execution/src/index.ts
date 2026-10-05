import {createHash} from 'node:crypto';
import type {DeletionAction, ExecutionResult} from '../../../packages/shared/src/index.js';

export type ExecutionContext = {approved: boolean; planHash: string; currentPlanHash: string; approvalExpiresAt: string; approvalUsed: boolean; demoMode: true; authorizationBoundary?: 'guarded'};

export class ExecutionEngine {
  private completed = new Set<string>();
  /** Runs every guard and returns false when the action already ran under this plan (idempotent replay). */
  authorize(action: DeletionAction, ctx: ExecutionContext): boolean {
    if (ctx.authorizationBoundary !== 'guarded') throw new Error('Guarded authorization boundary required');
    if (!ctx.demoMode) throw new Error('Production execution is disabled in demo mode');
    if (!ctx.approved) throw new Error('Human approval required');
    if (ctx.approvalUsed) throw new Error('Approval has already been used');
    if (Date.parse(ctx.approvalExpiresAt) <= Date.now()) throw new Error('Approval has expired');
    if (ctx.planHash !== ctx.currentPlanHash) throw new Error('Approval plan hash does not match current plan');
    if (!action.selector || /[;']/.test(action.selector)) throw new Error('Structured action selector required');
    const actionKey = createHash('sha256').update(`${ctx.planHash}:${action.id}`).digest('hex');
    if (this.completed.has(actionKey)) return false;
    this.completed.add(actionKey);
    return true;
  }
  execute(action: DeletionAction, ctx: ExecutionContext): ExecutionResult {
    const startedAt = new Date().toISOString();
    if (!this.authorize(action, ctx)) return {actionId: action.id, status: 'skipped', startedAt, completedAt: new Date().toISOString(), affectedRecords: 0};
    return {actionId: action.id, status: 'completed', startedAt, completedAt: new Date().toISOString(), affectedRecords: action.recordCount};
  }
}

export function assertRescanVerified(results: {system: string; remainingMatches: number; verified: boolean}[]) {
  const failures = results.filter(result => !result.verified || result.remainingMatches !== 0);
  if (failures.length) throw new Error(`Post-execution verification failed: ${failures.map(result => `${result.system}=${result.remainingMatches}`).join(', ')}`);
  return true;
}

export class ExecutionLedger {
  private readonly results = new Map<string, ExecutionResult>();
  record(planHash: string, result: ExecutionResult) { const key = createHash('sha256').update(`${planHash}:${result.actionId}`).digest('hex'); if (!this.results.has(key)) this.results.set(key, result); return this.results.get(key)!; }
  all() { return [...this.results.values()]; }
}
