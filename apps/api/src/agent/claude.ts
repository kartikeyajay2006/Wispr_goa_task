import Anthropic from '@anthropic-ai/sdk';
import type {z} from 'zod';

export type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
export type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
export type BetaTool = Anthropic.Beta.Messages.BetaTool;
export type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
/** The one method the agents need, so tests can inject a scripted model. */
export type MessagesClient = {create(params: CreateParams): Promise<BetaMessage>};

export type AiEngine =
  | {kind: 'claude'; model: string; messages: MessagesClient}
  | {kind: 'rules'; reason: string};

export class ClaudeOutputError extends Error {}

/**
 * Claude runs the agents when credentials exist (or ERASEOPS_AI=claude forces it, for
 * `ant auth login` profiles). Without them, every agent falls back to deterministic rules
 * and says so, so the demo never depends on network access.
 */
export function createAiEngine(config: {mode: 'auto' | 'claude' | 'off'; model: string}, env: Record<string, string | undefined>, messages?: MessagesClient): AiEngine {
  if (config.mode === 'off') return {kind: 'rules', reason: 'Claude is turned off with ERASEOPS_AI=off'};
  if (config.mode === 'auto' && !messages && !env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) return {kind: 'rules', reason: 'Set ANTHROPIC_API_KEY to let Claude run the agents'};
  if (messages) return {kind: 'claude', model: config.model, messages};
  const client = new Anthropic();
  return {kind: 'claude', model: config.model, messages: {create: params => client.beta.messages.create(params)}};
}

/** Every call opts into server-side refusal fallbacks and checks the stop reason before content is read. */
export async function callClaude(engine: Extract<AiEngine, {kind: 'claude'}>, params: Omit<CreateParams, 'model' | 'betas' | 'fallbacks'>): Promise<BetaMessage> {
  const message = await engine.messages.create({...params, model: engine.model, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default'});
  if (message.stop_reason === 'refusal') throw new ClaudeOutputError(`Claude declined this request${message.stop_details?.category ? ` (${message.stop_details.category})` : ''}`);
  return message;
}

export const textOf = (message: BetaMessage) => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim();
export const reasoningOf = (message: BetaMessage) => message.content.flatMap(block => block.type === 'thinking' && block.thinking.trim() ? [block.thinking.trim()] : []);

/** Reads a structured-output response and validates it again locally before anything acts on it. */
export function parseStructured<T>(message: BetaMessage, schema: z.ZodType<T>): T {
  if (message.stop_reason === 'max_tokens') throw new ClaudeOutputError('Claude ran out of output tokens before finishing the answer');
  const text = textOf(message);
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new ClaudeOutputError('Claude returned text that is not valid JSON'); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ClaudeOutputError(`Claude's answer did not match the expected shape: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  return parsed.data;
}

/** Turns an SDK or output failure into a short operator-facing sentence. */
export function describeAiError(error: unknown) {
  if (error instanceof Anthropic.AuthenticationError) return 'Claude rejected the API key';
  if (error instanceof Anthropic.RateLimitError) return 'Claude is rate limited right now';
  if (error instanceof Anthropic.APIConnectionError) return 'Claude could not be reached';
  if (error instanceof Anthropic.APIError) return `Claude API error ${error.status ?? ''}`.trim();
  return error instanceof Error ? error.message : 'Claude failed';
}
