/**
 * @fileoverview Defines configuration structures for the RetrievalAugmentor.
 * This includes how different RAG memory categories are handled, default
 * behaviors for ingestion and retrieval, and other operational parameters for
 * the core RAG orchestration service.
 *
 * The configurations here rely on data contract types (like options and results
 * for retrieval/ingestion) defined in `../rag/IRetrievalAugmentor.ts`.
 *
 * @module backend/agentos/config/RetrievalAugmentorConfiguration
 * @see ../rag/IRetrievalAugmentor.ts for operational data contracts.
 * @see ../rag/RetrievalAugmentor.ts for the concrete implementation using this config.
 */

import {
  RagMemoryCategory,
  RagRetrievalOptions, // Assuming this is defined in IRetrievalAugmentor.ts
  RagIngestionOptions, // Assuming this is defined in IRetrievalAugmentor.ts
} from '../../cognition/rag/IRetrievalAugmentor.js';
import type { RerankerServiceConfig } from '../../cognition/rag/reranking/IRerankerService.js';

/**
 * Defines default behaviors and mappings for different RAG memory categories.
 * Each memory category can be configured to use specific data collections,
 * default operational parameters, and retention policies.
 *
 * @interface RagCategoryBehavior
 * @property {RagMemoryCategory} category - The logical memory category (e.g., 'user_explicit_memory').
 * @property {string[]} targetDataSourceIds - The actual data source ID(s) (collections/indexes
 * in a vector store) that this logical category maps to. A category can map to multiple physical data sources.
 * @property {Partial<RagRetrievalOptions>} [defaultRetrievalOptions] - Default retrieval options specific to this category,
 * overriding global defaults. These are partial because they only override specified fields.
 * @property {Partial<RagIngestionOptions>} [defaultIngestionOptions] - Default ingestion options specific to this category,
 * overriding global defaults.
 * @property {string} [defaultEmbeddingModelId] - Default embedding model ID for this category, overriding
 * the EmbeddingManager's default or the RetrievalAugmentor's default query model.
 * @property {number} [retentionDays] - Optional: How long to retain items in this category in days.
 * A value of 0 or undefined might imply indefinite retention or reliance on underlying store policies.
 * @property {boolean} [isUserSpecific] - True if data in this category is typically tied to a `userId` and
 * should be filtered accordingly during retrieval by default.
 * @property {boolean} [isPersonaSpecific] - True if data in this category is typically tied to a specific
 * `personaId` and might require persona-based access or filtering.
 * @property {number} [queryPriority=0] - Priority for querying this category when multiple categories are searched.
 * Higher values indicate higher priority. This can influence result merging or ordering.
 * @property {Record<string, any>} [customMetadata] - Any other custom metadata or flags associated with this category's behavior.
 */
export interface RagCategoryBehavior {
  category: RagMemoryCategory;
  targetDataSourceIds: string[];
  defaultRetrievalOptions?: Partial<RagRetrievalOptions>;
  defaultIngestionOptions?: Partial<RagIngestionOptions>;
  defaultEmbeddingModelId?: string;
  retentionDays?: number;
  isUserSpecific?: boolean;
  isPersonaSpecific?: boolean;
  queryPriority?: number;
  customMetadata?: Record<string, any>;
}

/**
 * Configuration for the RetrievalAugmentor service itself.
 * This structure is typically loaded at application startup to initialize the
 * RetrievalAugmentor instance.
 *
 * @interface RetrievalAugmentorServiceConfig
 * @property {string} [defaultQueryEmbeddingModelId] - Optional: An embedding model ID that overrides the
 * EmbeddingManager's default, specifically for generating query embeddings within the RetrievalAugmentor.
 * If not set, the EmbeddingManager's default will be used.
 * @property {string} [defaultEmbeddingModelId] - Optional: default embedding model for document ingestion when
 * individual requests or categories do not override it.
 * @property {string} [defaultDataSourceId] - Optional: fallback data source / collection for ingestion + retrieval.
 * @property {RagIngestionOptions['chunkingStrategy']} [defaultChunkingStrategy] - Optional fallback chunking strategy.
 * @property {Partial<RagRetrievalOptions>} [globalDefaultRetrievalOptions] - Global default retrieval options that apply if
 * no category-specific or request-specific options are provided.
 * @property {Partial<RagIngestionOptions>} [globalDefaultIngestionOptions] - Global default ingestion options.
 * @property {RagCategoryBehavior[]} categoryBehaviors - An array defining the behavior and mapping for each
 * supported RAG memory category. This is a core part of the configuration, dictating how different
 * types of information are handled.
 * @property {number} [maxCharsForAugmentedPrompt=4000] - The maximum number of characters to include in the
 * `augmentedPromptText` generated by `retrieveContext`. This helps in managing token limits for LLMs.
 * @property {string} [contextJoinSeparator="\n\n---\n\n"] - The separator string used when joining multiple
 * retrieved context snippets into the single `augmentedPromptText`.
 * @property {boolean} [enableExperimentalFeatures=false] - A flag to enable or disable experimental RAG features,
 * allowing for controlled rollout and testing.
 * @property {object} [performanceTuning] - Optional advanced settings for performance tuning.
 * @property {number} [performanceTuning.maxConcurrentQueries] - Max concurrent queries to vector stores.
 * @property {number} [performanceTuning.queryTimeoutMs] - Default timeout for RAG queries.
 */
export interface RetrievalAugmentorServiceConfig {
  defaultQueryEmbeddingModelId?: string;
  defaultEmbeddingModelId?: string;
  defaultDataSourceId?: string;
  defaultChunkingStrategy?: RagIngestionOptions['chunkingStrategy'];
  globalDefaultRetrievalOptions?: Partial<RagRetrievalOptions>;
  globalDefaultIngestionOptions?: Partial<RagIngestionOptions>;
  categoryBehaviors: RagCategoryBehavior[];
  maxCharsForAugmentedPrompt?: number;
  contextJoinSeparator?: string;
  enableExperimentalFeatures?: boolean;
  performanceTuning?: {
    maxConcurrentQueries?: number;
    queryTimeoutMs?: number;
  };
  /**
   * Cross-encoder reranker service configuration.
   *
   * When configured, enables optional reranking of retrieved chunks using
   * cross-encoder models. Reranking is disabled by default and must be
   * explicitly enabled per-request via `rerankerConfig.enabled: true`.
   *
   * `initialize()` registers the `cohere` provider (when its entry has an
   * `apiKey`) and the `local` provider for the entries this list names. The
   * `llm-judge` provider and any provider of your own are registered with
   * `RetrievalAugmentor.registerRerankerProvider()`.
   *
   * @see RerankerServiceConfig for provider configuration details
   */
  rerankerServiceConfig?: RerankerServiceConfig;
  /**
   * Default reranker provider ID when reranking is enabled but no provider specified.
   * Built-in values: 'local', 'cohere', 'llm-judge'; or the id of a provider the host registered.
   */
  defaultRerankerProviderId?: string;
  /**
   * Default reranker model ID when reranking is enabled but no model specified.
   * Examples: 'cross-encoder/ms-marco-MiniLM-L-6-v2' (local), 'rerank-v3.5' (Cohere). The LLM judge
   * ignores it and calls `llmCallFn` with its own `scoringModel` and `rankingModel`.
   */
  defaultRerankerModelId?: string;
}

// Example of how categoryBehaviors might be configured:
/*
const exampleRetrievalAugmentorServiceConfig: RetrievalAugmentorServiceConfig = {
  categoryBehaviors: [
    {
      category: RagMemoryCategory.SHARED_KNOWLEDGE_BASE,
      targetDataSourceIds: ['global_wiki_main', 'global_faq_secondary'],
      defaultRetrievalOptions: { topK: 5, strategyParams: { mmrLambda: 0.7 } },
      defaultIngestionOptions: { chunkingStrategy: { type: 'recursive_character', chunkSize: 1000, chunkOverlap: 100 } },
      queryPriority: 10,
    },
    {
      category: RagMemoryCategory.USER_EXPLICIT_MEMORY,
      targetDataSourceIds: ['user_private_notes_vector_store'],
      isUserSpecific: true,
      defaultRetrievalOptions: { topK: 3 },
      queryPriority: 100, // High priority for personal user memory
      retentionDays: 365, // User notes kept for a year by default
    },
    {
      category: RagMemoryCategory.PERSONAL_LLM_EXPERIENCE,
      targetDataSourceIds: ['gmi_self_learnings_collection'],
      isPersonaSpecific: true, // Or combination of user & persona
      defaultRetrievalOptions: { topK: 2, strategyParams: { mmrLambda: 0.5 } },
      queryPriority: 50,
    }
  ],
  globalDefaultRetrievalOptions: { topK: 3, strategy: 'similarity' },
  maxCharsForAugmentedPrompt: 3000,
  contextJoinSeparator: "\n\n[SOURCE]\n",
};
*/
