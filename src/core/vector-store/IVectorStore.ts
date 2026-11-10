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

/** How a stored word matches a query word in a grouped lexical search: the same word, a word it begins, or a word one edit away. */
export type LexicalMatchKind = 'same' | 'start' | 'edit';

/** One item of a group: the caller's source id and the instant the caller orders it by, or null. */
export interface LexicalGroupItem {
  /** The value of the passages' `sourceId` metadata key: a text that is not empty and holds no NUL. */
  sourceId: string;
  /**
   * An ISO 8601 instant with its zone (`2026-03-01T09:30:00.000Z`) that names a real day and time, to the
   * microsecond at most, or null for an item with no date.
   */
  date: string | null;
}

/** An item's place in a page's complete order: what a later page starts after. */
export interface LexicalGroupKey {
  /** The item's date as the caller handed it, or null. Read only under the date order and by a listing with no word. */
  date?: string | null;
  /** The item's rank, the decimal text an earlier page answered: at most 131072 digits before the point, leading zeros aside, and 16383 after it, as a Postgres numeric holds. */
  rank: string;
  /** The item's source id. */
  sourceId: string;
}

/**
 * One group of a grouped lexical search ({@link IVectorStore.lexicalGroupSearch}): the items to read, the words, how
 * an item ranks and which page of the answer is asked for.
 */
export interface LexicalGroupSearchOptions {
  /**
   * The query's words, in order, each once: a letter or a digit followed by letters, digits and combining marks, in
   * lower case, as `lexicalTokens` reads them. A word the store's text search configuration reads as no word (a stop
   * word) is left out of the search: the other words decide. With no word at all the search lists every item that holds
   * a passage, in the date order.
   */
  words: string[];
  /**
   * For each word, in order, the stored words one edit away that an earlier page of this search matched. With it the
   * store reads no stored word again and `oneEdit` is not read; a search hands back what the first page answered.
   * At most 64 a word; each stored word is at most 2046 bytes of UTF-8 and all of them, each with one byte more, at
   * most 1048575 bytes less the query's words, each counted twice with one byte more, as one tsquery holds them
   * beside those words.
   */
  expansion?: string[][];
  /**
   * Without `expansion`: widens each word of `minLength` letters or more to the stored words of the group's passages
   * that are one edit away (a letter added, dropped or changed, or two side by side swapped) and hold `minLength`
   * letters or more, the most frequent first, at most `max` a word, and only as many as `expansion` holds. `max` is a
   * whole number from 1 to 64. A word that more than `max` stored words are one edit from, or one whose stored word
   * `expansion` has no room for, marks the answer incomplete. The words drawn follow the rule the answer's
   * `expansion` states.
   */
  oneEdit?: { minLength: number; max: number };
  /**
   * The items to read, which the search never leaves: a passage counts only when its `sourceId` is one of them, a
   * text and not a number of the same digits, and `filter` admits it. `partKinds` keeps the passages whose `partKind` metadata key is one of these; an empty list
   * narrows nothing. An item is listed once.
   */
  group: { items: LexicalGroupItem[]; partKinds?: string[] };
  /**
   * Each field's weight, a finite number above 0, read by a passage's `field` metadata key; a passage with no `field`,
   * or one `fields` does not name, takes the weight of `fallback`, which `fields` names. With `title: 'metadata'` an
   * item's `title` metadata key is matched as well, as the field `title`.
   */
  profile: { fields: Record<string, number>; fallback: string; title?: 'passage' | 'metadata' };
  /** `rank`: the highest rank first. `date`: the newest of the caller's dates first, an undated item after every dated one. */
  order: 'rank' | 'date';
  /** The most items a page answers: a whole number, 1 or more, that JavaScript holds exactly. */
  pageSize: number;
  /** The last item of the page before this one; without it, the first page. */
  after?: LexicalGroupKey;
  /**
   * What else a passage must meet: the caller's scope. A plain value, `$eq`, `$ne`, `$in` and `$nin` compare a key that
   * holds one value by its JSON type as well, so `{ tenantId: '7' }` never admits a passage whose `tenantId` is the
   * number 7, as `LibraryIndex` checks the passages a store answers.
   */
  filter?: MetadataFilter;
  /**
   * Checked between the store's statements: once it has aborted the store starts no further statement of the search
   * and answers `incomplete` with no item. A statement that has started runs to its end.
   */
  signal?: AbortSignal;
}

/** One item a grouped lexical search found. */
export interface LexicalGroupRow {
  /** The item's source id. */
  sourceId: string;
  /**
   * The item's rank as exact decimal text: for each word, the best of its matches over the item's passages, the
   * weight of the passage's field times the match's kind (the same word 1, a word it begins 0.75, a word one edit away
   * 0.5), summed over the words. `0` in a listing with no word.
   */
  rank: string;
  /**
   * The field of the match shown: `document`'s field as the rank read it (its `field` metadata key, or the profile's
   * `fallback` when it has none or the profile does not name it), or the title's field when no passage holds a word
   * and the item matched by its title read from the metadata.
   */
  field: string;
  /**
   * For each word, in order, the kind of the item's best match of it, over its passages and its title read from the
   * metadata, or null for a word the item does not hold.
   */
  kinds: Array<LexicalMatchKind | null>;
  /**
   * The passage to show, with its metadata and text: the one that holds the most words, then the one of the strongest
   * field, then the earliest; the item's first passage when no passage holds a word (a listing, or a match in a title
   * read from the metadata alone).
   */
  document: RetrievedVectorDocument;
  /** For each word, in order, how `document` holds it, or null when it does not. */
  held: Array<LexicalMatchKind | null>;
}

/** What a grouped lexical search answers for one group. */
export interface LexicalGroupSearchResult {
  /** How many distinct items match every word, whatever the page. */
  total: number;
  /**
   * True when a word had more stored words one edit away than `oneEdit.max`, in which case the most frequent `max` are
   * matched and the items are answered; when a stored word one edit away was left out as the tsquery had no room for
   * it (past 2046 bytes, or past the room `expansion` states), in which case the words kept are matched and the items
   * are answered; or when the signal stopped the search, in which case no item is.
   */
  incomplete: boolean;
  /**
   * For each word, in order, the stored words one edit away the search matched: found on a first page, the caller's
   * own `expansion` echoed on a later page. `LibraryIndex` carries a first page's lists in its cursor and holds them
   * to the same rule when a later page hands them back; a later page's cursor carries the lists the index handed that
   * page, never the store's answer, so a store answers only lists that keep the rule:
   * - a list for each word: on a first page, empty for a word under `oneEdit.minLength` letters, and empty for every
   *   word without `oneEdit`; on a later page, the list handed in `expansion` for that word;
   * - each stored word one edit from its word (a letter added, dropped or changed, or two side by side swapped) and
   *   `oneEdit.minLength` letters or more, and never the word itself or a word that begins with it, which match as
   *   such;
   * - each stored word once in its list, and at most `oneEdit.max` (64 at most) a word;
   * - each at most 2046 bytes of UTF-8, and all of them within the room `expansion` states beside the query's words.
   * A word the store left out for room or past `max` marks the answer `incomplete`. A first page's list outside the rule,
   * such as `[['budgets', 'budgte']]` for `budget`, makes the index refuse the cursor of its own next page.
   */
  expansion: string[][];
  /** The page's items, in order. */
  rows: LexicalGroupRow[];
  /**
   * On a first page of two words or more where no item matches every word: the items that match some of the words,
   * in order, at most `pageSize`. They are outside `total`.
   */
  anyWord: LexicalGroupRow[];
  /** Whether an item follows the page's last. */
  more: boolean;
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
      /** Lexical leg: every word of the query (`'all'`) or any word (`'any'`). Default: implementation-defined. */
      match?: 'all' | 'any';
      /** Lexical leg: a query word also matches a stored word that begins with it. Default: false. */
      prefix?: boolean;
    },
  ): Promise<QueryResult>;

  /**
   * Optional: search on the store's lexical index alone, with no embedding. `match` asks for every word (`'all'`) or
   * any word (`'any'`, the default); `prefix` matches a stored word that begins with a query word.
   */
  lexicalSearch?(
    collectionName: string,
    queryText: string,
    options?: QueryOptions & { match?: 'all' | 'any'; prefix?: boolean },
  ): Promise<QueryResult>;

  /**
   * Optional: one search over the items of one of the caller's groups, on the store's lexical index, with no
   * embedding. An item is a source: the passages whose `sourceId` metadata key is its id. It matches when every word
   * matches in at least one of its passages, the same passage or different ones, and the answer counts the distinct
   * items that match, ranks them by field and kind of match, pages them by a key, and gives each item's best passage.
   * The store reads the metadata keys `sourceId`, `field`, `partKind`, `title` and `index`, and reads no passage that
   * `filter` and the group's items do not admit: not for a match, a count, a rank or a stored word to widen to.
   */
  lexicalGroupSearch?(
    collectionName: string,
    options: LexicalGroupSearchOptions,
  ): Promise<LexicalGroupSearchResult>;

  /**
   * Optional: change the metadata of every document a filter matches. A key whose value is `null` is removed; the
   * other keys replace the stored ones. The filter must hold at least one condition.
   */
  updateMetadata?(
    collectionName: string,
    filter: MetadataFilter,
    patch: Record<string, MetadataValue | null>,
  ): Promise<{ updatedCount: number }>;

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
