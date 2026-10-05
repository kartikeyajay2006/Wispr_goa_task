import {createHash} from 'node:crypto';
import type {DeletionAction, SimulationReport} from '../../../packages/shared/src/index.js';

export type SandboxResult = {id: string; planHash: string; status: 'passed' | 'failed'; tests: string[]; warnings: string[]; failures: string[]; executedAt: string; fixtureHash: string; simulations: SimulationReport[]};

/**
 * Combines static plan checks with simulation reports from each connector. A connector
 * simulation applies the plan to an isolated copy, so its failures are evidence, not guesses.
 */
export function verifyPlanInSandbox(input: {customerId: string; planHash: string; actions: DeletionAction[]; simulations?: SimulationReport[]}): SandboxResult {
  const tests = ['Selectors are parameterized', 'Every action targets only the requested customer', 'Every destructive action has verification criteria'];
  const failures: string[] = [];
  const warnings: string[] = [];
  for (const action of input.actions) {
    if (!action.selector || /[;']/.test(action.selector)) failures.push(`${action.id}: invalid structured selector`);
    if (!action.verification) failures.push(`${action.id}: missing post-action verification`);
    const foreignIds = [...`${action.selector} ${action.id}`.matchAll(/CUST-\d{4}/g)].map(match => match[0]).filter(id => id !== input.customerId);
    if (foreignIds.length) failures.push(`${action.id}: cross-customer target ${[...new Set(foreignIds)].join(', ')}`);
  }
  if (!input.actions.length) warnings.push('Plan contains no actions');
  const simulations = input.simulations ?? [];
  for (const simulation of simulations) {
    tests.push(...simulation.checks.map(check => `${simulation.system}: ${check}`));
    failures.push(...simulation.failures.map(failure => `${simulation.system}: ${failure}`));
    warnings.push(...simulation.warnings.map(warning => `${simulation.system}: ${warning}`));
  }
  if (!simulations.length) warnings.push('No connector simulation was available; only static checks ran');
  const fixtureHash = createHash('sha256').update(JSON.stringify({customerId: input.customerId, actions: input.actions, simulations})).digest('hex');
  return {id: `sandbox-${fixtureHash.slice(0, 12)}`, planHash: input.planHash, status: failures.length ? 'failed' : 'passed', tests, warnings, failures, executedAt: new Date().toISOString(), fixtureHash, simulations};
}
