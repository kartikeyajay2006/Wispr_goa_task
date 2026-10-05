import {DESTRUCTIVE_TOOLS, REVERSIBLE_TOOLS, SAFE_TOOLS, executeMcpTool, invokeTool, type DestructiveRateLimiter, type ToolAuthorization} from './server.js';

type JsonRpcRequest = {jsonrpc: '2.0'; id?: string | number; method: string; params?: Record<string, unknown>};
type JsonRpcResponse = {jsonrpc: '2.0'; id?: string | number; result?: unknown; error?: {code: number; message: string}};
type McpAuthorization = ToolAuthorization;

const toolDescription = (name: string) => ({name, description: `${name} — EraserOps controlled tool`, inputSchema: (DESTRUCTIVE_TOOLS as readonly string[]).includes(name) ? {type: 'object', additionalProperties: false, required: ['customerId', 'resource', 'strategy', 'requestId', 'approvalId', 'planHash'], properties: {customerId: {type: 'string', pattern: '^CUST-[0-9]{4}$'}, resource: {type: 'string'}, strategy: {type: 'string', enum: ['DELETE', 'ANONYMIZE']}, requestId: {type: 'string', format: 'uuid'}, approvalId: {type: 'string', format: 'uuid'}, planHash: {type: 'string', pattern: '^[a-f0-9]{64}$'}}} : {type: 'object', additionalProperties: true}});
const allTools = [...SAFE_TOOLS, ...REVERSIBLE_TOOLS, ...DESTRUCTIVE_TOOLS];

export function handleMcpRequest(request: JsonRpcRequest, authorization: McpAuthorization = {identity: 'mcp-client', approved: false}): JsonRpcResponse | undefined {
  if (!request.id && request.method.startsWith('notifications/')) return undefined;
  try {
    if (request.method === 'initialize') return {jsonrpc: '2.0', id: request.id, result: {protocolVersion: '2025-06-18', capabilities: {tools: {}}, serverInfo: {name: 'eraseops-mcp', version: '0.1.0'}}};
    if (request.method === 'ping') return {jsonrpc: '2.0', id: request.id, result: {}};
    if (request.method === 'tools/list') return {jsonrpc: '2.0', id: request.id, result: {tools: allTools.map(toolDescription)}};
    if (request.method !== 'tools/call') return {jsonrpc: '2.0', id: request.id, error: {code: -32601, message: `Method not found: ${request.method}`}};
    const name = String(request.params?.name ?? '');
    const args = request.params?.arguments ?? {};
    const result = invokeTool(name, args, authorization);
    return {jsonrpc: '2.0', id: request.id, result: {content: [{type: 'text', text: JSON.stringify({tool: name, status: (DESTRUCTIVE_TOOLS as readonly string[]).includes(name) ? 'authorized-structured-call' : 'metadata-only', input: result})}]}};
  } catch (error) { return {jsonrpc: '2.0', id: request.id, error: {code: -32000, message: error instanceof Error ? error.message : 'MCP tool failure'}}; }
}

export async function handleMcpRequestAsync(request: JsonRpcRequest, authorization: McpAuthorization = {identity: 'mcp-client', approved: false}): Promise<JsonRpcResponse | undefined> {
  if (!request.id && request.method.startsWith('notifications/')) return undefined;
  try {
    if (request.method !== 'tools/call') return handleMcpRequest(request, authorization);
    const name=String(request.params?.name ?? ''); const result=await executeMcpTool(name,request.params?.arguments ?? {},authorization);
    return {jsonrpc:'2.0',id:request.id,result:{content:[{type:'text',text:JSON.stringify({tool:name,status:'executed',output:result})}]}};
  } catch (error) { return {jsonrpc:'2.0',id:request.id,error:{code:-32000,message:error instanceof Error?error.message:'MCP tool failure'}}; }
}

function encodeResponse(response: JsonRpcResponse) { const body = JSON.stringify(response); return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`; }
async function emitRequest(body: string) { try { return await handleMcpRequestAsync(JSON.parse(body) as JsonRpcRequest); } catch { return {jsonrpc: '2.0' as const, error: {code: -32700, message: 'Invalid JSON'}}; } }

export function startStdioServer() {
  let buffer = Buffer.alloc(0);
  process.stdin.on('data', (chunk: Buffer | string) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    while (buffer.length) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) break;
      const header = buffer.subarray(0, headerEnd).toString('utf8');
      const match = header.match(/content-length:\s*(\d+)/i);
      if (!match) { buffer = buffer.subarray(headerEnd + 4); continue; }
      const length = Number(match[1]); const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) break;
      const body = buffer.subarray(bodyStart, bodyStart + length).toString('utf8'); buffer = buffer.subarray(bodyStart + length);
      void emitRequest(body).then(response => { if (response) process.stdout.write(encodeResponse(response)); });
    }
  });
  process.stdin.resume();
}

if (process.env.ERASEROPS_MCP_STDIO === 'true') startStdioServer();
