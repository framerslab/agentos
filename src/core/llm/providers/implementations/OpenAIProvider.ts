// File: backend/agentos/core/llm/providers/implementations/OpenAIProvider.ts

/**
 * @fileoverview Implements the IProvider interface for OpenAI's GPT models.
 * This provider offers comprehensive integration with OpenAI's API, including:
 * - Chat completions (streaming and non-streaming)
 * - Tool/function calling
 * - Vision capabilities for multimodal models (e.g., GPT-4o)
 * - Text embeddings generation
 * - Model introspection and health checks.
 *
 * It is designed with robustness and extensibility in mind, featuring:
 * - Detailed error handling using custom `OpenAIProviderError`.
 * - API key management with support for system-wide and per-request overrides.
 * - Configurable request retries with exponential backoff.
 * - Rate limiting (conceptual, actual enforcement by OpenAI).
 * - Comprehensive JSDoc documentation.
 * - Adherence to TypeScript best practices and modern ECMAScript features.
 *
 * @module backend/agentos/core/llm/providers/implementations/OpenAIProvider
 * @implements {IProvider}
 */

import {
  IProvider,
  ChatMessage,
  ModelCompletionOptions,
  ModelCompletionResponse,
  ModelCompletionChoice,
  ModelInfo,
  ModelUsage,
  ProviderEmbeddingOptions,
  ProviderEmbeddingResponse,
  AttemptOutcome,
} from '../IProvider';
import { responseModel } from '../responseModel';
import { stripParamsForOpenAI } from '../openrouter-only-params';
import { resolveOpenAiCacheRetentionParams, resolvePromptCacheKey } from '../openai-cache-params';
import { OpenAIProviderError } from '../errors/OpenAIProviderError';
import { ApiKeyPool, keyPoolStrategyFromEnv, type ApiKeyPoolConfig, type ProbeResult } from '../../../providers/ApiKeyPool.js';
import { classifyKeyFailure, retryAfterMs, statusOfKinds, type KeyFailureKind } from '../../../providers/quotaErrors.js';
import {
  failedKeyProbeAnswer,
  noModelKeyProbeAnswer,
  readKeyProbeAnswer,
  startKeyProbeDeadline,
  type KeyProbeAnswer,
  type KeyProbeOptions,
} from '../../../providers/keyProbe.js';
import { toOpenAiResponseFormat, toOpenAiResponsesTextFormat } from './openai-response-format-guard';
import { clampMaxOutputTokens } from '../model-output-limits.js';
import { mapEffortToOpenAiReasoningEffortForModel, mapEffortToOpenAiResponsesEffort } from '../model-effort.js';
import { computeRetryBackoffMs, waitForRetry } from './retry-backoff.js';
import { operationIdHeaderNamed, operationIdHeaders, resolveOperationIdHeader, setOperationIdHeaders } from './operation-id.js';
import { redactUrlSecrets } from '../url-secrets.js';
import {
  OPENAI_LONG_CONTEXT_INPUT_MULTIPLIER,
  OPENAI_LONG_CONTEXT_OUTPUT_MULTIPLIER,
  OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS,
  OPENAI_MODEL_PRICING,
  estimateOpenAICostUSD,
  openAIModelPricing,
  openAiHasLongContextPricing,
} from './openaiPricing.js';
import {
  OPENAI_RESPONSES_MIN_OUTPUT_TOKENS,
  isOpenAIReasoningModel,
  isOpenAIResponsesOnlyModel,
  openAiReasoningContextWindow,
  openAiRequiresResponsesApi,
  requestHasFunctionTools,
} from './openaiModelFamilies.js';
import { retiredOpenAIModel, retiredOpenAIModelMessage } from './openaiRetirements.js';
import { moduleLogger } from '../../../logging/loggerFactory.js';
import { listedErrorFields } from '../../../logging/events.js';
import { AttemptBudgetExhaustedError, CountingAttemptBudget } from '../../../../safety/runtime/ModelAttemptBudget.js';

/** This module's events, under its fixed diagnostic origin; no runtime name enters telemetry. */
const log = moduleLogger('llm', 'openai_provider');

// The model-family predicates and the long-context tier live in openaiModelFamilies.ts and openaiPricing.ts, which
// import nothing of this provider, so `@framers/agentos/safety/runtime` can price a call at its long-context rates
// without loading the provider. The rule for which calls go to the Responses API lives there too, so the spend budget
// can count the output cap such a call sends. Re-exported here so every import that reached them through this module
// keeps working.
export {
  OPENAI_LONG_CONTEXT_INPUT_MULTIPLIER,
  OPENAI_LONG_CONTEXT_OUTPUT_MULTIPLIER,
  OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS,
  isOpenAIReasoningModel,
  isOpenAIResponsesOnlyModel,
  openAiHasLongContextPricing,
  openAiReasoningContextWindow,
  openAiRequiresResponsesApi,
};
export {
  OPENAI_MODEL_SHUTDOWNS,
  openAIModelShutdown,
  retiredOpenAIModel,
  type OpenAIModelShutdown,
} from './openaiRetirements.js';

// Assuming a fetch-like interface is available globally or polyfilled (e.g., node-fetch)
// For Node.js, ensure 'node-fetch' is a dependency or use Node's built-in fetch from v18+.
// import fetch, { RequestInit, Response as FetchResponse, AbortController } from 'node-fetch'; // Example for Node

/**
 * Minimal structural types for the subset of OpenAI REST responses this provider
 * consumes, defined from the fields the mapping code accesses (the API returns a
 * superset). Previously the whole file was `@ts-nocheck`, which silently masked
 * this missing namespace and the unguarded `choices` access in the mappers.
 */
// eslint-disable-next-line @typescript-eslint/no-namespace
namespace OpenAIAPITypes {
  export interface Usage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    /**
     * OpenAI automatic prompt caching (gpt-4o and newer): prompt tokens
     * served from cache at the discounted rate, plus — on GPT-5.6+ —
     * tokens written to cache (billed 1.25x). Normalized into
     * {@link ModelUsage.cacheReadInputTokens} / cacheCreationInputTokens
     * so caching is visible platform-wide (OpenRouterProvider already
     * normalizes the same fields). `cache_write_tokens_details` splits the
     * writes by lifetime where the request could ask for the 12-hour one.
     */
    prompt_tokens_details?: CacheTokenDetails;
  }
  /** Complete tool call as returned on a non-streaming message. */
  export interface ToolCall {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }
  /** Partial tool call as returned on a streaming delta. */
  export interface ToolCallDelta {
    index: number;
    id?: string;
    type?: 'function';
    function?: { name?: string; arguments?: string };
  }
  export interface ChatMessage {
    role: string;
    content: string | null;
    /** The model's refusal message, when it declined the request (the content then holds no answer). */
    refusal?: string | null;
    reasoning_content?: string;
    tool_calls?: ToolCall[];
  }
  export interface ChatChoice {
    index: number;
    message: ChatMessage;
    finish_reason: string | null;
    logprobs?: unknown;
  }
  export interface ChatCompletionResponse {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: ChatChoice[];
    usage?: Usage;
    /** Service tier the call actually ran at (present when service_tier was requested or defaulted). */
    service_tier?: string;
  }
  export interface StreamChunkExtras {
    /** Service tier the call actually ran at (present on chunks when requested/defaulted). */
    service_tier?: string;
  }
  export interface StreamDelta {
    role?: string;
    content?: string | null;
    /** A piece of the model's refusal message. */
    refusal?: string | null;
    reasoning_content?: string;
    tool_calls?: ToolCallDelta[];
  }
  export interface StreamChoice {
    index: number;
    delta: StreamDelta;
    finish_reason: string | null;
    logprobs?: unknown;
  }
  export interface ChatCompletionStreamResponse extends StreamChunkExtras {
    id: string;
    object: string;
    created: number;
    model: string;
    // Optional: the trailing usage-only chunk (stream_options.include_usage)
    // carries an empty/absent choices array.
    choices?: StreamChoice[];
    usage?: Usage;
  }
  export interface ModelAPIObject {
    id: string;
    object?: string;
    created?: number;
    owned_by?: string;
  }
  export interface ListModelsResponse {
    object?: string;
    data: ModelAPIObject[];
  }
  export interface EmbeddingItem {
    object?: string;
    index: number;
    embedding: number[];
  }
  export interface EmbeddingResponse {
    object?: string;
    model: string;
    data: EmbeddingItem[];
    usage: Usage;
  }
  export interface APIErrorResponse {
    error?: { message?: string; type?: string; code?: string };
    /** The tokens an error body reports for the request it refused, when the server reports any. */
    usage?: unknown;
  }

  // --- /v1/responses (Responses API) — narrow read surface --------------
  // Only the fields mapResponsesToCompletionResponse reads. Live-probed
  // 2026-07-08 (gpt-5.5): output items carry `type`, message content is
  // `output_text` parts, function_call items carry `call_id`/`name`/
  // `arguments`, usage uses input_tokens/output_tokens, `created_at` +
  // `status` + `incomplete_details` are top-level.
  /**
   * The prompt-cache detail of a usage report: `cached_tokens` read, `cache_write_tokens` written (on GPT-5.6 and
   * later), and, on a Responses API model with `prompt_cache_options`, the writes by lifetime, which add up to
   * `cache_write_tokens` (https://developers.openai.com/api/docs/guides/prompt-caching, read 2026-11-04).
   */
  export interface CacheTokenDetails {
    cached_tokens?: number;
    cache_write_tokens?: number;
    cache_write_tokens_details?: { ttl_30m_tokens?: number; ttl_12h_tokens?: number };
  }
  export interface ResponsesUsage {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    /** Responses-API spelling of the cached-prompt-token detail. */
    input_tokens_details?: CacheTokenDetails;
  }
  export interface ResponsesOutputContentPart {
    type: string; // 'output_text' | 'refusal' | …
    text?: string;
    /** On a `refusal` part: the model's refusal message. */
    refusal?: string;
  }
  export interface ResponsesOutputItem {
    type: string; // 'message' | 'function_call' | 'reasoning' | …
    /** Item id; stream events name the item by it (`item_id`). */
    id?: string;
    status?: string;
    // message item
    role?: string;
    content?: ResponsesOutputContentPart[];
    // function_call item
    call_id?: string;
    name?: string;
    arguments?: string;
  }
  export interface ResponsesResponse {
    id: string;
    object?: string; // 'response'
    created_at?: number;
    model?: string;
    status?: string; // 'completed' | 'incomplete' | …
    output?: ResponsesOutputItem[];
    usage?: ResponsesUsage | null;
    incomplete_details?: { reason?: string } | null;
    /** Why a `failed` response failed. */
    error?: { code?: string; message?: string } | null;
    /** Service tier the call actually ran at. */
    service_tier?: string;
  }
  /**
   * One `/v1/responses` stream event (the JSON `data` of an SSE message; its
   * `type` repeats the SSE `event` name). Only the fields the stream mapper
   * reads, per the streaming-events reference retrieved 2026-09-30.
   */
  export interface ResponsesStreamEvent {
    type: string;
    sequence_number?: number;
    /** response.created / in_progress / completed / incomplete / failed. */
    response?: ResponsesResponse;
    /** Position of the item in `response.output`. */
    output_index?: number;
    /** output_item.added / output_item.done. */
    item?: ResponsesOutputItem;
    /** Item id on the delta and done events. */
    item_id?: string;
    /** output_text.delta, refusal.delta and function_call_arguments.delta. */
    delta?: string;
    /** refusal.done: the complete refusal message. */
    refusal?: string;
    /** function_call_arguments.done: the complete argument text. */
    arguments?: string;
    /** The `error` event. */
    code?: string | null;
    message?: string;
    param?: string | null;
  }
}

/**
 * The OpenAI API's base URL, which requests go to when the config names no `baseURL`. `embedText` posts OpenAI
 * embeddings under it too.
 */
export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/**
 * Chat Completions body keys the Responses API has no parameter for, each with the reason its `llm.option_ignored`
 * line carries. The body the reference lists
 * (https://developers.openai.com/api/reference/resources/responses/methods/create, read 2026-11-21) holds none of
 * them. `customModelParams` is shared with the chat path, so a caller's chat key can reach the Responses builder,
 * which leaves these off the body: the call is answered without them instead of refused for a key Responses does not
 * take.
 */
const RESPONSES_UNSUPPORTED_CHAT_PARAMS = [
  ['stop', 'stop_sequences'],
  ['presence_penalty', 'penalties'],
  ['frequency_penalty', 'penalties'],
  ['seed', 'chat_only_param'],
  ['n', 'chat_only_param'],
  ['logit_bias', 'chat_only_param'],
  ['logprobs', 'chat_only_param'],
] as const;

/**
 * Configuration specific to the OpenAIProvider.
 */
export interface OpenAIProviderConfig {
  /** The API key for accessing OpenAI services. Can be overridden by `apiKeyOverride` in request options. Can be empty when oauthFlow is provided. */
  apiKey: string;
  /** Base URL for the OpenAI API. Defaults to "https://api.openai.com/v1". Useful for proxies. */
  baseURL?: string;
  /** Default OpenAI organization ID to use for requests. */
  organizationId?: string;
  /** Maximum number of retry attempts for failed API requests. Defaults to 3. */
  maxRetries?: number;
  /** Timeout for API requests in milliseconds. Defaults to 60000 (60 seconds). */
  requestTimeout?: number;
  /** Optional custom headers to include with all requests to the OpenAI API. */
  customHeaders?: Record<string, string>;
  /** Default model ID to use if not specified in a request. E.g., "gpt-4o-mini". */
  defaultModelId?: string;
  /** Optional OAuth flow for subscription-based auth (e.g. ChatGPT Plus/Pro). When set, apiKey is derived dynamically from OAuth tokens. */
  oauthFlow?: { getAccessToken(): Promise<string> };
  /**
   * The key pool behind a comma-separated `apiKey`: `ordered` prefers the
   * earliest usable key (a cost order), `round-robin` spreads load (the
   * default; `AGENTOS_KEY_POOL_STRATEGY=ordered` changes it when this is
   * absent); `store` and `id` persist the keys' standing across restarts.
   */
  keyPool?: Pick<ApiKeyPoolConfig, 'strategy' | 'cooldownMs' | 'recheckMs' | 'maxRecheckMs' | 'maxRetryAfterMs' | 'loadTimeoutMs' | 'storeTimeoutMs' | 'store' | 'id'>;
  /**
   * The header each request carries its call's operation id in, a UUID made
   * once before the call's first attempt and sent on every retry of the call;
   * the next call, and a request sent again with a changed body, gets a new
   * one. When this is unset the provider reads `AGENTOS_OPERATION_ID_HEADER`;
   * with neither, no header is sent. The id replaces a `customHeaders` entry
   * of the same name, in any case, so a request carries one value. A name
   * that is not an HTTP header name, or one the provider sets itself
   * (`Authorization`, `Content-Type`, ...), is refused with a `RangeError` by
   * `initialize()`, by each call and by `probeApiKey()`, before anything is
   * sent.
   */
  operationIdHeader?: string;
}

// Simplified OpenAI API response structures (non-namespaced)
type OpenAIChatCompletionChoice = {
    index: number;
    message: {
      role: ChatMessage['role'];
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
      function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string | null;
    logprobs?: unknown;
};

type _OpenAIChatCompletionResponse = {
    id: string;
    object: string; // e.g., "chat.completion"
    created: number; // Unix timestamp
    model: string; // Model ID used
  choices: OpenAIChatCompletionChoice[];
    usage?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
    system_fingerprint?: string;
};

type OpenAIChatCompletionStreamChoiceDelta = {
    role?: ChatMessage['role'];
    content?: string;
    tool_calls?: Array<{
      index: number; // Required for accumulating tool calls
      id?: string;
      type?: 'function';
    function?: { name?: string; arguments?: string };
    }>;
};

type OpenAIChatCompletionStreamChoice = {
    index: number;
  delta: OpenAIChatCompletionStreamChoiceDelta;
    finish_reason?: string | null;
    logprobs?: unknown;
};

type _OpenAIChatCompletionStreamResponse = {
    id: string;
    object: string; // e.g., "chat.completion.chunk"
    created: number;
    model: string;
  choices: OpenAIChatCompletionStreamChoice[];
  usage?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
    system_fingerprint?: string;
};

type OpenAIEmbeddingAPIObject = {
    object: 'embedding';
    embedding: number[];
    index: number;
};

type _OpenAIEmbeddingResponse = {
    object: 'list';
  data: OpenAIEmbeddingAPIObject[];
    model: string; // Model ID used
    usage: {
      prompt_tokens: number;
      total_tokens: number;
    };
};

type OpenAIModelAPIObject = {
    id: string;
    object: 'model';
    created: number; // Unix timestamp
    owned_by: string;
};

type _OpenAIListModelsResponse = {
    object: 'list';
  data: OpenAIModelAPIObject[];
};

type _OpenAIAPIErrorResponse = {
    error?: {
      message: string;
      type: string;
      param?: string | null;
      code?: string | null;
    };
};

/**
 * @class OpenAIProvider
 * @implements {IProvider}
 * Provides an interface to OpenAI's suite of models (GPT, Embeddings).
 * It handles API requests, streaming, error management, and model information.
 */
/**
 * Whether the given model id belongs to the family that requires
 * `max_completion_tokens` instead of the legacy `max_tokens` parameter.
 *
 * OpenAI's reasoning models (o1, o3, o4) and the GPT-5 family reject
 * `max_tokens` outright with HTTP 400 "Unsupported parameter:
 * 'max_tokens' is not supported with this model. Use
 * 'max_completion_tokens' instead." Legacy chat completions
 * (gpt-4o, gpt-4-turbo, gpt-4.1, gpt-3.5, etc.) still accept the
 * old field.
 *
 * Errs on the conservative side — any model id that is not a clear
 * member of one of the new families uses `max_tokens` so older
 * deployments do not silently break when the param-name flag changes.
 *
 * @param modelId Provider-side model identifier (e.g. `'gpt-5.4-mini'`).
 * @returns `true` when the model needs `max_completion_tokens`.
 */
export function modelRequiresMaxCompletionTokens(modelId: string): boolean {
  return isOpenAIReasoningModel(modelId);
}

/**
 * The model a billing probe sends its completion to when none is configured: the first GPT chat model the catalog
 * lists, else its first o-series model with a price, skipping the Responses-only models
 * ({@link isOpenAIResponsesOnlyModel}), which have no Chat Completions route, the completions-only `instruct` models,
 * and the embedding, audio, realtime, image and search models.
 *
 * @param ids The model ids `GET /models` listed, in its order.
 * @returns The model to probe, or `undefined` when the catalog lists none.
 */
function probeModelFromCatalog(ids: readonly string[]): string | undefined {
  const callable = ids.filter((id) => !isOpenAIResponsesOnlyModel(id) && !/embedding|realtime|audio|tts|transcribe|image|search|instruct/.test(id));
  return callable.find((id) => /^gpt-/.test(id)) ?? callable.find((id) => /^o\d/.test(id) && openAIModelPricing(id) !== undefined);
}

/**
 * ModelInfo capabilities for a GPT-5, GPT-6 or o-series id, limited to what
 * OpenAIProvider can serve.
 *
 *   - Responses-only models ({@link isOpenAIResponsesOnlyModel}) list as
 *     `chat` only. Tool and streaming support vary from model to model on
 *     that tier, and the refresh leaves the Responses-only o-series ids out.
 *   - GPT-6 lists `tool_use`: every GPT-6 tool call, streamed or not, goes to
 *     `/v1/responses` ({@link openAiRequiresResponsesApi}).
 *   - `o1-mini` and `o1-preview` have no function calling or structured
 *     outputs. They and `o3-mini` take text only, and every other id takes
 *     images (per model input modalities, checked 2026-09-29).
 *
 * @param modelId Provider-side model identifier (e.g. `'gpt-6-sol'`).
 * @returns Capability strings for ModelInfo.
 */
export function openAiReasoningCapabilities(modelId: string): string[] {
  const id = modelId.toLowerCase();
  if (isOpenAIResponsesOnlyModel(id) || /^o1-(mini|preview)/.test(id)) return ['chat'];
  const caps = ['chat', 'json_mode', 'tool_use'];
  if (!/^o3-mini/.test(id)) caps.push('vision_input');
  return caps;
}

/**
 * Whether OpenAI rejects `presence_penalty` and `frequency_penalty` for
 * `modelId`: the o-series and the GPT-5 family do, with HTTP 400 ("Unsupported
 * parameter: 'presence_penalty' is not supported with this model."), recorded
 * for GPT-5, GPT-5 mini, o3 and o4-mini in
 * https://github.com/danny-avila/LibreChat/discussions/11689 and for a GPT-5.1
 * mini model in https://docs.nectain.com/docs/nectainium/admin_guide/2/2.14/2.14.3/.
 * GPT-6 does as well: on 2026-11-17 `gpt-6.2-sol`, `gpt-6.2-astra` and
 * `gpt-6-luna` answered a Chat Completions call with `presence_penalty` or
 * `frequency_penalty` 0.5 with HTTP 400 "Unsupported parameter:
 * 'presence_penalty' is not supported with this model." (only 0 passed), and
 * `gpt-6-luna` at `reasoning_effort: 'none'` answered HTTP 500 to them. No
 * reference page names the penalties for these models, so the provider sends
 * the GPT-6 family neither.
 *
 * @param modelId Provider-side model identifier (e.g. `'o3'`, `'gpt-5.5'`).
 */
function openAiRejectsPenalties(modelId: string): boolean {
  return /^(o\d|gpt-5|gpt-6)/i.test(modelId);
}

/**
 * Whether OpenAI rejects `stop` on Chat Completions for `modelId`. The GPT-6
 * family does: on 2026-11-17 `gpt-6.2-sol`, `gpt-6.2-astra` and `gpt-6-luna`
 * (at every effort, `none` included) answered a call with `stop` with HTTP 400
 * "Unsupported parameter: 'stop' is not supported with this model."; the
 * Chat Completions reference names o3 and o4-mini as refusing it too
 * (https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create).
 * The provider drops the caller's stop sequences for these models, so the
 * call is answered in full instead of refused. The Responses API has no
 * `stop` parameter, and its builder never sends one.
 *
 * @param modelId Provider-side model identifier (e.g. `'gpt-6.2-sol'`).
 */
export function openAiRejectsStop(modelId: string): boolean {
  return /^gpt-6/i.test(modelId);
}

/**
 * Whether OpenAI rejects `reasoning_effort` sent alongside function tools on
 * the `/v1/chat/completions` endpoint for `modelId`. The GPT-5 family does:
 * "Function tools with reasoning_effort are not supported for gpt-5.5 in
 * /v1/chat/completions. Please use /v1/responses instead." (live-observed
 * 2026-07-08, when the codegen frontier fallback chain sent a tool-carrying,
 * effort:xhigh orchestrator turn to gpt-5.5 and the whole build failed).
 *
 * GPT-6 does as well. Live-probed 2026-09-10 (chat.completions,
 * `gpt-6-astra`, `reasoning_effort: 'xhigh'` and one function tool): HTTP 400
 * `invalid_request_error`, "Function tools with reasoning_effort are not
 * supported for gpt-6-astra in /v1/chat/completions. To use function tools,
 * use /v1/responses or set reasoning_effort to 'none'." The 2026-09-30 probe
 * found that `gpt-6-sol` and `gpt-6-luna` accept `'none'` there while
 * `gpt-6-astra` rejects it, and that a GPT-6 tool call with no
 * `reasoning_effort` also returns 400, so every GPT-6 tool call goes to
 * `/v1/responses` ({@link openAiRequiresResponsesApi}).
 *
 * Dropping `reasoning_effort` does not make such a call succeed: the model
 * applies its default effort when the call names none, and on 2026-11-18
 * `gpt-5.6-sol` (default `medium`) answered tool calls on chat/completions
 * that held no `reasoning_effort` key with the same HTTP 400. So every GPT-5
 * and GPT-6 tool call goes to `/v1/responses`, with or without an effort
 * ({@link openAiRequiresResponsesApi}), and a call whose message content
 * Responses cannot carry is refused before sending
 * (`RESPONSES_UNMAPPABLE_CONTENT`). The chat builder still leaves the effort
 * out of a tool call to these families, for a subclass that builds a chat
 * body itself. The o-series (o1/o3/o4) accepts `reasoning_effort` with tools
 * on chat/completions, so it stays outside this predicate; widen it if a
 * future o-series model enforces the same rule.
 *
 * @param modelId Provider-side model identifier (e.g. `'gpt-5.5'`, `'gpt-6-astra'`).
 */
export function openAiRejectsReasoningEffortWithTools(modelId: string): boolean {
  return /^gpt-(5|6)/i.test(modelId);
}

/** Whether one content part is a plain text block the Responses mapper can carry. */
function isTextPart(part: unknown): part is { type: 'text'; text: string } {
  return (
    part != null &&
    typeof part === 'object' &&
    (part as { type?: unknown }).type === 'text' &&
    typeof (part as { text?: unknown }).text === 'string'
  );
}

/**
 * Whether a message's `content` can be carried to `/v1/responses` by
 * {@link flattenResponsesTextContent} WITHOUT losing information.
 *
 * Accepts a plain string, `null`/absent content, or an array whose parts are
 * ALL text blocks. Anthropic-style `cache_control` markers on those blocks are
 * fine to drop: OpenAI has no equivalent request field and caches long prefixes
 * automatically, so the marker carries no payload.
 *
 * Rejects genuinely multimodal content (images, `tool_result` blocks, any
 * non-text part) because the mapper still cannot represent it — flattening
 * those would silently discard the payload.
 *
 * This is the SINGLE source of truth shared by the Responses builder's
 * refusal (`RESPONSES_UNMAPPABLE_CONTENT`, through
 * {@link isResponsesMappableMessage}) and the mapper itself, so the two cannot
 * drift into the state that caused the silent-empty-system-prompt hazard this
 * guard replaced.
 */
export function isResponsesMappableContent(content: ChatMessage['content']): boolean {
  if (content == null || typeof content === 'string') return true;
  if (!Array.isArray(content)) return false;
  return content.every(isTextPart);
}

/**
 * Flatten a message's content to the plain text `/v1/responses` receives.
 *
 * A string passes through; an all-text block array is joined with `\n` (the
 * shape `systemBlocks` / `SystemContentBlock[]` produces, where each block is
 * an independently cache-markable slab of one logical prompt); anything else
 * yields `''`.
 *
 * Callers MUST gate on {@link isResponsesMappableContent} first — the `''`
 * fallback is a defensive floor for unmappable content, not a licence to send
 * it. Sending unmappable content here is exactly the silent-empty-prompt bug
 * the paired predicate exists to prevent.
 */
export function flattenResponsesTextContent(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (content == null || !Array.isArray(content)) return '';
  return content.filter(isTextPart).map((p) => p.text).join('\n');
}

/** Whether one content part is an image URL block, which `/v1/responses` takes as `input_image`. */
function isImageUrlPart(
  part: unknown,
): part is { type: 'image_url'; image_url: { url: string; detail?: string } } {
  if (part == null || typeof part !== 'object') return false;
  const p = part as { type?: unknown; image_url?: unknown };
  return (
    p.type === 'image_url' &&
    p.image_url != null &&
    typeof p.image_url === 'object' &&
    typeof (p.image_url as { url?: unknown }).url === 'string'
  );
}

/**
 * Whether one content part is a Chat Completions `file` part (a PDF, by
 * `file_id` or by `file_data` with its `filename`), which `/v1/responses`
 * takes as `input_file` with the same fields
 * (https://developers.openai.com/api/docs/guides/pdf-files, read 2026-11-21).
 */
function isFilePart(
  part: unknown,
): part is { type: 'file'; file: { file_id?: string; file_data?: string; filename?: string } } {
  if (part == null || typeof part !== 'object') return false;
  const p = part as { type?: unknown; file?: unknown };
  if (p.type !== 'file' || p.file == null || typeof p.file !== 'object') return false;
  const file = p.file as { file_id?: unknown; file_data?: unknown };
  return typeof file.file_id === 'string' || typeof file.file_data === 'string';
}

/** The `input_file` form of a Chat Completions `file` part: its `file_id`, `filename` and `file_data`, as given. */
function toResponsesInputFile(part: { file: { file_id?: string; file_data?: string; filename?: string } }): Record<string, unknown> {
  const out: Record<string, unknown> = { type: 'input_file' };
  for (const key of ['file_id', 'filename', 'file_data'] as const) {
    if (typeof part.file[key] === 'string') out[key] = part.file[key];
  }
  return out;
}

/**
 * Whether the `/v1/responses` builder can carry message `m` without losing
 * content. Text-only content ({@link isResponsesMappableContent}) maps on
 * every role. User and tool messages may also carry image parts: a user turn
 * sends them as `input_image`, and a tool result becomes a
 * `function_call_output` whose output is an `input_text` / `input_image`
 * array (the form OpenAI's function-calling reference gives for it). A user
 * turn may also carry PDF `file` parts, which travel as `input_file`. Any
 * other part, such as audio or an Anthropic `tool_result` block, has no
 * mapping.
 *
 * @param m A request message.
 * @returns `true` when the message maps onto Responses input losslessly.
 */
export function isResponsesMappableMessage(m: ChatMessage): boolean {
  if (isResponsesMappableContent(m.content)) return true;
  return (
    (m.role === 'user' || m.role === 'tool') &&
    Array.isArray(m.content) &&
    m.content.every((part) => isTextPart(part) || isImageUrlPart(part) || (m.role === 'user' && isFilePart(part)))
  );
}

/**
 * The `/v1/responses` form of a user or tool message's content. Text-only
 * content stays the flattened string {@link flattenResponsesTextContent}
 * builds; content with images or files becomes `input_text`, `input_image`
 * and `input_file` parts. Every image carries a `detail`, `'auto'` (the API's
 * default) when the source part set none. Callers gate on
 * {@link isResponsesMappableMessage} first.
 */
function toResponsesInputContent(
  content: ChatMessage['content'],
): string | Array<Record<string, unknown>> {
  if (!Array.isArray(content) || isResponsesMappableContent(content)) {
    return flattenResponsesTextContent(content);
  }
  return content.map((part) => {
    if (isImageUrlPart(part)) {
      return { type: 'input_image', image_url: part.image_url.url, detail: part.image_url.detail ?? 'auto' };
    }
    if (isFilePart(part)) return toResponsesInputFile(part);
    return { type: 'input_text', text: isTextPart(part) ? part.text : '' };
  });
}

/**
 * The `/v1/responses` form of a user message's content. A user turn of two or
 * more text parts keeps them apart, as `input_text` parts: they are separate
 * texts (a note from the application before the person's own words), and
 * joined with a newline the words would read as the note's next line. Any
 * other content takes {@link toResponsesInputContent}'s form.
 */
function toResponsesUserContent(
  content: ChatMessage['content'],
): string | Array<Record<string, unknown>> {
  if (Array.isArray(content) && content.length > 1 && content.every(isTextPart)) {
    return content.map((part) => ({ type: 'input_text', text: (part as { text: string }).text }));
  }
  return toResponsesInputContent(content);
}

/**
 * Whether a call goes to `/v1/responses` instead of `/v1/chat/completions`.
 * Streamed and non-streamed calls follow this one rule: every call
 * {@link openAiRequiresResponsesApi} names, which is any call to a
 * Responses-only model and any GPT-5 or GPT-6 call carrying function tools,
 * with or without an effort. Chat Completions refuses function tools for these
 * families unless `reasoning_effort` is `'none'` ("Function tools with
 * reasoning_effort are not supported ... use /v1/responses"), and a call that
 * names no effort runs at the model's default. Responses keeps the tools and
 * the effort, and a `responseFormat` travels as `text.format`.
 *
 * The messages do not change the route. The Responses builder carries
 * Anthropic-style cache-marked system blocks (`systemBlocks` reach the
 * provider as an all-text content array) and images on user and tool turns
 * ({@link isResponsesMappableMessage}); a message it cannot carry, such as
 * audio, fails the call with `RESPONSES_UNMAPPABLE_CONTENT` before anything is
 * sent, since Chat Completions would refuse the tool call as well.
 *
 * @param modelId Provider-side model identifier.
 * @param _messages The request messages; they do not change the route.
 * @param options The request's tools, effort and response format.
 * @returns `true` when the call goes to `/v1/responses`.
 */
export function shouldRouteToOpenAiResponsesApi(
  modelId: string,
  _messages: ChatMessage[],
  options: Pick<ModelCompletionOptions, 'tools' | 'effort' | 'responseFormat'>,
): boolean {
  return openAiRequiresResponsesApi(modelId, options);
}

/** Assistant text, refusal, function calls and item count read from a `/v1/responses` `output` array. */
interface ResponsesOutputSummary {
  /** Concatenated `output_text` of every message item. */
  text: string;
  /** Concatenated `refusal` parts of every message item: the model's refusal message, or '' when it sent none. */
  refusal: string;
  /** Whether any message item holds a `refusal` part, one with an empty message included. */
  refused: boolean;
  /** Function calls in output order. */
  toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  /** Number of output items of any type, reasoning included. */
  itemCount: number;
}

/**
 * Reads a `/v1/responses` `output` array: assistant text from the
 * `output_text` parts of message items, the refusal message from their
 * `refusal` parts, and tool calls from `function_call` items (`call_id`
 * becomes the call id). Reasoning and other item types count toward
 * `itemCount` only.
 */
function summarizeResponsesOutput(
  output: ReadonlyArray<OpenAIAPITypes.ResponsesOutputItem> | undefined,
): ResponsesOutputSummary {
  const items = output ?? [];
  let text = '';
  let refusal = '';
  let refused = false;
  const toolCalls: ResponsesOutputSummary['toolCalls'] = [];
  for (const item of items) {
    if (item.type === 'message') {
      for (const part of item.content ?? []) {
        if (part.type === 'output_text' && typeof part.text === 'string') text += part.text;
        else if (part.type === 'refusal' && typeof part.refusal === 'string') {
          refusal += part.refusal;
          refused = true;
        }
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id ?? '',
        type: 'function',
        function: { name: item.name ?? '', arguments: item.arguments ?? '' },
      });
    }
  }
  return { text, refusal, refused, toolCalls, itemCount: items.length };
}

/**
 * The finish reason and refusal fields of a choice whose answer may hold the
 * model's refusal message. The finish reason is always the one given: `stop`
 * beside a whole refusal message (Chat Completions) or for a `completed`
 * response (Responses), `length` or `content_filter` for a message the
 * answer's end cut off, `tool_calls` when function calls came beside it. A
 * refusal is carried in `refusal` alone, so a caller tells a declined request
 * from an empty answer by that field: the whole message, or the piece that
 * came when the answer was cut. Without one, no `refusal` field is set.
 *
 * `present` says whether the answer holds a refusal, an empty message
 * included: a Responses `refusal` content part whatever its message, a Chat
 * Completions refusal as {@link chatRefused} reads it. An empty message is
 * then kept as `''`, so the field is there exactly when the model refused.
 */
function withRefusal(
  finishReason: string | null,
  refusal: string | null | undefined,
  present: boolean,
): Pick<ModelCompletionChoice, 'finishReason' | 'refusal'> {
  if (!present) return { finishReason };
  return { finishReason, refusal: typeof refusal === 'string' ? refusal : '' };
}

/**
 * Whether a Chat Completions answer holds a refusal: a `refusal` string, the
 * message possibly empty. An empty refusal field beside the answer's text or
 * tool calls holds no refusal: the answer is that text or those calls.
 *
 * @param refusal - The message's `refusal` field, or `''` once a stream sent one.
 * @param seen - Whether the answer carried a `refusal` string at all.
 * @param answered - Whether the answer carried text or a tool call.
 */
function chatRefused(refusal: string, seen: boolean, answered: boolean): boolean {
  return seen && (refusal.length > 0 || !answered);
}

/** The refusal a Chat Completions stream has sent so far, and whether it sent text or a tool call beside it. */
interface ChatStreamRefusal {
  /** The refusal pieces, joined. */
  text: string;
  /** Whether a delta carried a `refusal` string, an empty one included. */
  seen: boolean;
  /** Whether a delta carried text or a tool call. */
  answered: boolean;
}

/**
 * HTTP-equivalent statuses of the `/v1/responses` error codes that mean the
 * request may succeed later or elsewhere. A stream that fails with one of them
 * before any output throws with this status, so the fallback walker treats it
 * like the HTTP error a failed request returns.
 */
const RESPONSES_RETRYABLE_ERROR_STATUS: Record<string, number> = {
  server_error: 500,
  rate_limit_exceeded: 429,
  vector_store_timeout: 504,
};

/** The HTTP-equivalent status of a `/v1/responses` error code, when it is a retryable one. */
function responsesErrorStatus(code: string | null | undefined): number | undefined {
  return typeof code === 'string' ? RESPONSES_RETRYABLE_ERROR_STATUS[code] : undefined;
}

/** The HTTP-equivalent status of a `/v1/responses` body marked `failed` with a retryable error code; else undefined. */
function retryableFailedResponseStatus(body: unknown): number | undefined {
  const response = body as Partial<OpenAIAPITypes.ResponsesResponse> | null | undefined;
  return response?.status === 'failed' ? responsesErrorStatus(response.error?.code) : undefined;
}

/**
 * The error a `/v1/responses` result marked `failed` throws, streamed or not,
 * as a failed HTTP request does: the status of a retryable error code and the
 * billed usage in `details.usage`, so callers can fail over and meter the
 * attempt. Output the result holds is not an answer.
 */
function responsesFailedError(
  response: OpenAIAPITypes.ResponsesResponse | undefined,
  usage: ModelUsage | undefined,
): OpenAIProviderError {
  return new OpenAIProviderError(
    response?.error?.message ?? 'OpenAI /responses reported the response as failed',
    'RESPONSES_FAILED',
    response?.error?.code ?? undefined,
    'response_failed',
    responsesErrorStatus(response?.error?.code),
    { error: response?.error, ...(usage ? { usage } : {}) },
  );
}

/**
 * Two usage reports, each already priced as the request it reports, summed field by field: a count holds a number
 * where either report has a finite one. The cost is the sum only when both reports carry one, since a cost known for
 * one request alone is not the pair's. Either report may be absent.
 */
function sumModelUsage(a: ModelUsage | undefined, b: ModelUsage | undefined): ModelUsage | undefined {
  if (!a || !b) return a ?? b;
  const left = a as unknown as Record<string, unknown>;
  const right = b as unknown as Record<string, unknown>;
  const finite = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const sum: Record<string, number> = {};
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const x = finite(left[key]);
    const y = finite(right[key]);
    if (x !== undefined || y !== undefined) sum[key] = (x ?? 0) + (y ?? 0);
  }
  if (finite(a.costUSD) === undefined || finite(b.costUSD) === undefined) delete sum.costUSD;
  return sum as unknown as ModelUsage;
}

/**
 * The usage of the `/v1/responses` results marked failed that a call sent again, each priced as the request it was,
 * keyed by the result the call returned. The mapper adds it to that result's own, so the requests are never priced as
 * one: a pair that each fell below OpenAI's long-context threshold is not billed at the long-context rate.
 */
const retriedResponsesUsage = new WeakMap<object, ModelUsage>();

/**
 * The chat-style finish reason of a `/v1/responses` result, shared by the
 * streamed and non-streamed mappings. An incomplete response reports why it
 * stopped, as Chat Completions does, even when it holds a function call (the
 * call may be cut off): `content_filter` when a filter stopped it, and `length`
 * otherwise, the output budget's or any reason this does not know or none,
 * since `stop` would present the part as the whole. Otherwise `tool_calls` when
 * the turn called tools, else `stop`.
 */
function responsesFinishReason(
  status: string | undefined,
  incompleteReason: string | undefined,
  hasToolCalls: boolean,
): string {
  if (status === 'incomplete') return incompleteReason === 'content_filter' ? 'content_filter' : 'length';
  return hasToolCalls ? 'tool_calls' : 'stop';
}

/** One incremental tool-call entry of a streamed chunk. */
type ToolCallDelta = NonNullable<ModelCompletionResponse['toolCallsDeltas']>[number];

/** A function call assembled from a `/v1/responses` stream. */
interface StreamedResponsesCall {
  /** Dense tool-call index, in order of first appearance. */
  index: number;
  /** Call id, name and argument text the emitted deltas have carried. */
  id: string;
  name: string;
  arguments: string;
  /** Authoritative arguments that do not extend the streamed text (see {@link reconcileStreamedCall}). */
  finalArguments?: string;
}

/**
 * Brings a streamed call in line with its authoritative form (the item on
 * `response.output_item.done`, the text on
 * `response.function_call_arguments.done`, or the call in the terminal
 * response) and returns the delta that carries the difference, or
 * `undefined` when the emitted deltas already match.
 *
 * Argument deltas only append, so when the authoritative arguments extend
 * the streamed text the missing suffix goes out as `arguments_delta`, and a
 * consumer that rebuilds calls from deltas (StreamingReconstructor) ends with
 * the same arguments as the final chunk. Arguments that do not extend the
 * streamed text cannot be corrected by appending; they are kept in
 * `finalArguments` for the final chunk and logged.
 *
 * @param call The streamed call, updated in place.
 * @param authoritative The call's final id, name and arguments; absent
 *   fields are left as streamed.
 * @returns The correcting delta, or `undefined`.
 */
function reconcileStreamedCall(
  call: StreamedResponsesCall,
  authoritative: { id?: string; name?: string; arguments?: string },
): ToolCallDelta | undefined {
  const delta: ToolCallDelta = { index: call.index };
  const fn: NonNullable<ToolCallDelta['function']> = {};
  let changed = false;
  if (authoritative.id && authoritative.id !== call.id) {
    call.id = authoritative.id;
    delta.id = authoritative.id;
    delta.type = 'function';
    changed = true;
  }
  if (authoritative.name && authoritative.name !== call.name) {
    call.name = authoritative.name;
    fn.name = authoritative.name;
    changed = true;
  }
  const args = authoritative.arguments;
  if (typeof args === 'string' && args !== call.arguments) {
    if (args.startsWith(call.arguments)) {
      fn.arguments_delta = args.slice(call.arguments.length);
      call.arguments = args;
      call.finalArguments = undefined;
      changed = true;
    } else if (call.finalArguments !== args) {
      call.finalArguments = args;
      log.warn('llm.output_mismatch', { provider: 'openai', reason: 'tool_arguments' });
    }
  }
  if (!changed) return undefined;
  if (fn.name !== undefined || fn.arguments_delta !== undefined) delta.function = fn;
  return delta;
}

/**
 * The model a completion request names: `customModelParams.model` when it is a non-blank string, since the payload
 * builders apply `customModelParams` last and it replaces `model` in the body, else `modelId`. The shutdown check, the
 * endpoint choice and every model-specific payload rule read this one value, so they judge the model that is sent.
 *
 * @param modelId The model id the caller passed.
 * @param options The call's options.
 */
function effectiveOpenAiModelId(modelId: string, options: Pick<ModelCompletionOptions, 'customModelParams'> | undefined): string {
  const override = options?.customModelParams?.model;
  return typeof override === 'string' && override.trim() !== '' ? override : modelId;
}

export class OpenAIProvider implements IProvider {
  /** @inheritdoc */
  public readonly providerId: string = 'openai';
  /** @inheritdoc */
  public isInitialized: boolean = false;
  /** @inheritdoc */
  public defaultModelId?: string;

  private config!: OpenAIProviderConfig; // Asserted as initialized by `initialize`
  private keyPool: ApiKeyPool | null = null;
  private availableModelsCache: Map<string, ModelInfo> = new Map();

  // OpenAI's price table (USD per 1K tokens) lives in openaiPricing.ts, so a
  // caller can price a call before it is made without loading this provider.
  private readonly modelPricing = OPENAI_MODEL_PRICING;


  /**
   * Creates an instance of OpenAIProvider.
   * Note: The provider is not ready to use until `initialize()` is called and resolves.
   */
  constructor() {
    // Configuration is set during initialize()
  }

  /** @inheritdoc */
  public async initialize(config: OpenAIProviderConfig): Promise<void> {
    if (!config.apiKey && !config.oauthFlow) {
      throw new OpenAIProviderError(
        'API key or OAuth flow is required for OpenAIProvider initialization.',
        'INIT_FAILED_MISSING_API_KEY'
      );
    }
    // A header name every call would refuse is refused here, before anything is sent or replaced.
    resolveOperationIdHeader(config.operationIdHeader);
    // The new pool is built before anything of the old state is touched: its construction makes no request, so a
    // timing it refuses (a RangeError) leaves this provider as it was, its pool and its recheck timer included.
    const keyPool = new ApiKeyPool(config.apiKey, {
      ...(config.keyPool ?? {}),
      ...(config.keyPool?.strategy ? {} : keyPoolStrategyFromEnv('openai')),
      probe: (key, kind) => this.probeKey(key, kind),
    });
    // A re-initialize replaces the configuration and the pool: the old pool first stops its timer, finishes its
    // probes (which read this provider's configuration) and writes their results, so a late probe can neither use
    // the new configuration nor overwrite what the new pool loads from the store.
    await this.keyPool?.close();

    this.config = {
      baseURL: OPENAI_DEFAULT_BASE_URL,
      maxRetries: 3,
      requestTimeout: 60000, // 60 seconds
      ...config, // User-provided config overrides defaults
    };
    this.keyPool = keyPool;
    await this.keyPool.ready();
    this.defaultModelId = config.defaultModelId;

    // Every key of a pool of several is out (the store held them failed): the model listing would draw no key and
    // fail the initialize, and a provider that never initializes runs no recheck timer, so nothing would probe the
    // keys back until a fresh process forgot them. It initializes without the listing instead and its timer probes
    // the keys at their recheck; the model cache fills on the first lookup that misses it.
    if (keyPool.size > 1 && keyPool.usable() === 0) {
      this.isInitialized = true;
      keyPool.startRechecks();
      log.warn('llm.key_pool_out', { provider: 'openai', count: keyPool.size });
      return;
    }

    try {
      // Attempt to list models to verify API key and connectivity.
      await this.refreshAvailableModels();
      this.isInitialized = true;
      // Failed keys are probed on the pool's own clock once the provider is up, so a provider the health
      // breaker holds still gets its keys back; the timer never keeps the process alive.
      if ((this.keyPool?.size ?? 0) > 1) this.keyPool?.startRechecks();
      log.debug('llm.provider_ready', { provider: 'openai', count: this.availableModelsCache.size });
    } catch (error: unknown) {
      this.isInitialized = false;
      log.error('llm.provider_start_failed', { provider: 'openai', ...listedErrorFields(error) });
      if (error instanceof OpenAIProviderError) {
        throw error; // Re-throw if already an OpenAIProviderError
      }
      const message = error instanceof Error ? error.message : 'Unknown error during initialization.';
      throw new OpenAIProviderError(
        `OpenAIProvider initialization failed: ${message}`,
        'INITIALIZATION_FAILED',
        undefined, undefined, undefined, error
      );
    }
  }

  /**
   * Fetches the list of available models from OpenAI and updates the internal cache.
   * @private
   * @throws {OpenAIProviderError} If fetching or parsing models fails.
   */
  protected async refreshAvailableModels(): Promise<void> {
    const apiKey = await this.getApiKey();
    const response = await this.makeApiRequest<OpenAIAPITypes.ListModelsResponse>(
      '/models',
      'GET',
      apiKey
    );

    this.availableModelsCache.clear();
    const native = this.isNativeOpenAiEndpoint();
    response.data.forEach((apiModel: OpenAIAPITypes.ModelAPIObject) => {
      // Basic filtering for generally usable models, can be expanded.
      // The o-series ids neither start with `gpt-` nor contain `embedding`,
      // so they are admitted on their own terms: priced in `modelPricing`
      // (dated snapshots resolve to their base row) and reachable on Chat
      // Completions. That admits `o1`, `o3`, `o3-mini` and `o4-mini`, and
      // leaves out the Responses-only `o1-pro` / `o3-pro` and the unpriced
      // `o1-mini` / `o1-preview`, which would fail when called or list as free.
      const admitOSeries = /^o\d/.test(apiModel.id)
        && !isOpenAIResponsesOnlyModel(apiModel.id)
        && this.resolvePricing(apiModel.id) !== undefined;
      // A model OpenAI has shut down is never offered: a call to it is refused (refuseRetiredModel).
      if (native && retiredOpenAIModel(apiModel.id)) return;
      if (apiModel.id.startsWith('gpt-') || admitOSeries || apiModel.id.includes('embedding')) {
        const modelInfo = this.mapApiToModelInfo(apiModel);
        this.availableModelsCache.set(modelInfo.modelId, modelInfo);
      }
    });
  }

  /**
   * Maps an OpenAI API model object to the standard ModelInfo interface.
   * @private
   * @param {OpenAIAPITypes.ModelAPIObject} apiModel - The model object from OpenAI API.
   * @returns {ModelInfo} The standardized ModelInfo object.
   */
  private mapApiToModelInfo(apiModel: OpenAIAPITypes.ModelAPIObject): ModelInfo {
    const capabilities: ModelInfo['capabilities'] = [];
    let contextWindowSize: number | undefined;
    let _supportsTools = false;
    let _supportsVision = false;
    let isEmbeddingModel = false;

    // Infer capabilities and context window from model ID (common OpenAI patterns).
    //
    // The GPT-5, GPT-6 and o-series branch comes first. Without it these
    // families fall through to the trailing `else`, which publishes them as
    // `capabilities: ['chat']` with no context window, and
    // `listAvailableModels({ capability: 'tool_use' })` then omits every
    // current OpenAI model while still returning gpt-4o.
    if (/^(gpt-5|gpt-6|o\d)/i.test(apiModel.id)) {
        capabilities.push(...openAiReasoningCapabilities(apiModel.id));
        contextWindowSize = openAiReasoningContextWindow(apiModel.id);
        _supportsTools = capabilities.includes('tool_use');
        _supportsVision = capabilities.includes('vision_input');
    } else if (apiModel.id.startsWith('gpt-4o')) {
        capabilities.push('chat', 'vision_input', 'tool_use', 'json_mode');
        contextWindowSize = 128000; _supportsTools = true; _supportsVision = true;
    } else if (apiModel.id.startsWith('gpt-4-turbo')) {
        capabilities.push('chat', 'tool_use', 'json_mode');
        contextWindowSize = 128000; _supportsTools = true;
        if (apiModel.id.includes('-vision')) { capabilities.push('vision_input'); _supportsVision = true;}
    } else if (apiModel.id.startsWith('gpt-4-32k')) {
        capabilities.push('chat', 'tool_use', 'json_mode');
        contextWindowSize = 32768; _supportsTools = true;
    } else if (apiModel.id.startsWith('gpt-4')) {
        capabilities.push('chat', 'tool_use', 'json_mode');
        contextWindowSize = 8192; _supportsTools = true;
    } else if (apiModel.id.startsWith('gpt-3.5-turbo-16k')) {
        capabilities.push('chat', 'tool_use', 'json_mode');
        contextWindowSize = 16385; _supportsTools = true;
    } else if (apiModel.id.startsWith('gpt-3.5-turbo')) {
        capabilities.push('chat', 'tool_use', 'json_mode');
        // context window for gpt-3.5-turbo can vary (e.g. 4096, 16385 for -0125)
        // Defaulting to a common value, but specific variants might differ.
        contextWindowSize = apiModel.id.includes('0125') || apiModel.id.includes('1106') ? 16385 : 4096;
        _supportsTools = true;
    } else if (apiModel.id.includes('embedding')) {
        capabilities.push('embeddings');
        isEmbeddingModel = true;
        // Common context/input token limit for OpenAI embedding models
        contextWindowSize = 8191; // Max input tokens
    } else {
        // Fallback for other gpt models if any (less common now)
        capabilities.push('chat'); // Assume chat at least
    }

    const pricing = this.resolvePricing(apiModel.id) || { input: 0, output: 0 };
    // modelPricing holds USD per 1K tokens and ModelInfo carries USD per 1M,
    // so every rate is scaled by 1000 here. Cost metering reads modelPricing
    // directly and is unaffected; this conversion is what callers of
    // listAvailableModels() and getModelInfo() see.
    const per1M = (per1K: number) => Math.round(per1K * 1000 * 1e6) / 1e6;

    return {
      modelId: apiModel.id,
      providerId: this.providerId,
      displayName: apiModel.id, // Can be enhanced if more metadata is available
      description: `OpenAI model: ${apiModel.id}`,
      capabilities,
      contextWindowSize,
      pricePer1MTokensInput: per1M(pricing.input),
      pricePer1MTokensOutput: per1M(pricing.output),
      pricePer1MTokensTotal: isEmbeddingModel ? per1M(pricing.input) : undefined,
      supportsStreaming: capabilities.includes('chat'), // Generally, chat models support streaming
      // OpenAI specific details can be added to metadata
      embeddingDimension: apiModel.id.includes('embedding-3-large') ? 3072 :
                          apiModel.id.includes('embedding-3-small') ? 1536 :
                          apiModel.id.includes('ada-002') ? 1536 : undefined,
      lastUpdated: new Date((apiModel.created ?? 0) * 1000).toISOString(),
      status: 'active', // OpenAI doesn't directly provide status in this list, assume active.
    };
  }

  /**
   * Ensures the provider is initialized before use.
   * @private
   * @throws {OpenAIProviderError} If not initialized.
   */
  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new OpenAIProviderError(
        'OpenAIProvider is not initialized. Call initialize() first.',
        'PROVIDER_NOT_INITIALIZED'
      );
    }
  }

  /**
   * Resolves the API key to use for a request, prioritizing per-request override, then OAuth flow, then system default.
   * A pool with no usable key while a probe of a failed key is in flight (its recheck came due) waits for that probe,
   * bounded by the pool's probe timeout, and draws again, so the first request after a recheck is served by a key that
   * came back; the caller's signal ends that wait at once.
   * @private
   * @param {string | undefined} apiKeyOverride - API key provided directly in request options.
   * @param {AbortSignal | undefined} abortSignal - The caller's signal, which ends a wait on the pool's probes.
   * @returns {Promise<string>} The API key to use.
   * @throws {OpenAIProviderError} If no API key is available; `REQUEST_ABORTED` when the signal ended the draw, or
   * had already aborted before an OAuth token read (no token is asked for).
   */
  private async getApiKey(apiKeyOverride?: string, abortSignal?: AbortSignal): Promise<string> {
    if (apiKeyOverride) return apiKeyOverride;
    if (this.config.oauthFlow) {
      // A token read can be a refresh request to the identity provider, so an aborted call makes none.
      if (abortSignal?.aborted) {
        throw new OpenAIProviderError('Request aborted by caller.', 'REQUEST_ABORTED');
      }
      return await this.config.oauthFlow.getAccessToken();
    }
    if (this.keyPool?.hasKeys) {
      const key = await this.keyPool.nextAfterProbes(abortSignal);
      if (abortSignal?.aborted) {
        throw new OpenAIProviderError('Request aborted by caller.', 'REQUEST_ABORTED');
      }
      if (key === '') throw this.allKeysFailedError();
      return key;
    }
    if (this.config.apiKey) return this.config.apiKey;
    throw new OpenAIProviderError(
      'No OpenAI API key available for the request.',
      'API_KEY_MISSING'
    );
  }

  /** Where a request's key came from, for the pool's bookkeeping: an override or an OAuth token is never marked or hopped. */
  private keySourceOf(apiKeyOverride?: string): 'pool' | 'override' | 'oauth' {
    if (apiKeyOverride) return 'override';
    // `config` is optional here: the routing tests stub the request path and set no config.
    if (this.config?.oauthFlow) return 'oauth';
    return 'pool';
  }

  /**
   * Probes one API key and reports what its answer showed: the verdict
   * (`ok`, the failure kind it still shows, or `unknown`), the HTTP status,
   * the vendor's message, the model and the Retry-After. Any kind but
   * `billing` sends the models list; `kind: 'billing'` sends a one-token
   * completion, since a models list can answer 200 with no credit left. The
   * completion goes to `options.model`, else the default model, else the first
   * GPT chat model the account lists, else its first priced o-series model
   * (Responses-only models are skipped, having no Chat Completions route);
   * with no model to send, the probe has no verdict (`failure: 'no_model'`). The reasoning families take
   * `max_completion_tokens`; a named Responses-only model is sent
   * `POST /responses` with `max_output_tokens: 16`. It works before
   * `initialize()`: the base URL is
   * `options.baseURL`, else the configured one, else OpenAI's own. The key
   * pool's probe of a failed key is this method's verdict.
   *
   * @throws {RangeError} When the operation id header's name is refused (`operationIdHeader`, else
   *   `AGENTOS_OPERATION_ID_HEADER`), before anything is sent: the name is the host's error, not the key's.
   */
  public async probeApiKey(apiKey: string, options: KeyProbeOptions = {}): Promise<KeyProbeAnswer> {
    // Resolved before the deadline starts and outside the catch below, which turns a failed request into an answer.
    const operationHeader = resolveOperationIdHeader(this.config?.operationIdHeader);
    const deadline = startKeyProbeDeadline(options);
    const baseURL = options.baseURL || this.config?.baseURL || OPENAI_DEFAULT_BASE_URL;
    try {
      const baseHeaders: Record<string, string> = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
      if (this.config?.organizationId) baseHeaders['OpenAI-Organization'] = this.config.organizationId;
      // Each request of the probe is a call of its own, with its own operation id when the host names a header.
      const headers = (): Record<string, string> => ({ ...baseHeaders, ...operationIdHeaderNamed(operationHeader) });
      const listModels = () => fetch(`${baseURL}/models`, { method: 'GET', headers: headers(), signal: deadline.signal });
      if (options.kind !== 'billing') return await readKeyProbeAnswer(await listModels(), { apiKey, signal: deadline.signal });
      let model = options.model || this.defaultModelId;
      if (!model) {
        const listed = await listModels();
        if (!listed.ok) return await readKeyProbeAnswer(listed, { apiKey, signal: deadline.signal });
        const body = (await listed.json().catch((error: unknown) => {
          // A read the deadline or the caller's abort ended is the probe's failure, not an empty catalog.
          if (deadline.signal.aborted) throw error;
          return {};
        })) as Partial<OpenAIAPITypes.ListModelsResponse>;
        model = probeModelFromCatalog((body.data ?? []).map((m) => m.id));
        if (!model) return noModelKeyProbeAnswer();
      }
      // A Responses-only model has no Chat Completions route: its probe goes to /responses, which takes a plain
      // string as input (https://developers.openai.com/api/reference/resources/responses/methods/create).
      const response = isOpenAIResponsesOnlyModel(model)
        ? await fetch(`${baseURL}/responses`, {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify({ model, input: 'ping', max_output_tokens: 16 }),
            signal: deadline.signal,
          })
        : await fetch(`${baseURL}/chat/completions`, {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify({
              model,
              ...(modelRequiresMaxCompletionTokens(model) ? { max_completion_tokens: 16 } : { max_tokens: 1 }),
              messages: [{ role: 'user', content: 'ping' }],
            }),
            signal: deadline.signal,
          });
      return await readKeyProbeAnswer(response, { model, apiKey, signal: deadline.signal });
    } catch (error) {
      return failedKeyProbeAnswer(error, deadline, { apiKey, baseURL });
    } finally {
      deadline.dispose();
    }
  }

  /** Probes a key the pool took out of rotation, off the request path: the verdict of `probeApiKey()`. */
  private async probeKey(apiKey: string, kind: KeyFailureKind | undefined): Promise<ProbeResult> {
    return (await this.probeApiKey(apiKey, { kind })).verdict;
  }

  /** The error thrown when every key of the pool is out: no credential is sent again until one returns. */
  private allKeysFailedError(message?: string, status?: number, errorType?: string, errorCode?: string): OpenAIProviderError {
    const kinds = Array.from(
      new Set((this.keyPool?.snapshot() ?? []).map((state) => state.kind).filter((kind): kind is KeyFailureKind => kind !== undefined)),
    );
    const retryAfter = this.keyPool?.soonestReturnMs();
    return new OpenAIProviderError(
      message ?? `Every OpenAI API key is out of rotation (${kinds.join(', ') || 'unknown'}).`,
      'ALL_KEYS_FAILED',
      errorCode,
      errorType,
      status ?? statusOfKinds(kinds),
      { kinds, ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}) },
    );
  }

  /** @inheritdoc */
  public async generateCompletion(
    requestedModelId: string,
    messages: ChatMessage[],
    options: ModelCompletionOptions
  ): Promise<ModelCompletionResponse> {
    this.ensureInitialized();
    // The model the request body will name: the shutdown check, the endpoint and the payload rules all read it.
    const modelId = effectiveOpenAiModelId(requestedModelId, options);
    this.refuseRetiredModel(modelId);
    const apiKey = await this.getApiKey(options.apiKeyOverride, options.abortSignal);

    // Responses-only models and GPT-5/6 tool calls go to /v1/responses;
    // every other call takes the chat path. generateCompletionStream applies the same rule. On both paths the
    // caller's signal aborts the request in flight and stops its retries.
    if (shouldRouteToOpenAiResponsesApi(modelId, messages, options)) {
      const responsesBody = this.buildResponsesPayload(modelId, messages, options);
      const responsesApiResponse = await this.makeApiRequest<OpenAIAPITypes.ResponsesResponse>(
        '/responses',
        'POST',
        apiKey,
        responsesBody,
        false,
        options.requestTimeout,
        options.abortSignal,
        { max: options.maxAttempts, onAttempt: options.onAttempt, operationId: options.operationId },
        this.keySourceOf(options.apiKeyOverride),
      );
      return this.mapResponsesToCompletionResponse(responsesApiResponse, modelId);
    }

    const requestBody = this.buildChatCompletionPayload(modelId, messages, options, false);

    const apiResponse = await this.makeApiRequest<OpenAIAPITypes.ChatCompletionResponse>(
      '/chat/completions',
      'POST',
      apiKey,
      requestBody,
      false,
      options.requestTimeout,
      options.abortSignal,
      { max: options.maxAttempts, onAttempt: options.onAttempt, operationId: options.operationId },
      this.keySourceOf(options.apiKeyOverride),
    );

    return this.mapApiToCompletionResponse(apiResponse);
  }

  /** @inheritdoc */
  public async *generateCompletionStream(
    requestedModelId: string,
    messages: ChatMessage[],
    options: ModelCompletionOptions
  ): AsyncGenerator<ModelCompletionResponse, void, undefined> {
    this.ensureInitialized();
    // The model the request body will name, as in generateCompletion.
    const modelId = effectiveOpenAiModelId(requestedModelId, options);
    const abortSignal = options.abortSignal;
    // Checked before any network work, so an aborted call never reaches the
    // OAuth token fetch or the POST.
    if (abortSignal?.aborted) {
      yield this.abortedStreamChunk(modelId, 'Stream aborted prior to first chunk');
      return;
    }
    this.refuseRetiredModel(modelId);
    let apiKey: string;
    try {
      apiKey = await this.getApiKey(options.apiKeyOverride, abortSignal);
    } catch (error: unknown) {
      // An abort while the draw waits on the pool's probes surfaces as the abort chunk, not a throw.
      if (abortSignal?.aborted) {
        yield this.abortedStreamChunk(modelId, 'Stream aborted prior to first chunk');
        return;
      }
      throw error;
    }

    // The routing rule generateCompletion uses, so a streamed call reaches the
    // same endpoint with the same effort as its non-streamed twin.
    const viaResponses = shouldRouteToOpenAiResponsesApi(modelId, messages, options);
    const endpoint = viaResponses ? '/responses' : '/chat/completions';
    const requestBody = viaResponses
      ? this.buildResponsesPayload(modelId, messages, options, true)
      : this.buildChatCompletionPayload(modelId, messages, options, true);

    let stream: ReadableStream<Uint8Array>;
    try {
      stream = await this.makeApiRequest(
        endpoint,
        'POST',
        apiKey,
        requestBody,
        true,
        options.requestTimeout,
        abortSignal,
        { max: options.maxAttempts, onAttempt: options.onAttempt, operationId: options.operationId },
        this.keySourceOf(options.apiKeyOverride),
      );
    } catch (error: unknown) {
      // An abort during the request surfaces as the abort chunk, not a throw.
      if (abortSignal?.aborted) {
        yield this.abortedStreamChunk(modelId, 'Stream aborted by caller');
        return;
      }
      throw error;
    }

    if (viaResponses) {
      yield* this.mapResponsesStream(stream, modelId, abortSignal);
      return;
    }
    yield* this.mapChatStream(stream, modelId, abortSignal);
  }

  /**
   * Refuses a call to a model OpenAI has shut down ({@link retiredOpenAIModel}) before a key is drawn or anything is
   * sent, with the error OpenAI's own answer would carry (HTTP 404, `model_not_found`) and a message that names the
   * model to use instead. Only a call to OpenAI's own endpoint is refused: a gateway or another vendor this class
   * serves (Groq, xAI, Together, Mistral, an Azure or LiteLLM proxy) keeps its own catalog and retirement dates.
   *
   * @throws {OpenAIProviderError} `MODEL_RETIRED` when `modelId` is shut down.
   * @private
   */
  private refuseRetiredModel(modelId: string): void {
    if (!this.isNativeOpenAiEndpoint()) return;
    const row = retiredOpenAIModel(modelId);
    if (!row) return;
    throw new OpenAIProviderError(
      retiredOpenAIModelMessage(modelId, row),
      'MODEL_RETIRED',
      'model_not_found',
      'invalid_request_error',
      404,
      { replacement: row.replacement, ...(row.shutdownOn ? { shutdownOn: row.shutdownOn } : {}) },
    );
  }

  /**
   * The terminal chunk a stream yields when the caller's signal aborts it: it names the model an event of the stream
   * named, or, when none has, the model the request named, marked as the request's.
   * @private
   */
  private abortedStreamChunk(modelId: string, message: string, answeredModel?: string): ModelCompletionResponse {
    return {
      id: `openai-abort-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      ...responseModel(answeredModel, modelId),
      choices: [],
      error: { message, type: 'abort' },
      isFinal: true,
    };
  }

  /**
   * Maps a `/v1/chat/completions` SSE stream onto
   * {@link ModelCompletionResponse} chunks, accumulating streamed tool calls
   * by index and the streamed refusal message. A caller abort ends the stream
   * with the abort chunk.
   * @private
   */
  private async *mapChatStream(
    stream: ReadableStream<Uint8Array>,
    modelId: string,
    abortSignal: AbortSignal | undefined,
  ): AsyncGenerator<ModelCompletionResponse, void, undefined> {
    const accumulatedToolCalls: Map<number, { id?: string; type?: 'function'; function?: { name?: string; arguments?: string; } }> = new Map();
    const accumulatedRefusal: ChatStreamRefusal = { text: '', seen: false, answered: false };
    // Whether a chunk reported the answer's finish reason.
    let finished = false;
    // The model a chunk named, kept once one names it, for the abort and cut-off chunks this stream ends with.
    let answeredModel: string | undefined;

    for await (const data of this.parseSseStream(stream, abortSignal)) {
      if (abortSignal?.aborted) break;
      // OpenAI ends the stream with [DONE]; the finish and usage chunks come before it.
      if (data === '[DONE]') break;
      let mapped: ModelCompletionResponse;
      try {
        const apiChunk = JSON.parse(data) as OpenAIAPITypes.ChatCompletionStreamResponse;
        mapped = this.mapApiToStreamChunkResponse(apiChunk, accumulatedToolCalls, accumulatedRefusal);
      } catch {
        log.warn('llm.stream_invalid', { provider: 'openai', bytes: new TextEncoder().encode(data).byteLength, reason: 'json' });
        continue;
      }
      if (mapped.choices[0]?.finishReason) finished = true;
      if (typeof mapped.modelId === 'string' && mapped.modelId !== '' && mapped.modelIdSource !== 'requested') {
        answeredModel = mapped.modelId;
      }
      yield mapped;
    }

    if (abortSignal?.aborted) {
      yield this.abortedStreamChunk(modelId, 'Stream aborted by caller', answeredModel);
      return;
    }
    // A refusal message whose answer never finished was cut off, an empty one
    // included: it is not a refusal the caller can rely on, so the stream ends
    // on an error.
    if (!finished && chatRefused(accumulatedRefusal.text, accumulatedRefusal.seen, accumulatedRefusal.answered)) {
      yield {
        id: `openai-truncated-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        ...responseModel(answeredModel, modelId),
        choices: [],
        error: { message: 'OpenAI chat stream ended before the refused answer finished', type: 'stream_truncated' },
        isFinal: true,
      };
    }
  }

  /**
   * Maps a `/v1/responses` SSE stream onto the {@link ModelCompletionResponse}
   * chunks the chat stream produces.
   *
   *   - `response.output_text.delta` yields a text chunk.
   *   - `response.refusal.delta` yields a chunk carrying the piece of the
   *     model's refusal message in `refusalDelta`; the final chunk of a
   *     refused answer holds the whole message in `refusal`, beside the
   *     finish reason the response gave (`stop`, or `length` for an
   *     `incomplete` one).
   *   - A `function_call` item yields a tool-call delta with its id and name
   *     (`response.output_item.added`), then its argument fragments
   *     (`response.function_call_arguments.delta`). Tool-call indexes are
   *     dense in order of appearance, so a reasoning item ahead of the calls
   *     leaves no gap.
   *   - The item's final form (`response.function_call_arguments.done`,
   *     `response.output_item.done`) and the terminal response are
   *     authoritative. Text, refusal text, a call id or name, or an argument
   *     suffix that the deltas did not carry goes out as one more delta,
   *     exactly once, before the final chunk. A consumer that rebuilds the turn from deltas
   *     (StreamingReconstructor) and one that reads the final chunk
   *     (streamText, GMI) therefore see the same text and calls, including
   *     when a proxy strips the delta events. Whether the answer holds a
   *     refusal, and its message, is read from the terminal output as the
   *     same body read whole reads it; the refusal deltas decide only when the
   *     terminal response carries no output.
   *   - `response.completed` and `response.incomplete` yield exactly one final
   *     chunk with the finish reason, tool calls and usage.
   *   - Before any text, refusal or tool call has gone out, `response.failed`, an
   *     `error` event, and a body that ends or fails to read before a terminal
   *     event throw an {@link OpenAIProviderError}, as a failed HTTP request
   *     does: the status of a retryable error code
   *     ({@link RESPONSES_RETRYABLE_ERROR_STATUS}) or `NETWORK_ERROR` for the
   *     cut-off or failed body, and a failed response's billed usage in
   *     `details.usage`. Callers can then fail over and meter the attempt.
   *   - After output, those failures and a caller abort each yield one final
   *     chunk carrying an error instead, so the partial answer stays with the
   *     caller.
   *
   * Reasoning summaries, content-part events and `response.refusal.done` carry
   * nothing this mapping surfaces and are skipped.
   * @private
   */
  private async *mapResponsesStream(
    stream: ReadableStream<Uint8Array>,
    modelId: string,
    abortSignal: AbortSignal | undefined,
  ): AsyncGenerator<ModelCompletionResponse, void, undefined> {
    let responseId = `openai-resp-${Date.now()}`;
    let created = Math.floor(Date.now() / 1000);
    // The model an event named, kept once one names it: a later event that names none leaves it as it is.
    let answeredModel: string | undefined;
    let emittedText = '';
    let emittedRefusal = '';
    // Whether a refusal delta came, an empty one included.
    let refusalSeen = false;
    const calls: StreamedResponsesCall[] = [];
    const callByOutputIndex = new Map<number, StreamedResponsesCall>();
    const callByItemId = new Map<string, StreamedResponsesCall>();
    // Whether any text, refusal or tool call has gone out to the caller.
    const deliveredOutput = (): boolean => emittedText.length > 0 || emittedRefusal.length > 0 || calls.length > 0;
    // A read that failed mid-body (a dropped connection) ends the event loop
    // like a body cut off before its terminal event.
    const reading: { failure?: OpenAIProviderError } = {};

    const noteResponse = (response: OpenAIAPITypes.ResponsesResponse | undefined): void => {
      if (!response) return;
      if (typeof response.id === 'string' && response.id) responseId = response.id;
      if (typeof response.created_at === 'number') created = response.created_at;
      if (typeof response.model === 'string' && response.model) answeredModel = response.model;
    };
    const chunk = (fields: Partial<ModelCompletionResponse>): ModelCompletionResponse => ({
      id: responseId,
      object: 'chat.completion.chunk',
      created,
      // The model an event named, or, while none has, the model the request named, marked as the request's.
      ...responseModel(answeredModel, modelId),
      choices: [{ index: 0, message: { role: 'assistant', content: null }, finishReason: null }],
      ...fields,
    });
    const textChunk = (delta: string): ModelCompletionResponse =>
      chunk({
        choices: [{ index: 0, message: { role: 'assistant', content: delta }, finishReason: null }],
        responseTextDelta: delta,
      });
    // Finds the call an event names, by call id first, then output position,
    // then item id, and starts a new one when none matches.
    const trackCall = (
      outputIndex: number | undefined,
      itemId: string | undefined,
      callId?: string,
    ): StreamedResponsesCall => {
      let call =
        (callId ? calls.find((c) => c.id === callId) : undefined) ??
        (outputIndex !== undefined ? callByOutputIndex.get(outputIndex) : undefined) ??
        (itemId ? callByItemId.get(itemId) : undefined);
      if (!call) {
        call = { index: calls.length, id: '', name: '', arguments: '' };
        calls.push(call);
      }
      if (outputIndex !== undefined) callByOutputIndex.set(outputIndex, call);
      if (itemId) callByItemId.set(itemId, call);
      return call;
    };

    for await (const data of this.readResponsesSse(stream, abortSignal, reading)) {
      if (abortSignal?.aborted) break;
      // /v1/responses sends no [DONE]; treat one as the end of the body.
      if (data === '[DONE]') break;
      let event: OpenAIAPITypes.ResponsesStreamEvent;
      try {
        event = JSON.parse(data) as OpenAIAPITypes.ResponsesStreamEvent;
      } catch {
        log.warn('llm.stream_invalid', { provider: 'openai', bytes: new TextEncoder().encode(data).byteLength, reason: 'json' });
        continue;
      }

      switch (event.type) {
        case 'response.created':
        case 'response.in_progress':
          noteResponse(event.response);
          break;

        case 'response.output_text.delta':
          if (typeof event.delta === 'string' && event.delta) {
            emittedText += event.delta;
            yield textChunk(event.delta);
          }
          break;

        case 'response.refusal.delta':
          if (typeof event.delta === 'string') refusalSeen = true;
          if (typeof event.delta === 'string' && event.delta) {
            emittedRefusal += event.delta;
            yield chunk({ refusalDelta: event.delta });
          }
          break;

        case 'response.output_item.added':
        case 'response.output_item.done': {
          const item = event.item;
          if (item?.type !== 'function_call') break;
          const call = trackCall(event.output_index, item.id, item.call_id);
          const delta = reconcileStreamedCall(call, {
            id: item.call_id,
            name: item.name,
            // An added item's arguments are normally '' and carry nothing yet.
            arguments: event.type === 'response.output_item.done' ? item.arguments : item.arguments || undefined,
          });
          if (delta) yield chunk({ toolCallsDeltas: [delta] });
          break;
        }

        case 'response.function_call_arguments.delta': {
          if (typeof event.delta !== 'string' || !event.delta) break;
          const call = trackCall(event.output_index, event.item_id);
          if (call.finalArguments !== undefined) break;
          call.arguments += event.delta;
          yield chunk({ toolCallsDeltas: [{ index: call.index, function: { arguments_delta: event.delta } }] });
          break;
        }

        case 'response.function_call_arguments.done': {
          if (typeof event.arguments !== 'string') break;
          const delta = reconcileStreamedCall(trackCall(event.output_index, event.item_id), {
            arguments: event.arguments,
          });
          if (delta) yield chunk({ toolCallsDeltas: [delta] });
          break;
        }

        case 'response.completed':
        case 'response.incomplete': {
          const response = event.response;
          noteResponse(response);
          const output = response?.output ?? [];
          const summary = summarizeResponsesOutput(output);

          // The terminal output is authoritative: send whatever the deltas left out.
          const corrections: ToolCallDelta[] = [];
          output.forEach((item, outputIndex) => {
            if (item.type !== 'function_call') return;
            const delta = reconcileStreamedCall(trackCall(outputIndex, item.id, item.call_id), {
              id: item.call_id,
              name: item.name,
              arguments: item.arguments,
            });
            if (delta) corrections.push(delta);
          });
          let missingText = '';
          if (summary.text && summary.text !== emittedText) {
            if (summary.text.startsWith(emittedText)) {
              missingText = summary.text.slice(emittedText.length);
            } else {
              log.warn('llm.output_mismatch', { provider: 'openai', reason: 'text' });
            }
          }
          if (missingText || corrections.length > 0) {
            emittedText += missingText;
            const correction = missingText ? textChunk(missingText) : chunk({});
            if (corrections.length > 0) correction.toolCallsDeltas = corrections;
            yield correction;
          }
          // The refusal message too: what the refusal deltas left out goes out once, before the final chunk.
          if (summary.refusal && summary.refusal !== emittedRefusal && summary.refusal.startsWith(emittedRefusal)) {
            const missingRefusal = summary.refusal.slice(emittedRefusal.length);
            emittedRefusal = summary.refusal;
            yield chunk({ refusalDelta: missingRefusal });
          }
          // The terminal output decides whether the answer holds a refusal and what it says, as it does for the same
          // body read whole; the deltas decide only when the terminal response carries no output at all.
          const terminalOutput = summary.itemCount > 0;
          if (terminalOutput && summary.refusal !== emittedRefusal) {
            // The refusal message is text of the answer: the terminal output and the deltas disagree on it.
            log.warn('llm.output_mismatch', { provider: 'openai', reason: 'text' });
          }
          const refusal = terminalOutput ? summary.refusal : emittedRefusal;
          // A refusal part with an empty message is a refusal too.
          const refused = terminalOutput ? summary.refused : refusalSeen;

          const usage = response?.usage
            ? this.mapResponsesUsage(response.usage, response.model ?? modelId)
            : undefined;
          const status = response?.status ?? (event.type === 'response.incomplete' ? 'incomplete' : 'completed');
          if (summary.itemCount === 0 && emittedText.length === 0 && !refused && calls.length === 0) {
            // Nothing streamed and nothing in the output: the malformed body
            // the non-streamed mapping throws INVALID_RESPONSE for.
            yield chunk({
              choices: [],
              error: {
                message: `OpenAI /responses returned no usable output (status: ${status})`,
                type: 'invalid_response',
              },
              ...(usage ? { usage } : {}),
              isFinal: true,
            });
            return;
          }

          const toolCalls = calls
            .filter((c) => c.id && c.name)
            .map((c) => ({
              id: c.id,
              type: 'function' as const,
              function: { name: c.name, arguments: c.finalArguments ?? c.arguments },
            }));
          const finishReason = responsesFinishReason(
            status,
            response?.incomplete_details?.reason,
            toolCalls.length > 0,
          );
          if (emittedText.length === 0 && toolCalls.length === 0 && !refused) {
            this.warnReasoningOnlyOutput(response ?? { id: responseId, status });
          }
          yield chunk({
            ...(typeof response?.service_tier === 'string' ? { serviceTier: response.service_tier } : {}),
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
              },
              ...withRefusal(finishReason, refusal, refused),
              logprobs: null,
            }],
            usage,
            isFinal: true,
          });
          return;
        }

        case 'response.failed': {
          const response = event.response;
          noteResponse(response);
          const message = response?.error?.message ?? 'OpenAI /responses reported the response as failed';
          const usage = response?.usage ? this.mapResponsesUsage(response.usage, response.model ?? modelId) : undefined;
          if (!deliveredOutput()) throw responsesFailedError(response, usage);
          yield chunk({
            choices: [],
            error: {
              message,
              type: 'response_failed',
              ...(response?.error?.code ? { code: response.error.code } : {}),
              ...(response?.error ? { details: response.error } : {}),
            },
            ...(usage ? { usage } : {}),
            isFinal: true,
          });
          return;
        }

        case 'error': {
          const message = event.message ?? 'OpenAI /responses stream error';
          if (!deliveredOutput()) {
            throw new OpenAIProviderError(
              message,
              'RESPONSES_STREAM_ERROR',
              event.code ?? undefined,
              'stream_error',
              responsesErrorStatus(event.code),
            );
          }
          yield chunk({
            choices: [],
            error: {
              message,
              type: 'stream_error',
              ...(event.code ? { code: event.code } : {}),
            },
            isFinal: true,
          });
          return;
        }

        default:
          // Reasoning summaries, content parts, output_text.done, refusal.done (the terminal output holds the refusal).
          break;
      }
    }

    if (abortSignal?.aborted) {
      yield this.abortedStreamChunk(modelId, 'Stream aborted by caller', answeredModel);
      return;
    }
    const endMessage = reading.failure
      ? `OpenAI /responses stream failed before response.completed: ${reading.failure.message}`
      : 'OpenAI /responses stream ended before response.completed';
    if (!deliveredOutput()) {
      // A connection cut before anything arrived, which a retry or another
      // provider can serve.
      throw new OpenAIProviderError(endMessage, 'NETWORK_ERROR', undefined, 'stream_truncated', undefined, reading.failure);
    }
    yield chunk({
      choices: [],
      error: {
        message: endMessage,
        type: 'stream_truncated',
      },
      isFinal: true,
    });
  }

  /** @inheritdoc */
  public async generateEmbeddings(
    modelId: string,
    texts: string[],
    options?: ProviderEmbeddingOptions
  ): Promise<ProviderEmbeddingResponse> {
    this.ensureInitialized();
    if (!texts || texts.length === 0) {
      throw new OpenAIProviderError('Input texts array cannot be empty for embeddings.', 'EMBEDDING_NO_INPUT');
    }
    const apiKey = await this.getApiKey(options?.apiKeyOverride, options?.abortSignal);

    const payload: Record<string, unknown> = {
      model: modelId,
      input: texts,
    };
    if (options?.encodingFormat) payload.encoding_format = options.encodingFormat;
    if (options?.dimensions) payload.dimensions = options.dimensions;
    if (options?.userId) payload.user = options.userId;
    // OpenAI specific: input_type for their newer models
    if (options?.inputType && (modelId.includes('text-embedding-3') || modelId.includes('ada-002'))) {
        // Not a standard OpenAI param, this is an example if they add it.
        // For now, customModelParams is the way for non-standard things.
    }
    {
      // Strip OpenRouter routing controls, Gemini request fields and Anthropic's output_config; see openrouter-only-params.
      const passthrough = stripParamsForOpenAI(options?.customModelParams);
      if (passthrough) {
        Object.assign(payload, passthrough);
      }
    }


    // The call's signal aborts the fetch in flight (REQUEST_ABORTED), and no attempt is sent after it.
    const apiResponse = await this.makeApiRequest<OpenAIAPITypes.EmbeddingResponse>(
      '/embeddings',
      'POST',
      apiKey,
      payload,
      false,
      undefined,
      options?.abortSignal,
      // The call's own operation id, when it names one, in place of the id this request makes.
      options?.operationId ? { operationId: options.operationId } : undefined,
      this.keySourceOf(options?.apiKeyOverride),
    );

    return this.mapApiToEmbeddingResponse(apiResponse);
  }

  /** @inheritdoc */
  public async listAvailableModels(filter?: { capability?: string }): Promise<ModelInfo[]> {
    this.ensureInitialized();
    // The listing initialize() makes fills the cache. A provider that initialized with every key of its pool out
    // made none, so its first listing once a probe brings a key back fills the cache here; a filled cache is served
    // as it is.
    if (this.availableModelsCache.size === 0) {
      try {
        await this.refreshAvailableModels();
      } catch (error) {
        log.warn('llm.models_failed', { provider: 'openai', ...listedErrorFields(error) });
      }
    }

    const models = Array.from(this.availableModelsCache.values());
    if (filter?.capability) {
      return models.filter(m => m.capabilities.includes(filter.capability!));
    }
    return models;
  }

  /** @inheritdoc */
  public async getModelInfo(modelId: string): Promise<ModelInfo | undefined> {
    this.ensureInitialized();
    // Could implement a direct fetch if model not in cache, or rely on cached version.
    // For now, uses cached version.
    if (!this.availableModelsCache.has(modelId)) {
        // Attempt to refresh and check again, in case it's a new model
        try {
            await this.refreshAvailableModels();
        } catch (error) {
            log.warn('llm.models_failed', { provider: 'openai', ...listedErrorFields(error) });
        }
    }
    return this.availableModelsCache.get(modelId);
  }

  /** @inheritdoc */
  public async checkHealth(): Promise<{ isHealthy: boolean; details?: unknown }> {
    try {
      // The key a request would send: the OAuth flow's token, or the next key
      // of the pool. The configured string can be a comma-separated key list,
      // which the API rejects as a bearer token.
      const apiKey = await this.getApiKey();
      // One light call: the default model's record, or the model list when
      // no default is set. No model id is assumed, since OpenAI retires them
      // (gpt-3.5-turbo on 2026-10-23).
      await this.makeApiRequest<unknown>(
          this.defaultModelId ? `/models/${encodeURIComponent(this.defaultModelId)}` : '/models',
          'GET',
          apiKey
      );
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
    // For OpenAIProvider, using stateless HTTP requests, there might not be
    // persistent connections to close. If connection pooling or WebSockets
    // were used, they would be closed here.
    this.isInitialized = false; // Mark as not initialized
    log.info('llm.provider_stopped', { provider: 'openai' });
    // No explicit resources to release in this implementation.
  }


  // --- Helper Methods ---

  /**
   * Builds the payload for OpenAI's Chat Completions API.
   * @private
   */
  protected buildChatCompletionPayload(
    modelId: string,
    messages: ChatMessage[],
    options: ModelCompletionOptions,
    stream: boolean
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      model: modelId,
      messages: messages.map(m => ({ // Ensure null content is handled if OpenAI expects it explicitly
          role: m.role,
          content: m.content, // OpenAI allows null content for assistant tool_calls message
          name: m.name,
          // Only the standard tool-call fields go on the wire. A tool call can
          // carry provider-specific extras, such as Gemini's thoughtSignature,
          // that the Chat Completions schema does not define.
          tool_calls: m.tool_calls?.map(({ id, type, function: fn }) => ({ id, type, function: fn })),
          tool_call_id: m.tool_call_id,
      })),
      stream: stream,
    };

    // OpenAI's streaming API omits the usage object by default. Without
    // stream_options.include_usage, the final SSE chunk carries finish_reason
    // but no token counts, so downstream `streamText({...}).usage` resolves
    // to zeros. Opting in here gives every streaming caller real usage data
    // (and surfaces a final usage chunk after the [DONE] marker per
    // https://platform.openai.com/docs/api-reference/chat/create#chat-create-stream_options).
    if (stream) {
      payload.stream_options = { include_usage: true };
    }

    // Reasoning models (o-series, GPT-5) reject custom sampling params with an
    // HTTP 400 — they run only at their fixed defaults. Omit temperature/top_p
    // for them, mirroring the max_tokens → max_completion_tokens switch below.
    if (!isOpenAIReasoningModel(modelId)) {
      if (options.temperature !== undefined) payload.temperature = options.temperature;
      if (options.topP !== undefined) payload.top_p = options.topP;
    } else {
      // Reasoning models (o-series, GPT-5, GPT-6) take `reasoning_effort`
      // (none|low|medium|high|xhigh) in place of the sampling params they
      // reject. Map the agentos effort scale onto it so `effort: 'max'` drives
      // them at their xhigh ceiling. customModelParams (below) can still
      // override.
      // GPT-5 and GPT-6 reject `reasoning_effort` with function tools on
      // chat/completions. shouldRouteToOpenAiResponsesApi sends every such
      // tool call to /v1/responses; a subclass that builds a chat body for
      // one itself gets no effort here. Leaving the effort out does not make
      // OpenAI accept the call (the model applies its default effort); only
      // Responses or an explicit `none` does.
      const reasoningEffort = mapEffortToOpenAiReasoningEffortForModel(options.effort, modelId);
      const dropEffortForTools =
        requestHasFunctionTools(options.tools) &&
        openAiRejectsReasoningEffortWithTools(modelId);
      if (reasoningEffort !== undefined && !dropEffortForTools) {
        payload.reasoning_effort = reasoningEffort;
      }
    }
    if (options.maxTokens !== undefined) {
      // Clamp to the model's real output ceiling first: a request sized for
      // a flagship model (e.g. 32000 for Claude Opus) is rejected by gpt-4o
      // (max 16384) when the fallback chain routes here. The clamp is a
      // no-op for models whose ceiling is at or above the request.
      const effMaxTokens = clampMaxOutputTokens(modelId, options.maxTokens) ?? options.maxTokens;
      // OpenAI's reasoning + GPT-5 model families reject `max_tokens`
      // and require `max_completion_tokens` instead. Legacy chat
      // completions (gpt-4o, gpt-4-turbo, gpt-3.5, etc.) keep
      // `max_tokens`. The two fields are otherwise equivalent: same
      // semantic meaning, just renamed in the newer API surface.
      if (modelRequiresMaxCompletionTokens(modelId)) {
        payload.max_completion_tokens = effMaxTokens;
      } else {
        payload.max_tokens = effMaxTokens;
      }
    }
    if (!openAiRejectsPenalties(modelId)) {
      if (options.presencePenalty !== undefined) payload.presence_penalty = options.presencePenalty;
      if (options.frequencyPenalty !== undefined) payload.frequency_penalty = options.frequencyPenalty;
    }
    if (options.stopSequences !== undefined) {
      if (!openAiRejectsStop(modelId)) {
        payload.stop = options.stopSequences;
      } else {
        // The GPT-6 family refuses `stop` with HTTP 400; the call is answered in full instead.
        log.debug('llm.option_ignored', { provider: 'openai', reason: 'stop_sequences' });
      }
    }
    if (options.userId !== undefined) payload.user = options.userId;
    // Chat completions are stored by default for new accounts; the call's
    // `store` goes out as given, and a call without it sends no key, as before.
    // https://developers.openai.com/api/docs/guides/migrate-to-responses
    if (typeof options.store === 'boolean') payload.store = options.store;
    if (options.tools !== undefined) payload.tools = options.tools;
    if (options.toolChoice !== undefined) payload.tool_choice = options.toolChoice;
    // Coerce to an OpenAI-valid response_format, or drop it. agentos builds a
    // provider-specific responseFormat for the PRIMARY provider and reuses it
    // across the fallback chain; an Anthropic tool-marker / Gemini-internal
    // object reaching OpenAI verbatim makes the API reject the request
    // ("Missing required parameter: 'response_format.type'"). Mirrors the
    // guard OpenRouterProvider already applies. See openai-response-format-guard.ts.
    if (options.responseFormat !== undefined) {
      const coerced = toOpenAiResponseFormat(options.responseFormat);
      if (coerced !== undefined) payload.response_format = coerced;
    }

    // Typed OpenAI prompt-cache / service-tier policy (spec batch-1 C2).
    // customModelParams (below) keeps last-write precedence — it is the
    // raw escape hatch and intentionally overrides these typed fields.
    this.applyCacheAndTierParams(payload, modelId, options);

    {
      // Strip OpenRouter routing controls, Gemini request fields and Anthropic's output_config; see openrouter-only-params.
      const passthrough = stripParamsForOpenAI(options.customModelParams);
      if (passthrough) {
        Object.assign(payload, passthrough);
      }
    }

    return payload;
  }

  /**
   * True when requests target api.openai.com rather than an
   * OpenAI-compatible gateway (the Groq/xAI/Together/Mistral wrappers pass
   * their own baseURL). Gates zero-config defaults that emit request
   * fields some gateways reject, so the match is an exact parsed-hostname
   * comparison — a substring test would classify look-alike gateway hosts
   * (api.openai.com.example.net) as native. Tolerates an uninitialized
   * provider (payload builders are unit-tested without initialize()) and
   * malformed URLs: anything unparseable is not native, never a throw.
   * @private
   */
  private isNativeOpenAiEndpoint(): boolean {
    try {
      const url = new URL(this.config?.baseURL ?? '');
      return (
        url.protocol === 'https:' &&
        url.hostname.toLowerCase() === 'api.openai.com' &&
        (url.port === '' || url.port === '443')
      );
    } catch {
      return false;
    }
  }

  /**
   * Apply the typed prompt-cache key/retention and service-tier options to
   * an outgoing payload (Chat and Responses builders share this; spec
   * batch-1 C2). Unsupported retention combinations are omitted fail-closed
   * with a debug log — never a hard error.
   * @private
   */
  private applyCacheAndTierParams(
    payload: Record<string, unknown>,
    modelId: string,
    options: ModelCompletionOptions,
  ): void {
    // Zero-config default: on the native OpenAI endpoint the shard key
    // derives from the session id ('auto' semantics) unless the caller
    // opted out via promptCacheKey or cache: false. OpenAI-compatible
    // gateways (Groq/xAI/Together/Mistral wrappers pass their own baseURL)
    // keep the omit default — some reject unknown request fields.
    const defaultCacheKeyMode =
      options.cache !== false && this.isNativeOpenAiEndpoint() ? ('auto' as const) : undefined;
    const cacheKey = resolvePromptCacheKey(
      options.promptCacheKey ?? defaultCacheKeyMode,
      options.promptCacheSessionId ?? options.sessionId,
    );
    if (cacheKey) payload.prompt_cache_key = cacheKey;
    if (options.promptCacheRetention) {
      const retention = resolveOpenAiCacheRetentionParams(modelId, options.promptCacheRetention);
      if (retention) {
        Object.assign(payload, retention);
      } else {
        log.debug('llm.option_ignored', { provider: 'openai', reason: 'cache_retention' });
      }
    }
    if (options.serviceTier) payload.service_tier = options.serviceTier;
  }

  /**
   * Build a `/v1/responses` request body for a call
   * {@link shouldRouteToOpenAiResponsesApi} sends there: a Responses-only
   * model, or a GPT-5 or GPT-6 tool call with or without an effort.
   *
   *   - System, assistant and text-only turns carry flattened text
   *     ({@link flattenResponsesTextContent}), so cache-marked `systemBlocks`
   *     arrive joined instead of empty. A user turn with images or PDF files
   *     carries `input_text` / `input_image` / `input_file` parts, and a tool
   *     result with images becomes a `function_call_output` whose output is
   *     that part array.
   *   - A `customModelParams.messages` override, which replaces `messages`
   *     on the chat path, is what `input` is built from; the body carries no
   *     `messages` key.
   *   - `tools`, `reasoning` and `text.format` appear only when the call has
   *     function tools, an effort the model maps, or an OpenAI-shaped
   *     `responseFormat`. `stream: true` marks a streamed call; Responses has
   *     no `stream_options.include_usage` and reports usage on the terminal
   *     event.
   *   - A chat-style `reasoning_effort` in `customModelParams` moves to
   *     `reasoning.effort`, because Responses rejects the top-level key.
   *   - A chat output limit in `customModelParams` (`max_completion_tokens`,
   *     `max_tokens`) goes as `max_output_tokens`, and a limit under 16 from
   *     any source goes as 16, the least Responses takes.
   *   - The chat keys Responses has no parameter for
   *     ({@link RESPONSES_UNSUPPORTED_CHAT_PARAMS}) are left off the body when
   *     `customModelParams` sets them, with an `llm.option_ignored` debug line.
   *   - `store` is the call's `store` option, and `false` when the call sets
   *     none, since Responses stores a response by default.
   *
   * Live-probed 2026-07-08; block-content path live-probed 2026-09-12.
   *
   * @throws {OpenAIProviderError} `RESPONSES_UNMAPPABLE_CONTENT` when a
   *   message carries a part Responses cannot represent (audio, a file
   *   outside a user turn, an Anthropic `tool_result` block), or when a
   *   `customModelParams.messages` override holds an entry that is not a
   *   message object. Only a call
   *   with no Chat Completions route (a Responses-only model, a GPT-5 or
   *   GPT-6 tool call) reaches here with such content; the error is not
   *   retryable, like the 400 or 404 Chat Completions would return for it.
   * @private
   */
  private buildResponsesPayload(
    modelId: string,
    messages: ChatMessage[],
    options: ModelCompletionOptions,
    stream: boolean = false,
  ): Record<string, unknown> {
    // Strip OpenRouter routing controls, Gemini request fields and Anthropic's output_config; see openrouter-only-params.
    // The /responses body rejects unknown top-level fields just like
    // /chat/completions.
    const passthrough = stripParamsForOpenAI(options.customModelParams);
    // A `customModelParams.messages` override replaces the chat body's
    // `messages`. Responses has no `messages` key and refuses one, so the
    // override is what `input` is built from here.
    const passedMessages = passthrough?.messages;
    const overrideMessages = Array.isArray(passedMessages) ? (passedMessages as ChatMessage[]) : undefined;
    // The override is the caller's own data: an entry that is no message object cannot be mapped, and is refused
    // here as unmappable content instead of failing inside the mapper.
    if (Array.isArray(passedMessages) && passedMessages.some((m: unknown) => m === null || typeof m !== 'object')) {
      throw new OpenAIProviderError(
        `OpenAI serves ${modelId} for this call only on /v1/responses, and its customModelParams.messages ` +
          `holds an entry that is not a message object`,
        'RESPONSES_UNMAPPABLE_CONTENT',
      );
    }
    const sourceMessages = overrideMessages ?? messages;

    const unmappable = sourceMessages.find((m) => !isResponsesMappableMessage(m));
    if (unmappable) {
      const partTypes = Array.isArray(unmappable.content)
        ? Array.from(new Set(unmappable.content.map((part) => String((part as { type?: unknown })?.type))))
        : [typeof unmappable.content];
      throw new OpenAIProviderError(
        `OpenAI serves ${modelId} for this call only on /v1/responses, which cannot carry a ` +
          `'${unmappable.role}' message with content parts [${partTypes.join(', ')}]`,
        'RESPONSES_UNMAPPABLE_CONTENT',
      );
    }

    const input: Array<Record<string, unknown>> = [];
    for (const m of sourceMessages) {
      if (m.role === 'tool') {
        // Tool result → function_call_output paired by call_id.
        input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: toResponsesInputContent(m.content) });
        continue;
      }
      if (m.role === 'user') {
        input.push({ role: 'user', content: toResponsesUserContent(m.content) });
        continue;
      }
      const text = flattenResponsesTextContent(m.content);
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        // Optional assistant text first, then one function_call item per call.
        if (text.length > 0) input.push({ role: 'assistant', content: text });
        for (const tc of m.tool_calls) {
          input.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          });
        }
        continue;
      }
      // system / plain assistant. Drop an empty assistant turn (no text, no
      // tool_calls carries nothing); keep an empty system turn defensively.
      if (m.role === 'assistant' && text.length === 0) continue;
      input.push({ role: m.role, content: text });
    }

    // Responses are stored by default; a call that does not set `store` keeps
    // sending `store: false`.
    const payload: Record<string, unknown> = {
      model: modelId,
      input,
      store: typeof options.store === 'boolean' ? options.store : false,
    };
    // A Responses-only model can be called without tools, and a
    // `reasoning: {}` or `tools: undefined` key has no meaning on the wire.
    if (requestHasFunctionTools(options.tools)) payload.tools = this.toResponsesTools(options.tools);
    const effort = mapEffortToOpenAiResponsesEffort(modelId, options.effort);
    if (effort !== undefined) payload.reasoning = { effort };
    const textFormat = toOpenAiResponsesTextFormat(options.responseFormat);
    if (textFormat) payload.text = { format: textFormat };
    if (stream) payload.stream = true;
    if (options.toolChoice !== undefined) {
      payload.tool_choice = this.toResponsesToolChoice(options.toolChoice);
    }
    if (options.maxTokens !== undefined) {
      // Responses refuses a `max_output_tokens` under 16 with HTTP 400 ("Expected a value >= 16"; the reference lists
      // `minimum: 16`), so a smaller cap is sent as 16.
      const cap = clampMaxOutputTokens(modelId, options.maxTokens) ?? options.maxTokens;
      payload.max_output_tokens = Math.max(cap, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
    }
    if (options.userId !== undefined) payload.safety_identifier = options.userId;
    // presence/frequency penalties + stop are intentionally OMITTED — reasoning
    // models don't meaningfully use them and the orchestrator sets none;
    // temperature/top_p omitted (reasoning models reject them). See spec §D3.
    // Responses takes no `stop`, no penalty and no message `name` (an input
    // message is { content, role, phase, type }:
    // https://developers.openai.com/api/reference/resources/responses/methods/create).
    // A call that sets them is answered without them, and a debug line says so,
    // as the chat path does when GPT-6 refuses `stop`.
    if (options.stopSequences !== undefined) {
      log.debug('llm.option_ignored', { provider: 'openai', reason: 'stop_sequences' });
    }
    if (options.presencePenalty !== undefined || options.frequencyPenalty !== undefined) {
      log.debug('llm.option_ignored', { provider: 'openai', reason: 'penalties' });
    }
    if (sourceMessages.some((m) => m.role !== 'tool' && typeof m.name === 'string' && m.name.length > 0)) {
      log.debug('llm.option_ignored', { provider: 'openai', reason: 'message_name' });
    }

    // Typed prompt-cache / service-tier policy — same helper as the Chat
    // builder; customModelParams below keeps last-write precedence.
    this.applyCacheAndTierParams(payload, modelId, options);

    if (passthrough) {
      Object.assign(payload, passthrough);
    }
    if (overrideMessages) delete payload.messages;
    // Chat keys Responses has no parameter for (`stop`, the penalties, `seed`,
    // `n`, `logit_bias`, `logprobs`) come back with the merge above when
    // customModelParams sets them. They are left off the body, each with the
    // debug line a dropped option writes.
    for (const [key, reason] of RESPONSES_UNSUPPORTED_CHAT_PARAMS) {
      if (!(key in payload)) continue;
      delete payload[key];
      log.debug('llm.option_ignored', { provider: 'openai', reason });
    }

    // customModelParams is shared with the chat path, whose effort key is the
    // top-level `reasoning_effort`. Responses rejects that key and takes the
    // value as `reasoning.effort`, so move it there.
    if ('reasoning_effort' in payload) {
      const passedEffort = payload.reasoning_effort;
      delete payload.reasoning_effort;
      if (passedEffort !== undefined && passedEffort !== null) {
        const reasoning =
          payload.reasoning && typeof payload.reasoning === 'object'
            ? (payload.reasoning as Record<string, unknown>)
            : {};
        payload.reasoning = { ...reasoning, effort: passedEffort };
      }
    }
    // The chat path's output limits (`max_completion_tokens`, `max_tokens`)
    // are `max_output_tokens` here; Responses rejects the chat names. An
    // explicit `max_output_tokens` in customModelParams wins.
    for (const chatLimit of ['max_completion_tokens', 'max_tokens'] as const) {
      if (!(chatLimit in payload)) continue;
      const limit = payload[chatLimit];
      delete payload[chatLimit];
      const passedOutputLimit = (options.customModelParams as Record<string, unknown> | undefined)?.max_output_tokens;
      if (typeof limit === 'number' && passedOutputLimit === undefined) {
        payload.max_output_tokens = limit;
      }
    }
    // The least `max_output_tokens` Responses takes holds for a limit that
    // customModelParams set too, under a chat name or its own.
    if (typeof payload.max_output_tokens === 'number' && payload.max_output_tokens < OPENAI_RESPONSES_MIN_OUTPUT_TOKENS) {
      payload.max_output_tokens = OPENAI_RESPONSES_MIN_OUTPUT_TOKENS;
    }
    // Chat-only stream settings have no Responses counterpart.
    delete payload.stream_options;
    // Other chat-shaped overrides, reshaped because Responses rejects them as
    // written for /chat/completions: a named-function `tool_choice` (its name
    // sits under `function`), chat-style function `tools`, `response_format`
    // (Responses reads `text.format`) and a top-level `verbosity` (Responses
    // reads `text.verbosity`). Values already in the Responses shape pass
    // through unchanged.
    if (payload.tool_choice !== undefined) payload.tool_choice = this.toResponsesToolChoice(payload.tool_choice);
    if (payload.tools !== undefined) payload.tools = this.toResponsesTools(payload.tools);
    if ('response_format' in payload || 'verbosity' in payload) {
      const text: Record<string, unknown> =
        payload.text && typeof payload.text === 'object' ? { ...(payload.text as Record<string, unknown>) } : {};
      if ('response_format' in payload) {
        const format = toOpenAiResponsesTextFormat(payload.response_format);
        if (format) text.format = format;
        delete payload.response_format;
      }
      if ('verbosity' in payload) {
        if (payload.verbosity !== undefined && payload.verbosity !== null) text.verbosity = payload.verbosity;
        delete payload.verbosity;
      }
      if (Object.keys(text).length > 0) payload.text = text;
    }
    return payload;
  }

  /** Reshape chat-completions function tools → the Responses flat tool shape. */
  private toResponsesTools(tools: unknown): unknown {
    if (!Array.isArray(tools)) return tools;
    return tools.map((t) => {
      const tool = t as {
        type?: string;
        function?: { name?: string; description?: string; parameters?: unknown; strict?: boolean };
        name?: string;
      };
      if (tool?.type === 'function' && tool.function) {
        return {
          type: 'function',
          name: tool.function.name,
          description: tool.function.description,
          // Responses requires `parameters` on a function tool, so an
          // argument-less tool gets the empty object schema.
          parameters: tool.function.parameters ?? { type: 'object', properties: {} },
          // A caller's explicit `strict` is kept. Otherwise false: strict mode
          // needs a schema most tools do not have (every property required,
          // no additional properties).
          strict: tool.function.strict ?? false,
        };
      }
      return t; // already-flat or non-function tool: pass through
    });
  }

  /** Map chat-completions tool_choice → the Responses tool_choice shape. */
  private toResponsesToolChoice(toolChoice: unknown): unknown {
    if (typeof toolChoice === 'string') return toolChoice; // 'auto' | 'required' | 'none'
    const tc = toolChoice as {
      type?: string;
      function?: { name?: string };
      allowed_tools?: { mode?: unknown; tools?: unknown };
    };
    if (tc?.type === 'function' && tc.function?.name) {
      return { type: 'function', name: tc.function.name };
    }
    // Chat nests an allowed-tools choice under `allowed_tools`, with
    // `{type:'function', function:{name}}` entries; Responses takes `mode` and
    // `tools` at the top level, with flat function names.
    if (tc?.type === 'allowed_tools' && tc.allowed_tools && typeof tc.allowed_tools === 'object') {
      const { mode, tools } = tc.allowed_tools;
      return {
        type: 'allowed_tools',
        ...(mode !== undefined ? { mode } : {}),
        ...(tools !== undefined
          ? {
              tools: Array.isArray(tools)
                ? tools.map((entry) => {
                    const tool = entry as { type?: string; function?: { name?: string } };
                    return tool?.type === 'function' && tool.function?.name
                      ? { type: 'function', name: tool.function.name }
                      : entry;
                  })
                : tools,
            }
          : {}),
      };
    }
    return toolChoice;
  }

  /**
   * Map a `/v1/responses` response into the same {@link ModelCompletionResponse}
   * shape the rest of agentos consumes from chat/completions: assistant text
   * from `output_text` message parts, tool calls from `function_call` items
   * (call_id → id).
   *
   * An output array with NO items at all THROWS (→ fallback advances) rather
   * than returning an empty success (Codex-Medium-2). Output that holds items
   * but no `message`/`function_call` does NOT throw: a reasoning model returns
   * reasoning-only output when reasoning exhausts the output budget, which is
   * a legitimate `length` finish. It maps to an empty turn (`content: null`)
   * carrying the real finishReason, so the caller can retry with a larger
   * budget instead of losing a whole multi-step build to one capped turn.
   * @private
   */
  private mapResponsesToCompletionResponse(
    apiResponse: OpenAIAPITypes.ResponsesResponse,
    modelId: string
  ): ModelCompletionResponse {
    // Its own usage, priced as its request, and that of the failed results the call sent before it, priced as theirs.
    const usage = sumModelUsage(
      retriedResponsesUsage.get(apiResponse),
      apiResponse.usage ? this.mapResponsesUsage(apiResponse.usage, apiResponse.model ?? modelId) : undefined,
    );
    if (apiResponse.status === 'failed') {
      throw responsesFailedError(apiResponse, usage);
    }
    const { text: assistantText, refusal, refused, toolCalls, itemCount } = summarizeResponsesOutput(apiResponse.output);
    const finishReason = responsesFinishReason(
      apiResponse.status,
      apiResponse.incomplete_details?.reason,
      toolCalls.length > 0,
    );

    if (itemCount === 0) {
      // GENUINELY empty 2xx — no output items at all. This is the malformed
      // body the guard was written for: throw so generateText's fallback
      // advances instead of treating it as a successful empty turn.
      //
      // Deliberately NOT triggered by "items present but none usable": a
      // reasoning model returns output holding ONLY a `reasoning` item when
      // reasoning consumes the whole output budget. That is a well-formed
      // `length` finish, not a malformed body, and this check used to sit
      // ABOVE the finishReason computation — so it threw before the code that
      // already knew how to express it could run, hard-erroring entire builds
      // over one budget-capped turn.
      //
      // The body goes in `details` with `usage` in the provider's form, its own
      // and that of the failed results sent before it, so a caller meters the
      // billed requests as it meters any other error's `details.usage`.
      throw new OpenAIProviderError(
        `OpenAI /responses returned no usable output (status: ${apiResponse.status ?? 'unknown'})`,
        'INVALID_RESPONSE',
        undefined,
        undefined,
        undefined,
        { ...(apiResponse as unknown as Record<string, unknown>), ...(usage ? { usage } : {}) }
      );
    }

    if (assistantText.length === 0 && toolCalls.length === 0 && !refused) {
      this.warnReasoningOnlyOutput(apiResponse);
    }

    return {
      id: apiResponse.id,
      object: 'chat.completion',
      created: apiResponse.created_at ?? Math.floor(Date.now() / 1000),
      ...responseModel(apiResponse.model, modelId),
      ...(typeof apiResponse.service_tier === 'string' ? { serviceTier: apiResponse.service_tier } : {}),
      choices: [{
        index: 0,
        message: {
          role: 'assistant' as ModelCompletionChoice['message']['role'],
          content: assistantText.length > 0 ? assistantText : null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        },
        ...withRefusal(finishReason, refusal, refused),
        logprobs: null,
      }],
      usage,
    };
  }

  /**
   * Logs a `/v1/responses` turn that holds output items but no message and
   * no function call: reasoning-only output, written as `llm.output_empty`
   * with the output token count. It is returned as an empty turn carrying
   * the real finish reason (`length` when max_output_tokens capped it), so
   * the caller can retry with a larger budget. Reasoning tokens come out of
   * the same output budget as the visible answer, so a reasoning model needs
   * a materially larger maxTokens than a non-reasoning one to leave room for
   * a reply.
   * @private
   */
  private warnReasoningOnlyOutput(apiResponse: OpenAIAPITypes.ResponsesResponse): void {
    log.warn('llm.output_empty', { provider: 'openai', count: apiResponse.usage?.output_tokens ?? 0 });
  }

  /**
   * Token usage and cost for a `/v1/responses` result. The Responses API
   * spells the counts `input_tokens` / `output_tokens` and the cached detail
   * `input_tokens_details`; they are re-keyed to the chat spelling so both
   * endpoints meter through {@link calculateUsage}.
   * @private
   */
  private mapResponsesUsage(usage: OpenAIAPITypes.ResponsesUsage, modelId: string): ModelUsage {
    return this.calculateUsage(
      {
        prompt_tokens: usage.input_tokens,
        completion_tokens: usage.output_tokens,
        total_tokens: usage.total_tokens,
        ...(usage.input_tokens_details
          ? {
              prompt_tokens_details: {
                cached_tokens: usage.input_tokens_details.cached_tokens,
                cache_write_tokens: usage.input_tokens_details.cache_write_tokens,
                cache_write_tokens_details: usage.input_tokens_details.cache_write_tokens_details,
              },
            }
          : {}),
      },
      modelId,
    );
  }

  /**
   * Maps the raw OpenAI API Chat Completion response to the standard ModelCompletionResponse.
   * @private
   */
  private mapApiToCompletionResponse(
    apiResponse: OpenAIAPITypes.ChatCompletionResponse
  ): ModelCompletionResponse {
    return {
      id: apiResponse.id,
      object: apiResponse.object,
      created: apiResponse.created,
      modelId: apiResponse.model,
      choices: (apiResponse.choices ?? []).map(c => ({
        index: c.index,
        message: {
          role: c.message.role as ModelCompletionChoice['message']['role'],
          content: c.message.content,
          ...(this.providerId === 'minimax' && c.message.reasoning_content !== undefined
            ? { reasoningText: c.message.reasoning_content } : {}),
          tool_calls: c.message.tool_calls,
        },
        // An explicit refusal comes with an ordinary stop and no content; its message, an empty one included, is kept
        // in `refusal`.
        ...withRefusal(
          c.finish_reason,
          c.message.refusal,
          chatRefused(
            c.message.refusal ?? '',
            typeof c.message.refusal === 'string',
            (typeof c.message.content === 'string' && c.message.content.length > 0) || (c.message.tool_calls?.length ?? 0) > 0,
          ),
        ),
        logprobs: c.logprobs,
      })),
      usage: apiResponse.usage ? this.calculateUsage(apiResponse.usage, apiResponse.model) : undefined,
      ...(typeof apiResponse.service_tier === 'string' ? { serviceTier: apiResponse.service_tier } : {}),
      // No deltas for non-streaming response
    };
  }

    /**
     * Maps an OpenAI API stream chunk to a ModelCompletionResponse chunk.
     * Handles accumulation of tool calls, and of the refusal message the
     * model streams as `delta.refusal` pieces: each piece goes out as
     * `refusalDelta`, and the chunk that carries the finish reason holds the
     * whole message in `refusal`, beside that reason (`stop`, or `length`
     * for a message the output cap cut off).
     * @private
     */
    private mapApiToStreamChunkResponse(
        apiChunk: OpenAIAPITypes.ChatCompletionStreamResponse,
        accumulatedToolCalls: Map<number, { id?: string; type?: 'function'; function?: { name?: string; arguments?: string; } }>,
        accumulatedRefusal: ChatStreamRefusal = { text: '', seen: false, answered: false },
    ): ModelCompletionResponse {
        const choice = apiChunk.choices?.[0];
        let responseTextDelta: string | undefined;
        let refusalDelta: string | undefined;
        let toolCallsDeltas: ModelCompletionResponse['toolCallsDeltas'];
        let finalUsage: ModelUsage | undefined;

        // With stream_options.include_usage, OpenAI emits a trailing chunk with
        // an empty `choices` array and a populated `usage` object. That chunk
        // carries no content / no finish_reason — its only job is to deliver
        // token totals. Treat it as a final usage-only chunk so callers see
        // accurate token counts after the stream resolves.
        if ((!apiChunk.choices || apiChunk.choices.length === 0) && apiChunk.usage) {
            const usageOnlyUsage = this.calculateUsage(apiChunk.usage, apiChunk.model);
            return {
                id: apiChunk.id,
                object: apiChunk.object,
                created: apiChunk.created,
                modelId: apiChunk.model,
                choices: [],
                isFinal: true,
                usage: usageOnlyUsage,
                ...(typeof apiChunk.service_tier === 'string'
                  ? { serviceTier: apiChunk.service_tier }
                  : {}),
            };
        }

        // After the usage-only sentinel above, a healthy chunk always carries a
        // choice. Guard defensively so the non-optional accesses below
        // (choice.index, choice.delta.role) can't crash on a malformed chunk.
        if (!choice) {
            return {
                id: apiChunk.id,
                object: apiChunk.object,
                created: apiChunk.created,
                modelId: apiChunk.model,
                choices: [],
            };
        }

        if (choice?.delta?.content) {
            responseTextDelta = choice.delta.content;
            accumulatedRefusal.answered = true;
        }

        // A refusal string, an empty one included, says the answer is a refusal; its pieces go out as they come.
        if (typeof choice?.delta?.refusal === 'string') {
            accumulatedRefusal.seen = true;
            if (choice.delta.refusal) {
                refusalDelta = choice.delta.refusal;
                accumulatedRefusal.text += refusalDelta;
            }
        }

        if (choice?.delta?.tool_calls?.length) accumulatedRefusal.answered = true;

        if (choice?.delta?.tool_calls) {
            toolCallsDeltas = [];
            choice.delta.tool_calls.forEach(tcDelta => {
                let currentToolCall = accumulatedToolCalls.get(tcDelta.index);
                if (!currentToolCall) {
                    currentToolCall = { function: {} }; // Initialize if new
                    if (tcDelta.id) currentToolCall.id = tcDelta.id;
                    if (tcDelta.type) currentToolCall.type = tcDelta.type;
                }

                if (tcDelta.id && !currentToolCall.id) currentToolCall.id = tcDelta.id; // Ensure ID is set if provided in delta
                if (tcDelta.function?.name) currentToolCall.function!.name = (currentToolCall.function!.name || '') + tcDelta.function.name;
                if (tcDelta.function?.arguments) currentToolCall.function!.arguments = (currentToolCall.function!.arguments || '') + tcDelta.function.arguments;
                
                accumulatedToolCalls.set(tcDelta.index, currentToolCall);

                toolCallsDeltas!.push({
                    index: tcDelta.index,
                    id: tcDelta.id,
                    type: tcDelta.type,
                    function: tcDelta.function ? {
                        name: tcDelta.function.name,
                        arguments_delta: tcDelta.function.arguments
                    } : undefined,
                });
            });
        }
        
        const isFinal = !!choice?.finish_reason;
        if (isFinal) {
            // OpenAI might send usage in the last chunk or not at all for streams.
            // If `apiChunk.usage` exists (it's optional in stream chunks per some docs), use it.
            if (apiChunk.usage) {
                 finalUsage = this.calculateUsage(apiChunk.usage, apiChunk.model);
            }
        }
        
        // Construct the primary choice message for the response
        const responseChoice: ModelCompletionChoice = {
            index: choice.index,
            message: {
                role: (choice.delta.role || 'assistant') as ModelCompletionChoice['message']['role'], // Role usually comes once or is 'assistant'
                content: responseTextDelta || null, // Content is delta
                 // For final chunk, assemble complete tool_calls
                tool_calls: isFinal ? Array.from(accumulatedToolCalls.values()).map(accTc => ({
                    id: accTc.id!, // ID should be present by now
                    type: accTc.type!, // Type should be present
                    function: {
                        name: accTc.function!.name!,
                        arguments: accTc.function!.arguments!
                    }
                })).filter(tc => tc.id && tc.function.name) : undefined, // Only include if valid
            },
            // The chunk that ends a refused answer holds the whole refusal message beside its finish reason.
            ...(isFinal
              ? withRefusal(
                  choice.finish_reason || null,
                  accumulatedRefusal.text,
                  chatRefused(accumulatedRefusal.text, accumulatedRefusal.seen, accumulatedRefusal.answered),
                )
              : { finishReason: choice.finish_reason || null }),
            logprobs: choice.logprobs,
        };


        return {
            id: apiChunk.id,
            object: apiChunk.object,
            created: apiChunk.created,
            modelId: apiChunk.model,
            choices: [responseChoice],
            responseTextDelta,
            ...(refusalDelta !== undefined ? { refusalDelta } : {}),
            ...(this.providerId === 'minimax' && choice.delta.reasoning_content !== undefined
              ? { reasoningTextDelta: choice.delta.reasoning_content } : {}),
            toolCallsDeltas,
            isFinal,
            usage: finalUsage, // Only on the very final message from the stream
        };
    }


  /**
   * Maps the raw OpenAI API Embedding response to the standard ProviderEmbeddingResponse.
   * @private
   */
  private mapApiToEmbeddingResponse(
    apiResponse: OpenAIAPITypes.EmbeddingResponse
  ): ProviderEmbeddingResponse {
    return {
      object: 'list',
      data: apiResponse.data.map(d => ({
        object: 'embedding',
        embedding: d.embedding,
        index: d.index,
      })),
      model: apiResponse.model,
      usage: {
        prompt_tokens: apiResponse.usage.prompt_tokens,
        total_tokens: apiResponse.usage.total_tokens,
        costUSD: this.calculateCost(
          apiResponse.usage.prompt_tokens,
          0, // No completion tokens for embeddings
          apiResponse.model,
          true // isEmbedding
        ),
      },
    };
  }

  /**
   * Calculates token usage and cost.
   * @private
   */
  private calculateUsage(
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      prompt_tokens_details?: OpenAIAPITypes.CacheTokenDetails;
    },
    modelId: string
  ): ModelUsage {
    // OpenAI automatic caching reports cached prompt tokens as detail
    // fields (reads AND — on GPT-5.6+, billed 1.25x — writes; both remain
    // INCLUDED in prompt_tokens, unlike Anthropic's exclusive accounting).
    // Normalize into cacheReadInputTokens / cacheCreationInputTokens so
    // caching is visible in platform telemetry, and price them at their own
    // rates: reads at the model's cached-input rate, writes at 1.25x input
    // for the 30-minute lifetime and 2.5x for the 12-hour one
    // (estimateOpenAICostUSD). Because prompt_tokens is already inclusive
    // here, inclusiveInputTokens is prompt_tokens as-is (Anthropic computes
    // input + cache_read + cache_creation).
    const cachedTokens = usage.prompt_tokens_details?.cached_tokens;
    const cacheWriteTokens = usage.prompt_tokens_details?.cache_write_tokens;
    const extendedWriteTokens = usage.prompt_tokens_details?.cache_write_tokens_details?.ttl_12h_tokens;
    return {
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      costUSD: this.calculateCost(usage.prompt_tokens, usage.completion_tokens, modelId, false, {
        cachedTokens,
        cacheWriteTokens,
        cacheWriteExtendedTokens: extendedWriteTokens,
      }),
      ...(typeof usage.prompt_tokens === 'number'
        ? { inclusiveInputTokens: usage.prompt_tokens }
        : {}),
      ...(typeof cachedTokens === 'number' && cachedTokens >= 0
        ? { cacheReadInputTokens: cachedTokens }
        : {}),
      ...(typeof cacheWriteTokens === 'number' && cacheWriteTokens >= 0
        ? { cacheCreationInputTokens: cacheWriteTokens }
        : {}),
      ...(typeof extendedWriteTokens === 'number' && extendedWriteTokens >= 0
        ? { cacheCreationExtendedInputTokens: extendedWriteTokens }
        : {}),
    };
  }

  /**
   * Price-table row for a model id. OpenAI responses name the dated snapshot
   * that served the call (`gpt-4.1-2025-04-14` for a `gpt-4.1` request), and
   * usage is costed from that response id, so an exact miss retries with a
   * trailing `-YYYY-MM-DD` removed. An exact row still wins, which keeps
   * snapshots priced apart from their alias (`gpt-4o-2024-05-13`,
   * `o3-pro-2025-06-10`).
   *
   * @param modelId Model id as requested or as echoed by the API.
   * @returns USD per 1K tokens, or undefined when no row matches.
   */
  private resolvePricing(modelId: string | undefined): { input: number; output: number } | undefined {
    return openAIModelPricing(modelId);
  }

  /**
   * Estimated USD cost of one API call, from the per-1K rates in
   * `modelPricing` ({@link estimateOpenAICostUSD}): cache reads at the model's
   * cached-input rate, cache writes at 1.25x input for the 30-minute lifetime
   * and 2.5x for the 12-hour one on GPT-5.6 and later. When the model has
   * long-context pricing ({@link openAiHasLongContextPricing}) and the prompt
   * exceeds {@link OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS} input tokens, the
   * whole call bills at the long-context rates: every input rate at 2x and the
   * output at 1.5x.
   *
   * @param promptTokens Input tokens, cached tokens included. OpenAI compares
   *   this same count against the long-context threshold.
   * @param completionTokens Output tokens, reasoning tokens included.
   * @param modelId Model id as echoed by the API; a dated snapshot without its
   *   own row resolves to its base row.
   * @param isEmbedding Prices `promptTokens` alone at the embedding rate.
   * @param cache The usage's cache counts: tokens read, written, and written
   *   for 12 hours.
   * @returns Cost in USD, or undefined when the model has no price row.
   * @private
   */
  private calculateCost(
    promptTokens: number,
    completionTokens: number,
    modelId: string,
    isEmbedding: boolean = false,
    cache: { cachedTokens?: number; cacheWriteTokens?: number; cacheWriteExtendedTokens?: number } = {}
  ): number | undefined {
    const pricing = this.resolvePricing(modelId);
    if (!pricing) return undefined; // Pricing info not available

    if (isEmbedding) {
      return (promptTokens / 1000) * pricing.input;
    }
    return estimateOpenAICostUSD(modelId, { promptTokens, completionTokens, ...cache });
  }

  /**
   * Makes an API request to OpenAI with error handling and retries.
   * @private
   * @template T The expected response type.
   * @param {string} endpoint - The API endpoint (e.g., "/chat/completions").
   * @param {'GET' | 'POST'} method - HTTP method.
   * @param {string} apiKey - The API key to use.
   * @param {Record<string, unknown>} [body] - The request body for POST requests.
   * @param {boolean} [expectStream] - Whether the response is expected to be a stream.
   * @param {number} [requestTimeoutOverride] - Per-call timeout in ms, over the configured default.
   * @param {AbortSignal} [abortSignal] - Caller's signal. It aborts the fetch in flight, and once
   *   it has fired no further attempt is sent.
   * @param [attempts] - The call's attempt count (`max`, the configured `maxRetries` when left out) and its
   *   report (`onAttempt`, called once for each attempt sent, with the answer of its last send). A
   *   {@link CountingAttemptBudget} authorizes each attempt before it is sent, so one past the count is refused
   *   first; a key hop re-sends inside its attempt and is not counted. `operationId`, the call's own id, goes in
   *   the operation id header in place of one this request makes.
   * @returns {Promise<T | ReadableStream<Uint8Array>>} The API response or stream.
   * @throws {OpenAIProviderError} If the request fails after retries or for non-retryable errors;
   *   `REQUEST_ABORTED` when the caller's signal ends it.
   * @throws {RangeError} When the attempt count is not a whole number of 1 or more, or the operation id header's
   *   name is refused (`operationIdHeader`); nothing is sent.
   */
  private async makeApiRequest<T = unknown>(
    endpoint: string,
    method: 'GET' | 'POST',
    apiKey: string,
    body?: Record<string, unknown>,
    expectStream?: false,
    requestTimeoutOverride?: number,
    abortSignal?: AbortSignal,
    attempts?: { max?: number; onAttempt?: (outcome: AttemptOutcome) => void; operationId?: string },
    keySource?: 'pool' | 'override' | 'oauth',
  ): Promise<T>;
  private async makeApiRequest(
    endpoint: string,
    method: 'GET' | 'POST',
    apiKey: string,
    body: Record<string, unknown> | undefined,
    expectStream: true,
    requestTimeoutOverride?: number,
    abortSignal?: AbortSignal,
    attempts?: { max?: number; onAttempt?: (outcome: AttemptOutcome) => void; operationId?: string },
    keySource?: 'pool' | 'override' | 'oauth',
  ): Promise<ReadableStream<Uint8Array>>;
  private async makeApiRequest<T = unknown>(
    endpoint: string,
    method: 'GET' | 'POST',
    apiKey: string,
    body?: Record<string, unknown>,
    expectStream: boolean = false,
    requestTimeoutOverride?: number,
    abortSignal?: AbortSignal,
    attempts?: { max?: number; onAttempt?: (outcome: AttemptOutcome) => void; operationId?: string },
    keySource?: 'pool' | 'override' | 'oauth',
  ): Promise<T | ReadableStream<Uint8Array>> {
    const url = `${this.config.baseURL}${endpoint}`;
    // The key this request sends; a key-scoped failure swaps it for the next
    // usable key of the pool (never a per-request override or an OAuth
    // token, which the pool does not hold).
    let currentKey = apiKey;
    // Only a key the pool handed out is marked or hopped: a per-request
    // override (even one equal to a pool key) and an OAuth token are the
    // caller's choice. Without the origin, membership decides.
    const fromPool = keySource === undefined ? (this.keyPool?.has(apiKey) ?? false) : keySource === 'pool';
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${currentKey}`,
      'User-Agent': 'AgentOS/1.0 (OpenAIProvider)',
      ...(this.config.customHeaders || {}),
    };
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
    }
    if (this.config.organizationId) {
      headers['OpenAI-Organization'] = this.config.organizationId;
    }
    // One operation id for the whole call, the call's own when it names one: every attempt and key hop below sends
    // this same value. It replaces a customHeaders entry of the same name in another case, which fetch would join with
    // it into one field.
    setOperationIdHeaders(headers, operationIdHeaders(this.config.operationIdHeader, attempts?.operationId));

    let lastError: Error = new OpenAIProviderError('Request failed after all retries.', 'MAX_RETRIES_REACHED');

    // The requests this call may send, a first and its retries together: the call's own count, or the
    // configured one. The attempt authorizer the voice platform calls before each of its requests counts
    // them here too, so an attempt past the count is refused before anything is sent.
    const allowed = attempts?.max ?? this.config.maxRetries!;
    if (!Number.isInteger(allowed) || allowed < 1) throw new RangeError('maxAttempts is a whole number, 1 or more');
    const budget = new CountingAttemptBudget({ maxAttempts: allowed, perAttempt: {} });
    // Each attempt sent is reported once, with the status of its last send's answer, or with none when no answer came,
    // and an error status with the tokens its body reported, which a later attempt's error would otherwise replace.
    let reported = -1;
    const report = (attempt: number, status: number | null, ok: boolean, usage?: unknown): void => {
      if (attempt === reported) return;
      reported = attempt;
      try {
        attempts?.onAttempt?.({ attempt: attempt + 1, status, ok, ...(usage !== undefined && usage !== null ? { usage } : {}) });
      } catch {
        // a caller's callback never ends the request
      }
    };
    // The tokens of the /v1/responses results marked failed that were sent again: billed, and reported by no later
    // answer, so they are added to the result the call returns or to the error it ends with.
    const requestModel = typeof body?.model === 'string' ? body.model : '';
    let retriedUsage: ModelUsage | undefined;
    const ending = (error: Error): Error => this.withRetriedUsage(error, retriedUsage, requestModel);
    for (let attempt = 0; ; attempt++) {
      if (abortSignal?.aborted) {
        throw ending(new OpenAIProviderError('Request aborted by caller.', 'REQUEST_ABORTED'));
      }
      try {
        await budget.authorize({ purpose: attempt === 0 ? 'initial' : 'retry' });
      } catch (refused) {
        if (refused instanceof AttemptBudgetExhaustedError) break;
        throw refused;
      }
      const last = attempt === allowed - 1;
      const controller = new AbortController();
      // CR8: honor a per-call requestTimeout override (e.g. long codegen) over
      // the provider's default; only Anthropic read this before.
      const effectiveTimeout =
        typeof requestTimeoutOverride === 'number' && requestTimeoutOverride > 0
          ? requestTimeoutOverride
          : this.config.requestTimeout;
      const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);
      // The caller's signal aborts this attempt's fetch as the timer does. The
      // listener is removed when the attempt settles; a returned stream body
      // is cancelled by parseSseStream instead.
      const abortAttempt = () => controller.abort();
      abortSignal?.addEventListener('abort', abortAttempt, { once: true });
      // Set once the fetch has begun, so a request that got no answer is reported as sent, and one whose
      // body would not serialize is not.
      let sent = false;
      let attemptStartedAt = Date.now();

      try {
        const requestOptions: RequestInit = {
          method,
          headers: { ...headers },
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        };

        sent = true;
        let response = await fetch(url, requestOptions);
        // A key-scoped failure (a bad or revoked key, an unpaid account, a
        // throttle) takes the key out of rotation and re-sends the same
        // request with the next usable key inside this attempt, so a hop
        // spends none of the attempt budget; the attempt's timeout bounds
        // the hops together, and a pool of several keys hops at most once
        // per key.
        let keyErrorData: OpenAIAPITypes.APIErrorResponse | undefined;
        let keyHops = 0;
        while (!response.ok && fromPool && this.keyPool && this.keyPool.size > 1 && this.keyPool.has(currentKey)) {
          keyErrorData = await response.json().catch(() => ({}));
          const kind = classifyKeyFailure(response.status, JSON.stringify(keyErrorData));
          if (!kind) break;
          const serverRetryAfterMs = retryAfterMs(response.headers.get('retry-after'), undefined, this.config.keyPool?.maxRetryAfterMs);
          this.keyPool.markFailed(currentKey, kind, {
            status: response.status,
            at: attemptStartedAt,
            ...(serverRetryAfterMs !== null ? { retryAfterMs: serverRetryAfterMs } : {}),
          });
          if (this.keyPool.usable() === 0) {
            if (kind !== 'quota') {
              // Every send of this attempt answered: the attempt is reported with its last answer, not as one that
              // got none (the catch below reports only an attempt not reported yet).
              report(attempt, response.status, false, keyErrorData?.usage);
              throw this.allKeysFailedError(keyErrorData?.error?.message, response.status, keyErrorData?.error?.type, keyErrorData?.error?.code ?? undefined);
            }
            break;
          }
          if (++keyHops >= this.keyPool.size) break;
          const nextKey = this.keyPool.next();
          if (nextKey === '') {
            report(attempt, response.status, false, keyErrorData?.usage);
            throw this.allKeysFailedError();
          }
          currentKey = nextKey;
          headers['Authorization'] = `Bearer ${currentKey}`;
          attemptStartedAt = Date.now();
          keyErrorData = undefined;
          response = await fetch(url, { ...requestOptions, headers: { ...headers } });
        }
        clearTimeout(timeoutId);
        if (response.ok) report(attempt, response.status, true);

        if (!response.ok) {
          const errorData: OpenAIAPITypes.APIErrorResponse = keyErrorData ?? (await response.json().catch(() => ({})));
          // Reported once its body is read, so the attempt carries the tokens the body says it billed; a body that
          // parsed to null is still reported with its status.
          report(attempt, response.status, false, (errorData as OpenAIAPITypes.APIErrorResponse | null)?.usage);
          const errorMessage = errorData.error?.message || `HTTP error ${response.status}: ${response.statusText}`;
          const errorType = errorData.error?.type;
          const errorCode = errorData.error?.code;
          
          // Non-retryable errors
          if (response.status === 401 || response.status === 403 || response.status === 400 || response.status === 404) {
            throw new OpenAIProviderError(errorMessage, 'API_CLIENT_ERROR', errorCode || undefined, errorType, response.status, errorData);
          }
          // For other server errors or rate limits, prepare for retry
          lastError = new OpenAIProviderError(errorMessage, 'API_SERVER_ERROR', errorCode || undefined, errorType, response.status, errorData);
          if (response.status === 429) {
            lastError = new OpenAIProviderError(errorMessage, 'RATE_LIMIT_EXCEEDED', errorCode || undefined, errorType, response.status, errorData);
            // On the last attempt the loop goes on to the budget's refusal, which ends it with lastError.
            if (!last) {
              // Retry-After is authoritative when present, as delay-seconds or an HTTP-date, bounded the way the
              // pool bounds a key's rest (maxRetryAfterMs, one hour); otherwise jittered backoff. The caller's
              // abort ends the wait, and the loop's check then reports it. The event carries the scheduled wait.
              const waitMs =
                retryAfterMs(response.headers.get('retry-after'), undefined, this.config.keyPool?.maxRetryAfterMs) ??
                computeRetryBackoffMs(attempt);
              log.warn('llm.retry', { provider: 'openai', status: response.status, attempt: attempt + 1,
                waitMs: Number.isFinite(waitMs) ? Math.round(waitMs) : 0 });
              await waitForRetry(waitMs, abortSignal);
            }
            continue; // Retry
          }
          if (response.status >= 500) {
            if (!last) {
              const waitMs = computeRetryBackoffMs(attempt); // jittered exponential backoff
              log.warn('llm.retry', { provider: 'openai', status: response.status, attempt: attempt + 1, waitMs });
              await waitForRetry(waitMs, abortSignal);
            }
            continue; // Retry
          }
          throw lastError; // If not explicitly handled for retry, throw
        }

        if (expectStream) {
          if (fromPool && this.keyPool?.has(currentKey)) this.keyPool.markSuccess(currentKey, attemptStartedAt);
          if (!response.body) {
            throw new OpenAIProviderError('Expected a stream response but body was null.', 'STREAM_BODY_NULL');
          }
          return response.body;
        }
        const answer = (await response.json()) as T;
        // A /v1/responses result marked `failed` with a retryable error code (`server_error`, `rate_limit_exceeded`,
        // `vector_store_timeout`) comes with a 200: it is sent again while the call has attempts left, as a 5xx is. The
        // last one is returned, and the mapper throws its RESPONSES_FAILED. Its usage, priced as the request it was, is
        // added to what the call returns or ends with (`retriedUsage`).
        const failedStatus = endpoint === '/responses' ? retryableFailedResponseStatus(answer) : undefined;
        const pooled = fromPool && this.keyPool?.has(currentKey) === true;
        // A result throttled in its body is the key's 429: the key rests as a 429 rests it, and is never marked a
        // success. Any other answer marks its key a success once its body has been read.
        if (pooled && failedStatus === 429) {
          if (this.keyPool!.size > 1) {
            const kind = classifyKeyFailure(429, JSON.stringify(answer)) ?? 'quota';
            this.keyPool!.markFailed(currentKey, kind, { status: 429, at: attemptStartedAt });
          }
        } else if (pooled) {
          this.keyPool!.markSuccess(currentKey, attemptStartedAt);
        }
        if (failedStatus !== undefined && !last) {
          const failed = answer as OpenAIAPITypes.ResponsesResponse;
          if (failed.usage) retriedUsage = sumModelUsage(retriedUsage, this.mapResponsesUsage(failed.usage, failed.model ?? requestModel));
          lastError = responsesFailedError(failed, undefined);
          // The retry of a throttled result goes out with the key the pool draws next: a usable one, or, when every
          // key is resting, the one whose rest ends soonest, the key just rested among them.
          if (pooled && failedStatus === 429 && this.keyPool!.size > 1) {
            const nextKey = this.keyPool!.next();
            if (nextKey !== '') {
              currentKey = nextKey;
              headers['Authorization'] = `Bearer ${currentKey}`;
            }
          }
          const waitMs = computeRetryBackoffMs(attempt);
          log.warn('llm.retry', { provider: 'openai', status: failedStatus, attempt: attempt + 1, waitMs });
          await waitForRetry(waitMs, abortSignal);
          continue;
        }
        if (retriedUsage && answer && typeof answer === 'object') retriedResponsesUsage.set(answer, retriedUsage);
        return answer;

      } catch (error: unknown) {
        clearTimeout(timeoutId);
        // A request that got no answer (a timeout, a network failure, or the caller's abort once the fetch
        // had begun) is reported as sent; an answer was reported as it came, so nothing is reported twice.
        if (sent) report(attempt, null, false);
        // A caller abort ends the request here; it is not a timeout to retry.
        if (abortSignal?.aborted) {
          throw ending(new OpenAIProviderError('Request aborted by caller.', 'REQUEST_ABORTED'));
        }
        if (error instanceof OpenAIProviderError) { // If already our custom error, re-throw if not retryable
             if (error.code === 'API_CLIENT_ERROR' || error.code === 'ALL_KEYS_FAILED') throw ending(error);
             lastError = error;
        } else if (error instanceof Error && error.name === 'AbortError') {
          lastError = new OpenAIProviderError(`Request timed out after ${effectiveTimeout}ms.`, 'REQUEST_TIMEOUT', undefined, undefined, undefined, error);
        } else {
          // fetch quotes a URL it rejects (base URL credentials included) and
          // a header value it rejects (the key), so the message is masked and
          // the raw error is not kept.
          lastError = new OpenAIProviderError(
            redactUrlSecrets(error instanceof Error ? error.message : 'Network or unknown error', this.config.baseURL, [apiKey, currentKey]),
            'NETWORK_ERROR',
          );
        }
        
        if (last) {
          break; // Last attempt failed, break to throw lastError
        }
        // Equal-jitter exponential backoff for retries not handled by 429
        const delay = computeRetryBackoffMs(attempt);
        log.warn('llm.retry', { provider: 'openai', status: 0, attempt: attempt + 1, waitMs: delay });
        await waitForRetry(delay, abortSignal);
      } finally {
        abortSignal?.removeEventListener('abort', abortAttempt);
      }
    }
    // For network errors, replace the cryptic cause chain with a clean message
    if (lastError instanceof OpenAIProviderError && lastError.code === 'NETWORK_ERROR') {
      throw ending(new OpenAIProviderError(
        redactUrlSecrets(
          `Network error: unable to reach ${this.config.baseURL}. Check your internet connection.`,
          this.config.baseURL,
          [apiKey],
        ),
        'NETWORK_ERROR',
      ));
    }
    throw ending(lastError); // Throw the last encountered error after all retries
  }

  /**
   * `error` with the usage of the `/v1/responses` results marked failed that the call sent again (`retried`, each
   * priced as the request it was) added to the usage it reports in `details.usage`, in the provider's form, so a
   * caller meters them as it meters the error's own: an error body's own usage is priced alone and added. Its other
   * details are kept (a cause that is not a plain object goes under `cause`). Without such usage, or for an error that
   * is not this provider's, `error` itself.
   * @private
   */
  private withRetriedUsage(error: Error, retried: ModelUsage | undefined, model: string): Error {
    if (!retried || !(error instanceof OpenAIProviderError)) return error;
    const details = error.details;
    const plain = details !== null && typeof details === 'object' && !(details instanceof Error) && !Array.isArray(details);
    const own = plain ? this.usageOfErrorBody((details as { usage?: unknown }).usage, model) : undefined;
    const usage = sumModelUsage(retried, own);
    const withUsage = new OpenAIProviderError(
      error.message,
      error.code,
      error.openaiErrorCode,
      error.openaiErrorType,
      error.httpStatus,
      plain ? { ...(details as Record<string, unknown>), usage } : details === undefined ? { usage } : { cause: details, usage },
    );
    withUsage.stack = error.stack;
    return withUsage;
  }

  /**
   * An error body's usage priced as its request: the Responses spelling (`input_tokens`), the Chat Completions one
   * (`prompt_tokens`), or the provider's form as it is; undefined for anything else.
   * @private
   */
  private usageOfErrorBody(usage: unknown, model: string): ModelUsage | undefined {
    if (!usage || typeof usage !== 'object') return undefined;
    const wire = usage as Record<string, unknown>;
    const counted = (...keys: string[]): boolean => keys.some((key) => typeof wire[key] === 'number');
    if (counted('input_tokens', 'output_tokens')) return this.mapResponsesUsage(usage as OpenAIAPITypes.ResponsesUsage, model);
    if (counted('prompt_tokens', 'completion_tokens')) {
      return this.calculateUsage(usage as { prompt_tokens: number; completion_tokens: number; total_tokens: number }, model);
    }
    return counted('promptTokens', 'completionTokens', 'totalTokens') ? (usage as ModelUsage) : undefined;
  }

  /**
   * {@link parseSseStream} for the /v1/responses mapper: a read that fails
   * mid-body (parseSseStream's `STREAM_PARSING_ERROR`) ends the stream and is
   * recorded on `reading.failure` instead of propagating, so the mapper
   * handles it like a body cut off before its terminal event.
   * @private
   */
  private async *readResponsesSse(
    stream: ReadableStream<Uint8Array>,
    abortSignal: AbortSignal | undefined,
    reading: { failure?: OpenAIProviderError },
  ): AsyncGenerator<string, void, undefined> {
    try {
      yield* this.parseSseStream(stream, abortSignal);
    } catch (error: unknown) {
      if (error instanceof OpenAIProviderError && error.code === 'STREAM_PARSING_ERROR') {
        reading.failure = error;
        return;
      }
      throw error;
    }
  }

  /**
   * Parses an SSE (Server-Sent Events) stream and yields each `data:` payload.
   *
   * When `abortSignal` fires, the reader is cancelled at once, which settles
   * a read that is waiting on the network, and the generator ends without
   * yielding more; the caller then emits its abort chunk.
   * @private
   */
  private async *parseSseStream(
    stream: ReadableStream<Uint8Array>,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<string, void, undefined> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const cancelOnAbort = () => {
      reader.cancel().catch(() => undefined);
    };
    abortSignal?.addEventListener('abort', cancelOnAbort, { once: true });

    try {
      while (!abortSignal?.aborted) {
        const { done, value } = await reader.read();
        if (done || abortSignal?.aborted) break;

        buffer += decoder.decode(value, { stream: true });
        
        let eolIndex;
        // An SSE event is typically defined by "data: ...\n\n"
        // Or multiple "data: ..." lines followed by \n\n
        while ((eolIndex = buffer.indexOf('\n\n')) >= 0) {
            const messageBlock = buffer.substring(0, eolIndex);
            buffer = buffer.substring(eolIndex + 2); // +2 for \n\n

            const lines = messageBlock.split('\n');
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const dataContent = line.substring('data: '.length).trim();
                    if (dataContent) { // Ensure not empty data string
                        yield dataContent;
                    }
                }
            }
        }
      }
      if (abortSignal?.aborted) return;
      // A body that ends without the closing blank line leaves its last block
      // in the buffer. Treat it as one block, so a terminal `event:` +
      // `data:` pair (the /v1/responses framing) is read like any other.
      buffer += decoder.decode();
      const trailing = buffer.trim();
      if (trailing) {
        let sawData = false;
        for (const line of buffer.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          sawData = true;
          const dataContent = line.substring('data: '.length).trim();
          if (dataContent) yield dataContent;
        }
        // Sometimes the final [DONE] is not prefixed by "data: ".
        if (!sawData) {
          if (trailing === '[DONE]') yield '[DONE]';
          else log.warn('llm.stream_invalid', { provider: 'openai', bytes: new TextEncoder().encode(buffer).byteLength, reason: 'framing' });
        }
      }

    } catch (error: unknown) {
        // A read that fails because the caller aborted is the abort, not a stream error.
        if (abortSignal?.aborted) return;
        const message = error instanceof Error ? error.message : 'Stream parsing error';
        log.error('llm.stream_failed', { provider: 'openai', ...listedErrorFields(error) });
        throw new OpenAIProviderError(message, 'STREAM_PARSING_ERROR', undefined, undefined, undefined, error);
    } finally {
      abortSignal?.removeEventListener('abort', cancelOnAbort);
      // Ensure stream is closed if `break` or `return` is called within the generator
      if (!reader.closed) {
          await reader.cancel().catch(err => log.warn('llm.stream_cancel_failed', { provider: 'openai', ...listedErrorFields(err) }));
      }
      // console.log("OpenAIProvider: SSE Stream parsing finished.");
    }
  }
}
