import {useState, type ReactNode} from 'react';
import {create} from 'zustand';
import {AlertTriangle, Check, CircleDot, Copy, Info, X} from 'lucide-react';
import type {Workflow} from '../api';

/* ---------- Workflow state language ---------- */
const STATE_LABELS: Record<string, [string, string]> = {
  AWAITING_HUMAN_APPROVAL: ['Awaiting approval', 'review'],
  APPROVED: ['Approved, ready to run', 'ready'],
  EXECUTING: ['Executing', 'ready'],
  VERIFYING_DELETION: ['Verifying', 'ready'],
  COMPLETED: ['Erased and verified', 'done'],
  REJECTED: ['Rejected', 'neutral'],
  ROLLED_BACK: ['Rolled back', 'neutral'],
  SANDBOX_FAILED: ['Blocked by sandbox', 'blocked'],
  BACKING_UP: ['Blocked at backup', 'blocked'],
  EXECUTION_FAILED: ['Execution failed', 'blocked'],
  VERIFICATION_FAILED: ['Verification failed', 'blocked'],
};
export function stateLabel(state?: string, dryRun?: boolean): [string, string] {
  if (dryRun && state === 'AWAITING_HUMAN_APPROVAL') return ['Dry run, review only', 'neutral'];
  return STATE_LABELS[state ?? ''] ?? [state?.toLowerCase().replaceAll('_', ' ') ?? 'unknown', 'neutral'];
}
export function StatePill({state, dryRun}: {state?: string; dryRun?: boolean}) {
  const [label, tone] = stateLabel(state, dryRun);
  return <span className={`pill ${tone}`}>{label}</span>;
}

export const ACTION_LABEL: Record<string, string> = {delete: 'Delete', redact: 'Redact', retain: 'Retain', deletable: 'Delete', anonymize: 'Redact'};
const CHIP_TONE: Record<string, string> = {deletable: 'delete', anonymize: 'redact'};
export function ActionChip({action}: {action: string}) { return <span className={`chip ${CHIP_TONE[action] ?? action}`}>{ACTION_LABEL[action] ?? action}</span>; }

export function FootprintBar({deletable, anonymize, retained, label}: {deletable: number; anonymize: number; retained: number; label?: string}) {
  const total = Math.max(1, deletable + anonymize + retained);
  return <div className="footbar" role="img" aria-label={label ?? `${deletable} to delete, ${anonymize} to redact, ${retained} retained`}>
    <i className="d" style={{width: `${(deletable / total) * 100}%`}} />
    <i className="a" style={{width: `${(anonymize / total) * 100}%`}} />
    <i className="r" style={{width: `${(retained / total) * 100}%`}} />
  </div>;
}
export function Legend() {
  return <div className="legend"><span><i style={{background: 'var(--delete)'}} />Delete</span><span><i style={{background: 'var(--redact)'}} />Redact</span><span><i style={{background: 'var(--retain)'}} />Retain</span></div>;
}

export function Hash({value, length = 14}: {value?: string; length?: number}) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="muted">none</span>;
  return <button type="button" className="hash" title={`${value} (click to copy)`} onClick={() => { void navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }); }}>
    <code>{value.slice(0, length)}…</code>{copied ? <Check size={13} /> : <Copy size={13} />}
  </button>;
}

export function ErrorNotice({error}: {error: unknown}) {
  if (!error) return null;
  return <div className="notice error" role="alert"><AlertTriangle size={16} /><span>{error instanceof Error ? error.message : String(error)}</span></div>;
}

export function Empty({icon, title, children}: {icon: ReactNode; title: string; children?: ReactNode}) {
  return <div className="empty">{icon}<h3>{title}</h3>{children}</div>;
}

export const formatTime = (iso?: string) => iso ? new Date(iso).toLocaleString(undefined, {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'}) : '';
export const relativeTime = (iso?: string) => {
  if (!iso) return '';
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (Math.abs(seconds) < 45) return seconds >= 0 ? 'just now' : 'in a moment';
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return minutes >= 0 ? `${minutes} min ago` : `in ${-minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours >= 0 ? `${hours} h ago` : `in ${-hours} h`;
};
export const plural = (count: number, word: string) => `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;
export const isTerminal = (workflow: Pick<Workflow, 'state'>) => ['COMPLETED', 'REJECTED', 'ROLLED_BACK'].includes(workflow.state ?? '');

/* ---------- Toasts ---------- */
type Toast = {id: number; tone: 'ok' | 'error' | 'info'; message: string};
export const useToasts = create<{items: Toast[]; push: (tone: Toast['tone'], message: string) => void; dismiss: (id: number) => void}>(set => ({
  items: [],
  push: (tone, message) => { const id = Date.now() + Math.random(); set(state => ({items: [...state.items.slice(-3), {id, tone, message}]})); setTimeout(() => set(state => ({items: state.items.filter(item => item.id !== id)})), 5200); },
  dismiss: id => set(state => ({items: state.items.filter(item => item.id !== id)})),
}));
export const toast = {ok: (message: string) => useToasts.getState().push('ok', message), error: (error: unknown) => useToasts.getState().push('error', error instanceof Error ? error.message : String(error)), info: (message: string) => useToasts.getState().push('info', message)};
export function Toasts() {
  const {items, dismiss} = useToasts();
  return <div className="toasts" aria-live="polite">{items.map(item => <div key={item.id} className={`toast ${item.tone}`}>{item.tone === 'ok' ? <Check size={16} /> : item.tone === 'error' ? <AlertTriangle size={16} /> : <Info size={16} />}<p>{item.message}</p><button type="button" className="btn btn-ghost icon-btn" aria-label="Dismiss" onClick={() => dismiss(item.id)}><X size={14} /></button></div>)}</div>;
}

/* ---------- Brand ---------- */
export function LogoMark({size = 28}: {size?: number}) {
  return <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
    <rect x="1" y="1" width="30" height="30" rx="9" fill="#121836" stroke="#36407a" />
    <rect x="7" y="9" width="18" height="3.2" rx="1.6" fill="#e8eaf6" />
    <rect x="7" y="14.4" width="18" height="3.2" rx="1" fill="#05060f" stroke="#9b7bff" strokeWidth=".8" />
    <rect x="7" y="19.8" width="11" height="3.2" rx="1.6" fill="#e8eaf6" opacity=".55" />
    <circle cx="23.5" cy="21.4" r="2.6" fill="#9b7bff" />
  </svg>;
}
export function Logo() { return <span className="logo"><LogoMark /><span>EraseOps</span></span>; }

/** Guilloche rosette, the interlaced line pattern used on certificates and banknotes. */
export function Guilloche({size = 220, strokes = 18, className}: {size?: number; strokes?: number; className?: string}) {
  const center = size / 2;
  const paths = Array.from({length: strokes}, (_, ring) => {
    const points: string[] = [];
    const base = center * (0.42 + ring * 0.028);
    for (let step = 0; step <= 360; step++) {
      const angle = (step / 360) * Math.PI * 2;
      const radius = base + Math.sin(angle * 12 + ring * 0.55) * center * 0.06 + Math.cos(angle * 5 - ring) * center * 0.025;
      points.push(`${(center + Math.cos(angle) * radius).toFixed(2)},${(center + Math.sin(angle) * radius).toFixed(2)}`);
    }
    return `M${points.join('L')}Z`;
  });
  return <svg className={className} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">{paths.map((d, index) => <path key={index} d={d} fill="none" stroke="currentColor" strokeWidth=".55" opacity={0.35 + (index % 3) * 0.15} />)}</svg>;
}

export function Dot({tone}: {tone: 'ok' | 'warn' | 'bad' | 'uv'}) { return <CircleDot size={14} className={`dot-${tone}`} aria-hidden="true" />; }

/** Initials from the masked name; once a customer is erased the avatar becomes a redaction swatch. */
export function Avatar({name, size = 30}: {name?: string; size?: number}) {
  if (!name) return <span className="avatar erased" style={{width: size, height: size}} aria-label="Name erased" />;
  const initials = name.replace(/\./g, '').split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase();
  const hue = [...name].reduce((total, char) => total + char.charCodeAt(0), 0) % 360;
  return <span className="avatar" aria-hidden="true" style={{width: size, height: size, background: `linear-gradient(140deg, hsl(${hue} 70% 62%), hsl(${(hue + 50) % 360} 65% 45%))`}}>{initials}</span>;
}

/** A progress ring that animates its arc when the value changes. */
export function Ring({value, total, size = 46}: {value: number; total: number; size?: number}) {
  const radius = size / 2 - 4;
  const circumference = 2 * Math.PI * radius;
  const fraction = total > 0 ? Math.min(1, value / total) : 0;
  return <svg className="ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
    <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--line)" strokeWidth="4" />
    <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--uv)" strokeWidth="4" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - fraction)} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
  </svg>;
}
