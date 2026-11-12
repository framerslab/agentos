/**
 * @fileoverview Cohere Rerank API provider implementation.
 * Uses Cohere's cloud-based cross-encoder reranking service.
 *
 * @module backend/agentos/rag/reranking/providers/CohereReranker
 * @see https://docs.cohere.com/reference/rerank
 */

import type {
  IRerankerProvider,
  RerankerInput,
  RerankerOutput,
  RerankerRequestConfig,
  RerankerProviderConfig,
} from '../IRerankerService';

/**
 * Cohere-specific provider configuration.
 */
export interface CohereRerankerConfig extends RerankerProviderConfig {
  providerId: 'cohere';
  /** Cohere API key (required) */
  apiKey: string;
  /** Base URL for Cohere API. Default: 'https://api.cohere.ai' */
  baseUrl?: string;
}

/**
 * Cohere Rerank API response shape.
 */
interface CohereRerankResponse {
  id: string;
  results: Array<{
    index: number;
    relevance_score: number;
  }>;
  meta?: {
    api_version?: { version: string };
    billed_units?: { search_units?: number };
  };
}

/**
 * Available Cohere reranker models.
 */
export const COHERE_RERANKER_MODELS = [
  // Latest models (recommended by Cohere docs)
  'rerank-v4.0-pro',
  'rerank-v4.0-fast',
  'rerank-v3.5',
  'rerank-english-v3.0',
  'rerank-multilingual-v3.0',
  'rerank-english-v2.0',
  'rerank-multilingual-v2.0',
] as const;

export type CohereRerankerModel = (typeof COHERE_RERANKER_MODELS)[number];

/**
 * Cohere Rerank API provider.
 *
 * Cloud-based cross-encoder reranking using Cohere's Rerank models. Each `rerank()` is one
 * POST to `${baseUrl}/v1/rerank` carrying the query and the full text of every document;
 * the request's `params` are merged into its body. Cohere bills it; the diagnostics carry
 * the billed search units the response reports (`tokensUsed`).
 *
 * @example
 * ```typescript
 * const reranker = new CohereReranker({
 *   providerId: 'cohere',
 *   apiKey: process.env.COHERE_API_KEY!,
 *   defaultModelId: 'rerank-v3.5'
 * });
 *
 * const result = await reranker.rerank(
 *   { query: 'machine learning', documents: [...] },
 *   { providerId: 'cohere', modelId: 'rerank-v3.5', topN: 5 }
 * );
 * ```
 */
export class CohereReranker implements IRerankerProvider {
  public readonly providerId = 'cohere' as const;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModelId: string;
  private readonly defaultTimeoutMs: number;

  constructor(config: CohereRerankerConfig) {
    // Allow empty apiKey for graceful isAvailable() checks
    this.apiKey = config.apiKey || '';
    this.baseUrl = config.baseUrl ?? 'https://api.cohere.ai';
    this.defaultModelId = config.defaultModelId ?? 'rerank-v3.5';
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 30000;
  }

  /**
   * Check if the Cohere API is accessible.
   */
  public async isAvailable(): Promise<boolean> {
    try {
      // Simple check - verify API key format
      return this.apiKey.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Get supported Cohere reranker models.
   */
  public getSupportedModels(): string[] {
    return [...COHERE_RERANKER_MODELS];
  }

  /**
   * Rerank documents using Cohere's Rerank API.
   *
   * The request's `timeoutMs` (else the provider's `defaultTimeoutMs`) bounds the whole call, the response's body
   * included, and the request's `signal` ends it at its abort. Either one aborts the request, which closes its
   * connection, and the timer is cleared once the call settles.
   *
   * @throws `CohereReranker: Request timed out after <ms>ms` when the response and its body are not read within
   * the timeout; the signal's reason when the signal aborts, before the request is sent or while it runs;
   * `Cohere API error (<status>): <body>` for a status that is not 2xx.
   */
  public async rerank(
    input: RerankerInput,
    config: RerankerRequestConfig,
  ): Promise<RerankerOutput> {
    if (!this.apiKey) {
      throw new Error('CohereReranker: apiKey is required for reranking');
    }

    const callerSignal = config.signal;
    if (callerSignal?.aborted) {
      // Nothing is sent for a call its caller has already stopped.
      throw callerSignal.reason;
    }

    const modelId = config.modelId || this.defaultModelId;
    const timeoutMs = config.timeoutMs ?? this.defaultTimeoutMs;
    const startTime = Date.now();

    // Prepare request body
    const requestBody = {
      model: modelId,
      query: input.query,
      documents: input.documents.map((d) => d.content),
      top_n: config.topN ?? input.documents.length,
      return_documents: false,
      ...(config.params as Record<string, unknown>),
    };

    // One controller ends the request and its body read: the timer aborts it with the timeout's error, the
    // caller's signal with its own reason. Both stay armed until the body is read.
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(new Error(`CohereReranker: Request timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    const onCallerAbort = (): void => controller.abort(callerSignal?.reason);
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

    try {
      // A signal fires its abort event once: one that aborted while the body was built, before the listener
      // above, ends the call here, and nothing is sent.
      if (callerSignal?.aborted) {
        throw callerSignal.reason;
      }

      const response = await untilAborted(
        fetch(`${this.baseUrl}/v1/rerank`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            'X-Client-Name': 'agentos',
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        }),
        controller.signal,
      );

      if (!response.ok) {
        const errorText = await untilAborted(response.text(), controller.signal);
        throw new Error(`Cohere API error (${response.status}): ${errorText}`);
      }

      const data = await untilAborted(response.json() as Promise<CohereRerankResponse>, controller.signal);
      const latencyMs = Date.now() - startTime;

      // Map results back to documents (Cohere returns indices)
      const results = data.results.map((r) => {
        const doc = input.documents[r.index];
        return {
          id: doc.id,
          content: doc.content,
          relevanceScore: r.relevance_score,
          originalScore: doc.originalScore,
          metadata: doc.metadata,
        };
      });

      return {
        results,
        diagnostics: {
          modelId,
          providerId: this.providerId,
          latencyMs,
          documentsProcessed: input.documents.length,
          tokensUsed: data.meta?.billed_units?.search_units,
          providerMetrics: {
            cohereRequestId: data.id,
            apiVersion: data.meta?.api_version?.version,
          },
        },
      };
    } catch (error) {
      // Once the controller has aborted, the call ends with its reason (the timeout's error or the caller's),
      // whatever the request or the body read rejected with.
      if (controller.signal.aborted) {
        throw controller.signal.reason;
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    }
  }
}

/**
 * Settles as `work` does, or rejects with the signal's reason once the signal aborts, whichever comes first.
 * `fetch` and its body reads end on the same signal; this also holds the deadline for a `fetch` that does not
 * honour it. A rejection of `work` after the abort is handled here, so it never surfaces as unhandled.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    Promise.resolve(work).then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
