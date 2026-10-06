import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import type {AddressInfo} from 'node:net';
import type {Server} from 'node:http';
import {app} from './server.js';

let server: Server;
let base = '';
const operator = {'content-type': 'application/json', 'x-operator-identity': 'test-operator'};
const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = operator) => {
  const response = await fetch(`${base}${path}`, {method, headers, body: body === undefined ? undefined : JSON.stringify(body)});
  return {status: response.status, body: await response.json() as any};
};
const create = (customerId: string, extra: Record<string, unknown> = {}) => call('POST', '/api/requests', {customerId, reason: 'Customer erasure request', dryRun: false, ...extra});

beforeAll(async () => { server = app.listen(0); await new Promise(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
afterAll(() => new Promise(resolve => server.close(resolve)));
beforeEach(async () => { await call('POST', '/api/demo/reset'); });

describe('HTTP erasure lifecycle', () => {
  it('erases a customer end to end and the next discovery reflects it', async () => {
    const created = await create('CUST-1042');
    expect(created.status).toBe(201);
    expect(created.body.request.requestedBy).toBe('test-operator');
    const id = created.body.requestId;
    expect((await call('GET', `/api/requests/${id}/verification`)).body.remainingMatches).toBe(12);

    const approved = await call('POST', `/api/requests/${id}/approve`, {confirmation: 'CUST-1042'});
    expect(approved.status).toBe(200);
    expect(approved.body.approval.approvedBy).toBe('test-operator');

    const executed = await call('POST', `/api/requests/${id}/execute-guarded`, {approvalId: approved.body.approval.token, planHash: approved.body.plan.hash});
    expect(executed.status).toBe(200);
    expect(executed.body.state).toBe('COMPLETED');
    expect(executed.body.verification.remainingMatches).toBe(0);

    const rescan = await call('GET', `/api/requests/${id}/verification`);
    expect(rescan.body).toMatchObject({verified: true, remainingMatches: 0});
    const report = await call('GET', `/api/requests/${id}/report`);
    expect(report.body.verification).toMatchObject({postgres: true, minio: true, remainingMatches: 0});
    expect(report.body.metrics.totalExecutionTimeMs).toBeGreaterThanOrEqual(0);
    expect((await call('GET', `/api/requests/${id}/audit`)).body.chain.valid).toBe(true);

    const again = await create('CUST-1042');
    expect(again.status).toBe(201);
    expect(again.body.assets.every((asset: any) => asset.classification !== 'deletable')).toBe(true);
    expect(again.body.blastRadius.deletable).toBe(0);
  });

  it('requires an operator identity for approval and execution', async () => {
    const created = await create('CUST-2088');
    const anonymous = await call('POST', `/api/requests/${created.body.requestId}/approve`, {confirmation: 'CUST-2088'}, {'content-type': 'application/json'});
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error).toContain('Operator identity required');
  });

  it('records the rejecting operator and leaves data untouched', async () => {
    const created = await create('CUST-2088');
    const rejected = await call('POST', `/api/requests/${created.body.requestId}/reject`, {reason: 'Legal hold pending'});
    expect(rejected.body).toMatchObject({status: 'blocked', state: 'REJECTED', rejection: {rejectedBy: 'test-operator', reason: 'Legal hold pending'}});
    expect((await call('GET', `/api/requests/${created.body.requestId}/verification`)).body.verified).toBe(false);
  });

  it('keeps dry runs review-only', async () => {
    const created = await create('CUST-1042', {dryRun: true});
    const approve = await call('POST', `/api/requests/${created.body.requestId}/approve`, {confirmation: 'CUST-1042'});
    expect(approve.status).toBe(409);
    expect(approve.body.error).toContain('Dry-run');
  });

  it('blocks shared and unbackupable footprints before approval, based on the data', async () => {
    const shared = await create('CUST-9001');
    expect(shared.body).toMatchObject({status: 'blocked', stage: 'sandbox', state: 'SANDBOX_FAILED'});
    expect(shared.body.sandbox.failures.join(' ')).toContain('unrelated customers (CUST-9002, CUST-9003)');
    const member = await create('CUST-9002');
    expect(member.body.status).toBe('awaiting_approval');
    const archived = await create('CUST-7001');
    expect(archived.body).toMatchObject({status: 'blocked', stage: 'backup', backupVerified: false});
    expect(archived.body.backupFailures[0]).toContain('ARCHIVE storage');
  });

  it('answers 404 for a customer with no personal data and 400 for a malformed ID', async () => {
    expect(await create('CUST-5555')).toMatchObject({status: 404, body: {error: 'No personal data found for CUST-5555 in PostgreSQL or MinIO'}});
    expect((await create('bob')).status).toBe(400);
  });

  it('refuses rollback unless an execution failed', async () => {
    const created = await create('CUST-2088');
    const rollback = await call('POST', `/api/requests/${created.body.requestId}/rollback`);
    expect(rollback.status).toBe(409);
  });

  it('resets the dataset to the fixture', async () => {
    const created = await create('CUST-4410');
    const approved = await call('POST', `/api/requests/${created.body.requestId}/approve`, {confirmation: 'CUST-4410'});
    await call('POST', `/api/requests/${created.body.requestId}/execute-guarded`, {approvalId: approved.body.approval.token, planHash: approved.body.plan.hash});
    expect((await create('CUST-4410')).body.blastRadius.deletable).toBe(0);
    await call('POST', '/api/demo/reset');
    expect((await create('CUST-4410')).body.blastRadius.deletable).toBe(2);
  });
});

describe('HTTP read models', () => {
  it('lists every customer in the systems with a live footprint and masked identity', async () => {
    const {body} = await call('GET', '/api/customers');
    expect(body.map((customer: any) => customer.customerId)).toEqual(['CUST-1042', 'CUST-2088', 'CUST-3175', 'CUST-4410', 'CUST-7001', 'CUST-9001', 'CUST-9002', 'CUST-9003']);
    const mira = body.find((customer: any) => customer.customerId === 'CUST-1042');
    expect(mira).toMatchObject({displayName: 'Mira K.', status: 'active', residual: 12, footprint: {records: 16, resources: 14, systems: ['PostgreSQL', 'MinIO']}});
    expect(mira.email).toMatch(/^m•+@example\.invalid$/);
    expect(body.find((customer: any) => customer.customerId === 'CUST-9001').signals[0]).toBe('Owns organizations that 2 other customers depend on (CUST-9002, CUST-9003)');
  });

  it('marks a customer erased once execution succeeds and hides the redacted name', async () => {
    const created = await create('CUST-4410');
    const approved = await call('POST', `/api/requests/${created.body.requestId}/approve`, {confirmation: 'CUST-4410'});
    await call('POST', `/api/requests/${created.body.requestId}/execute-guarded`, {approvalId: approved.body.approval.token, planHash: approved.body.plan.hash});
    const daniel = (await call('GET', '/api/customers')).body.find((customer: any) => customer.customerId === 'CUST-4410');
    expect(daniel).toMatchObject({status: 'erased', residual: 0, latestRequest: {state: 'COMPLETED'}});
    expect(daniel.displayName).toBeUndefined();
    const overview = (await call('GET', '/api/overview')).body;
    expect(overview.customers.erased).toBe(1);
    expect(overview.requests.executed).toBe(1);
    expect(overview.records.changed).toBe(3);
    expect(overview.audit.verified).toBe(overview.audit.chains);
  });

  it('lists requests newest first with blocking reasons', async () => {
    await create('CUST-7001');
    await create('CUST-2088');
    const {body} = await call('GET', '/api/requests');
    expect(body.map((request: any) => request.customerId)).toEqual(['CUST-2088', 'CUST-7001']);
    expect(body[1].blockedBy).toContain('ARCHIVE storage');
  });

  it('reports system inventory, policy rules and the audit log from live state', async () => {
    const systems = (await call('GET', '/api/systems')).body;
    expect(systems.map((system: any) => system.name)).toEqual(['PostgreSQL', 'MinIO']);
    expect(systems[0].inventory.find((entry: any) => entry.resource === 'analytics_events').records).toBe(20);
    const policies = (await call('GET', '/api/policies')).body;
    expect(policies.rules.find((rule: any) => rule.resource === 'orders')).toMatchObject({classification: 'retain', retention: '7 years'});
    expect(policies.controls.approvalTtlMinutes).toBe(15);
    await create('CUST-2088');
    const audit = (await call('GET', '/api/audit')).body;
    expect(audit.events[0].customerId).toBe('CUST-2088');
    expect(audit.chains.every((chain: any) => chain.valid)).toBe(true);
  });

  it('returns JSON 404 for unknown routes and requests', async () => {
    expect((await call('GET', '/api/nope')).status).toBe(404);
    expect((await call('GET', '/api/requests/00000000-0000-4000-8000-000000000000')).body.error).toContain('not found');
  });
});

describe('HTTP assistant', () => {
  it('reports which engine reads commands', async () => {
    const {body} = await call('GET', '/api/assistant/status');
    expect(body).toEqual({engine: 'rules', reason: 'Set ANTHROPIC_API_KEY to let Claude run the agents'});
  });
  it('reads natural commands against the live customer list', async () => {
    const {status, body} = await call('POST', '/api/assistant/interpret', {text: "can you wipe Mira's data?"});
    expect(status).toBe(200);
    expect(body).toMatchObject({engine: 'rules', intent: {action: 'erase', customerId: 'CUST-1042', readback: 'Open an erasure request for CUST-1042 (Mira K.)'}});
  });
  it('rejects empty commands', async () => expect((await call('POST', '/api/assistant/interpret', {text: '  '})).status).toBe(400));
});
