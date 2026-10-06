import {useEffect, useRef, useState} from 'react';
import {Check, PenLine, UserRound} from 'lucide-react';
import {useOperator} from '../operator';

/**
 * Who is acting, editable right where a decision is made. Approvals and rejections are
 * attributed to this name in the audit trail, so it is asked for inline instead of in a
 * sidebar that phones never show.
 */
export function OperatorField({label = 'Approving as', autoFocus = false}: {label?: string; autoFocus?: boolean}) {
  const {name, setName} = useOperator();
  const [editing, setEditing] = useState(!name);
  const [draft, setDraft] = useState(name);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!name) setEditing(true); }, [name]);
  useEffect(() => { if (editing && autoFocus) input.current?.focus(); }, [editing, autoFocus]);

  const save = () => { const value = draft.trim().slice(0, 120); if (!value) return; setName(value); setEditing(false); };

  if (!editing && name) return <div className="operator-chip">
    <UserRound size={15} /><span>{label} <b>{name}</b></span>
    <button type="button" className="link-btn" onClick={() => { setDraft(name); setEditing(true); }}><PenLine size={13} />Change</button>
  </div>;

  return <div className="operator-field">
    <label htmlFor="operator-name">Your name <span className="muted">(recorded in the audit trail)</span></label>
    <div className="row" style={{flexWrap: 'nowrap'}}>
      <input id="operator-name" ref={input} className="input" value={draft} maxLength={120} placeholder="e.g. Priya, Data Protection Officer" autoComplete="name"
        onChange={event => setDraft(event.target.value)} onBlur={save} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); save(); } }} />
      <button type="button" className="btn" disabled={!draft.trim()} onClick={save} aria-label="Save name"><Check size={15} /></button>
    </div>
  </div>;
}
