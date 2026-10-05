import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useLocation, useNavigate} from 'react-router-dom';
import {useQuery, useQueryClient} from '@tanstack/react-query';
import {ArrowRight, Command, Loader2, Mic, MicOff, Search} from 'lucide-react';
import {api} from '../api';
import {parseCommand, type CommandIntent} from '../command-parser';
import {toast} from './ui';

type SpeechResult = {transcript: string; isFinal: boolean};
type SpeechRecognitionLike = {lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void; abort(): void; onresult: ((event: {results: ArrayLike<ArrayLike<SpeechResult> & {isFinal: boolean}>}) => void) | null; onerror: ((event: {error: string}) => void) | null; onend: (() => void) | null};
const SpeechRecognition = (globalThis as unknown as {SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike}).SpeechRecognition
  ?? (globalThis as unknown as {webkitSpeechRecognition?: new () => SpeechRecognitionLike}).webkitSpeechRecognition;
export const speechSupported = Boolean(SpeechRecognition);

const TAB_FOR_QUERY: Record<string, string> = {'metrics': 'overview', 'report': 'report', 'blast-radius': 'plan', 'backup': 'backup', 'verification': 'verification', 'plan': 'plan', 'footprint': 'footprint', 'dependencies': 'dependencies', 'sandbox': 'sandbox', 'audit': 'audit'};
const EXAMPLES = ['go to approvals', 'show the dependency graph', 'verify deletion', 'open the report', 'dry run customer 3175', 'roll back', 'reset the demo data'];

/** ⌘K / Ctrl+K command bar. Typed or spoken commands never execute deletions; they navigate, open requests, and stage approvals. */
export function CommandPalette({open, onClose}: {open: boolean; onClose: () => void}) {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [heard, setHeard] = useState('');
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const customers = useQuery({queryKey: ['customers'], queryFn: api.customers, enabled: open});
  const currentRequest = location.pathname.match(/\/console\/requests\/([0-9a-f-]{36})/)?.[1];

  useEffect(() => { if (open) { setText(''); setHeard(''); setActive(0); setTimeout(() => inputRef.current?.focus(), 10); } else recognition.current?.abort(); }, [open]);

  const latestFor = useCallback((customerId?: string) => customerId ? customers.data?.find(customer => customer.customerId === customerId)?.latestRequest?.requestId : undefined, [customers.data]);

  const run = useCallback(async (input: string) => {
    const intent: CommandIntent = parseCommand(input);
    const target = (customerId?: string) => latestFor(customerId) ?? currentRequest;
    switch (intent.kind) {
      case 'blocked': toast.error('Commands cannot execute deletions. Approve the exact plan, then use the guarded Execute button on the request.'); return;
      case 'navigate': navigate(intent.page === 'overview' ? '/console' : `/console/${intent.page}`); onClose(); return;
      case 'reset':
        if (!window.confirm('Reset the demo? This restores the dataset and clears every request.')) return;
        setBusy(true);
        try { const result = await api.reset(); await queryClient.invalidateQueries(); toast.ok(result.dataset); navigate('/console'); onClose(); } catch (error) { toast.error(error); } finally { setBusy(false); }
        return;
      case 'request':
        setBusy(true);
        try {
          const workflow = await api.create({customerId: intent.customerId, reason: `Requested from the command bar: "${input.trim()}"`, dryRun: Boolean(intent.dryRun)});
          await queryClient.invalidateQueries();
          toast.ok(`${intent.dryRun ? 'Dry run' : 'Request'} opened for ${intent.customerId}.`);
          navigate(`/console/requests/${workflow.requestId}`);
          onClose();
        } catch (error) { toast.error(error); } finally { setBusy(false); }
        return;
      case 'approve': case 'reject': case 'rollback': {
        const id = target(intent.customerId);
        if (!id) { toast.info('Open a request first, or name the customer, for example "approve customer 1042".'); return; }
        navigate(`/console/requests/${id}?focus=${intent.kind}`); onClose(); return;
      }
      case 'query': {
        if (!intent.query) { toast.info(`Try one of: ${EXAMPLES.slice(0, 4).join(', ')}.`); return; }
        const id = target(intent.customerId);
        if (!id) { toast.info('Open a request first, or include a customer, for example "show the plan for customer 1042".'); return; }
        navigate(`/console/requests/${id}?tab=${TAB_FOR_QUERY[intent.query]}`); onClose(); return;
      }
    }
  }, [currentRequest, latestFor, navigate, onClose, queryClient]);

  const listen = () => {
    if (!SpeechRecognition) return;
    if (listening) { recognition.current?.stop(); return; }
    const engine = new SpeechRecognition();
    engine.lang = navigator.language || 'en-US';
    engine.interimResults = true;
    engine.continuous = false;
    let finalText = '';
    engine.onresult = event => {
      const transcript = Array.from(event.results).map(result => result[0].transcript).join(' ');
      setHeard(transcript);
      setText(transcript);
      if (event.results[event.results.length - 1].isFinal) finalText = transcript;
    };
    engine.onerror = event => { if (event.error !== 'aborted' && event.error !== 'no-speech') toast.error(event.error === 'not-allowed' ? 'Microphone access was blocked. Allow it in the browser to dictate commands.' : `Voice input stopped: ${event.error}`); };
    engine.onend = () => { setListening(false); if (finalText) void run(finalText); };
    recognition.current = engine;
    setListening(true);
    engine.start();
  };

  const suggestions = useMemo(() => {
    const lower = text.toLowerCase();
    const fromCustomers = (customers.data ?? []).flatMap(customer => customer.latestRequest
      ? [`open the plan for ${customer.customerId}`]
      : [`erase ${customer.customerId}${customer.displayName ? ` (${customer.displayName})` : ''}`]);
    return [...fromCustomers, ...EXAMPLES].filter(item => !lower || item.toLowerCase().includes(lower)).slice(0, 8);
  }, [customers.data, text]);

  if (!open) return null;
  const submit = (value: string) => { const command = value.replace(/\s*\(.*\)$/, ''); setText(command); void run(command); };

  return <div className="palette-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="palette" role="dialog" aria-modal="true" aria-label="Command bar">
      <div className="palette-input">
        {busy ? <Loader2 size={18} className="spin" /> : <Search size={18} className="muted" />}
        <input ref={inputRef} value={text} placeholder={speechSupported ? 'Type or say a command…' : 'Type a command…'} aria-label="Command" onChange={event => { setText(event.target.value); setActive(0); }}
          onKeyDown={event => {
            if (event.key === 'Escape') onClose();
            else if (event.key === 'ArrowDown') { event.preventDefault(); setActive(index => Math.min(index + 1, suggestions.length - 1)); }
            else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(index - 1, 0)); }
            else if (event.key === 'Enter') { event.preventDefault(); submit(text.trim() && !suggestions[active]?.toLowerCase().includes(text.toLowerCase()) ? text : suggestions[active] ?? text); }
          }} />
        {speechSupported
          ? <button type="button" className={`btn icon-btn mic ${listening ? 'listening' : ''}`} aria-pressed={listening} aria-label={listening ? 'Stop listening' : 'Dictate a command'} onClick={listen}>{listening ? <MicOff size={16} /> : <Mic size={16} />}</button>
          : <span className="small muted" title="This browser has no speech recognition">Voice unavailable</span>}
      </div>
      {heard && <div className="heard" aria-live="polite">Heard: “{heard}”</div>}
      <ul className="palette-list" role="listbox" aria-label="Suggestions">
        {suggestions.map((suggestion, index) => <li key={suggestion}><button type="button" role="option" aria-selected={index === active} data-active={index === active} onMouseEnter={() => setActive(index)} onClick={() => submit(suggestion)}><Command size={14} /><span>{suggestion}</span><ArrowRight size={14} /></button></li>)}
      </ul>
      <div className="palette-foot"><span><span className="kbd">Enter</span> run</span><span><span className="kbd">↑ ↓</span> choose</span><span><span className="kbd">Esc</span> close</span><span>Deletions only run from the guarded Execute button.</span></div>
    </div>
  </div>;
}
