/**
 * @fileoverview Defines the contracts and shared types for the Retrieval Augmented Generation (RAG)
 * pipeline inside AgentOS.  The RetrievalAugmentor coordinates between embedding managers, vector
 * store managers, and higher level orchestration (GMI, personas) to ingest knowledge, retrieve
 * relevant context, and manage document lifecycles.
 *
 * @module backend/agentos/rag/IRetrievalAugmentor
 */

import { IEmbeddingManager } from './IEmbeddingManager';
import { MetadataFilter, MetadataValue } from './IVectorStore';
import { IVectorStoreManager } from './IVectorStoreManager';
import { RetrievalAugmentorServiceConfig } from '../../core/config/RetrievalAugmentorConfiguration';
import type { RAGAuditTrail } from './audit/RAGAuditTypes';
import type { RetrievalConfidenceSummary } from './unified/confidence.js';
import type { MemoryRetrievalPolicy, MemoryRetrievalProfile } from './unified/policy.js';

/**
 * Logical buckets that the RAG system can target.  These allow integrators to map different
 * document types or knowledge sources to distinct vector store data sources and policies.
 */
export enum RagMemoryCategory {
  PERSONAL_LLM_EXPERIENCE = 'personal_llm_experience',
  USER_EXPLICIT_MEMORY = 'user_explicit_memory',
  SHARED_KNOWLEDGE_BASE = 'shared_knowledge_base',
  EPISODIC_CONTEXT = 'episodic_context',
  GOAL_ORIENTED_MEMORY = 'goal_oriented_memory',
}

/**
 * Represents raw document content provided for ingestion.
 */
export interface RagDocumentInput {
  /** Stable identifier for the document (chunk IDs will derive from this). */
  id: string;
  /** Raw text that will be chunked and embedded. */
  content: string;
  /** Optional override for which data source / collection to push this document into. */
  dataSourceId?: string;
  /** Original source pointer (URL, file path, API, etc.). */
  source?: string;
  /** Arbitrary metadata stored alongside chunks; values must be vector-store friendly. */
  metadata?: Record<string, MetadataValue>;
  /** ISO language tag for the content. */
  language?: string;
  /** ISO timestamp describing when this content was produced/updated. */
  timestamp?: string;
  /** Optional pre-computed embedding vector. */
  embedding?: number[];
  /** Identifier of the embedding model used when `embedding` is supplied. */
  embeddingModelId?: string;
}

/**
 * Chunking options and ingestion-time overrides.
 */
export interface RagIngestionOptions {
  /**
   * Explicit target data source ID.  If omitted, the augmentor falls back to the document-specified
   * `dataSourceId`, category behavior defaults, or system defaults.
   */
  targetDataSourceId?: string;
  /**
   * Behavior when a document ID already exists.
   * - `overwrite`: replace the existing document/chunks (default).
   * - `skip`: ignore duplicate IDs.
   * - `error`: surface a validation error.
   */
  duplicateHandling?: 'overwrite' | 'skip' | 'error';
  /**
   * Chunking configuration.  `strategySpecificParams` allows pluggable implementations to carry
   * provider-specific hints without widening the base interface each time.
   */
  chunkingStrategy?: {
    type: 'none' | 'fixed_size' | 'recursive_character' | 'semantic';
    chunkSize?: number;
    chunkOverlap?: number;
    strategySpecificParams?: Record<string, any>;
  };
  /**
   * Embedding model identifier used when generating embeddings for this ingestion request.
   * When omitted the augmentor consults the service config / category defaults.
   */
  embeddingModelId?: string;
  /** Optional user identifier for auditing and personalization. */
  userId?: string;
  /** Optional persona identifier for personalization. */
  personaId?: string;
  /** Batch size for large ingestion jobs. */
  batchSize?: number;
  /** Whether to schedule ingestion asynchronously (future enhancement hook). */
  processAsync?: boolean;
}

/**
 * Structure describing a retrieved chunk.
 */
export interface RagRetrievedChunk {
  id: string;
  content: string;
  /** Original document ID for traceability. */
  originalDocumentId: string;
  /** Data source / collection identifier. */
  dataSourceId?: string;
  /** Optional human-friendly source description. */
  source?: string;
  /** Metadata that traveled with the chunk. */
  metadata?: Record<string, MetadataValue>;
  /** Similarity or relevance score returned by the vector store. */
  relevanceScore?: number;
  /** Embedding vector if `includeEmbeddings` was requested. */
  embedding?: number[];
}

/**
 * Result of an ingestion attempt.
 */
export interface RagIngestionResult {
  processedCount: number;
  failedCount: number;
  ingestedIds?: string[];
  errors?: Array<{ documentId?: string; chunkId?: string; message: string; details?: unknown }>;
  jobId?: string;
  effectiveDataSourceIds?: string[];
}

/**
 * Diagnostics emitted by retrieval operations.
 */
export interface RagRetrievalDiagnostics {
  embeddingTimeMs?: number;
  retrievalTimeMs?: number;
  rerankingTimeMs?: number;
  totalTokensInContext?: number;
  strategyUsed?: RagRetrievalOptions['strategy'];
  dataSourceHits?: Record<string, number>;
  effectiveDataSourceIds?: string[];
  messages?: string[];
  /**
   * HyDE-specific diagnostics, populated when HyDE retrieval is active.
   *
   * - `hypothesis`: The generated (or pre-supplied) hypothetical answer.
   * - `hypothesisLatencyMs`: Time spent generating the hypothesis via LLM.
   * - `effectiveThreshold`: Final similarity threshold after adaptive stepping.
   * - `thresholdSteps`: Number of times the threshold was lowered before results
   *   were found (0 means the initial threshold succeeded).
   */
  hyde?: {
    hypothesis: string;
    hypothesisLatencyMs: number;
    effectiveThreshold: number;
    thresholdSteps: number;
  };
  policy?: {
    profile: MemoryRetrievalProfile;
    confidence: RetrievalConfidenceSummary;
    escalations: string[];
  };
}

/**
 * Options controlling retrieval behavior.
 */
export interface RagRetrievalOptions {
  /** Maximum number of chunks per query. */
  topK?: number;
  /** Set of explicit data sources to query. */
  targetDataSourceIds?: string[];
  /** Memory categories to consult (maps to data sources via config). */
  targetMemoryCategories?: RagMemoryCategory[];
  /** Metadata filter applied at the vector-store layer. */
  metadataFilter?: MetadataFilter;
  /** Retrieval strategy (defaults to similarity search). */
  strategy?: 'similarity' | 'mmr' | 'hybrid';
  /** Strategy-specific parameters (MMR lambda, hybrid alpha, etc.). */
  strategyParams?: {
    mmrLambda?: number;
    hybridAlpha?: number;
    custom?: Record<string, any>;
  };
  /**
   * Cross-encoder reranking configuration.
   *
   * When enabled, retrieved chunks are re-scored using a cross-encoder model
   * for improved relevance ranking. **Disabled by default** due to added latency.
   *
   * Recommended use cases:
   * - Background analysis tasks (accuracy over speed)
   * - Batch processing (no user waiting)
   * - Knowledge-intensive tasks (reduces hallucination)
   *
   * NOT recommended for real-time chat (latency sensitive).
   */
  rerankerConfig?: {
    /** Enable cross-encoder reranking. Default: false */
    enabled?: boolean;
    /** Reranker model ID (e.g., 'rerank-v3.5', 'cross-encoder/ms-marco-MiniLM-L-6-v2') */
    modelId?: string;
    /** Provider ID ('cohere', 'local') */
    providerId?: string;
    /** Number of top results to return after reranking */
    topN?: number;
    /** Max documents to send to reranker (limits cost/latency). Default: 100 */
    maxDocuments?: number;
    /** Request timeout in ms. Default: 30000 */
    timeoutMs?: number;
    /** Provider-specific parameters */
    params?: Record<string, any>;
  };
  /** Include chunk embeddings in the response. */
  includeEmbeddings?: boolean;
  /** Query embedding model override. */
  queryEmbeddingModelId?: string;
  /**
   * HyDE (Hypothetical Document Embedding) configuration.
   * When enabled, generates a hypothetical answer before embedding for
   * improved retrieval quality. Adds one LLM call per retrieval.
   */
  hyde?: {
    /** Enable HyDE for this retrieval. Default: false. */
    enabled?: boolean;
    /** Initial similarity threshold for adaptive thresholding. Default: 0.7. */
    initialThreshold?: number;
    /** Minimum threshold to step down to. Default: 0.3. */
    minThreshold?: number;
    /** Pre-generated hypothesis (skip LLM call if provided). */
    hypothesis?: string;
  };
  /** Advisory token/character budget for final context construction. */
  tokenBudgetForContext?: number;
  /** Caller identity for logging/billing. */
  userId?: string;
  /** When true, generates a RAGAuditTrail with per-operation transparency. */
  includeAudit?: boolean;
  /** Optional shared retrieval policy overlay. */
  policy?: MemoryRetrievalPolicy;
}

/**
 * Retrieval result passed back to callers.
 */
export interface RagRetrievalResult {
  queryText: string;
  retrievedChunks: RagRetrievedChunk[];
  augmentedContext: string;
  queryEmbedding?: number[];
  diagnostics?: RagRetrievalDiagnostics;
  /** Full audit trail when `includeAudit` was set on the retrieval options. */
  auditTrail?: RAGAuditTrail;
}

/**
 * Primary contract for the Retrieval Augmentor implementation.
 */
export interface IRetrievalAugmentor {
  readonly augmenterId: string;

  initialize(
    config: RetrievalAugmentorServiceConfig,
    embeddingManager: IEmbeddingManager,
    vectorStoreManager: IVectorStoreManager,
  ): Promise<void>;

  ingestDocuments(
    documents: RagDocumentInput | RagDocumentInput[],
    options?: RagIngestionOptions,
  ): Promise<RagIngestionResult>;

  retrieveContext(
    queryText: string,
    options?: RagRetrievalOptions,
  ): Promise<RagRetrievalResult>;

  /**
   * Batch-embed a list of texts using the same embedding model the augmentor
   * uses for retrieval. Exposed so consumers (e.g. {@link CitationVerifier}
   * via the agent-level `verifyCitations: { retrievalAugmentor }` shortcut)
   * can share a single embedding pipeline rather than wiring an embedder
   * twice with potentially-divergent model configs.
   */
  embedTexts(texts: string[]): Promise<number[][]>;

  deleteDocuments(
    documentIds: string[],
    dataSourceId?: string,
    options?: { ignoreNotFound?: boolean },
  ): Promise<{ successCount: number; failureCount: number; errors?: Array<{ documentId: string; message: string; details?: any }> }>;

  updateDocuments(
    documents: RagDocumentInput | RagDocumentInput[],
    options?: RagIngestionOptions,
  ): Promise<RagIngestionResult>;

  checkHealth(): Promise<{ isHealthy: boolean; details?: Record<string, unknown> }>;

  shutdown(): Promise<void>;
}
