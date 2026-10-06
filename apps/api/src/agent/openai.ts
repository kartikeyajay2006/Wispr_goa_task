import OpenAI from 'openai';
import type {BetaMessage, CreateParams, MessagesClient} from './claude.js';

/**
 * Runs the agents' Messages-shaped calls on OpenAI's Responses API, so every agent, prompt,
 * tool and fallback works unchanged on either provider. Requests use store: false: OpenAI keeps
 * no conversation state, and reasoning is carried between tool turns as encrypted content.
 */
export const DEFAULT_OPENAI_MODEL = 'gpt-5.5';

type CreateResponse = OpenAI.Responses.ResponseCreateParamsNonStreaming;
type Effort = NonNullable<NonNullable<CreateResponse['reasoning']>['effort']>;
/** The one method the adapter needs, so tests can inject a scripted client. */
export type ResponsesClient = {create(params: CreateResponse): Promise<OpenAI.Responses.Response>};

const EFFORT: Record<string, Effort> = {low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh'};
// An assistant turn carries the raw Responses output in a thinking block, so the next turn replays it exactly.
const CARRIER = 'openai-output:';
let summariesUnavailable = false;

type Block = {type: string; text?: string};
const joinText = (content: string | Block[] | undefined) => typeof content === 'string' ? content : (content ?? []).flatMap(block => block.type === 'text' && block.text ? [block.text] : []).join('\n');

/** Strict structured outputs need every object closed and every property required; looser schemas are still validated locally. */
export function strictReady(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') return true;
  const node = schema as {properties?: Record<string, unknown>; required?: string[]; additionalProperties?: unknown; items?: unknown; anyOf?: unknown[]};
  if (node.properties) {
    const required = new Set(node.required ?? []);
    if (node.additionalProperties !== false || Object.keys(node.properties).some(key => !required.has(key))) return false;
    if (!Object.values(node.properties).every(strictReady)) return false;
  }
  return [node.items, ...(node.anyOf ?? [])].every(strictReady);
}

export function toResponsesInput(messages: CreateParams['messages']): OpenAI.Responses.ResponseInputItem[] {
  return messages.flatMap((message): OpenAI.Responses.ResponseInputItem[] => {
    if (typeof message.content === 'string') return [{role: message.role, content: message.content}];
    const carrier = message.content.find(block => block.type === 'thinking' && block.signature.startsWith(CARRIER));
    if (carrier?.type === 'thinking') return JSON.parse(carrier.signature.slice(CARRIER.length)) as OpenAI.Responses.ResponseInputItem[];
    return message.content.flatMap((block): OpenAI.Responses.ResponseInputItem[] => {
      switch (block.type) {
        case 'text': return [{role: message.role, content: block.text}];
        case 'tool_use': return [{type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {})}];
        case 'tool_result': return [{type: 'function_call_output', call_id: block.tool_use_id, output: `${block.is_error ? 'ERROR: ' : ''}${joinText(block.content as string | Block[] | undefined)}`}];
        default: return [];
      }
    });
  });
}

export function toResponsesParams(params: CreateParams, summaries = true): CreateResponse {
  const format = params.output_config?.format;
  const wantsThinking = params.thinking?.type === 'adaptive' && params.thinking.display === 'summarized';
  return {
    model: params.model,
    instructions: joinText(params.system as string | Block[] | undefined) || undefined,
    input: toResponsesInput(params.messages),
    max_output_tokens: params.max_tokens,
    reasoning: {effort: EFFORT[params.output_config?.effort ?? 'medium'] ?? 'medium', ...(wantsThinking && summaries ? {summary: 'auto' as const} : {})},
    ...(params.tools?.length ? {tools: params.tools.flatMap(tool => 'input_schema' in tool ? [{type: 'function' as const, name: tool.name, description: tool.description, parameters: tool.input_schema as Record<string, unknown>, strict: false}] : [])} : {}),
    ...(format?.type === 'json_schema' ? {text: {format: {type: 'json_schema' as const, name: 'answer', schema: format.schema, strict: strictReady(format.schema)}}} : {}),
    store: false,
    include: ['reasoning.encrypted_content'],
  };
}

const parseArguments = (raw: string) => { try { return JSON.parse(raw) as unknown; } catch { return {}; } };
/** Reasoning summaries open with a bold title; the console shows plain text, so "**Title**\n\nBody" reads "Title: Body". */
export const plainSummary = (text: string) => text.replace(/^\*\*(.+?)\*\*\s*\n+/, '$1: ').replace(/\*\*(.+?)\*\*/g, '$1').trim();

export function fromResponse(response: OpenAI.Responses.Response): BetaMessage {
  if (response.status === 'failed') throw new Error(`OpenAI could not finish the response${response.error?.message ? `: ${response.error.message}` : ''}`);
  const summary = response.output.flatMap(item => item.type === 'reasoning' ? item.summary.map(part => plainSummary(part.text)) : []).join('\n\n');
  const content: unknown[] = [{type: 'thinking', thinking: summary, signature: CARRIER + JSON.stringify(response.output)}];
  let refused = false;
  for (const item of response.output) {
    if (item.type === 'function_call') content.push({type: 'tool_use', id: item.call_id, name: item.name, input: parseArguments(item.arguments)});
    if (item.type === 'message') for (const part of item.content) {
      if (part.type === 'output_text') content.push({type: 'text', text: part.text, citations: null});
      else if (part.type === 'refusal') refused = true;
    }
  }
  const incomplete = response.status === 'incomplete' ? response.incomplete_details?.reason : undefined;
  const stop = refused || incomplete === 'content_filter' ? 'refusal' : incomplete === 'max_output_tokens' ? 'max_tokens' : content.some(block => (block as Block).type === 'tool_use') ? 'tool_use' : 'end_turn';
  return {id: response.id, type: 'message', role: 'assistant', model: response.model, content, stop_reason: stop, stop_sequence: null, stop_details: null, container: null, context_management: null, usage: {input_tokens: response.usage?.input_tokens ?? 0, output_tokens: response.usage?.output_tokens ?? 0}} as unknown as BetaMessage;
}

export function openAiMessages(client: ResponsesClient): MessagesClient {
  return {
    async create(params) {
      try { return fromResponse(await client.create(toResponsesParams(params, !summariesUnavailable))); }
      catch (error) {
        // Reasoning summaries need a verified organization; without one, keep going without them.
        if (summariesUnavailable || !(error instanceof OpenAI.BadRequestError) || !/summar|verif/i.test(error.message)) throw error;
        summariesUnavailable = true;
        return fromResponse(await client.create(toResponsesParams(params, false)));
      }
    },
  };
}
