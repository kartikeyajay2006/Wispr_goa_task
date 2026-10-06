import {z} from 'zod';
import {DESTRUCTIVE_TOOLS, executeMcpTool, type McpConnectorRuntime} from '../../../mcp-server/src/server.js';
import {RETENTION_POLICY} from '../../../../packages/policy-engine/src/retention-policy.js';
import type {Asset, Dependency, VerificationResult} from '../../../../packages/shared/src/index.js';
import type {BetaTool} from './claude.js';

export type CustomerSummary = {customerId: string; displayName?: string; region?: string; status: string; residual: number; footprint: {records: number; resources: number; systems: string[]}; signals: string[]};
export type ToolContext = {runtime: McpConnectorRuntime; customers: () => Promise<CustomerSummary[]>};
export type ToolOutcome = {ok: boolean; summary: string; data: unknown};

const customerId = {type: 'string', description: 'Customer ID such as CUST-1042'} as const;
const closed = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({type: 'object' as const, additionalProperties: false, required, properties});

/**
 * Everything the agents may call. All of it is read-only: discovery and analysis come from the
 * EraseOps MCP catalog, and none of the destructive MCP tools are declared to the model.
 */
export const AGENT_TOOLS: BetaTool[] = [
  {name: 'search_customers', description: 'Find customers by ID, masked first name, or region. Returns masked identities, footprint size and residual personal data. An empty query lists everyone.', strict: true, input_schema: closed({query: {type: 'string'}})},
  {name: 'discover_customer_postgres', description: 'MCP: list the PostgreSQL tables holding the customer\'s rows, with record counts, record IDs and the retention-policy outcome for each. Values are never returned.', strict: true, input_schema: closed({customerId})},
  {name: 'discover_customer_s3', description: 'MCP: list the MinIO buckets holding the customer\'s objects, with object keys and the retention-policy outcome.', strict: true, input_schema: closed({customerId})},
  {name: 'calculate_dependencies', description: 'MCP: foreign keys inside the footprint, retention holds, and rows owned by OTHER customers that reference this customer\'s data (shared dependencies block erasure).', strict: true, input_schema: closed({customerId})},
  {name: 'count_customer_records', description: 'MCP: total records per system for the customer.', strict: true, input_schema: closed({customerId})},
  {name: 'rescan_customer', description: 'MCP: fresh rescan for personal data the policy says must be deleted or redacted. Zero means the customer is already erased.', strict: true, input_schema: closed({customerId})},
  {name: 'preview_deletion', description: 'MCP: dry preview of one action on one table or bucket: whether policy allows it and how many records it would touch. Changes nothing.', strict: true, input_schema: closed({customerId, resource: {type: 'string', description: 'Table or bucket name'}, strategy: {type: 'string', enum: ['DELETE', 'ANONYMIZE']}})},
  {name: 'get_retention_policy', description: 'The retention policy: for each table and bucket, whether data is deleted, redacted or retained, and the legal basis.', strict: true, input_schema: closed({})},
];

const inputs: Record<string, z.ZodTypeAny> = {
  search_customers: z.object({query: z.string()}),
  discover_customer_postgres: z.object({customerId: z.string()}),
  discover_customer_s3: z.object({customerId: z.string()}),
  calculate_dependencies: z.object({customerId: z.string()}),
  count_customer_records: z.object({customerId: z.string()}),
  rescan_customer: z.object({customerId: z.string()}),
  preview_deletion: z.object({customerId: z.string(), resource: z.string(), strategy: z.enum(['DELETE', 'ANONYMIZE'])}),
  get_retention_policy: z.object({}),
};

const compactAssets = (assets: Asset[]) => assets.map(asset => ({resource: asset.table, system: asset.system, records: asset.count, outcome: asset.classification, basis: asset.basis, sampleIds: asset.recordIds?.slice(0, 4)}));
const plural = (count: number, word: string) => `${count} ${count === 1 ? word : /[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`}`;

/** Runs one agent tool and returns compact, model-friendly JSON plus a one-line summary for the UI. */
export async function runAgentTool(name: string, rawInput: unknown, context: ToolContext): Promise<ToolOutcome> {
  if ((DESTRUCTIVE_TOOLS as readonly string[]).includes(name)) return {ok: false, summary: `${name} refused: agents cannot run destructive tools`, data: {error: 'Destructive tools need a human-approved plan; agents only investigate'}};
  const schema = inputs[name];
  if (!schema) return {ok: false, summary: `Unknown tool ${name}`, data: {error: `Unknown tool ${name}`}};
  const parsed = schema.safeParse(rawInput);
  if (!parsed.success) return {ok: false, summary: `${name}: invalid input`, data: {error: parsed.error.issues.map(issue => issue.message).join('; ')}};
  const input = parsed.data as Record<string, string>;
  const mcp = (tool: string, args: unknown) => executeMcpTool(tool, args, {identity: 'eraseops-agent', approved: false}, context.runtime);
  try {
    switch (name) {
      case 'search_customers': {
        const query = input.query.trim().toLowerCase();
        const matches = (await context.customers()).filter(customer => !query || [customer.customerId, customer.displayName ?? '', customer.region ?? ''].some(field => field.toLowerCase().includes(query)));
        return {ok: true, summary: `${plural(matches.length, 'customer')} match “${input.query || 'everyone'}”`, data: matches.map(customer => ({customerId: customer.customerId, name: customer.displayName ?? '(erased)', region: customer.region, status: customer.status, records: customer.footprint.records, residualPersonalData: customer.residual, notes: customer.signals}))};
      }
      case 'discover_customer_postgres': case 'discover_customer_s3': {
        const assets = await mcp(name, input) as Asset[];
        const records = assets.reduce((total, asset) => total + asset.count, 0);
        return {ok: true, summary: `${plural(assets.length, name === 'discover_customer_s3' ? 'bucket' : 'table')}, ${plural(records, 'record')} in ${name === 'discover_customer_s3' ? 'MinIO' : 'PostgreSQL'}`, data: compactAssets(assets)};
      }
      case 'calculate_dependencies': {
        const dependencies = await mcp(name, input) as Dependency[];
        const shared = dependencies.filter(dependency => dependency.constraintType === 'business');
        return {ok: true, summary: shared.length ? `${plural(shared.length, 'shared dependency')} on other customers` : `${plural(dependencies.length, 'dependency')}, none shared with other customers`, data: dependencies.map(({source, target, relationshipType, constraintType, risk}) => ({source, target, relationshipType, constraintType, risk}))};
      }
      case 'count_customer_records': {
        const counts = await mcp(name, input) as {systems: Record<string, number>};
        return {ok: true, summary: Object.entries(counts.systems).map(([system, count]) => `${system} ${count}`).join(', '), data: counts};
      }
      case 'rescan_customer': {
        const results = await mcp(name, input) as VerificationResult[];
        const remaining = results.reduce((total, result) => total + result.remainingMatches, 0);
        return {ok: true, summary: remaining ? `${plural(remaining, 'record')} of erasable personal data present` : 'No erasable personal data left', data: results};
      }
      case 'preview_deletion': {
        const preview = await mcp(name, input) as {safe: boolean; affected: number; reason: string};
        return {ok: true, summary: `${input.strategy.toLowerCase()} ${input.resource}: ${preview.safe ? 'allowed' : 'not allowed'}, ${plural(preview.affected, 'record')}`, data: preview};
      }
      case 'get_retention_policy':
        return {ok: true, summary: `Policy v${RETENTION_POLICY.version}: ${plural(RETENTION_POLICY.rules.length, 'rule')}`, data: RETENTION_POLICY};
    }
  } catch (error) {
    return {ok: false, summary: `${name} failed: ${error instanceof Error ? error.message : 'error'}`, data: {error: error instanceof Error ? error.message : 'error'}};
  }
  return {ok: false, summary: `Unknown tool ${name}`, data: {error: 'unknown tool'}};
}
