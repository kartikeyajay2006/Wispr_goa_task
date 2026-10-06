import {z} from 'zod';
import {callClaude, describeAiError, parseStructured, type AiEngine} from './claude.js';

export const ACTIONS = ['erase', 'dry_run', 'investigate', 'approve', 'reject', 'rollback', 'show', 'navigate', 'reset', 'blocked', 'unknown'] as const;
export const TABS = ['overview', 'footprint', 'dependencies', 'plan', 'sandbox', 'backup', 'verification', 'report', 'audit'] as const;
export const PAGES = ['overview', 'requests', 'approvals', 'customers', 'systems', 'policies', 'audit', 'agent'] as const;

export const IntentSchema = z.object({
  action: z.enum(ACTIONS),
  customerId: z.string().nullable(),
  candidates: z.array(z.string()),
  tab: z.enum(TABS).nullable(),
  page: z.enum(PAGES).nullable(),
  readback: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
});
export type Intent = z.infer<typeof IntentSchema>;
export type CustomerRef = {customerId: string; displayName?: string; region?: string};
export type Interpretation = {intent: Intent; engine: 'claude' | 'rules'; model?: string; note?: string};

const nullable = (schema: Record<string, unknown>) => ({anyOf: [schema, {type: 'null'}]});
/** JSON Schema for structured outputs: every object closed, every property required. */
export const INTENT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'customerId', 'candidates', 'tab', 'page', 'readback', 'confidence'],
  properties: {
    action: {type: 'string', enum: [...ACTIONS], description: 'What the operator wants. erase = open a live erasure request; dry_run = plan and rehearse only; investigate = answer a question about a customer without changing anything.'},
    customerId: nullable({type: 'string', description: 'Exactly one ID from the customer list, like CUST-1042'}),
    candidates: {type: 'array', items: {type: 'string'}, description: 'Customer IDs that could match when the request is ambiguous; empty otherwise'},
    tab: nullable({type: 'string', enum: [...TABS]}),
    page: nullable({type: 'string', enum: [...PAGES]}),
    readback: {type: 'string', description: 'One short sentence telling the operator what will happen, naming the customer ID'},
    confidence: {type: 'string', enum: ['high', 'medium', 'low']},
  },
} as const;

const SYSTEM_PROMPT = `You turn an operator's typed or dictated command into one structured intent for EraseOps, a console that erases a customer's personal data across PostgreSQL and object storage.

How to read commands:
- Speech recognition mangles IDs. "customer 10 42", "cust ten forty two" and "1042" all mean CUST-1042 when that ID exists.
- People refer to customers by first name ("wipe Mira's data", "forget Lena"). Match names only against the customer list you are given. If two customers fit, set customerId to null, list them in candidates, and use confidence "low".
- erase: delete, wipe, remove, forget, purge, "right to be forgotten". dry_run: preview, simulate, "what would happen if". investigate: questions about what data exists, who depends on it, or whether erasure is safe.
- approve, reject and rollback only move focus to the matching control; they never act by themselves.
- If the command asks to execute, run, or delete immediately without review, use action "blocked": deletions only run after a person approves the exact plan in the console.
- Use "show" with a tab for requests to see evidence on the current request, and "navigate" with a page for moving around the console.
- Never invent a customer ID that is not in the list.

Write the readback as one plain sentence in sentence case, for example "Open an erasure request for CUST-1042 (Mira K.)".`;

/* ---------------- Rule-based reading ---------------- */
const ID_PATTERN = /\bcust(?:omer)?[\s-]*(?:id[\s-]*)?(\d(?:\s?\d){3})(?!\s?\d)|\b(\d{4})\b/gi;
const words = (text: string) => text.toLowerCase().replace(/['’]s\b/g, '').split(/[^a-z0-9]+/).filter(Boolean);

/** Customer IDs written out in the text, plus customers whose first name is mentioned. */
export function findCustomers(text: string, customers: readonly CustomerRef[]) {
  const known = new Set(customers.map(customer => customer.customerId));
  const ids = new Set<string>();
  for (const match of text.matchAll(ID_PATTERN)) { const id = `CUST-${(match[1] ?? match[2]).replace(/\s/g, '')}`; if (known.has(id) || match[1]) ids.add(id); }
  const tokens = new Set(words(text));
  const byName = customers.filter(customer => { const first = customer.displayName?.split(/\s+/)[0]?.toLowerCase(); return Boolean(first && first.length > 2 && tokens.has(first)); });
  return {ids: [...ids], byName};
}

const TAB_WORDS: Array<[RegExp, Intent['tab']]> = [
  [/\b(report|certificate)\b/, 'report'], [/\b(dependenc(y|ies)|graph|shared)\b/, 'dependencies'], [/\b(plan|blast radius|actions)\b/, 'plan'],
  [/\bsandbox\b/, 'sandbox'], [/\bbackup\b/, 'backup'], [/\b(verify|verification|rescan)\b/, 'verification'], [/\b(footprint|assets)\b/, 'footprint'], [/\b(audit trail|events|history)\b/, 'audit'],
];
const PAGE_WORDS: Array<[RegExp, Intent['page']]> = [
  [/\b(dashboard|overview)\b/, 'overview'], [/\brequests\b/, 'requests'], [/\bapprovals\b/, 'approvals'], [/\bcustomers\b/, 'customers'],
  [/\bsystems\b/, 'systems'], [/\bpolic(y|ies)\b/, 'policies'], [/\baudit log\b/, 'audit'], [/\bagent\b/, 'agent'],
];

export function interpretWithRules(text: string, customers: readonly CustomerRef[]): Intent {
  const lower = text.toLowerCase().trim();
  const {ids, byName} = findCustomers(text, customers);
  const nameOf = (id: string) => customers.find(customer => customer.customerId === id)?.displayName;
  const label = (id: string) => nameOf(id) ? `${id} (${nameOf(id)})` : id;
  const matches = ids.length ? ids : byName.map(customer => customer.customerId);
  const customerId = matches.length === 1 ? matches[0] : null;
  const candidates = matches.length > 1 ? matches : [];
  const base = {customerId, candidates, tab: null, page: null, confidence: (customerId ? 'high' : candidates.length ? 'low' : 'medium') as Intent['confidence']};
  const who = customerId ? label(customerId) : candidates.length ? `one of ${candidates.map(label).join(' or ')}` : 'a customer';

  if (/\b(execute|run it|delete now|right now|immediately|force)\b/.test(lower)) return {...base, action: 'blocked', readback: 'Not allowed: deletions only run after a person approves the exact plan'};
  if (/\breset\b/.test(lower) && /\b(demo|data|everything)\b/.test(lower)) return {...base, action: 'reset', readback: 'Reset the demo data'};
  if (/\b(roll ?back|restore|undo)\b/.test(lower)) return {...base, action: 'rollback', readback: `Roll back from backup for ${who}`};
  if (/\b(approve|sign off)\b/.test(lower)) return {...base, action: 'approve', readback: `Review and approve the plan for ${who}`};
  if (/\b(reject|decline|cancel)\b/.test(lower)) return {...base, action: 'reject', readback: `Reject the plan for ${who}`};
  const page = PAGE_WORDS.find(([pattern]) => pattern.test(lower))?.[1] ?? null;
  if (page && /\b(go to|open|show|view|take me)\b/.test(lower) && !matches.length) return {...base, action: 'navigate', page, readback: `Go to ${page === 'audit' ? 'the audit log' : page}`};
  if (/\b(dry[\s-]?run|preview|simulate|what (would|will) happen|what if)\b/.test(lower)) return {...base, action: 'dry_run', readback: customerId ? `Open a dry run for ${who}` : `Open a dry run for ${who}: which one?`};
  const tab = TAB_WORDS.find(([pattern]) => pattern.test(lower))?.[1] ?? null;
  if (tab && /\b(show|open|view|see|display)\b/.test(lower)) return {...base, action: 'show', tab, readback: `Show the ${tab} tab${customerId ? ` for ${who}` : ''}`};
  if (/\b(erase|delete|wipe|remove|forget|purge|scrub|forgotten|get rid of)\b/.test(lower)) return {...base, action: 'erase', readback: customerId ? `Open an erasure request for ${who}` : `Open an erasure request for ${who}: which one?`};
  if (matches.length && /\b(what|who|which|how|why|is it|can we|find|look|check|investigate|tell|about|data|safe)\b/.test(lower)) return {...base, action: 'investigate', readback: `Investigate ${who} without changing anything`};
  if (customerId) return {...base, action: 'erase', confidence: 'medium', readback: `Open an erasure request for ${who}`};
  return {...base, action: 'unknown', confidence: 'low', readback: candidates.length ? `Which customer did you mean: ${candidates.map(label).join(' or ')}?` : 'Not sure what that means yet. Try "erase Mira\'s data" or "dry run for customer 3175".'};
}

/* ---------------- Claude reading ---------------- */
export async function interpretCommand(engine: AiEngine, text: string, customers: readonly CustomerRef[], current?: {requestId: string; customerId: string; state?: string}): Promise<Interpretation> {
  if (engine.kind === 'rules') return {intent: interpretWithRules(text, customers), engine: 'rules', note: engine.reason};
  try {
    const message = await callClaude(engine, {
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      output_config: {effort: 'low', format: {type: 'json_schema', schema: INTENT_JSON_SCHEMA as unknown as Record<string, unknown>}},
      // Only masked names leave the API: the model never sees emails or full surnames.
      messages: [{role: 'user', content: `Customers:\n${JSON.stringify(customers.map(customer => ({id: customer.customerId, name: customer.displayName ?? '(name erased)', region: customer.region ?? null})))}\n\nCurrent request: ${current ? JSON.stringify(current) : 'none'}\n\nCommand: ${JSON.stringify(text)}`}],
    });
    const intent = parseStructured(message, IntentSchema);
    const known = new Set(customers.map(customer => customer.customerId));
    // The model is not trusted to name customers: anything outside the list is dropped.
    if (intent.customerId && !known.has(intent.customerId)) { intent.customerId = null; intent.confidence = 'low'; }
    intent.candidates = intent.candidates.filter(id => known.has(id));
    return {intent, engine: 'claude', model: engine.model};
  } catch (error) {
    return {intent: interpretWithRules(text, customers), engine: 'rules', note: `${describeAiError(error)}; used the rule-based reader instead`};
  }
}
