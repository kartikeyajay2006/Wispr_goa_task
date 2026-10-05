import {create} from 'zustand';

const KEY = 'eraseops.operator';
const read = () => { try { return localStorage.getItem(KEY) ?? ''; } catch { return ''; } };

/** The person acting in the console. Sent as x-operator-identity and recorded in the audit trail. */
export const useOperator = create<{name: string; setName: (name: string) => void}>(set => ({
  name: read(),
  setName: name => { try { localStorage.setItem(KEY, name); } catch { /* storage can be unavailable */ } set({name}); },
}));
