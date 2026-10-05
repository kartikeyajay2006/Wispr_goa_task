export type CommandQuery = 'metrics' | 'report' | 'blast-radius' | 'backup' | 'verification' | 'plan' | 'footprint' | 'dependencies' | 'sandbox' | 'audit';
export type ConsolePage = 'overview' | 'requests' | 'approvals' | 'customers' | 'systems' | 'policies' | 'audit';
export type CommandIntent =
  | {kind: 'request'; customerId: string; dryRun?: boolean}
  | {kind: 'approve' | 'reject' | 'rollback'; customerId?: string}
  | {kind: 'query'; query?: CommandQuery; customerId?: string}
  | {kind: 'navigate'; page: ConsolePage}
  | {kind: 'reset'}
  | {kind: 'blocked'};

/** Accepts typed IDs ("cust-1042") and dictated ones ("customer 1042", "cust 1042"). */
export const extractCustomerId = (text: string) => {
  const match = text.match(/\bcust(?:omer)?[\s-]*(?:id[\s-]*)?(\d{4})\b/i);
  return match ? `CUST-${match[1]}` : undefined;
};

const queries: Array<[RegExp, CommandQuery]> = [
  [/\bmetrics\b/i, 'metrics'],
  [/\b(audit report|report|certificate)\b/i, 'report'],
  [/\bblast radius\b/i, 'blast-radius'],
  [/\b(create backup|backup)\b/i, 'backup'],
  [/\b(verify deletion|verification|verify|rescan)\b/i, 'verification'],
  [/\b(plan|actions)\b/i, 'plan'],
  [/\b(footprint|assets)\b/i, 'footprint'],
  [/\b(dependencies|dependency graph|graph)\b/i, 'dependencies'],
  [/\bsandbox\b/i, 'sandbox'],
  [/\b(audit trail|events|history)\b/i, 'audit'],
];
const pages: ConsolePage[] = ['overview', 'requests', 'approvals', 'customers', 'systems', 'policies', 'audit'];

export function parseCommand(input: string): CommandIntent {
  const text = input.trim();
  const customerId = extractCustomerId(text);
  if (/\b(execute|delete now)\b/i.test(text)) return {kind: 'blocked'};
  if (/\breset\b.*\b(demo|data)\b/i.test(text)) return {kind: 'reset'};
  if (/\b(roll ?back|restore)\b/i.test(text)) return {kind: 'rollback', customerId};
  if (/\b(request approval|approve)\b/i.test(text)) return {kind: 'approve', customerId};
  if (/\breject\b/i.test(text)) return {kind: 'reject', customerId};
  const navigation = text.match(/\b(?:go to|open|show|view)\s+(?:the\s+)?(overview|dashboard|requests|approvals|customers|systems|policies|policy|audit log)\b/i);
  if (navigation && !customerId) { const word = navigation[1].toLowerCase(); return {kind: 'navigate', page: word === 'dashboard' ? 'overview' : word === 'policy' ? 'policies' : word === 'audit log' ? 'audit' : word as ConsolePage}; }
  for (const [pattern, query] of queries) if (pattern.test(text)) return {kind: 'query', query, customerId};
  if (customerId) return /\bdry[\s-]?run\b/i.test(text) ? {kind: 'request', customerId, dryRun: true} : {kind: 'request', customerId};
  const page = pages.find(name => text.toLowerCase() === name);
  if (page) return {kind: 'navigate', page};
  return {kind: 'query'};
}
