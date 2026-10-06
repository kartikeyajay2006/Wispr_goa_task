import {useCallback, useEffect, useMemo, useRef, useState, type FormEvent} from 'react';
import {Link, useSearchParams} from 'react-router-dom';
import {useQuery, useQueryClient} from '@tanstack/react-query';
import {AlertTriangle, ArrowRight, Bot, Brain, Check, CircleSlash, FileSearch, Hand, Loader2, Mic, MicOff, Play, ScanLine, ShieldCheck, Sparkles, Wrench, X} from 'lucide-react';
import {api, modelProvider, type AgentEvent, type AgentNode, type ApprovalRequest} from '../api';
import {useOperator} from '../operator';
import {useSpeech} from '../components/speech';
import {OperatorField} from '../components/OperatorField';
import {ErrorNotice, StatePill, plural, relativeTime, toast} from '../components/ui';

type StageKey = 'understand' | 'investigate' | 'assess' | 'propose' | 'brief1' | 'checkpoint' | 'execute' | 'brief2';
type StageState = 'idle' | 'active' | 'done' | 'skipped' | 'blocked' | 'waiting';
const STAGES: Array<{key: StageKey; label: string; job: string; icon: typeof Bot}> = [
  {key: 'understand', label: 'Intake agent', job: 'Reads what you asked for', icon: Sparkles},
  {key: 'investigate', label: 'Discovery agent', job: 'Calls read-only MCP tools', icon: FileSearch},
  {key: 'assess', label: 'Risk agent', job: 'Weighs blockers and legal holds', icon: AlertTriangle},
  {key: 'propose', label: 'Planner', job: 'Sandbox rehearsal and verified backup', icon: ScanLine},
  {key: 'brief1', label: 'Reporter', job: 'Briefs you on the plan', icon: Bot},
  {key: 'checkpoint', label: 'Human checkpoint', job: 'You approve the exact plan', icon: Hand},
  {key: 'execute', label: 'Executor', job: 'Guarded execution and rescan', icon: ShieldCheck},
  {key: 'brief2', label: 'Reporter', job: 'Final briefing', icon: Bot},
];

/** Folds the event stream into one state per stage of the agent graph. */
function deriveStages(events: AgentEvent[]): Record<StageKey, StageState> {
  const state = Object.fromEntries(STAGES.map(stage => [stage.key, 'idle'])) as Record<StageKey, StageState>;
  let briefs = 0;
  const keyFor = (node: AgentNode, starting: boolean): StageKey | undefined => {
    if (node === 'brief') { if (starting) briefs++; return briefs >= 2 ? 'brief2' : 'brief1'; }
    if (node === 'reject') return 'execute';
    if (node === 'await_approval') return 'checkpoint';
    return node as StageKey;
  };
  for (const event of events) {
    if (event.type === 'node') { const key = keyFor(event.node, event.status === 'start'); if (key) state[key] = event.status === 'start' ? 'active' : state[key] === 'blocked' ? 'blocked' : 'done'; }
    if (event.type === 'request' && event.status === 'blocked' && !['REJECTED', 'ROLLED_BACK'].includes(event.state ?? '')) state.propose = 'blocked';
    if (event.type === 'approval') state.checkpoint = 'waiting';
    if (event.type === 'node' && (event.node === 'execute' || event.node === 'reject') && event.status === 'start') state.checkpoint = 'done';
    if (event.type === 'done' && event.status !== 'awaiting_approval') for (const stage of STAGES) if (state[stage.key] === 'idle') state[stage.key] = 'skipped';
  }
  return state;
}

export default function AgentPage() {
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const operator = useOperator(state => state.name.trim());
  const status = useQuery({queryKey: ['assistant-status'], queryFn: api.assistantStatus});
  const customers = useQuery({queryKey: ['customers'], queryFn: api.customers});
  const runs = useQuery({queryKey: ['agent-runs'], queryFn: api.agentRuns});
  const [goal, setGoal] = useState(params.get('goal') ?? '');
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<unknown>();
  const abort = useRef<AbortController | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  const push = useCallback((event: AgentEvent) => setEvents(current => [...current, event]), []);
  const finish = useCallback(async () => { setRunning(false); await queryClient.invalidateQueries(); }, [queryClient]);

  const start = useCallback(async (text: string) => {
    const value = text.trim();
    if (!value || running) return;
    abort.current?.abort();
    abort.current = new AbortController();
    setEvents([]); setError(undefined); setRunning(true); setGoal(value);
    try { await api.startAgent(value, push, abort.current.signal); } catch (failure) { setError(failure); } finally { await finish(); }
  }, [running, push, finish]);

  useEffect(() => () => abort.current?.abort(), []);
  // Deferred so React's StrictMode mount/unmount/mount cancels the first attempt instead of aborting a live stream.
  useEffect(() => {
    const initial = params.get('goal');
    if (!initial || params.get('start') !== '1') return;
    const timer = setTimeout(() => { setParams({}, {replace: true}); void start(initial); }, 0);
    return () => clearTimeout(timer);
  }, [params, setParams, start]);
  // Follow the transcript inside its own panel; scrolling the window would make the page jump.
  useEffect(() => { const feed = feedRef.current; if (feed) feed.scrollTo({top: feed.scrollHeight, behavior: 'smooth'}); }, [events.length]);

  const speech = useSpeech({onInterim: setGoal, onFinal: text => void start(text), onError: message => toast.error(message)});
  const run = events.find((event): event is Extract<AgentEvent, {type: 'run'}> => event.type === 'run');
  const stages = useMemo(() => deriveStages(events), [events]);
  const done = [...events].reverse().find((event): event is Extract<AgentEvent, {type: 'done'}> => event.type === 'done');
  const approval = done?.status === 'awaiting_approval' ? [...events].reverse().find((event): event is Extract<AgentEvent, {type: 'approval'}> => event.type === 'approval')?.approval : undefined;
  const toolCount = events.filter(event => event.type === 'tool' && event.status === 'end').length;

  const resume = async (decision: {decision: 'approve' | 'reject'; confirmation?: string; reason?: string}) => {
    if (!run) return;
    setRunning(true); setError(undefined);
    try { await api.resumeAgent(run.threadId, decision, push); } catch (failure) { setError(failure); } finally { await finish(); }
  };

  const examples = useMemo(() => {
    const list = customers.data ?? [];
    const named = list.filter(customer => customer.displayName && customer.status === 'active');
    const first = (name?: string) => name?.split(' ')[0];
    const shared = named.find(customer => customer.signals.some(signal => /depend/.test(signal)));
    const largest = [...list].filter(customer => customer.status === 'active').sort((a, b) => b.footprint.records - a.footprint.records)[0];
    const plain = named.find(customer => customer !== shared && !customer.signals.some(signal => /depend/.test(signal)));
    return [
      plain && `Can you wipe ${first(plain.displayName)}'s data?`,
      shared && `Is it safe to erase ${first(shared.displayName)}?`,
      largest && `What would happen if we erased customer ${largest.customerId.slice(5)}?`,
      named.at(-1) && `What data do we hold on ${first(named.at(-1)!.displayName)}?`,
    ].filter((example): example is string => Boolean(example));
  }, [customers.data]);

  const submit = (event: FormEvent) => { event.preventDefault(); void start(goal); };

  return <div className="page">
    <div className="page-head">
      <div><h1>Agent</h1><p>Say what you need in plain words. A LangGraph team of agents investigates with read-only tools, prepares the plan, and stops at a human checkpoint before anything is deleted.</p></div>
      {status.data && (status.data.engine === 'claude'
        ? <span className="engine-badge live"><Brain size={15} />{modelProvider(status.data.model)} · {status.data.model}</span>
        : <span className="engine-badge" title={status.data.reason}><Wrench size={15} />Rule-based agents · {status.data.reason}</span>)}
    </div>

    <form className={`panel agent-composer ${running ? 'running' : ''}`} onSubmit={submit}>
      <Bot size={20} className="dot-accent" />
      <input className="agent-input" value={goal} onChange={event => setGoal(event.target.value)} placeholder={examples[0] ? `Try: ${examples[0]}` : 'Describe the erasure or question'} aria-label="What should the agent do?" maxLength={500} />
      {speech.supported && <button type="button" className={`btn icon-btn mic ${speech.listening ? 'listening' : ''}`} aria-pressed={speech.listening} aria-label={speech.listening ? 'Stop listening' : 'Dictate'} onClick={speech.toggle}>{speech.listening ? <MicOff size={16} /> : <Mic size={16} />}</button>}
      <button className="btn btn-primary" aria-label="Run agents" disabled={running || !goal.trim()}>{running ? <Loader2 size={16} className="spin" /> : <Play size={16} />}<span className="run-label">Run agents</span></button>
    </form>
    {!events.length && <div className="agent-examples">{examples.map(example => <button key={example} type="button" className="chip-btn" onClick={() => void start(example)}>{example}</button>)}</div>}
    <ErrorNotice error={error} />

    {events.length > 0 && <div className="agent-grid">
      <section className="panel agent-graph" aria-label="Agent graph">
        <div className="panel-head"><div><h3>Agent graph</h3><p>{run ? (run.engine === 'claude' ? `${modelProvider(run.model)} ${run.model}` : 'Rule-based engine') : ''}</p></div>{running && <Loader2 size={16} className="spin dot-accent" />}</div>
        <ol className="stage-flow">{STAGES.map(stage => {
          const value = stages[stage.key];
          return <li key={stage.key} className={`agent-stage ${value}`}>
            <span className="stage-icon">{value === 'done' ? <Check size={15} /> : value === 'blocked' ? <X size={15} /> : value === 'skipped' ? <CircleSlash size={14} /> : <stage.icon size={15} />}</span>
            <div><strong>{stage.label}</strong><small>{stage.key === 'investigate' && toolCount ? `${plural(toolCount, 'tool call')}` : value === 'waiting' ? 'Waiting for you' : value === 'blocked' ? 'Blocked by a safety gate' : stage.job}</small></div>
          </li>;
        })}</ol>
      </section>

      <section className="panel agent-feed" aria-live="polite">
        <div className="panel-head"><div><h3>{run?.goal ?? goal}</h3><p>{run?.engine === 'rules' && run.note ? run.note : 'Live transcript of the run'}</p></div></div>
        <div className="feed" ref={feedRef}>
          <Feed events={events} />
          {running && !approval && <div className="feed-working" aria-hidden="true"><span className="dots"><i /><i /><i /></span>{STAGES.find(stage => stages[stage.key] === 'active')?.label ?? 'Agents'} working</div>}
          {approval && <ApprovalCard approval={approval} operator={operator} busy={running} onDecide={resume} />}
        </div>
      </section>
    </div>}

    <section className="panel">
      <div className="panel-head"><div><h3>Recent agent runs</h3><p>Runs live in memory until the API restarts or the demo is reset</p></div></div>
      {runs.data?.length ? <div className="table-wrap" tabIndex={0}><table className="table"><thead><tr><th>Goal</th><th>Customer</th><th>Outcome</th><th>Started</th><th /></tr></thead><tbody>{runs.data.map(item => <tr key={item.threadId}>
        <td>{item.goal}<div className="small muted">{item.engine === 'claude' ? modelProvider(item.model) : 'Rule-based'} · {item.operator}</div></td>
        <td className="id">{item.customerId ?? '—'}</td>
        <td><span className={`pill ${item.status === 'completed' ? 'done' : item.status === 'awaiting_approval' ? 'review' : item.status === 'failed' ? 'blocked' : 'ready'}`}>{item.status === 'awaiting_approval' ? 'Waiting for approval' : item.status}</span><div className="small dim">{item.headline}</div></td>
        <td>{relativeTime(item.startedAt)}</td>
        <td style={{textAlign: 'right'}}>{item.requestId && <Link className="btn" to={`/console/requests/${item.requestId}`}>Open request</Link>}</td>
      </tr>)}</tbody></table></div> : <p className="panel-pad small muted">No runs yet. Pick an example above or say what you need.</p>}
    </section>
  </div>;
}

function Feed({events}: {events: AgentEvent[]}) {
  const provider = modelProvider(events.find((event): event is Extract<AgentEvent, {type: 'run'}> => event.type === 'run')?.model);
  const finished = new Map(events.filter((event): event is Extract<AgentEvent, {type: 'tool'}> => event.type === 'tool' && event.status === 'end').map(event => [event.id, event]));
  const labels: Partial<Record<AgentNode, string>> = {};
  return <>{events.map((event, index) => {
    switch (event.type) {
      case 'node': if (event.status === 'start') labels[event.node] = event.label; return event.status === 'start' ? <div key={index} className="feed-node"><span />{event.label}</div> : null;
      case 'intent': return <div key={index} className="feed-card"><div className="row"><Sparkles size={15} className="dot-accent" /><strong>{event.intent.readback}</strong><span className="spacer" /><span className="engine-tag">{event.engine === 'claude' ? provider : 'Rules'}</span></div>{event.intent.candidates.length > 0 && <p className="small dim">Candidates: {event.intent.candidates.join(', ')}</p>}</div>;
      case 'reasoning': return <blockquote key={index} className="feed-reasoning"><Brain size={13} />{event.text}</blockquote>;
      case 'tool': {
        if (event.status === 'end') return null;
        const result = finished.get(event.id);
        return <div key={index} className={`feed-tool ${result ? (result.ok ? 'ok' : 'bad') : 'pending'}`}>{result ? (result.ok ? <Check size={13} /> : <X size={13} />) : <Loader2 size={13} className="spin" />}<code>{event.tool}</code><span>{result?.summary ?? 'running…'}</span></div>;
      }
      case 'assessment': return <div key={index} className={`feed-card risk-${event.assessment.risk}`}><div className="row"><strong>Risk: {event.assessment.risk}</strong></div>{event.assessment.blockers.map(blocker => <p key={blocker} className="small" style={{color: 'var(--delete)'}}>⛔ {blocker}</p>)}{event.assessment.notes.map(note => <p key={note} className="small dim">{note}</p>)}</div>;
      case 'request': return <div key={index} className="feed-card"><div className="row"><StatePill state={event.state} dryRun={event.dryRun} /><span className="id">{event.customerId}</span><span className="spacer" /><Link className="btn btn-ghost" to={`/console/requests/${event.requestId}`}>Open request <ArrowRight size={14} /></Link></div>{event.blockedBy && <p className="small" style={{color: 'var(--delete)'}}>{event.blockedBy}</p>}</div>;
      case 'briefing': return <article key={index} className="feed-briefing"><div className="row"><Bot size={16} className="dot-accent" /><h4>{event.briefing.headline}</h4><span className="spacer" /><span className="engine-tag">{event.engine === 'claude' ? `Written by ${provider}` : 'Rule-based briefing'}</span></div><p>{event.briefing.summary}</p>{event.briefing.findings.length > 0 && <ul>{event.briefing.findings.map(finding => <li key={finding}>{finding}</li>)}</ul>}{event.briefing.risks.length > 0 && <ul className="risks">{event.briefing.risks.map(risk => <li key={risk}>{risk}</li>)}</ul>}<p className="next"><ArrowRight size={14} />{event.briefing.nextStep}</p></article>;
      case 'error': return <div key={index} className="notice error"><AlertTriangle size={15} />{event.message}</div>;
      default: return null;
    }
  })}</>;
}

function ApprovalCard({approval, operator, busy, onDecide}: {approval: ApprovalRequest; operator: string; busy: boolean; onDecide: (decision: {decision: 'approve' | 'reject'; confirmation?: string; reason?: string}) => Promise<void>}) {
  const [confirmation, setConfirmation] = useState('');
  const [reason, setReason] = useState('');
  return <div className="feed-approval">
    <div className="row"><Hand size={18} /><h4>Human checkpoint: your call</h4></div>
    <p className="small dim">Approving runs the exact plan <code>{approval.planHash.slice(0, 12)}…</code> for <b>{approval.customerId}</b>: {plural(approval.deletable, 'record')} deleted, {approval.anonymized} redacted, {approval.retained} kept, across {plural(approval.systems, 'system')}. {approval.expiresHint}.</p>
    <OperatorField />
    <div className="row">
      <input className="input confirm-input" style={{maxWidth: 220}} value={confirmation} placeholder={approval.customerId} aria-label={`Type ${approval.customerId} to approve`} onChange={event => setConfirmation(event.target.value.toUpperCase())} />
      <button type="button" className="btn btn-danger" disabled={busy || !operator || confirmation !== approval.customerId} onClick={() => void onDecide({decision: 'approve', confirmation})}>{busy ? <Loader2 size={15} className="spin" /> : <ShieldCheck size={15} />}Approve and execute</button>
    </div>
    <div className="row">
      <input className="input" style={{flex: 1}} value={reason} placeholder="Or give a reason and reject" onChange={event => setReason(event.target.value)} />
      <button type="button" className="btn" disabled={busy || !operator} onClick={() => void onDecide({decision: 'reject', reason: reason.trim() || undefined})}><X size={15} />Reject</button>
    </div>
  </div>;
}
