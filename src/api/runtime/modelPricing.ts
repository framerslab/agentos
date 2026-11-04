/**
 * @file modelPricing.ts
 * @description The price of a model call before it is sent, for every provider: the rows OpenAI's and Anthropic's
 * tables hold and a table the host registers for any other provider (OpenRouter's models, say), in one shape, and
 * {@link estimateMaxCallCostUSD}, an upper bound on what a call can cost that a host can reserve before the call and
 * settle after it. The spend budget's typical estimate (`estimateCallCostUSD`) and its cost of a finished call
 * (`costOfUsageUSD`) read the same rows. This module imports no provider, so `@framers/agentos/safety/runtime`
 * carries it.
 */
import { anthropicModelPricing, type AnthropicModelPrice } from '../../core/llm/providers/implementations/anthropicCatalog.js';
import {
  OPENAI_CACHE_WRITE_MULTIPLIER,
  OPENAI_EXTENDED_CACHE_WRITE_MULTIPLIER,
  OPENAI_LONG_CONTEXT_INPUT_MULTIPLIER,
  OPENAI_LONG_CONTEXT_OUTPUT_MULTIPLIER,
  OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS,
  openAIModelPricing,
  openAiBillsCacheWrites,
  openAiHasLongContextPricing,
} from '../../core/llm/providers/implementations/openaiPricing.js';

/** One rate card, in US dollars per million tokens. */
export interface ModelPriceTier {
  /** Prompt tokens. */
  inputPerMTokUSD: number;
  /** Completion tokens, reasoning tokens included. */
  outputPerMTokUSD: number;
  /**
   * The highest rate a prompt-cache write is billed at when the request asks for caching: Anthropic's 1-hour write
   * (2x input) on a request with `cache_control`, OpenAI's 12-hour write (2.5x input) on a model that bills writes.
   * Unset where the provider bills no write.
   */
  cacheWritePerMTokUSD?: number;
  /**
   * The rate a prompt-cache write is billed at on a request that asks for no caching: OpenAI caches every prompt on
   * GPT-5.6 and later by default and bills the write at 1.25x input. Unset where a request without cache settings
   * writes nothing (Anthropic, OpenAI before GPT-5.6).
   */
  automaticCacheWritePerMTokUSD?: number;
  /** Prompt tokens read from the prompt cache, where the table knows the rate. */
  cacheReadPerMTokUSD?: number;
}

/** A model's rates: its standard card and, on a model priced by prompt length, the card above a prompt size. */
export interface ModelPrice extends ModelPriceTier {
  /** The card a call whose prompt is over `thresholdTokens` tokens pays for its whole usage. */
  longContext?: { thresholdTokens: number } & ModelPriceTier;
}

/** A host's price table for one provider: a model id's rates, or undefined for a model it does not price. */
export type ModelPriceTable = (modelId: string) => ModelPrice | undefined;

const hostTables = new Map<string, ModelPriceTable>();

/**
 * Registers the host's price table for `providerId`, replacing any table registered for it before. For `openai` and
 * `anthropic` the table is read only for a model the built-in table does not price; for any other provider it is the
 * only table. A host that refreshes its prices (OpenRouter's models endpoint each day) registers again; a table that
 * prices nothing (`() => undefined`) takes its prices away.
 */
export function registerModelPricing(providerId: string, table: ModelPriceTable): void {
  hostTables.set(providerId, table);
}

/** US dollars per million tokens from per thousand, at twelve significant digits so a listed rate reads as listed. */
function perMillion(perThousand: number): number {
  return Number((perThousand * 1000).toPrecision(12));
}

/** Whether `rate` is one a cost can be counted with: a finite number, zero or more. */
function countable(rate: unknown): rate is number {
  return typeof rate === 'number' && Number.isFinite(rate) && rate >= 0;
}

/** Whether every rate a card sets is countable, and the two it must set are set. */
function countableTier(tier: ModelPriceTier): boolean {
  return (
    countable(tier.inputPerMTokUSD) &&
    countable(tier.outputPerMTokUSD) &&
    (tier.cacheWritePerMTokUSD === undefined || countable(tier.cacheWritePerMTokUSD)) &&
    (tier.automaticCacheWritePerMTokUSD === undefined || countable(tier.automaticCacheWritePerMTokUSD)) &&
    (tier.cacheReadPerMTokUSD === undefined || countable(tier.cacheReadPerMTokUSD))
  );
}

/**
 * A row a host's table gave, when every rate in it can be counted. A rate of NaN would price a call at NaN, which
 * every budget check lets through (every comparison with NaN is false), and a negative one would price it below
 * nothing; such a row is no price at all.
 */
function checkedHostRow(row: ModelPrice | undefined): ModelPrice | undefined {
  if (!row || typeof row !== 'object' || !countableTier(row)) return undefined;
  if (row.longContext !== undefined) {
    const long = row.longContext;
    if (!long || typeof long !== 'object' || !countable(long.thresholdTokens) || !countableTier(long)) return undefined;
  }
  return row;
}

/** OpenAI's row in this shape: its per-1K rates, its cache writes on GPT-5.6 and later, its long-context card. */
function openAIPrice(modelId: string): ModelPrice | undefined {
  const row = openAIModelPricing(modelId);
  if (!row) return undefined;
  const writes = openAiBillsCacheWrites(modelId);
  const card = (input: number, output: number): ModelPriceTier => ({
    inputPerMTokUSD: input,
    outputPerMTokUSD: output,
    ...(writes
      ? {
          cacheWritePerMTokUSD: Number((input * OPENAI_EXTENDED_CACHE_WRITE_MULTIPLIER).toPrecision(12)),
          automaticCacheWritePerMTokUSD: Number((input * OPENAI_CACHE_WRITE_MULTIPLIER).toPrecision(12)),
        }
      : {}),
  });
  const input = perMillion(row.input);
  const output = perMillion(row.output);
  return Object.freeze({
    ...card(input, output),
    ...(openAiHasLongContextPricing(modelId)
      ? {
          longContext: Object.freeze({
            thresholdTokens: OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS,
            ...card(
              Number((input * OPENAI_LONG_CONTEXT_INPUT_MULTIPLIER).toPrecision(12)),
              Number((output * OPENAI_LONG_CONTEXT_OUTPUT_MULTIPLIER).toPrecision(12)),
            ),
          }),
        }
      : {}),
  });
}

/** Anthropic's card from its per-1K row: a request with `cache_control` can write at the 1-hour rate. */
function anthropicCard(rates: { input: number; output: number; cacheRead: number; cacheWriteOneHour: number }): ModelPriceTier {
  return {
    inputPerMTokUSD: perMillion(rates.input),
    outputPerMTokUSD: perMillion(rates.output),
    cacheWritePerMTokUSD: perMillion(rates.cacheWriteOneHour),
    cacheReadPerMTokUSD: perMillion(rates.cacheRead),
  };
}

/** Anthropic's row in this shape. */
function anthropicPrice(modelId: string): ModelPrice | undefined {
  const row: AnthropicModelPrice | undefined = anthropicModelPricing(modelId);
  if (!row) return undefined;
  return Object.freeze({
    ...anthropicCard(row),
    ...(row.longContext
      ? { longContext: Object.freeze({ thresholdTokens: row.longContext.fromTokens, ...anthropicCard(row.longContext) }) }
      : {}),
  });
}

/**
 * The rates a call to `modelId` on `providerId` is billed at: the built-in table's row for `openai` and `anthropic`,
 * else the row of the table the host registered for the provider ({@link registerModelPricing}); undefined when
 * neither prices the model, or the host's row holds a rate that cannot be counted (NaN, infinite or negative).
 */
export function modelPricing(providerId: string, modelId: string): ModelPrice | undefined {
  const builtIn = providerId === 'openai' ? openAIPrice(modelId) : providerId === 'anthropic' ? anthropicPrice(modelId) : undefined;
  if (builtIn) return builtIn;
  const table = hostTables.get(providerId);
  return table ? checkedHostRow(table(modelId)) : undefined;
}

/** What a request sends, for {@link estimateMaxCallCostUSD}. */
export interface MaxCostRequest {
  /**
   * The messages (or a Responses API `input`) as the provider is sent them. A string counts as one message. The bound
   * counts what the request carries: a request that draws in context stored with the provider (OpenAI's
   * `previous_response_id`, `conversation` or a stored `prompt`) is billed for tokens its text does not show, so a host
   * sends that context here or refuses the request.
   */
  messages: unknown;
  /**
   * The system prompt (or `instructions`), and anything else the request sends that the provider bills as input text,
   * such as a structured-output schema: its text is counted with the system prompt's.
   */
  system?: unknown;
  /** The tool definitions as the provider is sent them. */
  tools?: unknown;
  /**
   * The request's output cap: `max_tokens`, `max_completion_tokens` or `max_output_tokens`, as the request sends it. A
   * call with none has no bound. A host that cuts a cap above the model's ceiling passes the cut cap: the ceiling a
   * library table knows shapes a request, and is never taken as what the provider will bill.
   */
  maxOutputTokens?: number;
  /** Completions asked for (`n`, `best_of`): each is billed its own output, so a request for more than one has no bound. */
  n?: number;
  /**
   * The request asks for prompt caching: `cache_control` on the request or a block (Anthropic), cache settings or a
   * breakpoint (OpenAI's `prompt_cache_options`, `prompt_cache_breakpoint`, `prompt_cache_retention`). A
   * `cache_control` or `prompt_cache_breakpoint` key in the messages, the system prompt or the tools counts as well.
   */
  cacheMarkers?: boolean;
  /**
   * The request carries a content part that is not text (an image, audio, a file, a document), or asks for output that
   * is not text (OpenAI's `modalities` with `audio`): billed by its own measure.
   */
  nonTextParts?: boolean;
  /** The request names a tool the provider runs or defines (Anthropic's server tools, the Responses API's built-in tools). */
  providerSideTools?: boolean;
  /** The request asks for a faster tier at a higher price (OpenAI's `service_tier: 'priority'` or fast mode, Anthropic's `speed: 'fast'`). */
  priorityTier?: boolean;
  /** The request is processed in one region at an uplift (Anthropic's `inference_geo: 'us'`, OpenAI's regional endpoints). */
  regionalProcessing?: boolean;
}

/**
 * Prompt tokens allowed for each message of a request, and for its system prompt, beyond the bytes of its text: the
 * role and turn markers a provider renders around each one. The counts the providers' counting endpoints gave on
 * 2026-11-04 (`src/api/runtime/__tests__/fixtures/max-cost-token-counts.json`) never reached a message's JSON bytes,
 * which already carry its role and its punctuation.
 */
export const MAX_COST_TOKENS_PER_MESSAGE = 8;

/**
 * Prompt tokens allowed once for a request that sends any tool definition: the tool-use system prompt a provider adds.
 * Anthropic lists it per model, the largest being 804 tokens (Claude Opus 4.7 with `tool_choice` `any` or `tool`;
 * https://platform.claude.com/docs/en/about-claude/pricing, "Tool use pricing", read 2026-11-04), which this covers.
 */
export const MAX_COST_TOOL_USE_TOKENS = 1024;

/**
 * Content part types whose cost a request's text bounds. A part of any other type (an image, a document, audio, a
 * file, a server tool's call or result, whose content the request carries only encrypted or by reference) is billed by
 * a measure its text does not show. A thinking block is replayed with its signature, which holds the whole thinking:
 * on 2026-11-04 a Claude Haiku 5.5 turn's 122 thinking tokens came back with a 1,132-byte signature, and the counting
 * endpoint billed the replayed turn below the bytes of its text. A redacted thinking block's `data` and a Responses
 * API reasoning item's `encrypted_content` hold their thinking the same way.
 */
const TEXT_PART_TYPES = new Set([
  'text',
  'input_text',
  'output_text',
  'refusal',
  'message',
  'tool_use',
  'tool_result',
  'function_call',
  'function_call_output',
  'custom_tool_call',
  'custom_tool_call_output',
  'thinking',
  'redacted_thinking',
  'reasoning',
  'summary_text',
]);

/** Tool definition types the request's text describes in full: a function tool and a custom tool. */
const TEXT_TOOL_TYPES = new Set(['function', 'custom']);

/** Keys that mark a request as asking for prompt caching wherever they appear in its text. */
const CACHE_MARKER = /"(cache_control|prompt_cache_breakpoint)"/;

/**
 * The bytes `text` takes in UTF-8, counted without encoding it: a byte-level tokenizer's token covers at least one
 * byte, so this bounds the tokens the text can make. A lone surrogate counts as the three bytes of the replacement
 * character it is sent as.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** The text a part of the request is sent as: a string as it is, anything else as JSON. */
function textOf(value: unknown): string {
  if (value === undefined) return '';
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
}

/**
 * Whether a list of content parts (a message's `content`, a tool result's `content`, a function call's `output`, a
 * Responses API `input`) holds a part whose cost its text does not bound. It reads the `type` and `audio` of each part
 * and of the parts listed in that part's own `content` or `output`, never a tool call's arguments, which are data.
 */
function hasUnboundedPart(parts: unknown): boolean {
  if (!Array.isArray(parts)) return false;
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const { type, content, output, audio } = part as { type?: unknown; content?: unknown; output?: unknown; audio?: unknown };
    if (typeof type === 'string' && !TEXT_PART_TYPES.has(type)) return true;
    // A Chat Completions assistant message that replays an earlier audio answer by its id: the audio is billed as
    // audio input, which the few bytes of the reference do not show.
    if (audio !== undefined && audio !== null) return true;
    if (hasUnboundedPart(content) || hasUnboundedPart(output)) return true;
  }
  return false;
}

/** Whether a tool list names a tool the provider defines or runs (any `type` but a function or a custom tool). */
function hasProviderTool(tools: unknown): boolean {
  if (!Array.isArray(tools)) return false;
  return tools.some((tool) => {
    const type = tool && typeof tool === 'object' ? (tool as { type?: unknown }).type : undefined;
    return typeof type === 'string' && !TEXT_TOOL_TYPES.has(type);
  });
}

/**
 * An upper bound on the prompt tokens a request can be billed: one token per UTF-8 byte of its messages (as JSON),
 * its system prompt and its tool definitions (as JSON), plus {@link MAX_COST_TOKENS_PER_MESSAGE} for each message and
 * for the system prompt, plus {@link MAX_COST_TOOL_USE_TOKENS} once when it sends a tool. Undefined when the request
 * holds a part or a tool its text does not bound (see {@link estimateMaxCallCostUSD}).
 */
export function maxInputTokens(req: Pick<MaxCostRequest, 'messages' | 'system' | 'tools'>): number | undefined {
  return measure(req)?.tokens;
}

/** A request's token bound and whether its text asks for caching, from one serialization of each of its parts. */
function measure(req: Pick<MaxCostRequest, 'messages' | 'system' | 'tools'>): { tokens: number; cacheMarked: boolean } | undefined {
  if (hasProviderTool(req.tools)) return undefined;
  const messages = req.messages;
  // A message is a part with no type of its own (or the Responses API's `message`), so its content is read with it.
  if (hasUnboundedPart(messages) || hasUnboundedPart(req.system)) return undefined;
  const messagesText = textOf(messages ?? []);
  const systemText = textOf(req.system);
  const toolsText = textOf(req.tools);
  const messageCount = Array.isArray(messages) ? messages.length : messages === undefined ? 0 : 1;
  const toolCount = Array.isArray(req.tools) ? req.tools.length : req.tools === undefined ? 0 : 1;
  const tokens =
    utf8ByteLength(messagesText) +
    utf8ByteLength(systemText) +
    utf8ByteLength(toolsText) +
    MAX_COST_TOKENS_PER_MESSAGE * (messageCount + (systemText !== '' ? 1 : 0)) +
    (toolCount > 0 ? MAX_COST_TOOL_USE_TOKENS : 0);
  return { tokens, cacheMarked: CACHE_MARKER.test(messagesText) || CACHE_MARKER.test(systemText) || CACHE_MARKER.test(toolsText) };
}

/** The larger of two optional rates, or the one that is set. */
function higher(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

/**
 * An upper bound, in US dollars, on what a call to `modelId` on `providerId` can cost, or undefined where it cannot be
 * bounded; a host reserves it before the call and settles to the actual cost after.
 *
 * - Prompt tokens: {@link maxInputTokens}. The bound holds where the typical estimate does not: four characters a
 *   token undercounts CJK text, emoji and base64, which the providers' counting endpoints bill at up to 0.94 tokens a
 *   byte (the fixtures beside this module's tests).
 * - Input rate: the highest the request can reach. The long-context card's where the token bound passes its
 *   threshold, and the higher of that and the cache-write rate where the request asks for caching
 *   (`cacheMarkers`, or a `cache_control` or `prompt_cache_breakpoint` key in its text) or the model writes the cache
 *   by default (OpenAI on GPT-5.6 and later).
 * - Output: the output cap as the request sends it, at the highest output rate the request can reach. A ceiling
 *   below the cap is not applied: a table's ceiling can trail the provider's (an OpenRouter variant of a model writes
 *   more than the model's own ceiling), and a request above the real one is refused unbilled.
 *
 * Undefined, so a host refuses the call, when the model has no price row ({@link modelPricing}), when the request
 * names no finite output cap or asks for more than one completion (`n`), carries a content part that is not text
 * or replays an earlier audio answer, names a tool the provider defines or runs, or asks for a priority or fast tier or for regional processing, each of
 * which bills by a measure or at a rate the text and the table do not show.
 */
export function estimateMaxCallCostUSD(providerId: string, modelId: string, req: MaxCostRequest): number | undefined {
  if ((req.n ?? 1) !== 1) return undefined;
  if (req.nonTextParts || req.providerSideTools || req.priorityTier || req.regionalProcessing) return undefined;
  const price = modelPricing(providerId, modelId);
  if (!price) return undefined;
  const cap = req.maxOutputTokens;
  if (cap === undefined || !Number.isFinite(cap) || cap < 0) return undefined;
  const measured = measure(req);
  if (!measured) return undefined;
  const inputTokens = measured.tokens;
  const cached = req.cacheMarkers === true || measured.cacheMarked;
  const long = price.longContext && inputTokens > price.longContext.thresholdTokens ? price.longContext : undefined;
  const cards: ModelPriceTier[] = long ? [price, long] : [price];
  let inputRate = 0;
  let outputRate = 0;
  for (const card of cards) {
    const write = higher(card.automaticCacheWritePerMTokUSD, cached ? card.cacheWritePerMTokUSD : undefined);
    inputRate = Math.max(inputRate, card.inputPerMTokUSD, write ?? 0);
    outputRate = Math.max(outputRate, card.outputPerMTokUSD);
  }
  return (inputTokens * inputRate + Math.ceil(cap) * outputRate) / 1_000_000;
}

