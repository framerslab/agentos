/**
 * @fileoverview Defines the contracts for pluggable reranker providers in AgentOS.
 * A reranker re-scores retrieved documents against the query after the first retrieval.
 * The built-in providers are a local cross-encoder (`local`), Cohere's rerank API (`cohere`)
 * and an LLM judge (`llm-judge`); a host can register its own.
 *
 * @module backend/agentos/rag/reranking/IRerankerService
 */

import type { MetadataValue } from '../IVectorStore';

/**
 * A document to be reranked along with its original retrieval score.
 */
export interface RerankerDocument {
  /** Unique identifier for the document/chunk */
  id: string;
  /** Text content to evaluate for relevance */
  content: string;
  /** Original bi-encoder similarity score (preserved for comparison) */
  originalScore?: number;
  /** Document metadata */
  metadata?: Record<string, MetadataValue>;
}

/**
 * Input payload for reranking operations.
 */
export interface RerankerInput {
  /** The user query to rank documents against */
  query: string;
  /** Documents to rerank */
  documents: RerankerDocument[];
}

/**
 * A reranked document with its new cross-encoder relevance score.
 */
export interface RerankedDocument {
  /** Document identifier */
  id: string;
  /** Document content */
  content: string;
  /** New relevance score from cross-encoder (typically 0-1) */
  relevanceScore: number;
  /** Original bi-encoder score (for diagnostics/comparison) */
  originalScore?: number;
  /** Document metadata */
  metadata?: Record<string, MetadataValue>;
}

/**
 * Output from a reranking operation.
 */
export interface RerankerOutput {
  /** Reranked documents sorted by relevance (descending) */
  results: RerankedDocument[];
  /** Diagnostic information about the reranking operation */
  diagnostics?: RerankerDiagnostics;
}

/**
 * Diagnostic information from a reranking operation.
 */
export interface RerankerDiagnostics {
  /** Model used for reranking */
  modelId: string;
  /** Provider that performed the reranking */
  providerId: string;
  /** Time taken for the reranking operation in milliseconds */
  latencyMs: number;
  /** Number of documents processed */
  documentsProcessed: number;
  /** Tokens used (if applicable/available) */
  tokensUsed?: number;
  /** Any additional provider-specific metrics */
  providerMetrics?: Record<string, unknown>;
}

/**
 * Configuration for a reranking request.
 */
export interface RerankerRequestConfig {
  /** Provider to use for reranking */
  providerId: string;
  /** Model ID within the provider */
  modelId: string;
  /** Number of top results to return after reranking (defaults to all) */
  topN?: number;
  /** Maximum documents to send to reranker (limits cost). Default: 100 */
  maxDocuments?: number;
  /**
   * Request timeout in milliseconds. `RerankerService.rerank()` sends the call's, else the provider settings'
   * `defaultTimeoutMs`, else none, and the provider applies its own: 30000 for Cohere and the LLM judge.
   */
  timeoutMs?: number;
  /** Provider-specific parameters */
  params?: Record<string, unknown>;
}

/**
 * Configuration for initializing a reranker provider.
 */
export interface RerankerProviderConfig {
  /** Provider identifier */
  providerId: string;
  /** API key or authentication token */
  apiKey?: string;
  /** Base URL for the API (for self-hosted or custom endpoints) */
  baseUrl?: string;
  /** Default model to use if not specified per-request */
  defaultModelId?: string;
  /**
   * The model's pinned revision (a branch, a tag or a commit of its repository), for a provider that loads weights.
   * The local cross-encoder passes it to every load; unset, it loads the repository's `main`.
   */
  revision?: string;
  /** Default timeout in milliseconds */
  defaultTimeoutMs?: number;
  /** Provider-specific configuration options */
  providerOptions?: Record<string, unknown>;
}

/**
 * Contract for reranker provider implementations.
 *
 * A provider takes a query and a set of documents and answers them with
 * relevance scores, best first. How it scores is its own: a cross-encoder
 * model (`LocalCrossEncoderReranker`, `CohereReranker`), a language model
 * (`LlmJudgeReranker`) or anything a host writes.
 *
 * @example
 * ```typescript
 * class CohereReranker implements IRerankerProvider {
 *   readonly providerId = 'cohere';
 *
 *   async rerank(input: RerankerInput, config: RerankerRequestConfig): Promise<RerankerOutput> {
 *     // Call Cohere Rerank API
 *     const response = await this.callCohereAPI(input, config);
 *     return this.mapResponse(response, input.documents);
 *   }
 * }
 * ```
 */
export interface IRerankerProvider {
  /** Unique identifier for this provider */
  readonly providerId: string;

  /**
   * Rerank documents based on relevance to the query.
   *
   * @param input - Query and documents to rerank
   * @param config - Request configuration
   * @returns Reranked documents sorted by relevance
   */
  rerank(input: RerankerInput, config: RerankerRequestConfig): Promise<RerankerOutput>;

  /**
   * Check if this provider is available and properly configured.
   *
   * @returns True if the provider can accept reranking requests
   */
  isAvailable(): Promise<boolean>;

  /**
   * Get the list of supported model IDs for this provider.
   *
   * @returns Array of supported model identifiers
   */
  getSupportedModels?(): string[];
}

/**
 * Configuration for the RerankerService.
 */
export interface RerankerServiceConfig {
  /** Available provider configurations */
  providers: RerankerProviderConfig[];
  /** Default provider to use if not specified per-request */
  defaultProviderId?: string;
  /** Default model to use if not specified per-request */
  defaultModelId?: string;
  /** Enable debug logging */
  debug?: boolean;
}

/** A single stage in a reranker chain pipeline. */
export interface RerankChainStage {
  /** Provider ID (e.g., 'local', 'cohere', 'llm-judge'). */
  provider: string;
  /** Max results to keep after this stage. */
  topK: number;
  /**
   * The model this stage asks for. Unset, the stage takes the provider's `defaultModelId` from the service's
   * provider settings, else the service's `defaultModelId`, else the provider's own default.
   */
  model?: string;
}
