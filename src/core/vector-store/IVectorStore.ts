/**
 * @fileoverview Defines the IVectorStore interface, representing the contract
 * for interacting with a specific vector database or storage backend. This
 * interface abstracts the common operations such as upserting, querying, and
 * deleting vector documents, along with managing collections/indexes.
 *
 * It also defines core data structures used in these operations, including
 * configurations for providers, document formats, query options, and metadata filters.
 *
 * @module backend/agentos/core/vector-store/IVectorStore
 * @see ../../config/VectorStoreConfiguration.ts for specific provider configurations.
 * @see ./IVectorStoreManager.ts for the interface that manages multiple IVectorStore instances.
 */

/**
 * Base configuration for any vector store provider.
 * Specific provider configurations (e.g., for Pinecone, Weaviate) should extend this.
 *
 * @interface VectorStoreProviderConfig
 * @property {string} id - A unique identifier for this specific provider instance
 * (e.g., "pinecone-main-prod", "weaviate-dev-local"). This ID is used by the
 * VectorStoreManager to retrieve this provider.
 * @property {string} type - The type of the vector store provider
 * (e.g., "pinecone", "weaviate", "in_memory", "lancedb"). This helps in
 * selecting the correct implementation.
 * @property {Record<string, any>} [customProps] - Any other custom properties or
 * configurations specific to this provider instance not covered by standard fields.
 */
export interface VectorStoreProviderConfig {
  id: string;
  type: string;
  customProps?: Record<string, any>;
}

/**
 * Represents a scalar value allowed in document metadata.
 * @typedef {string | number | boolean} MetadataScalarValue
 */
export type MetadataScalarValue = string | number | boolean;

/**
 * Represents a value in document metadata, which can be a scalar or an array of scalars.
 * @typedef {MetadataScalarValue | MetadataScalarValue[]} MetadataValue
 */
export type MetadataValue = MetadataScalarValue | MetadataScalarValue[];

/**
 * Defines conditions for filtering metadata fields during a query.
 * Each property represents a comparison operator.
 *
 * @interface MetadataFieldCondition
 * @example
 * // Find documents where 'year' >= 2022
 * { year: { $gte: 2022 } }
 * // Find documents where 'tags' array contains 'typescript'
 * { tags: { $contains: 'typescript' } }
 * // Find documents where 'status' is 'published'
 * { status: { $eq: 'published' } } // or simply { status: 'published' }
 */
export interface MetadataFieldCondition {
  $eq?: MetadataScalarValue;        // Equal to
  $ne?: MetadataScalarValue;        // Not equal to
  $gt?: number | string;            // Greater than. Strings are compared lexicographically (e.g. ISO timestamps).
  $gte?: number | string;           // Greater than or equal to. Strings are compared lexicographically.
  $lt?: number | string;            // Less than. Strings are compared lexicographically (e.g. ISO timestamps).
  $lte?: number | string;           // Less than or equal to. Strings are compared lexicographically.
  $in?: MetadataScalarValue[];      // Value is one of these (for scalar fields)
  $nin?: MetadataScalarValue[];     // Value is not one of these (for scalar fields)
  $exists?: boolean;                // Field exists (true) or does not exist (false)
  $contains?: MetadataScalarValue;  // For array fields: the array contains this value. For string fields: the string contains this substring.
  $all?: MetadataScalarValue[];     // For array fields: the array contains all of these values.
  $textSearch?: string;             // Perform a text search within the metadata field (if supported by the store).
}

/**
 * Defines a filter for document metadata. All top-level key-value pairs are implicitly ANDed.
 * The value for a field can be a direct scalar match (implicit equality) or a `MetadataFieldCondition` object
 * for more complex comparisons.
 *
 * @typedef {Object.<string, MetadataScalarValue | MetadataFieldCondition>} MetadataFilter
 * @example
 * const filter: MetadataFilter = {
 * category: "technology", // Implicit $eq
 * year: { $gte: 2023 },
 * tags: { $all: ["typescript", "AI"] },
 * isPublished: true
 * };
 */
export type MetadataFilter = {
  [key: string]: MetadataScalarValue | MetadataFieldCondition;
};

/**
 * Represents a document to be stored or retrieved from a vector store.
 *
 * @interface VectorDocument
 * @property {string} id - A unique identifier for the document.
 * @property {number[]} embedding - The vector embedding of the document's content.
 * @property {Record<string, MetadataValue>} [metadata] - A flexible key-value store for document metadata.
 * Values can be scalars or arrays of scalars. Used for filtering and providing context.
 * @property {string} [textContent] - Optional: The raw text content of the document.
 * Some use cases might store this alongside the embedding, while others might fetch it from a primary store using the ID.
 */
export interface VectorDocument {
  id: string;
  embedding: number[];
  metadata?: Record<string, MetadataValue>;
  textContent?: string;
}

/**
 * Options for a vector store query operation.
 *
 * @interface QueryOptions
 * @property {number} [topK=10] - The number of most similar documents to retrieve.
 * @property {MetadataFilter} [filter] - Metadata filter to apply to the search. Only documents matching
 * the filter will be considered.
 * @property {boolean} [includeEmbedding=false] - Whether to include the embedding vector in the retrieved documents.
 * @property {boolean} [includeMetadata=true] - Whether to include metadata in the retrieved documents.
 * @property {boolean} [includeTextContent=false] - Whether to include the `textContent` in the retrieved documents.
 * @property {number} [minSimilarityScore] - Optional minimum similarity score (0-1, or specific to metric)
 * for a document to be included in the results. Interpretation depends on the store's similarity metric.
 * @property {string} [userId] - Optional user ID, which might be used for multi-tenancy filters if the store supports it.
 * @property {Record<string, any>} [customParams] - Provider-specific parameters for the query.
 */
export interface QueryOptions {
  topK?: number;
  filter?: MetadataFilter;
  includeEmbedding?: boolean;
  includeMetadata?: boolean;
  includeTextContent?: boolean;
  minSimilarityScore?: number;
  userId?: string;
  customParams?: Record<string, any>;
}

/**
 * Represents a single document retrieved from a query, including its similarity score.
 *
 * @interface RetrievedVectorDocument
 * @extends VectorDocument
 * @property {number} similarityScore - The similarity score of this document with respect to the query vector.
 * The meaning of this score depends on the similarity metric used by the vector store (e.g., cosine similarity, Euclidean distance).
 */
export interface RetrievedVectorDocument extends VectorDocument {
  similarityScore: number;
}

/**
 * The result of a vector store query operation.
 *
 * @interface QueryResult
 * @property {RetrievedVectorDocument[]} documents - An array of retrieved documents, typically sorted by relevance (similarity score).
 * @property {string} [queryId] - An optional identifier for the query, useful for logging or diagnostics.
 * @property {Record<string, any>} [stats] - Optional statistics about the query execution (e.g., latency).
 */
export interface QueryResult {
  documents: RetrievedVectorDocument[];
  queryId?: string;
  stats?: Record<string, any>;
}

/**
 * Options for enumerating documents by metadata without a query embedding.
 */
export interface MetadataScanOptions {
  filter?: MetadataFilter;
  limit?: number;
  includeEmbedding?: boolean;
  includeMetadata?: boolean;
  includeTextContent?: boolean;
  cursor?: string;
  customParams?: Record<string, any>;
}

/**
 * Result of a metadata-only document scan.
 */
export interface MetadataScanResult {
  documents: RetrievedVectorDocument[];
  nextCursor?: string;
  stats?: Record<string, any>;
}

/**
 * Options for a vector store upsert (insert or update) operation.
 *
 * @interface UpsertOptions
 * @property {number} [batchSize] - Preferred batch size for upserting multiple documents, if the provider supports batching.
 * @property {boolean} [overwrite=true] - Whether to overwrite existing documents with the same ID.
 * @property {Record<string, any>} [customParams] - Provider-specific parameters for the upsert operation.
 */
export interface UpsertOptions {
  batchSize?: number;
  overwrite?: boolean;
  customParams?: Record<string, any>;
}

/**
 * The result of a vector store upsert operation.
 *
 * @interface UpsertResult
 * @property {number} upsertedCount - The number of documents successfully upserted.
 * @property {string[]} [upsertedIds] - Optional array of IDs of the upserted documents.
 * @property {number} [failedCount=0] - The number of documents that failed to upsert.
 * @property {Array<{ id: string; error: string; details?: any }>} [errors] - Detailed information about any failures.
 */
export interface UpsertResult {
  upsertedCount: number;
  upsertedIds?: string[];
  failedCount?: number;
  errors?: Array<{ id: string; message: string; details?: any }>;
}

/**
 * Options for a vector store delete operation.
 *
 * @interface DeleteOptions
 * @property {MetadataFilter} [filter] - Optional: Delete documents matching this metadata filter.
 * If `ids` are also provided, the behavior (AND/OR) might be store-specific or could be an error.
 * Typically, deletion is by IDs OR by filter.
 * @property {boolean} [deleteAll=false] - If true (and `ids` and `filter` are empty), attempt to delete all documents
 * in the specified collection. This is a destructive operation and should be used with extreme caution.
 * @property {Record<string, any>} [customParams] - Provider-specific parameters for the delete operation.
 */
export interface DeleteOptions {
  filter?: MetadataFilter;
  deleteAll?: boolean;
  customParams?: Record<string, any>;
}

/**
 * The result of a vector store delete operation.
 *
 * @interface DeleteResult
 * @property {number} deletedCount - The number of documents successfully deleted.
 * @property {number} [failedCount=0] - The number of documents/operations that failed.
 * @property {Array<{ id?: string; error: string; details?: any }>} [errors] - Detailed information about any failures.
 */
export interface DeleteResult {
  deletedCount: number;
  failedCount?: number;
  errors?: Array<{ id?: string; message: string; details?: any }>;
}

/**
 * Options for creating a new collection/index in the vector store.
 * @interface CreateCollectionOptions
 * @property {'cosine' | 'euclidean' | 'dotproduct'} [similarityMetric='cosine'] - The similarity metric for the collection.
 * @property {boolean} [overwriteIfExists=false] - If a collection with the same name exists, should it be overwritten?
 * @property {number} [replicas] - Number of replicas for the collection (if supported).
 * @property {number} [shards] - Number of shards for the collection (if supported).
 * @property {Record<string, any>} [providerSpecificParams] - Any other parameters specific to the vector store provider
 * for collection creation (e.g., indexing options, cloud region).
 */
export interface CreateCollectionOptions {
  similarityMetric?: 'cosine' | 'euclidean' | 'dotproduct';
  overwriteIfExists?: boolean;
  replicas?: number;
  shards?: number;
  providerSpecificParams?: Record<string, any>;
}

/**
 * @interface IVectorStore
 * @description Defines the contract for interacting with a specific vector database or storage backend.
 * Implementations will wrap specific clients (e.g., Pinecone client, Weaviate client, in-memory store logic).
 */
export interface IVectorStore {
  /**
   * Initializes the vector store provider with its specific configuration.
   * This method must be called before any other operations can be performed.
   * It sets up connections, authenticates, and prepares the store for use.
   *
   * @async
   * @param {VectorStoreProviderConfig} config - The configuration object specific to this vector store provider.
   * This is typically a more specific type that extends `VectorStoreProviderConfig`.
   * @returns {Promise<void>} A promise that resolves when initialization is complete.
   * @throws {Error} If initialization fails (e.g., invalid configuration, connection error, authentication failure).
   */
  initialize(config: VectorStoreProviderConfig): Promise<void>;

  /**
   * Upserts (inserts or updates) a batch of documents into a specified collection.
   * If a document with the same ID already exists, it is typically updated; otherwise, it's inserted.
   *
   * @async
   * @param {string} collectionName - The name of the collection (or index, class, etc.) to upsert documents into.
   * @param {VectorDocument[]} documents - An array of documents to upsert.
   * @param {UpsertOptions} [options] - Optional parameters for the upsert operation.
   * @returns {Promise<UpsertResult>} A promise that resolves with the result of the upsert operation.
   * @throws {Error} If the upsert operation fails critically.
   */
  upsert(
    collectionName: string,
    documents: VectorDocument[],
    options?: UpsertOptions,
  ): Promise<UpsertResult>;

  /**
   * Queries a specified collection for documents similar to the provided query embedding.
   *
   * @async
   * @param {string} collectionName - The name of the collection to query.
   * @param {number[]} queryEmbedding - The query vector embedding.
   * @param {QueryOptions} [options] - Optional parameters for the query operation, including filters and topK.
   * @returns {Promise<QueryResult>} A promise that resolves with the query results.
   * @throws {Error} If the query operation fails.
   */
  query(
    collectionName: string,
    queryEmbedding: number[],
    options?: QueryOptions,
  ): Promise<QueryResult>;

  /**
   * Optional: Enumerates documents using metadata-only filtering without
   * requiring a query embedding.
   */
  scanByMetadata?(
    collectionName: string,
    options?: MetadataScanOptions,
  ): Promise<MetadataScanResult>;

  /**
   * Optional: Fetch documents by their primary IDs without similarity ranking.
   *
   * Used by callers like `HybridSearcher` to hydrate documents that were
   * ranked by a sparse / lexical index but missed the dense top-K — a
   * primary-key fetch is the only correct hydration path here because a
   * second similarity query would surface the next-K dense rows instead
   * of the specific BM25 winners, misattributing rows under the wrong
   * fused-score position.
   *
   * Stores that cannot do efficient PK fetches (e.g. some sparse-only or
   * remote indexes) may leave this unimplemented; callers must then choose
   * whether to drop sparse-only winners or fall back to text-content-missing
   * results.
   *
   * The returned `RetrievedVectorDocument.similarityScore` is set to 0 as
   * a sentinel — callers that try to rank these by `similarityScore` will
   * get an obvious "no similarity" signal rather than a stale cosine number.
   *
   * @async
   * @param {string} collectionName - The collection to fetch from.
   * @param {string[]} ids - Document IDs to fetch. Empty array returns [].
   * @param {object} [options] - Optional inclusion flags (default both true).
   * @returns {Promise<RetrievedVectorDocument[]>} Hydrated documents in
   *   implementation-defined order (callers should not rely on ordering).
   */
  fetchByIds?(
    collectionName: string,
    ids: string[],
    options?: { includeMetadata?: boolean; includeTextContent?: boolean },
  ): Promise<RetrievedVectorDocument[]>;

  /**
   * Optional: Hybrid retrieval combining dense vector similarity with lexical search.
   *
   * This is typically implemented using a store-native full-text index (e.g., SQLite FTS5),
   * or a store-side BM25 implementation, then fusing dense and lexical rankings (e.g., RRF).
   *
   * If not implemented, callers should fall back to `query()` (dense similarity).
   */
  hybridSearch?(
    collectionName: string,
    queryEmbedding: number[],
    queryText: string,
    options?: QueryOptions & {
      /** Weight of dense retrieval (0..1). Default: implementation-defined. */
      alpha?: number;
      /** Fusion method used to combine rankings. Default: implementation-defined. */
      fusion?: 'rrf' | 'weighted';
      /** RRF k constant when `fusion='rrf'`. Default: implementation-defined. */
      rrfK?: number;
      /** Number of lexical candidates to consider before fusion. Default: implementation-defined. */
      lexicalTopK?: number;
    },
  ): Promise<QueryResult>;

  /**
   * Deletes documents from a specified collection by their IDs or by a metadata filter.
   *
   * @async
   * @param {string} collectionName - The name of the collection to delete documents from.
   * @param {string[]} [ids] - An array of document IDs to delete.
   * @param {DeleteOptions} [options] - Optional parameters, including metadata filters or a deleteAll flag.
   * If `ids` are provided, `options.filter` might be ignored or combined,
   * depending on store behavior. Use with caution.
   * @returns {Promise<DeleteResult>} A promise that resolves with the result of the delete operation.
   * @throws {Error} If the delete operation fails.
   */
  delete(
    collectionName: string,
    ids?: string[],
    options?: DeleteOptions,
  ): Promise<DeleteResult>;

  /**
   * Creates a new collection (or index, class, etc.) in the vector store.
   * This is often necessary before documents can be upserted into it, depending on the provider.
   *
   * @async
   * @param {string} collectionName - The name of the collection to create.
   * @param {number} dimension - The dimensionality of the vector embeddings that will be stored in this collection.
   * @param {CreateCollectionOptions} [options] - Optional parameters for collection creation, such as similarity metric or provider-specific settings.
   * @returns {Promise<void>} A promise that resolves when the collection is successfully created.
   * @throws {Error} If collection creation fails (e.g., name conflict and not overwriting, invalid parameters).
   */
  createCollection?(
    collectionName: string,
    dimension: number,
    options?: CreateCollectionOptions,
  ): Promise<void>;

  /**
   * Deletes an entire collection from the vector store. This is a destructive operation.
   *
   * @async
   * @param {string} collectionName - The name of the collection to delete.
   * @returns {Promise<void>} A promise that resolves when the collection is successfully deleted.
   * @throws {Error} If collection deletion fails.
   */
  deleteCollection?(collectionName: string): Promise<void>;

  /**
   * Checks if a collection with the given name exists in the vector store.
   *
   * @async
   * @param {string} collectionName - The name of the collection to check.
   * @returns {Promise<boolean>} A promise that resolves with `true` if the collection exists, `false` otherwise.
   * @throws {Error} If the check fails for reasons other than existence (e.g., connection issue).
   */
  collectionExists?(collectionName: string): Promise<boolean>;

  /**
   * Checks the operational health of the vector store provider.
   * This might involve pinging the service, checking connection status, or verifying authentication.
   *
   * @async
   * @returns {Promise<{ isHealthy: boolean; details?: any }>} A promise that resolves with the health status.
   * `details` can include specific error messages or status information.
   */
  checkHealth(): Promise<{ isHealthy: boolean; details?: any }>;

  /**
   * Gracefully shuts down the vector store provider, releasing any resources
   * such as database connections or client instances.
   *
   * @async
   * @returns {Promise<void>} A promise that resolves when shutdown is complete.
   */
  shutdown(): Promise<void>;

  /**
   * Optional: Retrieves statistics about a specific collection or the store itself.
   * The structure of the returned statistics is provider-dependent.
   *
   * @async
   * @param {string} [collectionName] - Optional: The name of the collection to get stats for.
   * If omitted, may return store-wide stats if supported.
   * @returns {Promise<Record<string, any>>} A promise that resolves with a statistics object.
   * @throws {Error} If fetching statistics fails.
   */
  getStats?(collectionName?: string): Promise<Record<string, any>>;
}
