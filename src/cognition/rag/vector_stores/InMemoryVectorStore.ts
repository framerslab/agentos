/**
 * @fileoverview Implements an in-memory vector store (`InMemoryVectorStore`)
 * that adheres to the `IVectorStore` interface. This implementation is suitable
 * for development, testing, and scenarios where data persistence across sessions
 * is not required or is handled externally (e.g., via optional file persistence).
 *
 * It supports basic vector operations like upsert, query by similarity, and delete,
 * storing documents and their embeddings directly in memory.
 *
 * Key Features:
 * - Fast operations due to in-memory storage.
 * - No external dependencies for core functionality.
 * - Optional simple file-based persistence for basic session-to-session data retention.
 * - Supports metadata filtering.
 * - Implements cosine similarity for vector searches.
 *
 * @module backend/agentos/rag/vector_stores/InMemoryVectorStore
 * @see ../../IVectorStore.ts for the interface definition.
 * @see ../../../config/VectorStoreConfiguration.ts for `InMemoryVectorStoreConfig`.
 */

import {
  IVectorStore,
  VectorStoreProviderConfig,
  VectorDocument,
  RetrievedVectorDocument,
  QueryOptions,
  QueryResult,
  MetadataScanOptions,
  MetadataScanResult,
  UpsertOptions,
  UpsertResult,
  DeleteOptions,
  DeleteResult,
  CreateCollectionOptions,
  MetadataFilter,
  MetadataValue,
  MetadataFieldCondition,
  MetadataScalarValue,
} from '../IVectorStore';
import { InMemoryVectorStoreConfig } from '../../../config/VectorStoreConfiguration';
import { GMIError } from '../../../core/utils/errors.js'; // Assuming a GMIError utility
import { uuidv4 } from '../../../core/utils/uuid';

// Node.js built-in modules for optional file persistence
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Represents a single collection within the in-memory store.
 * @internal
 */
interface InMemoryCollection {
  name: string;
  dimension: number;
  documents: Map<string, VectorDocument>; // Document ID -> VectorDocument
  similarityMetric: 'cosine' | 'euclidean' | 'dotproduct'; // Store the metric for consistency
}

/**
 * Implements the `IVectorStore` interface using in-memory data structures.
 * Provides a simple, fast vector store primarily for development and testing.
 *
 * @class InMemoryVectorStore
 * @implements {IVectorStore}
 */
export class InMemoryVectorStore implements IVectorStore {
  private config!: InMemoryVectorStoreConfig;
  private collections: Map<string, InMemoryCollection>; // collectionName -> InMemoryCollection
  private isInitialized: boolean = false;
  private readonly providerId: string;

  /**
   * Constructs an InMemoryVectorStore instance.
   * Note: The store is not ready for use until `initialize` is called.
   */
  constructor() {
    this.collections = new Map();
    this.providerId = `in-memory-store-${uuidv4()}`; // Unique ID for this instance
  }

  /**
   * @inheritdoc
   */
  public async initialize(config: VectorStoreProviderConfig): Promise<void> {
    if (this.isInitialized) {
      console.warn(
        `InMemoryVectorStore (ID: ${this.providerId}, Config ID: ${config.id}) already initialized. Re-initializing.`,
      );
      // Potentially clear state or handle re-initialization logic
      this.collections.clear();
    }

    if (config.type !== 'in_memory') {
      throw new GMIError(
        `Invalid configuration type for InMemoryVectorStore: ${config.type}. Expected 'in_memory'.`,
        'CONFIG_ERROR',
      );
    }
    this.config = config as InMemoryVectorStoreConfig;

    if (this.config.persistPath) {
      try {
        await this.loadFromFile(this.config.persistPath);
        console.log(
          `InMemoryVectorStore (ID: ${this.providerId}) loaded data from ${this.config.persistPath}`,
        );
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          console.log(
            `InMemoryVectorStore (ID: ${this.providerId}): Persistence file ${this.config.persistPath} not found. Starting with an empty store.`,
          );
        } else {
          console.warn(
            `InMemoryVectorStore (ID: ${this.providerId}): Failed to load data from ${this.config.persistPath}. Error: ${error.message}. Starting with an empty store.`,
          );
        }
      }
    }

    this.isInitialized = true;
    console.log(
      `InMemoryVectorStore (ID: ${this.providerId}, Config ID: ${this.config.id}) initialized successfully.`,
    );
  }

  /**
   * Ensures that the store has been initialized before use.
   * @private
   * @throws {GMIError} If the store is not initialized.
   */
  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new GMIError(
        `InMemoryVectorStore (ID: ${this.providerId}) is not initialized. Call initialize() first.`,
        'NOT_INITIALIZED',
      );
    }
  }

  /**
   * Retrieves a collection or throws an error if not found.
   * @private
   * @param {string} collectionName - The name of the collection.
   * @returns {InMemoryCollection} The collection object.
   * @throws {GMIError} If the collection does not exist.
   */
  private getCollection(collectionName: string): InMemoryCollection {
    this.ensureInitialized();
    const collection = this.collections.get(collectionName);
    if (!collection) {
      throw new GMIError(
        `Collection '${collectionName}' not found in InMemoryVectorStore (ID: ${this.providerId}).`,
        'NOT_FOUND',
        { collectionName },
      );
    }
    return collection;
  }

  /**
   * Creates or replaces an in-memory collection.
   */
  public async createCollection(
    collectionName: string,
    dimension: number,
    options?: CreateCollectionOptions,
  ): Promise<void> {
    this.ensureInitialized();
    if (this.collections.has(collectionName)) {
      if (options?.overwriteIfExists) {
        console.warn(
          `InMemoryVectorStore (ID: ${this.providerId}): Collection '${collectionName}' already exists and will be overwritten.`,
        );
      } else {
        throw new GMIError(
          `Collection '${collectionName}' already exists in InMemoryVectorStore (ID: ${this.providerId}).`,
          'ALREADY_EXISTS',
          { collectionName },
        );
      }
    }

    if (dimension <= 0) {
      throw new GMIError(
        `Invalid dimension for collection '${collectionName}': ${dimension}. Must be positive.`,
        'VALIDATION_ERROR',
        { dimension }
      );
    }

    this.collections.set(collectionName, {
      name: collectionName,
      dimension,
      documents: new Map(),
      similarityMetric: options?.similarityMetric || this.config.similarityMetric || 'cosine',
    });
    console.log(
      `InMemoryVectorStore (ID: ${this.providerId}): Collection '${collectionName}' created with dimension ${dimension}.`,
    );
  }

  /**
   * @inheritdoc
   */
  public async collectionExists(collectionName: string): Promise<boolean> {
    this.ensureInitialized();
    return this.collections.has(collectionName);
  }

  /**
   * @inheritdoc
   */
  public async deleteCollection(collectionName: string): Promise<void> {
    this.ensureInitialized();
    if (!this.collections.has(collectionName)) {
      console.warn(
        `InMemoryVectorStore (ID: ${this.providerId}): Attempted to delete non-existent collection '${collectionName}'.`,
      );
      return; // Or throw NOT_FOUND error, for now, be lenient.
    }
    this.collections.delete(collectionName);
    console.log(
      `InMemoryVectorStore (ID: ${this.providerId}): Collection '${collectionName}' deleted.`,
    );
  }

  /**
   * @inheritdoc
   */
  public async upsert(
    collectionName: string,
    documents: VectorDocument[],
    options?: UpsertOptions,
  ): Promise<UpsertResult> {
    const collection = this.getCollection(collectionName);
    let upsertedCount = 0;
    const upsertedIds: string[] = [];
    const errors: Array<{ id: string; message: string; details?: any }> = [];

    for (const doc of documents) {
      if (doc.embedding.length !== collection.dimension) {
        errors.push({
          id: doc.id,
          message: `Document '${doc.id}' embedding dimension ${doc.embedding.length} does not match collection '${collectionName}' dimension ${collection.dimension}.`,
        });
        continue;
      }
      if (!collection.documents.has(doc.id) || (options?.overwrite !== false)) {
        collection.documents.set(doc.id, { ...doc }); // Store a copy
        upsertedCount++;
        upsertedIds.push(doc.id);
      } else {
        // Document exists and overwrite is false
        errors.push({
          id: doc.id,
          message: `Document '${doc.id}' already exists and overwrite is disabled.`,
          details: { reason: 'NO_OVERWRITE' }
        });
      }
    }

    return {
      upsertedCount,
      upsertedIds,
      failedCount: errors.length,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  /**
   * @inheritdoc
   */
  public async query(
    collectionName: string,
    queryEmbedding: number[],
    options?: QueryOptions,
  ): Promise<QueryResult> {
    const collection = this.getCollection(collectionName);
    const topK = options?.topK ?? 10;

    if (queryEmbedding.length !== collection.dimension) {
      throw new GMIError(
        `Query embedding dimension ${queryEmbedding.length} does not match collection '${collectionName}' dimension ${collection.dimension}.`,
        'VALIDATION_ERROR',
      );
    }

    const candidates: RetrievedVectorDocument[] = [];
    for (const doc of collection.documents.values()) {
      if (options?.filter && !this.matchesFilter(doc, options.filter)) {
        continue;
      }

      let similarityScore: number;
      switch (collection.similarityMetric) {
          // Add Euclidean and Dotproduct if needed, for now, cosine is common.
          case 'cosine':
          default:
            similarityScore = this.cosineSimilarity(queryEmbedding, doc.embedding);
            break;
      }


      if (options?.minSimilarityScore && similarityScore < options.minSimilarityScore) {
        continue;
      }

      // Construct the document to return based on include options
      const retrievedDoc: Partial<RetrievedVectorDocument> = {
        id: doc.id,
        similarityScore,
      };
      if (options?.includeEmbedding) retrievedDoc.embedding = doc.embedding;
      if (options?.includeMetadata !== false && doc.metadata) retrievedDoc.metadata = doc.metadata; // Default true
      if (options?.includeTextContent && doc.textContent) retrievedDoc.textContent = doc.textContent;


      candidates.push(retrievedDoc as RetrievedVectorDocument);
    }

    // Sort by similarity score in descending order
    candidates.sort((a, b) => b.similarityScore - a.similarityScore);

    return {
      documents: candidates.slice(0, topK),
      queryId: `inmemory-query-${uuidv4()}`,
    };
  }

  public async scanByMetadata(
    collectionName: string,
    options?: MetadataScanOptions,
  ): Promise<MetadataScanResult> {
    const collection = this.getCollection(collectionName);
    const limit = Math.max(1, options?.limit ?? 100);
    const documents: RetrievedVectorDocument[] = [];

    for (const doc of collection.documents.values()) {
      if (options?.filter && !this.matchesFilter(doc, options.filter)) {
        continue;
      }

      const scannedDoc: RetrievedVectorDocument = {
        id: doc.id,
        embedding: options?.includeEmbedding ? doc.embedding : [],
        similarityScore: 1,
      };

      if (options?.includeMetadata !== false && doc.metadata) {
        scannedDoc.metadata = doc.metadata;
      }
      if (options?.includeTextContent && doc.textContent) {
        scannedDoc.textContent = doc.textContent;
      }

      documents.push(scannedDoc);
      if (documents.length >= limit) break;
    }

    return {
      documents,
      stats: { returnedCount: documents.length },
    };
  }

  /**
   * @inheritdoc
   */
  public async delete(
    collectionName: string,
    ids?: string[],
    options?: DeleteOptions,
  ): Promise<DeleteResult> {
    const collection = this.getCollection(collectionName);
    let deletedCount = 0;
    const errors: Array<{ id?: string; message: string; details?: any }> = [];

    if (options?.deleteAll && !ids && !options.filter) {
      deletedCount = collection.documents.size;
      collection.documents.clear();
      console.warn(`InMemoryVectorStore (ID: ${this.providerId}): All documents deleted from collection '${collectionName}'.`);
      return { deletedCount };
    }

    if (ids) {
      for (const id of ids) {
        if (collection.documents.delete(id)) {
          deletedCount++;
        } else {
          // Optionally log or add to minor errors if ID not found
        }
      }
    }

    if (options?.filter) {
      const filter = options.filter;
      const idsToDelete: string[] = [];
      for (const doc of collection.documents.values()) {
        if (this.matchesFilter(doc, filter)) {
          idsToDelete.push(doc.id);
        }
      }
      for (const id of idsToDelete) {
        if (collection.documents.delete(id)) {
          deletedCount++;
        }
      }
    }
    // Note: If both ids and filter are provided, current logic processes ids first, then filter on remaining.
    // Behavior might need refinement based on desired interaction between ids and filter.

    return {
      deletedCount,
      failedCount: errors.length > 0 ? errors.length : undefined,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  /**
   * @inheritdoc
   */
  public async checkHealth(): Promise<{ isHealthy: boolean; details?: any }> {
    this.ensureInitialized(); // Basic check
    return {
      isHealthy: true,
      details: {
        providerId: this.providerId,
        configId: this.config.id,
        type: 'in_memory',
        collectionCount: this.collections.size,
        totalDocuments: Array.from(this.collections.values()).reduce(
          (sum, col) => sum + col.documents.size,
          0,
        ),
        persistencePath: this.config.persistPath || 'N/A',
      },
    };
  }

  /**
   * @inheritdoc
   */
  public async shutdown(): Promise<void> {
    this.ensureInitialized();
    if (this.config.persistPath) {
      try {
        await this.saveToFile(this.config.persistPath);
        console.log(
          `InMemoryVectorStore (ID: ${this.providerId}) data persisted to ${this.config.persistPath} on shutdown.`,
        );
      } catch (error: any) {
        console.error(
          `InMemoryVectorStore (ID: ${this.providerId}): Failed to persist data to ${this.config.persistPath} on shutdown. Error: ${error.message}`,
        );
      }
    }
    this.collections.clear();
    this.isInitialized = false; // Mark as not usable until re-initialized
    console.log(`InMemoryVectorStore (ID: ${this.providerId}) shut down.`);
  }

  /**
   * @inheritdoc
   */
  public async getStats(collectionName?: string): Promise<Record<string, any>> {
    this.ensureInitialized();
    if (collectionName) {
      const collection = this.getCollection(collectionName);
      return {
        collectionName: collection.name,
        documentCount: collection.documents.size,
        dimension: collection.dimension,
        similarityMetric: collection.similarityMetric,
      };
    } else {
      // Store-wide stats
      return {
        providerId: this.providerId,
        configId: this.config.id,
        collectionCount: this.collections.size,
        totalDocuments: Array.from(this.collections.values()).reduce(
          (sum, col) => sum + col.documents.size,
          0,
        ),
      };
    }
  }

  /**
   * Calculates cosine similarity between two vectors.
   * @private
   * @param {number[]} vecA - The first vector.
   * @param {number[]} vecB - The second vector.
   * @returns {number} The cosine similarity (between -1 and 1).
   * @throws {Error} If vectors have different dimensions or are empty.
   */
  private cosineSimilarity(vecA: number[], vecB: number[]): number {
    if (vecA.length !== vecB.length) {
      throw new Error('Vectors must have the same dimensions for cosine similarity.');
    }
    if (vecA.length === 0) {
      throw new Error('Cannot compute cosine similarity for empty vectors.');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }

    const magnitudeA = Math.sqrt(normA);
    const magnitudeB = Math.sqrt(normB);

    if (magnitudeA === 0 || magnitudeB === 0) {
      // One or both vectors are zero vectors.
      // Cosine similarity is undefined or can be treated as 0 or specific value based on context.
      // For practical purposes in similarity search, if one vector is zero, similarity is minimal.
      return 0;
    }

    return dotProduct / (magnitudeA * magnitudeB);
  }

  /**
   * Checks if a document's metadata matches the provided filter.
   * @private
   * @param {VectorDocument} doc - The document to check.
   * @param {MetadataFilter} filter - The filter to apply.
   * @returns {boolean} True if the document matches, false otherwise.
   */
  private matchesFilter(doc: VectorDocument, filter: MetadataFilter): boolean {
    if (!doc.metadata) {
      // If filter requires fields that don't exist (via $exists: false), it might pass.
      // For simplicity here, if doc has no metadata, it only matches filters that assert non-existence.
      for (const key in filter) {
        const filterValue = filter[key];
        if (typeof filterValue === 'object' && filterValue !== null && (filterValue as MetadataFieldCondition).$exists === true) {
          return false; // Requires existence, but metadata is undefined
        }
         if (typeof filterValue !== 'object' || (filterValue as MetadataFieldCondition).$exists !== false) {
            // If the filter is a direct value or any other condition than $exists: false,
            // and there's no metadata, it doesn't match.
            // This simplified check: for a field to match, metadata must exist.
        }
      }
       // If all filter keys were about $exists: false for fields in an undefined metadata, it could be true.
       // This part of logic could be more nuanced. For now, let's assume if filter has positive assertions, it needs metadata.
       let allExistFalse = true;
       for (const key in filter) {
            const condition = filter[key] as MetadataFieldCondition;
            if (typeof condition !== 'object' || condition.$exists !== false) {
                allExistFalse = false;
                break;
            }
       }
       return allExistFalse; // Only matches if all filters are $exists: false
    }


    for (const key in filter) {
      const docValue = doc.metadata[key];
      const filterValueOrCondition = filter[key];

      if (typeof filterValueOrCondition === 'object' && filterValueOrCondition !== null) {
        // It's a MetadataFieldCondition
        const condition = filterValueOrCondition as MetadataFieldCondition;
        if (!this.evaluateCondition(docValue, condition)) {
          return false; // AND logic: one false condition means no match
        }
      } else {
        // It's a direct scalar match (implicit $eq)
        const filterScalarValue = filterValueOrCondition as MetadataScalarValue;
        if (Array.isArray(docValue)) {
            if (!docValue.includes(filterScalarValue)) return false; // Check if scalar is in doc array
        } else if (docValue !== filterScalarValue) {
          return false;
        }
      }
    }
    return true; // All filter conditions passed
  }

  /**
   * Evaluates a single metadata field condition.
   * @private
   */
  private evaluateCondition(docValue: MetadataValue | undefined, condition: MetadataFieldCondition): boolean {
    if (condition.$exists !== undefined) {
      return condition.$exists === (docValue !== undefined);
    }
    if (docValue === undefined) return false; // Field doesn't exist but condition isn't about existence

    if (condition.$eq !== undefined && docValue !== condition.$eq) return false;
    if (condition.$ne !== undefined && docValue === condition.$ne) return false;

    // Type checks for comparisons
    if (typeof docValue === 'number') {
        if (typeof condition.$gt === 'number' && !(docValue > condition.$gt)) return false;
        if (typeof condition.$gte === 'number' && !(docValue >= condition.$gte)) return false;
        if (typeof condition.$lt === 'number' && !(docValue < condition.$lt)) return false;
        if (typeof condition.$lte === 'number' && !(docValue <= condition.$lte)) return false;
    } else if (typeof docValue === 'string') {
        if (condition.$gt !== undefined && !(docValue > String(condition.$gt))) return false;
        if (condition.$gte !== undefined && !(docValue >= String(condition.$gte))) return false;
        if (condition.$lt !== undefined && !(docValue < String(condition.$lt))) return false;
        if (condition.$lte !== undefined && !(docValue <= String(condition.$lte))) return false;
    }


    if (condition.$in !== undefined) {
        if (!Array.isArray(condition.$in)) return false; // Malformed condition
        if (Array.isArray(docValue)) { // If docValue is an array, check if any element is in $in
            if (!docValue.some(val => (condition.$in as MetadataScalarValue[]).includes(val))) return false;
        } else { // If docValue is scalar
            if (!(condition.$in as MetadataScalarValue[]).includes(docValue as MetadataScalarValue)) return false;
        }
    }
    if (condition.$nin !== undefined) {
        if (!Array.isArray(condition.$nin)) return false; // Malformed condition
         if (Array.isArray(docValue)) { // If docValue is an array, check if all elements are not in $nin
            if (docValue.some(val => (condition.$nin as MetadataScalarValue[]).includes(val))) return false;
        } else { // If docValue is scalar
            if ((condition.$nin as MetadataScalarValue[]).includes(docValue as MetadataScalarValue)) return false;
        }
    }

    if (Array.isArray(docValue)) {
        if (condition.$contains !== undefined) {
            if (!docValue.includes(condition.$contains as MetadataScalarValue)) return false;
        }
        if (condition.$all !== undefined) {
            if (!Array.isArray(condition.$all) || !condition.$all.every(item => docValue.includes(item))) return false;
        }
    } else if (typeof docValue === 'string' && condition.$contains !== undefined && typeof condition.$contains === 'string') {
        if (!docValue.includes(condition.$contains)) return false;
    }


    if (condition.$textSearch !== undefined && typeof docValue === 'string') {
        // Simple case-insensitive substring search for $textSearch
        if (!docValue.toLowerCase().includes(condition.$textSearch.toLowerCase())) return false;
    } else if (condition.$textSearch !== undefined && typeof docValue !== 'string') {
        return false; // $textSearch only applies to string docValues
    }


    return true;
  }

  /**
   * Saves the current state of all collections to a file.
   * @private
   * @param {string} filePath - The path to the file where data will be saved.
   */
  private async saveToFile(filePath: string): Promise<void> {
    const collectionsData: Record<string, Omit<InMemoryCollection, 'documents'> & { documents: [string, VectorDocument][] }> = {};
    for (const [name, collection] of this.collections) {
      collectionsData[name] = {
        name: collection.name,
        dimension: collection.dimension,
        similarityMetric: collection.similarityMetric,
        documents: Array.from(collection.documents.entries()),
      };
    }
    const jsonData = JSON.stringify({ collections: collectionsData, config: this.config });
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, jsonData, 'utf-8');
  }

  /**
   * Loads store state from a file.
   * @private
   * @param {string} filePath - The path to the file from which data will be loaded.
   */
  private async loadFromFile(filePath: string): Promise<void> {
    const jsonData = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(jsonData);

    if (data.config) {
        // Config loaded from file might be older or different.
        // For now, let's assume current config passed to initialize() is authoritative for behavior,
        // but a persisted config could inform store structure.
        // this.config = { ...this.config, ...data.config }; // Or merge selectively
    }

    if (data.collections) {
      this.collections.clear();
      for (const name in data.collections) {
        const colData = data.collections[name];
        this.collections.set(name, {
          name: colData.name,
          dimension: colData.dimension,
          similarityMetric: colData.similarityMetric || 'cosine',
          documents: new Map(colData.documents as [string, VectorDocument][]),
        });
      }
    }
  }
}
