import type OpenAI from 'openai';
import {describe, expect, it} from 'vitest';
import {createMockConnectors} from '../../../../packages/connectors/src/index.js';
import {InMemoryRuntimeStore} from '../runtime-store.js';
import {DestructiveRequestGuard} from '../destructive-guard.js';
import {WorkflowService} from '../workflow-service.js';
import {listCustomers} from '../read-models.js';
import {loadConfig} from '../config.js';
import {createAiEngine, describeAiError, type CreateParams} from './claude.js';
import {ErasureAgent, type AgentEvent} from './graph.js';
import {DEFAULT_OPENAI_MODEL, fromResponse, openAiMessages, strictReady, toResponsesInput, toResponsesParams, type ResponsesClient} from './openai.js';

type Params = OpenAI.Responses.ResponseCreateParamsNonStreaming;
const response = (output: unknown[], extra: Record<string, unknown> = {}) => ({id: 'resp', object: 'response', model: 'gpt-5.5', status: 'completed', output, usage: {input_tokens: 10, output_tokens: 5}, ...extra}) as unknown as OpenAI.Responses.Response;
const text = (value: string) => ({type: 'message', id: 'msg', role: 'assistant', status: 'completed', content: [{type: 'output_text', text: value, annotations: []}]});
const call = (callId: string, name: string, args: unknown) => ({type: 'function_call', id: `fc_${callId}`, call_id: callId, name, arguments: JSON.stringify(args), status: 'completed'});
const reasoning = (summary: string, encrypted: string) => ({type: 'reasoning', id: `rs_${encrypted}`, summary: [{type: 'summary_text', text: summary}], encrypted_content: encrypted});
const closed = {type: 'object', additionalProperties: false, required: ['risk'], properties: {risk: {type: 'string', enum: ['low', 'high']}}};

describe('choosing the model provider', () => {
  it('runs the agents on OpenAI when OPENAI_API_KEY is set', () => {
    expect(createAiEngine({mode: 'auto', model: 'claude-opus-5-5'}, {OPENAI_API_KEY: 'sk-test'})).toMatchObject({kind: 'claude', provider: 'openai', model: DEFAULT_OPENAI_MODEL});
    expect(createAiEngine({mode: 'auto', model: 'claude-opus-5-5'}, {OPENAI_API_KEY: 'sk-test', OPENAI_MODEL: 'gpt-5.4-mini'})).toMatchObject({provider: 'openai', model: 'gpt-5.4-mini'});
  });

  it('falls back to rules without a key, and when turned off', () => {
    expect(createAiEngine({mode: 'auto', model: 'm'}, {})).toEqual({kind: 'rules', reason: 'Set OPENAI_API_KEY to let OpenAI run the agents'});
    expect(createAiEngine({mode: 'off', model: 'm'}, {OPENAI_API_KEY: 'sk-test'})).toMatchObject({kind: 'rules'});
  });
});

describe('translating agent calls to the Responses API', () => {
  const base: CreateParams = {model: 'gpt-5.5', max_tokens: 4096, system: 'You are the risk agent.', messages: [{role: 'user', content: 'Assess CUST-9001'}]};

  it('maps instructions, effort, schema and privacy settings', () => {
    const params = toResponsesParams({...base, output_config: {effort: 'low', format: {type: 'json_schema', schema: closed}}});
    expect(params).toMatchObject({model: 'gpt-5.5', instructions: 'You are the risk agent.', max_output_tokens: 4096, reasoning: {effort: 'low'}, store: false, include: ['reasoning.encrypted_content'], text: {format: {type: 'json_schema', name: 'answer', schema: closed, strict: true}}});
    expect(params.input).toEqual([{role: 'user', content: 'Assess CUST-9001'}]);
    expect(params.reasoning).not.toHaveProperty('summary');
  });

  it('asks for reasoning summaries and maps tools without strict mode', () => {
    const params = toResponsesParams({...base, thinking: {type: 'adaptive', display: 'summarized'}, output_config: {effort: 'medium'}, tools: [{name: 'rescan_customer', description: 'Counts personal data left', input_schema: {type: 'object', properties: {customerId: {type: 'string'}}, required: ['customerId']}}]});
    expect(params.reasoning).toEqual({effort: 'medium', summary: 'auto'});
    expect(params.tools).toEqual([{type: 'function', name: 'rescan_customer', description: 'Counts personal data left', parameters: {type: 'object', properties: {customerId: {type: 'string'}}, required: ['customerId']}, strict: false}]);
    expect(toResponsesParams(base, false).reasoning).toEqual({effort: 'medium'});
  });

  it('uses strict structured outputs only for closed schemas', () => {
    expect(strictReady(closed)).toBe(true);
    expect(strictReady({type: 'object', additionalProperties: false, required: [], properties: {tab: {type: 'string'}}})).toBe(false);
    expect(strictReady({type: 'object', required: ['a'], properties: {a: {type: 'array', items: {type: 'object', properties: {b: {type: 'string'}}}}}})).toBe(false);
  });

  it('turns tool calls and results into function call items, marking errors', () => {
    expect(toResponsesInput([
      {role: 'assistant', content: [{type: 'tool_use', id: 'c1', name: 'rescan_customer', input: {customerId: 'CUST-1042'}}]},
      {role: 'user', content: [{type: 'tool_result', tool_use_id: 'c1', content: '[{"remainingMatches":3}]'}, {type: 'tool_result', tool_use_id: 'c2', is_error: true, content: [{type: 'text', text: 'refused'}]}]},
    ])).toEqual([
      {type: 'function_call', call_id: 'c1', name: 'rescan_customer', arguments: '{"customerId":"CUST-1042"}'},
      {type: 'function_call_output', call_id: 'c1', output: '[{"remainingMatches":3}]'},
      {type: 'function_call_output', call_id: 'c2', output: 'ERROR: refused'},
    ]);
  });
});

describe('reading Responses API output', () => {
  it('surfaces reasoning summaries, tool calls and text, and replays the turn exactly', () => {
    const output = [reasoning('Check shared rows first.', 'enc1'), call('c1', 'calculate_dependencies', {customerId: 'CUST-9001'})];
    const message = fromResponse(response(output));
    expect(message.stop_reason).toBe('tool_use');
    expect(message.content).toMatchObject([{type: 'thinking', thinking: 'Check shared rows first.'}, {type: 'tool_use', id: 'c1', name: 'calculate_dependencies', input: {customerId: 'CUST-9001'}}]);
    // The next turn sends back the raw items, encrypted reasoning included, so the model keeps its chain of thought.
    expect(toResponsesInput([{role: 'assistant', content: message.content as never}])).toEqual(output);
    expect(fromResponse(response([text('- done')])).content.at(-1)).toMatchObject({type: 'text', text: '- done'});
  });

  it('turns bold reasoning titles into plain text', () => {
    expect(fromResponse(response([reasoning('**Gathering footprint**\n\nI need both systems and **shared** rows.', 'e')])).content[0]).toMatchObject({type: 'thinking', thinking: 'Gathering footprint: I need both systems and shared rows.'});
  });

  it('maps stop reasons and failures', () => {
    expect(fromResponse(response([text('- done')])).stop_reason).toBe('end_turn');
    expect(fromResponse(response([text('{"ri')], {status: 'incomplete', incomplete_details: {reason: 'max_output_tokens'}})).stop_reason).toBe('max_tokens');
    expect(fromResponse(response([{type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{type: 'refusal', refusal: 'No.'}]}])).stop_reason).toBe('refusal');
    expect(() => fromResponse(response([], {status: 'failed', error: {code: 'server_error', message: 'overloaded'}}))).toThrow('OpenAI could not finish the response: overloaded');
    expect(describeAiError(new Error('socket hang up'))).toBe('socket hang up');
  });
});

describe('LangGraph erasure agent on OpenAI (scripted)', () => {
  function setup(client: ResponsesClient) {
    const {dataset, postgres, minio} = createMockConnectors();
    const workflows = new WorkflowService({postgres, minio, store: new InMemoryRuntimeStore(), guard: new DestructiveRequestGuard(), context: {demoMode: true, allowlistedHosts: ['postgres'], allowlistedBuckets: ['customer-uploads', 'support-attachments', 'exports']}, approvalTtlMs: 60_000});
    const deps = {postgres, minio, store: new InMemoryRuntimeStore(), context: {demoMode: true as const, allowlistedHosts: ['postgres'], allowlistedBuckets: ['customer-uploads']}, config: loadConfig({})};
    const engine = createAiEngine({mode: 'claude', model: 'gpt-5.5'}, {}, openAiMessages(client), 'openai');
    return {agent: new ErasureAgent({engine, workflows, tools: {runtime: {postgres, minio}, customers: () => listCustomers(deps)}}), dataset};
  }

  it('investigates with OpenAI tool calls, keeps reasoning between turns, and still stops for a human', async () => {
    const calls: Params[] = [];
    const investigation = [
      response([reasoning('Look at both systems and shared rows.', 'enc1'), call('c1', 'discover_customer_postgres', {customerId: 'CUST-1042'}), call('c2', 'calculate_dependencies', {customerId: 'CUST-1042'})]),
      response([text('- 11 PostgreSQL tables hold 12 records\n- No other customer depends on this data')]),
    ];
    const client: ResponsesClient = {create: async params => {
      calls.push(params);
      const schema = (params.text?.format as {schema?: {properties?: Record<string, unknown>}} | undefined)?.schema?.properties ?? {};
      if ('action' in schema) return response([text(JSON.stringify({action: 'erase', customerId: 'CUST-1042', candidates: [], tab: null, page: null, readback: 'Open an erasure request for CUST-1042 (Mira K.)', confidence: 'high'}))]);
      if ('risk' in schema) return response([text(JSON.stringify({risk: 'low', blockers: [], notes: ['4 resources are kept for tax and audit reasons']}))]);
      if ('headline' in schema) return response([text(JSON.stringify({headline: 'Plan ready for CUST-1042', summary: '9 records to delete and 3 to redact.', findings: [], risks: [], nextStep: 'Type CUST-1042 to approve.'}))]);
      return investigation.shift()!;
    }};
    const {agent, dataset} = setup(client);
    const events: AgentEvent[] = [];
    for await (const event of agent.start("can you wipe Mira's data?", 'ops').events) events.push(event);

    expect(events[0]).toMatchObject({type: 'run', engine: 'claude', model: 'gpt-5.5'});
    expect(events.some(event => event.type === 'reasoning' && event.text === 'Look at both systems and shared rows.')).toBe(true);
    expect(events.filter(event => event.type === 'tool' && event.status === 'end').map(event => event.type === 'tool' && [event.tool, event.ok])).toEqual([['discover_customer_postgres', true], ['calculate_dependencies', true]]);
    expect(events.find(event => event.type === 'briefing')).toMatchObject({engine: 'claude', briefing: {headline: 'Plan ready for CUST-1042'}});
    expect(events.find(event => event.type === 'approval')).toMatchObject({approval: {customerId: 'CUST-1042'}});
    expect(dataset.ownedRows('users', 'CUST-1042')).toHaveLength(1);

    expect(calls.every(params => params.store === false)).toBe(true);
    const turns = calls.filter(params => params.tools);
    expect(turns[0].tools!.map(tool => (tool as {name: string}).name)).not.toContain('delete_postgres_records');
    const second = turns[1].input as Array<Record<string, unknown>>;
    expect(second.slice(1, 4)).toMatchObject([{type: 'reasoning', encrypted_content: 'enc1'}, {type: 'function_call', call_id: 'c1'}, {type: 'function_call', call_id: 'c2'}]);
    expect(second.slice(4).map(item => [item.type, item.call_id])).toEqual([['function_call_output', 'c1'], ['function_call_output', 'c2']]);
  });
});
