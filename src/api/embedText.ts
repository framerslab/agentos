/**
 * @file embedText.ts
 * Provider-agnostic text embedding generation for the AgentOS high-level API.
 *
 * Dispatches embedding requests to OpenAI-compatible, Ollama, or OpenRouter
 * endpoints using the same provider resolution pipeline as {@link generateText}.
 * Supports single and batch text inputs, optional dimensionality reduction,
 * and returns raw float vectors.
 *
 * @see {@link generateText} for the text generation primitive.
 * @see {@link resolveModelOption} for model resolution with `TaskType = 'embedding'`.
 */
import { resolveModelOption, resolveProvider } from './model.js';
import { attachGenAiAttributes, attachUsageAttributes, toTurnMetricUsage } from './observability.js';
import { recordAgentOSUsage, type AgentOSUsageLedgerOptions } from './runtime/usageLedger.js';
import { recordAgentOSTurnMetrics, withAgentOSSpan } from '../safety/evaluation/observability/otel.js';

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
   * @example `"openai"`, `"ollama"`, `"openrouter"`
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

  /** Override the API key instead of reading from environment variables. */
  apiKey?: string;

  /** Override the provider base URL (useful for local proxies or Ollama). */
  baseUrl?: string;

  /** Optional durable usage ledger configuration for helper-level accounting. */
  usageLedger?: AgentOSUsageLedgerOptions;
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
 * (also used by OpenRouter and compatible proxies).
 * @internal
 */
interface OpenAIEmbeddingResponse {
  /** Array of embedding objects, one per input. */
  data: OpenAIEmbeddingData[];
  /** Model identifier echoed back by the API. */
  model: string;
  /** Token usage summary. */
  usage: {
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
 * Calls the OpenAI-compatible `/v1/embeddings` endpoint.
 *
 * Works for OpenAI native, OpenRouter, and any API that follows the
 * same request/response contract.
 *
 * @param baseUrl - The API base URL (e.g. `https://api.openai.com/v1`).
 * @param apiKey - Bearer token for the Authorization header.
 * @param modelId - The embedding model identifier.
 * @param input - Array of strings to embed.
 * @param dimensions - Optional dimensionality reduction hint.
 * @returns Parsed {@link OpenAIEmbeddingResponse}.
 * @throws {Error} On non-2xx HTTP status or network failure.
 */
async function callOpenAIEmbedding(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  input: string[],
  dimensions?: number,
): Promise<OpenAIEmbeddingResponse> {
  // Construct the request body, omitting `dimensions` when not specified
  // to avoid confusing models that don't support it.
  const body: Record<string, unknown> = { model: modelId, input };
  if (dimensions !== undefined) {
    body.dimensions = dimensions;
  }

  const url = `${baseUrl.replace(/\/+$/, '')}/embeddings`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '(no body)');
    throw new Error(`Embedding request failed (${response.status}): ${text}`);
  }

  return response.json() as Promise<OpenAIEmbeddingResponse>;
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
 * @returns Parsed {@link OllamaEmbedResponse}.
 * @throws {Error} On non-2xx HTTP status or network failure.
 */
async function callOllamaEmbed(
  baseUrl: string,
  modelId: string,
  input: string[],
): Promise<OllamaEmbedResponse> {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/embed`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelId, input }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '(no body)');
    throw new Error(`Ollama embed request failed (${response.status}): ${text}`);
  }

  return response.json() as Promise<OllamaEmbedResponse>;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Generates embedding vectors for one or more text inputs using a
 * provider-agnostic `provider:model` string.
 *
 * Resolves credentials via the standard AgentOS provider pipeline, then
 * dispatches to the appropriate embedding endpoint (OpenAI, Ollama, or
 * OpenRouter). Returns raw float arrays suitable for vector similarity
 * search, clustering, or any downstream ML pipeline.
 *
 * @param opts - Embedding options including model, input text(s), and
 *   optional provider/key overrides.
 * @returns A promise resolving to the embedding vectors, provider metadata,
 *   and token usage.
 *
 * @throws {Error} When provider resolution fails (missing API key, unknown
 *   provider, etc.).
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
  const startedAt = Date.now();
  let metricStatus: 'ok' | 'error' = 'ok';
  let metricProviderId: string | undefined;
  let metricModelId: string | undefined;
  let metricUsage: { promptTokens: number; totalTokens: number } | undefined;

  try {
    return await withAgentOSSpan(
      'agentos.api.embed_text',
      async (span) => {
        // Resolve provider/model using the 'embedding' task type so the
        // correct default model is selected (e.g. text-embedding-3-small).
        const { providerId, modelId } = resolveModelOption(opts, 'embedding');
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

        let embeddings: number[][];
        let reportedModel: string;
        let usage: { promptTokens: number; totalTokens: number };

        if (resolved.providerId === 'ollama') {
          // Ollama uses its own /api/embed endpoint format
          const baseUrl = resolved.baseUrl ?? 'http://localhost:11434';
          const result = await callOllamaEmbed(baseUrl, resolved.modelId, inputArray);

          embeddings = result.embeddings;
          reportedModel = result.model;
          // Ollama doesn't report token usage for embeddings
          usage = { promptTokens: 0, totalTokens: 0 };
        } else {
          // OpenAI, OpenRouter, and any OpenAI-compatible provider
          const baseUrl = resolved.baseUrl ?? (
            resolved.providerId === 'openrouter'
              ? 'https://openrouter.ai/api/v1'
              : 'https://api.openai.com/v1'
          );

          if (!resolved.apiKey) {
            throw new Error(`No API key available for embedding provider "${resolved.providerId}".`);
          }

          const result = await callOpenAIEmbedding(
            baseUrl,
            resolved.apiKey,
            resolved.modelId,
            inputArray,
            opts.dimensions,
          );

          // Sort by index to guarantee order matches input order
          // (the API contract already guarantees this, but defensive coding)
          const sorted = [...result.data].sort((a, b) => a.index - b.index);
          embeddings = sorted.map((d) => d.embedding);
          reportedModel = result.model;
          usage = {
            promptTokens: result.usage.prompt_tokens,
            totalTokens: result.usage.total_tokens,
          };
        }

        metricUsage = usage;
        span?.setAttribute('agentos.api.embed_dimensions', embeddings[0]?.length ?? 0);
        attachUsageAttributes(span, {
          promptTokens: usage.promptTokens,
          totalTokens: usage.totalTokens,
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
      } : undefined),
    });
  }
}
