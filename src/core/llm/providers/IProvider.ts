// File: backend/agentos/core/llm/providers/IProvider.ts
/**
 * @fileoverview Core provider contract and shared types for integrating Large Language / Multimodal Model services
 * into AgentOS. Implementations wrap concrete vendor SDKs or HTTP APIs (OpenAI, Anthropic, Ollama, OpenRouter, etc.)
 * and normalize their capabilities into a consistent surface area used by higher‑level orchestration layers
 * (PromptEngine, GMIManager, Utility AI components).
 *
 * Design Goals:
 * 1. Capability Normalization – Chat vs legacy completion, tool/function calling, streaming deltas, embeddings.
 * 2. Deterministic Streaming Semantics – Every streamed chunk is a full `ModelCompletionResponse` fragment with:
 *    - optional `responseTextDelta` (string diff)
 *    - optional `toolCallsDeltas[]` capturing incremental tool argument assembly
 *    - `isFinal` flag to indicate terminal chunk and stable usage metrics.
 * 3. Introspection – Lightweight model catalog (`listAvailableModels`, `getModelInfo`) enabling routing & cost decisions.
 * 4. Resilience & Diagnostics – Uniform error envelope attached to `ModelCompletionResponse.error` for both
 *    streaming and non‑streaming calls so upstream layers can surface actionable messages.
 * 5. Strict Initialization Lifecycle – `initialize()` must succeed before any other mutating call.
 *
 * Error Handling Philosophy:
 * - Provider implementations SHOULD translate vendor‑specific errors into a stable structure:
 *   { message, type?, code?, details? }.
 * - Transient failures (network timeouts, rate limit backoffs) MAY be surfaced inline; upstream retry policies live above.
 * - Streaming calls MUST emit a terminal chunk with `isFinal: true` even on error (with `error` populated) so consumers
 *   can perform consistent teardown.
 *
 * Concurrency & Cancellation:
 * - Implementations MAY support externally triggered abort via custom option (e.g. `customModelParams.abortSignal`).
 * - If supported, aborted streams MUST still resolve the generator cleanly (no thrown error) after emitting a final
 *   chunk with `isFinal: true` and an `error` describing the cancellation reason.
 *
 * Token Usage & Cost:
 * - `usage.totalTokens` MUST be present on final responses (streaming or non‑streaming).
 * - Interim streaming chunks SHOULD omit usage or provide partials; callers should treat usage as unstable until final.
 * - `costUSD` is optional; if provided should reflect estimated or actual vendor pricing for the call.
 *
 * @module backend/agentos/core/llm/providers/IProvider
 */

/**
 * Represents a part of a multimodal message content.
 */
export type MessageContentPart =
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto'; } }
  // For Anthropic tool results specifically, fitting their API:
  | { type: 'tool_result'; tool_use_id: string; content?: string | Array<Record<string, any>>; is_error?: boolean; }
  // Fallback for other potential string types for extensibility
  | { type: string; [key: string]: any };


/**
 * Generic type for message content, which can be simple text or
 * a structured array for multimodal inputs (e.g., text and image parts).
 */
export type MessageContent = string | Array<MessageContentPart>;

/**
 * Represents a single message in a conversation, conforming to a structure
 * widely adopted by chat-based LLM APIs.
 */
/**
 * An Anthropic extended-thinking block, captured from a response and replayed
 * verbatim on the next tool-loop turn. `signature` (standard) and `data`
 * (redacted) are opaque, provider-issued tokens that MUST be replayed exactly,
 * in order — never strip, reorder, or regenerate them, or the Messages API
 * rejects the turn.
 */
export type ThinkingBlock =
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string };

export interface ChatMessage {
  /** The role of the entity sending the message. */
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** The content of the message. Can be simple text or structured for multimodal inputs. */
  content: MessageContent | null;
  /** An optional name for the message author. */
  name?: string;
  /** Identifier for the tool call, present in 'tool' role messages that are responses to a tool call. */
  tool_call_id?: string;
  /** A list of tool calls requested by the assistant. */
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
  /**
   * Anthropic extended-thinking blocks emitted on this assistant turn.
   * Captured from the response and replayed verbatim (signatures intact) on
   * the next tool-loop turn — Anthropic 400s a tool turn whose prior thinking
   * blocks aren't replayed. Present ONLY when the request enabled extended
   * thinking; undefined on every non-thinking turn (the existing path is
   * unchanged).
   */
  thinkingBlocks?: ThinkingBlock[];
}

// ... (rest of IProvider.ts remains the same as provided by user initially)
// ... (ensure ModelCompletionOptions, ModelUsage, ModelCompletionChoice, ModelCompletionResponse, etc. are correctly defined or imported if they were part of the "..." )


/**
 * General options for model completion requests (both chat and legacy text completion, though chat is prioritized).
 * These options control aspects like creativity, response length, and penalties.
 */
export interface ModelCompletionOptions {
  /** Identifier of the model to use for completion. */
  modelId?: string;
  /**
   * Controls randomness: lower values make the output more focused and deterministic.
   * Higher values (e.g., 0.8) make it more random.
   */
  temperature?: number;
  /**
   * Nucleus sampling: the model considers only tokens with probabilities summing up to topP.
   * Lower values (e.g., 0.1) mean more restricted, less random output.
   */
  topP?: number;
  /**
   * The maximum number of tokens to generate in the completion.
   */
  maxTokens?: number;
  /**
   * Per-call request timeout in milliseconds. Overrides the provider's default
   * request timeout for this single completion only. Large-output callers
   * (e.g. structured-output generation that emits long strings) can raise the
   * abort window without slowing the provider's default failover for chat or
   * narration traffic. Providers that don't implement a request timeout ignore
   * this field.
   */
  requestTimeout?: number;
  /**
   * Anthropic extended-thinking switch. When set on a reasoning-default
   * Claude model (Opus 4.7/4.8), the provider sends
   * `thinking: { type: 'adaptive' }` — the only form this family accepts;
   * the budget number is not sent and max_tokens passes through unchanged.
   * Providers/models that don't support it ignore the field. Single-shot
   * calls only — preserving thinking blocks across an agent tool loop is
   * a separate concern.
   */
  thinking?: { budgetTokens: number };
  /**
   * Reasoning-effort control. On effort-capable Claude models (Opus 4.5+,
   * Sonnet 4.6, Fable/Mythos 5) the provider sends `output_config.effort`
   * (low|medium|high|xhigh|max). Independent of `thinking` and tool_choice;
   * dropped on unsupported models or invalid values.
   */
  effort?: string;
  /**
   * Anthropic prompt-cache diagnostics (beta `cache-diagnosis-2026-04-07`).
   * When set, the provider sends `diagnostics: { previous_message_id }` plus
   * the beta header, and the API compares this request against the referenced
   * one to explain any cache miss. Pass `previousMessageId: null` on the first
   * call of a conversation to opt in; thread the previous response's `id`
   * (`msg_...`) on subsequent calls. The verdict comes back on
   * {@link ModelCompletionResponse.cacheDiagnostics}. Anthropic-only —
   * other providers ignore the field. Never affects request processing:
   * diagnostics are best-effort observability.
   */
  cacheDiagnostics?: { previousMessageId: string | null };
  /**
   * Per-call prompt-cache control (Anthropic; other providers ignore it).
   *
   * - `false` — this request emits NO `cache_control` at all: the automatic
   *   markers (request-level marker, thinking-mode block markers, the moving
   *   message-tail) are suppressed AND caller-placed system/message/tool
   *   markers are stripped before the wire. Hard guarantee for true
   *   one-shots, where a cache write (1.25x at 5m, 2x at 1h) can never be
   *   read back.
   * - `{ ttl: '1h' }` — the automatic markers (including the moving
   *   message-tail) carry `ttl: '1h'` instead of the 5-minute default, and
   *   the auto path uses explicit block placement so the TTL reaches the
   *   wire. For slow loops whose step gaps exceed 5 minutes (codegen
   *   orchestrator/tool calls, human-paced conversation turns).
   *   Caller-placed markers keep their own TTLs untouched.
   * - `{ ttl: '5m' }` or omitted — default behavior (5-minute auto markers).
   */
  cache?: { ttl?: '5m' | '1h' } | false;
  /**
   * Per-conversation affinity key. OpenRouter forwards it as `session_id`
   * to pin provider sticky routing: upstream prompt caches are host-scoped,
   * so load-balanced conversations otherwise cold-miss the cache a prior
   * turn wrote on a different host. Pass a stable id per conversation
   * (game session id, companion conversation id). Providers without an
   * affinity concept ignore the field.
   */
  sessionId?: string;
  /**
   * Positive values penalize new tokens based on whether they appear in the text so far,
   * increasing the model's likelihood to talk about new topics.
   */
  presencePenalty?: number;
  /**
   * Positive values penalize new tokens based on their existing frequency in the text so far,
   * decreasing the model's likelihood to repeat the same line verbatim.
   */
  frequencyPenalty?: number;
  /** Sequences where the API will stop generating further tokens. */
  stopSequences?: string[];
  /** A unique identifier representing your end-user. */
  userId?: string;
  /** Allows overriding the default API key for a specific user or request. */
  apiKeyOverride?: string;
  /** For provider-specific parameters not covered by the common options. */
  customModelParams?: Record<string, unknown>;
  /**
   * Optional AbortSignal for caller-driven cancellation. If aborted:
   *  - Streaming providers MUST emit a terminal chunk with `isFinal: true` and `error.type='abort'`.
   *  - Non-streaming calls SHOULD throw a cancellation error (or return error response if already partially processed).
   */
  abortSignal?: AbortSignal;
  /** Indicates if a streaming response is expected. */
  stream?: boolean;
  /** Schemas of tools the model can call. */
  tools?: Array<Record<string, unknown>>;
  /** Controls how the model uses tools. */
  toolChoice?: string | Record<string, unknown>;
  /**
   * Response-format constraint for the provider call. Shape is
   * provider-specific; the adapter at
   * `src/core/llm/providers/structuredOutputFormat.ts` builds the right
   * shape per provider given a Zod schema.
   *
   * Examples:
   *   - OpenAI bare JSON mode:
   *       `{ type: 'json_object' }`
   *   - OpenAI strict JSON Schema mode:
   *       `{ type: 'json_schema',
   *          json_schema: { name, strict: true, schema } }`
   *   - Anthropic forced tool-use marker (routed to tool_choice
   *     internally by AnthropicProvider):
   *       `{ _agentosUseToolForStructuredOutput: true,
   *          tool: { name, input_schema } }`
   *   - Gemini responseSchema (routed to generationConfig
   *     internally by GeminiProvider):
   *       `{ type: 'json_object', _gemini: { responseSchema } }`
   */
  responseFormat?:
    | { type: 'text' | 'json_object' }
    | { type: 'json_schema'; json_schema: { name: string; strict: boolean; schema: Record<string, unknown> } }
    | Record<string, unknown>;
}

/**
 * The first point of divergence between this request and the one referenced
 * by `cacheDiagnostics.previousMessageId`, as reported by Anthropic's
 * cache-diagnostics beta. `type` is one of the API's discriminants
 * (`model_changed` | `system_changed` | `tools_changed` | `messages_changed`
 * | `previous_message_not_found` | `unavailable`) — kept as an open string so
 * new discriminants pass through without a library update. The `*_changed`
 * types also carry `cacheMissedInputTokens`, an estimate of how many input
 * tokens fell after the divergence point (magnitude indicator, not a billing
 * number).
 */
export interface CacheMissReason {
  type: string;
  cacheMissedInputTokens?: number;
}

/**
 * Cache-diagnostics verdict for one call. `cacheMissReason: null` means the
 * comparison was still running when the response serialized (inconclusive —
 * check the next turn). A populated reason identifies the earliest divergence;
 * fix it first, later ones may be hidden behind it.
 */
export interface CacheDiagnostics {
  cacheMissReason: CacheMissReason | null;
}

/**
 * Represents token usage information from a model call, including cost estimation.
 */
export interface ModelUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens: number;
  costUSD?: number;
  /** Tokens written to the prompt cache on this call (Anthropic: 25% surcharge). */
  cacheCreationInputTokens?: number;
  /** Tokens read from the prompt cache on this call (Anthropic: 90% discount). */
  cacheReadInputTokens?: number;
}

/**
 * Represents a single choice in a model's completion response.
 */
export interface ModelCompletionChoice {
  index: number;
  message: ChatMessage;
  text?: string;
  logprobs?: unknown;
  finishReason: string | null;
}

/**
 * Represents the full response from a model completion call (non-streaming or a single chunk of a stream).
 */
export interface ModelCompletionResponse {
  /** Provider‑assigned unique identifier for the request or chunk series. */
  id: string;
  /** Stable object/type discriminator (e.g. 'chat.completion.chunk', 'chat.completion'). */
  object: string;
  /** Unix epoch seconds when the provider created this response/chunk. */
  created: number;
  /** Resolved model identifier actually used (may differ from requested if routing / aliasing applied). */
  modelId: string;
  /**
   * Upstream host that actually served the request when the provider is an
   * aggregator/router (e.g. OpenRouter returns `provider: 'Groq'` in the
   * completion body). Undefined for direct providers and on aggregators
   * that omit it. Latency telemetry: identical model + token counts can be
   * 4s on Groq vs 10s+ on a price-biased host, so attribution needs this.
   */
  servingProvider?: string;
  /** One or more choices; for multi‑choice inference some providers return >1. */
  choices: ModelCompletionChoice[];
  /** Token usage & optional cost metrics (present on final chunk; may be partial/omitted on deltas). */
  usage?: ModelUsage;
  /**
   * Anthropic cache-diagnostics verdict (beta). Present only when the request
   * opted in via {@link ModelCompletionOptions.cacheDiagnostics} AND the API
   * returned a verdict. `null` = a comparison ran and found no divergence (or
   * this was the opt-in first turn with nothing to compare). An object with
   * `cacheMissReason` identifies the earliest divergence — see
   * {@link CacheDiagnostics}.
   */
  cacheDiagnostics?: CacheDiagnostics | null;
  /** Unified error envelope; present ONLY if an error occurred for this request/chunk. */
  error?: {
    /** Human readable message suitable for UI display or logging. */
    message: string;
    /** Optional provider/classification type (e.g. 'rate_limit', 'invalid_request'). */
    type?: string;
    /** Numeric or string code for programmatic handling. */
    code?: string | number;
    /** Raw provider payload or structured diagnostic details. */
    details?: unknown;
  };
  /** Incremental append‑only text delta for streaming; NOT cumulative. Undefined on non‑streaming final response. */
  responseTextDelta?: string;
  /** Array of incremental tool/function call argument deltas building up tool invocation payloads. */
  toolCallsDeltas?: Array<{
    /** Choice index if multiple parallel choices produce tool calls. */
    index: number;
    /** Stable tool call id once assigned by provider (may appear after initial delta). */
    id?: string;
    /** Type discriminator; currently 'function' for OpenAI‑style tools. */
    type?: 'function';
    /** Function metadata with incremental argument assembly. */
    function?: {
      /** Function name (first provided delta should include). */
      name?: string;
      /** Partial argument JSON fragment (streamed). Concatenate & then parse when final. */
      arguments_delta?: string;
    };
  }>;
  /** Indicates terminal chunk in a stream. MUST be true on last emission (success or error). */
  isFinal?: boolean;
}

/**
 * Options for embedding generation requests at the provider level.
 */
export interface ProviderEmbeddingOptions {
  model?: string;
  userId?: string;
  apiKeyOverride?: string;
  customModelParams?: Record<string, unknown>;
  encodingFormat?: 'float' | 'base64';
  dimensions?: number;
  inputType?: 'search_document' | 'search_query' | 'classification' | 'clustering' | string;
}

/**
 * Represents a single vector embedding object as returned by a provider.
 */
export interface EmbeddingObject {
  object: 'embedding';
  embedding: number[];
  index: number;
}

/**
 * Represents the response from an embedding generation call from a provider.
 */
export interface ProviderEmbeddingResponse {
  object: 'list';
  data: EmbeddingObject[];
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
    costUSD?: number;
  };
  error?: {
    message: string;
    type?: string;
    code?: string | number;
    details?: unknown;
  };
}

/**
 * Represents detailed information about a specific AI model available from a provider.
 */
export interface ModelInfo {
  modelId: string;
  providerId: string;
  displayName?: string;
  description?: string;
  capabilities: Array<'completion' | 'chat' | 'embeddings' | 'vision_input' | 'tool_use' | 'json_mode' | string>;
  contextWindowSize?: number;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  pricePer1MTokensInput?: number;
  pricePer1MTokensOutput?: number;
  pricePer1MTokensTotal?: number;
  supportsStreaming?: boolean;
  defaultTemperature?: number;
  minSubscriptionTierLevel?: number;
  isDefaultModel?: boolean;
  embeddingDimension?: number;
  lastUpdated?: string;
  status?: 'active' | 'beta' | 'deprecated' | string;
}

/**
 * @interface IProvider
 * @description Defines the contract for an AI Model Provider.
 */
export interface IProvider {
  /** Unique provider identifier (e.g. 'openai', 'ollama', 'openrouter'). */
  readonly providerId: string;
  /** Indicates successful initialization; all operational methods MUST guard against !isInitialized. */
  readonly isInitialized: boolean;
  /** Optional default model to fall back to when caller does not specify one. */
  readonly defaultModelId?: string;

  /**
   * Perform one‑time (or idempotent) initialization: validate credentials, prime model catalog, set defaults.
   * SHOULD throw on unrecoverable misconfiguration (e.g., missing API key) rather than silently degrade.
   * Multiple calls MAY reset internal caches (implementation specific).
   */
  initialize(config: Record<string, any>): Promise<void>;

  /**
   * Single shot (non‑streaming) completion. Provider MUST return a fully assembled
   * `ModelCompletionResponse` with `isFinal` either omitted or true, containing full text in `choices[].message.content`.
   * @param modelId Target model identifier (may be validated or routed).
   * @param messages Prior conversation messages (system+user+assistant+tool) shaped per unified ChatMessage.
   * @param options Completion tuning & feature flags (temperature, tools, json mode, etc.).
   * @throws Error if provider not initialized or request irrecoverably invalid.
   */
  generateCompletion(
    modelId: string,
    messages: ChatMessage[],
    options: ModelCompletionOptions
  ): Promise<ModelCompletionResponse>;

  /**
   * Streaming completion. Returns an async generator yielding incremental deltas.
   * REQUIRED invariants:
   *  - First chunk SHOULD include `id`, `modelId`, `object`, and MAY start text/tool deltas.
   *  - `responseTextDelta` values MUST be append‑only segments (caller concatenates in order).
   *  - Tool call reconstruction: concatenate `arguments_delta` per (index,id) then JSON parse when final.
   *  - Exactly one chunk MUST set `isFinal: true` (last). Final chunk SHOULD include usage & any error.
   *  - If an error occurs mid‑stream, emit a final chunk with `error` populated then end generator.
   * @returns AsyncGenerator<ModelCompletionResponse>
   */
  generateCompletionStream(
    modelId: string,
    messages: ChatMessage[],
    options: ModelCompletionOptions
  ): AsyncGenerator<ModelCompletionResponse, void, undefined>;

  /**
   * Generate embeddings for a batch of input texts. Provider MAY chunk internally but MUST return consolidated
   * response with ordering preserved (indices map to input position).
   */
  generateEmbeddings(
    modelId: string,
    texts: string[],
    options?: ProviderEmbeddingOptions
  ): Promise<ProviderEmbeddingResponse>;

  /** List available models, optionally filtered by required capability (e.g. 'embeddings'). */
  listAvailableModels(filter?: { capability?: 'completion' | 'chat' | 'embeddings' | string }): Promise<ModelInfo[]>;

  /** Retrieve detailed metadata about a specific model; undefined if unknown or catalog not loaded. */
  getModelInfo(modelId: string): Promise<ModelInfo | undefined>;

  /** Lightweight health signal; SHOULD avoid heavy network calls. */
  checkHealth(): Promise<{isHealthy: boolean, details?: unknown}>;

  /** Graceful teardown: release sockets, abort inflight requests, flush caches. Idempotent. */
  shutdown(): Promise<void>;
}
