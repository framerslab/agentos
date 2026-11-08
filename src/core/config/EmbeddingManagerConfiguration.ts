/**
 * @fileoverview Defines configuration structures for the EmbeddingManager.
 * This includes the main `EmbeddingManagerConfig` which holds settings for
 * caching, model selection, and a list of available `EmbeddingModelConfig` entries.
 * Each `EmbeddingModelConfig` specifies details for a particular embedding model,
 * such as its ID, provider, dimension, and any provider-specific arguments.
 *
 * These configurations are crucial for initializing and operating the EmbeddingManager,
 * allowing it to adapt to different embedding models and operational requirements.
 *
 * @module backend/agentos/config/EmbeddingManagerConfiguration
 * @see ../core/embeddings/IEmbeddingManager.ts
 * @see ../rag/EmbeddingManager.ts
 */

/**
 * Configuration for a single embedding model available to the EmbeddingManager.
 *
 * @interface EmbeddingModelConfig
 */
export interface EmbeddingModelConfig {
  /**
   * A unique identifier for this embedding model.
   * This ID is used to request this specific model for embedding generation.
   * @type {string}
   * @example "text-embedding-3-small", "openai/text-embedding-ada-002", "custom-e5-large-v2"
   */
  modelId: string;

  /**
   * The identifier of the AIModelProvider instance (configured in AIModelProviderManager)
   * that serves this embedding model.
   * @type {string}
   * @example "openai-us-east-1", "local-ollama-server"
   */
  providerId: string;

  /**
   * The dimensionality of the embedding vectors produced by this model.
   * This is critical for setting up compatible vector stores.
   * @type {number}
   * @example 1536, 768, 384
   */
  dimension: number;

  /**
   * Optional: Indicates if this model should be considered the default embedding model
   * if no specific model is requested and other selection strategies don't apply.
   * Only one model should ideally be marked as default if this flag is used.
   * The `EmbeddingManagerConfig.defaultModelId` provides a more explicit way to set the default.
   * @type {boolean}
   * @optional
   */
  isDefault?: boolean;

  /**
   * Optional: A heuristic quality score for the model (e.g., on a scale of 0 to 1, or MTEB score).
   * Used by the 'dynamic_quality' model selection strategy. Higher is generally better.
   * @type {number}
   * @optional
   * @example 0.85
   */
  qualityScore?: number;

  /**
   * Optional: Estimated price per 1 million tokens in USD.
   * Used by the 'dynamic_cost' model selection strategy. Lower is better.
   * @type {number}
   * @optional
   * @example 0.0001 (for $0.0001 / 1K tokens, this would be 0.1)
   * Clarification: OpenAI's ada-002 is $0.0001 / 1K tokens. So per 1M tokens, it's $0.1.
   */
  pricePer1MTokensUSD?: number;

  /**
   * Optional: An array of collection IDs that this model is particularly well-suited for
   * or is designated to handle. Used by the 'dynamic_collection_preference' strategy.
   * @type {string[]}
   * @optional
   * @example ["legal_documents", "medical_transcripts"]
   */
  supportedCollections?: string[];

  /**
   * Optional: A record of provider-specific arguments or parameters to be used
   * when invoking this model via its provider.
   * For example, OpenAI's embedding models can take an `inputType` or `dimensions` parameter.
   * @type {Record<string, any>}
   * @optional
   * @example { "inputType": "search_document" } // For older OpenAI models
   * @example { "dimensions": 256 } // For newer OpenAI models supporting variable dimensions
   */
  providerSpecificArgs?: Record<string, any>;

  /**
   * Optional: Maximum number of input tokens this model can process in a single request.
   * Useful for upstream validation or guiding automatic chunking strategies.
   * @type {number}
   * @optional
   * @example 8191 // For text-embedding-ada-002
   */
  maxInputTokens?: number;

  /**
   * Optional: A human-readable name or description for the model.
   * @type {string}
   * @optional
   * @example "OpenAI Ada v2 (Optimized for similarity)"
   */
  displayName?: string;
}

/**
 * Defines the overall configuration for the EmbeddingManager.
 * This includes a list of all available embedding models, settings for caching,
 * model selection strategies, and default operational parameters.
 *
 * @interface EmbeddingManagerConfig
 */
export interface EmbeddingManagerConfig {
  /**
   * An array of {@link EmbeddingModelConfig} objects, defining each embedding model
   * that the EmbeddingManager can use.
   * At least one model must be configured if `defaultModelId` is not set to a valid model from this list.
   * @type {EmbeddingModelConfig[]}
   */
  embeddingModels: EmbeddingModelConfig[];

  /**
   * Optional: The `modelId` of the embedding model to be used as the default if no
   * specific model is requested or determined by the selection strategy.
   * This model must be defined in the `embeddingModels` array.
   * @type {string}
   * @optional
   * @example "text-embedding-3-small"
   */
  defaultModelId?: string;

  /**
   * Optional: Configuration for the strategy used to select an embedding model
   * when one is not explicitly specified in the `EmbeddingRequest`.
   * @type {object}
   * @optional
   * @property {'static' | 'dynamic_quality' | 'dynamic_cost' | 'dynamic_collection_preference'} type
   * - 'static': Always uses the `defaultModelId`.
   * - 'dynamic_quality': Selects the available model with the highest `qualityScore`.
   * - 'dynamic_cost': Selects the available model with the lowest `pricePer1MTokensUSD`.
   * - 'dynamic_collection_preference': Selects a model listed in `supportedCollections`
   * matching the `collectionId` in the `EmbeddingRequest`.
   * @property {string} [fallbackModelId] - The `modelId` to use if the dynamic strategy
   * fails to select a model (e.g., no model supports
   * a given collection, or no scores are available).
   * Defaults to `defaultModelId` if not set.
   */
  selectionStrategy?: {
    type:
      | 'static'
      | 'dynamic_quality'
      | 'dynamic_cost'
      | 'dynamic_collection_preference';
    fallbackModelId?: string;
    // Future: Add parameters for strategies, e.g., thresholds.
  };

  /**
   * Optional: Determines if embedding results should be cached.
   * Defaults to `true` if not specified. Set to `false` to disable caching.
   * @type {boolean}
   * @optional
   * @default true
   */
  enableCache?: boolean;

  /**
   * Optional: The maximum number of embedding entries to store in the LRU cache.
   * Only applicable if `enableCache` is true.
   * @type {number}
   * @optional
   * @default 1000
   */
  cacheMaxSize?: number;

  /**
   * Optional: The time-to-live (TTL) for cache entries in seconds.
   * Only applicable if `enableCache` is true.
   * @type {number}
   * @optional
   * @default 3600 (1 hour)
   */
  cacheTTLSeconds?: number;

  /**
   * Optional: The default batch size to use when sending multiple texts to an LLM provider
   * for embedding. Providers often have limits on batch size or perform better with
   * optimal batching. The default of 32 stays under OpenAI's per-request limits of 2,048
   * inputs and 300,000 tokens summed across inputs, even at 8,192 tokens an input
   * (https://developers.openai.com/api/reference/resources/embeddings/methods/create).
   * @type {number}
   * @optional
   * @default 32
   */
  defaultBatchSize?: number;

  /**
   * Optional: A system-wide default embedding dimension.
   * This can serve as a fallback if a specific `EmbeddingModelConfig` somehow
   * omits the `dimension` property, or for components that need a general idea
   * of embedding size before a specific model is chosen.
   * @type {number}
   * @optional
   * @example 1536
   */
  defaultEmbeddingDimension?: number;
}