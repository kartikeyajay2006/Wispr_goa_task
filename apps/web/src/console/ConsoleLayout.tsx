import {useEffect, useState} from 'react';
import {Link, NavLink, Outlet, useLocation, useNavigate} from 'react-router-dom';
import {useQuery, useQueryClient} from '@tanstack/react-query';
import {BookOpen, Bot, Database, Inbox, LayoutDashboard, ListChecks, RotateCcw, ScrollText, Search, UserRound, Users} from 'lucide-react';
import {api} from '../api';
import {useOperator} from '../operator';
import {CommandPalette} from '../components/CommandPalette';
import {speechSupported} from '../components/speech';
import {Logo, toast} from '../components/ui';

const NAV = [
  {to: '/console', label: 'Overview', icon: LayoutDashboard, end: true},
  {to: '/console/agent', label: 'Agent', icon: Bot},
  {to: '/console/requests', label: 'Requests', icon: ListChecks},
  {to: '/console/approvals', label: 'Approvals', icon: Inbox, badge: true},
  {to: '/console/customers', label: 'Customers', icon: Users},
  {to: '/console/systems', label: 'Systems', icon: Database},
  {to: '/console/policies', label: 'Policies', icon: BookOpen},
  {to: '/console/audit', label: 'Audit log', icon: ScrollText},
];

export default function ConsoleLayout() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const {name, setName} = useOperator();
  const [draft, setDraft] = useState(name);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const health = useQuery({queryKey: ['health'], queryFn: api.health, refetchInterval: 10_000, retry: false});
  const overview = useQuery({queryKey: ['overview'], queryFn: api.overview, refetchInterval: 10_000});
  const pending = (overview.data?.requests.awaitingApproval ?? 0) + (overview.data?.requests.ready ?? 0);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setPaletteOpen(open => !open); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const reset = async () => {
    if (!window.confirm('Reset the demo? This restores every customer from the fixture and clears all requests.')) return;
    try { const result = await api.reset(); await queryClient.invalidateQueries(); toast.ok(result.dataset); navigate('/console'); } catch (error) { toast.error(error); }
  };
  const saveName = () => { const trimmed = draft.trim().slice(0, 120); setName(trimmed); setDraft(trimmed); if (trimmed) toast.ok(`Actions are now recorded as ${trimmed}.`); };

  return <div className="console">
    <aside className="sidebar" aria-label="Console navigation">
      <Link to="/" className="logo-link" style={{textDecoration: 'none'}}><Logo /></Link>
      <nav className="side-nav">
        {NAV.map(item => <NavLink key={item.to} to={item.to} end={item.end} className={({isActive}) => isActive ? 'active' : ''}>
          <item.icon size={17} />{item.label}{item.badge && pending > 0 && <span className="badge" aria-label={`${pending} waiting`}>{pending}</span>}
        </NavLink>)}
      </nav>
      <div className="side-foot">
        <label>Acting as
          <input className="input" value={draft} placeholder="Your name or email" maxLength={120} onChange={event => setDraft(event.target.value)} onBlur={saveName} onKeyDown={event => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur(); }} />
        </label>
        <div className={`mode ${health.isError ? 'down' : ''}`}><i />{health.isError ? 'API offline' : health.data ? `${health.data.mode === 'local' ? 'PostgreSQL + MinIO (Docker)' : 'In-memory dataset'}` : 'Connecting…'}</div>
        <button type="button" className="btn btn-ghost" onClick={() => void reset()}><RotateCcw size={14} />Reset demo data</button>
      </div>
    </aside>
    <div className="main">
      <header className="topbar">
        <button type="button" className="command-trigger" onClick={() => setPaletteOpen(true)}><Search size={15} />{speechSupported ? 'Search, or say a command' : 'Search or run a command'}<kbd>Ctrl K</kbd></button>
        <div className="who">{name ? <><UserRound size={15} /><span>Acting as</span> <b>{name}</b></> : <span className="pill review">Set your name to approve</span>}</div>
      </header>
      <nav className="mobile-nav" aria-label="Console navigation">{NAV.map(item => <NavLink key={item.to} to={item.to} end={item.end} className={({isActive}) => isActive ? 'active' : ''}>{item.label}{item.badge && pending > 0 ? ` (${pending})` : ''}</NavLink>)}</nav>
      {health.isError && <div className="page" style={{paddingBottom: 0}}><div className="notice error" role="alert">The API is not reachable. Start it with <code>npm run dev</code>; this page reconnects on its own.</div></div>}
      <div key={location.pathname} className="route-in"><Outlet /></div>
    </div>
    <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
  </div>;
}
