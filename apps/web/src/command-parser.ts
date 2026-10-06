export type CommandQuery = 'metrics' | 'report' | 'blast-radius' | 'backup' | 'verification' | 'plan' | 'footprint' | 'dependencies' | 'sandbox' | 'audit';
export type ConsolePage = 'overview' | 'requests' | 'approvals' | 'customers' | 'systems' | 'policies' | 'audit' | 'agent';
export type CommandIntent =
  | {kind: 'request'; customerId: string; dryRun?: boolean}
  | {kind: 'approve' | 'reject' | 'rollback'; customerId?: string}
  | {kind: 'query'; query?: CommandQuery; customerId?: string}
  | {kind: 'navigate'; page: ConsolePage}
  | {kind: 'reset'}
  | {kind: 'blocked'};

/** Accepts typed IDs ("cust-1042") and dictated ones ("customer 1042", "customer 10 42"). */
export const extractCustomerId = (text: string) => {
  const match = text.match(/\bcust(?:omer)?[\s-]*(?:id[\s-]*)?(\d(?:\s?\d){3})(?!\s?\d)/i);
  return match ? `CUST-${match[1].replace(/\s/g, '')}` : undefined;
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
const pages: ConsolePage[] = ['overview', 'requests', 'approvals', 'customers', 'systems', 'policies', 'audit', 'agent'];

export function parseCommand(input: string): CommandIntent {
  const text = input.trim();
  const customerId = extractCustomerId(text);
  if (/\b(execute|delete now)\b/i.test(text)) return {kind: 'blocked'};
  if (/\breset\b.*\b(demo|data)\b/i.test(text)) return {kind: 'reset'};
  if (/\b(roll ?back|restore)\b/i.test(text)) return {kind: 'rollback', customerId};
  if (/\b(request approval|approve)\b/i.test(text)) return {kind: 'approve', customerId};
  if (/\breject\b/i.test(text)) return {kind: 'reject', customerId};
  const navigation = text.match(/\b(?:go to|open|show|view)\s+(?:the\s+)?(overview|dashboard|requests|approvals|customers|systems|policies|policy|audit log|agent)\b/i);
  if (navigation && !customerId) { const word = navigation[1].toLowerCase(); return {kind: 'navigate', page: word === 'dashboard' ? 'overview' : word === 'policy' ? 'policies' : word === 'audit log' ? 'audit' : word as ConsolePage}; }
  for (const [pattern, query] of queries) if (pattern.test(text)) return {kind: 'query', query, customerId};
  if (customerId) return /\bdry[\s-]?run\b/i.test(text) ? {kind: 'request', customerId, dryRun: true} : {kind: 'request', customerId};
  const page = pages.find(name => text.toLowerCase() === name);
  if (page) return {kind: 'navigate', page};
  return {kind: 'query'};
}

const QUERY_LABEL: Record<CommandQuery, string> = {'metrics': 'the timeline', 'report': 'the report', 'blast-radius': 'the plan and blast radius', 'backup': 'the backup', 'verification': 'a live rescan', 'plan': 'the plan', 'footprint': 'the footprint', 'dependencies': 'the dependency graph', 'sandbox': 'the sandbox report', 'audit': 'the audit trail'};
/** Plain-language reading of a command, shown before it runs so dictation mistakes are visible. */
export function describeIntent(intent: CommandIntent): string | undefined {
  switch (intent.kind) {
    case 'request': return `${intent.dryRun ? 'Open a dry run' : 'Open an erasure request'} for ${intent.customerId}`;
    case 'approve': return `Review and approve the plan${intent.customerId ? ` for ${intent.customerId}` : ''}`;
    case 'reject': return `Reject the plan${intent.customerId ? ` for ${intent.customerId}` : ''}`;
    case 'rollback': return `Roll back from backup${intent.customerId ? ` for ${intent.customerId}` : ''}`;
    case 'navigate': return `Go to ${intent.page === 'audit' ? 'the audit log' : intent.page === 'agent' ? 'the agent' : intent.page}`;
    case 'reset': return 'Reset the demo data';
    case 'blocked': return 'Not allowed: deletions only run from the guarded Execute button';
    case 'query': return intent.query ? `Show ${QUERY_LABEL[intent.query]}${intent.customerId ? ` for ${intent.customerId}` : ''}` : undefined;
  }
}

/** True when the local reading is specific enough to act on without asking the server. */
export const isConfident = (intent: CommandIntent) => intent.kind === 'navigate' || intent.kind === 'reset' || intent.kind === 'blocked' || (intent.kind === 'request' && Boolean(intent.customerId)) || (intent.kind === 'query' && Boolean(intent.query) && Boolean(intent.customerId));

const TAB_QUERY: Record<string, CommandQuery> = {overview: 'metrics', footprint: 'footprint', dependencies: 'dependencies', plan: 'plan', sandbox: 'sandbox', backup: 'backup', verification: 'verification', report: 'report', audit: 'audit'};
/** Maps the server's reading (model or rules) onto the console's command intents. */
export function fromServerIntent(intent: {action: string; customerId: string | null; tab: string | null; page: string | null}): CommandIntent | {kind: 'investigate'; customerId?: string} | {kind: 'unknown'} {
  const customerId = intent.customerId ?? undefined;
  switch (intent.action) {
    case 'erase': return customerId ? {kind: 'request', customerId} : {kind: 'unknown'};
    case 'dry_run': return customerId ? {kind: 'request', customerId, dryRun: true} : {kind: 'unknown'};
    case 'investigate': return {kind: 'investigate', customerId};
    case 'approve': case 'reject': case 'rollback': return {kind: intent.action, customerId};
    case 'show': return {kind: 'query', query: TAB_QUERY[intent.tab ?? ''] ?? 'metrics', customerId};
    case 'navigate': return intent.page && (pages as string[]).includes(intent.page) ? {kind: 'navigate', page: intent.page as ConsolePage} : {kind: 'unknown'};
    case 'reset': return {kind: 'reset'};
    case 'blocked': return {kind: 'blocked'};
    default: return {kind: 'unknown'};
  }
}
