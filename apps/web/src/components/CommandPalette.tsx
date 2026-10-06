import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useLocation, useNavigate} from 'react-router-dom';
import {useQuery, useQueryClient} from '@tanstack/react-query';
import {ArrowRight, Bot, Command, Loader2, Mic, MicOff, Search, Sparkles} from 'lucide-react';
import {api, type Interpretation} from '../api';
import {describeIntent, fromServerIntent, isConfident, parseCommand, type CommandIntent} from '../command-parser';
import {toast} from './ui';
import {useSpeech} from './speech';

export {speechSupported} from './speech';

const TAB_FOR_QUERY: Record<string, string> = {'metrics': 'overview', 'report': 'report', 'blast-radius': 'plan', 'backup': 'backup', 'verification': 'verification', 'plan': 'plan', 'footprint': 'footprint', 'dependencies': 'dependencies', 'sandbox': 'sandbox', 'audit': 'audit'};
const EXAMPLES = ['go to approvals', 'show the dependency graph', 'verify deletion', 'open the report', 'dry run customer 3175', 'roll back', 'reset the demo data'];
type Action = CommandIntent | {kind: 'investigate'; customerId?: string} | {kind: 'unknown'} | {kind: 'agent'};
type Row = {label: string; source: 'local' | 'claude' | 'rules' | 'agent' | 'suggestion'; action: () => Action; command: string};

/**
 * Ctrl/Cmd+K command bar. Clear commands are read instantly in the browser; anything looser
 * ("wipe Mira's data") goes to the server, where Claude (or the rule-based reader) resolves it.
 * Nothing typed or spoken here can execute a deletion.
 */
export function CommandPalette({open, onClose}: {open: boolean; onClose: () => void}) {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [heard, setHeard] = useState('');
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  const [reading, setReading] = useState<{text: string; result?: Interpretation; loading: boolean}>({text: '', loading: false});
  const inputRef = useRef<HTMLInputElement>(null);
  const customers = useQuery({queryKey: ['customers'], queryFn: api.customers, enabled: open});
  const currentRequest = location.pathname.match(/\/console\/requests\/([0-9a-f-]{36})/)?.[1];
  // The finished utterance is handled by runText, which is defined further down.
  const runTextRef = useRef<(value: string) => void>(() => undefined);
  const speech = useSpeech({onInterim: transcript => { setHeard(transcript); setText(transcript); }, onFinal: transcript => runTextRef.current(transcript), onError: message => toast.error(message)});
  const {listening, cancel} = speech;
  useEffect(() => { if (open) { setText(''); setHeard(''); setActive(0); setReading({text: '', loading: false}); setTimeout(() => inputRef.current?.focus(), 10); } else cancel(); }, [open, cancel]);

  const interpret = useCallback(async (value: string) => {
    setReading({text: value, loading: true});
    try { const result = await api.interpret(value, currentRequest); setReading(current => current.text === value ? {text: value, result, loading: false} : current); return result; }
    catch (error) { setReading({text: value, loading: false}); toast.error(error); return undefined; }
  }, [currentRequest]);

  // Ask the server only when the browser's reading is not specific enough, and only after typing pauses.
  const trimmed = text.trim();
  const local = parseCommand(trimmed);
  const needsServer = Boolean(trimmed) && !isConfident(local) && /[a-z]{3}/i.test(trimmed);
  useEffect(() => {
    if (!open || !needsServer || listening) return;
    const timer = setTimeout(() => { void interpret(trimmed); }, 450);
    return () => clearTimeout(timer);
  }, [open, needsServer, trimmed, listening, interpret]);

  const latestFor = useCallback((customerId?: string) => customerId ? customers.data?.find(customer => customer.customerId === customerId)?.latestRequest?.requestId : undefined, [customers.data]);

  const perform = useCallback(async (action: Action, source: string) => {
    const target = (customerId?: string) => latestFor(customerId) ?? currentRequest;
    switch (action.kind) {
      case 'blocked': toast.error('Commands cannot execute deletions. Approve the exact plan, then use the guarded Execute button on the request.'); return;
      case 'unknown': toast.info(reading.result?.intent.readback ?? `Try one of: ${EXAMPLES.slice(0, 4).join(', ')}.`); return;
      case 'agent': navigate(`/console/agent?goal=${encodeURIComponent(source)}&start=1`); onClose(); return;
      case 'investigate': navigate(`/console/agent?goal=${encodeURIComponent(source)}&start=1`); onClose(); return;
      case 'navigate': navigate(action.page === 'overview' ? '/console' : `/console/${action.page}`); onClose(); return;
      case 'reset':
        if (!window.confirm('Reset the demo? This restores the dataset and clears every request.')) return;
        setBusy(true);
        try { const result = await api.reset(); await queryClient.invalidateQueries(); toast.ok(result.dataset); navigate('/console'); onClose(); } catch (error) { toast.error(error); } finally { setBusy(false); }
        return;
      case 'request':
        setBusy(true);
        try {
          const workflow = await api.create({customerId: action.customerId, reason: `Requested from the command bar: "${source}"`, dryRun: Boolean(action.dryRun)});
          await queryClient.invalidateQueries();
          toast.ok(`${action.dryRun ? 'Dry run' : 'Request'} opened for ${action.customerId}.`);
          navigate(`/console/requests/${workflow.requestId}`);
          onClose();
        } catch (error) { toast.error(error); } finally { setBusy(false); }
        return;
      case 'approve': case 'reject': case 'rollback': {
        const id = target(action.customerId);
        if (!id) { toast.info('Open a request first, or name the customer, for example "approve customer 1042".'); return; }
        navigate(`/console/requests/${id}?focus=${action.kind}`); onClose(); return;
      }
      case 'query': {
        if (!action.query) { toast.info(`Try one of: ${EXAMPLES.slice(0, 4).join(', ')}.`); return; }
        const id = target(action.customerId);
        if (!id) { toast.info('Open a request first, or include a customer, for example "show the plan for customer 1042".'); return; }
        navigate(`/console/requests/${id}?tab=${TAB_FOR_QUERY[action.query]}`); onClose(); return;
      }
    }
  }, [currentRequest, latestFor, navigate, onClose, queryClient, reading.result]);

  /** Runs a finished utterance: local reading when it is clear, the server's reading otherwise. */
  const runText = useCallback(async (value: string) => {
    const reading = parseCommand(value);
    if (isConfident(reading)) return perform(reading, value);
    const result = await interpret(value);
    if (result) return perform(fromServerIntent(result.intent), value);
  }, [interpret, perform]);

  runTextRef.current = value => { void runText(value); };

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const lower = trimmed.toLowerCase();
    if (trimmed && isConfident(local)) out.push({label: describeIntent(local) ?? trimmed, source: 'local', action: () => local, command: trimmed});
    else if (reading.result && reading.text === trimmed) out.push({label: reading.result.intent.readback, source: reading.result.engine, action: () => fromServerIntent(reading.result!.intent), command: trimmed});
    if (trimmed.length > 6) out.push({label: `Ask the agent: “${trimmed}”`, source: 'agent', action: () => ({kind: 'agent'}), command: trimmed});
    const fromCustomers = (customers.data ?? []).flatMap(customer => customer.latestRequest
      ? [`open the plan for ${customer.customerId}`]
      : [`erase ${customer.customerId}${customer.displayName ? ` (${customer.displayName})` : ''}`]);
    for (const suggestion of [...fromCustomers, ...EXAMPLES].filter(item => !lower || item.toLowerCase().includes(lower)).slice(0, 6)) {
      const command = suggestion.replace(/\s*\(.*\)$/, '');
      out.push({label: suggestion, source: 'suggestion', action: () => parseCommand(command), command});
    }
    return out;
  }, [trimmed, local, reading, customers.data]);

  if (!open) return null;
  const choose = (row: Row) => { setText(row.command); void perform(row.action(), row.command); };
  const sourceLabel = (row: Row) => row.source === 'claude' ? `Claude${reading.result?.model ? ` (${reading.result.model})` : ''}` : row.source === 'rules' ? 'Rule-based reader' : undefined;

  return <div className="palette-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="palette" role="dialog" aria-modal="true" aria-label="Command bar">
      <div className="palette-input">
        {busy || reading.loading ? <Loader2 size={18} className="spin" /> : <Search size={18} className="muted" />}
        <input ref={inputRef} value={text} placeholder={speech.supported ? 'Type or say a command, e.g. "wipe Mira\'s data"' : 'Type a command, e.g. "wipe Mira\'s data"'} aria-label="Command" onChange={event => { setText(event.target.value); setActive(0); }}
          onKeyDown={event => {
            if (event.key === 'Escape') onClose();
            else if (event.key === 'ArrowDown') { event.preventDefault(); setActive(index => Math.min(index + 1, rows.length - 1)); }
            else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(index - 1, 0)); }
            else if (event.key === 'Enter') { event.preventDefault(); if (rows[active]) choose(rows[active]); else if (trimmed) void runText(trimmed); }
          }} />
        {speech.supported
          ? <button type="button" className={`btn icon-btn mic ${listening ? 'listening' : ''}`} aria-pressed={listening} aria-label={listening ? 'Stop listening' : 'Dictate a command'} onClick={speech.toggle}>{listening ? <MicOff size={16} /> : <Mic size={16} />}</button>
          : <span className="small muted" title="This browser has no speech recognition">Voice unavailable</span>}
      </div>
      {heard && <div className="heard" aria-live="polite">Heard: “{heard}”</div>}
      <ul className="palette-list" role="listbox" aria-label="Suggestions">
        {needsServer && reading.loading && <li className="small muted" style={{padding: '0.6rem 0.75rem'}}>Reading your command…</li>}
        {rows.map((row, index) => <li key={`${row.source}-${row.label}`}><button type="button" role="option" aria-selected={index === active} data-active={index === active} className={row.source === 'suggestion' ? undefined : 'intent'} onMouseEnter={() => setActive(index)} onClick={() => choose(row)}>
          {row.source === 'agent' ? <Bot size={14} /> : row.source === 'suggestion' ? <Command size={14} /> : <Sparkles size={14} />}
          <span>{row.label}{sourceLabel(row) && <small className="engine-tag">{sourceLabel(row)}</small>}</span><ArrowRight size={14} />
        </button></li>)}
      </ul>
      <div className="palette-foot"><span><span className="kbd">Enter</span> run</span><span><span className="kbd">↑ ↓</span> choose</span><span><span className="kbd">Esc</span> close</span><span>Deletions only run after a person approves the exact plan.</span></div>
    </div>
  </div>;
}
