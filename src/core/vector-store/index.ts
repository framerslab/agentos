/**
 * Core vector-store interfaces, re-usable across rag/, memory/, discovery/,
 * query-router/, agents/, and any other module that needs vector storage.
 *
 * @module @framers/agentos/core/vector-store
 */

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
  LexicalGroupItem,
  LexicalGroupKey,
  LexicalGroupRow,
  LexicalGroupSearchOptions,
  LexicalGroupSearchResult,
  LexicalMatchKind,
} from './IVectorStore.js';

export type {
  IVectorStoreManager,
  VectorStoreManagerHealthReport,
} from './IVectorStoreManager.js';
