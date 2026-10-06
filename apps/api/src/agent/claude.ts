import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type {z} from 'zod';
import {DEFAULT_OPENAI_MODEL, openAiMessages} from './openai.js';

export type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
export type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
export type BetaTool = Anthropic.Beta.Messages.BetaTool;
export type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
/** The one method the agents need, so tests can inject a scripted model. */
export type MessagesClient = {create(params: CreateParams): Promise<BetaMessage>};

export type Provider = 'openai' | 'anthropic';
/** `kind: 'claude'` means a language model runs the agents; `provider` says whose (the agents speak the Messages shape either way). */
export type AiEngine =
  | {kind: 'claude'; provider: Provider; model: string; messages: MessagesClient}
  | {kind: 'rules'; reason: string};
export const PROVIDER_LABEL: Record<Provider, string> = {openai: 'OpenAI', anthropic: 'Claude'};

export class ClaudeOutputError extends Error {}

/**
 * OpenAI runs the agents when OPENAI_API_KEY is set (OPENAI_MODEL picks the model). Claude runs
 * them with an Anthropic key, or when ERASEOPS_AI=claude forces it for `ant auth login` profiles.
 * With neither, every agent falls back to deterministic rules and says so, so the demo never
 * depends on network access.
 */
export function createAiEngine(config: {mode: 'auto' | 'claude' | 'off'; model: string}, env: Record<string, string | undefined>, messages?: MessagesClient, provider: Provider = 'anthropic'): AiEngine {
  if (config.mode === 'off') return {kind: 'rules', reason: 'The agents\' model is turned off with ERASEOPS_AI=off'};
  if (messages) return {kind: 'claude', provider, model: config.model, messages};
  if (config.mode === 'auto' && env.OPENAI_API_KEY) {
    return {kind: 'claude', provider: 'openai', model: env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL, messages: openAiMessages(new OpenAI({apiKey: env.OPENAI_API_KEY}).responses)};
  }
  if (config.mode === 'auto' && !env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) return {kind: 'rules', reason: 'Set OPENAI_API_KEY to let OpenAI run the agents'};
  const client = new Anthropic();
  return {kind: 'claude', provider: 'anthropic', model: config.model, messages: {create: params => client.beta.messages.create(params)}};
}

/** Every call checks the stop reason before content is read; on Claude it also opts into server-side refusal fallbacks. */
export async function callClaude(engine: Extract<AiEngine, {kind: 'claude'}>, params: Omit<CreateParams, 'model' | 'betas' | 'fallbacks'>): Promise<BetaMessage> {
  const message = await engine.messages.create({...params, model: engine.model, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default'});
  if (message.stop_reason === 'refusal') throw new ClaudeOutputError(`The model declined this request${message.stop_details?.category ? ` (${message.stop_details.category})` : ''}`);
  return message;
}

export const textOf = (message: BetaMessage) => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim();
export const reasoningOf = (message: BetaMessage) => message.content.flatMap(block => block.type === 'thinking' && block.thinking.trim() ? [block.thinking.trim()] : []);

/** Reads a structured-output response and validates it again locally before anything acts on it. */
export function parseStructured<T>(message: BetaMessage, schema: z.ZodType<T>): T {
  if (message.stop_reason === 'max_tokens') throw new ClaudeOutputError('The model ran out of output tokens before finishing the answer');
  const text = textOf(message);
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new ClaudeOutputError('The model returned text that is not valid JSON'); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ClaudeOutputError(`The model's answer did not match the expected shape: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  return parsed.data;
}

/** Turns an SDK or output failure into a short operator-facing sentence. */
export function describeAiError(error: unknown) {
  if (error instanceof OpenAI.AuthenticationError) return 'OpenAI rejected the API key';
  if (error instanceof OpenAI.RateLimitError) return 'OpenAI is rate limited or out of quota right now';
  if (error instanceof OpenAI.APIConnectionError) return 'OpenAI could not be reached';
  if (error instanceof OpenAI.APIError) return `OpenAI API error ${error.status ?? ''}`.trim();
  if (error instanceof Anthropic.AuthenticationError) return 'Claude rejected the API key';
  if (error instanceof Anthropic.RateLimitError) return 'Claude is rate limited right now';
  if (error instanceof Anthropic.APIConnectionError) return 'Claude could not be reached';
  if (error instanceof Anthropic.APIError) return `Claude API error ${error.status ?? ''}`.trim();
  return error instanceof Error ? error.message : 'The model failed';
}
