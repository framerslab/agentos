/**
 * AgentOS RAG (Retrieval Augmented Generation) Module
 * 
 * This module provides a complete RAG system for AgentOS including:
 * - Vector store abstractions and implementations
 * - Embedding management with caching
 * - Document ingestion and chunking
 * - Context retrieval and augmentation
 * 
 * **Architecture Overview:**
 * ```
 * ┌─────────────────────────────────────────────────────────────────┐
 * │                    RetrievalAugmentor                           │
 * │  (Orchestrates ingestion, retrieval, and document management)  │
 * └─────────────────────────────────────────────────────────────────┘
 *                              │
 *          ┌───────────────────┴───────────────────┐
 *          ▼                                       ▼
 * ┌─────────────────────┐              ┌─────────────────────┐
 * │  EmbeddingManager   │              │ VectorStoreManager  │
 * │  (Embedding gen,    │              │ (Multi-provider     │
 * │   caching, models)  │              │  vector storage)    │
 * └─────────────────────┘              └─────────────────────┘
 *          │                                       │
 *          ▼                                       ▼
 * ┌─────────────────────┐              ┌─────────────────────┐
 * │ AIModelProvider     │              │ IVectorStore        │
 * │ (OpenAI, etc.)      │              │ implementations     │
 * └─────────────────────┘              └─────────────────────┘
 *                                              │
 *                    ┌─────────────────────────┼─────────────────────────┐
 *                    ▼                         ▼                         ▼
 *           ┌───────────────┐         ┌───────────────┐         ┌───────────────┐
 *           │ InMemoryStore │         │ SqlVectorStore│         │ Pinecone/etc  │
 *           │ (dev/testing) │         │ (cross-plat)  │         │ (cloud)       │
 *           └───────────────┘         └───────────────┘         └───────────────┘
 *                                             │
 *                                             ▼
 *                                    @framers/sql-storage-adapter
 *                                    (SQLite/Postgres/IndexedDB)
 * ```
 * 
 * @module @framers/agentos/cognition/rag
 * 
 * @example Basic RAG Setup
 * ```typescript
 * import { 
 *   VectorStoreManager, 
 *   EmbeddingManager, 
 *   RetrievalAugmentor 
 * } from '@framers/agentos/cognition/rag';
 * 
 * // Initialize vector store manager
 * const vectorStoreManager = new VectorStoreManager();
 * await vectorStoreManager.initialize(
 *   {
 *     managerId: 'main-vsm',
 *     providers: [{
 *       id: 'sql-store',
 *       type: 'sql',
 *       storage: { filePath: './vectors.db' }
 *     }],
 *     defaultProviderId: 'sql-store'
 *   },
 *   [{ dataSourceId: 'docs', vectorStoreProviderId: 'sql-store', actualNameInProvider: 'documents' }]
 * );
 * 
 * // Initialize embedding manager
 * const embeddingManager = new EmbeddingManager();
 * await embeddingManager.initialize(embeddingConfig, aiProviderManager);
 * 
 * // Initialize retrieval augmentor
 * const ragAugmentor = new RetrievalAugmentor();
 * await ragAugmentor.initialize(ragConfig, embeddingManager, vectorStoreManager);
 * 
 * // Ingest documents
 * await ragAugmentor.ingestDocuments([
 *   { id: 'doc-1', content: 'Document content here...' }
 * ]);
 * 
 * // Retrieve context
 * const result = await ragAugmentor.retrieveContext('What is machine learning?');
 * console.log(result.augmentedContext);
 * ```
 */

// ============================================================================
// Interfaces
// ============================================================================

export type {
  IVectorStore,
  VectorStoreProviderConfig,
  VectorDocument,
  RetrievedVectorDocument,
  QueryOptions,
  QueryResult,
  UpsertOptions,
  UpsertResult,
  DeleteOptions,
  DeleteResult,
  CreateCollectionOptions,
  MetadataFilter,
  MetadataValue,
  MetadataFieldCondition,
  MetadataScalarValue,
} from '../../core/vector-store/IVectorStore.js';

export type {
  IVectorStoreManager,
  VectorStoreManagerHealthReport,
} from '../../core/vector-store/IVectorStoreManager.js';

export type {
  IEmbeddingManager,
  EmbeddingRequest,
  EmbeddingResponse,
} from '../../core/embeddings/IEmbeddingManager.js';

export type {
  IRetrievalAugmentor,
  RagDocumentInput,
  RagIngestionOptions,
  RagIngestionResult,
  RagRetrievalOptions,
  RagRetrievalResult,
  RagRetrievalScope,
  RagRetrievedChunk,
  RagRetrievalDiagnostics,
  RagMemoryCategory,
} from './IRetrievalAugmentor.js';

// ============================================================================
// Implementations
// ============================================================================

export { VectorStoreManager } from './VectorStoreManager.js';
export { EmbeddingManager } from './EmbeddingManager.js';
export { RetrievalAugmentor } from './RetrievalAugmentor.js';

// HyDE (Hypothetical Document Embedding) Retriever
export {
  HydeRetriever,
  type HydeConfig,
  type HydeLlmCaller,
  type HydeRetrievalResult,
  type HydeMultiRetrievalResult,
  DEFAULT_HYDE_CONFIG,
  resolveHydeConfig,
} from './HydeRetriever.js';

// ============================================================================
// Vector Store Implementations
// ============================================================================

export { InMemoryVectorStore } from './vector_stores/InMemoryVectorStore.js';
export { SqlVectorStore, type SqlVectorStoreConfig } from './vector_stores/SqlVectorStore.js';
export { HnswlibVectorStore, type HnswlibVectorStoreConfig } from './vector_stores/HnswlibVectorStore.js';
export { QdrantVectorStore, type QdrantVectorStoreConfig } from './vector_stores/QdrantVectorStore.js';
export { PostgresVectorStore, type PostgresVectorStoreConfig } from './vector_stores/PostgresVectorStore.js';

// ============================================================================
// GraphRAG
// ============================================================================

export { GraphRAGEngine } from '../memory/retrieval/graph/graphrag/index.js';
export type {
  IGraphRAGEngine,
  GraphRAGConfig,
  GraphEntity,
  GraphRelationship,
  GraphCommunity,
  GraphRAGSearchOptions,
  GlobalSearchResult,
  LocalSearchResult,
} from '../memory/retrieval/graph/graphrag/index.js';

// ============================================================================
// Audit Trail
// ============================================================================

export type {
  RAGAuditTrail,
  RAGOperationEntry,
  RAGSourceAttribution,
} from './audit/index.js';

export {
  RAGAuditCollector,
  RAGOperationHandle,
  type RAGAuditCollectorOptions,
} from './audit/index.js';

// ============================================================================
// Multimodal Indexing (images, audio)
// ============================================================================

export { MultimodalIndexer } from './multimodal/index.js';
export { SpeechProviderAdapter } from './multimodal/index.js';
export { LLMVisionAdapter, type LLMVisionAdapterConfig } from './multimodal/index.js';
export {
  createMultimodalIndexerFromResolver,
  type MultimodalIndexerFromResolverOptions,
} from './multimodal/index.js';

export type {
  ContentModality,
  ImageIndexOptions,
  ImageIndexResult,
  AudioIndexOptions,
  AudioIndexResult,
  MultimodalSearchOptions,
  MultimodalSearchResult,
  IVisionProvider,
  ISpeechToTextProvider,
  MultimodalIndexerConfig,
} from './multimodal/index.js';

// ============================================================================
// Hybrid Search (BM25 + Dense)
// ============================================================================

export { BM25Index, type BM25Config, type BM25Document, type BM25Result, type BM25Stats } from './search/index.js';
export { HybridSearcher, type HybridSearcherConfig, type HybridResult } from './search/index.js';

// ============================================================================
// Semantic Chunking
// ============================================================================

export {
  SemanticChunker,
  type SemanticChunkerConfig,
  type SemanticChunk,
  type BoundaryType,
} from './chunking/index.js';

// ============================================================================
// RAPTOR (Recursive Abstractive Processing for Tree-Organized Retrieval)
// ============================================================================

export {
  RaptorTree,
  type RaptorTreeConfig,
  type RaptorInputChunk,
  type RaptorTreeStats,
  type RaptorResult,
} from './raptor/index.js';

// ============================================================================
// Unified Retrieval (plan-based orchestrator)
// ============================================================================

export { UnifiedRetriever, buildDefaultPlan } from './unified/index.js';
export type {
  MemoryRetrievalPolicy,
  MemoryRetrievalProfile,
  ResolvedMemoryRetrievalPolicy,
  RetrievalPlan,
  RetrievalPlanSources,
  MemoryTypeFilter,
  ModalityFilter,
  TemporalConfig,
  GraphTraversalConfig,
  UnifiedRetrievalResult,
  SourceDiagnostics,
  UnifiedRetrieverEvent,
  UnifiedRetrieverDeps,
} from './unified/index.js';
export {
  DEFAULT_MEMORY_RETRIEVAL_POLICY,
  buildRetrievalPlanFromPolicy,
  getCandidateLimit,
  resolveMemoryRetrievalPolicy,
} from './unified/index.js';

// ============================================================================
// Vector Math Utilities
// ============================================================================

export {
  cosineSimilarity,
  dotProduct,
  euclideanDistance,
  embeddingToBlob,
  blobToEmbedding,
  blobToFloat32,
  isLegacyJsonBlob,
  type VectorLike,
} from './utils/vectorMath.js';

// ============================================================================
// Migration Engine
// ============================================================================

export { PineconeVectorStore, type PineconeVectorStoreConfig } from './vector_stores/PineconeVectorStore.js';
export { MigrationEngine } from './migration/MigrationEngine.js';
export type {
  BackendType,
  BackendConfig,
  MigrationOptions,
  MigrationResult,
  IMigrationSource,
  IMigrationTarget,
} from './migration/types.js';

// ============================================================================
// Backend Auto-Setup
// ============================================================================

export { DockerDetector } from './setup/DockerDetector.js';
export { QdrantSetup } from './setup/QdrantSetup.js';
export { PostgresSetup } from './setup/PostgresSetup.js';
export type {
  SetupStatus,
  BackendStatus,
  SetupConfig,
  VectorStoreConfig,
} from './setup/types.js';

// Citation verification
export { CitationVerifier, formatVerifiedResponse } from './citation/index.js';
export type {
  CitationVerifierConfig,
  ClaimVerdict,
  ClaimVerdictKind,
  VerifiedResponse,
  VerificationSource,
} from './citation/index.js';
