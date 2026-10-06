import {describe, expect, it} from 'vitest';
import {createMockConnectors} from '../../../../packages/connectors/src/index.js';
import {InMemoryRuntimeStore} from '../runtime-store.js';
import {DestructiveRequestGuard} from '../destructive-guard.js';
import {WorkflowService} from '../workflow-service.js';
import {listCustomers} from '../read-models.js';
import {loadConfig} from '../config.js';
import {createAiEngine, type BetaMessage, type CreateParams} from './claude.js';
import {ErasureAgent, type AgentEvent} from './graph.js';

const context = {demoMode: true as const, allowlistedHosts: ['postgres'], allowlistedBuckets: ['customer-uploads', 'support-attachments', 'exports']};

function setup(messages?: {create(params: CreateParams): Promise<BetaMessage>}) {
  const {dataset, postgres, minio} = createMockConnectors();
  const store = new InMemoryRuntimeStore();
  const workflows = new WorkflowService({postgres, minio, store, guard: new DestructiveRequestGuard(), context, approvalTtlMs: 60_000});
  const deps = {postgres, minio, store, context, config: loadConfig({})};
  const engine = messages ? createAiEngine({mode: 'claude', model: 'claude-opus-5-5'}, {}, messages) : createAiEngine({mode: 'auto', model: 'claude-opus-5-5'}, {});
  const agent = new ErasureAgent({engine, workflows, tools: {runtime: {postgres, minio}, customers: () => listCustomers(deps)}});
  return {agent, workflows, dataset};
}
const collect = async (events: AsyncIterable<AgentEvent>) => { const out: AgentEvent[] = []; for await (const event of events) out.push(event); return out; };
const of = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) => events.filter((event): event is Extract<AgentEvent, {type: T}> => event.type === type);

describe('LangGraph erasure agent (rule-based engine)', () => {
  it('investigates, proposes, pauses for a human, then executes and verifies', async () => {
    const {agent, workflows, dataset} = setup();
    const run = agent.start("can you wipe Mira's data?", 'ops');
    const first = await collect(run.events);
    expect(first[0]).toMatchObject({type: 'run', engine: 'rules'});
    expect(of(first, 'intent')[0].intent).toMatchObject({action: 'erase', customerId: 'CUST-1042'});
    expect(of(first, 'tool').filter(event => event.status === 'end').map(event => event.tool)).toEqual(['discover_customer_postgres', 'discover_customer_s3', 'calculate_dependencies', 'rescan_customer']);
    expect(of(first, 'node').filter(event => event.status === 'start').map(event => event.label)).toEqual(['Intake agent', 'Discovery agent', 'Risk agent', 'Planner', 'Reporter']);
    expect(of(first, 'briefing')[0].briefing).toMatchObject({headline: 'Plan ready for CUST-1042', nextStep: 'Review the plan and type CUST-1042 to approve it.'});
    const approval = of(first, 'approval')[0].approval;
    expect(approval).toMatchObject({customerId: 'CUST-1042', deletable: 9, anonymized: 3});
    expect(first.at(-1)).toEqual({type: 'done', status: 'awaiting_approval', requestId: approval.requestId});
    // Paused: nothing has been deleted yet.
    expect(dataset.ownedRows('users', 'CUST-1042')).toHaveLength(1);
    expect(workflows.get(approval.requestId).state).toBe('AWAITING_HUMAN_APPROVAL');

    const second = await collect(agent.resume(run.threadId, {action: 'approve', operator: 'dpo', confirmation: 'CUST-1042'}));
    expect(of(second, 'node').filter(event => event.status === 'start').map(event => event.label)).toEqual(['Executor', 'Reporter']);
    expect(of(second, 'briefing')[0].briefing.headline).toBe('CUST-1042 erased and verified');
    expect(second.at(-1)).toMatchObject({type: 'done', status: 'completed'});
    expect(workflows.get(approval.requestId)).toMatchObject({state: 'COMPLETED', approval: {approvedBy: 'dpo'}});
    expect(dataset.ownedRows('users', 'CUST-1042')).toHaveLength(0);
    expect(agent.record(run.threadId)).toMatchObject({status: 'completed', customerId: 'CUST-1042', requestId: approval.requestId});
  });

  it('lets the sandbox block a shared workspace without asking for approval', async () => {
    const {agent} = setup();
    const events = await collect(agent.start('erase customer 9001', 'ops').events);
    expect(of(events, 'assessment')[0].assessment).toMatchObject({risk: 'high'});
    expect(of(events, 'assessment')[0].assessment.blockers[0]).toContain('CUST-9002');
    expect(of(events, 'request')[0]).toMatchObject({state: 'SANDBOX_FAILED', status: 'blocked'});
    expect(of(events, 'approval')).toHaveLength(0);
    expect(of(events, 'briefing')[0].briefing.headline).toBe('CUST-9001 is blocked by the sandbox');
  });

  it('answers questions without opening a request', async () => {
    const {agent, workflows} = setup();
    const events = await collect(agent.start("who depends on Priya's data?", 'ops').events);
    expect(of(events, 'intent')[0].intent.action).toBe('investigate');
    expect(of(events, 'request')).toHaveLength(0);
    expect(of(events, 'briefing')[0].briefing.nextStep).toContain('Resolve the shared data');
    expect(() => workflows.get('missing')).toThrow('not found');
  });

  it('records a rejection and changes nothing', async () => {
    const {agent, dataset} = setup();
    const run = agent.start('forget customer 2088', 'ops');
    await collect(run.events);
    const events = await collect(agent.resume(run.threadId, {action: 'reject', operator: 'dpo', reason: 'Legal hold'}));
    expect(of(events, 'request')[0]).toMatchObject({state: 'REJECTED'});
    expect(of(events, 'briefing')[0].briefing.headline).toBe('Plan rejected; nothing changed');
    expect(dataset.ownedRows('users', 'CUST-2088')).toHaveLength(1);
  });

  it('asks which customer when the name is ambiguous, and refuses to resume a finished run', async () => {
    const {agent} = setup();
    const run = agent.start('erase someone please', 'ops');
    const events = await collect(run.events);
    expect(of(events, 'briefing')[0].briefing.headline).toBe('I need a customer to work on');
    expect(() => agent.resume(run.threadId, {action: 'approve', operator: 'x', confirmation: 'CUST-1042'})).toThrow('not waiting for approval');
  });
});

describe('LangGraph erasure agent (Claude engine, scripted)', () => {
  const reply = (content: unknown[], stop: BetaMessage['stop_reason']) => ({id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: stop, stop_sequence: null, stop_details: null, usage: {input_tokens: 1, output_tokens: 1}} as unknown as BetaMessage);
  const json = (value: unknown) => reply([{type: 'text', text: JSON.stringify(value), citations: null}], 'end_turn');

  function scriptedClaude(investigation: BetaMessage[]) {
    const calls: CreateParams[] = [];
    return {calls, client: {create: async (params: CreateParams) => {
      calls.push(params);
      const schema = (params.output_config?.format as {schema?: {properties?: Record<string, unknown>}} | undefined)?.schema?.properties ?? {};
      if ('action' in schema) return json({action: 'erase', customerId: 'CUST-1042', candidates: [], tab: null, page: null, readback: 'Open an erasure request for CUST-1042 (Mira K.)', confidence: 'high'});
      if ('risk' in schema) return json({risk: 'low', blockers: [], notes: ['4 resources are kept for tax and audit reasons']});
      if ('headline' in schema) return json({headline: 'Plan ready for CUST-1042', summary: '9 records to delete and 3 to redact.', findings: ['Data in 11 tables and 3 buckets'], risks: [], nextStep: 'Type CUST-1042 to approve.'});
      return investigation.shift()!;
    }}};
  }

  it('lets Claude choose read-only MCP tools and refuses a destructive call it was never given', async () => {
    const {client, calls} = scriptedClaude([
      reply([{type: 'thinking', thinking: 'Check both systems and look for shared rows first.', signature: 's'}, {type: 'tool_use', id: 't1', name: 'discover_customer_postgres', input: {customerId: 'CUST-1042'}}, {type: 'tool_use', id: 't2', name: 'calculate_dependencies', input: {customerId: 'CUST-1042'}}], 'tool_use'),
      reply([{type: 'tool_use', id: 't3', name: 'delete_postgres_records', input: {customerId: 'CUST-1042', resource: 'users'}}], 'tool_use'),
      reply([{type: 'text', text: '- 11 PostgreSQL tables hold 12 records\n- No other customer depends on this data', citations: null}], 'end_turn'),
    ]);
    const {agent, dataset} = setup(client);
    const events = await collect(agent.start('please take Mira out of all our systems', 'ops').events);

    expect(events[0]).toMatchObject({type: 'run', engine: 'claude', model: 'claude-opus-5-5'});
    expect(of(events, 'reasoning').map(event => event.text)).toContain('Check both systems and look for shared rows first.');
    const refused = of(events, 'tool').find(event => event.tool === 'delete_postgres_records' && event.status === 'end');
    expect(refused).toMatchObject({ok: false, summary: 'delete_postgres_records refused: agents cannot run destructive tools'});
    expect(dataset.ownedRows('users', 'CUST-1042')).toHaveLength(1);
    expect(of(events, 'approval')[0].approval.customerId).toBe('CUST-1042');
    expect(of(events, 'briefing')[0]).toMatchObject({engine: 'claude', briefing: {headline: 'Plan ready for CUST-1042'}});

    const investigateCalls = calls.filter(call => call.tools);
    expect(investigateCalls[0]).toMatchObject({model: 'claude-opus-5-5', fallbacks: 'default', thinking: {type: 'adaptive', display: 'summarized'}, output_config: {effort: 'medium'}});
    expect(investigateCalls[0].tools!.map(tool => (tool as {name: string}).name)).not.toContain('delete_postgres_records');
    // The refused call went back to Claude as an error result, appended after the unchanged assistant turn.
    const third = investigateCalls[2].messages;
    expect(third.at(-1)).toMatchObject({role: 'user', content: [{type: 'tool_result', tool_use_id: 't3', is_error: true}]});
    expect(third.at(-2)).toMatchObject({role: 'assistant'});
  });

  it('keeps known blockers even if the model calls the risk low', async () => {
    const {client} = scriptedClaude([reply([{type: 'tool_use', id: 't1', name: 'calculate_dependencies', input: {customerId: 'CUST-9001'}}], 'tool_use'), reply([{type: 'text', text: '- done', citations: null}], 'end_turn')]);
    const overridden = {create: async (params: CreateParams) => { const schema = (params.output_config?.format as {schema?: {properties?: Record<string, unknown>}} | undefined)?.schema?.properties ?? {}; return 'action' in schema ? json({action: 'investigate', customerId: 'CUST-9001', candidates: [], tab: null, page: null, readback: 'Investigate CUST-9001', confidence: 'high'}) : client.create(params); }};
    const {agent} = setup(overridden);
    const events = await collect(agent.start('is it safe to erase 9001?', 'ops').events);
    expect(of(events, 'assessment')[0].assessment.risk).toBe('high');
    expect(of(events, 'assessment')[0].assessment.blockers.join(' ')).toContain('CUST-9002');
  });

  it('falls back to the rule-based investigation when Claude fails mid-run', async () => {
    let call = 0;
    const flaky = {create: async (params: CreateParams) => { call++; if (params.tools) throw new Error('socket hang up'); const schema = (params.output_config?.format as {schema?: {properties?: Record<string, unknown>}} | undefined)?.schema?.properties ?? {}; if ('action' in schema) return json({action: 'erase', customerId: 'CUST-4410', candidates: [], tab: null, page: null, readback: 'Erase CUST-4410', confidence: 'high'}); throw new Error('still down'); }};
    const {agent} = setup(flaky);
    const events = await collect(agent.start('erase customer 4410', 'ops').events);
    expect(of(events, 'reasoning').some(event => event.text.includes('Continuing with the rule-based investigation'))).toBe(true);
    expect(of(events, 'tool').filter(event => event.status === 'end')).toHaveLength(4);
    expect(of(events, 'approval')).toHaveLength(1);
    expect(of(events, 'briefing')[0].engine).toBe('rules');
    expect(call).toBeGreaterThan(1);
  });
});
