import {lazy, Suspense, useEffect, useRef, useState, type CSSProperties} from 'react';
import {Link, useNavigate, useParams, useSearchParams} from 'react-router-dom';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {AlertTriangle, ArrowRight, Check, CheckCircle2, Download, FileCheck2, HardDrive, Loader2, LockKeyhole, Printer, RefreshCw, RotateCcw, ScanLine, ShieldAlert, ShieldCheck, X} from 'lucide-react';
import {api, ApiError, type Stage, type Workflow} from '../api';
import {useOperator} from '../operator';
import {ActionChip, Empty, ErrorNotice, FootprintBar, Guilloche, Hash, Legend, StatePill, formatTime, plural, readable, relativeTime, toast, useActiveInView} from '../components/ui';
import {TabInk, atLeast} from '../components/motion';
import {OperatorField} from '../components/OperatorField';

const order = (i: number) => ({'--i': i}) as CSSProperties;

const DependencyGraph = lazy(() => import('./DependencyGraph'));
const STAGES: Stage[] = ['intake', 'discovery', 'footprint', 'dependencies', 'classification', 'plan', 'sandbox', 'backup', 'blast_radius', 'policy', 'approval', 'execution', 'rescan', 'report'];
const STAGE_LABEL: Record<Stage, string> = {intake: 'Intake', discovery: 'Discover', footprint: 'Footprint', dependencies: 'Dependencies', classification: 'Classify', plan: 'Plan', sandbox: 'Sandbox', backup: 'Backup', blast_radius: 'Blast radius', policy: 'Policy', approval: 'Approval', execution: 'Execute', rescan: 'Rescan', report: 'Report'};
const TABS = [['overview', 'Timeline'], ['footprint', 'Footprint'], ['dependencies', 'Dependencies'], ['plan', 'Plan'], ['sandbox', 'Sandbox'], ['backup', 'Backup'], ['verification', 'Verification'], ['report', 'Report'], ['audit', 'Audit']] as const;
type Tab = typeof TABS[number][0];

export default function RequestDetail() {
  const {id = ''} = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.some(([key]) => key === params.get('tab')) ? params.get('tab') : 'overview') as Tab;
  const workflow = useQuery({queryKey: ['request', id], queryFn: () => api.request(id), refetchInterval: query => query.state.data?.state === 'APPROVED' ? 5_000 : false});
  const tabsRef = useRef<HTMLDivElement>(null);
  useActiveInView(tabsRef, '[aria-selected="true"]', `${tab}:${Boolean(workflow.data)}`);

  if (workflow.isLoading) return <div className="page"><div className="skeleton" style={{height: 120}} /><div className="skeleton" style={{height: 420}} /></div>;
  if (workflow.error || !workflow.data) return <div className="page"><ErrorNotice error={workflow.error ?? new Error('Request not found')} />{workflow.error instanceof ApiError && workflow.error.status === 404 && <p className="dim">Requests live in memory unless persistence is set to PostgreSQL, so restarting the API or resetting the demo clears them. <Link to="/console/requests/new">Open a new one</Link>.</p>}</div>;
  const data = workflow.data;
  const setTab = (next: Tab) => setParams(previous => { const copy = new URLSearchParams(previous); copy.set('tab', next); copy.delete('focus'); return copy; }, {replace: true});

  return <div className="page">
    <header className="req-head">
      <div className="req-title"><h1>{data.customerId}</h1><StatePill state={data.state} dryRun={data.dryRun} />{data.dryRun && <span className="pill neutral">Dry run</span>}</div>
      <div className="req-meta">
        <span>Plan <Hash value={data.plan.hash} /></span>
        <span>Opened <b title={formatTime(data.request?.createdAt)}>{relativeTime(data.request?.createdAt)}</b> by <b>{data.request?.requestedBy}</b></span>
        {data.request?.reason && <span>Reason <b>{data.request.reason}</b></span>}
      </div>
      <StageTrack workflow={data} />
    </header>
    <div className="req-grid">
      <section className="panel req-body">
        <div className="tabs" role="tablist" aria-label="Request evidence" ref={tabsRef}><TabInk container={tabsRef} activeKey={tab} />{TABS.map(([key, label]) => <button key={key} type="button" role="tab" className="tab" aria-selected={tab === key} onClick={() => setTab(key)}>{label}{key === 'footprint' && <span className="count">{data.assets.length}</span>}{key === 'sandbox' && data.sandbox?.status === 'failed' && <AlertTriangle size={13} className="dot-bad" />}{key === 'backup' && data.sandboxPassed && !data.backupVerified && <AlertTriangle size={13} className="dot-bad" />}</button>)}</div>
        <div className="tab-body" role="tabpanel">
          {tab === 'overview' && <TimelineTab workflow={data} />}
          {tab === 'footprint' && <FootprintTab workflow={data} />}
          {tab === 'dependencies' && <DependenciesTab workflow={data} />}
          {tab === 'plan' && <PlanTab workflow={data} />}
          {tab === 'sandbox' && <SandboxTab workflow={data} />}
          {tab === 'backup' && <BackupTab workflow={data} />}
          {tab === 'verification' && <VerificationTab workflow={data} />}
          {tab === 'report' && <ReportTab workflow={data} />}
          {tab === 'audit' && <AuditTab workflow={data} />}
        </div>
      </section>
      <SafetyRail workflow={data} focus={params.get('focus')} onTab={setTab} />
    </div>
  </div>;
}

function StageTrack({workflow}: {workflow: Workflow}) {
  const reached = new Set(workflow.events.map(event => event.stage));
  const current = workflow.stage;
  const failed = workflow.status === 'blocked' && !['REJECTED', 'ROLLED_BACK'].includes(workflow.state ?? '');
  const strip = useRef<HTMLDivElement>(null);
  useActiveInView(strip, '[aria-current="step"]', current);
  return <div className="stages" ref={strip} aria-label="Workflow progress" tabIndex={0}>{STAGES.map((stage, index) => {
    const state = stage === current ? (failed ? 'failed' : 'current') : reached.has(stage) ? 'done' : '';
    return <div key={stage} className={`stage ${state}`} style={order(index)} aria-current={stage === current ? 'step' : undefined}><i /><span>{STAGE_LABEL[stage]}</span></div>;
  })}</div>;
}

/* ---------------- Safety rail ---------------- */
function SafetyRail({workflow, focus, onTab}: {workflow: Workflow; focus: string | null; onTab: (tab: Tab) => void}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const operator = useOperator(state => state.name.trim());
  const [confirmation, setConfirmation] = useState('');
  const [reason, setReason] = useState('');
  const approveRef = useRef<HTMLInputElement>(null);
  const rejectRef = useRef<HTMLTextAreaElement>(null);
  const rollbackRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (focus === 'approve') approveRef.current?.focus(); else if (focus === 'reject') rejectRef.current?.focus(); else if (focus === 'rollback') rollbackRef.current?.focus(); }, [focus]);
  // Re-render every second while approved, so an expiring approval turns into a renewal form on time.
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (workflow.state !== 'APPROVED') return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [workflow.state]);
  const expired = workflow.state === 'APPROVED' && Boolean(workflow.approval) && Date.parse(workflow.approval!.expiresAt) <= now && !workflow.approval!.used;

  const refresh = async (next: Workflow) => { queryClient.setQueryData(['request', next.requestId], next); await queryClient.invalidateQueries({predicate: query => query.queryKey[0] !== 'request'}); };
  const onError = async (error: unknown) => { toast.error(error); await queryClient.invalidateQueries({queryKey: ['request', workflow.requestId]}); };
  const approve = useMutation({mutationFn: () => api.approve(workflow.requestId, confirmation), onSuccess: async next => { setConfirmation(''); await refresh(next); toast.ok(expired ? `Approval renewed by ${operator}.` : `Plan approved by ${operator}. Execute it before the approval expires.`); }, onError});
  const reject = useMutation({mutationFn: () => api.reject(workflow.requestId, reason.trim() || undefined), onSuccess: async next => { await refresh(next); toast.ok('Plan rejected. Nothing was deleted.'); }, onError});
  const execute = useMutation({mutationFn: () => atLeast(api.execute(workflow.requestId, workflow.approval!.token, workflow.plan.hash), 1800), onSuccess: async next => { await refresh(next); toast.ok(`Erased and verified: ${next.verification?.remainingMatches ?? 0} residual records.`); onTab('report'); }, onError});
  const rollback = useMutation({mutationFn: () => api.rollback(workflow.requestId), onSuccess: async next => { await refresh(next); toast.ok('Data restored from the request backup.'); }, onError});
  const live = useMutation({mutationFn: () => api.create({customerId: workflow.customerId, reason: workflow.request?.reason ?? 'Erasure request', dryRun: false}), onSuccess: async next => { await queryClient.invalidateQueries(); navigate(`/console/requests/${next.requestId}`); toast.ok('Live request opened from the dry run.'); }, onError: error => toast.error(error)});
  const busy = approve.isPending || reject.isPending || execute.isPending || rollback.isPending || live.isPending;

  const sandbox = workflow.sandbox?.status;
  const gates: Array<[string, 'pass' | 'fail' | 'wait', string]> = [
    ['Sandbox rehearsal', sandbox === 'passed' ? 'pass' : sandbox === 'failed' ? 'fail' : 'wait', sandbox === 'failed' ? 'blocked' : sandbox ?? 'pending'],
    ['Verified backup', workflow.backupVerified ? 'pass' : workflow.sandboxPassed ? 'fail' : 'wait', workflow.backupVerified ? 'verified' : workflow.sandboxPassed ? 'failed' : 'skipped'],
    ['Plan hash bound', workflow.plan.hash ? 'pass' : 'wait', `v${workflow.plan.version ?? 1}`],
    ['Human approval', workflow.approval ? 'pass' : workflow.state === 'REJECTED' ? 'fail' : 'wait', workflow.approval ? (workflow.approval.approvedBy ?? 'approved') : workflow.state === 'REJECTED' ? 'rejected' : 'pending'],
    ['Rescan proves erasure', workflow.state === 'COMPLETED' ? 'pass' : workflow.state === 'VERIFICATION_FAILED' ? 'fail' : 'wait', workflow.verification ? `${workflow.verification.remainingMatches} left` : 'pending'],
  ];

  return <aside className="rail">
    <section className="panel panel-pad stack">
      <div className="row"><ShieldCheck size={20} className="dot-accent" /><h3 style={{fontSize: 'var(--step-1)'}}>Safety gates</h3></div>
      <div className="gate-list">{gates.map(([label, state, note]) => <div key={label} className={`gate ${state}`}><span className="mark">{state === 'pass' ? <Check size={13} /> : state === 'fail' ? <X size={13} /> : <span>·</span>}</span><span>{label}</span><small>{note}</small></div>)}</div>
    </section>

    <section className="panel panel-pad stack">
      {workflow.state === 'AWAITING_HUMAN_APPROVAL' && workflow.dryRun && <>
        <h3 style={{fontSize: 'var(--step-1)'}}>Dry run complete</h3>
        <p className="small dim">The plan passed sandbox and backup. Dry runs can be reviewed but never executed.</p>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => live.mutate()}>{live.isPending ? <Loader2 size={15} className="spin" /> : <ArrowRight size={15} />}Open a live request</button>
      </>}

      {workflow.state === 'AWAITING_HUMAN_APPROVAL' && !workflow.dryRun && <>
        <div><h3 style={{fontSize: 'var(--step-1)'}}>Approve this exact plan</h3><p className="small dim">{plural(workflow.blastRadius.deletable, 'record')} will be deleted and {workflow.blastRadius.anonymized} redacted across {plural(workflow.blastRadius.systems, 'system')}. Review the <button type="button" className="link-btn" onClick={() => onTab('plan')}>plan</button> first.</p></div>
        <OperatorField />
        <label className="field"><span>Type <b className="mono">{workflow.customerId}</b> to confirm</span><input ref={approveRef} className="input confirm-input" value={confirmation} placeholder={workflow.customerId} autoComplete="off" onChange={event => setConfirmation(event.target.value.toUpperCase())} /></label>
        <button type="button" className="btn btn-primary btn-lg" disabled={busy || !operator || confirmation !== workflow.customerId} onClick={() => approve.mutate()}>{approve.isPending ? <Loader2 size={16} className="spin" /> : <LockKeyhole size={16} />}Approve plan</button>
        <label className="field"><span>Or reject it</span><textarea ref={rejectRef} className="textarea" value={reason} placeholder="Why? (recorded in the audit trail)" onChange={event => setReason(event.target.value)} /></label>
        <button type="button" className="btn" disabled={busy || !operator} onClick={() => reject.mutate()}>{reject.isPending ? <Loader2 size={15} className="spin" /> : <X size={15} />}Reject plan</button>
      </>}

      {expired && workflow.approval && <>
        <div><h3 style={{fontSize: 'var(--step-1)'}}>Approval expired</h3><p className="small dim">{workflow.approval.approvedBy} approved this plan, but it was not executed within the approval window. Renew the approval for the same plan hash to continue.</p></div>
        <OperatorField />
        <label className="field"><span>Type <b className="mono">{workflow.customerId}</b> to renew</span><input className="input confirm-input" value={confirmation} placeholder={workflow.customerId} autoComplete="off" onChange={event => setConfirmation(event.target.value.toUpperCase())} /></label>
        <button type="button" className="btn btn-primary btn-lg" disabled={busy || !operator || confirmation !== workflow.customerId} onClick={() => approve.mutate()}>{approve.isPending ? <Loader2 size={16} className="spin" /> : <LockKeyhole size={16} />}Renew approval</button>
      </>}

      {workflow.state === 'APPROVED' && workflow.approval && !expired && <>
        <div><h3 style={{fontSize: 'var(--step-1)'}}>Ready to execute</h3><p className="small dim">Approved by <b>{workflow.approval.approvedBy}</b>. The approval works once and expires in <Countdown until={workflow.approval.expiresAt} />.</p></div>
        <div className="notice warn"><AlertTriangle size={15} />This permanently deletes {plural(workflow.blastRadius.deletable, 'record')} and redacts {workflow.blastRadius.anonymized}. A backup is kept for rollback if verification fails.</div>
        {!operator && <OperatorField label="Executing as" />}
        {execute.isPending && <ErasingProgress workflow={workflow} />}
        <button type="button" className="btn btn-danger btn-lg" disabled={busy || !operator} onClick={() => execute.mutate()}>{execute.isPending ? <><Loader2 size={16} className="spin" />Executing and rescanning…</> : <>Execute approved plan</>}</button>
      </>}

      {(workflow.state === 'EXECUTION_FAILED' || workflow.state === 'VERIFICATION_FAILED') && <>
        <div className="notice error"><ShieldAlert size={15} />{workflow.state === 'VERIFICATION_FAILED' ? `The rescan still found ${plural(workflow.verification?.remainingMatches ?? 0, 'record')}.` : 'An action failed part-way.'} Restore everything from the request backup.</div>
        {!operator && <OperatorField label="Rolling back as" />}
        <button ref={rollbackRef} type="button" className="btn btn-primary btn-lg" disabled={busy || !operator} onClick={() => rollback.mutate()}>{rollback.isPending ? <Loader2 size={16} className="spin" /> : <RotateCcw size={16} />}Roll back from backup</button>
      </>}

      {workflow.state === 'COMPLETED' && <>
        <div className="notice ok"><CheckCircle2 size={15} />Erased and verified. The rescan found {workflow.verification?.remainingMatches ?? 0} residual records.</div>
        <button type="button" className="btn btn-primary" onClick={() => onTab('report')}><FileCheck2 size={15} />View certificate</button>
      </>}
      {workflow.state === 'SANDBOX_FAILED' && <><div className="notice error"><ShieldAlert size={15} /><span>{workflow.sandbox?.failures[0]}</span></div><p className="small dim">Resolve the shared dependency (for example transfer ownership), then open a new request. Nothing was backed up or changed.</p><button type="button" className="btn" onClick={() => onTab('sandbox')}>See the sandbox report</button></>}
      {workflow.state === 'BACKING_UP' && <><div className="notice error"><HardDrive size={15} /><span>{workflow.backupFailures?.[0] ?? workflow.backupChecks?.find(check => !check.verified)?.reason}</span></div><p className="small dim">Approval stays locked until every affected record can be backed up and read back.</p><button type="button" className="btn" onClick={() => onTab('backup')}>See the backup report</button></>}
      {workflow.state === 'REJECTED' && <div className="notice info"><X size={15} />Rejected by {workflow.rejection?.rejectedBy}{workflow.rejection?.reason ? `: ${workflow.rejection.reason}` : ''}. No data changed.</div>}
      {workflow.state === 'ROLLED_BACK' && <div className="notice info"><RotateCcw size={15} />Rolled back. The customer's data was restored from the request backup.</div>}
    </section>
  </aside>;
}

/** Shown while the approved plan runs: each action is struck through in order, then the rescan line sweeps. */
function ErasingProgress({workflow}: {workflow: Workflow}) {
  return <div className="erasing" role="status" aria-live="polite">
    <div className="erasing-title"><Loader2 size={15} className="spin" />Executing {plural(workflow.plan.items.length, 'action')}, then rescanning every system</div>
    {workflow.plan.items.map((item, index) => <div key={item.id} className={`er-row ${item.action}`} style={order(index)}><span>{item.label}</span><span>{item.action === 'retain' ? 'kept' : item.action === 'redact' ? `redact ${item.count}` : `delete ${item.count}`}</span></div>)}
  </div>;
}

function Countdown({until}: {until: string}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const left = Math.max(0, Date.parse(until) - now);
  if (!left) return <b className="countdown" style={{color: 'var(--delete)'}}>expired</b>;
  return <b className="countdown">{Math.floor(left / 60000)}:{String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}</b>;
}

/* ---------------- Tabs ---------------- */
function TimelineTab({workflow}: {workflow: Workflow}) {
  return <div className="stack">
    <div className="blast">
      <Stat value={workflow.assets.length} label={`resources in ${plural(workflow.blastRadius.systems, 'system')}`} />
      <Stat value={workflow.blastRadius.deletable} label="records to delete" color="var(--delete)" />
      <Stat value={workflow.blastRadius.anonymized} label="records to redact" color="var(--redact)" />
      <Stat value={workflow.blastRadius.retained} label="records retained" color="var(--retain)" />
      {workflow.verification && <Stat value={workflow.verification.remainingMatches} label="residual after rescan" color={workflow.verification.remainingMatches ? 'var(--delete)' : 'var(--ok)'} />}
    </div>
    <ol className="timeline">{workflow.events.map((event, index) => <li key={event.id} style={order(index)}><span className={`node ${event.actor}`} /><div><strong>{readable(event.message)}</strong><small>{STAGE_LABEL[event.stage]}, {event.actor}, {formatTime(event.at)}</small></div></li>)}</ol>
  </div>;
}

function Stat({value, label, color}: {value: number | string; label: string; color?: string}) { return <div className="blast-stat"><strong style={color ? {color} : undefined}>{value}</strong><span>{label}</span></div>; }

function FootprintTab({workflow}: {workflow: Workflow}) {
  return <div className="stack">
    <div className="row"><p className="dim small">Discovered through the allowlisted connectors. Record IDs are evidence; values never leave the connectors.</p><span className="spacer" /><Legend /></div>
    <div className="panel" style={{boxShadow: 'none'}}>
      <div className="asset-row asset-head small"><span>Resource</span><span>System</span><span>Records</span><span>Policy</span><span>Evidence</span></div>
      {workflow.assets.map(asset => <div className="asset-row" key={asset.id}>
        <div><strong>{asset.label}</strong><div className="id muted">{asset.table}</div></div>
        <span className="dim">{asset.system}</span>
        <span className="num">{asset.count}</span>
        <span><ActionChip action={asset.classification} /></span>
        <div className="records">{(asset.recordIds ?? []).slice(0, 6).map(record => <code key={record}>{record}</code>)}{(asset.recordIds?.length ?? 0) > 6 && <code>+{asset.recordIds!.length - 6}</code>}{!asset.recordIds?.length && <span className="muted small">{asset.fields.join(', ')}</span>}</div>
      </div>)}
    </div>
  </div>;
}

function DependenciesTab({workflow}: {workflow: Workflow}) {
  const shared = (workflow.dependencies ?? []).filter(dependency => dependency.constraintType === 'business');
  const holds = (workflow.dependencies ?? []).filter(dependency => dependency.constraintType === 'retention');
  return <div className="stack">
    {shared.length ? <div className="notice error"><ShieldAlert size={16} /><div>{shared.map(dependency => <div key={dependency.source}>{dependency.relationshipType}</div>)}</div></div> : <div className="notice ok"><ShieldCheck size={16} />No other customer's records point at this footprint.</div>}
    <Suspense fallback={<div className="skeleton" style={{height: 460}} />}><DependencyGraph workflow={workflow} /></Suspense>
    <div className="legend"><span><i style={{background: 'var(--delete)'}} />Shared with another customer</span><span><i style={{background: 'var(--retain)'}} />Retention hold</span><span><i style={{background: 'var(--line-strong)'}} />Foreign key</span></div>
    {holds.length > 0 && <div className="stack" style={{gap: '0.3rem'}}><h4>Retention holds</h4>{holds.map(hold => <div className="check warn" key={hold.source}><LockKeyhole size={14} /><span><code>{hold.source.split(':')[1]}</code> {hold.relationshipType}</span></div>)}</div>}
  </div>;
}

function PlanTab({workflow}: {workflow: Workflow}) {
  return <div className="stack">
    <div className="row small dim"><span>Version {workflow.plan.version ?? 1}</span><span>Risk score {workflow.plan.riskScore ?? 'n/a'}</span><span>Status <b>{workflow.plan.status.replace('_', ' ')}</b></span><span className="spacer" /><Hash value={workflow.plan.hash} length={24} /></div>
    <FootprintBar deletable={workflow.blastRadius.deletable} anonymize={workflow.blastRadius.anonymized} retained={workflow.blastRadius.retained} />
    <div className="panel" style={{boxShadow: 'none'}}>{workflow.plan.items.map((item, index) => {
      const result = workflow.executionResults?.find(entry => entry.actionId === item.id);
      return <div key={item.id} className={`plan-row ${item.action}`}><span className="n">{String(index + 1).padStart(2, '0')}</span><div><strong>{item.label} <span className="muted" style={{fontWeight: 400}}>({plural(item.count, 'record')})</span></strong><small>{item.system} / {item.table}. {item.basis}</small>{result && <small style={{display: 'block', color: result.status === 'completed' ? 'var(--ok)' : 'var(--muted)'}}>{result.status === 'skipped' ? 'Retained, nothing changed' : `${plural(result.affectedRecords, 'record')} changed`}</small>}</div><ActionChip action={item.action} /></div>;
    })}</div>
  </div>;
}

function SandboxTab({workflow}: {workflow: Workflow}) {
  const sandbox = workflow.sandbox;
  if (!sandbox) return <Empty icon={<ScanLine size={28} />} title="No sandbox result" />;
  return <div className="stack">
    <div className={`notice ${sandbox.status === 'passed' ? 'ok' : 'error'}`}>{sandbox.status === 'passed' ? <ShieldCheck size={16} /> : <ShieldAlert size={16} />}{sandbox.status === 'passed' ? `The plan was rehearsed on isolated copies and passed ${plural(sandbox.tests.length, 'check')}.` : `The rehearsal found ${plural(sandbox.failures.length, 'problem')}, so the plan was blocked before any backup or approval.`}</div>
    {sandbox.failures.map(failure => <div key={failure} className="check fail"><X size={15} /><span>{failure}</span></div>)}
    {sandbox.warnings.map(warning => <div key={warning} className="check warn"><AlertTriangle size={15} /><span>{warning}</span></div>)}
    {(sandbox.simulations ?? []).map(simulation => <div key={simulation.system} className="panel panel-pad stack" style={{boxShadow: 'none', gap: '0.5rem'}}>
      <div className="row"><strong>{simulation.system}</strong><span className="pill neutral">{simulation.mode === 'transaction-rollback' ? 'Rolled-back transaction' : simulation.mode === 'object-listing' ? 'Object listing' : 'Isolated copy'}</span><span className="spacer" /><span className="small muted">{plural(simulation.affected, 'record')} changed in rehearsal, {simulation.residualAfter} left</span></div>
      {simulation.checks.map(check => <div key={check} className={`check ${simulation.failures.length ? 'warn' : 'pass'}`}><Check size={15} /><span>{check}</span></div>)}
    </div>)}
    <p className="small muted">Ran {formatTime(sandbox.executedAt)}</p>
  </div>;
}

function BackupTab({workflow}: {workflow: Workflow}) {
  if (!workflow.sandboxPassed) return <Empty icon={<HardDrive size={28} />} title="No backup was taken"><p>The sandbox blocked this plan, so no customer data was copied.</p></Empty>;
  return <div className="stack">
    <div className={`notice ${workflow.backupVerified ? 'ok' : 'error'}`}>{workflow.backupVerified ? <ShieldCheck size={16} /> : <ShieldAlert size={16} />}{workflow.backupVerified ? 'Every affected record was backed up, read back, and matched its checksum.' : 'The backup is incomplete or unverifiable, so approval is locked.'}</div>
    {(workflow.backupFailures ?? []).map(failure => <div key={failure} className="check fail"><X size={15} /><span>{failure}</span></div>)}
    {(workflow.backupChecks ?? []).map(check => <div key={check.system} className={`check ${check.verified ? 'pass' : 'fail'}`}>{check.verified ? <Check size={15} /> : <X size={15} />}<span><b>{check.system}</b>: {check.reason}</span></div>)}
    {workflow.backup && <div className="panel table-wrap" style={{boxShadow: 'none'}} tabIndex={0}><table className="table"><thead><tr><th>Resource</th><th>Kind</th><th className="num">Records</th><th>SHA-256</th></tr></thead><tbody>{workflow.backup.resources.map(resource => <tr key={resource.resource}><td className="id">{resource.resource}</td><td className="dim">{resource.kind}</td><td className="num">{resource.records}</td><td><Hash value={resource.checksum} length={16} /></td></tr>)}</tbody></table></div>}
  </div>;
}

function VerificationTab({workflow}: {workflow: Workflow}) {
  const rescan = useQuery({queryKey: ['verification', workflow.requestId], queryFn: () => api.verification(workflow.requestId)});
  return <div className="stack">
    <div className="row"><p className="dim small">A fresh rescan of every system, run now. Before execution it shows what is still there; afterwards it is the proof.</p><span className="spacer" /><button type="button" className="btn" disabled={rescan.isFetching} onClick={() => void rescan.refetch()}>{rescan.isFetching ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}Rescan now</button></div>
    <ErrorNotice error={rescan.error} />
    {rescan.data && <>
      <div className={`notice ${rescan.data.verified ? 'ok' : 'warn'}`}>{rescan.data.verified ? <ShieldCheck size={16} /> : <ScanLine size={16} />}{rescan.data.verified ? 'No erasable personal data remains for this customer.' : `${plural(rescan.data.remainingMatches, 'record')} of erasable personal data still present.`} <span className="muted">Checked {formatTime(rescan.data.checkedAt)}</span></div>
      {rescan.data.results.map(result => <div key={result.system} className={`check ${result.verified ? 'pass' : 'warn'}`}>{result.verified ? <Check size={15} /> : <AlertTriangle size={15} />}<span><b>{result.system}</b>: {result.details}</span></div>)}
    </>}
  </div>;
}

function ReportTab({workflow}: {workflow: Workflow}) {
  const report = useQuery({queryKey: ['report', workflow.requestId, workflow.state], queryFn: () => api.report(workflow.requestId)});
  const audit = useQuery({queryKey: ['request-audit', workflow.requestId, workflow.events.length], queryFn: () => api.requestAudit(workflow.requestId)});
  const data = report.data;
  if (!data) return report.error ? <ErrorNotice error={report.error} /> : <div className="skeleton" style={{height: 360}} />;
  const erased = data.state === 'COMPLETED';
  const download = () => { const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'}); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `eraseops-report-${data.customerId}-${data.requestId.slice(0, 8)}.json`; link.click(); URL.revokeObjectURL(link.href); };
  return <div className="stack">
    <article className="certificate">
      <Guilloche className="rosette" size={300} strokes={22} />
      <div className="cert-head"><span className="small dim">{erased ? 'Certificate of erasure' : 'Erasure report'}</span><h2>{erased ? `${data.customerId}'s personal data was erased and the erasure was verified.` : `${data.customerId}: ${data.state?.toLowerCase().replaceAll('_', ' ')}`}</h2><p>{erased ? `${data.summary.deleted} records deleted and ${data.summary.anonymized} redacted across ${plural(data.summary.systems, 'system')}. ${data.summary.retained} records are retained under the retention policy.` : 'This report records what was planned and why it did not complete.'}</p></div>
      <dl className="cert-grid">
        <div><dt>Request</dt><dd className="mono">{data.requestId}</dd></div>
        <div><dt>Plan hash</dt><dd><Hash value={data.planHash} length={16} /></dd></div>
        <div><dt>Requested by</dt><dd>{data.request?.requestedBy ?? 'n/a'}</dd></div>
        <div><dt>Approved by</dt><dd>{data.approval?.approvedBy ?? (data.rejection ? `Rejected by ${data.rejection.rejectedBy}` : 'Not approved')}</dd></div>
        <div><dt>Executed</dt><dd>{workflow.executionCompletedAt ? formatTime(workflow.executionCompletedAt) : 'Not executed'}</dd></div>
        <div><dt>Execution time</dt><dd>{data.metrics.totalExecutionTimeMs} ms</dd></div>
        <div><dt>Residual after rescan</dt><dd style={{color: data.verification.remainingMatches === 0 ? 'var(--ok)' : undefined}}>{data.verification.remainingMatches < 0 ? 'Not rescanned' : data.verification.remainingMatches}</dd></div>
        <div><dt>Audit chain</dt><dd>{audit.data ? (audit.data.chain.valid ? `Intact, ${plural(audit.data.events.length, 'event')}` : `Broken: ${audit.data.chain.reason}`) : '…'}</dd></div>
      </dl>
      <div className="cert-foot"><div className={`seal stamp ${erased ? '' : 'void'}`}>{erased ? <>Verified<br />erased</> : <>Not<br />erased</>}</div><span className="small dim">Generated {formatTime(data.generatedAt)}<br />Report {data.reportId.slice(0, 22)}</span><div className="row no-print"><button type="button" className="btn" onClick={() => window.print()}><Printer size={15} />Print or save as PDF</button><button type="button" className="btn" onClick={download}><Download size={15} />Download JSON</button></div></div>
    </article>
    <div className="panel table-wrap" style={{boxShadow: 'none'}} tabIndex={0}><table className="table"><thead><tr><th>Action</th><th>Resource</th><th className="num">Planned</th><th className="num">Changed</th><th>Result</th></tr></thead><tbody>{data.actions.map(action => <tr key={action.id}><td><ActionChip action={action.action} /></td><td><span className="id">{action.resource}</span> <span className="muted small">{action.system}</span></td><td className="num">{action.planned}</td><td className="num">{action.changed}</td><td className="dim">{action.status}</td></tr>)}</tbody></table></div>
  </div>;
}

function AuditTab({workflow}: {workflow: Workflow}) {
  const audit = useQuery({queryKey: ['request-audit', workflow.requestId, workflow.events.length], queryFn: () => api.requestAudit(workflow.requestId)});
  return <div className="stack">
    {audit.data && <div className={`notice ${audit.data.chain.valid ? 'ok' : 'error'}`}>{audit.data.chain.valid ? <ShieldCheck size={16} /> : <ShieldAlert size={16} />}{audit.data.chain.valid ? `Hash chain verified across ${plural(audit.data.events.length, 'event')}.` : audit.data.chain.reason}</div>}
    <div className="panel table-wrap" style={{boxShadow: 'none'}} tabIndex={0}><table className="table"><thead><tr><th>#</th><th>Event</th><th>Actor</th><th>Previous</th><th>Hash</th></tr></thead><tbody>{(audit.data?.events ?? workflow.events).map(event => <tr key={event.id}><td className="mono muted">{event.sequence}</td><td><div>{readable(event.message)}</div><small className="muted">{STAGE_LABEL[event.stage]}, {formatTime(event.at)}</small></td><td className="dim">{event.actor}</td><td><code className="muted">{event.previousHash === 'GENESIS' ? 'genesis' : event.previousHash.slice(0, 10)}</code></td><td><Hash value={event.eventHash} length={10} /></td></tr>)}</tbody></table></div>
  </div>;
}
