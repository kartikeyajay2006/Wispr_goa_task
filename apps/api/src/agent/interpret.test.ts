import {describe, expect, it} from 'vitest';
import {createAiEngine, type BetaMessage, type CreateParams} from './claude.js';
import {interpretCommand, interpretWithRules} from './interpret.js';

const customers = [
  {customerId: 'CUST-1042', displayName: 'Mira K.', region: 'IN-GA'},
  {customerId: 'CUST-7001', displayName: 'Lena H.', region: 'DE-BE'},
  {customerId: 'CUST-9001', displayName: 'Priya R.', region: 'IN-KA'},
  {customerId: 'CUST-9002', displayName: 'Arjun M.', region: 'IN-MH'},
  {customerId: 'CUST-4410', region: 'NG-LA'},
];
const message = (text: string, stop: BetaMessage['stop_reason'] = 'end_turn') => ({id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{type: 'text', text, citations: null}], stop_reason: stop, stop_sequence: null, stop_details: null, usage: {input_tokens: 1, output_tokens: 1}} as unknown as BetaMessage);
const scripted = (...replies: Array<BetaMessage | Error>) => { const calls: CreateParams[] = []; return {calls, client: {create: async (params: CreateParams) => { calls.push(params); const next = replies.shift()!; if (next instanceof Error) throw next; return next; }}}; };

describe('rule-based command reading', () => {
  it('resolves customers by first name and possessive', () => {
    expect(interpretWithRules("can you wipe Mira's data?", customers)).toMatchObject({action: 'erase', customerId: 'CUST-1042', confidence: 'high', readback: 'Open an erasure request for CUST-1042 (Mira K.)'});
    expect(interpretWithRules('what would happen if we erased lena', customers)).toMatchObject({action: 'dry_run', customerId: 'CUST-7001'});
  });
  it('understands IDs the way speech engines write them', () => {
    expect(interpretWithRules('forget customer 10 42', customers)).toMatchObject({action: 'erase', customerId: 'CUST-1042'});
    expect(interpretWithRules('is it safe to delete 9001', customers)).toMatchObject({action: 'investigate', customerId: 'CUST-9001'});
  });
  it('treats questions as read-only investigations', () => {
    expect(interpretWithRules('who depends on Priya data?', customers)).toMatchObject({action: 'investigate', customerId: 'CUST-9001'});
    expect(interpretWithRules('Is it safe to erase Priya?', customers)).toMatchObject({action: 'investigate', customerId: 'CUST-9001'});
    expect(interpretWithRules('Can you wipe Mira\'s data?', customers).action).toBe('erase');
  });
  it('asks which customer when more than one fits', () => {
    const intent = interpretWithRules('erase mira and lena', customers);
    expect(intent).toMatchObject({customerId: null, candidates: ['CUST-1042', 'CUST-7001'], confidence: 'low'});
  });
  it('refuses to turn speech into immediate execution', () => expect(interpretWithRules('delete Mira right now', customers).action).toBe('blocked'));
  it('ignores four-digit numbers that are not customers', () => expect(interpretWithRules('erase the data from 2021', customers)).toMatchObject({customerId: null}));
});

describe('Claude command reading', () => {
  const intent = {action: 'erase', customerId: 'CUST-1042', candidates: [], tab: null, page: null, readback: 'Open an erasure request for CUST-1042 (Mira K.)', confidence: 'high'};

  it('sends masked customers with a structured-output schema and refusal fallbacks', async () => {
    const {client, calls} = scripted(message(JSON.stringify(intent)));
    const result = await interpretCommand(createAiEngine({mode: 'claude', model: 'claude-opus-5-5'}, {}, client), 'please take Mira out of all our systems', customers);
    expect(result).toEqual({intent, engine: 'claude', model: 'claude-opus-5-5'});
    expect(calls[0]).toMatchObject({model: 'claude-opus-5-5', betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', output_config: {effort: 'low', format: {type: 'json_schema'}}});
    expect(JSON.stringify(calls[0].messages)).not.toContain('@');
  });

  it('drops a customer ID the model made up', async () => {
    const {client} = scripted(message(JSON.stringify({...intent, customerId: 'CUST-0000', candidates: ['CUST-0000', 'CUST-7001']})));
    const result = await interpretCommand(createAiEngine({mode: 'claude', model: 'm'}, {}, client), 'erase someone', customers);
    expect(result.intent).toMatchObject({customerId: null, candidates: ['CUST-7001'], confidence: 'low'});
  });

  it('falls back to rules when Claude refuses, fails, or returns broken JSON', async () => {
    for (const reply of [message('', 'refusal'), new Error('network down'), message('not json')]) {
      const {client} = scripted(reply);
      const result = await interpretCommand(createAiEngine({mode: 'claude', model: 'm'}, {}, client), "wipe Mira's data", customers);
      expect(result.engine).toBe('rules');
      expect(result.intent.customerId).toBe('CUST-1042');
      expect(result.note).toContain('rule-based reader');
    }
  });

  it('runs on rules without credentials and says why', async () => {
    const result = await interpretCommand(createAiEngine({mode: 'auto', model: 'm'}, {}), "wipe Mira's data", customers);
    expect(result).toMatchObject({engine: 'rules', note: 'Set OPENAI_API_KEY to let OpenAI run the agents'});
  });
});
