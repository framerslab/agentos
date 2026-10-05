// File: backend/agentos/core/llm/providers/implementations/OpenRouterProvider.ts
/**
 * @fileoverview Implements the IProvider interface for OpenRouter, a service that
 * provides access to a wide variety of LLMs from different providers through a unified API.
 * This provider handles routing requests to the specified models via OpenRouter.
 * @module backend/agentos/core/llm/providers/implementations/OpenRouterProvider
 * @implements {IProvider}
 */

import axios, { AxiosInstance, AxiosError, ResponseType } from 'axios';
import {
  IProvider,
  ChatMessage,
  ModelCompletionOptions,
  ModelCompletionResponse,
  ModelInfo,
  ModelUsage,
  ProviderEmbeddingOptions,
  ProviderEmbeddingResponse,
  ModelCompletionChoice,
} from '../IProvider';
import { OpenRouterProviderError } from '../errors/OpenRouterProviderError';
import { ApiKeyPool } from '../../../providers/ApiKeyPool.js';
import { createGMIErrorFromError, GMIErrorCode } from '../../../utils/errors.js'; // Corrected import path
import { clampMaxOutputTokens } from '../model-output-limits.js';
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '../errors/errorCodes.js';
import { stripGeminiOnlyParams } from '../openrouter-only-params';
import { baseUrlCredentials, redactUrlSecrets } from '../url-secrets.js';

/**
 * Configuration specific to the OpenRouterProvider.
 */
export interface OpenRouterProviderConfig {
  apiKey: string;
  baseURL?: string;
  defaultModelId?: string;
  siteUrl?: string;
  appName?: string;
  requestTimeout?: number;
  streamRequestTimeout?: number;
}

/**
 * OpenRouter's error envelope. It arrives as an HTTP error body, as the
 * body of a 200 whose provider failed after accepting the request, on a
 * choice (`finish_reason: 'error'`), or as a mid-stream SSE event. `code`
 * is the HTTP status the failure maps to; `metadata.error_type` is
 * OpenRouter's stable typed code (the OpenRouter error reference).
 */
export interface OpenRouterErrorEnvelope {
  code?: number | string;
  message?: string;
  metadata?: Record<string, unknown>;
}

interface OpenRouterChatChoice {
  index: number;
  message?: {
    role: ChatMessage['role'];
    content: string | null;
    tool_calls?: ChatMessage['tool_calls'];
    /** Set when the model declined as output (`finish_reason: 'content_filter'`). */
    refusal?: string | null;
  };
  delta?: {
    role?: ChatMessage['role'];
    content?: string | null;
    refusal?: string | null;
    tool_calls?: Array<{
      index: number;
      id?: string;
      type?: 'function';
      function?: { name?: string; arguments?: string; };
    }>;
  };
  finish_reason: string | null;
  logprobs?: unknown;
  /** Present with `finish_reason: 'error'`: the provider failed mid-generation. */
  error?: OpenRouterErrorEnvelope;
}

interface OpenRouterChatCompletionAPIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  /**
   * Upstream host that served this completion (e.g. 'Groq', 'DeepInfra').
   * OpenRouter includes it on both non-stream responses and stream chunks.
   */
  provider?: string;
  choices: OpenRouterChatChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cost?: number;
    /**
     * Present when the request sets `usage: { include: true }` — prompt
     * tokens served from the upstream host's prompt cache. 0 or absent on
     * hosts without prompt-caching support.
     */
    prompt_tokens_details?: { cached_tokens?: number };
  };
  /** A 200 whose body reports a failure instead of choices, or a mid-stream error event. */
  error?: OpenRouterErrorEnvelope;
}

/**
 * Default OpenRouter provider-routing preferences from the environment.
 *
 * `OPENROUTER_PROVIDER_ORDER` (comma-separated upstream host names, e.g.
 * `Groq,DeepInfra`) pins an explicit host preference — tried in order with
 * `allow_fallbacks: true` so an unavailable pin falls through to the rest of
 * the pool. `OPENROUTER_PROVIDER_SORT` (`price` | `throughput` | `latency`)
 * sets the routing sort, and acts as the tiebreak when both are set; a value
 * outside that set is ignored with a one-time warning rather than sent to the
 * API, where an unknown sort fails every request routed through the default.
 * Returns `undefined` when neither env yields a usable value so default
 * routing stays byte-identical.
 *
 * Why this lives in the provider: routing consistency is a prerequisite for
 * upstream prompt-cache hits (caches are per-host, so price-variance routing
 * cold-misses even cache-capable hosts), and callers that resolve their
 * provider through a router cannot gate `customModelParams` on "openrouter"
 * themselves — every provider spreads those params onto its own payload, and
 * non-OpenRouter APIs reject the unknown `provider` key. Caller-supplied
 * `provider` preferences (via `customModelParams`) win field-by-field over
 * these defaults.
 */
const OPENROUTER_PROVIDER_SORTS = new Set(['price', 'throughput', 'latency']);

let warnedInvalidProviderSort = false;

export function defaultOpenRouterProviderPrefs(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> | undefined {
  const sortRaw = env.OPENROUTER_PROVIDER_SORT?.trim();
  let sort: string | undefined;
  if (sortRaw) {
    if (OPENROUTER_PROVIDER_SORTS.has(sortRaw)) {
      sort = sortRaw;
    } else if (!warnedInvalidProviderSort) {
      // Warn once per process: this helper runs on every request payload.
      warnedInvalidProviderSort = true;
      console.warn(
        `OpenRouterProvider: Ignoring OPENROUTER_PROVIDER_SORT='${sortRaw}' — expected one of price, throughput, latency.`,
      );
    }
  }
  const orderRaw = env.OPENROUTER_PROVIDER_ORDER?.trim();
  const order = orderRaw
    ? orderRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  if (order.length > 0) {
    return { order, allow_fallbacks: true, ...(sort ? { sort } : {}) };
  }
  if (sort) return { sort };
  return undefined;
}

/**
 * Map OpenRouter usage accounting onto the normalized {@link ModelUsage}
 * shape. With `usage: { include: true }` on the request, OpenRouter reports
 * `cost` and `prompt_tokens_details.cached_tokens` (prompt tokens served
 * from the upstream host's prompt cache). The cached count is surfaced as
 * `cacheReadInputTokens` — the same normalized field AnthropicProvider
 * populates — so the api layer's `cacheReadTokens` accounting and every
 * downstream cache log light up for OpenRouter turns without caller changes.
 */
export function mapOpenRouterUsage(
  apiUsage: OpenRouterChatCompletionAPIResponse['usage'],
): ModelUsage | undefined {
  if (!apiUsage) return undefined;
  const cachedTokens = apiUsage.prompt_tokens_details?.cached_tokens;
  return {
    promptTokens: apiUsage.prompt_tokens,
    completionTokens: apiUsage.completion_tokens,
    totalTokens: apiUsage.total_tokens,
    costUSD: apiUsage.cost,
    // OpenRouter's prompt_tokens (like OpenAI's) already INCLUDES cached
    // tokens, so the provider-independent inclusive input total is the
    // prompt count as-is (Anthropic computes input + cache_read + cache_creation).
    ...(typeof apiUsage.prompt_tokens === 'number'
      ? { inclusiveInputTokens: apiUsage.prompt_tokens }
      : {}),
    ...(typeof cachedTokens === 'number' && cachedTokens >= 0
      ? { cacheReadInputTokens: cachedTokens }
      : {}),
  };
}

interface OpenRouterEmbeddingAPIResponse {
  object: 'list';
  data: Array<{
    object: 'embedding';
    embedding: number[];
    index: number;
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

interface OpenRouterModelAPIObject {
  id: string;
  name: string;
  description: string;
  pricing: {
    prompt: string;
    completion: string;
    request?: string;
    image?: string;
  };
  context_length: number | null;
  architecture?: {
    modality: string;
    tokenizer: string;
    instruct_type: string | null;
  };
  top_provider: {
    max_retries: number | null;
    is_fallback: boolean | null;
  };
}

interface OpenRouterListModelsAPIResponse {
  data: OpenRouterModelAPIObject[];
}

/** Longest streamed error body read into an error, in bytes. */
const MAX_STREAM_ERROR_BODY_BYTES = 8192;

/** How long reading a streamed error body may take, in milliseconds. */
const STREAM_ERROR_BODY_TIMEOUT_MS = 2000;

/** Whether a value is a Node readable stream, as axios returns for `responseType: 'stream'`. */
function isReadableStream(value: unknown): value is NodeJS.ReadableStream & { destroy?: () => void } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { pipe?: unknown }).pipe === 'function' &&
    typeof (value as { on?: unknown }).on === 'function'
  );
}

/**
 * Reads up to {@link MAX_STREAM_ERROR_BODY_BYTES} of a streamed error body as
 * UTF-8 text, waiting at most {@link STREAM_ERROR_BODY_TIMEOUT_MS}, then
 * destroys the stream so its socket is released.
 *
 * @param stream - The error response body axios returned as a stream.
 * @returns The text read, possibly empty, and whether it is the whole body
 *   (false when the size limit, the timeout or a stream error cut it short).
 */
async function readErrorStream(
  stream: NodeJS.ReadableStream & { destroy?: () => void },
): Promise<{ text: string; complete: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let ended = false;
  try {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(finish, STREAM_ERROR_BODY_TIMEOUT_MS);
      function finish(): void {
        clearTimeout(timer);
        stream.removeListener('data', onData);
        stream.removeListener('end', onEnd);
        stream.removeListener('error', finish);
        resolve();
      }
      function onEnd(): void {
        ended = true;
        finish();
      }
      function onData(chunk: Buffer | string): void {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        chunks.push(bytes);
        size += bytes.length;
        if (size >= MAX_STREAM_ERROR_BODY_BYTES) finish();
      }
      stream.on('data', onData);
      stream.once('end', onEnd);
      stream.once('error', finish);
    });
  } finally {
    stream.destroy?.();
  }
  return {
    text: Buffer.concat(chunks).subarray(0, MAX_STREAM_ERROR_BODY_BYTES).toString('utf8'),
    complete: ended && size <= MAX_STREAM_ERROR_BODY_BYTES,
  };
}

/** An error body read as text: the parsed JSON object when it is one, else the text. */
function parseErrorBody(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? parsed : text;
  } catch {
    return text;
  }
}

/** How OpenRouter declined a request, read from its error envelope. */
export interface OpenRouterDecline {
  /**
   * AgentOS's content-policy codes: `content_filter` for a model's own
   * refusal, `content_policy_violation` for a filter around the model. Both
   * are in `isContentPolicyRefusal`'s and the health registry's sets.
   */
  code: 'content_filter' | 'content_policy_violation';
  /** What OpenRouter reported, kept for diagnostics. */
  nativeType: 'refusal' | 'content_policy_violation' | 'moderation' | 'in_body_403' | 'content_filter_finish';
}

/**
 * Classify an OpenRouter error envelope as a content decline, or not.
 *
 * - `metadata.error_type` `refusal`: the model refused (code `content_filter`).
 * - `metadata.error_type` `content_policy_violation`: a filter flagged the
 *   input or output.
 * - The documented moderation metadata (`reasons` + `flagged_input`) with no
 *   `error_type`.
 * - With `inBody`, a numeric code 403 and no `error_type`: the error reference
 *   gives every in-body policy decline the code 403 once the HTTP line was
 *   already committed. Never applied to an HTTP 403 response, which without a
 *   decline type is a guardrail or permission block (`permission_denied`).
 *
 * @param error - The `error` object from an OpenRouter body, choice or event.
 * @param opts.inBody - True when the error sits inside an HTTP 200 body.
 * @returns The decline, or `undefined` when the error is not one.
 */
export function classifyOpenRouterDecline(
  error: unknown,
  opts: { inBody?: boolean } = {},
): OpenRouterDecline | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const env = error as OpenRouterErrorEnvelope;
  const meta = env.metadata && typeof env.metadata === 'object' ? env.metadata : undefined;
  const errorType = typeof meta?.error_type === 'string' ? meta.error_type : undefined;
  if (errorType === 'refusal') return { code: 'content_filter', nativeType: 'refusal' };
  if (errorType === 'content_policy_violation') {
    return { code: 'content_policy_violation', nativeType: 'content_policy_violation' };
  }
  if (errorType !== undefined) return undefined;
  if (Array.isArray(meta?.reasons) && typeof meta?.flagged_input === 'string') {
    return { code: 'content_policy_violation', nativeType: 'moderation' };
  }
  if (opts.inBody && env.code === 403) return { code: 'content_policy_violation', nativeType: 'in_body_403' };
  return undefined;
}

export class OpenRouterProvider implements IProvider {
  public readonly providerId: string = 'openrouter';
  public isInitialized: boolean = false;
  public defaultModelId?: string;

  // Corrected: Changed type of this.config to satisfy the Readonly<Required<...>> assignment by providing defaults
  private config!: Readonly<Required<Omit<OpenRouterProviderConfig, 'defaultModelId' | 'siteUrl' | 'appName' | 'baseURL' | 'requestTimeout' | 'streamRequestTimeout'>> & OpenRouterProviderConfig>;
  private keyPool: ApiKeyPool | null = null;
  private client!: AxiosInstance;
  private readonly availableModelsCache: Map<string, ModelInfo> = new Map();

  constructor() {}

  public async initialize(config: OpenRouterProviderConfig): Promise<void> {
    if (!config.apiKey) {
      throw new OpenRouterProviderError(
        'OpenRouter API key (apiKey) is required for initialization.',
        'INIT_FAILED_MISSING_API_KEY'
      );
    }
    // Corrected: Ensure all properties of Required<OpenRouterProviderConfig> are present
    // by providing defaults for optional fields before freezing.
    this.config = Object.freeze({
      apiKey: config.apiKey,
      baseURL: config.baseURL || 'https://openrouter.ai/api/v1',
      defaultModelId: config.defaultModelId, // Can be undefined, but this.defaultModelId will store it
      siteUrl: config.siteUrl, // Can be undefined
      appName: config.appName, // Can be undefined
      requestTimeout: config.requestTimeout || 60000,
      streamRequestTimeout: config.streamRequestTimeout || 180000,
    });
    this.keyPool = new ApiKeyPool(config.apiKey);
    this.defaultModelId = this.config.defaultModelId; // Store the potentially undefined value

    // NOTE: no Authorization header here — the key is drawn from the pool
    // PER ATTEMPT inside makeApiRequest, so a 429/402 on one key fails over
    // to the next instead of reusing a throttled key baked at init.
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': `AgentOS/1.0 (OpenRouterProvider; ${this.config.appName || 'UnknownApp'})`,
    };
    if (this.config.siteUrl) {
      headers['HTTP-Referer'] = this.config.siteUrl;
    }
    if (this.config.appName) {
      headers['X-Title'] = this.config.appName;
    }

    this.client = axios.create({
      baseURL: this.config.baseURL,
      headers,
    });

    try {
      await this.refreshAvailableModels();
      this.isInitialized = true;
      console.log(`OpenRouterProvider initialized. Default Model: ${this.defaultModelId || 'Not set'}. Found ${this.availableModelsCache.size} models via OpenRouter.`);
    } catch (error: unknown) {
      this.isInitialized = false;
      const initError = error instanceof OpenRouterProviderError ? error :
        createGMIErrorFromError( // Corrected: use imported createGMIErrorFromError
          error instanceof Error ? error : new Error(String(error)),
          GMIErrorCode.LLM_PROVIDER_ERROR, // Corrected: use imported GMIErrorCode
          { providerId: this.providerId },
          `OpenRouterProvider failed to initialize: ${error instanceof Error ? error.message : String(error)}`
        );
      console.error(initError.message, initError.details || initError);
      throw initError;
    }
  }

  private async refreshAvailableModels(): Promise<void> {
    const responseData = await this.makeApiRequest<OpenRouterListModelsAPIResponse>(
      '/models',
      'GET',
      this.config.requestTimeout
    );

    this.availableModelsCache.clear();
    if (responseData && Array.isArray(responseData.data)) {
      responseData.data.forEach((apiModel: OpenRouterModelAPIObject) => {
        const modelInfo = this.mapApiToModelInfo(apiModel);
        this.availableModelsCache.set(modelInfo.modelId, modelInfo);
      });
    } else {
      console.warn("OpenRouterProvider: Received no model data or malformed response from /models endpoint.");
    }
  }

  private mapApiToModelInfo(apiModel: OpenRouterModelAPIObject): ModelInfo {
    const capabilities: ModelInfo['capabilities'] = ['chat', 'completion'];
    if (apiModel.architecture?.modality === 'multimodal') {
      capabilities.push('vision_input');
    }
    const knownAdvancedModelPatterns = ['gpt-3.5', 'gpt-4', 'claude-2', 'claude-3', 'gemini', 'mistral', 'llama'];
    if (knownAdvancedModelPatterns.some(pattern => apiModel.id.toLowerCase().includes(pattern))) {
      capabilities.push('tool_use', 'json_mode');
    }
    if (apiModel.id.includes('embedding') || apiModel.id.includes('embed')) {
      capabilities.push('embeddings');
    }

    const parsePrice = (priceStr: string | undefined, tokensFactor: number = 1000000): number | undefined => {
      if (typeof priceStr !== 'string') return undefined;
      const price = parseFloat(priceStr);
      return isNaN(price) ? undefined : price * tokensFactor;
    };

    return {
      modelId: apiModel.id,
      providerId: this.providerId,
      displayName: apiModel.name,
      description: apiModel.description,
      capabilities: Array.from(new Set(capabilities)),
      contextWindowSize: apiModel.context_length || undefined,
      pricePer1MTokensInput: parsePrice(apiModel.pricing.prompt),
      pricePer1MTokensOutput: parsePrice(apiModel.pricing.completion),
      supportsStreaming: true,
      status: 'active',
    };
  }

  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new OpenRouterProviderError(
        'OpenRouterProvider is not initialized. Please call the initialize() method first.',
        'PROVIDER_NOT_INITIALIZED'
      );
    }
  }

  /**
   * Zero-config prompt caching for Anthropic models routed through
   * OpenRouter. OpenRouter forwards Anthropic `cache_control` blocks
   * unchanged, and Anthropic caches ONLY when a request carries them — an
   * `anthropic/*` slug without markers can never hit cache. Direct
   * Anthropic traffic gets markers from AnthropicProvider's auto path;
   * this applies the same default to the OpenRouter leg.
   *
   * Marks two breakpoints, mirroring the direct auto path:
   * - the first system message (stable prefix — later system messages can
   *   be volatile per-turn recall appended by memory hooks), and
   * - the last text block of the final message (moving tail, so multi-turn
   *   history is read back on the next turn).
   *
   * Stands down entirely when the caller already placed any cache_control
   * marker on messages or tool definitions (caller placement wins), or on
   * the `AGENTOS_ANTHROPIC_AUTO_CACHE=0`/`false` kill switch (same syntax
   * as the direct path). `options.cache === false` goes further, mirroring
   * the direct provider's per-call hard-off: caller markers already in the
   * message content are stripped as well. Sub-floor prefixes are safe to
   * mark: Anthropic silently ignores markers below the model's minimum
   * cacheable length. `options.cache.ttl` rides onto the injected markers.
   */
  private applyAnthropicSlugCacheControl(
    modelId: string,
    orMessages: Array<Partial<ChatMessage>>,
    options: ModelCompletionOptions,
  ): void {
    if (!modelId.toLowerCase().startsWith('anthropic/')) return;

    type WirePart = {
      type?: string;
      text?: string;
      cache_control?: { type: 'ephemeral'; ttl?: '1h' };
    } & Record<string, unknown>;

    if (options.cache === false) {
      // Per-call hard-off, mirroring AnthropicProvider's cache:false region
      // strip: caller-provided markers are removed too, so the opt-out
      // holds regardless of how a marker arrived. Copies, never in-place
      // edits — content arrays are shared with caller state.
      for (const message of orMessages) {
        if (!Array.isArray(message.content)) continue;
        const parts = message.content as WirePart[];
        if (!parts.some((p) => p && p.cache_control !== undefined)) continue;
        (message as { content: unknown }).content = parts.map((part) => {
          if (!part || part.cache_control === undefined) return part;
          const { cache_control: _stripped, ...rest } = part;
          return rest;
        });
      }
      return;
    }

    // Same kill-switch syntax as the direct Anthropic auto path.
    const autoCacheEnv = process.env.AGENTOS_ANTHROPIC_AUTO_CACHE;
    if (autoCacheEnv === '0' || autoCacheEnv === 'false') return;

    // Caller placement wins: a marker already present in messages, tool
    // definitions, or customModelParams tool overrides means the caller
    // owns breakpoint placement — injecting two more could exceed
    // Anthropic's 4-breakpoint cap or order a longer TTL after a shorter
    // one (both reject with 400).
    const holdsMarker = (value: unknown): boolean =>
      Array.isArray(value) &&
      value.some(
        (entry) =>
          entry !== null &&
          typeof entry === 'object' &&
          (entry as Record<string, unknown>).cache_control !== undefined,
      );
    const customTools = (options.customModelParams as Record<string, unknown> | undefined)
      ?.tools;
    if (
      orMessages.some((m) => holdsMarker(m.content)) ||
      holdsMarker(options.tools) ||
      holdsMarker(customTools)
    ) {
      return;
    }

    const marker: { type: 'ephemeral'; ttl?: '1h' } =
      options.cache && options.cache.ttl === '1h'
        ? { type: 'ephemeral', ttl: '1h' }
        : { type: 'ephemeral' };

    const markMessage = (msg: Partial<ChatMessage>): boolean => {
      if (typeof msg.content === 'string') {
        if (!msg.content) return false;
        (msg as { content: unknown }).content = [
          { type: 'text', text: msg.content, cache_control: { ...marker } },
        ];
        return true;
      }
      if (Array.isArray(msg.content)) {
        // Copy-on-write: mapToOpenRouterMessages shares content references
        // with the caller's messages, so mutating a part in place would
        // leak the injected marker back into caller state (and a retry or
        // fallback leg would then mistake it for a caller marker).
        const parts = msg.content as WirePart[];
        for (let i = parts.length - 1; i >= 0; i--) {
          const part = parts[i];
          if (part && part.type === 'text' && typeof part.text === 'string' && part.text) {
            const copy = parts.slice();
            copy[i] = { ...part, cache_control: { ...marker } };
            (msg as { content: unknown }).content = copy;
            return true;
          }
        }
      }
      return false;
    };

    // Stable prefix: the FIRST system message. Memory hooks append volatile
    // per-turn recall as LATER system messages; a breakpoint there would sit
    // on bytes that change every turn and cold-miss (write premium, no
    // reads) forever.
    let systemIdx = -1;
    for (let i = 0; i < orMessages.length; i++) {
      if (orMessages[i].role === 'system') {
        systemIdx = i;
        break;
      }
    }
    if (systemIdx >= 0) markMessage(orMessages[systemIdx]);

    // Moving tail: the final message, unless it IS the system message we
    // just marked (single-message requests keep one breakpoint).
    const lastIdx = orMessages.length - 1;
    if (lastIdx >= 0 && lastIdx !== systemIdx) markMessage(orMessages[lastIdx]);
  }

  private mapToOpenRouterMessages(messages: ChatMessage[]): Array<Partial<ChatMessage>> {
    return messages.map(msg => {
      const mappedMsg: Partial<ChatMessage> = { role: msg.role, content: msg.content };
      if (msg.name) mappedMsg.name = msg.name;
      // Only the standard tool-call fields go on the wire. A tool call can
      // carry provider-specific extras, such as Gemini's thoughtSignature,
      // that the upstream Chat Completions schema does not define.
      if (msg.tool_calls) {
        mappedMsg.tool_calls = msg.tool_calls.map(({ id, type, function: fn }) => ({ id, type, function: fn }));
      }
      if (msg.tool_call_id) mappedMsg.tool_call_id = msg.tool_call_id;
      return mappedMsg;
    });
  }

  public async generateCompletion(
    modelId: string,
    messages: ChatMessage[],
    options: ModelCompletionOptions
  ): Promise<ModelCompletionResponse> {
    this.ensureInitialized();
    const openRouterMessages = this.mapToOpenRouterMessages(messages);
    this.applyAnthropicSlugCacheControl(modelId, openRouterMessages, options);

    const payload: Record<string, unknown> = {
      model: modelId,
      messages: openRouterMessages,
      stream: false,
      ...(options.temperature !== undefined && { temperature: options.temperature }),
      ...(options.topP !== undefined && { top_p: options.topP }),
      // OpenRouter reserves credits up to max_tokens at request time. When the
      // caller doesn't specify a limit, OR falls back to the model's full output
      // capacity (e.g. 64000 for claude-haiku-4-5), which causes 402 credit-required
      // errors on accounts without enough buffer. Default to 4096 — the same value
      // AnthropicProvider uses — so short prompts succeed without explicit tuning.
      // Then clamp to the model's output ceiling so a request sized for a
      // flagship model is not rejected when routed to a lower-ceiling OpenAI
      // model (e.g. openai/gpt-4o caps at 16384, not 32000).
      max_tokens: clampMaxOutputTokens(modelId, options.maxTokens) ?? 4096,
      ...(options.presencePenalty !== undefined && { presence_penalty: options.presencePenalty }),
      ...(options.frequencyPenalty !== undefined && { frequency_penalty: options.frequencyPenalty }),
      ...(options.stopSequences !== undefined && { stop: options.stopSequences }),
      ...(options.userId !== undefined && { user: options.userId }),
      // Provider sticky routing: pins the conversation to one upstream host
      // so its prompt cache (host-scoped) actually gets re-read; without it
      // load balancing cold-misses upstream caches turn over turn.
      ...(options.sessionId !== undefined && { session_id: options.sessionId }),
      ...(options.tools !== undefined && { tools: options.tools }),
      ...(options.toolChoice !== undefined && { tool_choice: options.toolChoice }),
      ...(options.responseFormat?.type === 'json_object' && { response_format: { type: 'json_object' } }),
      ...(options.responseFormat?.type === 'json_schema' && { response_format: options.responseFormat }),
      // OpenRouter unified usage accounting: reports `cost` and
      // `prompt_tokens_details.cached_tokens` on the response (trailing
      // usage chunk on streams). Placed before the customModelParams spread
      // so callers can override it.
      usage: { include: true },
      // Gemini's request fields never apply here (a Gemini call that fell
      // over to OpenRouter still carries them); routing controls stay.
      ...(stripGeminiOnlyParams(options.customModelParams) || {}),
    };
    this.applyDefaultProviderPrefs(payload);
    this.applySchemaRoutingPrefs(payload, options);

    let apiResponseData: OpenRouterChatCompletionAPIResponse;
    try {
      apiResponseData = await this.makeApiRequest<OpenRouterChatCompletionAPIResponse>(
        '/chat/completions',
        'POST',
        // CR8: honor a per-call requestTimeout override over the provider default.
        options.requestTimeout ?? this.config.requestTimeout,
        payload
      );
    } catch (error: unknown) {
      const degraded = this.degradeSchemaPayloadOnNoEndpoints(payload, error);
      if (!degraded) throw error;
      apiResponseData = await this.makeApiRequest<OpenRouterChatCompletionAPIResponse>(
        '/chat/completions',
        'POST',
        options.requestTimeout ?? this.config.requestTimeout,
        payload
      );
    }
    this.throwOnInBodyError(apiResponseData, modelId);
    return this.mapApiToCompletionResponse(apiResponseData, modelId);
  }

  /**
   * Seed env-default provider-routing preferences (see
   * {@link defaultOpenRouterProviderPrefs}) under any caller-supplied
   * `provider` object — caller keys win field-by-field. Runs before
   * {@link applySchemaRoutingPrefs} so `require_parameters` merges on top.
   */
  private applyDefaultProviderPrefs(payload: Record<string, unknown>): void {
    const defaults = defaultOpenRouterProviderPrefs();
    if (!defaults) return;
    const existing =
      payload.provider && typeof payload.provider === 'object'
        ? (payload.provider as Record<string, unknown>)
        : {};
    payload.provider = { ...defaults, ...existing };
  }

  /**
   * When the request carries a schema-enforced `response_format`
   * (`json_schema`), restrict OpenRouter's routing to upstream hosts that
   * actually support the requested parameters — otherwise a host that
   * ignores `response_format` serves the call, returns prose, and the
   * caller's Zod validation fails with nothing to retry on. Merges over any
   * caller-supplied `provider` prefs (e.g. `provider.sort` latency routing
   * via customModelParams) instead of clobbering them.
   */
  private applySchemaRoutingPrefs(
    payload: Record<string, unknown>,
    options: ModelCompletionOptions,
  ): void {
    if (options.responseFormat?.type !== 'json_schema') return;
    const existing =
      payload.provider && typeof payload.provider === 'object'
        ? (payload.provider as Record<string, unknown>)
        : {};
    payload.provider = { ...existing, require_parameters: true };
  }

  /**
   * One-shot degrade for schema-enforced calls: when OpenRouter reports
   * that no endpoint can serve the request (404 "No endpoints found …" —
   * typically because no host for the model supports `response_format`
   * with `require_parameters` routing), swap the payload down to loose
   * `json_object` mode and drop the routing restriction so the call still
   * completes. Caller-side Zod validation remains the correctness
   * backstop, exactly as before schema enforcement existed.
   *
   * @returns true when the payload was degraded and the caller should
   *          retry once; false when the error is unrelated.
   */
  private degradeSchemaPayloadOnNoEndpoints(
    payload: Record<string, unknown>,
    error: unknown,
  ): boolean {
    const rf = payload.response_format as { type?: string } | undefined;
    if (rf?.type !== 'json_schema') return false;
    if (!(error instanceof OpenRouterProviderError)) return false;
    const noEndpoints =
      error.httpStatus === 404 && /no endpoints/i.test(error.message);
    if (!noEndpoints) return false;

    console.warn(
      `OpenRouterProvider: no endpoint supports json_schema for model ` +
        `'${String(payload.model)}' — degrading to json_object for this call.`,
    );
    payload.response_format = { type: 'json_object' };
    const provider = payload.provider as Record<string, unknown> | undefined;
    if (provider && typeof provider === 'object') {
      delete provider.require_parameters;
      if (Object.keys(provider).length === 0) delete payload.provider;
    }
    return true;
  }

  public async *generateCompletionStream(
    modelId: string,
    messages: ChatMessage[],
    options: ModelCompletionOptions
  ): AsyncGenerator<ModelCompletionResponse, void, undefined> {
    this.ensureInitialized();
    const openRouterMessages = this.mapToOpenRouterMessages(messages);
    this.applyAnthropicSlugCacheControl(modelId, openRouterMessages, options);

    const payload: Record<string, unknown> = {
      model: modelId,
      messages: openRouterMessages,
      stream: true,
      // OpenRouter follows the OpenAI streaming convention: usage is omitted
      // unless stream_options.include_usage is set, in which case a trailing
      // usage-only chunk arrives before [DONE]. Without this flag,
      // streamText({...}).usage resolves to all zeros even on success.
      stream_options: { include_usage: true },
      ...(options.temperature !== undefined && { temperature: options.temperature }),
      ...(options.topP !== undefined && { top_p: options.topP }),
      // OpenRouter reserves credits up to max_tokens at request time. When the
      // caller doesn't specify a limit, OR falls back to the model's full output
      // capacity (e.g. 64000 for claude-haiku-4-5), which causes 402 credit-required
      // errors on accounts without enough buffer. Default to 4096 — the same value
      // AnthropicProvider uses — so short prompts succeed without explicit tuning.
      // Then clamp to the model's output ceiling so a request sized for a
      // flagship model is not rejected when routed to a lower-ceiling OpenAI
      // model (e.g. openai/gpt-4o caps at 16384, not 32000).
      max_tokens: clampMaxOutputTokens(modelId, options.maxTokens) ?? 4096,
      ...(options.presencePenalty !== undefined && { presence_penalty: options.presencePenalty }),
      ...(options.frequencyPenalty !== undefined && { frequency_penalty: options.frequencyPenalty }),
      ...(options.stopSequences !== undefined && { stop: options.stopSequences }),
      ...(options.userId !== undefined && { user: options.userId }),
      // Provider sticky routing: pins the conversation to one upstream host
      // so its prompt cache (host-scoped) actually gets re-read; without it
      // load balancing cold-misses upstream caches turn over turn.
      ...(options.sessionId !== undefined && { session_id: options.sessionId }),
      ...(options.tools !== undefined && { tools: options.tools }),
      ...(options.toolChoice !== undefined && { tool_choice: options.toolChoice }),
      ...(options.responseFormat?.type === 'json_object' && { response_format: { type: 'json_object' } }),
      ...(options.responseFormat?.type === 'json_schema' && { response_format: options.responseFormat }),
      // OpenRouter unified usage accounting: reports `cost` and
      // `prompt_tokens_details.cached_tokens` on the response (trailing
      // usage chunk on streams). Placed before the customModelParams spread
      // so callers can override it.
      usage: { include: true },
      // Gemini's request fields never apply here (a Gemini call that fell
      // over to OpenRouter still carries them); routing controls stay.
      ...(stripGeminiOnlyParams(options.customModelParams) || {}),
    };
    this.applyDefaultProviderPrefs(payload);
    this.applySchemaRoutingPrefs(payload, options);

    let stream: NodeJS.ReadableStream;
    try {
      stream = await this.makeApiRequest<NodeJS.ReadableStream>(
        '/chat/completions',
        'POST',
        // CR8: honor a per-call requestTimeout override over the stream default.
        options.requestTimeout ?? this.config.streamRequestTimeout,
        payload,
        true
      );
    } catch (error: unknown) {
      const degraded = this.degradeSchemaPayloadOnNoEndpoints(payload, error);
      if (!degraded) throw error;
      stream = await this.makeApiRequest<NodeJS.ReadableStream>(
        '/chat/completions',
        'POST',
        options.requestTimeout ?? this.config.streamRequestTimeout,
        payload,
        true
      );
    }

    const accumulatedToolCalls: Map<number, { id?: string; type?: 'function'; function?: { name?: string; arguments?: string; } }> = new Map();

    const abortSignal = options.abortSignal;
    // `usage` is what a refused turn billed before the abort; a consumer
    // metering final chunks would otherwise lose it.
    const abortChunk = (message: string, usage?: ModelUsage): ModelCompletionResponse => ({
      id: `openrouter-abort-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      modelId,
      choices: [],
      error: { message, type: 'abort' },
      isFinal: true,
      ...(usage ? { usage } : {}),
    });
    if (abortSignal?.aborted) {
      // The response is already open, and parseSseStream, which closes it,
      // never runs on this path.
      (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      yield abortChunk('Stream aborted prior to first chunk');
      return;
    }
    const abortHandler = () => { /* passive; loop logic handles emission */ };
    abortSignal?.addEventListener('abort', abortHandler, { once: true });

    // Text yielded so far (for the decline's partialText); the
    // decline held back when a content_filter finish arrives, while the
    // trailing usage chunk is read; a read error seen during that wait.
    let yieldedText = '';
    let held: { decline: OpenRouterDecline; refusal: string | null; usage?: ModelUsage } | null = null;
    let readError: unknown;
    const isDecline = (e: unknown): boolean =>
      e instanceof OpenRouterProviderError && (e.code === 'content_filter' || e.code === 'content_policy_violation');

    try {
      try {
        for await (const rawChunk of this.parseSseStream(stream)) {
          if (abortSignal?.aborted) {
            // The line that shows the abort is usually the usage line a held
            // decline was waiting for: read what it reports before leaving.
            if (held) held.usage = this.usageOfSseLine(rawChunk) ?? held.usage;
            yield abortChunk('Stream aborted by caller', held?.usage);
            return;
          }
          if (!rawChunk.startsWith('data: ')) continue;
          const jsonData = rawChunk.substring('data: '.length);
          if (jsonData.trim() === '[DONE]') break;

          // The parse has its own catch, so a decline thrown while HANDLING
          // a chunk is never swallowed as a parse failure. A line that is not
          // JSON, or is JSON but not an object, is skipped as before.
          let apiChunk: OpenRouterChatCompletionAPIResponse;
          try {
            apiChunk = JSON.parse(jsonData) as OpenRouterChatCompletionAPIResponse;
          } catch (error: unknown) {
            console.warn('OpenRouterProvider: Failed to parse stream chunk JSON, skipping chunk. Data:', jsonData, 'Error:', error);
            continue;
          }
          if (!apiChunk || typeof apiChunk !== 'object') {
            console.warn('OpenRouterProvider: Stream chunk is not a JSON object, skipping chunk. Data:', jsonData);
            continue;
          }

          // OpenRouter reports upstream failures MID-STREAM as an SSE data
          // event carrying an `error` object. A content decline throws typed
          // (the walkers move on before any output; after output the stream
          // ends with an error part). Any other error still surfaces as an
          // upstream_error chunk and ends the stream.
          if (apiChunk.error && typeof apiChunk.error === 'object') {
            // The stream is an HTTP 200, so the in-body 403 row applies here too.
            const decline = classifyOpenRouterDecline(apiChunk.error, { inBody: true });
            if (decline) {
              throw this.declineError(modelId, decline, {
                httpStatus: typeof apiChunk.error.code === 'number' ? apiChunk.error.code : undefined,
                error: apiChunk.error,
                partialText: yieldedText,
                // The event's own usage when it reports one, else what the
                // held finish or the usage chunk reported.
                usage: mapOpenRouterUsage(apiChunk.usage) ?? held?.usage,
              });
            }
            const errMessage = apiChunk.error.message || 'OpenRouter mid-stream error';
            const errCode = apiChunk.error.code;
            // The typed code: metadata.error_type, else the envelope's own
            // `type`, in the order the HTTP error path reads them.
            const envelopeType = (apiChunk.error as { type?: unknown }).type;
            const errType =
              typeof apiChunk.error.metadata?.error_type === 'string'
                ? apiChunk.error.metadata.error_type
                : typeof envelopeType === 'string'
                  ? envelopeType
                  : undefined;
            // A 401 or 403 inside a 200 stream describes an upstream attempt,
            // not this key: without the `[NNN]` prefix the health registry
            // counts a transient failure, not its auth policy (as inBodyError
            // does for a 200 body).
            const decorated =
              errCode === 401 || errCode === 403
                ? `OpenRouter in-body error ${errCode}: ${errMessage}`
                : errCode !== undefined
                  ? `[${errCode}] ${errMessage}`
                  : errMessage;
            // A context-window rejection, or a string code such as
            // `server_error`, rides the chunk's `code` for the walkers.
            const chunkCode =
              errType === 'context_length_exceeded'
                ? CONTEXT_WINDOW_EXCEEDED_CODE
                : typeof errCode === 'string'
                  ? errCode
                  : undefined;
            if (held) {
              // The answer already ended on a content_filter finish. A later
              // upstream failure is the end of the read: it neither replaces
              // the held decline nor loses the usage read so far.
              if (apiChunk.usage) held.usage = mapOpenRouterUsage(apiChunk.usage);
              readError = new Error(decorated);
              break;
            }
            yield {
              id: apiChunk.id ?? `openrouter-error-${Date.now()}`,
              object: 'chat.completion.chunk',
              created: apiChunk.created ?? Math.floor(Date.now() / 1000),
              modelId: apiChunk.model || modelId,
              choices: [],
              isFinal: true,
              error: {
                message: decorated,
                type: 'upstream_error',
                ...(chunkCode !== undefined ? { code: chunkCode } : {}),
              },
            };
            break;
          }

          if (held) {
            // After a content_filter finish only the trailing usage-only
            // chunk is wanted; nothing more is yielded.
            if (apiChunk.usage) held.usage = mapOpenRouterUsage(apiChunk.usage);
            continue;
          }
          const choice = apiChunk.choices?.[0];
          if (choice && choice.finish_reason === 'content_filter') {
            held = {
              decline: { code: 'content_filter', nativeType: 'content_filter_finish' },
              refusal: choice.delta?.refusal ?? choice.message?.refusal ?? null,
              usage: mapOpenRouterUsage(apiChunk.usage),
            };
            continue;
          }

          // A chunk of an unexpected shape (no choices array, a malformed
          // tool call) is logged and skipped, as it was when the parse and
          // the mapping shared one catch.
          let mapped: ModelCompletionResponse;
          try {
            mapped = this.mapApiToStreamChunkResponse(apiChunk, modelId, accumulatedToolCalls);
          } catch (error: unknown) {
            console.warn('OpenRouterProvider: Failed to map stream chunk, skipping chunk. Data:', jsonData, 'Error:', this.describeError(error));
            continue;
          }
          if (mapped.responseTextDelta) yieldedText += mapped.responseTextDelta;
          yield mapped;
          // Don't break on finish_reason: with stream_options.include_usage,
          // OpenRouter (like OpenAI) emits a trailing usage-only chunk AFTER
          // the finish_reason chunk and BEFORE [DONE]. The [DONE] marker
          // check above is the right termination signal.
        }
      } catch (error: unknown) {
        if (isDecline(error)) throw error;
        // A read error after a content_filter finish does not lose the
        // decline: it is thrown below with the usage held so far.
        if (held) readError = error;
        else throw error;
      }
      if (held) {
        // An abort during the wait wins over the decline. The loop only
        // checks the signal when a line arrives, so a read that ended
        // without one is checked here.
        if (abortSignal?.aborted) {
          yield abortChunk('Stream aborted by caller', held.usage);
          return;
        }
        throw this.declineError(modelId, held.decline, {
          httpStatus: 200,
          refusal: held.refusal,
          partialText: yieldedText,
          usage: held.usage,
          readError,
        });
      }
    } finally {
      abortSignal?.removeEventListener('abort', abortHandler);
    }
  }

  public async generateEmbeddings(
    modelId: string,
    texts: string[],
    options?: ProviderEmbeddingOptions
  ): Promise<ProviderEmbeddingResponse> {
    this.ensureInitialized();
    if (!texts || texts.length === 0) {
      throw new OpenRouterProviderError('Input texts array cannot be empty for generating embeddings.', 'EMBEDDING_NO_INPUT');
    }

    const modelInfo = await this.getModelInfo(modelId);
    if (modelInfo && !modelInfo.capabilities.includes('embeddings')) {
      console.warn(`OpenRouterProvider: Model '${modelId}' is not explicitly listed with embedding capabilities. Attempting anyway.`);
    }

    const payload: Record<string, unknown> = {
      model: modelId,
      input: texts,
      ...(options?.encodingFormat && { encoding_format: options.encodingFormat }),
      ...(options?.dimensions && { dimensions: options.dimensions }),
      ...(stripGeminiOnlyParams(options?.customModelParams) || {}),
    };
    if (options?.inputType && payload.customModelParams && typeof payload.customModelParams === 'object') {
      (payload.customModelParams as Record<string, unknown>).input_type = options.inputType;
    } else if (options?.inputType) {
      payload.customModelParams = { input_type: options.inputType };
    }

    const apiResponseData = await this.makeApiRequest<OpenRouterEmbeddingAPIResponse>(
      '/embeddings',
      'POST',
      this.config.requestTimeout,
      payload
    );

    return {
      object: 'list',
      data: apiResponseData.data.map(d => ({
        object: 'embedding',
        embedding: d.embedding,
        index: d.index,
      })),
      model: apiResponseData.model,
      usage: {
        prompt_tokens: apiResponseData.usage.prompt_tokens,
        total_tokens: apiResponseData.usage.total_tokens,
      },
    };
  }

  public async listAvailableModels(filter?: { capability?: string }): Promise<ModelInfo[]> {
    this.ensureInitialized();
    if (this.availableModelsCache.size === 0) {
      try {
        await this.refreshAvailableModels();
      } catch (refreshError) {
        console.warn("OpenRouterProvider: Failed to refresh models during listAvailableModels call after finding empty cache:", refreshError);
      }
    }
    const models = Array.from(this.availableModelsCache.values());
    if (filter?.capability) {
      return models.filter(m => m.capabilities.includes(filter.capability!));
    }
    return models;
  }

  public async getModelInfo(modelId: string): Promise<ModelInfo | undefined> {
    this.ensureInitialized();
    if (!this.availableModelsCache.has(modelId)) {
      try {
        console.log(`OpenRouterProvider: Model ${modelId} not in cache. Refreshing model list.`);
        await this.refreshAvailableModels();
      } catch (error) {
        console.warn(`OpenRouterProvider: Failed to refresh models list while trying to get info for ${modelId}:`, error);
      }
    }
    return this.availableModelsCache.get(modelId);
  }

  public async checkHealth(): Promise<{ isHealthy: boolean; details?: unknown }> {
    if (!this.client) {
      return { isHealthy: false, details: { message: "OpenRouterProvider not initialized (HTTP client missing)."}};
    }
    try {
      // Auth rides per-request since the key moved off the axios instance
      // (per-attempt pool rotation) — /models is public today, but keep the
      // health probe representative of real authenticated traffic.
      await this.client.get('/models', {
        timeout: Math.min(this.config.requestTimeout || 10000, 10000),
        headers: {
          Authorization: `Bearer ${this.keyPool?.hasKeys ? this.keyPool.next() : this.config.apiKey}`,
        },
      });
      return { isHealthy: true, details: { message: "Successfully connected to OpenRouter /models endpoint." } };
    } catch (error: unknown) {
      const err = error as AxiosError;
      return {
        isHealthy: false,
        details: {
          message: this.redactSecrets(`OpenRouter health check failed: ${err.message}`),
          status: err.response?.status,
          responseData: this.redactResponseData(err.response?.data),
        },
      };
    }
  }

  public async shutdown(): Promise<void> {
    this.isInitialized = false;
    this.availableModelsCache.clear();
    console.log('OpenRouterProvider shutdown: Instance marked as uninitialized and cache cleared.');
  }

  private mapApiToCompletionResponse(
    apiResponse: OpenRouterChatCompletionAPIResponse,
    requestedModelId: string
  ): ModelCompletionResponse {
    const choice = apiResponse.choices[0];
    if (!choice) {
      throw new OpenRouterProviderError("Received empty choices array from OpenRouter.", "API_RESPONSE_MALFORMED", undefined, undefined, { responseId: apiResponse.id });
    }

    const usage: ModelUsage | undefined = mapOpenRouterUsage(apiResponse.usage);

    return {
      id: apiResponse.id,
      object: apiResponse.object,
      created: apiResponse.created,
      modelId: apiResponse.model || requestedModelId,
      // Serving-host attribution (Groq vs DeepInfra etc.) — load-bearing for
      // latency telemetry since provider routing prefs (customModelParams
      // `provider.sort`) change which host serves the same model.
      ...(apiResponse.provider ? { servingProvider: apiResponse.provider } : {}),
      choices: apiResponse.choices.map(c => ({
        index: c.index,
        message: {
          role: c.message!.role,
          content: c.message!.content,
          tool_calls: c.message!.tool_calls,
        },
        finishReason: c.finish_reason,
        logprobs: c.logprobs,
      })),
      usage,
    };
  }

  private mapApiToStreamChunkResponse(
      apiChunk: OpenRouterChatCompletionAPIResponse,
      requestedModelId: string,
      accumulatedToolCalls: Map<number, { id?: string; type?: 'function'; function?: { name?: string; arguments?: string; } }>
  ): ModelCompletionResponse {
      const choice = apiChunk.choices[0];

      // With stream_options.include_usage, OpenRouter (like OpenAI) emits a
      // trailing chunk with an empty choices array and a populated usage
      // object. Recognize it as a final usage-only chunk so callers see real
      // token totals after the stream resolves. Without this, the empty-choices
      // path below would mark it as a malformed-response error.
      if ((!apiChunk.choices || apiChunk.choices.length === 0) && apiChunk.usage) {
        return {
          id: apiChunk.id,
          object: apiChunk.object,
          created: apiChunk.created,
          modelId: apiChunk.model || requestedModelId,
          ...(apiChunk.provider ? { servingProvider: apiChunk.provider } : {}),
          choices: [],
          isFinal: true,
          usage: mapOpenRouterUsage(apiChunk.usage),
        };
      }

      if (!choice) {
        return {
          id: apiChunk.id, object: apiChunk.object, created: apiChunk.created,
          modelId: apiChunk.model || requestedModelId, choices: [], isFinal: true,
          error: { message: "Stream chunk contained no choices.", type: "invalid_response" }
        };
      }

      let responseTextDelta: string | undefined;
      let toolCallsDeltas: ModelCompletionResponse['toolCallsDeltas'];
      
      if (choice.delta?.content) {
        responseTextDelta = choice.delta.content;
      }

      if (choice.delta?.tool_calls) {
        toolCallsDeltas = [];
        choice.delta.tool_calls.forEach(tcDelta => {
          let currentToolCallState = accumulatedToolCalls.get(tcDelta.index);
          if (!currentToolCallState) {
            currentToolCallState = { function: { name: '', arguments: ''} };
          }

          if (tcDelta.id) currentToolCallState.id = tcDelta.id;
          if (tcDelta.type) currentToolCallState.type = tcDelta.type as 'function';
          if (tcDelta.function?.name) currentToolCallState.function!.name = (currentToolCallState.function!.name || '') + tcDelta.function.name;
          if (tcDelta.function?.arguments) currentToolCallState.function!.arguments = (currentToolCallState.function!.arguments || '') + tcDelta.function.arguments;
           
          accumulatedToolCalls.set(tcDelta.index, currentToolCallState);

          toolCallsDeltas!.push({
            index: tcDelta.index,
            id: tcDelta.id,
            type: tcDelta.type as 'function',
            function: tcDelta.function ? {
              name: tcDelta.function.name,
              arguments_delta: tcDelta.function.arguments
            } : undefined,
          });
        });
      }

      const isFinal = !!choice.finish_reason;
      let finalUsage: ModelUsage | undefined;
      const finalChoices: ModelCompletionChoice[] = [];

      if (isFinal) {
        if (apiChunk.usage) {
          finalUsage = {
            promptTokens: apiChunk.usage.prompt_tokens,
            completionTokens: apiChunk.usage.completion_tokens,
            totalTokens: apiChunk.usage.total_tokens,
            costUSD: apiChunk.usage.cost,
          };
        }
        const finalMessage: ChatMessage = {
          role: choice.delta?.role || accumulatedToolCalls.size > 0 ? 'assistant' : (choice.message?.role || 'assistant'),
          content: responseTextDelta || (choice.message?.content || null),
          tool_calls: Array.from(accumulatedToolCalls.values())
            .filter(tc => tc.id && tc.function?.name)
            .map(accTc => ({
              id: accTc.id!,
              type: accTc.type!,
              function: { name: accTc.function!.name!, arguments: accTc.function!.arguments! }
            })),
        };
        if (!finalMessage.tool_calls || finalMessage.tool_calls.length === 0) {
          delete finalMessage.tool_calls;
        }
        if (responseTextDelta && !choice.message?.content && accumulatedToolCalls.size === 0) {
          finalMessage.content = responseTextDelta;
        } else if (accumulatedToolCalls.size > 0 && !responseTextDelta && !choice.message?.content) {
          finalMessage.content = null;
        }

        finalChoices.push({
          index: choice.index,
          message: finalMessage,
          finishReason: choice.finish_reason,
          logprobs: choice.logprobs,
        });
      } else {
        finalChoices.push({
          index: choice.index,
          message: {
            role: choice.delta?.role || 'assistant',
            content: responseTextDelta || null,
          },
          finishReason: null,
        });
      }
      
      return {
        id: apiChunk.id,
        object: apiChunk.object,
        created: apiChunk.created,
        modelId: apiChunk.model || requestedModelId,
        ...(apiChunk.provider ? { servingProvider: apiChunk.provider } : {}),
        choices: finalChoices,
        responseTextDelta: isFinal ? undefined : responseTextDelta,
        toolCallsDeltas: isFinal ? undefined : toolCallsDeltas,
        isFinal,
        usage: finalUsage,
      };
  }

  /** Attempts per request: 1 initial + 2 retries on retryable failures. */
  private static readonly MAX_REQUEST_ATTEMPTS = 3;
  /** Ceiling for a single retry sleep (Retry-After or backoff), ms. */
  private static readonly MAX_RETRY_SLEEP_MS = 15_000;

  /**
   * Executes one OpenRouter API request with per-attempt key rotation and
   * bounded retry. Previously this was a single attempt with the API key
   * baked into the axios instance at initialize() — a throttled or
   * credit-exhausted key was reused forever and every transient 429/5xx/
   * network blip surfaced straight to the caller as a final failure.
   *
   * Per attempt:
   *  - the Authorization key is drawn fresh from the {@link ApiKeyPool}
   *    (weighted round-robin, skips keys in cooldown);
   *  - a 402/429 marks the CURRENT key exhausted so the next attempt (and
   *    the next request) fails over to a different key;
   *  - 408/429/5xx and transport-level failures (no HTTP response) retry
   *    with the response's Retry-After when present (capped), else
   *    jittered exponential backoff; 4xx request errors throw immediately.
   */
  private async makeApiRequest<T = unknown>(
    endpoint: string,
    method: 'GET' | 'POST',
    timeout?: number,
    body?: Record<string, unknown>,
    expectStream: boolean = false
  ): Promise<T> {
    let lastError: OpenRouterProviderError | null = null;

    for (let attempt = 0; attempt < OpenRouterProvider.MAX_REQUEST_ATTEMPTS; attempt++) {
      const apiKey = this.keyPool?.hasKeys ? this.keyPool.next() : this.config.apiKey;
      try {
        const response = await this.client.request<T>({
          url: endpoint,
          method,
          data: body,
          timeout: timeout,
          headers: { Authorization: `Bearer ${apiKey}` },
          responseType: expectStream ? 'stream' as ResponseType : 'json' as ResponseType,
        });
        return response.data;
      } catch (error: unknown) {
        let statusCode: number | undefined;
        let errorData: any;
        let errorMessage = 'Unknown OpenRouter API error';
        let errorType = 'UNKNOWN_API_ERROR';
        let retryAfterSec: number | undefined;
        let transportFailure = false;

        if (axios.isAxiosError(error)) {
          statusCode = error.response?.status;
          errorData = error.response?.data;
          // A streamed request's error body is the live response stream,
          // whose `req` holds the request head with the Authorization
          // header. Read a bounded prefix and drop the stream, so the
          // message can use the body and nothing keeps the request.
          if (isReadableStream(errorData)) {
            const { text, complete } = await readErrorStream(errorData);
            // A body cut short can end inside a key, which whole-secret
            // masking would not match. Whole keys are masked first, so a key
            // whose last characters also start a key is not split in two.
            errorData = parseErrorBody(complete ? text : this.maskCutSecretTail(this.redactSecrets(text)));
          }
          transportFailure = error.response === undefined;
          const retryAfterRaw = error.response?.headers?.['retry-after'];
          const parsedRetryAfter =
            typeof retryAfterRaw === 'string' ? parseInt(retryAfterRaw, 10) : NaN;
          if (Number.isFinite(parsedRetryAfter) && parsedRetryAfter > 0) {
            retryAfterSec = parsedRetryAfter;
          }
          if (errorData?.error && typeof errorData.error === 'object') {
            errorMessage = errorData.error.message || errorMessage;
            const metaType = errorData.error.metadata?.error_type;
            errorType = (typeof metaType === 'string' ? metaType : undefined) || errorData.error.type || errorType;
          } else if (typeof errorData === 'string' && errorData.trim()) {
            errorMessage = errorData;
          } else if ((error as Error).message) {
            errorMessage = (error as Error).message;
          }
        } else if (error instanceof Error) {
          errorMessage = error.message;
        }

        // A content decline is a verdict on the request, not provider
        // health: throw it typed at once (no in-provider retry, no key
        // cooldown) so the walkers move on and the breaker stays closed.
        const decline = classifyOpenRouterDecline(errorData?.error);
        if (decline) {
          throw this.declineError(String(body?.model ?? ''), decline, {
            httpStatus: statusCode,
            error: errorData.error as OpenRouterErrorEnvelope,
          });
        }

        // A throttled (429) or credit-exhausted (402) key must not be
        // reused by the next attempt/request — cool it down in the pool.
        if ((statusCode === 402 || statusCode === 429) && this.keyPool?.hasKeys) {
          this.keyPool.markExhausted(apiKey);
        }

        // Prefix the status code into the message so downstream retry/fallback
        // logic (e.g. isRetryableError, which greps for \b402\b) can route on it
        // even when the OR API body provides a friendlier description.
        const decoratedMessage = this.redactSecrets(statusCode ? `[${statusCode}] ${errorMessage}` : errorMessage);
        lastError = new OpenRouterProviderError(
          decoratedMessage,
          errorType === 'context_length_exceeded' ? CONTEXT_WINDOW_EXCEEDED_CODE : 'API_REQUEST_FAILED',
          statusCode,
          errorType,
          {
            requestEndpoint: endpoint,
            requestBodyPreview: body ? JSON.stringify(body).substring(0, 200) + '...' : undefined,
            responseData: this.redactResponseData(errorData),
            // Not the AxiosError itself: its config and request carry the
            // Authorization header, so logging or serializing the details
            // would print the API key.
            underlyingError: this.describeError(error),
          }
        );

        const retryable =
          transportFailure ||
          statusCode === 408 ||
          statusCode === 429 ||
          (typeof statusCode === 'number' && statusCode >= 500 && statusCode < 600);
        if (!retryable || attempt === OpenRouterProvider.MAX_REQUEST_ATTEMPTS - 1) {
          throw lastError;
        }

        const sleepMs = Math.min(
          retryAfterSec !== undefined
            ? retryAfterSec * 1000
            : 300 * 2 ** attempt + Math.floor(Math.random() * 200),
          OpenRouterProvider.MAX_RETRY_SLEEP_MS,
        );
        console.warn(
          `OpenRouterProvider: attempt ${attempt + 1}/${OpenRouterProvider.MAX_REQUEST_ATTEMPTS} ` +
            `failed (${decoratedMessage.substring(0, 160)}); retrying in ${sleepMs}ms.`,
        );
        await new Promise((resolve) => setTimeout(resolve, sleepMs));
      }
    }

    // Unreachable in practice (the loop either returns or throws), but keeps
    // the compiler + any future refactor honest.
    throw lastError ?? new OpenRouterProviderError('OpenRouter request failed.', 'API_REQUEST_FAILED');
  }

  /**
   * The error a declined request raises. Code `content_filter` or
   * `content_policy_violation` is what `isContentPolicyRefusal` and the
   * health registry's exemption read, so the walkers move on and no breaker
   * opens. The message is fixed: no HTTP status digits and no upstream text,
   * which retry classifiers grep for. The response status, the upstream
   * message (redacted, 300 chars), the provider, the refusal text (300), the
   * partial text (2,000) and the billed usage ride `details`.
   */
  private declineError(
    modelId: string,
    decline: OpenRouterDecline,
    details: {
      httpStatus?: number;
      error?: OpenRouterErrorEnvelope;
      refusal?: string | null;
      partialText?: string | null;
      usage?: ModelUsage;
      readError?: unknown;
    },
  ): OpenRouterProviderError {
    const meta = details.error?.metadata;
    const bounded = (value: unknown, max: number): string | undefined =>
      typeof value === 'string' && value.length > 0 ? this.redactSecrets(value).slice(0, max) : undefined;
    return new OpenRouterProviderError(
      `OpenRouter declined the request on ${modelId || 'the requested model'} (${decline.nativeType}).`,
      decline.code,
      undefined,
      decline.nativeType,
      {
        httpStatus: details.httpStatus,
        upstreamMessage: bounded(details.error?.message, 300),
        providerName: typeof meta?.provider_name === 'string' ? meta.provider_name : undefined,
        providerCode: typeof meta?.provider_code === 'string' ? meta.provider_code : undefined,
        refusal: bounded(details.refusal, 300),
        partialText: bounded(details.partialText, 2000),
        usage: details.usage,
        ...(details.readError !== undefined ? { readError: this.describeError(details.readError) } : {}),
      },
    );
  }

  /**
   * A 200 body that reports a failure instead of an answer throws before
   * mapping, in this order: a body holding only `error` and no
   * choice; a choice ended by `finish_reason: 'error'` with its own error
   * object; a choice ended by `finish_reason: 'content_filter'` (the model
   * declined as output). A choice with `finish_reason: 'error'` and no error
   * object is not a documented shape and is mapped as before.
   */
  private throwOnInBodyError(body: OpenRouterChatCompletionAPIResponse, modelId: string): void {
    const choices = Array.isArray(body.choices) ? body.choices : [];
    const first = choices[0];
    const usage = mapOpenRouterUsage(body.usage);
    if (body.error && typeof body.error === 'object' && choices.length === 0) {
      throw this.inBodyError(body.error, modelId, { responseId: body.id, usage });
    }
    if (first && first.finish_reason === 'error' && first.error && typeof first.error === 'object') {
      throw this.inBodyError(first.error, modelId, {
        responseId: body.id,
        usage,
        partialText: first.message?.content ?? null,
      });
    }
    if (first && first.finish_reason === 'content_filter') {
      throw this.declineError(modelId, { code: 'content_filter', nativeType: 'content_filter_finish' }, {
        httpStatus: 200,
        refusal: first.message?.refusal ?? null,
        partialText: first.message?.content ?? null,
        usage,
      });
    }
  }

  /**
   * An error reported inside an HTTP 200 body: a decline becomes
   * the decline error; anything else becomes the error an HTTP response with
   * that code produces today, so `isRetryableError` and the breaker treat it
   * by its code. The exception is a 401 or 403 that is not a decline: it is
   * still retryable, but it carries no status, so it counts as a transient
   * failure and not as a rejected key.
   */
  private inBodyError(
    error: OpenRouterErrorEnvelope,
    modelId: string,
    extra: { responseId?: string; usage?: ModelUsage; partialText?: string | null },
  ): OpenRouterProviderError {
    const code = typeof error.code === 'number' ? error.code : undefined;
    const decline = classifyOpenRouterDecline(error, { inBody: true });
    if (decline) {
      return this.declineError(modelId, decline, {
        httpStatus: code,
        error,
        partialText: extra.partialText,
        usage: extra.usage,
      });
    }
    // The body is untyped network input: a message that is not a string
    // must not reach the redaction's string calls.
    const message = this.redactSecrets(
      typeof error.message === 'string' && error.message ? error.message : 'OpenRouter reported an error in a 200 response',
    );
    // The typed code: metadata.error_type, else the envelope's own `type`, in
    // the order the HTTP error path reads them.
    const envelopeType = (error as { type?: unknown }).type;
    const errorType =
      typeof error.metadata?.error_type === 'string'
        ? error.metadata.error_type
        : typeof envelopeType === 'string'
          ? envelopeType
          : undefined;
    // The 200 means the configured key was accepted, so a 401 or 403 inside
    // the body describes an upstream attempt (a BYOK key, a failover leg),
    // not this account. Its code stays in the message, where the retry
    // classifiers read it, and in details; the error carries no status and
    // no `[NNN]` prefix, so the breaker counts one transient failure instead
    // of opening its auth policy (one failure, 30 minutes) on one response.
    const inBodyAuth = code === 401 || code === 403;
    return new OpenRouterProviderError(
      code === undefined ? message : inBodyAuth ? `OpenRouter in-body error ${code}: ${message}` : `[${code}] ${message}`,
      errorType === 'context_length_exceeded' ? CONTEXT_WINDOW_EXCEEDED_CODE : 'API_REQUEST_FAILED',
      inBodyAuth ? undefined : code,
      errorType ?? 'UNKNOWN_API_ERROR',
      {
        responseId: extra.responseId,
        ...(inBodyAuth ? { httpStatus: code } : {}),
        responseData: this.redactResponseData(error),
        partialText: typeof extra.partialText === 'string' ? this.redactSecrets(extra.partialText).slice(0, 2000) : undefined,
        usage: extra.usage,
      },
    );
  }

  /**
   * Masks the configured API keys (the raw config value and each key in a
   * comma-separated pool) and any base-URL credentials out of text bound
   * for an error, a log line or a health report.
   *
   * @param text - Text that may quote a request header or URL.
   * @returns The text with those secrets replaced by `[redacted]`.
   */
  private redactSecrets(text: string): string {
    const rawKeys = this.config?.apiKey ?? '';
    const keys = [rawKeys, ...rawKeys.split(',').map((key) => key.trim())];
    return redactUrlSecrets(text, this.config?.baseURL, keys);
  }

  /** Every configured secret: the raw key setting, each pooled key, and base-URL credentials. */
  private configuredSecrets(): string[] {
    const rawKeys = this.config?.apiKey ?? '';
    return [rawKeys, ...rawKeys.split(',').map((key) => key.trim()), baseUrlCredentials(this.config?.baseURL) ?? ''].filter(
      (secret) => secret.length > 0,
    );
  }

  /**
   * Masks the end of a text that was cut short when that end is the start
   * of a configured secret. {@link redactSecrets} matches whole secrets
   * only, so a key split by the cut would otherwise show all but its last
   * characters.
   *
   * @param text - Text cut at a size limit or a timeout.
   * @returns The text with any such tail replaced by `[redacted]`.
   */
  private maskCutSecretTail(text: string): string {
    let cut = 0;
    for (const secret of this.configuredSecrets()) {
      for (let length = Math.min(secret.length - 1, text.length); length > cut; length--) {
        if (text.endsWith(secret.slice(0, length))) {
          cut = length;
          break;
        }
      }
    }
    return cut > 0 ? `${text.slice(0, text.length - cut)}[redacted]` : text;
  }

  /**
   * A response body as kept in error details, with the configured keys
   * masked: text directly, JSON values through their serialized form.
   * Anything that does not serialize, such as a live stream whose `req`
   * holds the Authorization header, is replaced by a placeholder.
   *
   * @param data - The response body as axios returned it.
   * @returns A plain value that is safe to log or serialize.
   */
  private redactResponseData(data: unknown): unknown {
    if (data === undefined || data === null) return data;
    if (typeof data === 'string') return this.redactSecrets(data);
    if (isReadableStream(data)) return '[stream body not read]';
    try {
      const json = JSON.stringify(data);
      return json === undefined ? undefined : JSON.parse(this.redactSecrets(json));
    } catch {
      return '[unserializable response body]';
    }
  }

  /**
   * The parts of a caught error worth keeping in details: its name, string
   * `code` and masked message. An AxiosError's config and request carry the
   * Authorization header, so they are left out.
   *
   * @param error - The caught error.
   * @returns A plain description that is safe to log or serialize.
   */
  private describeError(error: unknown): { name?: string; code?: string; message: string } {
    if (error instanceof Error) {
      const code = (error as { code?: unknown }).code;
      return {
        name: error.name,
        ...(typeof code === 'string' ? { code } : {}),
        message: this.redactSecrets(error.message),
      };
    }
    return { message: this.redactSecrets(String(error)) };
  }

  /** The usage a raw SSE line reports, when it is a data line that carries one. */
  private usageOfSseLine(rawChunk: string): ModelUsage | undefined {
    if (!rawChunk.startsWith('data: ')) return undefined;
    try {
      const parsed: unknown = JSON.parse(rawChunk.substring('data: '.length));
      return parsed && typeof parsed === 'object'
        ? mapOpenRouterUsage((parsed as OpenRouterChatCompletionAPIResponse).usage)
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async *parseSseStream(stream: NodeJS.ReadableStream): AsyncGenerator<string, void, undefined> {
    let buffer = '';
    const readableStream = stream as NodeJS.ReadableStream & { destroy?: () => void };

    try {
      for await (const chunk of readableStream) {
        buffer += chunk.toString();
        let eolIndex;
        while ((eolIndex = buffer.indexOf('\n')) >= 0) {
          const line = buffer.substring(0, eolIndex).trim();
          buffer = buffer.substring(eolIndex + 1);
          if (line) {
            yield line;
          }
        }
      }
      if (buffer.trim()) {
        yield buffer.trim();
      }
    } catch (error: unknown) {
      const message = this.redactSecrets(
        error instanceof Error ? error.message : "OpenRouter stream parsing/reading error",
      );
      // A stream error can be an AxiosError holding the request config, so
      // only its description is logged and kept.
      const description = this.describeError(error);
      console.error("OpenRouterProvider: Error reading or parsing SSE stream:", message, description);
      if (error instanceof OpenRouterProviderError) throw error;
      throw new OpenRouterProviderError(message, 'STREAM_PARSING_ERROR', undefined, undefined, description);
    } finally {
      if (typeof readableStream.destroy === 'function') {
        readableStream.destroy();
      } else if (typeof (readableStream as any).close === 'function') {
        (readableStream as any).close();
      }
    }
  }
}

