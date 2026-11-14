/**
 * @fileoverview Provider-agnostic reranker service. It holds the registered providers (the
 * local cross-encoder, Cohere's API, the LLM judge, or a host's own) and calls the one a request names.
 *
 * @module backend/agentos/rag/reranking/RerankerService
 */

import type { ILogger } from '../../../core/logging/ILogger';
import type { RagRetrievedChunk } from '../IRetrievalAugmentor';
import type {
  IRerankerProvider,
  RerankerInput,
  RerankerOutput,
  RerankerRequestConfig,
  RerankerServiceConfig,
  RerankChainStage,
  RerankerProviderConfig,
} from './IRerankerService';

/**
 * Configuration for the RerankerService constructor.
 */
export interface RerankerServiceOptions {
  /** Service configuration */
  config: RerankerServiceConfig;
  /** Optional logger instance */
  logger?: ILogger;
}

/**
 * Provider-agnostic reranker service.
 *
 * Calls the provider a request names (`providerId`), else `defaultProviderId`, through
 * one interface, whatever the provider runs: a local cross-encoder, a remote API or an
 * LLM judge. Handles provider selection, request routing, and result mapping back to
 * RAG chunk format.
 *
 * @example
 * ```typescript
 * const service = new RerankerService({
 *   config: {
 *     providers: [
 *       { providerId: 'local', defaultModelId: 'cross-encoder/ms-marco-MiniLM-L-6-v2' },
 *       { providerId: 'cohere', apiKey: process.env.COHERE_API_KEY },
 *       { providerId: 'llm-judge' }
 *     ],
 *     defaultProviderId: 'local'
 *   }
 * });
 *
 * // Register provider implementations: the config entries create none.
 * service.registerProvider(new LocalCrossEncoderReranker(...));
 * service.registerProvider(new CohereReranker(...));
 * service.registerProvider(new LlmJudgeReranker({ llmCallFn: myLlmCall }));
 *
 * // Rerank chunks with the default provider, or name one per request
 * const reranked = await service.rerankChunks(query, chunks);
 * const judged = await service.rerankChunks(query, chunks, { providerId: 'llm-judge', topN: 5 });
 * ```
 */
export class RerankerService {
  private readonly providers: Map<string, IRerankerProvider> = new Map();
  private readonly providerConfigs: Map<string, RerankerProviderConfig> = new Map();
  private readonly config: RerankerServiceConfig;
  private readonly logger?: ILogger;

  constructor(options: RerankerServiceOptions) {
    this.config = options.config;
    this.logger = options.logger;

    // Index provider configs
    for (const providerConfig of options.config.providers) {
      this.providerConfigs.set(providerConfig.providerId, providerConfig);
    }
  }

  /**
   * Register a reranker provider implementation.
   *
   * @param provider - Provider instance to register
   */
  public registerProvider(provider: IRerankerProvider): void {
    this.providers.set(provider.providerId, provider);
    this.logger?.debug?.(`RerankerService: Registered provider '${provider.providerId}'`);
  }

  /**
   * Get a registered provider by ID.
   *
   * @param providerId - Provider identifier
   * @returns Provider instance or undefined if not found
   */
  public getProvider(providerId: string): IRerankerProvider | undefined {
    return this.providers.get(providerId);
  }

  /**
   * Get configuration for a provider.
   *
   * @param providerId - Provider identifier
   * @returns Provider configuration or undefined if not found
   */
  public getProviderConfig(providerId: string): RerankerProviderConfig | undefined {
    return this.providerConfigs.get(providerId);
  }

  /**
   * List all registered provider IDs.
   *
   * @returns Array of provider identifiers
   */
  public listProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Check if a provider is available.
   *
   * @param providerId - Provider identifier
   * @returns True if provider is registered and available
   */
  public async isProviderAvailable(providerId: string): Promise<boolean> {
    const provider = this.providers.get(providerId);
    if (!provider) return false;
    return provider.isAvailable();
  }

  /**
   * Rerank documents using the specified or default provider.
   *
   * @param input - Query and documents to rerank
   * @param config - Request configuration (optional, uses defaults if not provided)
   * @returns Reranked documents with relevance scores
   * @throws Error if provider not found or reranking fails
   */
  public async rerank(
    input: RerankerInput,
    config?: Partial<RerankerRequestConfig>,
  ): Promise<RerankerOutput> {
    const providerId = config?.providerId ?? this.config.defaultProviderId;
    if (!providerId) {
      throw new Error('RerankerService: No provider specified and no default configured');
    }

    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`RerankerService: Provider '${providerId}' not found. Available: ${this.listProviders().join(', ')}`);
    }

    const providerConfig = this.providerConfigs.get(providerId);

    // Build full config with defaults
    const fullConfig: RerankerRequestConfig = {
      providerId,
      modelId: config?.modelId ?? providerConfig?.defaultModelId ?? this.config.defaultModelId ?? '',
      topN: config?.topN,
      maxDocuments: config?.maxDocuments ?? 100,
      // Unset when neither the call nor the provider's settings name one, so the provider's own default applies.
      timeoutMs: config?.timeoutMs ?? providerConfig?.defaultTimeoutMs,
      // The caller's abort reaches the provider; one that reads it (Cohere's) ends its request there.
      signal: config?.signal,
      params: config?.params,
    };

    // Apply maxDocuments limit
    let documents = input.documents;
    if (fullConfig.maxDocuments && documents.length > fullConfig.maxDocuments) {
      this.logger?.debug?.(
        `RerankerService: Truncating ${documents.length} documents to maxDocuments=${fullConfig.maxDocuments}`,
      );
      documents = documents.slice(0, fullConfig.maxDocuments);
    }

    const startTime = Date.now();
    this.logger?.debug?.(
      `RerankerService: Reranking ${documents.length} documents with provider '${providerId}', model '${fullConfig.modelId}'`,
    );

    try {
      const result = await provider.rerank({ query: input.query, documents }, fullConfig);

      // Apply topN if specified
      if (fullConfig.topN && result.results.length > fullConfig.topN) {
        result.results = result.results.slice(0, fullConfig.topN);
      }

      const latencyMs = Date.now() - startTime;
      this.logger?.debug?.(
        `RerankerService: Reranking complete. Returned ${result.results.length} results in ${latencyMs}ms`,
      );

      return result;
    } catch (error) {
      // A stop by the caller's own signal is not a provider failure; a timeout that fired first has another reason.
      if (fullConfig.signal?.aborted && error === fullConfig.signal.reason) {
        this.logger?.debug?.(`RerankerService: Reranking with provider '${providerId}' stopped by the caller's signal`);
      } else {
        this.logger?.error(`RerankerService: Reranking failed with provider '${providerId}'`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  /**
   * Rerank RAG chunks and return updated chunks with new relevance scores.
   *
   * This is the main method used by RetrievalAugmentor. It accepts RagRetrievedChunk[],
   * performs reranking, and returns the same type with updated scores.
   *
   * @param query - User query
   * @param chunks - Retrieved chunks to rerank
   * @param config - Request configuration
   * @returns Reranked chunks sorted by relevance
   * @throws The provider's error, after logging it to the service's logger when the service has one, as
   * `rerank()` does; also an error of its own, which it does not log: no provider named and no default, a
   * provider not registered, or a result id that is not among the chunks. A caller that wants its order on a
   * failure catches the error, records it and returns `chunks`; `rerankChain()` does this for each stage.
   */
  public async rerankChunks(
    query: string,
    chunks: RagRetrievedChunk[],
    config?: Partial<RerankerRequestConfig>,
  ): Promise<RagRetrievedChunk[]> {
    if (chunks.length === 0) {
      return [];
    }

    // Convert chunks to reranker input format
    const input: RerankerInput = {
      query,
      documents: chunks.map((chunk) => ({
        id: chunk.id,
        content: chunk.content,
        originalScore: chunk.relevanceScore,
        metadata: chunk.metadata,
      })),
    };

    const output = await this.rerank(input, config);

    // Create a map for O(1) chunk lookup
    const chunkMap = new Map(chunks.map((c) => [c.id, c]));

    // Map reranked results back to RagRetrievedChunk format
    return output.results.map((result) => {
      const originalChunk = chunkMap.get(result.id);
      if (!originalChunk) {
        throw new Error(`RerankerService: Reranker returned unknown document ID: ${result.id}`);
      }

      const providerId = config?.providerId ?? this.config.defaultProviderId;
      const metadata = { ...(originalChunk.metadata ?? {}) };
      if (typeof result.originalScore === 'number') {
        metadata._rerankerOriginalScore = result.originalScore;
      }
      if (providerId) {
        metadata._rerankerProviderId = providerId;
      }

      return {
        ...originalChunk,
        relevanceScore: result.relevanceScore,
        metadata,
      };
    });
  }

  /**
   * Run chunks through a multi-stage reranker pipeline.
   * Each stage's output feeds into the next, narrowing the result set.
   * A stage whose provider is not registered or not available is skipped. A stage whose provider throws
   * (a local model that fails to load included) is skipped with a warning to the logger, and the chunks keep
   * the order and scores they had; it never throws for a stage's failure.
   *
   * @param query - The search query.
   * @param chunks - Input chunks to rerank.
   * @param chain - Ordered array of reranking stages.
   * @returns Reranked chunks after all stages.
   */
  public async rerankChain(
    query: string,
    chunks: RagRetrievedChunk[],
    chain: RerankChainStage[],
  ): Promise<RagRetrievedChunk[]> {
    if (chunks.length === 0 || chain.length === 0) return chunks;

    let current = chunks;
    const stagesRun: string[] = [];

    for (const stage of chain) {
      const provider = this.providers.get(stage.provider);
      if (!provider) {
        this.logger?.debug?.(`rerankChain: Provider '${stage.provider}' not registered — skipping stage`);
        continue;
      }

      try {
        const available = await provider.isAvailable();
        if (!available) {
          this.logger?.debug?.(`rerankChain: Provider '${stage.provider}' not available — skipping stage`);
          continue;
        }

        // A stage without a model leaves modelId unset, so rerank() takes the provider's defaultModelId from the
        // settings, else the service's, else the provider's own.
        current = await this.rerankChunks(query, current, {
          providerId: stage.provider,
          modelId: stage.model,
          topN: stage.topK,
        });
        stagesRun.push(stage.provider);
      } catch (err) {
        this.logger?.warn?.(
          `rerankChain: Stage '${stage.provider}' failed — continuing with previous results: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return current.map((chunk) => ({
      ...chunk,
      metadata: {
        ...chunk.metadata,
        _rerankerChainStages: stagesRun.join(','),
      },
    }));
  }
}
