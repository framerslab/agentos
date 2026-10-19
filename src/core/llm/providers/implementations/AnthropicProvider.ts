// File: backend/agentos/core/llm/providers/implementations/AnthropicProvider.ts

/**
 * @fileoverview Implements the IProvider interface for Anthropic's Messages API.
 * This provider offers native integration with Anthropic's API, including:
 * - Chat completions via the Messages endpoint (streaming and non-streaming)
 * - Tool/function calling with Anthropic's `input_schema` format
 * - System prompt handling as a top-level field (not a message role)
 * - Proper stop reason mapping (`end_turn` / `tool_use` → IProvider conventions)
 *
 * Key differences from OpenAI that this provider handles:
 * - `system` is a top-level request field, NOT a message with role "system"
 * - `max_tokens` is REQUIRED (Anthropic will reject requests without it)
 * - Tool definitions use `input_schema` instead of `parameters`
 * - Stop reason is `end_turn` (not `stop`) and `tool_use` (not `tool_calls`)
 * - Streaming uses distinct SSE event types (`content_block_delta`, `message_delta`)
 *
 * @module backend/agentos/core/llm/providers/implementations/AnthropicProvider
 * @implements {IProvider}
 */

import {
  IProvider,
  ChatMessage,
  ThinkingBlock,
  MessageContentPart,
  ModelCompletionOptions,
  ModelCompletionResponse,
  ModelCompletionChoice,
  ModelInfo,
  ModelUsage,
  ProviderEmbeddingOptions,
  ProviderEmbeddingResponse,
  CacheDiagnostics,
} from '../IProvider';
import { stripForeignVendorParams } from '../openrouter-only-params';
import { AnthropicProviderError } from '../errors/AnthropicProviderError';
import { ApiKeyPool, keyPoolStrategyFromEnv, type ApiKeyPoolConfig, type ProbeResult } from '../../../providers/ApiKeyPool.js';
import { classifyKeyFailure, retryAfterMs, statusOfKinds, type KeyFailureKind } from '../../../providers/quotaErrors.js';
import { resolveThinkingOff, resolveThinkingPayload } from '../model-thinking.js';
import { modelSupportsForcedToolChoice } from '../model-forced-tool-choice.js';
import {
  anthropicJsonOutputSchema,
  anthropicSchemaRoute,
  modelSupportsJsonOutputs,
  type AnthropicSchemaRoute,
} from '../model-strict-tool-use.js';
import {
  ANTHROPIC_MODELS,
  anthropicModelPricing,
  estimateAnthropicCostUSD,
  resolveAnthropicModelEntry,
  resolveModelCatalogEntry,
  type AnthropicCacheCreationBreakdown,
  type AnthropicModelInfo,
  type AnthropicModelPrice,
  type AnthropicUsageForCost,
} from './anthropicCatalog.js';
import { resolveAnthropicEffort } from '../model-effort.js';
import { computeRetryBackoffMs } from './retry-backoff.js';
import { recordCacheUsage } from './cacheLeakDetector.js';
import { resolveCacheCapabilities } from '../model-cache-capabilities.js';
import { redactUrlSecrets } from '../url-secrets';
import { contentSafeConsole as console } from '../../../logging/contentSafeConsole.js';

// Re-export so callers that already reach for Anthropic model-capability
// predicates (modelSupportsTemperature lives here too) find this one next to
// it, even though its source of truth is the pure model-forced-tool-choice
// module.
export { modelSupportsForcedToolChoice };

// The model catalog, its lookups and its prices live in anthropicCatalog.ts,
// which imports nothing of this provider, so `@framers/agentos/safety/runtime`
// can carry `anthropicModelPricing` without loading the provider. Re-exported
// here so every import that reached them through this module keeps working.
export {
  anthropicModelPricing,
  estimateAnthropicCostUSD,
  resolveAnthropicModelEntry,
  resolveModelCatalogEntry,
  type AnthropicCacheCreationBreakdown,
  type AnthropicModelInfo,
  type AnthropicModelPrice,
  type AnthropicUsageForCost,
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration specific to the AnthropicProvider.
 *
 * @example
 * const config: AnthropicProviderConfig = {
 *   apiKey: process.env.ANTHROPIC_API_KEY!,
 *   defaultModelId: 'claude-sonnet-4-6',
 *   maxRetries: 3,
 * };
 */
export interface AnthropicProviderConfig {
  /**
   * The API key for accessing Anthropic services.
   * Typically sourced from the `ANTHROPIC_API_KEY` environment variable.
   */
  apiKey: string;
  /**
   * Base URL for the Anthropic API.
   * @default "https://api.anthropic.com"
   */
  baseURL?: string;
  /**
   * Default model ID to use if not specified in a request.
   * @example "claude-sonnet-4-6"
   */
  defaultModelId?: string;
  /**
   * Maximum number of retry attempts for failed API requests.
   * @default 3
   */
  maxRetries?: number;
  /**
   * Timeout for API requests in milliseconds.
   * @default 120000 (120 seconds — Anthropic responses can be slow for large contexts)
   */
  requestTimeout?: number;
  /**
   * Idle timeout for streaming responses, in milliseconds. Unlike
   * `requestTimeout` (which only bounds connection + response headers, then is
   * cleared), this bounds the gap BETWEEN streamed chunks: if the provider
   * sends headers and then stalls mid-body, the SSE reader aborts after this
   * many ms rather than awaiting `reader.read()` forever. Defaults to
   * `requestTimeout`.
   * @default requestTimeout (90000)
   */
  streamIdleTimeoutMs?: number;
  /**
   * Transport for `generateCompletion`. When `true` (default), completions
   * ride the SSE streaming path and accumulate server-side events into the
   * same response shape — so `streamIdleTimeoutMs` bounds mid-body stalls.
   * A non-streaming POST cannot distinguish a hung connection from a slow
   * generation, which let a caller's generous `requestTimeout` (codegen
   * passes 25 min) turn each hang into a 25-minute silence. Set `false` to
   * restore the single-shot JSON transport (escape hatch for SSE-hostile
   * proxies).
   * @default true
   */
  streamCompletions?: boolean;
  /**
   * Default max_tokens value when the caller does not specify one.
   * Anthropic requires max_tokens on every request.
   * @default 4096
   */
  defaultMaxTokens?: number;
  /**
   * The key pool behind a comma-separated `apiKey`: `ordered` prefers the
   * earliest usable key (a cost order: credited keys first, the paid key
   * last), `round-robin` spreads load (the default; the environment's
   * `AGENTOS_KEY_POOL_STRATEGY=ordered` changes it when this is absent);
   * `store` and `id` persist the keys' standing across restarts. A key the
   * pool took out is probed off the request path before it returns.
   */
  keyPool?: Pick<ApiKeyPoolConfig, 'strategy' | 'cooldownMs' | 'recheckMs' | 'maxRecheckMs' | 'maxRetryAfterMs' | 'loadTimeoutMs' | 'storeTimeoutMs' | 'store' | 'id'>;
}

/** The kind of key failure an in-stream `error` event names, or null when it is not the key's fault. */
function keyFailureOfStreamError(type: string | undefined, message: string): KeyFailureKind | null {
  if (type === 'authentication_error' || type === 'permission_error') return 'auth';
  if (type === 'rate_limit_error') return 'quota';
  if (type === 'invalid_request_error' && message.toLowerCase().startsWith('your credit balance is too low')) return 'billing';
  return null;
}

/** What a stream request's error carries about the key it used, for the retry loops' key hops. */
interface KeyFailureDetails {
  keyFailure?: KeyFailureKind;
  keyUsable?: number;
  keyCount?: number;
  retryAfterSec?: number;
}

// ---------------------------------------------------------------------------
// Model capability helpers
// ---------------------------------------------------------------------------

/**
 * Whether the given Claude model id accepts the `temperature` parameter.
 *
 * Anthropic deprecated `temperature` on reasoning-default models. Opus 4.7,
 * Opus 4.8, Opus 5, Opus 5.5, Sonnet 5, Sonnet 5.5, Fable 5 and Fable 5.1
 * reject requests that include it with HTTP 400 "`temperature` is deprecated
 * for this model." Opus 5, Opus 5.5 and Fable 5.1 were live-probed on
 * 2026-09-29 and Sonnet 5.5 on 2026-09-30. Opus 5.5, Sonnet 5.5 and Fable 5.1
 * match the existing `opus-5`, `sonnet-5` and `fable-5` alternatives on
 * purpose, because `\b` matches at the hyphen before their trailing version
 * digit.
 * Every earlier Claude model (Opus ≤ 4.6, Sonnet 4.6 and earlier, Haiku) still accepts it.
 * The same family also rejects `top_p` / `top_k`, so {@link buildRequestPayload}
 * gates `top_p` on this predicate too.
 *
 * Deny-by-explicit-family, allow-by-default: keeps older models
 * producing deterministic output and lets new, non-reasoning Claude
 * models keep their temperature control unless added to the deny
 * regex here. Mirrors the pattern `modelRequiresMaxCompletionTokens`
 * uses on OpenAIProvider for `max_tokens` vs `max_completion_tokens`.
 *
 * @param modelId Anthropic-side model id (e.g. `"claude-opus-4-7"` or
 *   a dated variant like `"claude-opus-4-7-20260501"`).
 * @returns `false` when Anthropic will reject `temperature` for this
 *   model, `true` otherwise.
 */
export function modelSupportsTemperature(modelId: string): boolean {
  // Reasoning-default models that reject `temperature` (and `top_p` / `top_k`):
  // Claude Opus 4.7 / 4.8 / 5 / 5.5, Sonnet 5 / 5.5, Fable 5 / 5.1, and any
  // dated variant. Future reasoning-first siblings get added here as Anthropic
  // releases them, in lockstep with modelSupportsThinking.
  return !/^claude-(opus-4-(7|8)|opus-5|sonnet-5|fable-5)\b/i.test(modelId);
}

// ---------------------------------------------------------------------------
// Anthropic API types
// ---------------------------------------------------------------------------

/** A single content block in an Anthropic message (text, tool_use, or tool_result). */
interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'image' | 'thinking' | 'redacted_thinking';
  /** Present when type === 'text'. */
  text?: string;
  /** Present when type === 'thinking' — the reasoning text. */
  thinking?: string;
  /** Present when type === 'thinking' — opaque replay signature; preserve verbatim. */
  signature?: string;
  /** Present when type === 'redacted_thinking' — encrypted reasoning blob; preserve verbatim. */
  data?: string;
  /** Present when type === 'tool_use'. */
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  /** Present when type === 'tool_result'. */
  tool_use_id?: string;
  content?: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
  /** Present when type === 'image'. */
  source?: { type: 'base64'; media_type: string; data: string };
}

/**
 * Why the model declined, sent beside `stop_reason: 'refusal'`. Kept verbatim
 * on the content-policy error the provider raises.
 */
interface AnthropicStopDetails {
  type?: string;
  /** The policy area the request fell under, such as `cyber`. */
  category?: string | null;
  explanation?: string | null;
}

/** The Anthropic Messages API response shape. */
interface AnthropicMessagesResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicContentBlock[];
  model: string;
  stop_reason:
    | 'end_turn'
    | 'max_tokens'
    | 'stop_sequence'
    | 'tool_use'
    | 'pause_turn'
    | 'refusal'
    | 'model_context_window_exceeded'
    | null;
  stop_sequence: string | null;
  /** Present with `stop_reason: 'refusal'`. */
  stop_details?: AnthropicStopDetails | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    /**
     * Split of `cache_creation_input_tokens` by cache TTL. 5-minute writes
     * bill at 1.25x the input price and 1-hour writes at 2x.
     */
    cache_creation?: AnthropicCacheCreationBreakdown | null;
  };
  /**
   * Cache-diagnostics verdict (beta `cache-diagnosis-2026-04-07`). Returned
   * only when the request carried a `diagnostics` field. Absent = not
   * requested; `null` = compared with no divergence (or first-turn opt-in);
   * `{ cache_miss_reason: null }` = comparison still running;
   * `{ cache_miss_reason: {...} }` = earliest divergence identified.
   */
  diagnostics?: {
    cache_miss_reason: { type: string; cache_missed_input_tokens?: number } | null;
  } | null;
}

/**
 * Normalize the wire-format diagnostics object into the camelCased
 * {@link CacheDiagnostics} surfaced on {@link ModelCompletionResponse}.
 * Preserves the API's three requested-response states losslessly:
 * `null` (compared, no divergence) stays `null`; `cache_miss_reason: null`
 * (comparison pending) becomes `{ cacheMissReason: null }`; a populated
 * reason maps field-for-field. Exported for tests.
 */
export function normalizeCacheDiagnostics(
  diagnostics: AnthropicMessagesResponse['diagnostics'],
): CacheDiagnostics | null {
  if (diagnostics == null) return null;
  const reason = diagnostics.cache_miss_reason;
  return {
    cacheMissReason:
      reason == null
        ? null
        : {
            type: reason.type,
            ...(reason.cache_missed_input_tokens !== undefined && {
              cacheMissedInputTokens: reason.cache_missed_input_tokens,
            }),
          },
  };
}

/** An Anthropic tool definition sent in the request body. */
interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Anthropic API error envelope. */
interface AnthropicAPIError {
  type: 'error';
  error: {
    type: string;
    message: string;
  };
}

// ---------------------------------------------------------------------------
// SSE event types for streaming
// ---------------------------------------------------------------------------

interface AnthropicStreamMessageStart {
  type: 'message_start';
  message: AnthropicMessagesResponse;
}

interface AnthropicStreamContentBlockStart {
  type: 'content_block_start';
  index: number;
  content_block: AnthropicContentBlock;
}

interface AnthropicStreamContentBlockDelta {
  type: 'content_block_delta';
  index: number;
  delta: {
    type: 'text_delta' | 'input_json_delta' | 'thinking_delta' | 'signature_delta';
    text?: string;
    partial_json?: string;
    thinking?: string;
    signature?: string;
  };
}

interface AnthropicStreamContentBlockStop {
  type: 'content_block_stop';
  index: number;
}

interface AnthropicStreamMessageDelta {
  type: 'message_delta';
  delta: {
    stop_reason: string | null;
    stop_sequence: string | null;
    /** Present with `stop_reason: 'refusal'`. */
    stop_details?: AnthropicStopDetails | null;
  };
  usage: {
    output_tokens: number;
  };
}

interface AnthropicStreamMessageStop {
  type: 'message_stop';
}

type AnthropicStreamEvent =
  | AnthropicStreamMessageStart
  | AnthropicStreamContentBlockStart
  | AnthropicStreamContentBlockDelta
  | AnthropicStreamContentBlockStop
  | AnthropicStreamMessageDelta
  | AnthropicStreamMessageStop
  | { type: 'ping' }
  | { type: 'error'; error: { type: string; message: string } };

/**
 * Clamp a requested `max_tokens` to the target model's real output ceiling from
 * {@link ANTHROPIC_MODELS}. Anthropic returns HTTP 400 when `max_tokens` exceeds
 * a model's output limit, so a truncation-retry that escalates `max_tokens`
 * (e.g. to 64000) would otherwise convert a recoverable truncation into a fatal
 * request on a lower-ceiling model. Exact id match wins; otherwise a dated
 * variant (`claude-opus-4-7-20260501`) or bare alias (`claude-haiku-4-5`) is
 * matched by prefix. Unknown models pass through unchanged (no catalog ceiling).
 */
export function clampAnthropicMaxTokens(modelId: string, requested: number): number {
  const ceiling = resolveAnthropicModelEntry(modelId)?.outputTokenLimit;
  return typeof ceiling === 'number' && ceiling > 0 ? Math.min(requested, ceiling) : requested;
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

/** Keys of warnings already printed by {@link warnOnce}. */
const warnedKeys = new Set<string>();

/**
 * Prints `message` once per process for `key`, so a setting applied to every
 * request (thinking off on an always-on model, a capped effort) warns once
 * rather than on every call.
 */
function warnOnce(key: string, message: string): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  console.warn(message);
}

/**
 * True when any content block of the wire `messages` enables citations
 * (`citations: { enabled: true }` on a document block). Structured outputs are
 * incompatible with citations: the API answers 400 to a request carrying both.
 */
function messagesEnableCitations(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  for (const message of messages) {
    const content = (message as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const citations = (block as { citations?: unknown } | null)?.citations;
      if (citations && typeof citations === 'object' && (citations as { enabled?: unknown }).enabled === true) {
        return true;
      }
    }
  }
  return false;
}

/**
 * The block the prompt-only route adds to the system prompt, for a schema
 * request neither the JSON output format nor a forced tool carries.
 */
function schemaPromptText(schema: unknown): string {
  return `Answer with JSON only, matching this schema: ${JSON.stringify(schema)}`;
}

/**
 * Appends the prompt-only route's schema block to a system prompt the caller's
 * passthrough set (`customModelParams.system`): a string gets the block joined
 * on, a block array gets a text block in a new array, and an empty one gets
 * the block alone. The provider's own system blocks take the block in the
 * payload builder instead, so the auto-cache's re-emission of those blocks
 * keeps it.
 */
function appendSchemaSystemBlock(payload: Record<string, unknown>, text: string): void {
  const system = payload.system;
  if (Array.isArray(system)) {
    // A new array: a passthrough `system` is the caller's own array, reused
    // across calls, and must not grow a block per call.
    payload.system = [...system, { type: 'text', text }];
  } else if (typeof system === 'string' && system) {
    payload.system = `${system}\n\n${text}`;
  } else {
    payload.system = text;
  }
}

/**
 * The route a built payload's schema took, read by the paths that send it:
 * `forced_tool` names the schema tool for the response mapper, and `none`
 * says the schema rode the prompt, not the payload.
 */
const schemaRouteOfPayload = new WeakMap<object, AnthropicSchemaRoute>();

/**
 * The forced schema tool's name when the built payload sent the schema as that
 * tool, so the mapper surfaces the tool call's input as the answer. The other
 * routes name none: on the JSON output format the answer is the text block, so
 * a caller tool that shares the schema's name stays a tool call.
 */
function forcedSchemaToolName(payload: object, options: ModelCompletionOptions): string | undefined {
  if (schemaRouteOfPayload.get(payload) !== 'forced_tool') return undefined;
  const name = (options.responseFormat as { tool?: { name?: unknown } } | undefined)?.tool?.name;
  return typeof name === 'string' && name ? name : undefined;
}

/** True when the payload turns thinking on (`adaptive` or `enabled`); the off shapes (`disabled`, `between_tools`) do not. */
function payloadThinkingActive(payload: Record<string, unknown>): boolean {
  const type = (payload.thinking as { type?: unknown } | undefined)?.type;
  return type === 'adaptive' || type === 'enabled';
}

/**
 * The `input_schema` of every `strict: true` tool on the wire. Only a
 * passthrough `tools` array carries one (the provider's own tool conversion
 * never sets `strict`), and the vendor counts it with the JSON output format
 * toward the union-typed and optional parameter limits.
 */
function strictToolInputSchemas(tools: unknown): unknown[] {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((tool) => tool !== null && typeof tool === 'object' && (tool as { strict?: unknown }).strict === true)
    .map((tool) => (tool as { input_schema?: unknown }).input_schema ?? {});
}

/** True when a wire `tools` array holds a tool named `name`. */
function toolsInclude(tools: unknown, name: string): boolean {
  return (
    Array.isArray(tools) &&
    tools.some((tool) => tool !== null && typeof tool === 'object' && (tool as { name?: unknown }).name === name)
  );
}

/**
 * True when a wire `tool_choice` makes the model call the schema tool `name`:
 * a choice that names it, or `any` when the schema tool is the one tool the
 * request offers. `passthroughTools` is a passthrough `tools` array, or
 * undefined when the provider sends the schema tool alone.
 */
function toolChoiceForcesSchemaTool(toolChoice: unknown, passthroughTools: unknown, name: string): boolean {
  if (!toolChoice || typeof toolChoice !== 'object') return false;
  const choice = toolChoice as { type?: unknown; name?: unknown };
  if (choice.type === 'tool') return choice.name === name;
  if (choice.type !== 'any') return false;
  if (passthroughTools === undefined) return true;
  return Array.isArray(passthroughTools) && passthroughTools.length === 1 && toolsInclude(passthroughTools, name);
}

/**
 * Removes a passthrough `output_config.format`, keeping the rest of
 * `output_config`, for a request whose messages enable citations: the format
 * and citations together answer 400.
 */
function dropOutputConfigFormat(payload: Record<string, unknown>): void {
  const config = payload.output_config;
  if (!config || typeof config !== 'object' || Array.isArray(config) || !('format' in config)) return;
  const rest: Record<string, unknown> = { ...(config as Record<string, unknown>) };
  delete rest.format;
  if (Object.keys(rest).length > 0) payload.output_config = rest;
  else delete payload.output_config;
}

/**
 * Marks a completion or stream chunk of a schema request with the route the
 * built payload took (`schemaRoute`), so a completion gateway lifts the answer
 * from where this request put it: the text on the JSON output format, the
 * schema tool's call on the forced tool. A request that put the schema in the
 * prompt itself also says `schemaInPayload: false`, as OpenRouter's
 * json_object retry does, so a gateway lifts nothing and the session checks
 * the text as prompt-only. A request without a schema is left as it is.
 */
function withSchemaRoute<T extends ModelCompletionResponse>(completion: T, payload: object): T {
  const schemaRoute = schemaRouteOfPayload.get(payload);
  if (!schemaRoute) return completion;
  return schemaRoute === 'none'
    ? { ...completion, schemaRoute, schemaInPayload: false }
    : { ...completion, schemaRoute };
}

/**
 * @class AnthropicProvider
 * @implements {IProvider}
 *
 * Provides native integration with Anthropic's Messages API.
 * Handles the significant structural differences between Anthropic's API
 * and the OpenAI-style conventions used by IProvider, including system
 * prompt extraction, tool schema remapping, and stop reason normalization.
 *
 * @example
 * const provider = new AnthropicProvider();
 * await provider.initialize({ apiKey: 'sk-ant-...' });
 * const response = await provider.generateCompletion(
 *   'claude-sonnet-4-6',
 *   [{ role: 'user', content: 'Hello!' }],
 *   { maxTokens: 1024 },
 * );
 */
export class AnthropicProvider implements IProvider {
  /** @inheritdoc */
  public readonly providerId: string = 'anthropic';
  /** @inheritdoc */
  public isInitialized: boolean = false;
  /** @inheritdoc */
  public defaultModelId?: string;

  private config!: AnthropicProviderConfig;
  private keyPool: ApiKeyPool | null = null;

  constructor() {}

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Initialize the Anthropic provider with the given configuration.
   *
   * Validates that an API key is present — Anthropic's API will reject
   * unauthenticated requests. Does NOT make a network call on startup
   * because Anthropic has no lightweight health endpoint like OpenAI's
   * `/models` list.
   *
   * @param {AnthropicProviderConfig} config - Provider configuration.
   * @returns {Promise<void>}
   * @throws {AnthropicProviderError} If the API key is missing.
   */
  public async initialize(config: AnthropicProviderConfig): Promise<void> {
    if (!config.apiKey) {
      throw new AnthropicProviderError(
        'API key is required for AnthropicProvider initialization. Set ANTHROPIC_API_KEY.',
        'INIT_FAILED_MISSING_API_KEY',
      );
    }
    // The new pool is built before anything of the old state is touched: its construction makes no request, so a
    // timing it refuses (a RangeError) leaves this provider as it was, its pool and its recheck timer included.
    const keyPool = new ApiKeyPool(config.apiKey, {
      ...(config.keyPool ?? {}),
      ...(config.keyPool?.strategy ? {} : keyPoolStrategyFromEnv('anthropic')),
      probe: (key, kind) => this.probeKey(key, kind),
    });
    // A re-initialize replaces the configuration and the pool: the old pool first stops its timer, finishes its
    // probes (which read this provider's configuration) and writes their results, so a late probe can neither use
    // the new configuration nor overwrite what the new pool loads from the store.
    await this.keyPool?.close();

    this.config = {
      baseURL: 'https://api.anthropic.com',
      // Total attempts (NOT retries-on-top): 1 meant a single shot with the
      // whole retryable-error path (429 / 5xx / 529 overloaded / network) as
      // dead code. 3 matches the OpenAI + Gemini providers and lets the
      // equal-jitter backoff below actually ride out a transient throttle.
      maxRetries: 3,
      requestTimeout: 90000,
      // 4096 was Anthropic's per-call max in the Claude 2 era and
      // is way too small for modern Claude 4 tool-use traffic — Opus
      // 4.7 in particular regularly truncates mid-JSON on tool-use
      // responses when capped here, which surfaces downstream as
      // "tool_use input parse failed" or silently dropped output.
      // Bumped to 16000 — well under Opus 4.7's 32k output ceiling
      // and Sonnet 4.6's 16k ceiling; consumers that need more pass
      // `options.maxTokens` per call. The 2026-05-17 wilds-ai
      // ai-codegen orchestrator hang traced back to this exact
      // default: Opus's tool-use response truncated to 4096 tokens,
      // the model saw the truncated JSON in its history, complained
      // "intent too long. Let me condense", and burned hours in a
      // shorten-retry loop.
      defaultMaxTokens: 16000,
      ...config,
    };
    this.keyPool = keyPool;
    await this.keyPool.ready();
    this.defaultModelId = config.defaultModelId;
    this.isInitialized = true;
    // Failed keys are probed on the pool's own clock once the provider is up, so a provider the health
    // breaker holds still gets its keys back; the timer never keeps the process alive.
    if ((this.keyPool?.size ?? 0) > 1) this.keyPool?.startRechecks();

    const env = typeof process !== 'undefined' ? process.env : undefined;
    const debugOn = env && (env.AGENTOS_DEBUG === '1' || env.AGENTOS_DEBUG === 'true' || (env.AGENTOS_LOG_LEVEL ?? '').toLowerCase() === 'debug');
    if (debugOn) {
      console.log(
        `AnthropicProvider initialized. Default model: ${this.defaultModelId || 'Not set'}.`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Chat completions
  // -------------------------------------------------------------------------

  /**
   * Generates a non-streaming chat completion via Anthropic's Messages API.
   *
   * Extracts system messages from the conversation and promotes them to the
   * top-level `system` field, converts tool definitions from OpenAI format
   * to Anthropic's `input_schema` format, and normalizes the response back
   * to IProvider conventions.
   *
   * @param {string} modelId - The Anthropic model to use (e.g., "claude-sonnet-4-6").
   * @param {ChatMessage[]} messages - Conversation messages. System-role messages are
   *   extracted and sent as the top-level `system` parameter.
   * @param {ModelCompletionOptions} options - Completion options. `maxTokens` is strongly
   *   recommended; defaults to {@link AnthropicProviderConfig.defaultMaxTokens} if omitted.
   * @returns {Promise<ModelCompletionResponse>} A normalized completion response.
   * @throws {AnthropicProviderError} On authentication, validation, or network
   *   errors, and with code `content_filter` when the model refuses
   *   (`stop_reason: 'refusal'`); partial output from a refused turn is
   *   discarded.
   */
  public async generateCompletion(
    modelId: string,
    messages: ChatMessage[],
    options: ModelCompletionOptions,
  ): Promise<ModelCompletionResponse> {
    this.ensureInitialized();

    // The response mapper surfaces the forced schema tool's input as the
    // message's JSON text, named from the route the built payload took
    // (forcedSchemaToolName): the payload builder decides it for the model on
    // the wire, after thinking and citations have had their say.

    // Escape hatch: single-shot JSON transport for SSE-hostile proxies.
    // On both transports the caller's signal aborts the request in flight and
    // stops its retries.
    if (this.config.streamCompletions === false) {
      const payload = this.buildRequestPayload(modelId, messages, options, false);
      const structuredOutputName = forcedSchemaToolName(payload, options);
      const apiResponse = await this.makeApiRequest<AnthropicMessagesResponse>(
        '/v1/messages',
        'POST',
        payload,
        options.requestTimeout,
        options.abortSignal,
      );
      this.recordCacheLeakSample(modelId, payload, apiResponse, options.cache === false);
      return withSchemaRoute(this.mapResponseToCompletion(apiResponse, structuredOutputName, modelId), payload);
    }

    // Default: ride the SSE path so parseSseStream's idle watchdog bounds
    // mid-body stalls. A non-streaming POST cannot tell a hung connection
    // from a slow generation, so a caller's generous requestTimeout
    // (codegen passes 25 min) turned each hang into a 25-minute silence;
    // streamed deltas keep flowing on a healthy call, so a quiet gap of
    // streamIdleTimeoutMs means the connection is dead — fail fast and
    // let the caller (or the retry loop below) recover in seconds.
    const payload = this.buildRequestPayload(modelId, messages, options, true);
    const structuredOutputName = forcedSchemaToolName(payload, options);
    const apiResponse = await this.streamMessagesToResponse(
      payload,
      options.requestTimeout,
      options.abortSignal,
      structuredOutputName,
    );
    this.recordCacheLeakSample(modelId, payload, apiResponse, options.cache === false);
    return withSchemaRoute(this.mapResponseToCompletion(apiResponse, structuredOutputName, modelId), payload);
  }

  /**
   * Feed one request's cache usage to the leak detector (see
   * cacheLeakDetector.ts — warns once per callsite on the zero-read /
   * unmarked pathological signatures). The callsite identity is the first
   * 256 chars of the system prompt, read from the just-built payload so it
   * reflects what actually went to the wire. Fail-open by construction.
   *
   * @param cacheOptOut True when the caller turned caching off for this
   *   request (`options.cache === false`). Its uncached input is deliberate,
   *   so the detector does not count it toward the `unmarked` warning.
   * @private
   */
  private recordCacheLeakSample(
    modelId: string,
    payload: Record<string, unknown>,
    apiResponse: Pick<AnthropicMessagesResponse, 'usage'>,
    cacheOptOut = false,
  ): void {
    try {
      const system = payload.system as
        | string
        | Array<{ type: string; text?: string }>
        | undefined;
      // Bound both branches to the 256-char callsite-identity window the
      // detector hashes — avoids handing a 15K-token system string to the
      // detector on the string path just for it to slice internally.
      const systemPrefix = typeof system === 'string'
        ? system.slice(0, 256)
        : Array.isArray(system)
          ? system.map((b) => b.text ?? '').join('\n').slice(0, 256)
          : '';
      recordCacheUsage({
        model: modelId,
        systemPrefix,
        uncachedInputTokens: apiResponse.usage?.input_tokens ?? 0,
        cacheReadTokens: apiResponse.usage?.cache_read_input_tokens ?? 0,
        cacheCreationTokens: apiResponse.usage?.cache_creation_input_tokens ?? 0,
        ...(cacheOptOut ? { cacheOptOut: true } : {}),
      });
    } catch {
      // Telemetry must never break a request.
    }
  }

  /**
   * Runs a `/v1/messages` request over the SSE transport and accumulates the
   * event stream into a complete {@link AnthropicMessagesResponse}, retrying
   * retryable failures (idle stalls, 429s, 5xx, network errors) up to
   * `config.maxRetries` attempts with exponential backoff.
   *
   * @param payload Request body (must include `stream: true`).
   * @param requestTimeoutOverride Per-call override for the CONNECTION
   *   timeout (headers phase only). The mid-body idle bound stays at
   *   `streamIdleTimeoutMs` regardless — a generous total budget must not
   *   extend how long a dead connection can sit silent.
   * @param abortSignal Caller's signal. It aborts the request in flight, its
   *   body read included, and once it has fired no further attempt is sent.
   * @param schemaToolName The forced schema tool's name when the payload sent
   *   the schema as that tool ({@link accumulateMessagesStream}).
   * @throws {AnthropicProviderError} `REQUEST_ABORTED` when the caller's signal
   *   ends the request.
   * @private
   */
  private async streamMessagesToResponse(
    payload: Record<string, unknown>,
    requestTimeoutOverride?: number,
    abortSignal?: AbortSignal,
    schemaToolName?: string,
  ): Promise<AnthropicMessagesResponse> {
    let lastError: AnthropicProviderError = new AnthropicProviderError(
      'Streaming completion failed after all retries.',
      'MAX_RETRIES_REACHED',
    );

    const attempts = Math.max(1, this.config.maxRetries ?? 1);
    // Key hops this request has made: a key-scoped failure hops to the next
    // usable key at once without spending a transient attempt, at most once
    // per key of the pool.
    let keyHops = 0;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (abortSignal?.aborted) {
        throw new AnthropicProviderError('Request aborted by caller.', 'REQUEST_ABORTED');
      }
      const attemptInfo: { apiKey?: string; startedAt?: number } = {};
      try {
        const stream = await this.makeStreamRequest('/v1/messages', payload, requestTimeoutOverride, abortSignal, attemptInfo);
        const accumulated = await this.accumulateMessagesStream(stream, schemaToolName);
        if (attemptInfo.apiKey) this.keyPool?.markSuccess(attemptInfo.apiKey, attemptInfo.startedAt);
        return accumulated;
      } catch (error: unknown) {
        // A caller abort ends the request here; it is not a failure to retry.
        if (abortSignal?.aborted) {
          throw new AnthropicProviderError('Request aborted by caller.', 'REQUEST_ABORTED');
        }
        lastError =
          error instanceof AnthropicProviderError
            ? error
            : new AnthropicProviderError(
                error instanceof Error ? error.message : 'Streaming completion failed.',
                'STREAM_PROCESSING_ERROR',
              );
        // An in-stream error event that names the key (a revoked key, an
        // unpaid account, a throttle) marks it: nothing has reached the
        // caller yet on this path, so the next key may take the request.
        if (lastError.code === 'STREAM_ERROR_EVENT' && attemptInfo.apiKey && this.keyPool) {
          const kind = keyFailureOfStreamError(lastError.anthropicErrorType, lastError.message);
          if (kind) {
            this.keyPool.markFailed(attemptInfo.apiKey, kind, { at: attemptInfo.startedAt });
            lastError = new AnthropicProviderError(lastError.message, lastError.code, lastError.httpStatus, lastError.anthropicErrorType, {
              ...(typeof lastError.details === 'object' && lastError.details !== null ? (lastError.details as Record<string, unknown>) : {}),
              keyFailure: kind,
              keyUsable: this.keyPool.usable(),
              keyCount: this.keyPool.size,
            });
          }
        }
        const keyDetails = lastError.details as KeyFailureDetails | undefined;
        if (keyDetails?.keyFailure && (keyDetails.keyCount ?? 1) > 1) {
          if ((keyDetails.keyUsable ?? 0) > 0 && ++keyHops < (keyDetails.keyCount ?? 1)) {
            attempt -= 1;
            continue;
          }
          if ((keyDetails.keyUsable ?? 0) === 0 && keyDetails.keyFailure !== 'quota') {
            throw this.allKeysFailedError(lastError.message, lastError.httpStatus, lastError.anthropicErrorType);
          }
        }
        if (!this.isRetryableStreamError(lastError) || attempt === attempts - 1) {
          throw lastError;
        }
        // Honor the server's Retry-After when the failed attempt carried one
        // (429s from makeStreamRequest stash it on error.details) — parity
        // with the non-stream retry path. Fall back to jittered backoff.
        const retryAfterSec = (lastError.details as { retryAfterSec?: number } | undefined)
          ?.retryAfterSec;
        const sleepMs =
          typeof retryAfterSec === 'number' && Number.isFinite(retryAfterSec) && retryAfterSec > 0
            ? retryAfterSec * 1000
            : computeRetryBackoffMs(attempt);
        await new Promise(resolve => setTimeout(resolve, sleepMs));
      }
    }
    throw lastError;
  }

  /**
   * Whether a streaming-completion failure is worth another attempt.
   * Client errors (4xx except 429) and their Anthropic error types are
   * terminal — the request itself is wrong. Everything else (idle stalls,
   * truncated streams, 429s, 5xx, network failures) is transport-level
   * and may succeed on retry.
   * @private
   */
  private isRetryableStreamError(error: AnthropicProviderError): boolean {
    if (error.code === 'ALL_KEYS_FAILED') return false;
    if (
      typeof error.httpStatus === 'number' &&
      error.httpStatus >= 400 &&
      error.httpStatus < 500 &&
      error.httpStatus !== 429
    ) {
      return false;
    }
    const terminalTypes = new Set([
      'invalid_request_error',
      'authentication_error',
      'permission_error',
      'not_found_error',
    ]);
    if (error.anthropicErrorType && terminalTypes.has(error.anthropicErrorType)) {
      return false;
    }
    return true;
  }

  /**
   * Consumes a Messages SSE stream and reassembles the raw response object,
   * mirroring the event handling in {@link generateCompletionStream} but
   * producing the non-streaming {@link AnthropicMessagesResponse} shape so
   * {@link mapResponseToCompletion} stays the single mapping path
   * (structured output, stop reasons, cost, thinking blocks).
   *
   * A refusal returns normally with `stop_reason: 'refusal'` and its
   * `stop_details`, even when it cut a tool_use input off mid-JSON:
   * {@link mapResponseToCompletion} raises it as a content-policy error, and
   * a transport error here would be retried instead.
   *
   * A forced schema tool call whose input an output limit cut off
   * (`max_tokens`, or the context window) returns normally too: its raw
   * input becomes a text block, so {@link mapResponseToCompletion} reports
   * the cut text with finish reason `length`, the answer generateObject
   * raises its budget for, where a transport error would be retried at the
   * same budget and then thrown past the escalation.
   *
   * @param schemaToolName The forced schema tool's name when the request sent
   *   the schema as that tool; a cut call of any other name still throws.
   * @throws {AnthropicProviderError} `STREAM_ERROR_EVENT` on an SSE error
   *   event, `STREAM_INCOMPLETE` when the stream ends before `message_delta`
   *   or a tool_use input JSON is truncated (other than the schema call's at
   *   an output limit), plus whatever {@link parseSseStream} throws
   *   (`STREAM_IDLE_TIMEOUT`, parse errors).
   * @private
   */
  private async accumulateMessagesStream(
    stream: ReadableStream<Uint8Array>,
    schemaToolName?: string,
  ): Promise<AnthropicMessagesResponse> {
    type AccumBlock = {
      type: 'text' | 'tool_use' | 'thinking' | 'redacted_thinking';
      text?: string;
      id?: string;
      name?: string;
      argsJson?: string;
      thinking?: string;
      signature?: string;
      data?: string;
    };

    let id = `anthropic-stream-${Date.now()}`;
    let model = '';
    let stopReason: AnthropicMessagesResponse['stop_reason'] = null;
    let stopDetails: AnthropicStopDetails | null | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreationTokens: number | undefined;
    let cacheReadTokens: number | undefined;
    let cacheCreationSplit: AnthropicCacheCreationBreakdown | null | undefined;
    let diagnostics: AnthropicMessagesResponse['diagnostics'];
    let sawMessageDelta = false;
    const blocks = new Map<number, AccumBlock>();

    for await (const rawEvent of this.parseSseStream(stream)) {
      let event: AnthropicStreamEvent;
      try {
        event = JSON.parse(rawEvent) as AnthropicStreamEvent;
      } catch {
        console.warn('AnthropicProvider: Could not parse SSE event JSON:', {
          eventBytes: new TextEncoder().encode(rawEvent).byteLength,
          error: 'Invalid stream JSON.',
        });
        continue;
      }

      switch (event.type) {
        case 'message_start': {
          id = event.message.id ?? id;
          model = event.message.model ?? model;
          inputTokens = event.message.usage?.input_tokens ?? 0;
          cacheCreationTokens = event.message.usage?.cache_creation_input_tokens;
          cacheReadTokens = event.message.usage?.cache_read_input_tokens;
          // The 5m/1h split of the cache writes prices the 1h share at 2x.
          cacheCreationSplit = event.message.usage?.cache_creation;
          // Cache diagnostics ride message_start in streaming responses.
          diagnostics = event.message.diagnostics;
          break;
        }
        case 'content_block_start': {
          const cb = event.content_block;
          if (cb.type === 'text') {
            blocks.set(event.index, { type: 'text', text: cb.text ?? '' });
          } else if (cb.type === 'tool_use') {
            blocks.set(event.index, {
              type: 'tool_use',
              id: cb.id ?? `call_${Date.now()}_${event.index}`,
              name: cb.name ?? 'unknown',
              argsJson: '',
            });
          } else if (cb.type === 'thinking') {
            blocks.set(event.index, {
              type: 'thinking',
              thinking: cb.thinking ?? '',
              signature: cb.signature ?? '',
            });
          } else if (cb.type === 'redacted_thinking') {
            blocks.set(event.index, { type: 'redacted_thinking', data: cb.data ?? '' });
          }
          break;
        }
        case 'content_block_delta': {
          const block = blocks.get(event.index);
          if (!block) break;
          if (event.delta.type === 'text_delta' && event.delta.text) {
            block.text = (block.text ?? '') + event.delta.text;
          } else if (event.delta.type === 'input_json_delta' && event.delta.partial_json) {
            block.argsJson = (block.argsJson ?? '') + event.delta.partial_json;
          } else if (event.delta.type === 'thinking_delta' && typeof event.delta.thinking === 'string') {
            block.thinking = (block.thinking ?? '') + event.delta.thinking;
          } else if (event.delta.type === 'signature_delta' && typeof event.delta.signature === 'string') {
            block.signature = (block.signature ?? '') + event.delta.signature;
          }
          break;
        }
        case 'message_delta': {
          sawMessageDelta = true;
          stopReason = (event.delta.stop_reason ?? null) as AnthropicMessagesResponse['stop_reason'];
          stopDetails = event.delta.stop_details ?? stopDetails;
          // Anthropic reports the cumulative output total here — latest wins.
          outputTokens = event.usage?.output_tokens ?? outputTokens;
          break;
        }
        case 'error': {
          throw new AnthropicProviderError(
            event.error.message,
            'STREAM_ERROR_EVENT',
            undefined,
            event.error.type,
          );
        }
        // 'content_block_stop', 'message_stop', 'ping' — no action needed
        default:
          break;
      }
    }

    if (!sawMessageDelta) {
      throw new AnthropicProviderError(
        'Stream ended before message_delta — response incomplete (connection dropped mid-message).',
        'STREAM_INCOMPLETE',
      );
    }

    const content: AnthropicContentBlock[] = Array.from(blocks.entries())
      // A refusal can cut a tool input off mid-JSON. The refused turn is
      // discarded whole, so its tool calls are dropped rather than parsed.
      .filter(([, block]) => stopReason !== 'refusal' || block.type !== 'tool_use')
      .sort((a, b) => a[0] - b[0])
      .map(([, block]) => {
        if (block.type === 'tool_use') {
          let input: Record<string, unknown>;
          try {
            input = block.argsJson ? (JSON.parse(block.argsJson) as Record<string, unknown>) : {};
          } catch {
            if (
              schemaToolName !== undefined &&
              block.name === schemaToolName &&
              (stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded')
            ) {
              // The answer stopped at an output limit while its JSON was still
              // being written: the turn ended there, the stream did not drop.
              // The raw input is the answer's text, reported with the stop.
              return { type: 'text', text: block.argsJson ?? '' };
            }
            throw new AnthropicProviderError(
              `Tool input JSON for "${block.name}" truncated mid-stream — response incomplete.`,
              'STREAM_INCOMPLETE',
            );
          }
          return { type: 'tool_use', id: block.id, name: block.name, input };
        }
        if (block.type === 'thinking') {
          return { type: 'thinking', thinking: block.thinking ?? '', signature: block.signature ?? '' };
        }
        if (block.type === 'redacted_thinking') {
          return { type: 'redacted_thinking', data: block.data ?? '' };
        }
        return { type: 'text', text: block.text ?? '' };
      });

    return {
      id,
      type: 'message',
      role: 'assistant',
      content,
      model,
      stop_reason: stopReason,
      stop_sequence: null,
      ...(stopDetails !== undefined && { stop_details: stopDetails }),
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        ...(cacheCreationTokens !== undefined && { cache_creation_input_tokens: cacheCreationTokens }),
        ...(cacheReadTokens !== undefined && { cache_read_input_tokens: cacheReadTokens }),
        ...(cacheCreationSplit != null && { cache_creation: cacheCreationSplit }),
      },
      ...(diagnostics !== undefined && { diagnostics }),
    };
  }

  /**
   * Generates a streaming chat completion via Anthropic's Messages API.
   *
   * Anthropic's streaming uses distinct SSE event types:
   * - `message_start` — initial metadata and usage
   * - `content_block_start` — beginning of a text or tool_use block
   * - `content_block_delta` — incremental text or tool argument JSON
   * - `content_block_stop` — end of a block
   * - `message_delta` — final stop_reason and output token count
   * - `message_stop` — terminal event
   *
   * This method normalizes all of the above into the IProvider streaming
   * contract with `responseTextDelta`, `toolCallsDeltas`, and `isFinal`.
   *
   * @param {string} modelId - The Anthropic model to use.
   * @param {ChatMessage[]} messages - Conversation messages.
   * @param {ModelCompletionOptions} options - Completion options.
   * @returns {AsyncGenerator<ModelCompletionResponse>} Incremental response chunks.
   * @throws {AnthropicProviderError} On connection errors, and with code
   *   `content_filter` when the model refuses (`stop_reason: 'refusal'`),
   *   before or after text has streamed. Other stream errors end the stream
   *   with an error chunk.
   */
  public async *generateCompletionStream(
    modelId: string,
    messages: ChatMessage[],
    options: ModelCompletionOptions,
  ): AsyncGenerator<ModelCompletionResponse, void, undefined> {
    this.ensureInitialized();

    const payload = this.buildRequestPayload(modelId, messages, options, true);
    if (!schemaRouteOfPayload.has(payload)) {
      yield* this.streamRequest(modelId, options, payload);
      return;
    }
    // A schema request: every chunk names the route the payload took, and one
    // whose schema rode the prompt says `schemaInPayload: false` (as
    // OpenRouter's json_object retry does), so a gateway lifts the answer from
    // where this request put it, or lifts nothing.
    for await (const chunk of this.streamRequest(modelId, options, payload)) {
      yield withSchemaRoute(chunk, payload);
    }
  }

  /** The stream of one built request: the abort handling, the SSE parse, the retries and the chunk mapping. */
  private async *streamRequest(
    modelId: string,
    options: ModelCompletionOptions,
    payload: Record<string, unknown>,
  ): AsyncGenerator<ModelCompletionResponse, void, undefined> {
    // Handle pre-aborted signals
    const abortSignal = options.abortSignal;
    if (abortSignal?.aborted) {
      yield this.buildAbortChunk(modelId);
      return;
    }

    // A key-scoped connection failure, before any event has reached the
    // caller, moves to the next usable key; after content has streamed an
    // error surfaces as before and the key stays marked for the next request.
    const streamAttempt: { apiKey?: string; startedAt?: number } = {};
    let keyHops = 0;
    let stream: ReadableStream<Uint8Array> | undefined;
    while (stream === undefined) {
      try {
        // The caller's signal ends a draw that waits on the pool's probes, the connection and the body's reads.
        stream = await this.makeStreamRequest('/v1/messages', payload, undefined, abortSignal, streamAttempt);
      } catch (error: unknown) {
        // An abort before the first event, while the draw waited on the probes or the connection was opening,
        // ends the stream with the abort chunk, as an abort before the request does.
        if (abortSignal?.aborted) {
          yield this.buildAbortChunk(modelId);
          return;
        }
        if (error instanceof AnthropicProviderError) {
          const keyDetails = error.details as KeyFailureDetails | undefined;
          if (keyDetails?.keyFailure && (keyDetails.keyCount ?? 1) > 1) {
            if ((keyDetails.keyUsable ?? 0) > 0 && ++keyHops < (keyDetails.keyCount ?? 1)) continue;
            if ((keyDetails.keyUsable ?? 0) === 0 && keyDetails.keyFailure !== 'quota') {
              throw this.allKeysFailedError(error.message, error.httpStatus, error.anthropicErrorType);
            }
          }
        }
        throw error;
      }
    }

    // State accumulators across SSE events
    let responseId = `anthropic-${modelId}-${Date.now()}`;
    let accumulatedContent = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreationTokens: number | undefined;
    let cacheReadTokens: number | undefined;
    /** The 5m/1h split of the cache writes, reported on message_start. */
    let cacheCreationSplit: AnthropicCacheCreationBreakdown | null | undefined;
    /**
     * Cache-diagnostics verdict, delivered ONLY on message_start (no later
     * SSE event repeats it). `undefined` = the API sent none (not opted in);
     * `null` = compared, no divergence. Attached normalized to the final
     * chunk beside `id` — the same place threading callers already read.
     */
    let streamDiagnostics: AnthropicMessagesResponse['diagnostics'] | undefined;
    /** Map from content block index → tool call accumulator */
    const toolCallAccum: Map<number, { id: string; name: string; argsJson: string }> = new Map();
    /**
     * Map from content block index → accumulating thinking block. Standard
     * thinking accumulates text + signature across deltas; redacted thinking
     * arrives whole in content_block_start. Assembled in index order on the
     * final chunk so the agent loop can replay them verbatim.
     */
    const thinkingAccum: Map<number, ThinkingBlock> = new Map();

    const abortHandler = () => { /* consumer checks abortSignal each iteration */ };
    abortSignal?.addEventListener('abort', abortHandler, { once: true });

    try {
      for await (const rawEvent of this.parseSseStream(stream)) {
        if (abortSignal?.aborted) {
          yield this.buildAbortChunk(modelId);
          break;
        }

        let event: AnthropicStreamEvent;
        try {
          event = JSON.parse(rawEvent) as AnthropicStreamEvent;
        } catch {
          // Malformed JSON — skip this event
          console.warn('AnthropicProvider: Could not parse SSE event JSON:', {
            eventBytes: new TextEncoder().encode(rawEvent).byteLength,
            error: 'Invalid stream JSON.',
          });
          continue;
        }

        switch (event.type) {
          case 'message_start': {
            responseId = event.message.id;
            inputTokens = event.message.usage?.input_tokens ?? 0;
            // input_tokens excludes cached tokens — capture the cache
            // counts so the final chunk's usage prices them (the
            // accumulate path at streamToCompletion does the same).
            cacheCreationTokens = event.message.usage?.cache_creation_input_tokens;
            cacheReadTokens = event.message.usage?.cache_read_input_tokens;
            cacheCreationSplit = event.message.usage?.cache_creation;
            // Cache diagnostics ride message_start in streaming responses
            // (mirrors the streamToCompletion aggregate path).
            streamDiagnostics = event.message.diagnostics;
            break;
          }

          case 'content_block_start': {
            // A new tool_use block registers a placeholder in the accumulator
            if (event.content_block.type === 'tool_use') {
              toolCallAccum.set(event.index, {
                id: event.content_block.id ?? `call_${Date.now()}_${event.index}`,
                name: event.content_block.name ?? 'unknown',
                argsJson: '',
              });
            } else if (event.content_block.type === 'thinking') {
              // Standard thinking: text + signature accumulate across deltas.
              thinkingAccum.set(event.index, {
                type: 'thinking',
                thinking: event.content_block.thinking ?? '',
                signature: event.content_block.signature ?? '',
              });
            } else if (event.content_block.type === 'redacted_thinking') {
              // Redacted thinking arrives whole — capture the blob verbatim.
              thinkingAccum.set(event.index, {
                type: 'redacted_thinking',
                data: event.content_block.data ?? '',
              });
            }
            break;
          }

          case 'content_block_delta': {
            if (event.delta.type === 'text_delta' && event.delta.text) {
              // Incremental text content
              const textDelta = event.delta.text;
              accumulatedContent += textDelta;

              yield {
                id: responseId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                modelId,
                choices: [{
                  index: 0,
                  message: { role: 'assistant', content: textDelta },
                  finishReason: null,
                }],
                responseTextDelta: textDelta,
              };
            } else if (event.delta.type === 'input_json_delta' && event.delta.partial_json) {
              // Incremental tool argument JSON fragment
              const accum = toolCallAccum.get(event.index);
              if (accum) {
                accum.argsJson += event.delta.partial_json;

                yield {
                  id: responseId,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  modelId,
                  choices: [{
                    index: 0,
                    message: { role: 'assistant', content: null },
                    finishReason: null,
                  }],
                  toolCallsDeltas: [{
                    index: event.index,
                    id: accum.id,
                    type: 'function',
                    function: {
                      name: accum.name,
                      arguments_delta: event.delta.partial_json,
                    },
                  }],
                };
              }
            } else if (
              event.delta.type === 'thinking_delta' &&
              typeof event.delta.thinking === 'string'
            ) {
              // Internal reasoning — accumulated, not surfaced as a text delta.
              const accum = thinkingAccum.get(event.index);
              if (accum && accum.type === 'thinking') {
                accum.thinking += event.delta.thinking;
              }
            } else if (
              event.delta.type === 'signature_delta' &&
              typeof event.delta.signature === 'string'
            ) {
              const accum = thinkingAccum.get(event.index);
              if (accum && accum.type === 'thinking') {
                accum.signature += event.delta.signature;
              }
            }
            break;
          }

          case 'message_delta': {
            // Anthropic reports the CUMULATIVE output total in each
            // message_delta — latest wins. Summing successive deltas (`+=`)
            // double-counts output tokens and over-reports billing. Mirrors the
            // streamMessagesToResponse path.
            outputTokens = event.usage?.output_tokens ?? outputTokens;
            const stopReason = this.mapStopReason(event.delta.stop_reason);

            // Assemble final tool_calls array from accumulated blocks
            const toolCalls = this.assembleToolCalls(toolCallAccum);
            const hasToolCalls = toolCalls.length > 0;

            // Assemble thinking blocks in content-block index order so they
            // replay in the exact sequence the model emitted them.
            const thinkingBlocks: ThinkingBlock[] = Array.from(thinkingAccum.entries())
              .sort((a, b) => a[0] - b[0])
              .map(([, block]) => block);

            const usage: ModelUsage = {
              promptTokens: inputTokens,
              completionTokens: outputTokens,
              totalTokens: inputTokens + outputTokens,
              // Cache-aware like the non-streaming path: input_tokens
              // excludes cached tokens, so dropping the cache counts here
              // undercosted every streamed turn once automatic caching
              // landed (cache reads and writes are real spend).
              costUSD: estimateAnthropicCostUSD(modelId, {
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                cache_read_input_tokens: cacheReadTokens,
                cache_creation_input_tokens: cacheCreationTokens,
                cache_creation: cacheCreationSplit,
              }),
              ...(cacheCreationTokens !== undefined && {
                cacheCreationInputTokens: cacheCreationTokens,
              }),
              ...(cacheReadTokens !== undefined && {
                cacheReadInputTokens: cacheReadTokens,
              }),
              // Inclusive input total (input_tokens excludes cache on Anthropic).
              ...(typeof inputTokens === 'number'
                ? {
                    inclusiveInputTokens:
                      inputTokens + (cacheReadTokens ?? 0) + (cacheCreationTokens ?? 0),
                  }
                : {}),
            };

            // Sample the leak detector on the STREAMING path too. This was
            // the RC9 blind spot: only generateCompletion sampled, so the
            // streamed conversation surfaces (narrator, companion) — where
            // the 2026-07 history-caching regressions actually lived — were
            // invisible to the zero-read / unmarked tripwires.
            this.recordCacheLeakSample(
              modelId,
              payload,
              {
                usage: {
                  input_tokens: inputTokens,
                  output_tokens: outputTokens,
                  ...(cacheCreationTokens !== undefined && {
                    cache_creation_input_tokens: cacheCreationTokens,
                  }),
                  ...(cacheReadTokens !== undefined && {
                    cache_read_input_tokens: cacheReadTokens,
                  }),
                },
              },
              options.cache === false,
            );

            // A refusal ends the turn unsuccessfully, whatever streamed before
            // it. Anthropic's contract is to discard the partial output; a
            // final chunk would let the caller keep it as the answer and run
            // tool calls parsed out of it.
            if (event.delta.stop_reason === 'refusal') {
              throw this.refusalError(modelId, event.delta.stop_details, accumulatedContent, usage);
            }

            yield {
              id: responseId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              modelId,
              choices: [{
                index: 0,
                message: {
                  role: 'assistant',
                  content: accumulatedContent || null,
                  ...(hasToolCalls && { tool_calls: toolCalls }),
                  ...(thinkingBlocks.length > 0 && { thinkingBlocks }),
                },
                finishReason: stopReason,
              }],
              usage,
              // Normalized verdict beside `id`, the threading key — absent
              // entirely when the API sent no diagnostics (not opted in).
              ...(streamDiagnostics !== undefined && {
                cacheDiagnostics: normalizeCacheDiagnostics(streamDiagnostics),
              }),
              isFinal: true,
            };
            break;
          }

          case 'error': {
            // Stream-level error from Anthropic. One that names the key (a
            // revoked key, an unpaid account, a throttle) takes the key out
            // for the next request; this request has streamed content, so
            // the error surfaces as before.
            const keyKind = keyFailureOfStreamError(event.error.type, event.error.message);
            if (keyKind && streamAttempt.apiKey && this.keyPool) {
              this.keyPool.markFailed(streamAttempt.apiKey, keyKind, { at: streamAttempt.startedAt });
            }
            yield {
              id: responseId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              modelId,
              choices: [],
              error: {
                message: event.error.message,
                type: event.error.type,
              },
              isFinal: true,
            };
            return;
          }

          // 'content_block_stop', 'message_stop', 'ping' — no action needed
          default:
            break;
        }
      }
    } catch (streamError: unknown) {
      // A refusal propagates as a thrown content-policy error, as
      // GeminiProvider's safety block does, so the fallback chain can act on
      // it instead of reading an error chunk.
      if (streamError instanceof AnthropicProviderError && streamError.code === 'content_filter') {
        throw streamError;
      }
      // The caller's signal rides on the fetch, so an abort mid-stream ends the body's read at once: the stream
      // ends with the abort chunk, not an error chunk.
      if (abortSignal?.aborted) {
        yield this.buildAbortChunk(modelId);
        return;
      }
      const message = streamError instanceof Error ? streamError.message : 'Anthropic stream processing error';
      console.error(`AnthropicProvider stream error for model ${modelId}:`, message);
      yield {
        id: responseId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        modelId,
        choices: [],
        isFinal: true,
        error: { message, type: 'STREAM_PROCESSING_ERROR' },
      };
    } finally {
      abortSignal?.removeEventListener('abort', abortHandler);
    }
  }

  // -------------------------------------------------------------------------
  // Embeddings (not natively supported by Anthropic)
  // -------------------------------------------------------------------------

  /**
   * Anthropic does not offer an embeddings API. This method always throws.
   *
   * @param {string} _modelId - Unused.
   * @param {string[]} _texts - Unused.
   * @param {ProviderEmbeddingOptions} [_options] - Unused.
   * @returns {Promise<ProviderEmbeddingResponse>} Never returns.
   * @throws {AnthropicProviderError} Always — embeddings are not supported.
   */
  public async generateEmbeddings(
    _modelId: string,
    _texts: string[],
    _options?: ProviderEmbeddingOptions,
  ): Promise<ProviderEmbeddingResponse> {
    throw new AnthropicProviderError(
      'Anthropic does not provide an embeddings API. Use a dedicated embedding provider (e.g., OpenAI, Voyage).',
      'EMBEDDINGS_NOT_SUPPORTED',
    );
  }

  // -------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------

  /**
   * Returns a static catalog of known Anthropic models.
   *
   * Anthropic does not expose a `/models` list endpoint, so this uses a
   * hardcoded catalog that is kept up-to-date with major releases.
   *
   * @param {{ capability?: string }} [filter] - Optional capability filter.
   * @returns {Promise<ModelInfo[]>} Array of known Anthropic models.
   */
  public async listAvailableModels(
    filter?: { capability?: string },
  ): Promise<ModelInfo[]> {
    this.ensureInitialized();
    if (filter?.capability) {
      return ANTHROPIC_MODELS.filter(m => m.capabilities.includes(filter.capability!));
    }
    return [...ANTHROPIC_MODELS];
  }

  /**
   * Retrieves metadata for a specific model from the static catalog.
   *
   * @param {string} modelId - Model identifier (e.g., "claude-sonnet-4-6").
   * @returns {Promise<ModelInfo | undefined>} Model info or undefined if not found.
   */
  public async getModelInfo(modelId: string): Promise<ModelInfo | undefined> {
    this.ensureInitialized();
    return ANTHROPIC_MODELS.find(m => m.modelId === modelId);
  }

  /**
   * Performs a lightweight health check by sending a minimal Messages request.
   *
   * @returns {Promise<{ isHealthy: boolean; details?: unknown }>} Health status.
   */
  public async checkHealth(): Promise<{ isHealthy: boolean; details?: unknown }> {
    try {
      // Anthropic has no /health or /models endpoint, so we send a tiny
      // completion request with max_tokens=1 to verify credentials + connectivity.
      await this.makeApiRequest<AnthropicMessagesResponse>('/v1/messages', 'POST', {
        model: this.defaultModelId || 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      });
      return { isHealthy: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Health check failed';
      return { isHealthy: false, details: { message, error } };
    }
  }

  /** @inheritdoc */
  public async shutdown(): Promise<void> {
    // Stops the recheck timer, waits for the probes in flight (each under the probe timeout), then writes the keys' standing.
    await this.keyPool?.close();
    this.isInitialized = false;
    console.log('AnthropicProvider shutdown complete.');
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  /**
   * Guard that throws if the provider has not been initialized.
   * @private
   * @throws {AnthropicProviderError} If not initialized.
   */
  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new AnthropicProviderError(
        'AnthropicProvider is not initialized. Call initialize() first.',
        'PROVIDER_NOT_INITIALIZED',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Payload construction
  // -------------------------------------------------------------------------

  /**
   * Builds the Anthropic Messages API request payload from IProvider inputs.
   *
   * The key transformation is extracting system-role messages from the
   * conversation array and placing their content into the top-level `system`
   * field, since Anthropic does not accept system as a message role.
   *
   * @param {string} modelId - Target model.
   * @param {ChatMessage[]} messages - Conversation messages.
   * @param {ModelCompletionOptions} options - Completion options.
   * @param {boolean} stream - Whether to request streaming.
   * @returns {Record<string, unknown>} The request body for Anthropic's API.
   * @private
   */
  private buildRequestPayload(
    modelId: string,
    messages: ChatMessage[],
    options: ModelCompletionOptions,
    stream: boolean,
  ): Record<string, unknown> {
    // --- Extract system messages into content blocks ---
    // Anthropic treats system as a top-level field, not a conversation role.
    // When cache_control markers are present on content parts, emit system
    // as an array of content blocks (required for Anthropic prompt caching).
    type SystemBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral'; ttl?: '5m' | '1h' } };
    const systemBlocks: SystemBlock[] = [];
    const conversationMessages: ChatMessage[] = [];
    // Index one past the last block contributed by the FIRST system message
    // that produced any blocks — i.e. the caller's primary system prompt.
    // Consumed by the thinking-mode auto-cache below so the pinned
    // breakpoint covers only the primary system, never hook-appended
    // per-turn system context (e.g. memory recall).
    let firstSystemMsgBlockEnd = 0;

    for (const msg of messages) {
      if (msg.role === 'system') {
        const blocksBefore = systemBlocks.length;
        if (typeof msg.content === 'string') {
          if (msg.content) systemBlocks.push({ type: 'text', text: msg.content });
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content as MessageContentPart[]) {
            if (part.type === 'text') {
              const block: SystemBlock = { type: 'text', text: (part as { text: string }).text };
              if ((part as any).cache_control) {
                block.cache_control = (part as any).cache_control;
              }
              systemBlocks.push(block);
            }
          }
        }
        if (firstSystemMsgBlockEnd === 0 && systemBlocks.length > blocksBefore) {
          firstSystemMsgBlockEnd = systemBlocks.length;
        }
      } else {
        conversationMessages.push(msg);
      }
    }

    // --- Convert remaining messages to Anthropic format ---
    // Prior-turn thinking handling is MODEL-DYNAMIC, mirroring what the
    // server does (see model-cache-capabilities.ts):
    //
    //  - Retaining models (Opus 4.5+, Sonnet 4.6+, Fable/Mythos): thinking
    //    blocks from previous assistant turns are kept in context by the
    //    server, participate in prompt caching, and are billed only when
    //    shown — so they are passed back VERBATIM. The previous
    //    unconditional client-side strip mutated the prior assistant turn's
    //    bytes on EVERY agent-loop step, invalidating every previously
    //    written cache entry: measured on prod 2026-07-06 as the full
    //    history re-WRITTEN at the 1.25x cache-write premium every step and
    //    read back never (create/read = 1.51; cache reads matched the
    //    system prefix alone). Verbatim replay keeps older history
    //    byte-stable so each step reads the prefix cached by the one before.
    //
    //  - Non-retaining models (older Opus/Sonnet, ALL Haiku): the server
    //    strips prior thinking from context BEFORE caching, so client-side
    //    stripping is cache-neutral there and saves the wire bytes — keep
    //    the legacy strip for them.
    //
    // Env override (emergency use): AGENTOS_ANTHROPIC_STRIP_PRIOR_THINKING
    // =1/true forces the strip everywhere; =0/false forces verbatim replay
    // everywhere; unset -> per-model behavior above.
    const stripEnv = process.env.AGENTOS_ANTHROPIC_STRIP_PRIOR_THINKING;
    const stripPriorThinking =
      stripEnv === '1' || stripEnv === 'true'
        ? true
        : stripEnv === '0' || stripEnv === 'false'
          ? false
          : !resolveCacheCapabilities(modelId).retainsPriorThinkingInContext;
    let lastAssistantIdx = -1;
    for (let i = 0; i < conversationMessages.length; i++) {
      if (conversationMessages[i].role === 'assistant') lastAssistantIdx = i;
    }
    const anthropicMessages = conversationMessages.map((msg, i) =>
      this.toAnthropicMessage(
        stripPriorThinking && msg.role === 'assistant' && i !== lastAssistantIdx && msg.thinkingBlocks
          ? { ...msg, thinkingBlocks: undefined }
          : msg,
      ),
    );

    // --- Per-call cache opt-out: options.cache === false (region strip) ---
    // Strip caller-placed markers from the system and message regions BEFORE
    // payload assembly, so system falls back to the joined-string emission
    // and the auto-cache gate below stands down entirely. Markers that ride
    // in via customModelParams (raw tools, request-level cache_control) are
    // cleared at the gate itself. One switch, zero cache_control on the
    // wire — the hard guarantee a true one-shot needs: a cache write there
    // is pure premium (1.25x/2x), never read back.
    if (options.cache === false) {
      for (const b of systemBlocks) delete b.cache_control;
      for (const msg of anthropicMessages) {
        const content = msg.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (block && typeof block === 'object') {
            delete (block as Record<string, unknown>).cache_control;
          }
        }
      }
    }

    const payload: Record<string, unknown> = {
      model: modelId,
      // max_tokens is REQUIRED by Anthropic — enforce a sane default
      // Clamp to the model's real output ceiling so an escalated truncation-retry
      // (max_tokens → 64000) is reshaped to the model's limit instead of 400ing.
      max_tokens: clampAnthropicMaxTokens(
        modelId,
        options.maxTokens ?? this.config.defaultMaxTokens ?? 4096,
      ),
      messages: anthropicMessages,
      stream,
    };

    // Emit system as content block array when cache markers are present,
    // otherwise fall back to joined string for backward compatibility.
    if (systemBlocks.length > 0) {
      const hasCacheMarkers = systemBlocks.some(b => b.cache_control);
      payload.system = hasCacheMarkers
        ? systemBlocks
        : systemBlocks.map(b => b.text).join('\n\n');
    }

    // --- Optional parameters ---
    // Guard temperature behind modelSupportsTemperature: Opus 4.7 (and
    // future reasoning-first Claude models) reject it with HTTP 400.
    // Older models still accept it. See modelSupportsTemperature() above.
    if (
      options.temperature !== undefined &&
      modelSupportsTemperature(modelId)
    ) {
      payload.temperature = options.temperature;
    }
    // top_p is rejected by the same reasoning-default family that rejects
    // temperature (Opus 4.7/4.8, Fable 5) with HTTP 400. Gate it on the same
    // predicate so a caller passing topP without a thinking budget — the path
    // that otherwise skips the thinking-reconciliation drop below — doesn't
    // 400 the request.
    if (options.topP !== undefined && modelSupportsTemperature(modelId)) {
      payload.top_p = options.topP;
    }
    if (options.stopSequences?.length) payload.stop_sequences = options.stopSequences;

    // --- Extended thinking (reasoning-default Claude models) ---
    // When a caller passes a thinking budget and the model supports it
    // (Opus 4.7/4.8), send the adaptive `thinking` block — the only form
    // this family accepts ({type:'enabled', budget_tokens} returns 400).
    // The family also rejects temperature/top_p, so drop both.
    // resolveThinkingPayload returns null for non-thinking models or
    // when no budget is set, leaving the request untouched.
    const thinkingResolved = resolveThinkingPayload(
      modelId,
      options.thinking,
      payload.max_tokens as number,
    );
    if (thinkingResolved) {
      payload.thinking = thinkingResolved.thinking;
      payload.max_tokens = thinkingResolved.maxTokens;
      delete payload.temperature;
      delete payload.top_p;
    }

    // --- Thinking off (options.thinking === false) ---
    // Leaving the field out keeps the model's default, which is thinking ON
    // for Opus 5 and Sonnet 5+, so turning it off takes the model's own
    // shape. Some models accept that shape only at effort high or below; the
    // effort block below caps it there.
    let thinkingOffEffortCap: 'high' | undefined;
    if (!thinkingResolved && options.thinking === false) {
      const off = resolveThinkingOff(modelId);
      if (off.kind === 'send') {
        payload.thinking = off.thinking;
        thinkingOffEffortCap = off.maxEffort;
      } else if (off.kind === 'always_on') {
        warnOnce(
          `thinking-always-on:${modelId}`,
          `[agentos] AnthropicProvider: thinking cannot be turned off on ${modelId}; the request runs ` +
            `with adaptive thinking. Lower options.effort to reduce it.`,
        );
      }
    }

    // --- Effort (output_config.effort) ---
    // Reasoning depth + token-spend control on effort-capable Claude models
    // (Opus 4.5+/Sonnet 4.6/Fable/Mythos). Independent of thinking + tool_choice
    // — it rides on output_config. Dropped on unsupported models or invalid
    // values, and lowered to a level the model takes, so an out-of-range
    // effort never returns 400 (see resolveAnthropicEffort).
    let effort = resolveAnthropicEffort(modelId, options.effort);
    if (thinkingOffEffortCap && (effort === 'xhigh' || effort === 'max')) {
      warnOnce(
        `thinking-off-effort:${modelId}`,
        `[agentos] AnthropicProvider: ${modelId} turns thinking off only at effort ` +
          `${thinkingOffEffortCap} or below; sending effort '${thinkingOffEffortCap}' ` +
          `instead of '${effort}'.`,
      );
      effort = thinkingOffEffortCap;
    }
    if (effort) {
      const oc = (payload.output_config as Record<string, unknown> | undefined) ?? {};
      payload.output_config = { ...oc, effort };
    }

    // --- Cache diagnostics (beta cache-diagnosis-2026-04-07) ---
    // Opt-in observability: the API compares this request against the one
    // referenced by previous_message_id and reports where the prompt prefix
    // diverged (cache_miss_reason on the response). `null` opts in on the
    // first turn with nothing to compare. The matching beta header is added
    // by betaHeaders() keyed off this payload field. Best-effort by API
    // contract — diagnostics never block or fail the request.
    if (options.cacheDiagnostics !== undefined) {
      payload.diagnostics = {
        previous_message_id: options.cacheDiagnostics.previousMessageId,
      };
    }

    // --- Tool definitions ---
    const tools = this.convertToolDefs(options.tools);
    if (tools.length > 0) {
      payload.tools = tools;
      // Map toolChoice to Anthropic's format
      if (options.toolChoice) {
        payload.tool_choice = this.convertToolChoice(options.toolChoice);
      }
    }


    // --- Schema-driven structured output ---
    // The marker from structuredOutputFormat.ts carries one object schema under
    // `tool.input_schema`. anthropicSchemaRoute decides, for the model going on
    // the wire (a passthrough `model` included, so it runs after the passthrough
    // below) and that schema, which surface carries it; the builder ran the same
    // function on the same object for the model it was built for. The payload
    // then has its say, once the passthrough has run:
    //
    //   json_schema  `output_config.format` with the schema, merged over a
    //                passthrough `output_config` (an effort, say) rather than
    //                wiped by it. No tool and no tool_choice for the schema; a
    //                direct caller's tools stay, since the format works beside
    //                tools, and the format's parameter limits are counted with
    //                their strict schemas. The model answers JSON in its text
    //                block. A request that enables citations leaves this route
    //                (the API refuses the pair) for the forced tool, which
    //                rides beside citations, or the prompt where it cannot.
    //   forced_tool  A model without the JSON output format, or a schema the
    //                format cannot carry (a record, an untyped node, a $ref or
    //                oneOf, more union-typed or optional properties than it
    //                takes), on a model that accepts a forced tool_choice: one
    //                tool whose input_schema is the schema, with tool_choice
    //                forced on it; the answer is the tool call's input. The
    //                caller's tools are dropped as before (mixing them needs a
    //                multi-turn protocol the session path does not speak).
    //                Never strict: a schema strict mode carries takes the format
    //                on every model with strict tool use, and beside citations,
    //                which refuse structured outputs, the tool goes out plain.
    //                Never clamped: a payload that turns thinking on takes the
    //                prompt instead, and so do a passthrough `tools` that
    //                replaces the tool and a passthrough `tool_choice` that
    //                does not force it.
    //   none         Neither carries the schema. The schema goes into the
    //                prompt itself, as a system block after the caller's, with
    //                one warning per model and reason, so a direct caller still
    //                gets the shape asked for; every completion and stream
    //                chunk of the request says `schemaInPayload: false`.
    //
    // Every completion and stream chunk of a schema request names the route it
    // took (`schemaRoute`), so a completion gateway lifts the answer from where
    // this request put it, not from where the marker's builder expected it.
    const sf = options.responseFormat as
      | { _agentosUseToolForStructuredOutput?: boolean; tool?: { name: string; input_schema: Record<string, unknown> } }
      | undefined;
    const schemaMarker = sf?._agentosUseToolForStructuredOutput && sf.tool ? sf.tool : undefined;

    // Pass through any custom model params — minus OpenRouter's routing
    // controls and Gemini's request fields, which only those vendors' bodies
    // accept (a fallback leg reuses the same params object across hosts; see
    // openrouter-only-params).
    //
    // This runs BEFORE the forced tool_choice reconciliation below so that a
    // `tool_choice` injected through customModelParams is reconciled too —
    // otherwise it merges in after the clamp and can send the forbidden
    // thinking + forced-tool combination (or a Fable-rejected forced tool),
    // which Anthropic 400s on.
    // Track whether the passthrough replaced whole payload regions: the
    // auto-cache block below must never restructure a region it no longer
    // owns — mutating the stale pre-override locals would clobber the
    // caller's system override, and a tail marker written into the stale
    // message array never reaches the wire.
    let customSystemOverride = false;
    let customMessagesOverride = false;
    let customToolsOverride = false;
    let customToolChoiceOverride = false;
    {
      const passthrough = stripForeignVendorParams(options.customModelParams);
      if (passthrough) {
        customSystemOverride = Object.prototype.hasOwnProperty.call(passthrough, 'system');
        customMessagesOverride = Object.prototype.hasOwnProperty.call(passthrough, 'messages');
        customToolsOverride = Object.prototype.hasOwnProperty.call(passthrough, 'tools');
        customToolChoiceOverride = Object.prototype.hasOwnProperty.call(passthrough, 'tool_choice');
        Object.assign(payload, passthrough);
      }
    }
    // The model on the wire: a passthrough `model` replaces the one given, and
    // the schema route, the forced-choice clamp and the warnings follow it.
    const wireModelId = typeof payload.model === 'string' && payload.model ? payload.model : modelId;

    // The JSON output format and the prompt-only schema block, after the
    // passthrough: the passthrough assigns whole top-level keys, so a format
    // set before it under `output_config` would be wiped by a passthrough
    // `output_config`, and a schema block appended to `system` before it would
    // be lost to a passthrough `system`. The messages read here for citations
    // are the ones going on the wire, a passthrough `messages` included.
    if (schemaMarker) {
      // The format's union-typed and optional parameter limits are the
      // request's: a strict tool beside it counts toward them (only a
      // passthrough `tools` array carries one).
      let schemaRoute: AnthropicSchemaRoute = anthropicSchemaRoute(
        wireModelId,
        schemaMarker.input_schema,
        strictToolInputSchemas(payload.tools),
      );
      // Why the request takes the prompt route, when the payload rather than
      // the model and the schema sent it there.
      let promptOnlyReason: string | undefined;
      if (messagesEnableCitations(payload.messages)) {
        // Citations and the JSON output format answer 400 together, so a
        // passthrough format goes (the rest of output_config stays), and the
        // format route gives way to the non-strict forced tool, which rides
        // beside citations (live-probed 2026-10-19 on claude-sonnet-4-6, 200
        // with a tool_use stop), or to the prompt on a model that refuses a
        // forced choice.
        dropOutputConfigFormat(payload);
        if (schemaRoute === 'json_schema') {
          schemaRoute = modelSupportsForcedToolChoice(wireModelId) ? 'forced_tool' : 'none';
          if (schemaRoute === 'none') {
            promptOnlyReason =
              'the request enables citations, which the JSON output format refuses, and the model refuses a forced tool choice';
          }
        }
      }
      if (schemaRoute === 'forced_tool' && payloadThinkingActive(payload)) {
        // A forced choice cannot ride with thinking on, and the clamp below
        // would send the schema tool under `auto` with no guarantee: the
        // prompt is the honest route.
        schemaRoute = 'none';
        promptOnlyReason = 'thinking is on, and a forced tool choice cannot be sent beside it';
      }
      if (schemaRoute === 'forced_tool' && customToolsOverride && !toolsInclude(payload.tools, schemaMarker.name)) {
        // A passthrough `tools` array keeps precedence; forcing a tool it does
        // not hold would answer 400.
        schemaRoute = 'none';
        promptOnlyReason = 'a passthrough tools array replaces the schema tool';
      }
      if (
        schemaRoute === 'forced_tool' &&
        customToolChoiceOverride &&
        !toolChoiceForcesSchemaTool(payload.tool_choice, customToolsOverride ? payload.tools : undefined, schemaMarker.name)
      ) {
        // A passthrough `tool_choice` keeps precedence too; one that does not
        // force the schema tool (`auto`, `none`, another tool's name) leaves
        // the call to the model, which may answer in prose, so the schema
        // rides the prompt rather than a tool the model need not call.
        schemaRoute = 'none';
        promptOnlyReason = 'a passthrough tool_choice does not force the schema tool';
      }
      schemaRouteOfPayload.set(payload, schemaRoute);

      if (schemaRoute === 'json_schema') {
        const existing = payload.output_config;
        payload.output_config = {
          ...(existing && typeof existing === 'object' && !Array.isArray(existing)
            ? (existing as Record<string, unknown>)
            : {}),
          format: { type: 'json_schema', schema: anthropicJsonOutputSchema(schemaMarker.input_schema) },
        };
      } else if (schemaRoute === 'forced_tool') {
        // The non-strict forced schema tool. A passthrough `tool_choice` keeps
        // precedence, as it did when the schema tool was set before the
        // passthrough; a passthrough `tools` array that holds the schema tool
        // is sent as given.
        if (!customToolsOverride) payload.tools = [{ name: schemaMarker.name, input_schema: schemaMarker.input_schema }];
        if (!customToolChoiceOverride) payload.tool_choice = { type: 'tool', name: schemaMarker.name };
      } else {
        const reason =
          promptOnlyReason ??
          (!modelSupportsJsonOutputs(wireModelId)
            ? 'the model has neither the JSON output format nor a forced tool choice'
            : 'the schema is outside the limits of the JSON output format (a record, a $ref or oneOf, an untyped node, ' +
              'or more union-typed or optional properties than it takes, a strict tool beside it counted), and the model ' +
              'refuses a forced tool choice');
        const text = schemaPromptText(schemaMarker.input_schema);
        if (customSystemOverride) {
          appendSchemaSystemBlock(payload, text);
        } else {
          // The provider's own system blocks take the schema block, so the
          // auto-cache below, which re-emits them as a block array to place
          // its marker, sends it too.
          systemBlocks.push({ type: 'text', text });
          payload.system = systemBlocks.some((b) => b.cache_control)
            ? systemBlocks
            : systemBlocks.map((b) => b.text).join('\n\n');
        }
        warnOnce(
          `structured-output-prompt-only:${wireModelId}:${reason}`,
          `[agentos] AnthropicProvider: structured output for '${schemaMarker.name}' on model ${wireModelId} rides the ` +
            `prompt alone: ${reason}. The schema was added to the system prompt; the caller's schema validates the answer.`,
        );
      }
      if (
        schemaRoute !== 'forced_tool' &&
        payload.tool_choice !== undefined &&
        !(Array.isArray(payload.tools) && payload.tools.length > 0)
      ) {
        // The format and prompt routes send no schema tool, so a passthrough
        // tool_choice can be left with no tool on the wire; a choice with
        // nothing to choose from says nothing, and it goes.
        delete payload.tool_choice;
      }
    }

    // --- Forced tool_choice reconciliation ---
    // A FORCED tool_choice ({type:'any'} or {type:'tool'}) is incompatible with
    // two situations, and Anthropic 400s on either:
    //   (1) extended thinking is active — "Thinking may not be enabled when
    //       tool_choice forces tool use." Thinking + {type:'auto'} IS allowed.
    //   (2) the model rejects forced tool use outright — Claude Fable:
    //       "tool_choice forces tool use is not compatible with this model."
    // In both cases clamp to 'auto' (the only supported form) rather than
    // letting the request 400. The model still chooses tools on 'auto' —
    // strongest with prescriptive tool descriptions — but forced tool use is no
    // longer guaranteed. Centralizing this means no caller has to special-case
    // the thinking or Fable quirks. Catches the convertToolChoice path AND a
    // tool_choice injected via customModelParams (which is why this runs after
    // the passthrough above). The structured-output forced tool never reaches
    // it: the schema route above sends the schema in the prompt where thinking
    // is on or the model refuses a forced choice, rather than a clamped tool.
    {
      const tc = payload.tool_choice as { type?: string } | undefined;
      if (tc && (tc.type === 'any' || tc.type === 'tool')) {
        // Only a thinking-on shape conflicts with a forced tool_choice; the
        // off shapes (disabled, between_tools) do not.
        const thinkingType = (payload.thinking as { type?: string } | undefined)?.type;
        const thinkingActive = thinkingType === 'adaptive' || thinkingType === 'enabled';
        const modelRejectsForced = !modelSupportsForcedToolChoice(wireModelId);
        if (thinkingActive || modelRejectsForced) {
          const reason = thinkingActive
            ? 'extended thinking is incompatible with a forced tool_choice'
            : `model ${wireModelId} rejects a forced tool_choice`;
          console.warn(
            `[agentos] AnthropicProvider: ${reason} (type='${tc.type}'); clamping to ` +
              `'auto' for model ${wireModelId}. The model decides whether to call a tool — ` +
              `forced tool use is not guaranteed.`,
          );
          payload.tool_choice = { type: 'auto' };
        }
      }
    }

    // --- Automatic prompt caching ---
    // A request-level `cache_control` is a real Anthropic feature: the API
    // auto-places a moving cache breakpoint on the last cacheable block,
    // covering tools + system + messages in cache order. Verified empirically
    // (2026-06): a request carrying a top-level `{type:'ephemeral'}` writes the
    // cache and reads it back on the next identical request within the TTL.
    // Per-turn pipelines and agent loops that re-send a stable prefix get cache
    // reads (0.1x input price) with zero caller changes.
    //
    // Caller-placed breakpoints are composed with, not cancelled by, the auto
    // path — but per REGION:
    //
    //  - SYSTEM markers (e.g. a `cacheBreakpoint` from generateText /
    //    generateObject, possibly with a non-default 1h TTL): the caller owns
    //    the system region — never restructure it or add markers there. The
    //    auto moving TAIL on the final message is still pinned, with or
    //    without thinking: in agent loops and multi-turn chats the growing
    //    history lives in the provider-facing message array the caller never
    //    sees, so this layer is the only one that can mark it. Full
    //    stand-down here left that history permanently uncached — measured
    //    2026-07-05 on the thinking path at 15M+ full-price prompt tokens/day
    //    (avg 16-19K uncached tokens/step) while marker-free calls on the
    //    same image collapsed to ~2 uncached tokens/step; the non-thinking
    //    stand-down had the identical shape on streamed conversation turns
    //    (system prefix cached, every turn's history re-billed at full input
    //    price). A caller 1h system TTL alongside a 5-min moving tail is
    //    valid API usage (stable prefix long TTL, moving tail short TTL).
    //
    //  - MESSAGE markers: the caller owns the whole messages region — the auto
    //    tail stands down entirely.
    //
    // Per-call control (ModelCompletionOptions.cache):
    //
    //  - `cache: false` — zero cache_control on the wire for this request:
    //    the region strip above already cleared caller system/message
    //    markers, and the block below clears customModelParams-injected
    //    tools/request markers + stands the auto path down. For true
    //    one-shots (unique-suffix judges, single-call enrichment) where a
    //    write can never be read back.
    //  - `cache: { ttl: '1h' }` — the auto markers (system-end + moving
    //    tail) carry `ttl: '1h'` and are placed as explicit block markers so
    //    the TTL reaches the wire. For loops whose step gaps exceed the
    //    5-minute default TTL (codegen tool calls run 2-14 min; human
    //    think-time between conversation turns regularly exceeds 5m).
    //
    // Process-global kill switch (single-shot batch processes):
    // AGENTOS_ANTHROPIC_AUTO_CACHE=0 — disables the auto path only; caller
    // markers still pass through there (use `cache: false` for a per-call
    // hard-off including caller markers).
    const autoCacheEnv = process.env.AGENTOS_ANTHROPIC_AUTO_CACHE;
    if (options.cache === false) {
      // customModelParams passthrough ran above and may have injected ANY
      // marked region — raw tools, a request-level cache_control, or even a
      // wholesale system/messages override. Sanitize all of them so the
      // opt-out holds regardless of how a marker arrived. Regions are
      // rebuilt as copies (never mutated in place): after the spread these
      // may be the caller's own customModelParams objects.
      delete payload.cache_control;
      const stripBlockMarkers = (value: unknown): unknown =>
        Array.isArray(value)
          ? value.map((block) => {
              if (!block || typeof block !== 'object') return block;
              const { cache_control: _stripped, ...rest } = block as Record<string, unknown>;
              return rest;
            })
          : value;
      payload.system = stripBlockMarkers(payload.system);
      if (payload.system === undefined) delete payload.system;
      if (Array.isArray(payload.messages)) {
        payload.messages = (payload.messages as Array<Record<string, unknown>>).map((message) => {
          if (!message || typeof message !== 'object') return message;
          const copy = { ...message };
          copy.content = stripBlockMarkers(copy.content);
          return copy;
        });
      }
      if (Array.isArray(payload.tools)) {
        payload.tools = stripBlockMarkers(payload.tools);
      }
    } else if (
      autoCacheEnv !== '0'
      && autoCacheEnv !== 'false'
      && payload.cache_control === undefined
      // Model-dynamic: stand the AUTO path down for ids without Anthropic
      // prompt caching (a non-claude id routed here by a proxy config).
      // Explicit caller markers above still pass through untouched.
      && resolveCacheCapabilities(modelId).supportsPromptCaching
    ) {
      if (customSystemOverride || customMessagesOverride) {
        // customModelParams replaced payload.system/messages wholesale, so
        // the locals below (systemBlocks / anthropicMessages and their
        // marker counts) describe regions that are no longer on the wire.
        // Never restructure here. Count markers on the ACTUAL payload:
        // any marker means the caller owns the wire (full stand-down);
        // none means the request-level auto marker — valid on any payload
        // shape — keeps the pre-override caching behavior.
        const overrideMarkers =
          this.countWireBlockMarkers(payload.system) +
          this.countMessageCacheMarkers(
            Array.isArray(payload.messages)
              ? (payload.messages as Array<Record<string, unknown>>)
              : [],
          ) +
          this.countWireBlockMarkers(payload.tools);
        if (overrideMarkers === 0) {
          payload.cache_control = { type: 'ephemeral' };
        }
        return payload;
      }
      const explicitBreakpoints = systemBlocks.filter(b => b.cache_control).length;
      const messageBreakpoints = this.countMessageCacheMarkers(anthropicMessages);
      // Tool definitions can carry their own cache_control (tool-use prompt
      // caching), and those markers count against Anthropic's hard
      // 4-breakpoint-per-request cap. Fold them into the accounting so a
      // request with e.g. 3 marked system blocks + 1 marked tool (4, at the
      // cap) does not get a 5th tail marker here and 400. agentos does not
      // emit marked tools today (adaptTools adds none, and a customModelParams
      // tools override is raw), so toolBreakpoints is 0 for every current
      // caller — this is forward-safety, not a behavior change. Any caller
      // that DOES mark tools also stands the auto path down entirely (below),
      // matching the caller-owns-the-region philosophy.
      const toolBreakpoints = Array.isArray(payload.tools)
        ? (payload.tools as Array<{ cache_control?: unknown }>).filter(
            (t) => t && typeof t === 'object' && (t as { cache_control?: unknown }).cache_control,
          ).length
        : 0;
      // Per-call TTL for the AUTO-placed markers only (caller markers keep
      // their own TTLs). '1h' writes at 2x instead of 1.25x, so it is opt-in
      // per call site — worth it exactly when step gaps exceed the 5m TTL.
      const autoTtl: '1h' | undefined =
        options.cache && options.cache.ttl === '1h' ? '1h' : undefined;
      if (explicitBreakpoints === 0 && messageBreakpoints === 0 && toolBreakpoints === 0) {
        if (payload.thinking !== undefined || autoTtl !== undefined) {
          // Two reasons to use explicit block-level breakpoints instead of
          // the request-level auto marker:
          //
          //  - Extended thinking: the request-level auto marker measurably
          //    produces ZERO cache creation on thinking-enabled calls
          //    (2026-07: 900+ agent-loop calls, ~12M prompt tokens/day,
          //    0.000 hit rate).
          //  - A per-call TTL (`cache: { ttl: '1h' }`): the TTL is a
          //    block-level attribute, so honoring it requires explicit
          //    placement. Opt-in only — callers without a TTL keep the
          //    request-level marker exactly as before.
          //
          // Placement:
          //
          //  1. On the last block of the FIRST system message — the
          //     primary system prompt precedes the thinking-bearing
          //     messages so it caches normally, and hook-appended
          //     per-turn system context (memory recall) stays outside
          //     the cached prefix. System is re-emitted as a block
          //     array so the marker reaches the wire.
          //  2. On the last cacheable block of the FINAL message — the
          //     moving multi-turn breakpoint. Agent loops re-send the
          //     whole growing history every step; without this each
          //     step re-pays it at full input price. Prior-turn thinking
          //     blocks are passed back verbatim (see the preservation
          //     note above the message conversion), so older history is
          //     byte-stable between calls and each step reads the prefix
          //     cached by the previous one, writing only the fresh tail.
          //
          // Two breakpoints total, under the API cap of 4.
          let placed = false;
          if (firstSystemMsgBlockEnd > 0) {
            systemBlocks[firstSystemMsgBlockEnd - 1].cache_control = {
              type: 'ephemeral',
              ...(autoTtl ? { ttl: autoTtl } : {}),
            };
            payload.system = systemBlocks;
            placed = true;
          }
          if (this.markLastCacheableMessageBlock(anthropicMessages, autoTtl)) {
            placed = true;
          }
          if (!placed) {
            // Degenerate request (no system, no markable message block):
            // fall back to the top-level marker rather than sending
            // nothing at all.
            payload.cache_control = { type: 'ephemeral' };
          }
        } else {
          payload.cache_control = { type: 'ephemeral' };
        }
      } else if (
        messageBreakpoints === 0 &&
        explicitBreakpoints > 0 &&
        explicitBreakpoints + toolBreakpoints < 4
      ) {
        // Caller marked the system prefix only: keep their placement
        // verbatim and pin just the moving message tail (the API cap is 4
        // breakpoints per request — the tail adds one, so require headroom
        // across ALL wire markers, tools included).
        // Applies on thinking AND non-thinking requests alike — the streamed
        // conversation surfaces (caller-marked system, no thinking) were the
        // last shape whose per-turn history went permanently uncached.
        //
        // TTL ordering (Anthropic hard rule): every 1h marker must precede
        // every 5m marker in cache order (tools → system → messages), or
        // the request 400s. A 1h moving tail therefore requires the
        // caller's system markers to be 1h too — `cache: { ttl: '1h' }`
        // declares the whole call's pacing, so RAISE shorter/unset system
        // marker TTLs to 1h (a codegen call's 5m-marked system + 1h tail
        // was the rejected shape). Marked tools are raw caller objects we
        // never mutate — with one present the tail falls back to the 5m
        // default instead, keeping the order valid.
        let tailTtl = autoTtl;
        if (autoTtl === '1h') {
          if (toolBreakpoints > 0) {
            tailTtl = undefined;
          } else {
            for (const block of systemBlocks) {
              if (block.cache_control && block.cache_control.ttl !== '1h') {
                block.cache_control = { ...block.cache_control, ttl: '1h' };
              }
            }
          }
        }
        this.markLastCacheableMessageBlock(anthropicMessages, tailTtl);
      }
    }

    return payload;
  }

  /**
   * Count `cache_control` markers on a raw wire-shaped block array (a
   * customModelParams `system` or `tools` override). Non-arrays (joined
   * string systems, absent regions) count zero. Used by the override
   * stand-down in the auto-cache block: with an override on the wire the
   * pre-override locals cannot be trusted, so marker ownership is decided
   * from the actual payload regions.
   *
   * @param value - The payload region as it will hit the wire.
   * @returns Number of blocks carrying a `cache_control` marker.
   * @private
   */
  private countWireBlockMarkers(value: unknown): number {
    if (!Array.isArray(value)) return 0;
    let count = 0;
    for (const block of value) {
      if (block && typeof block === 'object' && (block as Record<string, unknown>).cache_control) {
        count += 1;
      }
    }
    return count;
  }

  /**
   * Count caller-placed `cache_control` markers across message content blocks.
   * Used to decide whether the caller owns the messages region (auto tail
   * stands down) or only the system region (auto tail still composes).
   *
   * @param anthropicMessages - Messages already converted to Anthropic wire format.
   * @returns Number of content blocks carrying a `cache_control` marker.
   * @private
   */
  private countMessageCacheMarkers(
    anthropicMessages: Array<Record<string, unknown>>,
  ): number {
    let count = 0;
    for (const msg of anthropicMessages) {
      const content = msg.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block && typeof block === 'object' && (block as Record<string, unknown>).cache_control) {
          count++;
        }
      }
    }
    return count;
  }

  /**
   * Pin an ephemeral cache breakpoint on the last cacheable content block of
   * the final message, converting a plain-string content to a single text
   * block when needed so the marker can reach the wire.
   *
   * Only the FINAL message is considered — in agent loops that is always the
   * newest user / tool_result turn, which is exactly where the moving
   * multi-turn breakpoint belongs. Thinking / redacted_thinking blocks cannot
   * carry `cache_control` and are skipped.
   *
   * @param anthropicMessages - Messages already converted to Anthropic wire format.
   * @param ttl - Optional non-default TTL for the marker (per-call
   *   `cache: { ttl: '1h' }`); omitted = the 5-minute default.
   * @returns True when a marker was placed.
   * @private
   */
  private markLastCacheableMessageBlock(
    anthropicMessages: Array<Record<string, unknown>>,
    ttl?: '1h',
  ): boolean {
    const marker = ttl
      ? { type: 'ephemeral' as const, ttl }
      : { type: 'ephemeral' as const };
    if (anthropicMessages.length === 0) return false;
    const last = anthropicMessages[anthropicMessages.length - 1];
    const content = last.content;
    if (typeof content === 'string') {
      if (!content) return false;
      last.content = [
        { type: 'text', text: content, cache_control: { ...marker } },
      ];
      return true;
    }
    if (Array.isArray(content)) {
      const CACHEABLE = new Set(['text', 'image', 'tool_use', 'tool_result', 'document', 'search_result']);
      for (let i = content.length - 1; i >= 0; i--) {
        const block = content[i] as Record<string, unknown>;
        if (block && typeof block === 'object' && CACHEABLE.has(block.type as string)) {
          block.cache_control = { ...marker };
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Converts a single ChatMessage to Anthropic's message format.
   *
   * Handles three cases:
   * 1. Assistant messages with tool_calls → content blocks with tool_use entries
   * 2. Tool-role messages → content blocks with tool_result entries
   * 3. Standard user/assistant text or multimodal messages
   *
   * @param {ChatMessage} msg - The source message.
   * @returns {Record<string, unknown>} Anthropic-formatted message.
   * @private
   */
  private toAnthropicMessage(msg: ChatMessage): Record<string, unknown> {
    // --- Assistant with tool_calls ---
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      const content: AnthropicContentBlock[] = [];
      // Thinking blocks MUST come first — Anthropic requires the assistant
      // turn's reasoning (verbatim, signatures intact) to precede its text and
      // tool_use blocks when extended thinking is in play.
      for (const tb of msg.thinkingBlocks ?? []) {
        content.push(
          tb.type === 'thinking'
            ? { type: 'thinking', thinking: tb.thinking, signature: tb.signature }
            : { type: 'redacted_thinking', data: tb.data },
        );
      }
      // Include any text content next
      if (typeof msg.content === 'string' && msg.content) {
        content.push({ type: 'text', text: msg.content });
      }
      // Add tool_use blocks
      for (const tc of msg.tool_calls) {
        let parsedInput: Record<string, unknown>;
        try {
          parsedInput = typeof tc.function.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : (tc.function.arguments as unknown as Record<string, unknown>) ?? {};
        } catch {
          parsedInput = {};
        }
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: parsedInput,
        });
      }
      return { role: 'assistant', content };
    }

    // --- Tool result messages ---
    if (msg.role === 'tool') {
      const resultContent = typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content ?? '');
      return {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: msg.tool_call_id ?? 'unknown',
          content: resultContent,
        }],
      };
    }

    // --- Assistant text turn that carries thinking ---
    // A session transcript records a final answer's signed thinking; it
    // replays verbatim ahead of the answer's content, like a tool turn's.
    // The content converts exactly as it would without thinking, so text
    // parts keep their cache_control breakpoints. For models that do not
    // retain prior thinking, the caller strips it from every assistant turn
    // but the last one before this runs.
    if (msg.role === 'assistant' && msg.thinkingBlocks?.length) {
      const rest = this.toAnthropicMessage({ ...msg, thinkingBlocks: undefined });
      const restContent = rest.content;
      const blocks: Array<Record<string, unknown>> = Array.isArray(restContent)
        ? (restContent as Array<Record<string, unknown>>)
        : typeof restContent === 'string' && restContent
          ? [{ type: 'text', text: restContent }]
          : [];
      // An answer with no content keeps the plain shape: Anthropic rejects an
      // assistant turn that holds only thinking.
      if (blocks.length === 0) return rest;
      const thinking = msg.thinkingBlocks.map((tb) =>
        tb.type === 'thinking'
          ? { type: 'thinking', thinking: tb.thinking, signature: tb.signature }
          : { type: 'redacted_thinking', data: tb.data },
      );
      return { role: 'assistant', content: [...thinking, ...blocks] };
    }

    // --- Multimodal content (vision) ---
    if (Array.isArray(msg.content)) {
      const anthropicContent: Array<Record<string, unknown>> = [];
      for (const part of msg.content as MessageContentPart[]) {
        if (part.type === 'text') {
          const block: Record<string, unknown> = { type: 'text', text: (part as { text: string }).text };
          // Preserve caller-placed cache breakpoints (shared-prefix /
          // varying-suffix pattern) — rebuilding the block without them
          // silently un-caches the caller's marked prefix.
          const cc = (part as { cache_control?: unknown }).cache_control;
          if (cc) block.cache_control = cc;
          anthropicContent.push(block);
        } else if (part.type === 'image_url') {
          const url = (part as { image_url: { url: string } }).image_url.url;
          // Extract base64 data from data: URLs
          const dataMatch = url.match(/^data:(image\/\w+);base64,(.+)$/);
          if (dataMatch) {
            anthropicContent.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: dataMatch[1],
                data: dataMatch[2],
              },
            });
          } else {
            // For external URLs, Anthropic supports URL source type
            anthropicContent.push({
              type: 'image',
              source: { type: 'url', url },
            });
          }
        }
      }
      return { role: msg.role, content: anthropicContent };
    }

    // --- Simple text ---
    return {
      role: msg.role,
      content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? ''),
    };
  }

  /**
   * Converts OpenAI-style tool definitions to Anthropic's format.
   *
   * OpenAI uses `{ type: 'function', function: { name, description, parameters } }`
   * while Anthropic uses `{ name, description, input_schema }`.
   *
   * @param {Array<Record<string, unknown>>} [tools] - OpenAI-formatted tool defs.
   * @returns {AnthropicToolDef[]} Anthropic-formatted tool definitions.
   * @private
   */
  private convertToolDefs(tools?: Array<Record<string, unknown>>): AnthropicToolDef[] {
    if (!tools || tools.length === 0) return [];
    return tools.map(tool => {
      // OpenAI format: { type: 'function', function: { name, description, parameters } }
      const fn = (tool as any)?.function;
      if (fn?.name) {
        return {
          name: fn.name as string,
          description: (fn.description ?? '') as string,
          // Anthropic calls it input_schema, OpenAI calls it parameters
          input_schema: fn.parameters ?? { type: 'object' },
        };
      }
      // AgentOS ITool format: { name, description, inputSchema }
      return {
        name: (tool as any).name ?? 'unknown',
        description: (tool as any).description ?? '',
        input_schema: (tool as any).inputSchema ?? (tool as any).parameters ?? { type: 'object' },
      };
    });
  }

  /**
   * Converts an OpenAI-style toolChoice value to Anthropic's tool_choice format.
   *
   * @param {string | Record<string, unknown>} choice - OpenAI tool choice.
   * @returns {Record<string, unknown>} Anthropic tool_choice value.
   * @private
   */
  private convertToolChoice(choice: string | Record<string, unknown>): Record<string, unknown> {
    if (typeof choice === 'string') {
      // "auto" → { type: "auto" }, "none" → { type: "auto" } (no direct "none" in Anthropic),
      // "required" → { type: "any" }
      if (choice === 'required') return { type: 'any' };
      return { type: 'auto' };
    }
    // Object form: { type: "function", function: { name: "..." } } → { type: "tool", name: "..." }
    const fn = (choice as any)?.function;
    if (fn?.name) {
      return { type: 'tool', name: fn.name };
    }
    return { type: 'auto' };
  }

  // -------------------------------------------------------------------------
  // Response mapping
  // -------------------------------------------------------------------------

  /**
   * Maps a non-streaming Anthropic Messages response to IProvider format.
   *
   * Extracts text content, tool_use blocks, and usage metrics, then normalizes
   * the stop reason from Anthropic's vocabulary to IProvider conventions.
   *
   * @param {AnthropicMessagesResponse} apiResponse - Raw Anthropic response.
   * @param structuredOutputName - Name of the forced structured-output tool,
   *   whose input becomes the message content.
   * @param requestedModelId - The model the request named. Prices the call
   *   when the response carries no model echo.
   * @returns {ModelCompletionResponse} Normalized completion response.
   * @throws {AnthropicProviderError} With code `content_filter` when the model
   *   refused (`stop_reason: 'refusal'`), whether or not it wrote any output
   *   first.
   * @private
   */
  private mapResponseToCompletion(
    apiResponse: AnthropicMessagesResponse,
    structuredOutputName?: string,
    requestedModelId?: string,
  ): ModelCompletionResponse {
    const pricedModelId = apiResponse.model || requestedModelId || '';

    // Collect text content
    const textParts = apiResponse.content
      .filter(block => block.type === 'text' && block.text)
      .map(block => block.text!);
    let fullText = textParts.join('');

    const usage: ModelUsage = {
      promptTokens: apiResponse.usage.input_tokens,
      completionTokens: apiResponse.usage.output_tokens,
      totalTokens: apiResponse.usage.input_tokens + apiResponse.usage.output_tokens,
      costUSD: estimateAnthropicCostUSD(pricedModelId, apiResponse.usage),
      cacheCreationInputTokens: apiResponse.usage.cache_creation_input_tokens,
      cacheReadInputTokens: apiResponse.usage.cache_read_input_tokens,
      // Anthropic's input_tokens EXCLUDES cache reads/writes; the
      // provider-independent inclusive input total adds them back
      // (OpenAI/OpenRouter report prompt_tokens already inclusive).
      inclusiveInputTokens:
        apiResponse.usage.input_tokens
        + (apiResponse.usage.cache_read_input_tokens ?? 0)
        + (apiResponse.usage.cache_creation_input_tokens ?? 0),
    };

    // A refused turn is discarded whole, even when the model wrote text or
    // tool_use blocks before refusing, so it never reaches tool-call mapping
    // and the caller can never run a tool from it.
    if (apiResponse.stop_reason === 'refusal') {
      throw this.refusalError(pricedModelId, apiResponse.stop_details, fullText, usage);
    }

    // Schema-driven structured output: when the request forced the schema
    // tool, the matching tool_use block is the answer. Its input becomes the
    // message's JSON text, which keeps result.text uniform with OpenAI's
    // json_schema response for callers that read result.text directly, and
    // the block leaves the tool calls: a tool loop (generateText's) would
    // otherwise run it as a tool it does not have and ask the model again.
    // A call the output limit stopped keeps the `length` stop below, so
    // generateObject raises the budget when its JSON does not parse or
    // validate; one cut mid-JSON arrives here as a text block holding its raw
    // input (accumulateMessagesStream), which is then the answer's text.
    const schemaToolBlock = structuredOutputName
      ? apiResponse.content.find(
          b => b.type === 'tool_use' && b.name === structuredOutputName && b.input !== undefined,
        )
      : undefined;
    if (schemaToolBlock) {
      fullText = JSON.stringify(schemaToolBlock.input);
    }

    // Collect the other tool_use blocks and convert to OpenAI-style tool_calls
    const toolCalls = apiResponse.content
      .filter(block => block.type === 'tool_use' && block !== schemaToolBlock)
      .map(block => ({
        id: block.id!,
        type: 'function' as const,
        function: {
          name: block.name!,
          arguments: JSON.stringify(block.input ?? {}),
        },
      }));

    // Collect extended-thinking blocks (Opus 4.7/4.8 with thinking enabled).
    // Captured so the agent loop can replay them verbatim on the next tool
    // turn — Anthropic requires it. Empty on every non-thinking response, so
    // the assistant message below carries no `thinkingBlocks` field then.
    const thinkingBlocks = apiResponse.content.flatMap((block): ThinkingBlock[] => {
      if (
        block.type === 'thinking' &&
        typeof block.thinking === 'string' &&
        typeof block.signature === 'string'
      ) {
        return [{ type: 'thinking', thinking: block.thinking, signature: block.signature }];
      }
      if (block.type === 'redacted_thinking' && typeof block.data === 'string') {
        return [{ type: 'redacted_thinking', data: block.data }];
      }
      return [];
    });

    const hasToolCalls = toolCalls.length > 0;
    // A tool_use stop whose only call was the schema answer finished the answer.
    const finishReason =
      schemaToolBlock && !hasToolCalls && apiResponse.stop_reason === 'tool_use'
        ? 'stop'
        : this.mapStopReason(apiResponse.stop_reason);

    const choice: ModelCompletionChoice = {
      index: 0,
      message: {
        role: 'assistant',
        content: fullText || null,
        ...(hasToolCalls && { tool_calls: toolCalls }),
        ...(thinkingBlocks.length > 0 && { thinkingBlocks }),
      },
      finishReason,
    };

    return {
      id: apiResponse.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      modelId: apiResponse.model,
      choices: [choice],
      usage,
      ...(apiResponse.diagnostics !== undefined && {
        cacheDiagnostics: normalizeCacheDiagnostics(apiResponse.diagnostics),
      }),
    };
  }

  /**
   * Maps Anthropic stop reasons to IProvider-convention finish reasons.
   *
   * - `end_turn` → `"stop"` (natural completion)
   * - `tool_use` → `"tool_calls"` (model wants to invoke tools)
   * - `max_tokens` → `"length"` (hit token limit)
   * - `model_context_window_exceeded` → `"length"` (output cut off at the
   *   context window)
   * - `stop_sequence` → `"stop"` (hit a caller-specified stop sequence)
   * - `refusal` → `"content_filter"`, the name GeminiProvider and
   *   OpenAIProvider use. Both response paths raise a refusal as an error
   *   before a finish reason is reported; the mapping keeps the vocabulary
   *   complete.
   * - anything else (such as `pause_turn`) passes through unchanged.
   *
   * @param {string | null} stopReason - Anthropic's stop_reason value.
   * @returns {string} Normalized finish reason.
   * @private
   */
  private mapStopReason(stopReason: string | null): string {
    switch (stopReason) {
      case 'end_turn': return 'stop';
      case 'tool_use': return 'tool_calls';
      case 'max_tokens': return 'length';
      case 'model_context_window_exceeded': return 'length';
      case 'stop_sequence': return 'stop';
      case 'refusal': return 'content_filter';
      default: return stopReason ?? 'stop';
    }
  }

  /**
   * The error a refused turn raises. Code `content_filter` is what
   * `isContentPolicyRefusal` recognizes, so the generateText and streamText
   * fallback chains act on it, and the provider-health registry does not
   * count it as a provider failure. The message carries no HTTP status or
   * rate-limit wording, which retry classifiers grep for.
   *
   * @param modelId Model that refused.
   * @param stopDetails The response's `stop_details`, kept verbatim.
   * @param partialText Text the model wrote before refusing, discarded as an
   *   answer but kept for diagnostics.
   * @param usage Tokens the refused call consumed.
   * @returns An error with code `content_filter` and Anthropic error type
   *   `refusal`.
   * @private
   */
  private refusalError(
    modelId: string,
    stopDetails: AnthropicStopDetails | null | undefined,
    partialText: string,
    usage: ModelUsage,
  ): AnthropicProviderError {
    const category = stopDetails?.category;
    return new AnthropicProviderError(
      `Claude declined the request on ${modelId || 'the requested model'} (stop_reason refusal${
        category ? `, category ${category}` : ''
      }).`,
      'content_filter',
      undefined,
      'refusal',
      { stopReason: 'refusal', stopDetails: stopDetails ?? null, partialText, usage },
    );
  }

  /**
   * Assembles completed tool calls from the streaming accumulator.
   *
   * @param {Map<number, { id: string; name: string; argsJson: string }>} accum - Tool call accumulators.
   * @returns {NonNullable<ChatMessage['tool_calls']>} Assembled tool calls array.
   * @private
   */
  private assembleToolCalls(
    accum: Map<number, { id: string; name: string; argsJson: string }>,
  ): NonNullable<ChatMessage['tool_calls']> {
    if (accum.size === 0) return [];
    return Array.from(accum.values()).map(tc => ({
      id: tc.id,
      type: 'function' as const,
      function: {
        name: tc.name,
        arguments: tc.argsJson || '{}',
      },
    }));
  }

  /**
   * Builds an abort chunk for early stream termination.
   *
   * @param {string} modelId - The model ID for the response.
   * @returns {ModelCompletionResponse} A terminal chunk with abort error.
   * @private
   */
  private buildAbortChunk(modelId: string): ModelCompletionResponse {
    return {
      id: `anthropic-abort-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      modelId,
      choices: [],
      error: { message: 'Stream aborted by caller', type: 'abort' },
      isFinal: true,
    };
  }

  // -------------------------------------------------------------------------
  // Key pool: probes and the all-keys-failed error
  // -------------------------------------------------------------------------

  /**
   * Probes a key the pool took out of rotation (the pool calls this off the
   * request path): an auth failure with the cheapest authenticated read, a
   * billing failure with the smallest billable request, since a models list
   * can answer 200 with no credit left. The answer goes through the same
   * classifier as a request's.
   */
  private async probeKey(apiKey: string, kind: KeyFailureKind | undefined): Promise<ProbeResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const headers = { ...this.buildHeaders(apiKey), 'Content-Type': 'application/json' };
      const response =
        kind === 'billing'
          ? await fetch(`${this.config.baseURL}/v1/messages`, {
              method: 'POST',
              headers,
              body: JSON.stringify({ model: this.defaultModelId || 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
              signal: controller.signal,
            })
          : await fetch(`${this.config.baseURL}/v1/models?limit=1`, { method: 'GET', headers, signal: controller.signal });
      if (response.ok) return 'ok';
      const text = typeof response.text === 'function' ? await response.text().catch(() => '') : '';
      return classifyKeyFailure(response.status, text) ?? 'unknown';
    } catch {
      return 'unknown';
    } finally {
      clearTimeout(timer);
    }
  }

  /** The error thrown when every key of the pool is out: no credential is sent again until one returns. */
  private allKeysFailedError(message?: string, httpStatus?: number, errorType?: string): AnthropicProviderError {
    const kinds = Array.from(
      new Set((this.keyPool?.snapshot() ?? []).map((state) => state.kind).filter((kind): kind is KeyFailureKind => kind !== undefined)),
    );
    const retryAfter = this.keyPool?.soonestReturnMs();
    return new AnthropicProviderError(
      message ?? `Every Anthropic API key is out of rotation (${kinds.join(', ') || 'unknown'}).`,
      'ALL_KEYS_FAILED',
      httpStatus ?? statusOfKinds(kinds),
      errorType,
      { kinds, ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}) },
    );
  }

  // -------------------------------------------------------------------------
  // HTTP transport
  // -------------------------------------------------------------------------

  /**
   * Makes a non-streaming API request to Anthropic's API with retry logic.
   *
   * Uses the `x-api-key` header (Anthropic's auth mechanism) and the required
   * `anthropic-version` header for API versioning.
   *
   * @template T The expected response type.
   * @param {string} endpoint - API endpoint path (e.g., "/v1/messages").
   * @param {'POST'} method - HTTP method (Anthropic Messages API is POST-only).
   * @param {Record<string, unknown>} body - Request body.
   * @param {number} [requestTimeoutOverride] - Per-call timeout in ms, over the configured default.
   * @param {AbortSignal} [abortSignal] - Caller's signal. It aborts the fetch in flight, and once
   *   it has fired no further attempt is sent.
   * @returns {Promise<T>} Parsed JSON response.
   * @throws {AnthropicProviderError} On authentication, validation, rate-limit, or network errors;
   *   `REQUEST_ABORTED` when the caller's signal ends the request.
   * @private
   */
  private async makeApiRequest<T>(
    endpoint: string,
    method: 'POST',
    body: Record<string, unknown>,
    requestTimeoutOverride?: number,
    abortSignal?: AbortSignal,
  ): Promise<T> {
    const url = `${this.config.baseURL}${endpoint}`;

    // Per-call request-timeout override. Large-output callers (e.g. codegen
    // structured-output that emits long TSX) pass a longer requestTimeout so
    // they don't abort mid-generation, WITHOUT raising the global default —
    // chat / narrator traffic keeps the fast failover.
    const effRequestTimeout =
      typeof requestTimeoutOverride === 'number' && requestTimeoutOverride > 0
        ? requestTimeoutOverride
        : this.config.requestTimeout!;

    let lastError: Error = new AnthropicProviderError(
      'Request failed after all retries.',
      'MAX_RETRIES_REACHED',
    );

    // Key hops this request has made: a key-scoped failure moves to the next
    // usable key at once (at most one hop per key) without spending a transient
    // attempt; the attempt counter bounds the 429, 5xx and network retries.
    let keyHops = 0;
    for (let attempt = 0; attempt < this.config.maxRetries!; attempt++) {
      if (abortSignal?.aborted) {
        throw new AnthropicProviderError('Request aborted by caller.', 'REQUEST_ABORTED');
      }
      // Rotate the key per attempt so a retry after a 429 fails over to a
      // different key from the pool instead of hammering the throttled one.
      const apiKey = await this.drawApiKey(abortSignal);
      if (abortSignal?.aborted) {
        throw new AnthropicProviderError('Request aborted by caller.', 'REQUEST_ABORTED');
      }
      if (apiKey === '') throw this.allKeysFailedError();
      const attemptStartedAt = Date.now();
      const headers = this.buildHeaders(apiKey);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), effRequestTimeout);

      try {
        // Hard JS timeout race over the abort-signal fetch: undici can leave a
        // keep-alive "zombie" socket where the AbortController fires but the
        // promise never settles. `connection: close` discourages reuse; the
        // race guarantees the await resolves within requestTimeout + 500ms.
        const fetchPromise = fetch(url, {
          method,
          headers: { ...headers, ...this.betaHeaders(body), 'Content-Type': 'application/json', connection: 'close' },
          body: JSON.stringify(body),
          // The caller's signal aborts this attempt's fetch as the timer does.
          signal: abortSignal ? AbortSignal.any([controller.signal, abortSignal]) : controller.signal,
        });
        let hardTimeoutId: ReturnType<typeof setTimeout> | null = null;
        const hardTimeoutPromise = new Promise<never>((_, rej) => {
          hardTimeoutId = setTimeout(() => {
            controller.abort();
            rej(
              new AnthropicProviderError(
                `Hard JS timeout after ${effRequestTimeout + 500}ms (includes 500ms buffer over abort-signal timeout — undici keep-alive zombie).`,
                'REQUEST_HARD_TIMEOUT',
              ),
            );
          }, effRequestTimeout + 500);
        });
        const response = await Promise.race([fetchPromise, hardTimeoutPromise]);
        if (hardTimeoutId) clearTimeout(hardTimeoutId);
        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({})) as Partial<AnthropicAPIError>;
          const errorMessage = errorData.error?.message || `HTTP ${response.status}: ${response.statusText}`;
          const errorType = errorData.error?.type;
          this.logStrictSchemaRejection(body, response.status, errorMessage);

          // A key-scoped failure (a bad or revoked key, an unpaid account, a
          // throttle) takes this key out of rotation and moves to the next
          // usable key at once; the hop spends no transient attempt.
          const keyFailure = classifyKeyFailure(response.status, JSON.stringify(errorData));
          const serverRetryAfterMs = retryAfterMs(response.headers.get('retry-after'), undefined, this.config.keyPool?.maxRetryAfterMs);
          if (keyFailure && this.keyPool && this.keyPool.size > 1) {
            this.keyPool.markFailed(apiKey, keyFailure, {
              status: response.status,
              at: attemptStartedAt,
              ...(serverRetryAfterMs !== null ? { retryAfterMs: serverRetryAfterMs } : {}),
            });
            lastError = new AnthropicProviderError(errorMessage, keyFailure === 'quota' ? 'RATE_LIMIT_EXCEEDED' : 'API_CLIENT_ERROR', response.status, errorType, errorData);
            if (this.keyPool.usable() > 0 && ++keyHops < this.keyPool.size) {
              attempt -= 1;
              continue;
            }
            if (this.keyPool.usable() === 0 && keyFailure !== 'quota') {
              throw this.allKeysFailedError(errorMessage, response.status, errorType);
            }
          }

          // Non-retryable client errors
          if (response.status === 401 || response.status === 403 || response.status === 400 || response.status === 404) {
            throw new AnthropicProviderError(errorMessage, 'API_CLIENT_ERROR', response.status, errorType, errorData);
          }

          // Rate limit: the key rests (quota cooldown) so the next attempt
          // draws another when one is usable, then respect Retry-After.
          if (response.status === 429) {
            lastError = new AnthropicProviderError(errorMessage, 'RATE_LIMIT_EXCEEDED', 429, errorType, errorData);
            if (!(this.keyPool && this.keyPool.size > 1)) this.keyPool?.markExhausted(apiKey);
            // Retry-After is authoritative when present; otherwise jittered backoff.
            const waitMs = serverRetryAfterMs ?? computeRetryBackoffMs(attempt);
            await new Promise(resolve => setTimeout(resolve, waitMs));
            continue;
          }

          // Retryable server errors (5xx)
          if (response.status >= 500) {
            lastError = new AnthropicProviderError(errorMessage, 'API_SERVER_ERROR', response.status, errorType, errorData);
            await new Promise(resolve => setTimeout(resolve, computeRetryBackoffMs(attempt)));
            continue;
          }

          throw new AnthropicProviderError(errorMessage, 'API_REQUEST_FAILED', response.status, errorType, errorData);
        }

        this.keyPool?.markSuccess(apiKey, attemptStartedAt);

        // The race above bounds only the connection + response headers; the
        // body then streams in via `response.json()`. With no bound here, a
        // provider that sends headers and stalls mid-body (or a large body
        // that never finishes arriving) hangs this read indefinitely — the
        // non-streaming sibling of an SSE stall, and the cause of the
        // multi-minute codegen tool wedge observed 2026-06-05 (32K-token TSX
        // generations). Bound the body read on the same deadline and abort the
        // socket so a stalled body fails fast and retries, honoring this
        // method's documented "resolves within requestTimeout" guarantee.
        let bodyTimeoutId: ReturnType<typeof setTimeout> | null = null;
        try {
          return (await Promise.race([
            response.json() as Promise<T>,
            new Promise<never>((_, rej) => {
              bodyTimeoutId = setTimeout(() => {
                controller.abort();
                rej(
                  new AnthropicProviderError(
                    `Response body read timed out after ${effRequestTimeout}ms (provider sent headers then stalled mid-body).`,
                    'REQUEST_HARD_TIMEOUT',
                  ),
                );
              }, effRequestTimeout);
            }),
          ]));
        } finally {
          if (bodyTimeoutId) clearTimeout(bodyTimeoutId);
        }
      } catch (error: unknown) {
        clearTimeout(timeoutId);
        // A caller abort ends the request here; it is not a timeout to retry.
        if (abortSignal?.aborted) {
          throw new AnthropicProviderError('Request aborted by caller.', 'REQUEST_ABORTED');
        }
        if (error instanceof AnthropicProviderError) {
          if (error.code === 'API_CLIENT_ERROR' || error.code === 'ALL_KEYS_FAILED') throw error;
          lastError = error;
        } else if (error instanceof Error && error.name === 'AbortError') {
          lastError = new AnthropicProviderError(
            `Request timed out after ${effRequestTimeout}ms.`,
            'REQUEST_TIMEOUT',
          );
        } else {
          // fetch names the URL (credentials included) when it rejects one,
          // and quotes a header value it rejects, which carries the key.
          lastError = new AnthropicProviderError(
            redactUrlSecrets(
              error instanceof Error ? error.message : 'Network or unknown error',
              this.config.baseURL,
              [apiKey],
            ),
            'NETWORK_ERROR',
          );
        }

        if (attempt === this.config.maxRetries! - 1) break;
        const delay = computeRetryBackoffMs(attempt);
        console.warn(`[AnthropicProvider] Retry ${attempt + 1}/${this.config.maxRetries! - 1} in ${(delay / 1000).toFixed(1)}s`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    throw lastError;
  }

  /**
   * Makes a streaming API request and returns the raw ReadableStream.
   *
   * @param {string} endpoint - API endpoint.
   * @param {Record<string, unknown>} body - Request body (must include `stream: true`).
   * @param {number} [requestTimeoutOverride] - Per-call connection timeout in ms, over the configured default.
   * @param {AbortSignal} [abortSignal] - Caller's signal. It aborts the request in flight, the
   *   returned body's reads included.
   * @returns {Promise<ReadableStream<Uint8Array>>} The response body stream.
   * @throws {AnthropicProviderError} On connection errors; `REQUEST_ABORTED` when the caller's
   *   signal ends the request before the body is returned.
   * @private
   */
  private async makeStreamRequest(
    endpoint: string,
    body: Record<string, unknown>,
    requestTimeoutOverride?: number,
    abortSignal?: AbortSignal,
    attemptOut?: { apiKey?: string; startedAt?: number },
  ): Promise<ReadableStream<Uint8Array>> {
    const url = `${this.config.baseURL}${endpoint}`;
    const apiKey = await this.drawApiKey(abortSignal);
    if (abortSignal?.aborted) {
      throw new AnthropicProviderError('Request aborted by caller.', 'REQUEST_ABORTED');
    }
    if (apiKey === '') throw this.allKeysFailedError();
    const startedAt = Date.now();
    if (attemptOut) {
      attemptOut.apiKey = apiKey;
      attemptOut.startedAt = startedAt;
    }
    const headers = this.buildHeaders(apiKey);

    // Bounds the CONNECTION phase only (request + response headers) — it is
    // cleared the moment headers arrive. Mid-body stalls are the idle
    // watchdog's job (streamIdleTimeoutMs in parseSseStream), so a caller's
    // generous per-call override here cannot extend how long a dead
    // connection sits silent once streaming has begun.
    const connectionTimeout =
      typeof requestTimeoutOverride === 'number' && requestTimeoutOverride > 0
        ? requestTimeoutOverride
        : this.config.requestTimeout;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), connectionTimeout);

    try {
      // Hard JS timeout race over the abort-signal fetch: undici can leave a
      // keep-alive "zombie" socket where the AbortController fires but the
      // fetch promise never settles. Same guard as makeApiRequest — the race
      // guarantees the await ends even when the signal is ignored.
      const fetchPromise = fetch(url, {
        method: 'POST',
        headers: { ...headers, ...this.betaHeaders(body), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        // The caller's signal aborts the request as the connection timer does,
        // and the body's reads after the headers have arrived.
        signal: abortSignal ? AbortSignal.any([controller.signal, abortSignal]) : controller.signal,
      });
      let hardTimeoutId: ReturnType<typeof setTimeout> | null = null;
      const hardTimeout = new Promise<never>((_, reject) => {
        hardTimeoutId = setTimeout(() => {
          reject(
            new AnthropicProviderError(
              `Hard JS timeout after ${connectionTimeout! + 500}ms (includes 500ms buffer over abort-signal timeout — undici keep-alive zombie).`,
              'STREAM_CONNECTION_FAILED',
            ),
          );
        }, connectionTimeout! + 500);
      });
      let response: Response;
      try {
        response = await Promise.race([fetchPromise, hardTimeout]);
      } finally {
        if (hardTimeoutId) clearTimeout(hardTimeoutId);
      }
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({})) as Partial<AnthropicAPIError>;
        const errorMessage = errorData.error?.message || `HTTP ${response.status}: ${response.statusText}`;
        this.logStrictSchemaRejection(body, response.status, errorMessage);
        // A key-scoped failure takes this key out so the next stream or
        // request draws another; the retry loops read `keyFailure` on the
        // error to hop keys at once. The server's Retry-After rides on the
        // error (in seconds) so the stream retry loop can honor it.
        const serverRetryAfterMs = retryAfterMs(response.headers.get('retry-after'), undefined, this.config.keyPool?.maxRetryAfterMs);
        const keyFailure = classifyKeyFailure(response.status, JSON.stringify(errorData));
        if (keyFailure) {
          this.keyPool?.markFailed(apiKey, keyFailure, {
            status: response.status,
            at: startedAt,
            ...(serverRetryAfterMs !== null ? { retryAfterMs: serverRetryAfterMs } : {}),
          });
        }
        const retryAfterSec = serverRetryAfterMs !== null ? Math.ceil(serverRetryAfterMs / 1000) : NaN;
        const keyDetails: KeyFailureDetails = {
          ...(Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? { retryAfterSec } : {}),
          ...(keyFailure ? { keyFailure, keyUsable: this.keyPool ? this.keyPool.usable() : 1, keyCount: this.keyPool?.size ?? 1 } : {}),
        };
        throw new AnthropicProviderError(
          errorMessage,
          'STREAM_CONNECTION_FAILED',
          response.status,
          errorData.error?.type,
          { ...errorData, ...keyDetails },
        );
      }

      if (!response.body) {
        throw new AnthropicProviderError(
          'Expected a stream response but body was null.',
          'STREAM_BODY_NULL',
        );
      }

      return response.body;
    } catch (error: unknown) {
      clearTimeout(timeoutId);
      if (abortSignal?.aborted) {
        throw new AnthropicProviderError('Request aborted by caller.', 'REQUEST_ABORTED');
      }
      if (error instanceof AnthropicProviderError) throw error;
      // Masked like makeApiRequest's network failures: fetch's rejection
      // can name a credential-bearing base URL or quote the key header.
      throw new AnthropicProviderError(
        redactUrlSecrets(
          error instanceof Error ? error.message : 'Failed to connect to Anthropic stream.',
          this.config.baseURL,
          [apiKey],
        ),
        'STREAM_CONNECTION_FAILED',
      );
    }
  }

  /**
   * Builds the common headers for all Anthropic API requests.
   *
   * Includes the `x-api-key` authentication header and the required
   * `anthropic-version` header that pins the API behavior.
   *
   * @returns {Record<string, string>} Request headers.
   * @private
   */
  /**
   * Resolve the next API key. With a multi-key pool this is the pool's
   * strategy, which skips keys resting after a 429 or taken out; with a single
   * key it returns that key. Call this once PER ATTEMPT (not once per
   * request) so a retry after a 429 fails over to a different key rather
   * than reusing the throttled one. When no key is usable while a probe of a
   * failed key is in flight (its recheck came due), it waits for that probe,
   * bounded by the pool's probe timeout, and draws again, so the first request
   * after a recheck is served by a key that came back; the caller's signal
   * ends that wait at once, and the request then reports the abort.
   */
  private async drawApiKey(abortSignal?: AbortSignal): Promise<string> {
    return this.keyPool?.hasKeys ? this.keyPool.nextAfterProbes(abortSignal) : this.config.apiKey;
  }

  private buildHeaders(apiKey: string): Record<string, string> {
    return {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'User-Agent': 'AgentOS/1.0 (AnthropicProvider)',
    };
  }

  /**
   * The `anthropic-beta` header for every beta this request actually uses,
   * comma-joined per the API convention. Currently:
   *
   * - `interleaved-thinking-2025-05-14` — when the request enables extended
   *   thinking outbound (`thinking` in the body) or replays captured thinking
   *   blocks from a prior assistant turn.
   * - `cache-diagnosis-2026-04-07` — when the body carries a `diagnostics`
   *   field (see {@link ModelCompletionOptions.cacheDiagnostics}); the header
   *   must ride EVERY diagnosed turn or the next turn's lookup fails with
   *   `previous_message_not_found`.
   * - `structured-outputs-2025-11-13` — when any tool definition in the body
   *   carries `strict: true` (the forced structured-output tool on
   *   strict-capable models; see modelSupportsStrictToolUse).
   *
   * Empty when no beta applies, so plain traffic is byte-for-byte unchanged.
   */
  private betaHeaders(body: Record<string, unknown>): Record<string, string> {
    const betas: string[] = [];
    if (this.payloadUsesThinking(body)) betas.push('interleaved-thinking-2025-05-14');
    if (body.diagnostics !== undefined) betas.push('cache-diagnosis-2026-04-07');
    if (this.payloadUsesStrictTools(body)) betas.push('structured-outputs-2025-11-13');
    return betas.length > 0 ? { 'anthropic-beta': betas.join(',') } : {};
  }

  /** True when any tool definition in the request carries `strict: true`. */
  private payloadUsesStrictTools(body: Record<string, unknown>): boolean {
    const tools = body.tools;
    return (
      Array.isArray(tools) &&
      tools.some(
        t => t != null && typeof t === 'object' && (t as { strict?: unknown }).strict === true,
      )
    );
  }

  /**
   * Strict-schema rejection tripwire (2026-07-07): when a 4xx response
   * carries the structured-outputs validator's schema rejection — the
   * `additionalProperties` form (root-caused: absent keys, fixed by the
   * stamped copy in 0.9.116) or the constraint-keyword form (`property
   * '<kw>' is not supported`, mapped + stripped in 0.9.117) — dump the
   * outbound tool schemas + `anthropic-beta` header + strict-stamp verdict
   * so any future recurrence is a one-log root-cause instead of another
   * inference chain. WARN once per request — these 4xx paths do not retry.
   * Tool schemas are not secret; user message content never appears here.
   */
  private logStrictSchemaRejection(
    body: Record<string, unknown>,
    status: number,
    message: string,
  ): void {
    if (status < 400 || status >= 500) return;
    // Every structured-outputs strict-schema rejection is prefixed
    // `tools.N.custom:` — the additionalProperties form (0.9.116), the
    // constraint-keyword form (`property '<kw>' is not supported`, 0.9.117),
    // AND the empty-schema form (`Empty schema ({}) … is not supported`,
    // found 2026-07-08). Match the umbrella prefix so the tripwire catches
    // the whole class, present and future, instead of a hand-maintained
    // message list that already missed the empty-schema case.
    // The JSON output format's rejections are prefixed `output_config.format`
    // (`output_config.format.schema: For 'array' type, 'minItems' values other
    // than 0 or 1 are not supported`, live-probed 2026-10-19), the same class
    // of schema rejection on the route every current model takes.
    const strictRejection =
      /tools\.\d+\.custom:/.test(message) ||
      /output_config\.format/.test(message) ||
      message.includes('additionalProperties');
    if (!strictRejection) return;
    try {
      console.warn(
        '[AnthropicProvider] strict-schema 4xx diagnostic',
        JSON.stringify({
          event: 'anthropic_strict_schema_rejection',
          status,
          modelId: typeof body.model === 'string' ? body.model : String(body.model ?? ''),
          betaHeader: this.betaHeaders(body)['anthropic-beta'] ?? '',
          payloadUsesStrictTools: this.payloadUsesStrictTools(body),
          message: message.slice(0, 300),
          tools: body.tools ?? [],
          outputConfigFormat: (body.output_config as { format?: unknown } | undefined)?.format ?? null,
        }),
      );
    } catch {
      /* diagnostics must never break the request path */
    }
  }

  /**
   * True when the request enables extended thinking or replays thinking
   * blocks. `{ type: 'disabled' }` turns thinking off; `between_tools` still
   * returns thinking blocks between tool calls, so it counts.
   */
  private payloadUsesThinking(body: Record<string, unknown>): boolean {
    const thinkingType = (body.thinking as { type?: unknown } | null | undefined)?.type;
    if (body.thinking != null && thinkingType !== 'disabled') return true;
    const messages = body.messages;
    if (!Array.isArray(messages)) return false;
    return messages.some(m => {
      const content = (m as { content?: unknown }).content;
      return (
        Array.isArray(content) &&
        content.some(
          b =>
            b != null &&
            typeof b === 'object' &&
            ((b as { type?: unknown }).type === 'thinking' ||
              (b as { type?: unknown }).type === 'redacted_thinking'),
        )
      );
    });
  }

  // -------------------------------------------------------------------------
  // SSE parsing
  // -------------------------------------------------------------------------

  /**
   * Parses an SSE (Server-Sent Events) stream from Anthropic.
   *
   * Anthropic SSE events follow the format:
   * ```
   * event: <event_type>
   * data: <json_payload>
   * ```
   *
   * This parser extracts the `data:` line content for each event and yields
   * the raw JSON strings for the caller to parse and dispatch.
   *
   * @param {ReadableStream<Uint8Array>} stream - The raw SSE byte stream.
   * @returns {AsyncGenerator<string>} Yields JSON string payloads.
   * @private
   */
  private async *parseSseStream(
    stream: ReadableStream<Uint8Array>,
  ): AsyncGenerator<string, void, undefined> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Stream-idle watchdog. `reader.read()` has no built-in deadline, and
    // `makeStreamRequest` clears its connection timeout the moment response
    // headers arrive — so a provider that sends headers then stalls mid-body
    // leaves this loop awaiting a chunk that never comes, hanging until the
    // CALLER's outer timeout fires (observed: a 25-min orchestrator stall at
    // iterations:0, 2026-06-05). Bound each read: if no chunk arrives within
    // streamIdleTimeoutMs, abort and throw STREAM_IDLE_TIMEOUT so the caller
    // can retry or fail fast instead of hanging.
    const streamIdleTimeoutMs =
      this.config.streamIdleTimeoutMs ?? this.config.requestTimeout ?? 90_000;

    try {
      while (true) {
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        const readResult = (await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            idleTimer = setTimeout(
              () =>
                reject(
                  new AnthropicProviderError(
                    `Stream idle: no data received for ${streamIdleTimeoutMs}ms (provider stalled mid-stream).`,
                    'STREAM_IDLE_TIMEOUT',
                  ),
                ),
              streamIdleTimeoutMs,
            );
          }),
        ]).finally(() => {
          if (idleTimer) clearTimeout(idleTimer);
        })) as ReadableStreamReadResult<Uint8Array>;
        const { done, value } = readResult;
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by double newlines
        let eolIndex;
        while ((eolIndex = buffer.indexOf('\n\n')) >= 0) {
          const messageBlock = buffer.substring(0, eolIndex);
          buffer = buffer.substring(eolIndex + 2);

          // Extract data: lines from the event block
          const lines = messageBlock.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const dataContent = line.substring('data: '.length).trim();
              if (dataContent) yield dataContent;
            }
          }
        }
      }

      // Process any trailing content in the buffer
      if (buffer.trim()) {
        const lines = buffer.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataContent = line.substring('data: '.length).trim();
            if (dataContent) yield dataContent;
          }
        }
      }
    } catch (error: unknown) {
      // Preserve a typed provider error (e.g. STREAM_IDLE_TIMEOUT) so the
      // caller can distinguish a mid-stream stall from a generic parse failure
      // and decide whether to retry, instead of mislabeling it.
      if (error instanceof AnthropicProviderError) throw error;
      const message = error instanceof Error ? error.message : 'SSE stream parsing error';
      console.error('AnthropicProvider: Error reading SSE stream:', message);
      throw new AnthropicProviderError(message, 'STREAM_PARSING_ERROR');
    } finally {
      // Ensure the reader is released
      try { await reader.cancel(); } catch { /* swallow cleanup errors */ }
    }
  }
}
