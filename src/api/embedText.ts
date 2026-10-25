/**
 * @file embedText.ts
 * Provider-agnostic text embedding generation for the AgentOS high-level API.
 *
 * Dispatches embedding requests to the OpenAI-compatible embeddings endpoints
 * of OpenAI, OpenRouter, Mistral and Requesty (or a base URL the caller sets),
 * to Ollama, or to Gemini, using the same provider resolution pipeline as
 * {@link generateText}. A provider's key goes only to that provider's endpoint
 * or to a base URL the caller set; a provider with no embeddings is refused
 * before its key is read.
 * Supports single and batch text inputs, optional dimensionality reduction,
 * and returns raw float vectors.
 *
 * @see {@link generateText} for the text generation primitive.
 * @see {@link resolveModelOption} for model resolution with `TaskType = 'embedding'`.
 */
import { resolveModelOption, resolveProvider } from './model.js';
import type { AttemptOutcome } from '../core/llm/providers/IProvider.js';
import { GeminiProvider } from '../core/llm/providers/implementations/GeminiProvider.js';
import { MISTRAL_DEFAULT_BASE_URL } from '../core/llm/providers/implementations/MistralProvider.js';
import { OPENAI_DEFAULT_BASE_URL } from '../core/llm/providers/implementations/OpenAIProvider.js';
import { OPENROUTER_DEFAULT_BASE_URL } from '../core/llm/providers/implementations/OpenRouterProvider.js';
import { REQUESTY_DEFAULT_BASE_URL } from '../core/llm/providers/implementations/RequestyProvider.js';
import { GeminiProviderError } from '../core/llm/providers/errors/GeminiProviderError.js';
import { getDefaultProvider } from './runtime/global-default.js';
import { GEMINI_DEFAULT_EMBEDDING_MODEL, PROVIDER_DEFAULTS } from './runtime/provider-defaults.js';
import { attachGenAiAttributes, attachUsageAttributes, toTurnMetricUsage } from './observability.js';
import { recordAgentOSUsage, type AgentOSUsageLedgerOptions } from './runtime/usageLedger.js';
import { recordAgentOSTurnMetrics, withAgentOSSpan } from '../safety/evaluation/observability/otel.js';
import { redactUrlSecrets } from '../core/llm/providers/url-secrets.js';
import {
  asSpendBudget,
  assertCallWithinBudget,
  costOfUsageUSD,
  type SpendBudget,
  type SpendBudgetOptions,
} from './runtime/spendBudget.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options for an {@link embedText} call.
 *
 * At minimum, `input` must be provided. Provider/model resolution follows
 * the same rules as {@link generateText}: supply `provider`, `model`
 * (the combined `provider:model` string is also accepted), or rely on
 * env-var auto-detection.
 *
 * @example
 * ```ts
 * const opts: EmbedTextOptions = {
 *   provider: 'openai',
 *   model: 'text-embedding-3-small',
 *   input: ['Hello world', 'Goodbye world'],
 *   dimensions: 256,
 * };
 * ```
 */
export interface EmbedTextOptions {
  /**
   * Provider name. When supplied without `model`, the default embedding model
   * for the provider is resolved automatically from the built-in defaults.
   *
   * Embeds on `openai`, `openrouter`, `mistral` and `requesty` (each at its own
   * OpenAI-compatible embeddings endpoint), `gemini` and `ollama`. Another
   * provider agentos knows has no embeddings it can send to (Anthropic, Groq,
   * Together AI, xAI, MiniMax, the image providers and the CLIs), and a call
   * to one is refused before its key is read.
   *
   * @example `"openai"`, `"mistral"`, `"ollama"`, `"gemini"`
   */
  provider?: string;

  /**
   * Model identifier. Prefer the plain model name with `provider` set;
   * the combined `"provider:model"` string is also accepted.
   *
   * @example `"text-embedding-3-small"` (with `provider: 'openai'`), `"nomic-embed-text"`
   */
  model?: string;

  /**
   * Text(s) to embed. Pass a single string for one embedding or an array
   * for batch processing.
   *
   * @example
   * ```ts
   * // Single input
   * input: 'Hello world'
   * // Batch input
   * input: ['Hello world', 'Goodbye world']
   * ```
   */
  input: string | string[];

  /**
   * Desired output dimensionality. Only honoured by models that support
   * dimension reduction (e.g. OpenAI `text-embedding-3-*` with `dimensions`).
   * Ignored when the model has a fixed output size.
   */
  dimensions?: number;

  /**
   * Maximum inputs per OpenAI-compatible request, an integer from 1 to 2048.
   * Defaults to 2048. Native Gemini and Ollama ignore this option.
   * OpenAI allows 2048 inputs and 300,000 total input tokens per request:
   * https://developers.openai.com/api/reference/resources/embeddings/methods/create
   * (read 2026-10-12). Requests also stay within 300,000 UTF-8 bytes as a
   * conservative token bound. A single input above that byte bound is rejected;
   * callers must still respect the model's per-input token limit.
   */
  maxInputsPerRequest?: number;

  /** Override the API key instead of reading from environment variables. */
  apiKey?: string;

  /**
   * Override the provider base URL (useful for local proxies or Ollama). An
   * OpenAI-compatible request goes to `<baseUrl>/embeddings` with the call's
   * key. A provider agentos does not know (a gateway or proxy of your own)
   * needs it, or a global default's `baseUrl`: without one the call is
   * refused, since agentos knows no endpoint for its key. A provider with no
   * embeddings (Anthropic, Groq, Together AI, xAI, MiniMax) is refused
   * whatever the base URL.
   */
  baseUrl?: string;

  /** Optional durable usage ledger configuration for helper-level accounting. */
  usageLedger?: AgentOSUsageLedgerOptions;

  /**
   * A spend budget for this call and, when the same {@link SpendBudget} instance is passed to several calls, for all of
   * them: the request is checked against what is left before it is sent, its input priced at the model's row, and
   * its cost recorded after it.
   */
  budget?: SpendBudget | SpendBudgetOptions;

  /**
   * Ends the call when it aborts: the embedding request in flight is cancelled, no further request starts, and the
   * call rejects with the signal's reason.
   */
  abortSignal?: AbortSignal;

  /**
   * The most requests a batch sends; a batch is sent once and never retried here, so any count from 1 allows it
   * and the option stands for parity with the completion calls. Below 1 is refused with a `RangeError`.
   */
  maxAttempts?: number;

  /**
   * Called after each request this call sent to an OpenAI-compatible endpoint, one a batch: its number (1), its
   * HTTP status or null when none came, and whether it succeeded. Gemini's and Ollama's requests are not reported.
   */
  onAttempt?: (outcome: AttemptOutcome) => void;
}

/**
 * The result returned by {@link embedText}.
 *
 * @example
 * ```ts
 * const { embeddings, usage } = await embedText({
 *   provider: 'openai',
 *   model: 'text-embedding-3-small',
 *   input: ['Hello', 'World'],
 * });
 * console.log(embeddings.length); // 2
 * console.log(embeddings[0].length); // e.g. 1536
 * ```
 */
export interface EmbedTextResult {
  /**
   * One embedding vector per input string. Each vector is a plain `number[]`
   * of floats whose dimensionality depends on the model (and the optional
   * `dimensions` parameter).
   */
  embeddings: number[][];

  /** Model identifier reported by the provider (may differ from the requested model). */
  model: string;

  /** Provider identifier used for the run. */
  provider: string;

  /**
   * Token usage for the embedding request.
   * Most embedding APIs only report prompt tokens (the input); completion
   * tokens are typically zero.
   */
  usage: {
    /** Number of tokens consumed by the input text(s). */
    promptTokens: number;
    /** Sum of prompt and any other tokens (usually equal to `promptTokens`). */
    totalTokens: number;
    /**
     * Cost in USD: Gemini's when it prices the call itself (embedding models
     * with a catalog price), and an OpenAI embedding model's from OpenAI's
     * price table. Absent when neither is known.
     */
    costUSD?: number;
  };
}

// ---------------------------------------------------------------------------
// Provider-specific response types (internal)
// ---------------------------------------------------------------------------

/**
 * Shape of a single embedding object in an OpenAI-compatible response.
 * @internal
 */
interface OpenAIEmbeddingData {
  /** Ordinal index matching the input order. */
  index: number;
  /** The raw float embedding vector. */
  embedding: number[];
}

/**
 * Shape of the top-level response from the OpenAI `/v1/embeddings` endpoint
 * (also used by OpenRouter, Mistral, Requesty and compatible proxies).
 * @internal
 */
interface OpenAIEmbeddingResponse {
  /** Array of embedding objects, one per input. */
  data: OpenAIEmbeddingData[];
  /** Model identifier echoed back by the API. */
  model: string;
  /**
   * Token usage summary. OpenAI always sends it; an OpenAI-compatible server
   * may omit it.
   */
  usage?: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

/**
 * Shape of the response from the Ollama `/api/embed` endpoint.
 * @internal
 */
interface OllamaEmbedResponse {
  /** Model name echoed back by Ollama. */
  model: string;
  /** Array of embedding vectors, one per input. */
  embeddings: number[][];
}

// ---------------------------------------------------------------------------
// Provider dispatch helpers
// ---------------------------------------------------------------------------

/**
 * Calls an OpenAI-compatible `/embeddings` endpoint: OpenAI's, OpenRouter's,
 * Mistral's, Requesty's, or the one at a base URL the caller set.
 *
 * @param baseUrl - The API base URL (e.g. `https://api.openai.com/v1`): the
 *   caller's, or the provider's own from {@link EMBEDDINGS_BASE_URLS}.
 * @param apiKey - Bearer token for the Authorization header.
 * @param modelId - The embedding model identifier.
 * @param input - Array of strings to embed.
 * @param dimensions - Optional dimensionality reduction hint.
 * @param abortSignal - The caller's signal, which cancels the request in flight.
 * @param onAttempt - The caller's report, told of the request once it is sent: attempt 1, with the HTTP status it
 *   answered, or null when no answer came (a network failure, or the caller's abort once the request had begun).
 * @returns Parsed {@link OpenAIEmbeddingResponse}.
 * @throws {Error} On non-2xx HTTP status or network failure, with base URL
 *   credentials and the API key masked out of the message; the signal's
 *   reason once it has aborted.
 */
async function callOpenAIEmbedding(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  input: string[],
  dimensions?: number,
  abortSignal?: AbortSignal,
  onAttempt?: (outcome: AttemptOutcome) => void,
): Promise<OpenAIEmbeddingResponse> {
  // Construct the request body, omitting `dimensions` when not specified
  // to avoid confusing models that don't support it.
  const body: Record<string, unknown> = { model: modelId, input };
  if (dimensions !== undefined) {
    body.dimensions = dimensions;
  }

  const url = `${baseUrl.replace(/\/+$/, '')}/embeddings`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      ...(abortSignal ? { signal: abortSignal } : {}),
    });
  } catch (error) {
    // The request got no answer, so it is reported as sent with no status.
    reportAttempt(onAttempt, null, false);
    // An abort is the caller's own: its reason, not a masked network error.
    if (abortSignal?.aborted) throw abortSignal.reason;
    throw embeddingFetchError(error, 'Embedding', baseUrl, [apiKey]);
  }
  reportAttempt(onAttempt, response.status, response.ok);

  if (!response.ok) {
    const text = await response.text().catch(() => '(no body)');
    // A server can echo the key or the URL it was called with.
    throw new Error(`Embedding request failed (${response.status}): ${redactUrlSecrets(text, baseUrl, [apiKey])}`);
  }

  return response.json() as Promise<OpenAIEmbeddingResponse>;
}

/**
 * Tells the caller's `onAttempt` of one embedding request it sent. A batch is sent once, so its request is attempt
 * 1; a callback that throws never ends the call.
 *
 * @param onAttempt - The caller's report, when given.
 * @param status - The HTTP status the request answered, or null when no answer came.
 * @param ok - Whether it answered with a success.
 */
function reportAttempt(
  onAttempt: ((outcome: AttemptOutcome) => void) | undefined,
  status: number | null,
  ok: boolean,
): void {
  try {
    onAttempt?.({ attempt: 1, status, ok });
  } catch {
    // a caller's callback never ends the call
  }
}

/**
 * The error raised when fetch rejects an embedding request. fetch quotes the
 * request URL when it rejects it (a base URL with `user:password@`, or one it
 * cannot parse) and quotes a header value it rejects, which carries the API
 * key, so the message is masked. The cause is dropped, since a parse
 * failure's cause holds the raw URL; a network error code such as
 * ECONNREFUSED is kept in the message.
 *
 * @param error What fetch rejected with.
 * @param label Names the request in the message.
 * @param baseUrl The base URL the request was built from.
 * @param secrets Other secrets the request carried, such as the API key.
 * @returns An error safe to pass to callers, logs and spans.
 */
function embeddingFetchError(
  error: unknown,
  label: string,
  baseUrl: string,
  secrets: ReadonlyArray<string> = [],
): Error {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { cause?: { code?: unknown } } | null | undefined)?.cause?.code;
  const suffix = typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code) ? ` (${code})` : '';
  return new Error(`${label} request failed: ${redactUrlSecrets(message, baseUrl, secrets)}${suffix}`);
}

/**
 * Calls the Ollama `/api/embed` endpoint.
 *
 * Ollama uses a different request shape than OpenAI: input is passed as a
 * top-level `input` field (string or string[]), and the response has
 * `embeddings` at the top level.
 *
 * @param baseUrl - The Ollama API base URL (e.g. `http://localhost:11434`).
 * @param modelId - The Ollama model name (e.g. `nomic-embed-text`).
 * @param input - Array of strings to embed.
 * @param abortSignal - The caller's signal, which cancels the request in flight.
 * @returns Parsed {@link OllamaEmbedResponse}.
 * @throws {Error} On non-2xx HTTP status or network failure, with base URL
 *   credentials masked out of the message; the signal's reason once it has
 *   aborted.
 */
async function callOllamaEmbed(
  baseUrl: string,
  modelId: string,
  input: string[],
  abortSignal?: AbortSignal,
): Promise<OllamaEmbedResponse> {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/embed`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId, input }),
      ...(abortSignal ? { signal: abortSignal } : {}),
    });
  } catch (error) {
    // An abort is the caller's own: its reason, not a masked network error.
    if (abortSignal?.aborted) throw abortSignal.reason;
    throw embeddingFetchError(error, 'Ollama embed', baseUrl);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '(no body)');
    throw new Error(`Ollama embed request failed (${response.status}): ${redactUrlSecrets(text, baseUrl)}`);
  }

  return response.json() as Promise<OllamaEmbedResponse>;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * The providers whose own documentation names an OpenAI-compatible embeddings
 * endpoint (`POST <base URL>/embeddings`, `model` and `input` in,
 * `data[].embedding` out), each with that base URL as its provider
 * implementation records it. A request for one of them goes there, or to the
 * base URL the caller set (the call's `baseUrl`, the global default's, or the
 * provider's base-URL variable), and never to another provider's host. Read on
 * 2026-10-25:
 *
 * - OpenAI, `POST https://api.openai.com/v1/embeddings`:
 *   https://developers.openai.com/api/reference/resources/embeddings/methods/create
 * - OpenRouter, `POST https://openrouter.ai/api/v1/embeddings`:
 *   https://openrouter.ai/docs/api/api-reference/embeddings/submit-an-embedding-request
 * - Mistral, `POST https://api.mistral.ai/v1/embeddings`:
 *   https://docs.mistral.ai/api/endpoint/embeddings
 * - Requesty, `POST https://router.requesty.ai/v1/embeddings`:
 *   https://docs.requesty.ai/api-reference/endpoint/embeddings-create
 */
const EMBEDDINGS_BASE_URLS: ReadonlyMap<string, string> = new Map([
  ['openai', OPENAI_DEFAULT_BASE_URL],
  ['openrouter', OPENROUTER_DEFAULT_BASE_URL],
  ['mistral', MISTRAL_DEFAULT_BASE_URL],
  ['requesty', REQUESTY_DEFAULT_BASE_URL],
]);

/**
 * Why embedText refuses a provider agentos knows that has no embeddings it
 * can send to, as the provider's own documentation says (read 2026-10-25):
 *
 * - Anthropic: "Anthropic does not offer its own embedding model."
 *   https://platform.claude.com/docs/en/build-with-claude/embeddings
 * - Groq: its API reference lists no embeddings endpoint.
 *   https://console.groq.com/docs/api-reference
 * - Together AI: "There are currently no embedding models offered via
 *   serverless." https://docs.together.ai/docs/serverless-models
 * - xAI: its REST API reference lists no embeddings endpoint.
 *   https://docs.x.ai/llms.txt
 * - MiniMax: its API reference names no embedding model.
 *   https://platform.minimax.io/docs/api-reference
 *
 * Third-party listings name an xAI `POST /v1/embeddings` and a MiniMax
 * `embo-01` endpoint with its own request shape; neither provider's reference
 * lists them (UNVERIFIED), so neither is sent to.
 *
 * Every other provider agentos knows that is not in
 * {@link EMBEDDINGS_BASE_URLS} and is not Gemini or Ollama (an image
 * provider, a CLI) is refused as well.
 */
const NO_EMBEDDINGS_REASONS: ReadonlyMap<string, string> = new Map([
  ['anthropic', 'Anthropic publishes no embedding model'],
  ['groq', 'Groq publishes no embeddings endpoint'],
  ['together', 'Together AI serves no embedding model'],
  ['xai', 'xAI publishes no embeddings endpoint'],
  ['minimax', 'MiniMax publishes no embedding model'],
]);

/**
 * The providers embedText embeds with, for its refusals to name: Gemini,
 * Ollama and those in {@link EMBEDDINGS_BASE_URLS}.
 */
function embeddingProviderList(): string {
  const ids = ['gemini', 'ollama', ...EMBEDDINGS_BASE_URLS.keys()].sort();
  return `${ids.slice(0, -1).join(', ')} or ${ids[ids.length - 1]}`;
}

/**
 * Refuses a provider agentos knows (a key of {@link PROVIDER_DEFAULTS}) that
 * has no embeddings embedText can send to. It runs before the provider's key
 * is read or any request is built: the OpenAI-compatible branch would post the
 * key to a host that is not its provider's (OpenAI's endpoint when no base URL
 * is set), or post a request to an endpoint that cannot answer it. A provider
 * agentos does not know is left to the base URL the caller sets.
 *
 * @param providerId The provider the call resolved to.
 * @throws {Error} Saying why the provider has no embeddings, and naming the
 *   providers that have them.
 */
function refuseProviderWithoutEmbeddings(providerId: string): void {
  if (providerId === 'gemini' || providerId === 'ollama' || EMBEDDINGS_BASE_URLS.has(providerId)) return;
  if (!Object.prototype.hasOwnProperty.call(PROVIDER_DEFAULTS, providerId)) return;
  const reason = NO_EMBEDDINGS_REASONS.get(providerId) ?? `agentos knows no embeddings endpoint for provider "${providerId}"`;
  throw new Error(`${reason}; embed with ${embeddingProviderList()}.`);
}

/**
 * Whether a `gemini` embedding call should use Gemini's native
 * batchEmbedContents protocol: with no base URL (GeminiProvider's default
 * endpoint) or with Google's own native endpoint. Any other base URL, such as
 * an OpenAI-compatible gateway or Google's OpenAI-compatible surface (a path
 * ending in `/openai`), keeps the OpenAI-style `/embeddings` route with bearer
 * auth that those endpoints serve.
 *
 * @param baseUrl Resolved base URL, if any.
 * @returns True when the native Gemini protocol applies.
 */
function usesNativeGeminiEmbeddings(baseUrl: string | undefined): boolean {
  if (baseUrl === undefined) return true;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  return url.hostname === 'generativelanguage.googleapis.com' && !/\/openai\/*$/.test(url.pathname);
}

/**
 * Applies {@link GEMINI_DEFAULT_EMBEDDING_MODEL} when the effective provider is
 * Gemini and no embedding model is named: `provider: 'gemini'` inline without a
 * model, or a global default provider of `gemini` (set with
 * `setDefaultProvider`). A global default's model is kept only when it is an
 * embedding model. It is normally the chat model `generateText` uses, and
 * Gemini's embedding endpoint rejects a chat model. The global default applies
 * only when neither provider nor model is inline, as in `resolveModelOption`.
 *
 * @param opts Caller options.
 * @returns Options with the Gemini embedding model filled in where needed.
 */
function withGeminiEmbeddingDefault(opts: EmbedTextOptions): EmbedTextOptions {
  if (opts.model) return opts;
  if (opts.provider) {
    return opts.provider === 'gemini' ? { ...opts, model: GEMINI_DEFAULT_EMBEDDING_MODEL } : opts;
  }
  const globalDefault = getDefaultProvider();
  if (globalDefault?.provider !== 'gemini') return opts;
  const globalModel = globalDefault.model;
  return {
    ...opts,
    provider: 'gemini',
    model: globalModel && /embedding/i.test(globalModel) ? globalModel : GEMINI_DEFAULT_EMBEDDING_MODEL,
  };
}

/**
 * Generates embedding vectors for one or more text inputs using a
 * provider-agnostic `provider:model` string.
 *
 * Resolves credentials via the standard AgentOS provider pipeline, then
 * dispatches to the provider's own embedding endpoint (OpenAI, OpenRouter,
 * Mistral, Requesty, Ollama or Gemini) or to the base URL the caller set; a
 * provider's key goes to no other host. Returns raw float arrays suitable for
 * vector similarity search, clustering, or any downstream ML pipeline.
 *
 * @param opts - Embedding options including model, input text(s), and
 *   optional provider/key overrides.
 * @returns A promise resolving to the embedding vectors, provider metadata,
 *   and token usage.
 *
 * @throws {Error} When provider resolution fails (missing API key, unknown
 *   provider, etc.).
 * @throws {Error} When the call resolves to a provider with no embeddings
 *   embedText can send to (Anthropic, Groq, Together AI, xAI, MiniMax, the
 *   image providers and the CLIs), whatever its base URL; its key is not read
 *   and no request is sent.
 * @throws {Error} When the call resolves to a provider agentos does not know
 *   and no base URL is set, on the call or on the global default; no request
 *   is sent.
 * @throws {Error} When the embedding API returns a non-2xx status.
 *
 * @example
 * ```ts
 * import { embedText } from '@framers/agentos';
 *
 * // Single input
 * const { embeddings } = await embedText({
 *   provider: 'openai',
 *   model: 'text-embedding-3-small',
 *   input: 'Hello world',
 * });
 * console.log(embeddings[0].length); // 1536
 *
 * // Batch with reduced dimensions
 * const batch = await embedText({
 *   provider: 'openai',
 *   model: 'text-embedding-3-small',
 *   input: ['Hello', 'World'],
 *   dimensions: 256,
 * });
 * console.log(batch.embeddings.length); // 2
 * console.log(batch.embeddings[0].length); // 256
 * ```
 *
 * @see {@link generateText} for text generation.
 * @see {@link resolveModelOption} for provider auto-detection behaviour.
 */
export async function embedText(opts: EmbedTextOptions): Promise<EmbedTextResult> {
  // A call whose signal has already aborted is refused before anything is sent.
  opts.abortSignal?.throwIfAborted();
  // So is an attempt count the completion calls would refuse, whichever provider serves the call.
  if (opts.maxAttempts !== undefined && (!Number.isInteger(opts.maxAttempts) || opts.maxAttempts < 1)) {
    throw new RangeError('maxAttempts is a whole number, 1 or more');
  }
  const startedAt = Date.now();
  let metricStatus: 'ok' | 'error' = 'ok';
  let metricProviderId: string | undefined;
  let metricModelId: string | undefined;
  let metricUsage: { promptTokens: number; totalTokens: number; costUSD?: number } | undefined;
  const budget = asSpendBudget(opts.budget);

  try {
    return await withAgentOSSpan(
      'agentos.api.embed_text',
      async (span) => {
        // Resolve provider/model using the 'embedding' task type so the
        // correct default model is selected (e.g. text-embedding-3-small).
        const { providerId, modelId } = resolveModelOption(withGeminiEmbeddingDefault(opts), 'embedding');
        // A provider with no embeddings is refused before its key is read.
        refuseProviderWithoutEmbeddings(providerId);
        const resolved = resolveProvider(providerId, modelId, {
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });

        metricProviderId = resolved.providerId;
        metricModelId = resolved.modelId;

        span?.setAttribute('llm.provider', resolved.providerId);
        span?.setAttribute('llm.model', resolved.modelId);

        // Normalise input to an array for uniform handling downstream
        const inputArray = Array.isArray(opts.input) ? opts.input : [opts.input];
        span?.setAttribute('agentos.api.embed_input_count', inputArray.length);
        // Checked once for the whole request, whichever branch below sends it:
        // its input's assumed tokens at the model's input rate.
        if (budget) assertCallWithinBudget(budget, resolved, inputArray.join('').length, 0, 'embed_text');

        let embeddings: number[][];
        let reportedModel: string;
        let usage: { promptTokens: number; totalTokens: number; costUSD?: number };

        if (resolved.providerId === 'ollama') {
          // Ollama uses its own /api/embed endpoint format
          const baseUrl = resolved.baseUrl ?? 'http://localhost:11434';
          const result = await callOllamaEmbed(baseUrl, resolved.modelId, inputArray, opts.abortSignal);

          embeddings = result.embeddings;
          reportedModel = result.model;
          // Ollama doesn't report token usage for embeddings
          usage = { promptTokens: 0, totalTokens: 0 };
        } else if (resolved.providerId === 'gemini' && usesNativeGeminiEmbeddings(resolved.baseUrl)) {
          // Gemini's native API serves embeddings through batchEmbedContents,
          // which GeminiProvider implements (including the API's limit of 100
          // texts per call). A gateway or Google's OpenAI-compatible base URL
          // takes the OpenAI-compatible branch below instead.
          if (!resolved.apiKey) {
            throw new Error('No API key available for embedding provider "gemini".');
          }
          const gemini = new GeminiProvider();
          await gemini.initialize({
            apiKey: resolved.apiKey,
            ...(resolved.baseUrl ? { baseURL: resolved.baseUrl } : {}),
          });
          const result = await gemini
            .generateEmbeddings(resolved.modelId, inputArray, {
              ...(opts.dimensions ? { dimensions: opts.dimensions } : {}),
              ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
            })
            .catch((error: unknown) => {
              // A batch that fails after earlier ones succeeded still leaves
              // those billed; record their usage before the error propagates.
              const partial = error instanceof GeminiProviderError ? error.partialUsage : undefined;
              if (partial) {
                metricUsage = {
                  promptTokens: partial.prompt_tokens,
                  totalTokens: partial.total_tokens,
                  ...(partial.costUSD !== undefined ? { costUSD: partial.costUSD } : {}),
                };
                budget?.record(partial.costUSD, partial.total_tokens, 'embed_text');
              }
              throw error;
            });
          embeddings = [...result.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
          reportedModel = result.model;
          // gemini-embedding-2 reports prompt tokens, which GeminiProvider
          // prices; gemini-embedding-001 reports none, so its calls count zero.
          usage = {
            promptTokens: result.usage.prompt_tokens,
            totalTokens: result.usage.total_tokens,
            ...(result.usage.costUSD !== undefined ? { costUSD: result.usage.costUSD } : {}),
          };
        } else {
          // The base URL the caller set (the call's, the global default's or
          // the provider's base-URL variable), else the provider's own
          // documented embeddings endpoint. A provider agentos does not know
          // has none, so its key goes only to a base URL the caller set.
          const baseUrl = resolved.baseUrl ?? EMBEDDINGS_BASE_URLS.get(resolved.providerId);
          if (baseUrl === undefined) {
            throw new Error(
              `No embeddings endpoint is known for provider "${resolved.providerId}"; pass baseUrl, the ` +
                `OpenAI-compatible endpoint its key is for, or embed with ${embeddingProviderList()}.`,
            );
          }

          if (!resolved.apiKey) {
            throw new Error(`No API key available for embedding provider "${resolved.providerId}".`);
          }

          const maxInputs = opts.maxInputsPerRequest ?? 2048;
          if (!Number.isInteger(maxInputs) || maxInputs < 1 || maxInputs > 2048) {
            throw new RangeError('maxInputsPerRequest must be an integer from 1 to 2048.');
          }
          const encoder = new TextEncoder();
          embeddings = [];
          reportedModel = resolved.modelId;
          usage = { promptTokens: 0, totalTokens: 0 };
          metricUsage = usage;
          // Reject the whole input list before any batch can incur charges.
          const inputSizes = inputArray.map((input, index) => {
            const bytes = encoder.encode(input).byteLength;
            if (bytes > 300_000) {
              throw new RangeError(`Embedding input at index ${index} is ${bytes} UTF-8 bytes and exceeds the 300,000 UTF-8 byte request bound.`);
            }
            return bytes;
          });
          let offset = 0;
          try {
            // Preserve the provider's handling of an empty input array.
            do {
              opts.abortSignal?.throwIfAborted();
              const batch: string[] = [];
              let bytes = 0;
              while (offset < inputArray.length && batch.length < maxInputs) {
                const input = inputArray[offset];
                const inputBytes = inputSizes[offset];
                if (bytes + inputBytes > 300_000) break;
                batch.push(input);
                bytes += inputBytes;
                offset++;
              }
              const result = await callOpenAIEmbedding(
                baseUrl,
                resolved.apiKey,
                resolved.modelId,
                batch,
                opts.dimensions,
                opts.abortSignal,
                opts.onAttempt,
              );

              // Each response's indices start at zero for its own batch.
              const sorted = [...result.data].sort((a, b) => a.index - b.index);
              for (const item of sorted) embeddings.push(item.embedding);
              reportedModel = result.model;
              // Compatible endpoints may omit usage after returning vectors.
              usage.promptTokens += result.usage?.prompt_tokens ?? 0;
              usage.totalTokens += result.usage?.total_tokens ?? 0;
              if (resolved.providerId === 'openai') {
                const costUSD = costOfUsageUSD(resolved.providerId, resolved.modelId, { promptTokens: usage.promptTokens }, true);
                if (costUSD !== undefined) usage.costUSD = costUSD;
              }
              metricUsage = usage;
              opts.abortSignal?.throwIfAborted();
            } while (offset < inputArray.length);
          } catch (error) {
            // Earlier successful batches remain billed if a later one fails.
            // The finally block persists their usage; record their budget too.
            if (metricUsage) budget?.record(usage.costUSD, usage.totalTokens, 'embed_text');
            throw error;
          }
        }

        metricUsage = usage;
        budget?.record(usage.costUSD, usage.totalTokens, 'embed_text');
        span?.setAttribute('agentos.api.embed_dimensions', embeddings[0]?.length ?? 0);
        attachUsageAttributes(span, {
          promptTokens: usage.promptTokens,
          totalTokens: usage.totalTokens,
          ...(usage.costUSD !== undefined ? { costUSD: usage.costUSD } : {}),
        });
        // GenAI semconv for the embeddings operation (queue item:
        // modality-aware operation names — embeddings input carries no
        // cache split, so the inclusive total is the prompt count as-is).
        attachGenAiAttributes(span, {
          providerName: resolved.providerId,
          operationName: 'embeddings',
          requestModel: resolved.modelId,
          ...(typeof reportedModel === 'string' && reportedModel
            ? { responseModel: reportedModel }
            : {}),
          usage: {
            promptTokens: usage.promptTokens,
            inclusiveInputTokens: usage.promptTokens,
          },
        });

        return {
          embeddings,
          model: reportedModel,
          provider: resolved.providerId,
          usage,
        };
      },
    );
  } catch (error) {
    metricStatus = 'error';
    // The caller's signal ended the call: it rejects with the signal's reason,
    // whatever the request failed with (a body read the abort cut off, a
    // provider's own abort error).
    if (opts.abortSignal?.aborted) throw opts.abortSignal.reason;
    throw error;
  } finally {
    // Best-effort usage persistence and metrics recording
    try {
      await recordAgentOSUsage({
        providerId: metricProviderId,
        modelId: metricModelId,
        usage: metricUsage ? {
          promptTokens: metricUsage.promptTokens,
          completionTokens: 0,
          totalTokens: metricUsage.totalTokens,
          ...(metricUsage.costUSD !== undefined ? { costUSD: metricUsage.costUSD } : {}),
        } : undefined,
        options: {
          ...opts.usageLedger,
          source: opts.usageLedger?.source ?? 'embedText',
        },
      });
    } catch {
      // Helper-level usage persistence is best-effort and should not break embedding.
    }
    recordAgentOSTurnMetrics({
      durationMs: Date.now() - startedAt,
      status: metricStatus,
      usage: toTurnMetricUsage(metricUsage ? {
        promptTokens: metricUsage.promptTokens,
        completionTokens: 0,
        totalTokens: metricUsage.totalTokens,
        ...(metricUsage.costUSD !== undefined ? { costUSD: metricUsage.costUSD } : {}),
      } : undefined),
    });
  }
}
