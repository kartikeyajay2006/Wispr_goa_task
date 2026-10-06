import {randomUUID} from 'node:crypto';
import {Annotation, Command, END, MemorySaver, START, StateGraph, interrupt, type LangGraphRunnableConfig} from '@langchain/langgraph';
import {z} from 'zod';
import type {Workflow} from '../../../../packages/shared/src/index.js';
import type {WorkflowService} from '../workflow-service.js';
import {callClaude, describeAiError, parseStructured, reasoningOf, textOf, type AiEngine, type BetaMessageParam} from './claude.js';
import {interpretCommand, type Intent} from './interpret.js';
import {AGENT_TOOLS, runAgentTool, type ToolContext, type ToolOutcome} from './tools.js';

/* ---------------- Shapes shared with the console ---------------- */
export type AgentNode = 'understand' | 'investigate' | 'assess' | 'propose' | 'await_approval' | 'execute' | 'reject' | 'brief';
export const NODE_LABEL: Record<AgentNode, string> = {understand: 'Intake agent', investigate: 'Discovery agent', assess: 'Risk agent', propose: 'Planner', await_approval: 'Human checkpoint', execute: 'Executor', reject: 'Executor', brief: 'Reporter'};
export type Assessment = {risk: 'low' | 'medium' | 'high'; blockers: string[]; notes: string[]};
export type Briefing = {headline: string; summary: string; findings: string[]; risks: string[]; nextStep: string};
export type ApprovalRequest = {requestId: string; customerId: string; planHash: string; deletable: number; anonymized: number; retained: number; systems: number; expiresHint: string};
export type Decision = {action: 'approve' | 'reject'; operator: string; confirmation?: string; reason?: string};
export type RunStatus = 'running' | 'awaiting_approval' | 'completed' | 'failed';
export type AgentEvent =
  | {type: 'run'; threadId: string; goal: string; engine: 'claude' | 'rules'; model?: string; note?: string}
  | {type: 'node'; node: AgentNode; label: string; status: 'start' | 'end'; detail?: string}
  | {type: 'reasoning'; node: AgentNode; text: string}
  | {type: 'tool'; node: AgentNode; id: string; tool: string; input: unknown; status: 'start' | 'end'; ok?: boolean; summary?: string}
  | {type: 'intent'; intent: Intent; engine: 'claude' | 'rules'}
  | {type: 'assessment'; assessment: Assessment}
  | {type: 'request'; requestId: string; customerId: string; state?: string; status: string; dryRun: boolean; blockedBy?: string}
  | {type: 'approval'; approval: ApprovalRequest}
  | {type: 'briefing'; briefing: Briefing; engine: 'claude' | 'rules'}
  | {type: 'error'; message: string}
  | {type: 'done'; status: RunStatus; requestId?: string};

type Evidence = {tool: string; input: unknown; ok: boolean; summary: string; data: unknown};
type Outcome = {state?: string; residual?: number; recordsChanged?: number; error?: string};

const State = Annotation.Root({
  goal: Annotation<string>(),
  operator: Annotation<string>(),
  intent: Annotation<Intent | undefined>(),
  customerId: Annotation<string | undefined>(),
  evidence: Annotation<Evidence[]>({reducer: (current, update) => [...current, ...update], default: () => []}),
  findings: Annotation<string | undefined>(),
  assessment: Annotation<Assessment | undefined>(),
  requestId: Annotation<string | undefined>(),
  requestStatus: Annotation<string | undefined>(),
  decision: Annotation<Decision | undefined>(),
  outcome: Annotation<Outcome | undefined>(),
  briefing: Annotation<Briefing | undefined>(),
});
type AgentState = typeof State.State;
export type AgentDeps = {engine: AiEngine; workflows: WorkflowService; tools: ToolContext; maxTurns?: number};

/* ---------------- Prompts and schemas ---------------- */
const INVESTIGATOR_PROMPT = `You are the discovery agent inside EraseOps, which erases one customer's personal data across PostgreSQL and MinIO under a retention policy.

Gather the evidence the operator's goal needs, using the read-only tools. They come from the EraseOps MCP catalog and return metadata only: table names, counts, record IDs and policy outcomes, never values.

- Call tools rather than guessing: footprint in both systems, dependencies (look for rows owned by OTHER customers that point at this customer's data), and a rescan for what personal data is still present. Use preview_deletion or the retention policy only when they answer something specific.
- Run independent tools in parallel.
- You cannot delete, approve, or open requests. After you finish, the workflow rehearses the plan in a sandbox, takes a verified backup, and waits for a person to approve the exact plan.
- When you have enough, stop calling tools and reply with 3 to 6 short findings, one per line, each starting with "- ". Name tables, counts and customer IDs. No preamble.`;

const ASSESSMENT_SCHEMA = {type: 'object', additionalProperties: false, required: ['risk', 'blockers', 'notes'], properties: {
  risk: {type: 'string', enum: ['low', 'medium', 'high'], description: 'Risk of erasing this customer now'},
  blockers: {type: 'array', items: {type: 'string'}, description: 'Facts that should stop erasure until a person resolves them, such as rows owned by other customers'},
  notes: {type: 'array', items: {type: 'string'}, description: 'Other things the approver should know, such as records kept for legal reasons'},
}} as const;
const AssessmentSchema = z.object({risk: z.enum(['low', 'medium', 'high']), blockers: z.array(z.string()), notes: z.array(z.string())});

const BRIEFING_SCHEMA = {type: 'object', additionalProperties: false, required: ['headline', 'summary', 'findings', 'risks', 'nextStep'], properties: {
  headline: {type: 'string', description: 'Under 12 words, states the outcome'},
  summary: {type: 'string', description: 'Two sentences at most'},
  findings: {type: 'array', items: {type: 'string'}, description: 'Up to 5 concrete facts with numbers'},
  risks: {type: 'array', items: {type: 'string'}, description: 'Up to 3; empty if none'},
  nextStep: {type: 'string', description: 'The one thing the operator should do next, in the console\'s words'},
}} as const;
const BriefingSchema = z.object({headline: z.string(), summary: z.string(), findings: z.array(z.string()), risks: z.array(z.string()), nextStep: z.string()});
const REPORTER_PROMPT = 'You are the reporter agent in EraseOps. Write a short briefing for the human operator from the run record you are given. Use only facts present in the record; never invent counts or customers. Plain sentences, no markdown. If a request is waiting for approval, the next step is to review the plan and type the customer ID to approve it.';

/* ---------------- Helpers ---------------- */
const emit = (config: LangGraphRunnableConfig, event: AgentEvent) => config.writer?.(event);
const plural = (count: number, word: string) => `${count} ${count === 1 ? word : /[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`}`;
const ERASING = new Set(['erase', 'dry_run']);
const blockedReason = (workflow: Workflow) => workflow.sandbox?.failures[0] ?? workflow.backupFailures?.[0] ?? workflow.backupChecks?.find(check => !check.verified)?.reason;

/** Wraps a node so the console sees which agent is working. */
function step<T>(node: AgentNode, run: (state: AgentState, config: LangGraphRunnableConfig) => Promise<T>) {
  return async (state: AgentState, config: LangGraphRunnableConfig) => {
    emit(config, {type: 'node', node, label: NODE_LABEL[node], status: 'start'});
    const result = await run(state, config);
    emit(config, {type: 'node', node, label: NODE_LABEL[node], status: 'end'});
    return result;
  };
}

async function useTool(node: AgentNode, tool: string, input: unknown, deps: AgentDeps, config: LangGraphRunnableConfig): Promise<ToolOutcome & {id: string}> {
  const id = randomUUID();
  emit(config, {type: 'tool', node, id, tool, input, status: 'start'});
  const outcome = await runAgentTool(tool, input, deps.tools);
  emit(config, {type: 'tool', node, id, tool, input, status: 'end', ok: outcome.ok, summary: outcome.summary});
  return {...outcome, id};
}

/** Deterministic investigation: the same tools, in a fixed order. */
async function investigateWithRules(state: AgentState, deps: AgentDeps, config: LangGraphRunnableConfig) {
  const evidence: Evidence[] = [];
  for (const tool of ['discover_customer_postgres', 'discover_customer_s3', 'calculate_dependencies', 'rescan_customer']) {
    const input = {customerId: state.customerId};
    const outcome = await useTool('investigate', tool, input, deps, config);
    evidence.push({tool, input, ok: outcome.ok, summary: outcome.summary, data: outcome.data});
  }
  return {evidence, findings: evidence.map(item => `- ${item.summary}`).join('\n')};
}

/** Claude chooses which read-only tools to call until it has enough evidence. */
async function investigateWithClaude(state: AgentState, deps: AgentDeps, config: LangGraphRunnableConfig, engine: Extract<AiEngine, {kind: 'claude'}>) {
  const customer = (await deps.tools.customers()).find(item => item.customerId === state.customerId);
  const messages: BetaMessageParam[] = [{role: 'user', content: `Operator's goal: ${JSON.stringify(state.goal)}\nCustomer: ${state.customerId}${customer?.displayName ? ` (${customer.displayName})` : ''}\nWhat they want: ${state.intent?.action}\n\nInvestigate.`}];
  const evidence: Evidence[] = [];
  let findings = '';
  for (let turn = 0; turn < (deps.maxTurns ?? 8); turn++) {
    const message = await callClaude(engine, {max_tokens: 16000, system: INVESTIGATOR_PROMPT, tools: AGENT_TOOLS, thinking: {type: 'adaptive', display: 'summarized'}, output_config: {effort: 'medium'}, cache_control: {type: 'ephemeral'}, messages});
    for (const text of reasoningOf(message)) emit(config, {type: 'reasoning', node: 'investigate', text});
    const toolUses = message.content.filter(block => block.type === 'tool_use');
    if (!toolUses.length) { findings = textOf(message); break; }
    if (message.stop_reason === 'max_tokens') { findings = textOf(message) || 'Investigation stopped: the model ran out of output tokens.'; break; }
    const interim = textOf(message);
    if (interim) emit(config, {type: 'reasoning', node: 'investigate', text: interim});
    messages.push({role: 'assistant', content: message.content});
    const results = await Promise.all(toolUses.map(async use => {
      const outcome = await useTool('investigate', use.name, use.input, deps, config);
      evidence.push({tool: use.name, input: use.input, ok: outcome.ok, summary: outcome.summary, data: outcome.data});
      return {type: 'tool_result' as const, tool_use_id: use.id, is_error: !outcome.ok, content: JSON.stringify(outcome.data).slice(0, 12_000)};
    }));
    messages.push({role: 'user', content: results});
  }
  return {evidence, findings: findings || evidence.map(item => `- ${item.summary}`).join('\n')};
}

/** Facts the risk assessment must include no matter what a model says. */
function signals(evidence: Evidence[]) {
  const dependencies = evidence.filter(item => item.tool === 'calculate_dependencies' && item.ok).flatMap(item => item.data as Array<{constraintType: string; relationshipType: string; target: string}>);
  const shared = [...new Set(dependencies.filter(item => item.constraintType === 'business').map(item => item.relationshipType))];
  const holds = new Set(dependencies.filter(item => item.constraintType === 'retention').map(item => item.target)).size;
  const assets = evidence.filter(item => item.tool.startsWith('discover_customer') && item.ok).flatMap(item => item.data as Array<{records: number}>);
  const records = assets.reduce((total, asset) => total + asset.records, 0);
  const rescan = evidence.filter(item => item.tool === 'rescan_customer' && item.ok).at(-1)?.data as Array<{remainingMatches: number}> | undefined;
  const residual = rescan?.reduce((total, result) => total + result.remainingMatches, 0);
  return {shared, holds, records, residual};
}

function assessWithRules(evidence: Evidence[]): Assessment {
  const {shared, holds, records, residual} = signals(evidence);
  return {
    risk: shared.length ? 'high' : records > 20 ? 'medium' : 'low',
    blockers: shared.map(item => `Shared data: ${item}`),
    notes: [...holds ? [`${plural(holds, 'resource')} must be kept under the retention policy`] : [], residual === 0 ? 'No erasable personal data is left; this customer looks already erased' : residual !== undefined ? `${plural(residual, 'record')} of erasable personal data present` : 'Residual personal data was not checked'],
  };
}

function briefWithRules(state: AgentState, workflow?: Workflow): Briefing {
  const intent = state.intent;
  const who = state.customerId ?? 'the customer';
  const findings = state.evidence.filter(item => item.ok).map(item => item.summary).slice(0, 5);
  const risks = [...state.assessment?.blockers ?? [], ...state.assessment?.notes.filter(note => /kept|retention/.test(note)) ?? []].slice(0, 3);
  if (!state.customerId) return {headline: intent?.candidates.length ? 'Which customer did you mean?' : 'I need a customer to work on', summary: intent?.readback ?? 'Name a customer by ID or first name.', findings: [], risks: [], nextStep: 'Try "erase Mira\'s data" or "what data do we hold on customer 9001?"'};
  if (intent && !ERASING.has(intent.action) && intent.action !== 'investigate') return {headline: intent.action === 'blocked' ? 'Agents cannot run deletions directly' : 'Use the console controls for that', summary: intent.readback, findings: [], risks: [], nextStep: intent.action === 'blocked' ? 'Ask me to erase the customer: I will prepare a plan for you to approve.' : 'Open the request and use the safety rail.'};
  if (state.outcome?.error && !workflow) return {headline: `Could not open a request for ${who}`, summary: state.outcome.error, findings, risks, nextStep: 'Check the customer ID and try again.'};
  if (!workflow) return {headline: `${who}: ${state.assessment?.risk ?? 'unknown'} risk to erase`, summary: state.findings?.split('\n')[0]?.replace(/^- /, '') ?? 'Investigation complete.', findings, risks, nextStep: state.assessment?.blockers.length ? 'Resolve the shared data before erasing, for example by transferring ownership.' : `Say "erase ${who}" when you are ready.`};
  const changed = workflow.executionResults?.reduce((total, result) => total + result.affectedRecords, 0) ?? 0;
  switch (workflow.state) {
    case 'COMPLETED': return {headline: `${who} erased and verified`, summary: `${plural(changed, 'record')} changed across ${plural(workflow.blastRadius.systems, 'system')}; the rescan found ${workflow.verification?.remainingMatches ?? 0} residual records.`, findings, risks, nextStep: 'Open the certificate of erasure.'};
    case 'REJECTED': return {headline: 'Plan rejected; nothing changed', summary: `${state.decision?.operator ?? 'The operator'} rejected the plan${state.decision?.reason ? `: ${state.decision.reason}` : '.'}`, findings, risks, nextStep: 'Open a new request when the issue is resolved.'};
    case 'SANDBOX_FAILED': return {headline: `${who} is blocked by the sandbox`, summary: blockedReason(workflow) ?? 'The rehearsal found a problem.', findings, risks, nextStep: 'Resolve the shared dependency, then ask again. Nothing was changed or backed up.'};
    case 'BACKING_UP': return {headline: `${who} is blocked at backup`, summary: blockedReason(workflow) ?? 'The backup could not be verified.', findings, risks, nextStep: 'Restore the archived object, then ask again.'};
    case 'AWAITING_HUMAN_APPROVAL': return workflow.dryRun
      ? {headline: 'Dry run passed sandbox and backup', summary: `${plural(workflow.blastRadius.deletable, 'record')} would be deleted and ${workflow.blastRadius.anonymized} redacted.`, findings, risks, nextStep: 'Open a live request when you are ready.'}
      : {headline: `Plan ready for ${who}`, summary: `${plural(workflow.blastRadius.deletable, 'record')} to delete and ${workflow.blastRadius.anonymized} to redact; ${workflow.blastRadius.retained} kept under policy.`, findings, risks, nextStep: `Review the plan and type ${who} to approve it.`};
    default: return {headline: `${who}: ${workflow.state?.toLowerCase().replaceAll('_', ' ')}`, summary: state.outcome?.error ?? 'The request did not complete.', findings, risks, nextStep: workflow.state === 'VERIFICATION_FAILED' || workflow.state === 'EXECUTION_FAILED' ? 'Roll back from the request backup on the request page.' : 'Open the request for details.'};
  }
}

/* ---------------- The graph ---------------- */
export function buildErasureGraph(deps: AgentDeps) {
  const engine = deps.engine;
  const graph = new StateGraph(State)
    .addNode('understand', step('understand', async (state, config) => {
      const customers = (await deps.tools.customers()).map(({customerId, displayName, region}) => ({customerId, displayName, region}));
      const reading = await interpretCommand(engine, state.goal, customers);
      if (reading.note && engine.kind === 'claude') emit(config, {type: 'reasoning', node: 'understand', text: reading.note});
      emit(config, {type: 'intent', intent: reading.intent, engine: reading.engine});
      return {intent: reading.intent, customerId: reading.intent.customerId ?? undefined};
    }))
    .addNode('investigate', step('investigate', async (state, config) => {
      if (engine.kind === 'rules') return investigateWithRules(state, deps, config);
      try { return await investigateWithClaude(state, deps, config, engine); }
      catch (error) {
        emit(config, {type: 'reasoning', node: 'investigate', text: `${describeAiError(error)}. Continuing with the rule-based investigation.`});
        return investigateWithRules(state, deps, config);
      }
    }))
    .addNode('assess', step('assess', async (state, config) => {
      const facts = assessWithRules(state.evidence);
      let assessment = facts;
      if (engine.kind === 'claude') {
        try {
          const message = await callClaude(engine, {max_tokens: 4096, output_config: {effort: 'low', format: {type: 'json_schema', schema: ASSESSMENT_SCHEMA as unknown as Record<string, unknown>}}, system: 'You are the risk agent in EraseOps. Judge how risky it is to erase this customer now, from the evidence only.', messages: [{role: 'user', content: JSON.stringify({goal: state.goal, customerId: state.customerId, findings: state.findings, evidence: state.evidence.map(({tool, summary, data}) => ({tool, summary, data})).slice(0, 12), knownBlockers: facts.blockers})}]});
          const judged = parseStructured(message, AssessmentSchema);
          // Known blockers always survive, and a model can raise risk but never lower it below the facts.
          const order = ['low', 'medium', 'high'] as const;
          assessment = {risk: order[Math.max(order.indexOf(judged.risk), order.indexOf(facts.risk))], blockers: [...new Set([...facts.blockers, ...judged.blockers])], notes: [...new Set([...judged.notes, ...facts.notes])].slice(0, 5)};
        } catch (error) { emit(config, {type: 'reasoning', node: 'assess', text: `${describeAiError(error)}. Using the rule-based assessment.`}); }
      }
      emit(config, {type: 'assessment', assessment});
      return {assessment};
    }))
    .addNode('propose', step('propose', async (state, config) => {
      try {
        const workflow = await deps.workflows.create({customerId: state.customerId, reason: `Requested through the EraseOps agent: "${state.goal.slice(0, 200)}"`, dryRun: state.intent?.action === 'dry_run'}, `${state.operator} via agent`);
        emit(config, {type: 'request', requestId: workflow.requestId, customerId: workflow.customerId, state: workflow.state, status: workflow.status, dryRun: workflow.dryRun, blockedBy: workflow.status === 'blocked' ? blockedReason(workflow) : undefined});
        return {requestId: workflow.requestId, requestStatus: workflow.status};
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not open the request';
        emit(config, {type: 'error', message});
        return {outcome: {error: message}};
      }
    }))
    .addNode('await_approval', async state => {
      // interrupt() pauses the run here; the graph resumes when a person answers in the console.
      const workflow = deps.workflows.get(state.requestId!);
      const decision = interrupt<ApprovalRequest, Decision>({requestId: workflow.requestId, customerId: workflow.customerId, planHash: workflow.plan.hash, deletable: workflow.blastRadius.deletable, anonymized: workflow.blastRadius.anonymized, retained: workflow.blastRadius.retained, systems: workflow.blastRadius.systems, expiresHint: 'Approval binds to this plan hash, works once, and expires after it is issued'});
      return {decision};
    })
    .addNode('execute', step('execute', async (state, config) => {
      const decision = state.decision!;
      const requestId = state.requestId!;
      try {
        await deps.workflows.approve(requestId, {confirmation: decision.confirmation}, decision.operator);
        const approved = deps.workflows.get(requestId);
        emit(config, {type: 'reasoning', node: 'execute', text: `${decision.operator} approved plan ${approved.plan.hash.slice(0, 12)}…; running guarded execution.`});
        const done = await deps.workflows.execute(requestId, {approvalId: approved.approval!.token, planHash: approved.plan.hash}, decision.operator);
        const outcome = {state: done.state, residual: done.verification?.remainingMatches, recordsChanged: done.executionResults?.reduce((total, result) => total + result.affectedRecords, 0)};
        emit(config, {type: 'request', requestId, customerId: done.customerId, state: done.state, status: done.status, dryRun: false});
        return {outcome};
      } catch (error) {
        const workflow = deps.workflows.get(requestId);
        const message = error instanceof Error ? error.message : 'Execution failed';
        emit(config, {type: 'error', message});
        emit(config, {type: 'request', requestId, customerId: workflow.customerId, state: workflow.state, status: workflow.status, dryRun: false});
        return {outcome: {state: workflow.state, error: message}};
      }
    }))
    .addNode('reject', step('reject', async (state, config) => {
      const decision = state.decision!;
      const workflow = await deps.workflows.reject(state.requestId!, {reason: decision.reason}, decision.operator);
      emit(config, {type: 'request', requestId: workflow.requestId, customerId: workflow.customerId, state: workflow.state, status: workflow.status, dryRun: workflow.dryRun});
      return {outcome: {state: workflow.state}};
    }))
    .addNode('brief', step('brief', async (state, config) => {
      const workflow = state.requestId ? deps.workflows.get(state.requestId) : undefined;
      let briefing = briefWithRules(state, workflow);
      let briefedBy: 'claude' | 'rules' = 'rules';
      if (engine.kind === 'claude' && state.customerId) {
        try {
          const record = {goal: state.goal, intent: state.intent, findings: state.findings, assessment: state.assessment, request: workflow && {requestId: workflow.requestId, state: workflow.state, dryRun: workflow.dryRun, blastRadius: workflow.blastRadius, blockedBy: blockedReason(workflow), residualAfterRescan: workflow.verification?.remainingMatches, recordsChanged: workflow.executionResults?.reduce((total, result) => total + result.affectedRecords, 0)}, decision: state.decision && {action: state.decision.action, operator: state.decision.operator, reason: state.decision.reason}, error: state.outcome?.error};
          const message = await callClaude(engine, {max_tokens: 4096, system: REPORTER_PROMPT, output_config: {effort: 'low', format: {type: 'json_schema', schema: BRIEFING_SCHEMA as unknown as Record<string, unknown>}}, messages: [{role: 'user', content: JSON.stringify(record)}]});
          briefing = parseStructured(message, BriefingSchema);
          briefedBy = 'claude';
        } catch (error) { emit(config, {type: 'reasoning', node: 'brief', text: `${describeAiError(error)}. Using the rule-based briefing.`}); }
      }
      emit(config, {type: 'briefing', briefing, engine: briefedBy});
      return {briefing};
    }))
    .addEdge(START, 'understand')
    .addConditionalEdges('understand', state => state.customerId && state.intent && (ERASING.has(state.intent.action) || state.intent.action === 'investigate') ? 'investigate' : 'brief', ['investigate', 'brief'])
    .addEdge('investigate', 'assess')
    // Nothing to erase: skip the plan when the rescan already shows zero erasable records.
    .addConditionalEdges('assess', state => ERASING.has(state.intent!.action) && signals(state.evidence).residual !== 0 ? 'propose' : 'brief', ['propose', 'brief'])
    .addEdge('propose', 'brief')
    // The reporter briefs the human before the checkpoint, and again after execution.
    .addConditionalEdges('brief', state => state.requestStatus === 'awaiting_approval' && state.intent?.action === 'erase' && !state.decision ? 'await_approval' : END, ['await_approval', END])
    .addConditionalEdges('await_approval', state => state.decision?.action === 'approve' ? 'execute' : 'reject', ['execute', 'reject'])
    .addEdge('execute', 'brief')
    .addEdge('reject', 'brief');
  return graph.compile({checkpointer: new MemorySaver()});
}

/* ---------------- Runs ---------------- */
export type RunRecord = {threadId: string; goal: string; operator: string; startedAt: string; updatedAt: string; status: RunStatus; engine: 'claude' | 'rules'; customerId?: string; requestId?: string; headline?: string; approval?: ApprovalRequest};

/** Owns the compiled graph and its checkpoints; one thread per agent run. */
export class ErasureAgent {
  private graph: ReturnType<typeof buildErasureGraph>;
  private readonly runs = new Map<string, RunRecord>();
  constructor(private readonly deps: AgentDeps) { this.graph = buildErasureGraph(deps); }

  get engine() { return this.deps.engine; }
  list() { return [...this.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)); }
  record(threadId: string) { return this.runs.get(threadId); }
  reset() { this.runs.clear(); this.graph = buildErasureGraph(this.deps); }

  start(goal: string, operator: string) {
    const threadId = randomUUID();
    const now = new Date().toISOString();
    const engine = this.deps.engine;
    this.runs.set(threadId, {threadId, goal, operator, startedAt: now, updatedAt: now, status: 'running', engine: engine.kind});
    const first: AgentEvent = {type: 'run', threadId, goal, engine: engine.kind, model: engine.kind === 'claude' ? engine.model : undefined, note: engine.kind === 'rules' ? engine.reason : undefined};
    return {threadId, events: this.drive(threadId, {goal, operator}, first)};
  }

  resume(threadId: string, decision: Decision) {
    const record = this.runs.get(threadId);
    if (!record) throw new Error('Agent run not found');
    if (record.status !== 'awaiting_approval') throw new Error(`This run is ${record.status.replace('_', ' ')}, not waiting for approval`);
    record.status = 'running';
    record.approval = undefined;
    return this.drive(threadId, new Command({resume: decision}));
  }

  private async *drive(threadId: string, input: Partial<AgentState> | Command, first?: AgentEvent): AsyncGenerator<AgentEvent> {
    const record = this.runs.get(threadId)!;
    const config = {configurable: {thread_id: threadId}};
    if (first) yield first;
    try {
      for await (const [mode, chunk] of await this.graph.stream(input as never, {...config, streamMode: ['custom', 'updates']})) {
        if (mode === 'custom') { const event = chunk as AgentEvent; this.track(record, event); yield event; }
        else if (mode === 'updates' && chunk && typeof chunk === 'object' && '__interrupt__' in chunk) {
          const approval = (chunk as {__interrupt__: Array<{value: ApprovalRequest}>}).__interrupt__[0]?.value;
          if (approval) { record.approval = approval; yield {type: 'approval', approval}; }
        }
      }
      const snapshot = await this.graph.getState(config);
      record.status = snapshot.next.length ? 'awaiting_approval' : snapshot.values.outcome?.error ? 'failed' : 'completed';
    } catch (error) {
      record.status = 'failed';
      yield {type: 'error', message: error instanceof Error ? error.message : 'Agent run failed'};
    }
    record.updatedAt = new Date().toISOString();
    yield {type: 'done', status: record.status, requestId: record.requestId};
  }

  private track(record: RunRecord, event: AgentEvent) {
    if (event.type === 'intent') record.customerId = event.intent.customerId ?? undefined;
    if (event.type === 'request') record.requestId = event.requestId;
    if (event.type === 'briefing') record.headline = event.briefing.headline;
    record.updatedAt = new Date().toISOString();
  }
}
