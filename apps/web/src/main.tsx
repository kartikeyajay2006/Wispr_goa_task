import {useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {ShieldCheck} from 'lucide-react';
import {DataVisuals} from './components/DataVisuals';
import {useWorkflowStore} from './store';
import {parseCommand} from './command-parser';
import './style.css';

const stages = ['intake', 'discovery', 'footprint', 'dependencies', 'classification', 'plan', 'sandbox', 'backup', 'blast_radius', 'policy', 'approval', 'execution', 'rescan', 'report'];
type Workflow = any;
type ApiError = {error?: string};
const queryClient = new QueryClient();
const scenarios = [['CUST-1042', 'Successful local demo'], ['CUST-2088', 'Approval rejection demo'], ['CUST-9001', 'Unsafe dependency block'], ['CUST-7001', 'Backup failure block']];

async function readJson(response: Response) {
  const payload = await response.json() as Workflow | ApiError;
  if (!response.ok) throw new Error((payload as ApiError).error ?? `Request failed (${response.status})`);
  return payload as Workflow;
}

function App() {
  const [customerId, setCustomerId] = useState('CUST-1042');
  const [local, setLocal] = useState<Workflow>();
  const [error, setError] = useState<string>();
  const [command, setCommand] = useState('');
  const [commandResult, setCommandResult] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const workflow = useWorkflowStore(s => s.workflow) as Workflow;
  const setWorkflow = useWorkflowStore(s => s.setWorkflow);
  const w = workflow ?? local;
  const apply = (next: Workflow) => { setLocal(next); setWorkflow(next); setError(undefined); };

  const request = async (id = customerId) => {
    setCustomerId(id);
    setConfirmation('');
    setBusy(true);
    setError(undefined);
    try {
      apply(await readJson(await fetch('/api/requests', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({customerId: id, reason: 'Customer erasure request for demo validation', dryRun: false})})));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to create request');
    } finally { setBusy(false); }
  };

  const action = async (path: string, body = {}) => {
    if (!w) return;
    setBusy(true);
    setError(undefined);
    try {
      apply(await readJson(await fetch(`/api/requests/${w.requestId}/${path}`, {method: 'POST', headers: {'content-type': 'application/json', 'x-operator-identity': 'operator'}, body: JSON.stringify(body)})));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
    } finally { setBusy(false); }
  };

  const runCommand = async () => {
    const text = command.trim();
    if (!text) return;
    setCommandResult('');
    const intent = parseCommand(text);
    try {
      if (intent.kind === 'request' && intent.customerId) {
        await request(intent.customerId);
        setCommandResult('Request created. Discovery and safety checks are running.');
      } else if (intent.kind === 'approve' && w?.stage === 'approval') {
        await action('approve', {confirmation: w.customerId});
        setCommandResult('Exact plan approved. Execution remains separately guarded.');
      } else if (intent.kind === 'reject' && w?.stage === 'approval') {
        await action('reject');
        setCommandResult('Plan rejected; no destructive tool was called.');
      } else if (intent.kind === 'blocked') {
        setCommandResult('Destructive execution requires an approved plan and explicit human authorization.');
      } else if (intent.kind === 'query' && intent.query && w) {
        const path = intent.query;
        const response = await fetch(`/api/requests/${w.requestId}/${path}`);
        setCommandResult(JSON.stringify(await response.json()));
      } else setCommandResult('Try: discover CUST-1042, request approval, reject plan, show blast radius, verify deletion, or generate audit report.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Command failed'); }
    setCommand('');
  };

  useEffect(() => { void request(); }, []);
  if (!w) return <main><p className="eyebrow">INITIALIZING CONTROL PLANE…</p>{error && <div className="failure">{error}</div>}</main>;
  const index = stages.indexOf(w.stage);
  const persistence = w.persistence?.status ?? 'pending';
  const canApprove = confirmation === w.customerId;

  return <main>
    <Header />
    <section className="hero"><div><p className="eyebrow">AUTONOMOUS DATA DELETION</p><h2>Make erasure<br /><em>provable.</em></h2><p className="lede">Discover, classify, approve, execute, and verify deletion with a deterministic safety boundary.</p><div className="scenarios">{scenarios.map(([id, label]) => <button className={id === customerId ? 'scenario active' : 'scenario'} key={id} onClick={() => void request(id)} disabled={busy}>{id}<small>{label}</small></button>)}</div></div><button className="primary" onClick={() => void request()} disabled={busy}>＋ New erasure request</button></section>
    <section className="command"><label htmlFor="eraseops-command">ASK ERASEROPS...</label><div><input id="eraseops-command" value={command} onChange={event => setCommand(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void runCommand(); }} placeholder="discover customer CUST-1042" /><button onClick={() => void runCommand()} disabled={busy}>RUN</button></div>{commandResult && <small>{commandResult}</small>}</section>
    <nav className="rail">{stages.map((stage, i) => <div className={(i <= index ? 'on ' : '') + (stage === w.stage ? 'current' : '')} key={stage}><b>{String(i + 1).padStart(2, '0')}</b><span>{stage.replace('_', ' ')}</span></div>)}</nav>
    {error && <div className="failure page-error">{error}</div>}
    <div className="grid"><section className="panel footprint"><PanelTitle eyebrow="ACTIVE REQUEST" title={`${w.customerId} · ${w.status.replace('_', ' ')}`} chip={w.stage} /><div className="stats"><Stat n={w.blastRadius.records} label="records" /><Stat n={w.blastRadius.deletable} label="delete" tone="teal" /><Stat n={w.blastRadius.anonymized} label="anonymize" tone="amber" /><Stat n={w.blastRadius.retained} label="retain" tone="muted" /></div><div className="table">{w.assets.map((asset: any) => <div className="row" key={asset.id}><div className="asset"><span className={'dot ' + asset.classification} /><div><strong>{asset.label}</strong><small>{asset.system} / {asset.table} · {asset.count} records</small></div></div><span className={'tag ' + asset.classification}>{asset.classification}</span></div>)}</div><DataVisuals workflow={w} /></section>
      <aside className="side"><section className="panel guard"><PanelTitle eyebrow="POLICY GATE" title="Human checkpoint" /><ShieldCheck className="shield" size={24} /><p>Destructive actions require the exact plan, sandbox, backup, and approval checks.</p><div className="hash"><small>PLAN SHA-256</small><code>{w.plan.hash.slice(0, 20)}…</code></div><div className="persistence"><span>AUTHORITATIVE SNAPSHOT</span><b className={persistence}>{persistence.toUpperCase()}</b></div><Check label="Sandbox verification" ok={w.sandbox?.status === 'passed'} /><Check label="Backup integrity" ok={w.backupVerified} /><Check label="Post-execution rescan" ok={w.stage === 'report'} />{w.sandbox?.failures?.length > 0 && <div className="failure">UNSAFE PLAN BLOCKED<br /><small>{w.sandbox.failures[0]}</small></div>}
        {w.stage === 'approval' && <><label className="confirmation-label" htmlFor="approval-confirmation">TYPE {w.customerId} TO APPROVE</label><input className="confirmation-input" id="approval-confirmation" value={confirmation} onChange={event => setConfirmation(event.target.value.toUpperCase())} placeholder={w.customerId} /><button className="approve" onClick={() => void action('approve', {confirmation})} disabled={busy || !canApprove}>Approve exact plan · {w.customerId}</button><button className="reject" onClick={() => void action('reject')} disabled={busy}>Reject plan</button></>}
        {w.stage === 'execution' && <button className="approve" onClick={() => void action('execute-guarded', {approvalId: w.approval?.token, planHash: w.plan.hash})} disabled={busy}>Confirm guarded execution</button>}
        {w.stage === 'report' && <div className="success">✓ Final report sealed · no live data touched</div>}
      </section><section className="panel audit"><PanelTitle eyebrow="IMMUTABLE TRAIL" title="Audit timeline" chip={String(w.events.length)} /><div className="events">{w.events.slice(-7).reverse().map((event: any) => <div className="event" key={event.id}><i /><div><strong>{event.message}</strong><small>{event.stage} · {new Date(event.at).toLocaleTimeString()}</small></div></div>)}</div></section></aside></div>
  </main>;
}

const Header = () => <header><div className="brand"><span className="mark">⌁</span><div><div className="eyebrow">SECURITY OPERATIONS / DEMO CONTROL</div><h1>Eraser<span>Ops</span></h1></div></div><div className="mode"><i /> DEMO SANDBOX<br /><small>AWS optional · credentials redacted</small></div></header>;
const PanelTitle = ({eyebrow, title, chip}: {eyebrow: string; title: string; chip?: string}) => <div className="panel-head"><div><p className="eyebrow">{eyebrow}</p><h3>{title}</h3></div>{chip && <span className="chip amber">{chip}</span>}</div>;
const Stat = ({n, label, tone = ''}: {n: number; label: string; tone?: string}) => <div className="stat"><strong className={tone}>{n}</strong><span>{label}</span></div>;
const Check = ({label, ok}: {label: string; ok: boolean}) => <div className="check"><i className={ok ? 'pass' : 'wait'}>{ok ? '✓' : '·'}</i><span>{label}</span><b>{ok ? 'PASS' : 'PENDING'}</b></div>;

createRoot(document.getElementById('root')!).render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);
