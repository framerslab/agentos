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
} from '../IProvider';
import { AnthropicProviderError } from '../errors/AnthropicProviderError';
import { ApiKeyPool } from '../../../providers/ApiKeyPool.js';
import { resolveThinkingPayload } from '../model-thinking.js';
import { modelSupportsForcedToolChoice } from '../model-forced-tool-choice.js';
import { modelSupportsEffort, isEffortLevel } from '../model-effort.js';
import { computeRetryBackoffMs } from './retry-backoff.js';
import { recordCacheUsage } from './cacheLeakDetector.js';
import { resolveCacheCapabilities } from '../model-cache-capabilities.js';

// Re-export so callers that already reach for Anthropic model-capability
// predicates (modelSupportsTemperature lives here too) find this one next to
// it, even though its source of truth is the pure model-forced-tool-choice
// module.
export { modelSupportsForcedToolChoice };

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration specific to the AnthropicProvider.
 *
 * @example
 * const config: AnthropicProviderConfig = {
 *   apiKey: process.env.ANTHROPIC_API_KEY!,
 *   defaultModelId: 'claude-sonnet-4-20250514',
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
   * @example "claude-sonnet-4-20250514"
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
}

// ---------------------------------------------------------------------------
// Model capability helpers
// ---------------------------------------------------------------------------

/**
 * Whether the given Claude model id accepts the `temperature` parameter.
 *
 * Anthropic deprecated `temperature` on reasoning-default models. Opus 4.7,
 * Opus 4.8, Sonnet 5, and Fable 5 (extended-thinking by default) reject requests
 * that include it with HTTP 400 "`temperature` is deprecated for this model."
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
  // Claude Opus 4.7 / 4.8, Sonnet 5, Fable 5, and any dated variant — reasoning-default
  // models that reject `temperature` (and `top_p` / `top_k`). Future
  // reasoning-first siblings get added here as Anthropic releases them, in
  // lockstep with modelSupportsThinking.
  return !/^claude-(opus-4-(7|8)|sonnet-5|fable-5)\b/i.test(modelId);
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

/** The Anthropic Messages API response shape. */
interface AnthropicMessagesResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
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

// ---------------------------------------------------------------------------
// Known model catalog — used by listAvailableModels / getModelInfo
// ---------------------------------------------------------------------------

/**
 * Static catalog of well-known Anthropic models and their metadata.
 *
 * Pricing verified against anthropic.com/pricing on 2026-04-16 (USD per 1M tokens).
 * Update when Anthropic publishes new rate cards.
 *
 * `outputTokenLimit` is the model's real max output ceiling, surfaced via
 * getModelInfo for callers that want to size requests. It is informational —
 * NOT the per-request default: when a caller omits `maxTokens`, the request
 * falls back to `config.defaultMaxTokens`, not this value — but a per-call
 * `maxTokens` IS clamped to it via {@link clampAnthropicMaxTokens}. Anthropic
 * specs: Fable 5 = 128K output / 1M context, Opus 4.x = 128K output / 1M
 * context, Sonnet 4.x = 64K output / 1M context, Haiku 4.5 = 64K output / 200K.
 */
const ANTHROPIC_MODELS: ModelInfo[] = [
  {
    modelId: 'claude-fable-5',
    providerId: 'anthropic',
    displayName: 'Claude Fable 5',
    description: "Anthropic's most capable widely released model, for the most demanding reasoning and long-horizon agentic work.",
    capabilities: ['chat', 'tool_use', 'vision_input'],
    contextWindowSize: 1000000,
    outputTokenLimit: 128000,
    pricePer1MTokensInput: 10,
    pricePer1MTokensOutput: 50,
    supportsStreaming: true,
    status: 'active',
  },
  {
    modelId: 'claude-opus-4-8',
    providerId: 'anthropic',
    displayName: 'Claude Opus 4.8',
    description: 'Most intelligent model for agents and coding.',
    capabilities: ['chat', 'tool_use', 'vision_input'],
    contextWindowSize: 1000000,
    outputTokenLimit: 128000,
    pricePer1MTokensInput: 5,
    pricePer1MTokensOutput: 25,
    supportsStreaming: true,
    status: 'active',
  },
  {
    modelId: 'claude-opus-4-7',
    providerId: 'anthropic',
    displayName: 'Claude Opus 4.7',
    description: 'Prior Opus generation.',
    capabilities: ['chat', 'tool_use', 'vision_input'],
    contextWindowSize: 1000000,
    outputTokenLimit: 128000,
    pricePer1MTokensInput: 5,
    pricePer1MTokensOutput: 25,
    supportsStreaming: true,
    status: 'active',
  },
  {
    modelId: 'claude-opus-4-6',
    providerId: 'anthropic',
    displayName: 'Claude Opus 4.6',
    description: 'Previous-generation Opus with same pricing as 4.7.',
    capabilities: ['chat', 'tool_use', 'vision_input'],
    contextWindowSize: 1000000,
    outputTokenLimit: 128000,
    pricePer1MTokensInput: 5,
    pricePer1MTokensOutput: 25,
    supportsStreaming: true,
    status: 'active',
  },
  {
    modelId: 'claude-sonnet-4-6',
    providerId: 'anthropic',
    displayName: 'Claude Sonnet 4.6',
    description: 'Optimal balance of intelligence, cost, and speed.',
    capabilities: ['chat', 'tool_use', 'vision_input'],
    contextWindowSize: 1000000,
    outputTokenLimit: 64000,
    pricePer1MTokensInput: 3,
    pricePer1MTokensOutput: 15,
    supportsStreaming: true,
    status: 'active',
  },
  {
    modelId: 'claude-sonnet-4-5',
    providerId: 'anthropic',
    displayName: 'Claude Sonnet 4.5',
    description: 'Previous-generation Sonnet with same pricing as 4.6.',
    capabilities: ['chat', 'tool_use', 'vision_input'],
    contextWindowSize: 200000,
    outputTokenLimit: 64000,
    pricePer1MTokensInput: 3,
    pricePer1MTokensOutput: 15,
    supportsStreaming: true,
    status: 'active',
  },
  {
    modelId: 'claude-haiku-4-5-20251001',
    providerId: 'anthropic',
    displayName: 'Claude Haiku 4.5',
    description: 'Fastest, most cost-efficient model for lightweight tasks.',
    capabilities: ['chat', 'tool_use', 'vision_input'],
    contextWindowSize: 200000,
    outputTokenLimit: 64000,
    pricePer1MTokensInput: 1,
    pricePer1MTokensOutput: 5,
    supportsStreaming: true,
    status: 'active',
  },
  // Legacy entries retained for model-ID back-compat. Prices reflect the
  // original rate card for those specific snapshots.
  {
    modelId: 'claude-opus-4-20250514',
    providerId: 'anthropic',
    displayName: 'Claude Opus 4 (2025-05-14)',
    description: 'Original Opus 4 snapshot. Legacy pricing retained.',
    capabilities: ['chat', 'tool_use', 'vision_input'],
    contextWindowSize: 200000,
    outputTokenLimit: 32000,
    pricePer1MTokensInput: 15,
    pricePer1MTokensOutput: 75,
    supportsStreaming: true,
    status: 'active',
  },
  {
    modelId: 'claude-sonnet-4-20250514',
    providerId: 'anthropic',
    displayName: 'Claude Sonnet 4 (2025-05-14)',
    description: 'Original Sonnet 4 snapshot.',
    capabilities: ['chat', 'tool_use', 'vision_input'],
    contextWindowSize: 200000,
    outputTokenLimit: 64000,
    pricePer1MTokensInput: 3,
    pricePer1MTokensOutput: 15,
    supportsStreaming: true,
    status: 'active',
  },
];

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
  const entry =
    ANTHROPIC_MODELS.find((m) => m.modelId === modelId) ??
    ANTHROPIC_MODELS.find((m) => modelId.startsWith(m.modelId) || m.modelId.startsWith(modelId));
  const ceiling = entry?.outputTokenLimit;
  return typeof ceiling === 'number' && ceiling > 0 ? Math.min(requested, ceiling) : requested;
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

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
 *   'claude-sonnet-4-20250514',
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
    this.keyPool = new ApiKeyPool(config.apiKey);
    this.defaultModelId = config.defaultModelId;
    this.isInitialized = true;

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
   * @param {string} modelId - The Anthropic model to use (e.g., "claude-sonnet-4-20250514").
   * @param {ChatMessage[]} messages - Conversation messages. System-role messages are
   *   extracted and sent as the top-level `system` parameter.
   * @param {ModelCompletionOptions} options - Completion options. `maxTokens` is strongly
   *   recommended; defaults to {@link AnthropicProviderConfig.defaultMaxTokens} if omitted.
   * @returns {Promise<ModelCompletionResponse>} A normalized completion response.
   * @throws {AnthropicProviderError} On authentication, validation, or network errors.
   */
  public async generateCompletion(
    modelId: string,
    messages: ChatMessage[],
    options: ModelCompletionOptions,
  ): Promise<ModelCompletionResponse> {
    this.ensureInitialized();

    // Capture the structured-output tool name from the request options
    // so the response mapper can surface the matching tool_use block's
    // input as JSON-string content (uniform API across providers).
    const sf = options.responseFormat as
      | { _agentosUseToolForStructuredOutput?: boolean; tool?: { name: string } }
      | undefined;
    const structuredOutputName = sf?._agentosUseToolForStructuredOutput
      ? sf.tool?.name
      : undefined;

    // Escape hatch: single-shot JSON transport for SSE-hostile proxies.
    if (this.config.streamCompletions === false) {
      const payload = this.buildRequestPayload(modelId, messages, options, false);
      const apiResponse = await this.makeApiRequest<AnthropicMessagesResponse>(
        '/v1/messages',
        'POST',
        payload,
        options.requestTimeout,
      );
      this.recordCacheLeakSample(modelId, payload, apiResponse);
      return this.mapResponseToCompletion(apiResponse, structuredOutputName);
    }

    // Default: ride the SSE path so parseSseStream's idle watchdog bounds
    // mid-body stalls. A non-streaming POST cannot tell a hung connection
    // from a slow generation, so a caller's generous requestTimeout
    // (codegen passes 25 min) turned each hang into a 25-minute silence;
    // streamed deltas keep flowing on a healthy call, so a quiet gap of
    // streamIdleTimeoutMs means the connection is dead — fail fast and
    // let the caller (or the retry loop below) recover in seconds.
    const payload = this.buildRequestPayload(modelId, messages, options, true);
    const apiResponse = await this.streamMessagesToResponse(payload, options.requestTimeout);
    this.recordCacheLeakSample(modelId, payload, apiResponse);
    return this.mapResponseToCompletion(apiResponse, structuredOutputName);
  }

  /**
   * Feed one request's cache usage to the leak detector (see
   * cacheLeakDetector.ts — warns once per callsite on the zero-read /
   * unmarked pathological signatures). The callsite identity is the first
   * 256 chars of the system prompt, read from the just-built payload so it
   * reflects what actually went to the wire. Fail-open by construction.
   *
   * @private
   */
  private recordCacheLeakSample(
    modelId: string,
    payload: Record<string, unknown>,
    apiResponse: AnthropicMessagesResponse,
  ): void {
    try {
      const system = payload.system as
        | string
        | Array<{ type: string; text?: string }>
        | undefined;
      const systemPrefix = typeof system === 'string'
        ? system
        : Array.isArray(system)
          ? system.map((b) => b.text ?? '').join('\n').slice(0, 256)
          : '';
      recordCacheUsage({
        model: modelId,
        systemPrefix,
        uncachedInputTokens: apiResponse.usage?.input_tokens ?? 0,
        cacheReadTokens: apiResponse.usage?.cache_read_input_tokens ?? 0,
        cacheCreationTokens: apiResponse.usage?.cache_creation_input_tokens ?? 0,
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
   * @private
   */
  private async streamMessagesToResponse(
    payload: Record<string, unknown>,
    requestTimeoutOverride?: number,
  ): Promise<AnthropicMessagesResponse> {
    let lastError: AnthropicProviderError = new AnthropicProviderError(
      'Streaming completion failed after all retries.',
      'MAX_RETRIES_REACHED',
    );

    const attempts = Math.max(1, this.config.maxRetries ?? 1);
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const stream = await this.makeStreamRequest('/v1/messages', payload, requestTimeoutOverride);
        return await this.accumulateMessagesStream(stream);
      } catch (error: unknown) {
        lastError =
          error instanceof AnthropicProviderError
            ? error
            : new AnthropicProviderError(
                error instanceof Error ? error.message : 'Streaming completion failed.',
                'STREAM_PROCESSING_ERROR',
              );
        if (!this.isRetryableStreamError(lastError) || attempt === attempts - 1) {
          throw lastError;
        }
        await new Promise(resolve => setTimeout(resolve, computeRetryBackoffMs(attempt)));
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
   * @throws {AnthropicProviderError} `STREAM_ERROR_EVENT` on an SSE error
   *   event, `STREAM_INCOMPLETE` when the stream ends before `message_delta`
   *   or a tool_use input JSON is truncated, plus whatever
   *   {@link parseSseStream} throws (`STREAM_IDLE_TIMEOUT`, parse errors).
   * @private
   */
  private async accumulateMessagesStream(
    stream: ReadableStream<Uint8Array>,
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
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreationTokens: number | undefined;
    let cacheReadTokens: number | undefined;
    let sawMessageDelta = false;
    const blocks = new Map<number, AccumBlock>();

    for await (const rawEvent of this.parseSseStream(stream)) {
      let event: AnthropicStreamEvent;
      try {
        event = JSON.parse(rawEvent) as AnthropicStreamEvent;
      } catch {
        console.warn('AnthropicProvider: Could not parse SSE event JSON:', rawEvent);
        continue;
      }

      switch (event.type) {
        case 'message_start': {
          id = event.message.id ?? id;
          model = event.message.model ?? model;
          inputTokens = event.message.usage?.input_tokens ?? 0;
          cacheCreationTokens = event.message.usage?.cache_creation_input_tokens;
          cacheReadTokens = event.message.usage?.cache_read_input_tokens;
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
      .sort((a, b) => a[0] - b[0])
      .map(([, block]) => {
        if (block.type === 'tool_use') {
          let input: Record<string, unknown>;
          try {
            input = block.argsJson ? (JSON.parse(block.argsJson) as Record<string, unknown>) : {};
          } catch {
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
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        ...(cacheCreationTokens !== undefined && { cache_creation_input_tokens: cacheCreationTokens }),
        ...(cacheReadTokens !== undefined && { cache_read_input_tokens: cacheReadTokens }),
      },
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
   * @throws {AnthropicProviderError} On connection or stream errors.
   */
  public async *generateCompletionStream(
    modelId: string,
    messages: ChatMessage[],
    options: ModelCompletionOptions,
  ): AsyncGenerator<ModelCompletionResponse, void, undefined> {
    this.ensureInitialized();

    const payload = this.buildRequestPayload(modelId, messages, options, true);

    // Handle pre-aborted signals
    const abortSignal = options.abortSignal;
    if (abortSignal?.aborted) {
      yield this.buildAbortChunk(modelId);
      return;
    }

    const stream = await this.makeStreamRequest('/v1/messages', payload);

    // State accumulators across SSE events
    let responseId = `anthropic-${modelId}-${Date.now()}`;
    let accumulatedContent = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreationTokens: number | undefined;
    let cacheReadTokens: number | undefined;
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
          console.warn('AnthropicProvider: Could not parse SSE event JSON:', rawEvent);
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
              // landed (reads 0.10x + writes 1.25x are real spend).
              costUSD: this.estimateCost(
                inputTokens,
                outputTokens,
                modelId,
                cacheReadTokens,
                cacheCreationTokens,
              ),
              ...(cacheCreationTokens !== undefined && {
                cacheCreationInputTokens: cacheCreationTokens,
              }),
              ...(cacheReadTokens !== undefined && {
                cacheReadInputTokens: cacheReadTokens,
              }),
            };

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
              isFinal: true,
            };
            break;
          }

          case 'error': {
            // Stream-level error from Anthropic
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
   * @param {string} modelId - Model identifier (e.g., "claude-sonnet-4-20250514").
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
    type SystemBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };
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

    // --- Effort (output_config.effort) ---
    // Reasoning depth + token-spend control on effort-capable Claude models
    // (Opus 4.5+/Sonnet 4.6/Fable/Mythos). Independent of thinking + tool_choice
    // — it rides on output_config. Dropped on unsupported models OR invalid
    // values so an out-of-range effort can never 400 the request.
    if (options.effort && isEffortLevel(options.effort) && modelSupportsEffort(modelId)) {
      const oc = (payload.output_config as Record<string, unknown> | undefined) ?? {};
      payload.output_config = { ...oc, effort: options.effort };
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

    // --- Schema-driven structured output via forced tool-use ---
    // Anthropic doesn't have an OpenAI-style response_format with
    // json_schema. The equivalent is a single forced tool whose
    // input_schema matches the desired output shape; the model returns
    // a tool_use block whose input is JSON-validated by Anthropic's
    // own enforcement.
    //
    // The provider-format adapter (structuredOutputFormat.ts) signals
    // this mode by setting _agentosUseToolForStructuredOutput on the
    // responseFormat option. The downstream response-mapper detects the
    // matching block by the tool's name and surfaces its input as the
    // JSON-string body of the choice's message.
    const sf = options.responseFormat as
      | { _agentosUseToolForStructuredOutput?: boolean; tool?: { name: string; input_schema: Record<string, unknown> } }
      | undefined;
    if (sf?._agentosUseToolForStructuredOutput && sf.tool) {
      // Schema-aware mode reserves the tool slot for the schema tool;
      // mixing structured output with caller-provided tools requires a
      // multi-turn protocol the session.send overload doesn't speak.
      // The caller path (AgentSession.send) already strips its tools
      // before reaching us; this drop is the second line of defense
      // against a direct provider.generateCompletion call that
      // accidentally passes both responseFormat (structured-output
      // marker) and a tools array.
      payload.tools = [{ name: sf.tool.name, input_schema: sf.tool.input_schema }];
      payload.tool_choice = { type: 'tool', name: sf.tool.name };
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
    // the thinking or Fable quirks. Catches both the convertToolChoice path and
    // the structured-output forced tool.
    {
      const tc = payload.tool_choice as { type?: string } | undefined;
      if (tc && (tc.type === 'any' || tc.type === 'tool')) {
        const thinkingActive = Boolean(payload.thinking);
        const modelRejectsForced = !modelSupportsForcedToolChoice(modelId);
        if (thinkingActive || modelRejectsForced) {
          const reason = thinkingActive
            ? 'extended thinking is incompatible with a forced tool_choice'
            : `model ${modelId} rejects a forced tool_choice`;
          console.warn(
            `[agentos] AnthropicProvider: ${reason} (type='${tc.type}'); clamping to ` +
              `'auto' for model ${modelId}. The model decides whether to call a tool — ` +
              `forced tool use is not guaranteed.`,
          );
          payload.tool_choice = { type: 'auto' };
        }
      }
    }

    // Pass through any custom model params
    if (options.customModelParams) {
      Object.assign(payload, options.customModelParams);
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
    //    the system region — never restructure it or add markers there. Under
    //    extended thinking the auto moving TAIL on the final message is still
    //    pinned: in agent loops the growing history lives in the
    //    provider-facing message array the caller never sees, so this layer is
    //    the only one that can mark it. Full stand-down here left that history
    //    permanently uncached — measured 2026-07-05 at 15M+ full-price prompt
    //    tokens/day (avg 16-19K uncached tokens/step) while marker-free calls
    //    on the same image collapsed to ~2 uncached tokens/step. A caller 1h
    //    system TTL alongside a 5-min moving tail is valid API usage (stable
    //    prefix long TTL, moving tail short TTL).
    //
    //  - MESSAGE markers: the caller owns the whole messages region — the auto
    //    tail stands down entirely.
    //
    //  - Non-thinking requests keep the old semantics: any caller marker
    //    stands the top-level auto marker down (it would cover the same
    //    regions the caller already scoped).
    //
    // Callers that need it off (single-shot prompts where the cache-write
    // premium can't amortize) set AGENTOS_ANTHROPIC_AUTO_CACHE=0.
    const autoCacheEnv = process.env.AGENTOS_ANTHROPIC_AUTO_CACHE;
    if (
      autoCacheEnv !== '0'
      && autoCacheEnv !== 'false'
      && payload.cache_control === undefined
      // Model-dynamic: stand the AUTO path down for ids without Anthropic
      // prompt caching (a non-claude id routed here by a proxy config).
      // Explicit caller markers above still pass through untouched.
      && resolveCacheCapabilities(modelId).supportsPromptCaching
    ) {
      const explicitBreakpoints = systemBlocks.filter(b => b.cache_control).length;
      const messageBreakpoints = this.countMessageCacheMarkers(anthropicMessages);
      if (explicitBreakpoints === 0 && messageBreakpoints === 0) {
        if (payload.thinking !== undefined) {
          // Extended thinking: the request-level auto marker measurably
          // produces ZERO cache creation on thinking-enabled calls
          // (2026-07: 900+ agent-loop calls, ~12M prompt tokens/day,
          // 0.000 hit rate). Place explicit block-level breakpoints
          // instead:
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
            systemBlocks[firstSystemMsgBlockEnd - 1].cache_control = { type: 'ephemeral' };
            payload.system = systemBlocks;
            placed = true;
          }
          if (this.markLastCacheableMessageBlock(anthropicMessages)) {
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
        payload.thinking !== undefined &&
        messageBreakpoints === 0 &&
        explicitBreakpoints > 0 &&
        explicitBreakpoints < 4
      ) {
        // Caller marked the system prefix only: keep their placement + TTL
        // verbatim and pin just the moving message tail (the API cap is 4
        // breakpoints per request — the tail adds one, so require headroom).
        this.markLastCacheableMessageBlock(anthropicMessages);
      }
    }

    return payload;
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
   * @returns True when a marker was placed.
   * @private
   */
  private markLastCacheableMessageBlock(
    anthropicMessages: Array<Record<string, unknown>>,
  ): boolean {
    if (anthropicMessages.length === 0) return false;
    const last = anthropicMessages[anthropicMessages.length - 1];
    const content = last.content;
    if (typeof content === 'string') {
      if (!content) return false;
      last.content = [
        { type: 'text', text: content, cache_control: { type: 'ephemeral' } },
      ];
      return true;
    }
    if (Array.isArray(content)) {
      const CACHEABLE = new Set(['text', 'image', 'tool_use', 'tool_result', 'document', 'search_result']);
      for (let i = content.length - 1; i >= 0; i--) {
        const block = content[i] as Record<string, unknown>;
        if (block && typeof block === 'object' && CACHEABLE.has(block.type as string)) {
          block.cache_control = { type: 'ephemeral' };
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
   * @returns {ModelCompletionResponse} Normalized completion response.
   * @private
   */
  private mapResponseToCompletion(
    apiResponse: AnthropicMessagesResponse,
    structuredOutputName?: string,
  ): ModelCompletionResponse {
    // Collect text content
    const textParts = apiResponse.content
      .filter(block => block.type === 'text' && block.text)
      .map(block => block.text!);
    let fullText = textParts.join('');

    // Collect tool_use blocks and convert to OpenAI-style tool_calls
    const toolCalls = apiResponse.content
      .filter(block => block.type === 'tool_use')
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

    // Schema-driven structured output: if the request set a forced tool
    // for structured output, find the matching tool_use block and surface
    // its input as JSON-string content. This keeps result.text uniform
    // with OpenAI's json_schema response (text is valid JSON) for
    // session.send callers that consume result.text directly.
    if (structuredOutputName) {
      const toolBlock = apiResponse.content.find(
        b => b.type === 'tool_use' && b.name === structuredOutputName,
      );
      if (toolBlock?.input !== undefined) {
        fullText = JSON.stringify(toolBlock.input);
      }
    }

    const hasToolCalls = toolCalls.length > 0;
    const finishReason = this.mapStopReason(apiResponse.stop_reason);

    const usage: ModelUsage = {
      promptTokens: apiResponse.usage.input_tokens,
      completionTokens: apiResponse.usage.output_tokens,
      totalTokens: apiResponse.usage.input_tokens + apiResponse.usage.output_tokens,
      costUSD: this.estimateCost(
        apiResponse.usage.input_tokens,
        apiResponse.usage.output_tokens,
        apiResponse.model,
        apiResponse.usage.cache_read_input_tokens,
        apiResponse.usage.cache_creation_input_tokens,
      ),
      cacheCreationInputTokens: apiResponse.usage.cache_creation_input_tokens,
      cacheReadInputTokens: apiResponse.usage.cache_read_input_tokens,
    };

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
    };
  }

  /**
   * Maps Anthropic stop reasons to IProvider-convention finish reasons.
   *
   * - `end_turn` → `"stop"` (natural completion)
   * - `tool_use` → `"tool_calls"` (model wants to invoke tools)
   * - `max_tokens` → `"length"` (hit token limit)
   * - `stop_sequence` → `"stop"` (hit a caller-specified stop sequence)
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
      case 'stop_sequence': return 'stop';
      default: return stopReason ?? 'stop';
    }
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
   * Estimates USD cost for a given model and token counts.
   *
   * Looks up pricing from the static model catalog. Returns undefined
   * if the model is not found in the catalog.
   *
   * @param {number} inputTokens - Number of input tokens.
   * @param {number} outputTokens - Number of output tokens.
   * @param {string} modelId - Model identifier for pricing lookup.
   * @returns {number | undefined} Estimated cost in USD.
   * @private
   */
  /**
   * Estimate cost in USD for a completion, including Anthropic's prompt-
   * caching tier pricing.
   *
   * Anthropic billing tiers (as of 2025):
   *   input_tokens            × 1.00 × base input rate  (non-cached input)
   *   cache_read_input_tokens × 0.10 × base input rate  (cache hit)
   *   cache_creation_input_tokens × 1.25 × base input rate  (5-min TTL write)
   *   output_tokens           × 1.00 × base output rate
   *
   * The API's `input_tokens` field already EXCLUDES cached tokens, so we
   * sum three separate components for total input cost. Previous
   * implementation used only `input_tokens` × rate, which happened to
   * be correct for the non-cached portion but hid cache creation cost
   * and ignored cache read cost entirely — meaning reported costUSD
   * was always BELOW true billed amount whenever caching was active.
   *
   * 1-hour TTL cache-creation rate is 2× the base input rate, not 1.25×.
   * We can't tell which TTL was used from the response, so we assume
   * the default 5-minute tier. For long-lived cached contexts the
   * reported cost will under-estimate by the 0.75× difference on
   * creation tokens (minor; mostly one-shot at run start).
   */
  private estimateCost(
    inputTokens: number,
    outputTokens: number,
    modelId: string,
    cacheReadTokens?: number,
    cacheCreationTokens?: number,
  ): number | undefined {
    const info = ANTHROPIC_MODELS.find(m => m.modelId === modelId);
    if (!info?.pricePer1MTokensInput || !info?.pricePer1MTokensOutput) return undefined;
    const inputPrice = info.pricePer1MTokensInput;
    const outputPrice = info.pricePer1MTokensOutput;
    const nonCachedInput = (inputTokens / 1_000_000) * inputPrice;
    const cachedRead = ((cacheReadTokens ?? 0) / 1_000_000) * inputPrice * 0.10;
    const cachedCreate = ((cacheCreationTokens ?? 0) / 1_000_000) * inputPrice * 1.25;
    const output = (outputTokens / 1_000_000) * outputPrice;
    return nonCachedInput + cachedRead + cachedCreate + output;
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
   * @returns {Promise<T>} Parsed JSON response.
   * @throws {AnthropicProviderError} On authentication, validation, rate-limit, or network errors.
   * @private
   */
  private async makeApiRequest<T>(
    endpoint: string,
    method: 'POST',
    body: Record<string, unknown>,
    requestTimeoutOverride?: number,
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

    for (let attempt = 0; attempt < this.config.maxRetries!; attempt++) {
      // Rotate the key per attempt so a retry after a 429 fails over to a
      // different key from the pool instead of hammering the throttled one.
      const apiKey = this.nextApiKey();
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
          headers: { ...headers, ...this.thinkingBetaHeaders(body), 'Content-Type': 'application/json', connection: 'close' },
          body: JSON.stringify(body),
          signal: controller.signal,
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

          // Non-retryable client errors
          if (response.status === 401 || response.status === 403 || response.status === 400 || response.status === 404) {
            throw new AnthropicProviderError(errorMessage, 'API_CLIENT_ERROR', response.status, errorType, errorData);
          }

          // Rate limit — take this key out of rotation (quota cooldown) so the
          // next attempt fails over to a different key, then respect Retry-After.
          if (response.status === 429) {
            lastError = new AnthropicProviderError(errorMessage, 'RATE_LIMIT_EXCEEDED', 429, errorType, errorData);
            this.keyPool?.markExhausted(apiKey);
            const retryAfter = response.headers.get('retry-after');
            // Retry-After is authoritative when present; otherwise jittered backoff.
            const retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : computeRetryBackoffMs(attempt);
            await new Promise(resolve => setTimeout(resolve, retryAfterMs));
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
        if (error instanceof AnthropicProviderError) {
          if (error.code === 'API_CLIENT_ERROR') throw error;
          lastError = error;
        } else if (error instanceof Error && error.name === 'AbortError') {
          lastError = new AnthropicProviderError(
            `Request timed out after ${effRequestTimeout}ms.`,
            'REQUEST_TIMEOUT',
          );
        } else {
          lastError = new AnthropicProviderError(
            error instanceof Error ? error.message : 'Network or unknown error',
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
   * @returns {Promise<ReadableStream<Uint8Array>>} The response body stream.
   * @throws {AnthropicProviderError} On connection errors.
   * @private
   */
  private async makeStreamRequest(
    endpoint: string,
    body: Record<string, unknown>,
    requestTimeoutOverride?: number,
  ): Promise<ReadableStream<Uint8Array>> {
    const url = `${this.config.baseURL}${endpoint}`;
    const apiKey = this.nextApiKey();
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
        headers: { ...headers, ...this.thinkingBetaHeaders(body), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
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
        // A throttled key should not be reused by the next stream/request —
        // mark it for cooldown so the pool fails over.
        if (response.status === 429) {
          this.keyPool?.markExhausted(apiKey);
        }
        throw new AnthropicProviderError(
          errorMessage,
          'STREAM_CONNECTION_FAILED',
          response.status,
          errorData.error?.type,
          errorData,
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
      if (error instanceof AnthropicProviderError) throw error;
      throw new AnthropicProviderError(
        error instanceof Error ? error.message : 'Failed to connect to Anthropic stream.',
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
   * Resolve the next API key. With a multi-key pool this is a weighted
   * round-robin that skips keys currently in quota cooldown; with a single
   * key it returns that key. Call this once PER ATTEMPT (not once per
   * request) so a retry after a 429 fails over to a different key rather
   * than reusing the throttled one.
   */
  private nextApiKey(): string {
    return this.keyPool?.hasKeys ? this.keyPool.next() : this.config.apiKey;
  }

  private buildHeaders(apiKey: string): Record<string, string> {
    return {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'User-Agent': 'AgentOS/1.0 (AnthropicProvider)',
    };
  }

  /**
   * The `anthropic-beta` header for interleaved extended thinking, returned
   * only when this request actually uses thinking — either it enables it
   * outbound (`thinking` in the body) or it replays captured thinking blocks
   * from a prior assistant turn. Empty otherwise, so non-thinking traffic is
   * byte-for-byte unchanged.
   */
  private thinkingBetaHeaders(body: Record<string, unknown>): Record<string, string> {
    return this.payloadUsesThinking(body)
      ? { 'anthropic-beta': 'interleaved-thinking-2025-05-14' }
      : {};
  }

  /** True when the request enables extended thinking or replays thinking blocks. */
  private payloadUsesThinking(body: Record<string, unknown>): boolean {
    if (body.thinking != null) return true;
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
