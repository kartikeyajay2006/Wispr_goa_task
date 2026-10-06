import {useEffect, useMemo, useRef, useState, type FormEvent} from 'react';
import {Link, useNavigate, useSearchParams} from 'react-router-dom';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {ArrowRight, Bot, CheckCircle2, Database, HardDrive, Inbox, ListChecks, Loader2, Plus, ScrollText, ShieldAlert, ShieldCheck, Users} from 'lucide-react';
import {api, type RequestSummary} from '../api';
import {ActionChip, Avatar, Empty, ErrorNotice, FootprintBar, Legend, Ring, StatePill, formatTime, plural, relativeTime, toast} from '../components/ui';
import {CountUp, TabInk} from '../components/motion';

function PageHead({title, children, action}: {title: string; children?: React.ReactNode; action?: React.ReactNode}) {
  return <div className="page-head"><div><h1>{title}</h1>{children && <p>{children}</p>}</div>{action}</div>;
}

function RequestTable({rows, empty}: {rows: RequestSummary[]; empty: React.ReactNode}) {
  const navigate = useNavigate();
  if (!rows.length) return <>{empty}</>;
  return <div className="table-wrap" tabIndex={0}><table className="table">
    <thead><tr><th>Customer</th><th>Status</th><th>Footprint</th><th className="num">Records changed</th><th>Opened</th><th>By</th></tr></thead>
    <tbody>{rows.map(row => <tr key={row.requestId} className="clickable" onClick={() => navigate(`/console/requests/${row.requestId}`)}>
      <td><Link to={`/console/requests/${row.requestId}`} className="id" onClick={event => event.stopPropagation()}>{row.customerId}</Link>{row.blockedBy && <div className="small clamp-2" style={{color: 'var(--delete)', maxWidth: 360, minWidth: 200}} title={row.blockedBy}>{row.blockedBy}</div>}</td>
      <td><StatePill state={row.state} dryRun={row.dryRun} /></td>
      <td style={{minWidth: 140}}><FootprintBar deletable={row.blastRadius.deletable} anonymize={row.blastRadius.anonymized} retained={row.blastRadius.retained} /><div className="small muted" style={{marginTop: 4}}>{plural(row.blastRadius.records, 'record')}</div></td>
      <td className="num">{row.recordsChanged}</td>
      <td title={formatTime(row.createdAt)}>{relativeTime(row.createdAt)}</td>
      <td className="dim">{row.requestedBy}</td>
    </tr>)}</tbody>
  </table></div>;
}

export function NewRequestForm({compact = false}: {compact?: boolean}) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const customers = useQuery({queryKey: ['customers'], queryFn: api.customers});
  const [customerId, setCustomerId] = useState(params.get('customer') ?? '');
  const [reason, setReason] = useState('Customer asked us to delete their personal data (GDPR Art. 17).');
  const [dryRun, setDryRun] = useState(false);
  useEffect(() => { const preset = params.get('customer'); if (preset) setCustomerId(preset); }, [params]);
  const create = useMutation({
    mutationFn: () => api.create({customerId: customerId.trim().toUpperCase(), reason: reason.trim(), dryRun}),
    onSuccess: async workflow => { await queryClient.invalidateQueries(); toast.ok(workflow.status === 'blocked' ? `Request opened for ${workflow.customerId}, but a safety gate blocked it.` : `Request opened for ${workflow.customerId}.`); navigate(`/console/requests/${workflow.requestId}`); },
  });
  const selected = customers.data?.find(customer => customer.customerId === customerId.trim().toUpperCase());
  const submit = (event: FormEvent) => { event.preventDefault(); create.mutate(); };
  return <form className={compact ? 'stack' : 'panel panel-pad stack'} onSubmit={submit}>
    {!compact && <div><h3 style={{fontSize: 'var(--step-1)'}}>Open an erasure request</h3><p className="small muted">Discovery, sandbox and backup run immediately. Nothing is deleted until someone approves.</p></div>}
    <label className="field"><span>Customer</span>
      <input className="input mono" list="customer-ids" value={customerId} placeholder="CUST-1042" required pattern="[Cc][Uu][Ss][Tt]-\d{4}" title="Customer IDs look like CUST-1042" onChange={event => setCustomerId(event.target.value.toUpperCase())} />
      <datalist id="customer-ids">{customers.data?.map(customer => <option key={customer.customerId} value={customer.customerId}>{customer.displayName ?? 'erased'}</option>)}</datalist>
    </label>
    {selected && <div className="small dim" style={{display: 'grid', gap: 6}}><FootprintBar deletable={selected.footprint.deletable} anonymize={selected.footprint.anonymize} retained={selected.footprint.retained} /><span>{selected.displayName ?? 'Name already redacted'}: {plural(selected.footprint.records, 'record')} in {selected.footprint.systems.join(' and ') || 'no system'}{selected.residual === 0 ? '; no personal data left to erase' : ''}</span></div>}
    <label className="field"><span>Reason</span><textarea className="textarea" value={reason} minLength={8} required onChange={event => setReason(event.target.value)} /></label>
    <label className="toggle"><input type="checkbox" checked={dryRun} onChange={event => setDryRun(event.target.checked)} />Dry run: plan and rehearse only, never execute</label>
    <ErrorNotice error={create.error} />
    <button className="btn btn-primary btn-lg" disabled={create.isPending}>{create.isPending ? <><Loader2 size={16} className="spin" />Scanning systems…</> : <><Plus size={16} />Open request</>}</button>
  </form>;
}

export function Overview() {
  const overview = useQuery({queryKey: ['overview'], queryFn: api.overview, refetchInterval: 8_000});
  const data = overview.data;
  return <div className="page">
    <PageHead title="Overview" action={<Link className="btn btn-primary" to="/console/agent"><Bot size={15} />Ask the agent</Link>}>Live state of every connected system and request.</PageHead>
    <ErrorNotice error={overview.error} />
    <div className="kpis">
      <Link className="kpi" to="/console/approvals"><span>Waiting on a human</span><strong>{data ? <CountUp value={data.requests.awaitingApproval + data.requests.ready} /> : '…'}</strong><small>{data ? `${data.requests.awaitingApproval} to approve, ${data.requests.ready} to execute` : ''}</small></Link>
      <Link className="kpi" to="/console/customers"><span>Customers erased</span><div className="kpi-row"><strong>{data ? <><CountUp value={data.customers.erased} />/<CountUp value={data.customers.total} /></> : '…'}</strong>{data && <Ring value={data.customers.erased} total={data.customers.total} />}</div><small>verified by rescan</small></Link>
      <Link className="kpi" to="/console/systems"><span>Records under management</span><strong>{data ? <CountUp value={data.records.managed} /> : '…'}</strong><small>{data ? `${data.records.residual} still personal and erasable` : ''}</small></Link>
      <Link className="kpi" to="/console/requests"><span>Records changed</span><strong>{data ? <CountUp value={data.records.changed} /> : '…'}</strong><small>{data ? `across ${plural(data.requests.executed, 'executed request')}` : ''}</small></Link>
      <Link className="kpi" to="/console/audit"><span>Audit chains intact</span><div className="kpi-row"><strong>{data ? <><CountUp value={data.audit.verified} />/<CountUp value={data.audit.chains} /></> : '…'}</strong>{data && data.audit.chains > 0 && <Ring value={data.audit.verified} total={data.audit.chains} />}</div><small>{data ? plural(data.audit.events, 'hashed event') : ''}</small></Link>
    </div>
    <div className="grid-2">
      <section className="panel">
        <div className="panel-head"><div><h3>Recent requests</h3><p>Newest first</p></div><Link className="btn btn-ghost" to="/console/requests">All requests <ArrowRight size={14} /></Link></div>
        <RequestTable rows={data?.recent ?? []} empty={<Empty icon={<ListChecks size={28} />} title="No requests yet"><p>Open one on the right, or press Ctrl K and say “erase customer 1042”.</p></Empty>} />
      </section>
      <div className="stack">
        <NewRequestForm />
        <section className="panel panel-pad stack">
          <h3 style={{fontSize: 'var(--step-1)'}}>Connected systems</h3>
          {(data?.systems ?? []).map(system => <div className="row" key={system.name}>{system.type === 'minio' ? <HardDrive size={16} /> : <Database size={16} />}<strong>{system.name}</strong><span className="spacer" /><span className={`pill ${system.connectionStatus === 'blocked' ? 'blocked' : 'done'}`}>{system.connectionStatus === 'mock' ? 'in-memory' : system.connectionStatus}</span></div>)}
        </section>
      </div>
    </div>
  </div>;
}

const FILTERS: Array<[string, string, (row: RequestSummary) => boolean]> = [
  ['all', 'All', () => true],
  ['review', 'Awaiting approval', row => row.status === 'awaiting_approval' && !row.dryRun],
  ['ready', 'Ready to execute', row => row.status === 'ready'],
  ['executed', 'Erased', row => row.status === 'executed'],
  ['blocked', 'Blocked or closed', row => row.status === 'blocked'],
  ['dry', 'Dry runs', row => row.dryRun],
];

export function Requests() {
  const requests = useQuery({queryKey: ['requests'], queryFn: api.requests, refetchInterval: 8_000});
  const [filter, setFilter] = useState('all');
  const tabsRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => (requests.data ?? []).filter(FILTERS.find(([id]) => id === filter)![2]), [requests.data, filter]);
  return <div className="page">
    <PageHead title="Requests" action={<Link className="btn btn-primary" to="/console/requests/new"><Plus size={15} />New request</Link>}>Every erasure request this API has handled, with the gate that stopped it if one did.</PageHead>
    <ErrorNotice error={requests.error} />
    <section className="panel">
      <div className="tabs" role="tablist" ref={tabsRef}><TabInk container={tabsRef} activeKey={filter} />{FILTERS.map(([id, label, predicate]) => <button key={id} type="button" role="tab" className="tab" aria-selected={filter === id} onClick={() => setFilter(id)}>{label}<span className="count">{(requests.data ?? []).filter(predicate).length}</span></button>)}</div>
      <RequestTable rows={rows} empty={<Empty icon={<ListChecks size={28} />} title={filter === 'all' ? 'No requests yet' : 'Nothing in this view'}><Link className="btn" to="/console/requests/new">Open a request</Link></Empty>} />
    </section>
  </div>;
}

export function NewRequestPage() {
  return <div className="page" style={{maxWidth: 720}}>
    <PageHead title="New erasure request">Pick a customer the connected systems know about, or type any ID; customers with no data get a clear answer instead of a request.</PageHead>
    <NewRequestForm />
  </div>;
}

export function Approvals() {
  const requests = useQuery({queryKey: ['requests'], queryFn: api.requests, refetchInterval: 5_000});
  const review = (requests.data ?? []).filter(row => row.status === 'awaiting_approval' && !row.dryRun);
  const ready = (requests.data ?? []).filter(row => row.status === 'ready');
  return <div className="page">
    <PageHead title="Approvals">Plans that passed every automatic gate and now need a person. Approval binds to one plan hash and expires.</PageHead>
    <ErrorNotice error={requests.error} />
    <section className="panel">
      <div className="panel-head"><div><h3>Waiting for approval</h3><p>Review the plan, then type the customer ID to approve it.</p></div></div>
      <RequestTable rows={review} empty={<Empty icon={<Inbox size={28} />} title="Nothing to approve"><p>New requests land here once sandbox and backup pass.</p></Empty>} />
    </section>
    <section className="panel">
      <div className="panel-head"><div><h3>Approved, waiting to execute</h3><p>Each approval is single-use and has a deadline.</p></div></div>
      {ready.length ? <div className="table-wrap" tabIndex={0}><table className="table"><thead><tr><th>Customer</th><th>Approved by</th><th>Expires</th><th /></tr></thead><tbody>{ready.map(row => <tr key={row.requestId}><td className="id">{row.customerId}</td><td>{row.approvedBy}</td><td>{relativeTime(row.approvalExpiresAt)}</td><td style={{textAlign: 'right'}}><Link className="btn btn-primary" to={`/console/requests/${row.requestId}`}>Review and execute</Link></td></tr>)}</tbody></table></div>
        : <Empty icon={<CheckCircle2 size={28} />} title="No approved plans pending" />}
    </section>
  </div>;
}

export function Customers() {
  const customers = useQuery({queryKey: ['customers'], queryFn: api.customers, refetchInterval: 10_000});
  return <div className="page">
    <PageHead title="Customers" action={<Legend />}>Everyone the connected systems hold data for. Names and emails are masked; residual counts come from a live rescan.</PageHead>
    <ErrorNotice error={customers.error} />
    <section className="panel table-wrap" tabIndex={0}>
      <table className="table">
        <thead><tr><th>Customer</th><th>Footprint</th><th className="num">Residual personal data</th><th>Notes</th><th>Status</th><th /></tr></thead>
        <tbody>{(customers.data ?? []).map(customer => <tr key={customer.customerId}>
          <td><div className="who-cell"><Avatar name={customer.displayName} /><div><span className="id">{customer.customerId}</span><div className="small dim">{customer.displayName ?? <span className="redaction" style={{width: 64}} aria-label="name redacted" />} {customer.email && <span className="muted">{customer.email}</span>}</div></div></div></td>
          <td style={{minWidth: 170}}><FootprintBar deletable={customer.footprint.deletable} anonymize={customer.footprint.anonymize} retained={customer.footprint.retained} /><div className="small muted" style={{marginTop: 4}}>{plural(customer.footprint.records, 'record')}, {customer.footprint.systems.join(' + ') || 'none'}</div></td>
          <td className="num">{customer.residual}</td>
          <td className="small dim" style={{maxWidth: 300}}>{customer.signals.join('. ') || 'None'}</td>
          <td>{customer.latestRequest ? <StatePill state={customer.latestRequest.state} dryRun={customer.latestRequest.dryRun} /> : customer.status === 'erased' ? <span className="pill done">Erased</span> : <span className="pill neutral">Active</span>}</td>
          <td style={{textAlign: 'right'}}>{customer.latestRequest ? <Link className="btn" to={`/console/requests/${customer.latestRequest.requestId}`}>View request</Link> : <Link className="btn" to={`/console/requests/new?customer=${customer.customerId}`}>Start request</Link>}</td>
        </tr>)}</tbody>
      </table>
      {customers.data?.length === 0 && <Empty icon={<Users size={28} />} title="No customers found"><p>Reset the demo data, or run <code>npm run seed:local</code> in local mode.</p></Empty>}
    </section>
  </div>;
}

export function Systems() {
  const systems = useQuery({queryKey: ['systems'], queryFn: api.systems, refetchInterval: 10_000});
  return <div className="page">
    <PageHead title="Systems">Connectors the API is allowed to touch, and what each one holds right now.</PageHead>
    <ErrorNotice error={systems.error} />
    <div className="grid-cards">{(systems.data ?? []).map(system => {
      const max = Math.max(1, ...system.inventory.map(entry => entry.records));
      return <section className="panel" key={system.id}>
        <div className="panel-head"><div className="row">{system.type === 'minio' ? <HardDrive size={18} /> : <Database size={18} />}<div><h3>{system.name}</h3><p>{system.connectionStatus === 'mock' ? 'In-memory synthetic dataset' : 'Docker service'}, {system.allowlisted ? 'allowlisted' : 'not allowlisted'}</p></div></div><span className={`pill ${system.allowlisted ? 'done' : 'blocked'}`}>{system.connectionStatus === 'mock' ? 'in-memory' : system.connectionStatus}</span></div>
        <div className="panel-pad stack" style={{gap: '0.6rem'}}>
          {system.inventory.map(entry => <div key={entry.resource} style={{display: 'grid', gridTemplateColumns: 'minmax(120px, 0.9fr) 1.4fr 48px', gap: '0.75rem', alignItems: 'center'}} className="small">
            <code className="dim">{entry.resource}</code>
            <div className="footbar" aria-hidden="true"><i style={{width: `${(entry.records / max) * 100}%`, background: entry.resource === 'eraseops-backups' ? 'var(--muted)' : 'var(--uv)'}} /></div>
            <span className="num" style={{textAlign: 'right'}}>{entry.records}</span>
          </div>)}
          <p className="small muted">Capabilities: {system.capabilities.join(', ')}</p>
        </div>
      </section>;
    })}</div>
  </div>;
}

export function Policies() {
  const policies = useQuery({queryKey: ['policies'], queryFn: api.policies});
  const data = policies.data;
  return <div className="page">
    <PageHead title="Policies">The retention rules discovery classifies against, and the gates every plan must clear. Values reflect the running configuration.</PageHead>
    <ErrorNotice error={policies.error} />
    {data && <div className="kpis">
      <div className="kpi"><span>Approval window</span><strong>{data.controls.approvalTtlMinutes} min</strong><small>single-use, bound to one plan hash</small></div>
      <div className="kpi"><span>Execution rate limit</span><strong>{data.controls.destructiveRateLimit.maxAttempts}/{data.controls.destructiveRateLimit.windowSeconds}s</strong><small>per operator</small></div>
      <div className="kpi"><span>Allowlisted systems</span><strong>{data.controls.allowlistedSystems.length}</strong><small>{data.controls.allowlistedSystems.join(', ')}</small></div>
      <div className="kpi"><span>Allowlisted buckets</span><strong>{data.controls.allowlistedBuckets.length}</strong><small>{data.controls.allowlistedBuckets.join(', ')}</small></div>
    </div>}
    <section className="panel">
      <div className="panel-head"><div><h3>Safety gates</h3><p>In the order a request meets them</p></div><ShieldCheck size={18} className="dot-uv" /></div>
      <div className="panel-pad stack">{data?.gates.map((gate, index) => <div key={gate.id} className="check pass" style={{gridTemplateColumns: '28px 1fr'}}><span className="mono muted">{index + 1}</span><div><strong>{gate.title}</strong><p className="dim small">{gate.rule}</p></div></div>)}</div>
    </section>
    <section className="panel table-wrap" tabIndex={0}>
      <div className="panel-head"><div><h3>Retention policy v{data?.version}</h3><p>Resources the policy does not name are retained and flagged</p></div></div>
      <table className="table"><thead><tr><th>Resource</th><th>Outcome</th><th>Legal basis</th><th>Kept for</th><th>Risk</th></tr></thead>
        <tbody>{data?.rules.map(rule => <tr key={`${rule.system}:${rule.resource}`}><td><strong>{rule.label}</strong><div className="id muted">{rule.system} / {rule.resource}</div></td><td><ActionChip action={rule.classification} /></td><td className="dim">{rule.basis}</td><td>{rule.retention ?? <span className="muted">n/a</span>}</td><td><span className={`chip risk-${rule.risk}`}>{rule.risk}</span></td></tr>)}</tbody>
      </table>
    </section>
  </div>;
}

export function AuditLog() {
  const audit = useQuery({queryKey: ['audit'], queryFn: () => api.audit(400), refetchInterval: 8_000});
  const [requestFilter, setRequestFilter] = useState('');
  const events = (audit.data?.events ?? []).filter(item => !requestFilter || item.requestId === requestFilter);
  const broken = (audit.data?.chains ?? []).filter(chain => !chain.valid);
  return <div className="page">
    <PageHead title="Audit log" action={<button type="button" className="btn" disabled={!audit.data} onClick={() => { const blob = new Blob([JSON.stringify(audit.data, null, 2)], {type: 'application/json'}); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `eraseops-audit-${new Date().toISOString().slice(0, 19)}.json`; link.click(); URL.revokeObjectURL(link.href); }}>Download JSON</button>}>Append-only events from every request. Each event carries the hash of the one before it, so any edit breaks the chain.</PageHead>
    <ErrorNotice error={audit.error} />
    {audit.data && (broken.length ? <div className="notice error"><ShieldAlert size={16} />{plural(broken.length, 'chain')} failed verification: {broken.map(chain => `${chain.customerId} (${chain.reason})`).join(', ')}</div>
      : audit.data.chains.length ? <div className="notice ok"><ShieldCheck size={16} />All {plural(audit.data.chains.length, 'hash chain')} verified, {plural(audit.data.total, 'event')} in total.</div> : null)}
    <section className="panel">
      <div className="panel-head"><div><h3>Events</h3><p>Newest first</p></div>
        <select className="select" style={{maxWidth: 280}} value={requestFilter} onChange={event => setRequestFilter(event.target.value)} aria-label="Filter by request">
          <option value="">All requests</option>
          {audit.data?.chains.map(chain => <option key={chain.requestId} value={chain.requestId}>{chain.customerId}, {chain.requestId.slice(0, 8)}</option>)}
        </select>
      </div>
      {events.length ? <ol className="timeline panel-pad">{events.map(item => <li key={item.id}><span className={`node ${item.actor}`} /><div><strong>{item.message}</strong><small><Link to={`/console/requests/${item.requestId}?tab=audit`} className="id">{item.customerId}</Link> &nbsp;{item.stage.replace('_', ' ')}, {item.actor}, {formatTime(item.at)} &nbsp;<code>#{item.sequence} {item.eventHash.slice(0, 10)}</code></small></div></li>)}</ol>
        : <Empty icon={<ScrollText size={28} />} title="No events yet"><p>Every request writes its own hash-linked trail here.</p></Empty>}
    </section>
  </div>;
}
