import {describe, it, expect} from 'vitest';
import {verifyPlanInSandbox} from './index';

const action = {id: 'pg:customers:CUST-1042', system: 'PostgreSQL', resource: 'customers', actionType: 'delete' as const, selector: 'customer_id = $1', reason: 'erasure', recordCount: 1, reversible: false, risk: 'high' as const, dependencies: [], verification: 'rescan customer'};
const simulation = {system: 'PostgreSQL', mode: 'dataset-clone' as const, checks: ['Referential integrity holds after the plan'], failures: [] as string[], warnings: [] as string[], affected: 1, residualAfter: 0};

describe('sandbox verification', () => {
  it('passes a parameterized plan whose simulation is clean', () => {
    const result = verifyPlanInSandbox({customerId: 'CUST-1042', planHash: 'h', actions: [action], simulations: [simulation]});
    expect(result.status).toBe('passed');
    expect(result.tests).toContain('PostgreSQL: Referential integrity holds after the plan');
  });
  it('fails when a connector simulation finds unrelated customers affected', () => {
    const result = verifyPlanInSandbox({customerId: 'CUST-9001', planHash: 'h', actions: [{...action, id: 'pg:organizations:CUST-9001', resource: 'organizations'}], simulations: [{...simulation, failures: ['Deleting organizations ORG-501 would orphan 2 records in organization_members that belong to unrelated customers (CUST-9002, CUST-9003)']}]});
    expect(result.status).toBe('failed');
    expect(result.failures.join(' ')).toContain('unrelated customers');
  });
  it('blocks actions that target another customer', () => {
    const result = verifyPlanInSandbox({customerId: 'CUST-1042', planHash: 'h', actions: [{...action, id: 'pg:users:CUST-2088'}], simulations: [simulation]});
    expect(result.failures).toEqual(['pg:users:CUST-2088: cross-customer target CUST-2088']);
  });
  it('blocks missing verification criteria', () => expect(verifyPlanInSandbox({customerId: 'CUST-1042', planHash: 'h', actions: [{...action, verification: ''}], simulations: [simulation]}).status).toBe('failed'));
  it('warns when only static checks could run', () => expect(verifyPlanInSandbox({customerId: 'CUST-1042', planHash: 'h', actions: [action]}).warnings).toContain('No connector simulation was available; only static checks ran'));
});
