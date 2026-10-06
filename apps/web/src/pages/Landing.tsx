import '../styles/landing.css';
import {useState} from 'react';
import {Link} from 'react-router-dom';
import {useQuery} from '@tanstack/react-query';
import {ArrowRight, Bot, Database, FileCheck2, Fingerprint, HardDrive, LockKeyhole, Menu, RefreshCw, ScanLine, ShieldCheck, Stamp, Terminal, X} from 'lucide-react';
import {api} from '../api';
import {RecordSphere} from '../components/RecordSphere';
import {ActionChip, Avatar, ErrorNotice, FootprintBar, Guilloche, Legend, Logo, StatePill, plural} from '../components/ui';
import {CountUp} from '../components/motion';
import {ThemeToggle} from '../components/ThemeToggle';
import type {CSSProperties} from 'react';

const order = (i: number, extra: Record<string, string> = {}) => ({'--i': i, ...extra}) as CSSProperties;

const STEPS: Array<[string, string, string]> = [
  ['Discover', 'Every allowlisted system is scanned for rows and objects that belong to the customer.', 'Footprint with record IDs'],
  ['Classify', 'The retention policy decides what is deleted, what is redacted, and what the law says to keep.', 'Policy basis per resource'],
  ['Rehearse', 'The plan runs on an isolated copy. Orphaned rows, changes to other customers, or leftover data block it.', 'Sandbox report'],
  ['Back up', 'Every affected record is copied, then read back and checksummed before anyone is asked to approve.', 'Verified backup manifest'],
  ['Approve', 'An operator types the customer ID to approve one exact, hashed plan. Approval expires and works once.', 'Signed approval'],
  ['Execute', 'Each connector runs only the approved, parameterized actions for that customer.', 'Per-action change counts'],
  ['Prove', 'Every system is rescanned. Anything left over fails the request and offers a rollback from backup.', 'Certificate and hash chain'],
];
const GATE_ICONS = [ScanLine, HardDrive, LockKeyhole, ShieldCheck, Fingerprint];

export default function Landing() {
  const [menuOpen, setMenuOpen] = useState(false);
  const overview = useQuery({queryKey: ['overview'], queryFn: api.overview, refetchInterval: 15_000});
  const customers = useQuery({queryKey: ['customers'], queryFn: api.customers, refetchInterval: 15_000});
  const policies = useQuery({queryKey: ['policies'], queryFn: api.policies});
  const totals = (customers.data ?? []).reduce((sum, customer) => ({delete: sum.delete + customer.footprint.deletable, redact: sum.redact + customer.footprint.anonymize, retain: sum.retain + customer.footprint.retained}), {delete: 0, redact: 0, retain: 0});
  const offline = overview.isError || customers.isError;
  // The hero's example request names a real, not-yet-erased customer from the live systems.
  const demoName = customers.data?.find(customer => customer.status === 'active' && customer.displayName && !customer.signals.some(signal => /depend/.test(signal)))?.displayName?.split(' ')[0];
  const demoGoal = demoName ? `Can you wipe ${demoName}'s data?` : undefined;
  const close = () => setMenuOpen(false);

  return <div className="landing">
    <header className="l-nav">
      <Link to="/" className="l-brand" aria-label="EraseOps home"><Logo /></Link>
      <nav className={`l-links ${menuOpen ? 'open' : ''}`} aria-label="Sections">
        <a href="#how" onClick={close}>How it works</a>
        <a href="#customers" onClick={close}>Demo customers</a>
        <a href="#gates" onClick={close}>Safety gates</a>
        <a href="#policy" onClick={close}>Retention policy</a>
      </nav>
      <div className="l-nav-actions">
        <ThemeToggle />
        <Link className="btn btn-primary" to="/console"><Terminal size={15} />Open console</Link>
        <button type="button" className="btn btn-ghost icon-btn l-menu" aria-expanded={menuOpen} aria-label="Toggle navigation" onClick={() => setMenuOpen(!menuOpen)}>{menuOpen ? <X size={18} /> : <Menu size={18} />}</button>
      </div>
    </header>

    <main>
      <section className="l-hero">
        <div className="l-hero-copy">
          <h1><span className="redact-line" style={order(0)}>Delete a customer</span> <span className="redact-line" style={order(1)}>from every system,</span> <span className="redact-line" style={order(2)}>and prove it.</span></h1>
          <p className="l-lede hero-seq" style={order(0, {'--d': '1s'})}>Ask in plain words, or out loud. EraseOps agents find a person's records across PostgreSQL and object storage, rehearse the deletion on a copy, back everything up, and stop for a human to approve the exact plan. Then they rescan until nothing personal is left.</p>
          <div className="row l-ctas hero-seq" style={order(0, {'--d': '1.15s'})}>
            <Link className="btn btn-primary btn-lg" to={demoGoal ? `/console/agent?goal=${encodeURIComponent(demoGoal)}&start=1` : '/console/agent'}><Bot size={17} />{demoGoal ? `Ask the agent: “${demoGoal}”` : 'Ask the agent'}</Link>
            <Link className="btn btn-lg" to="/console">Open the console</Link>
          </div>
          {offline ? <div className="notice warn l-offline hero-seq" style={order(0, {'--d': '1.3s'})}><RefreshCw size={16} /><span>The API is not answering, so live numbers are hidden. Start everything with <code>npm run dev</code> and this page fills in on its own.</span></div>
            : <dl className="l-stats hero-seq" style={order(0, {'--d': '1.3s'})} aria-busy={overview.isLoading}>
              <div><dt>Records under management</dt><dd>{overview.data ? <CountUp value={overview.data.records.managed} duration={1400} /> : '…'}</dd></div>
              <div><dt>Customers indexed</dt><dd>{overview.data ? <CountUp value={overview.data.customers.total} duration={1400} /> : '…'}</dd></div>
              <div><dt>Residual personal data</dt><dd>{overview.data ? <CountUp value={overview.data.records.residual} duration={1400} /> : '…'}</dd></div>
              {overview.data && overview.data.audit.chains > 0 ? <div><dt>Audit chains intact</dt><dd><CountUp value={overview.data.audit.verified} />/<CountUp value={overview.data.audit.chains} /></dd></div> : <div><dt>Requests handled so far</dt><dd>{overview.data ? <CountUp value={overview.data.requests.total} /> : '…'}</dd></div>}
            </dl>}
        </div>
        <figure className="l-sphere">
          <Guilloche className="hero-rosette" size={640} strokes={26} />
          {customers.data ? <RecordSphere counts={totals} label={`Live records by policy: ${totals.delete} to delete, ${totals.redact} to redact, ${totals.retain} retained`} /> : <div className="l-sphere-placeholder" />}
          <figcaption>
            <span className="dim">Every live record, colored by what policy does with it</span>
            <span className="l-sphere-counts"><b style={{color: 'var(--delete)'}}>{totals.delete}</b> delete <b style={{color: 'var(--redact)'}}>{totals.redact}</b> redact <b style={{color: 'var(--retain)'}}>{totals.retain}</b> retain</span>
          </figcaption>
        </figure>
      </section>

      <section className="l-section" id="how">
        <div className="l-section-head reveal">
          <h2>What happens to an erasure request</h2>
          <p>Seven steps, in order. Each one leaves evidence the next step checks, and the irreversible part sits behind all of them.</p>
        </div>
        <ol className="l-steps reveal">
          {STEPS.map(([title, copy, evidence], index) => <li key={title} className={index === 4 ? 'human' : ''} style={order(index)}>
            <span className="l-step-n">{index + 1}</span>
            <h3>{title}</h3>
            <p>{copy}</p>
            <span className="l-evidence"><FileCheck2 size={13} />{evidence}</span>
          </li>)}
        </ol>
      </section>

      <section className="l-section" id="customers">
        <div className="l-section-head reveal">
          <h2>Customers in the demo systems</h2>
          <p>Read live from the connectors. Each one exercises a different path, and nothing about them is special-cased in code: the outcome comes from their data.</p>
        </div>
        <ErrorNotice error={customers.error} />
        <div className="panel l-customers">
          {(customers.data ?? []).map((customer, index) => <article key={customer.customerId} className="l-customer reveal" style={order(index % 8)}>
            <div className="l-customer-id"><Avatar name={customer.displayName} size={34} /><div><span className="id">{customer.customerId}</span><span className="dim small">{customer.displayName ?? <span className="redaction" style={{width: 72}} aria-label="name redacted" />}{customer.region ? `, ${customer.region}` : ''}</span></div></div>
            <div className="l-customer-foot">
              <FootprintBar deletable={customer.footprint.deletable} anonymize={customer.footprint.anonymize} retained={customer.footprint.retained} />
              <span className="small muted">{plural(customer.footprint.records, 'record')} in {customer.footprint.systems.join(' and ') || 'no system'}</span>
            </div>
            <p className="l-customer-signal small">{customer.signals[0] ?? 'No shared data or holds'}</p>
            <div className="l-customer-act">
              {customer.latestRequest ? <StatePill state={customer.latestRequest.state} dryRun={customer.latestRequest.dryRun} /> : customer.status === 'erased' ? <span className="pill done">Erased</span> : <span className="pill neutral">No request yet</span>}
              <Link className="btn" to={customer.latestRequest ? `/console/requests/${customer.latestRequest.requestId}` : `/console/requests/new?customer=${customer.customerId}`}>{customer.latestRequest ? 'View request' : 'Start request'}</Link>
            </div>
          </article>)}
          {customers.isLoading && Array.from({length: 4}, (_, index) => <div key={index} className="skeleton" style={{height: 64, margin: 12}} />)}
        </div>
        <Legend />
      </section>

      <section className="l-section l-gates" id="gates">
        <div className="l-section-head reveal">
          <h2>Nothing is deleted until five gates pass</h2>
          <p>These are the limits the running API enforces right now{policies.data ? `: approvals expire after ${policies.data.controls.approvalTtlMinutes} minutes and execution is capped at ${policies.data.controls.destructiveRateLimit.maxAttempts} attempts per ${policies.data.controls.destructiveRateLimit.windowSeconds} seconds` : ''}.</p>
        </div>
        <ul className="l-gate-list">
          {(policies.data?.gates ?? []).map((gate, index) => { const Icon = GATE_ICONS[index] ?? Stamp; return <li key={gate.id} className="reveal" style={order(index)}><Icon size={20} /><div><h3>{gate.title}</h3><p>{gate.rule}</p></div></li>; })}
        </ul>
      </section>

      <section className="l-section" id="policy">
        <div className="l-section-head reveal">
          <h2>Retention policy {policies.data && <span className="muted l-version">v{policies.data.version}</span>}</h2>
          <p>Classification is looked up, never guessed. Unknown tables are retained and flagged for review.</p>
        </div>
        <div className="panel table-wrap reveal" tabIndex={0}>
          <table className="table">
            <thead><tr><th>Resource</th><th>System</th><th>Outcome</th><th>Why</th><th>Kept for</th></tr></thead>
            <tbody>{(policies.data?.rules ?? []).map(rule => <tr key={`${rule.system}:${rule.resource}`}><td><strong>{rule.label}</strong><div className="id muted">{rule.resource}</div></td><td>{rule.system === 'MinIO' ? <HardDrive size={14} /> : <Database size={14} />} {rule.system}</td><td><ActionChip action={rule.classification} /></td><td className="dim">{rule.basis}</td><td>{rule.retention ?? <span className="muted">n/a</span>}</td></tr>)}</tbody>
          </table>
        </div>
      </section>

      <section className="l-cta reveal">
        <h2>Run it on your machine</h2>
        <p className="dim">The default mode keeps a synthetic dataset in memory, so deletions are real but nothing leaves your laptop. Add Docker to run the same flow against PostgreSQL and MinIO.</p>
        <pre><code>npm install{'\n'}npm run dev{'\n'}# optional: real infrastructure{'\n'}docker compose up -d && npm run seed:local{'\n'}CONNECTOR_MODE=local npm run dev</code></pre>
        <Link className="btn btn-primary btn-lg" to="/console">Open the console <ArrowRight size={17} /></Link>
      </section>
    </main>

    <footer className="l-footer"><Logo /><span className="muted small">Synthetic demo data only. Every email address uses the reserved example.invalid domain.</span></footer>
  </div>;
}
