import {z} from 'zod';
import {MockMinioConnector, MockPostgresConnector, type Connector, type ConnectorContext} from '../../../packages/connectors/src/index.js';
import type {DeletionAction} from '../../../packages/shared/src/index.js';
export const SAFE_TOOLS=['discover_customer_postgres','discover_customer_s3','inspect_database_schema','inspect_foreign_keys','inspect_object_metadata','count_customer_records','preview_deletion','calculate_dependencies','rescan_customer','generate_report_data'] as const;
export const REVERSIBLE_TOOLS=['create_customer_backup','export_customer_snapshot','create_verification_snapshot'] as const;
export const DESTRUCTIVE_TOOLS=['delete_postgres_records','anonymize_postgres_records','delete_s3_objects'] as const;
export const destructiveInput=z.object({customerId:z.string().regex(/^CUST-\d{4}$/),resource:z.string().regex(/^[A-Za-z0-9_.-]+$/).min(1).max(100),strategy:z.enum(['DELETE','ANONYMIZE']),requestId:z.string().uuid(),approvalId:z.string().uuid(),planHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type DestructiveInput=z.infer<typeof destructiveInput>;
export function assertDestructiveToolApproval(tool:string,approved:boolean){if((DESTRUCTIVE_TOOLS as readonly string[]).includes(tool)&&!approved)throw new Error('Human approval required for destructive tool');}
export function validateDestructiveCall(tool:string,input:unknown,approved:boolean){assertDestructiveToolApproval(tool,approved);if(!(DESTRUCTIVE_TOOLS as readonly string[]).includes(tool))throw new Error('Tool is not a destructive connector operation');return destructiveInput.parse(input);}
export class DestructiveRateLimiter{private readonly attempts=new Map<string,{count:number;resetAt:number}>();constructor(private readonly maxAttempts=3,private readonly windowMs=60_000){}check(identity:string,now=Date.now()){const current=this.attempts.get(identity);if(!current||current.resetAt<=now){this.attempts.set(identity,{count:1,resetAt:now+this.windowMs});return true;}if(current.count>=this.maxAttempts)throw new Error('Destructive operation rate limit exceeded');current.count+=1;return true;}}
export type ToolCategory='safe'|'reversible'|'destructive';
export type ToolDefinition={name:string;category:ToolCategory;requiresApproval:boolean};
export const TOOL_CATALOG:readonly ToolDefinition[]=[...SAFE_TOOLS.map(name=>({name,category:'safe' as const,requiresApproval:false})),...REVERSIBLE_TOOLS.map(name=>({name,category:'reversible' as const,requiresApproval:false})),...DESTRUCTIVE_TOOLS.map(name=>({name,category:'destructive' as const,requiresApproval:true}))];
const definition=(tool:string)=>TOOL_CATALOG.find(item=>item.name===tool);
export type ToolAuthorization={identity:string;approved:boolean;limiter?:DestructiveRateLimiter;authoritativePlanHash?:string;authoritativeApprovalId?:string};
export function invokeTool(tool:string,input:unknown,context:ToolAuthorization){const toolDefinition=definition(tool);if(!toolDefinition)throw new Error('Unknown MCP tool');if(toolDefinition.category==='destructive'){context.limiter?.check(context.identity);const parsed=validateDestructiveCall(tool,input,context.approved);if(!context.authoritativePlanHash||parsed.planHash!==context.authoritativePlanHash)throw new Error('Authoritative plan hash mismatch');if(!context.authoritativeApprovalId||parsed.approvalId!==context.authoritativeApprovalId)throw new Error('Authoritative approval identity mismatch');return parsed;}return input;}

const customerInput=z.object({customerId:z.string().regex(/^CUST-\d{4}$/)}).passthrough();
const actionInput=customerInput.extend({resource:z.string().regex(/^[A-Za-z0-9_.-]+$/).min(1).max(100),strategy:z.enum(['DELETE','ANONYMIZE']).default('DELETE')});
const demoContext:ConnectorContext={demoMode:true,allowlistedHosts:['postgres'],allowlistedBuckets:['customer-uploads','support-attachments','exports','eraseops-backups']};
export type McpConnectorRuntime={postgres:Connector;minio:Connector};
export const createMcpConnectorRuntime=(runtime:Partial<McpConnectorRuntime>={}):McpConnectorRuntime=>({postgres:runtime.postgres??new MockPostgresConnector(),minio:runtime.minio??new MockMinioConnector()});

const actionFor=(input:ReturnType<typeof actionInput.parse>,system:'PostgreSQL'|'MinIO'):DeletionAction=>({id:`mcp:${system}:${input.resource}:${input.customerId}`,system,resource:input.resource,actionType:input.strategy==='ANONYMIZE'?'anonymize':'delete',selector:'customer_id = $1',reason:'approved structured MCP action',recordCount:0,reversible:input.strategy==='ANONYMIZE',risk:'high',dependencies:[],verification:'rescan connector'});
export async function executeMcpTool(tool:string,input:unknown,context:ToolAuthorization,runtime=createMcpConnectorRuntime()) {
  const checked=invokeTool(tool,input,context);
  if ((SAFE_TOOLS as readonly string[]).includes(tool) || (REVERSIBLE_TOOLS as readonly string[]).includes(tool)) {
    const customer=customerInput.parse(checked);
    if (tool==='discover_customer_postgres') return runtime.postgres.discoverCustomerData(customer.customerId,demoContext);
    if (tool==='discover_customer_s3') return runtime.minio.discoverCustomerData(customer.customerId,demoContext);
    if (tool==='inspect_database_schema') return {system:'PostgreSQL',tables:['customers','users','addresses','orders','order_items','payments','support_tickets','support_messages','analytics_events','marketing_profiles','audit_records']};
    if (tool==='inspect_foreign_keys') return runtime.postgres.inspectDependencies?.(customer.customerId) ?? [];
    if (tool==='inspect_object_metadata') return runtime.minio.discoverCustomerData(customer.customerId,demoContext);
    if (tool==='preview_deletion') { const preview=actionInput.parse(checked); return runtime.postgres.previewAction(actionFor(preview,'PostgreSQL')); }
    const [postgresAssets,minioAssets]=await Promise.all([runtime.postgres.discoverCustomerData(customer.customerId,demoContext),runtime.minio.discoverCustomerData(customer.customerId,demoContext)]);
    if (tool==='count_customer_records') return {customerId:customer.customerId,systems:{PostgreSQL:postgresAssets.reduce((n,a)=>n+a.count,0),MinIO:minioAssets.reduce((n,a)=>n+a.count,0)}};
    if (tool==='calculate_dependencies') return [...(runtime.postgres.inspectDependencies ? await runtime.postgres.inspectDependencies(customer.customerId) : []),...(runtime.minio.inspectDependencies ? await runtime.minio.inspectDependencies(customer.customerId) : [])];
    if (tool==='rescan_customer') return await Promise.all([runtime.postgres.verify(customer.customerId),runtime.minio.verify(customer.customerId)]);
    if (tool==='generate_report_data') return {customerId:customer.customerId,assets:[...postgresAssets,...minioAssets],verification:await Promise.all([runtime.postgres.verify(customer.customerId),runtime.minio.verify(customer.customerId)])};
    if (tool==='create_customer_backup' || tool==='export_customer_snapshot') return await Promise.all([runtime.postgres.backupCustomerData(customer.customerId,`mcp-${customer.customerId}`),runtime.minio.backupCustomerData(customer.customerId,`mcp-${customer.customerId}`)]);
    if (tool==='create_verification_snapshot') return await Promise.all([runtime.postgres.verify(customer.customerId),runtime.minio.verify(customer.customerId)]);
  }
  const destructive=destructiveInput.parse(checked); const system=tool==='delete_s3_objects'?'MinIO':'PostgreSQL'; const connector=system==='MinIO'?runtime.minio:runtime.postgres; return connector.execute(actionFor({customerId:destructive.customerId,resource:destructive.resource,strategy:destructive.strategy},system),destructive.planHash,{approved:context.approved});
}
