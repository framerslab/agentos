/**
 * @file HnswlibVectorStore.ts
 * @description HNSW-based vector store using hnswlib-node for fast approximate nearest neighbor search.
 * Provides O(log n) query performance vs O(n) linear scan, with file-based persistence.
 *
 * @deprecated Use SqlVectorStore instead — it now includes automatic HNSW acceleration
 * via the HnswIndexSidecar from rag/vector-search/. SqlVectorStore provides the same
 * HNSW performance plus SQLite persistence, hybrid search (BM25 + vector), metadata
 * queries, and ACID transactions. Configure with `type: 'sql'` and the HNSW sidecar
 * activates automatically when document count crosses the threshold (default 1000).
 *
 * @module AgentOS/RAG/VectorStores
 * @version 1.0.0
 */

import { v4 as uuidv4 } from 'uuid';
import type {
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
  MetadataFieldCondition,
  MetadataScalarValue,
  MetadataValue,
} from '../IVectorStore.js';
import { GMIError, GMIErrorCode } from '../../../core/utils/errors.js';

/**
 * Configuration for HnswlibVectorStore
 */
export interface HnswlibVectorStoreConfig extends VectorStoreProviderConfig {
  type: 'hnswlib';
  /** Directory to persist index files. If not set, indexes are in-memory only. */
  persistDirectory?: string;
  /** Default embedding dimension for new collections */
  defaultEmbeddingDimension?: number;
  /** Default similarity metric */
  similarityMetric?: 'cosine' | 'euclidean' | 'dotproduct';
  /** HNSW M parameter (number of connections per node, default 16) */
  hnswM?: number;
  /** HNSW efConstruction parameter (index build quality, default 200) */
  hnswEfConstruction?: number;
  /** HNSW efSearch parameter (search quality, default 100) */
  hnswEfSearch?: number;
}

interface HnswCollection {
  name: string;
  dimension: number;
  similarityMetric: 'cosine' | 'euclidean' | 'dotproduct';
  index: any; // HierarchicalNSW instance
  /** Maps internal HNSW label (number) → document ID (string) */
  labelToId: Map<number, string>;
  /** Maps document ID (string) → internal HNSW label (number) */
  idToLabel: Map<string, number>;
  /** Stores metadata and text content per document */
  metadata: Map<string, { metadata?: Record<string, MetadataValue>; textContent?: string }>;
  nextLabel: number;
  maxElements: number;
}

type PersistedCollectionEntry = {
  name: string;
  fileBase: string;
  dimension: number;
  similarityMetric: 'cosine' | 'euclidean' | 'dotproduct';
};

type PersistedManifestV1 = {
  version: 1;
  collections: PersistedCollectionEntry[];
};

type PersistedCollectionMetaV1 = {
  version: 1;
  name: string;
  dimension: number;
  similarityMetric: 'cosine' | 'euclidean' | 'dotproduct';
  nextLabel: number;
  maxElements: number;
  labelToId: Array<[number, string]>;
  metadata: Array<
    [string, { metadata?: Record<string, MetadataValue>; textContent?: string }]
  >;
};

/**
 * Vector store implementation using hnswlib-node for fast ANN search.
 *
 * Features:
 * - O(log n) query time via HNSW graph structure
 * - 1-10ms queries for 100K vectors
 * - File-based persistence
 * - Configurable HNSW parameters (M, efConstruction, efSearch)
 * - Full metadata filtering support
 */
export class HnswlibVectorStore implements IVectorStore {
  private config!: HnswlibVectorStoreConfig;
  private collections: Map<string, HnswCollection> = new Map();
  private isInitialized: boolean = false;
  private readonly providerId: string = `hnswlib-${uuidv4().slice(0, 8)}`;
  private HierarchicalNSW: any; // Lazy-loaded hnswlib-node class

  private hnswM: number = 16;
  private hnswEfConstruction: number = 200;
  private hnswEfSearch: number = 100;
  private defaultDimension: number = 1536;
  private defaultMetric: 'cosine' | 'euclidean' | 'dotproduct' = 'cosine';

  // Optional file-based persistence (best-effort).
  private persistDirectory?: string;
  private persistManifestPath?: string;
  private persisted: Map<string, PersistedCollectionEntry> = new Map();
  private dirtyCollections: Set<string> = new Set();
  private flushTimer: any = null;
  private nodeFs?: typeof import('node:fs/promises');
  private nodePath?: typeof import('node:path');

  async initialize(config: VectorStoreProviderConfig): Promise<void> {
    console.warn(
      '[DEPRECATED] HnswlibVectorStore is deprecated. Use SqlVectorStore instead — ' +
      'it now includes automatic HNSW acceleration via sidecar index. ' +
      'See rag/vector-search/HnswIndexSidecar for details.',
    );
    if (this.isInitialized) {
      console.warn(`[HnswlibVectorStore:${this.providerId}] Re-initializing.`);
      this.collections.clear();
      this.dirtyCollections.clear();
      if (this.flushTimer) {
        try {
          clearTimeout(this.flushTimer);
        } catch {
          // Ignore.
        }
        this.flushTimer = null;
      }
    }

    this.config = config as HnswlibVectorStoreConfig;

    // Load hnswlib-node dynamically (optional peer dependency)
    try {
      const hnswlib = await import('hnswlib-node');
      this.HierarchicalNSW = hnswlib.HierarchicalNSW;
    } catch (error) {
      throw new GMIError(
        'hnswlib-node is required for HnswlibVectorStore. Install it: npm install hnswlib-node',
        GMIErrorCode.MISSING_DEPENDENCY,
        { package: 'hnswlib-node' },
        'HnswlibVectorStore',
      );
    }

    this.hnswM = this.config.hnswM ?? 16;
    this.hnswEfConstruction = this.config.hnswEfConstruction ?? 200;
    this.hnswEfSearch = this.config.hnswEfSearch ?? 100;
    this.defaultDimension = this.config.defaultEmbeddingDimension ?? 1536;
    this.defaultMetric = this.config.similarityMetric ?? 'cosine';

    this.persistDirectory = this.config.persistDirectory?.trim() || undefined;
    if (this.persistDirectory) {
      await this.ensurePersistenceReady();
    } else {
      this.persistManifestPath = undefined;
      this.persisted.clear();
    }

    this.isInitialized = true;
  }

  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new GMIError(
        'HnswlibVectorStore is not initialized. Call initialize() first.',
        GMIErrorCode.NOT_INITIALIZED,
        undefined,
        'HnswlibVectorStore',
      );
    }
  }

  private async getFs(): Promise<typeof import('node:fs/promises')> {
    if (this.nodeFs) return this.nodeFs;
    this.nodeFs = await import('node:fs/promises');
    return this.nodeFs;
  }

  private async getPath(): Promise<typeof import('node:path')> {
    if (this.nodePath) return this.nodePath;
    this.nodePath = await import('node:path');
    return this.nodePath;
  }

  private fnv1a32(text: string): string {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  private deriveFileBase(collectionName: string): string {
    const encoded = encodeURIComponent(collectionName).replace(/%/g, '_');
    if (encoded.length <= 120) return encoded;
    return `${encoded.slice(0, 80)}_${this.fnv1a32(collectionName)}`;
  }

  private isMetric(value: unknown): value is 'cosine' | 'euclidean' | 'dotproduct' {
    return value === 'cosine' || value === 'euclidean' || value === 'dotproduct';
  }

  private async ensurePersistenceReady(): Promise<void> {
    if (!this.persistDirectory) return;

    const fs = await this.getFs();
    const path = await this.getPath();

    await fs.mkdir(this.persistDirectory, { recursive: true });
    this.persistManifestPath = path.join(this.persistDirectory, 'hnswlib.manifest.json');

    this.persisted.clear();

    try {
      const raw = await fs.readFile(this.persistManifestPath, 'utf8');
      const parsed = JSON.parse(raw) as PersistedManifestV1;
      if (parsed?.version !== 1 || !Array.isArray(parsed.collections)) return;

      for (const entry of parsed.collections) {
        const name = typeof entry?.name === 'string' ? entry.name : '';
        const fileBase = typeof entry?.fileBase === 'string' ? entry.fileBase : '';
        const dimension = typeof entry?.dimension === 'number' ? entry.dimension : 0;
        const similarityMetric = entry?.similarityMetric;
        if (!name || !fileBase) continue;
        if (!Number.isFinite(dimension) || dimension <= 0) continue;
        if (!this.isMetric(similarityMetric)) continue;

        this.persisted.set(name, { name, fileBase, dimension, similarityMetric });
      }
    } catch {
      // Ignore; persistence is best-effort.
    }
  }

  private async writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
    const fs = await this.getFs();
    const path = await this.getPath();
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    try {
      await fs.rename(tmpPath, filePath);
    } catch {
      try {
        await fs.rm(filePath, { force: true });
      } catch {
        // Ignore.
      }
      await fs.rename(tmpPath, filePath);
    }
  }

  private async persistManifest(): Promise<void> {
    if (!this.persistDirectory || !this.persistManifestPath) return;
    const manifest: PersistedManifestV1 = {
      version: 1,
      collections: Array.from(this.persisted.values()).sort((a, b) => a.name.localeCompare(b.name)),
    };
    await this.writeJsonAtomic(this.persistManifestPath, manifest);
  }

  private async getPersistPaths(entry: PersistedCollectionEntry): Promise<{ indexPath: string; metaPath: string }> {
    if (!this.persistDirectory) {
      throw new GMIError(
        'Persistence is not enabled for this HnswlibVectorStore.',
        GMIErrorCode.VALIDATION_ERROR,
        undefined,
        'HnswlibVectorStore',
      );
    }
    const path = await this.getPath();
    return {
      indexPath: path.join(this.persistDirectory, `${entry.fileBase}.hnsw`),
      metaPath: path.join(this.persistDirectory, `${entry.fileBase}.meta.json`),
    };
  }

  private markDirty(collectionName: string): void {
    if (!this.persistDirectory) return;
    this.dirtyCollections.add(collectionName);
    if (this.flushTimer) return;

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushPersistence();
    }, 2000);
  }

  private async flushPersistence(): Promise<void> {
    if (!this.persistDirectory) return;

    const toFlush = Array.from(this.dirtyCollections);
    this.dirtyCollections.clear();

    for (const collectionName of toFlush) {
      const collection = this.collections.get(collectionName);
      if (!collection) continue;
      try {
        await this.persistCollection(collection);
      } catch {
        // Ignore; persistence is best-effort.
      }
    }

    try {
      await this.persistManifest();
    } catch {
      // Ignore.
    }
  }

  private async persistCollection(collection: HnswCollection): Promise<void> {
    if (!this.persistDirectory) return;

    let entry = this.persisted.get(collection.name);
    if (!entry) {
      entry = {
        name: collection.name,
        fileBase: this.deriveFileBase(collection.name),
        dimension: collection.dimension,
        similarityMetric: collection.similarityMetric,
      };
      this.persisted.set(collection.name, entry);
    }

    const fs = await this.getFs();
    const { indexPath, metaPath } = await this.getPersistPaths(entry);

    const tmpIndexPath = `${indexPath}.tmp`;
    try {
      await collection.index.writeIndex(tmpIndexPath);
      try {
        await fs.rename(tmpIndexPath, indexPath);
      } catch {
        try {
          await fs.rm(indexPath, { force: true });
        } catch {
          // Ignore.
        }
        await fs.rename(tmpIndexPath, indexPath);
      }
    } catch {
      try {
        await fs.rm(tmpIndexPath, { force: true });
      } catch {
        // Ignore.
      }
    }

    const meta: PersistedCollectionMetaV1 = {
      version: 1,
      name: collection.name,
      dimension: collection.dimension,
      similarityMetric: collection.similarityMetric,
      nextLabel: collection.nextLabel,
      maxElements: collection.maxElements,
      labelToId: Array.from(collection.labelToId.entries()),
      metadata: Array.from(collection.metadata.entries()).map(([id, doc]) => [
        id,
        { metadata: doc.metadata, textContent: doc.textContent },
      ]),
    };
    await this.writeJsonAtomic(metaPath, meta);
  }

  private async loadPersistedCollection(entry: PersistedCollectionEntry): Promise<HnswCollection> {
    if (!this.persistDirectory) {
      throw new GMIError(
        'Persistence is not enabled for this HnswlibVectorStore.',
        GMIErrorCode.VALIDATION_ERROR,
        undefined,
        'HnswlibVectorStore',
      );
    }

    const fs = await this.getFs();
    const { indexPath, metaPath } = await this.getPersistPaths(entry);

    const raw = await fs.readFile(metaPath, 'utf8');
    const parsed = JSON.parse(raw) as PersistedCollectionMetaV1;
    if (parsed?.version !== 1) {
      throw new Error(`Unsupported metadata version for collection '${entry.name}'.`);
    }

    const metric = this.isMetric(parsed.similarityMetric) ? parsed.similarityMetric : entry.similarityMetric;
    const spaceType = this.getSpaceType(metric);

    const index = new this.HierarchicalNSW(spaceType, entry.dimension);
    await index.readIndex(indexPath);
    index.setEf(this.hnswEfSearch);

    const labelToId = new Map<number, string>(
      Array.isArray(parsed.labelToId) ? parsed.labelToId : [],
    );
    const idToLabel = new Map<string, number>();
    for (const [label, id] of labelToId.entries()) {
      idToLabel.set(id, label);
    }

    const metadata = new Map<string, { metadata?: Record<string, MetadataValue>; textContent?: string }>();
    if (Array.isArray(parsed.metadata)) {
      for (const [id, doc] of parsed.metadata) {
        if (!id) continue;
        metadata.set(id, { metadata: doc?.metadata, textContent: doc?.textContent });
      }
    }

    const nextLabel = Number.isFinite(parsed.nextLabel) ? parsed.nextLabel : Math.max(0, ...labelToId.keys()) + 1;
    const maxElements = Number.isFinite(parsed.maxElements) ? parsed.maxElements : Math.max(10_000, nextLabel);

    return {
      name: entry.name,
      dimension: entry.dimension,
      similarityMetric: metric,
      index,
      labelToId,
      idToLabel,
      metadata,
      nextLabel,
      maxElements,
    };
  }

  private async getExistingCollection(collectionName: string): Promise<HnswCollection | null> {
    const loaded = this.collections.get(collectionName);
    if (loaded) return loaded;

    const entry = this.persisted.get(collectionName);
    if (!entry) return null;

    try {
      const collection = await this.loadPersistedCollection(entry);
      this.collections.set(collectionName, collection);
      return collection;
    } catch (error) {
      console.warn(
        `[HnswlibVectorStore:${this.providerId}] Failed to load persisted collection '${collectionName}':`,
        error,
      );
      return null;
    }
  }

  /**
   * Map similarity metric to hnswlib space type.
   * hnswlib supports: 'l2' (euclidean), 'ip' (inner product/dot), 'cosine'
   */
  private getSpaceType(metric: 'cosine' | 'euclidean' | 'dotproduct'): string {
    switch (metric) {
      case 'cosine': return 'cosine';
      case 'euclidean': return 'l2';
      case 'dotproduct': return 'ip';
      default: return 'cosine';
    }
  }

  async createCollection(
    collectionName: string,
    dimension: number,
    options?: CreateCollectionOptions,
  ): Promise<void> {
    this.ensureInitialized();

    if (dimension <= 0) {
      throw new GMIError(
        `Invalid dimension ${dimension}. Must be > 0.`,
        GMIErrorCode.VALIDATION_ERROR,
        { dimension },
        'HnswlibVectorStore',
      );
    }

    const exists = this.collections.has(collectionName) || this.persisted.has(collectionName);
    if (exists && !options?.overwriteIfExists) {
      throw new GMIError(
        `Collection '${collectionName}' already exists.`,
        GMIErrorCode.ALREADY_EXISTS,
        { collectionName },
        'HnswlibVectorStore',
      );
    }

    if (exists && options?.overwriteIfExists) {
      await this.deleteCollection(collectionName);
    }

    const metric = options?.providerSpecificParams?.similarityMetric as
      | 'cosine' | 'euclidean' | 'dotproduct'
      | undefined
      ?? this.defaultMetric;

    const spaceType = this.getSpaceType(metric);
    const initialMaxElements = 10000; // Will resize dynamically

    const index = new this.HierarchicalNSW(spaceType, dimension);
    index.initIndex(initialMaxElements, this.hnswM, this.hnswEfConstruction);
    index.setEf(this.hnswEfSearch);

    this.collections.set(collectionName, {
      name: collectionName,
      dimension,
      similarityMetric: metric,
      index,
      labelToId: new Map(),
      idToLabel: new Map(),
      metadata: new Map(),
      nextLabel: 0,
      maxElements: initialMaxElements,
    });

    if (this.persistDirectory) {
      if (!this.persisted.has(collectionName)) {
        this.persisted.set(collectionName, {
          name: collectionName,
          fileBase: this.deriveFileBase(collectionName),
          dimension,
          similarityMetric: metric,
        });
        try {
          await this.persistManifest();
        } catch {
          // Ignore; persistence is best-effort.
        }
      }
    }
  }

  async deleteCollection(collectionName: string): Promise<void> {
    this.ensureInitialized();
    this.collections.delete(collectionName);

    if (this.persistDirectory) {
      const entry = this.persisted.get(collectionName);
      if (entry) {
        try {
          const fs = await this.getFs();
          const { indexPath, metaPath } = await this.getPersistPaths(entry);
          await fs.rm(indexPath, { force: true });
          await fs.rm(metaPath, { force: true });
        } catch {
          // Ignore; best-effort.
        }
        this.persisted.delete(collectionName);
        this.dirtyCollections.delete(collectionName);
        try {
          await this.persistManifest();
        } catch {
          // Ignore.
        }
      }
    }
  }

  async collectionExists(collectionName: string): Promise<boolean> {
    this.ensureInitialized();
    return this.collections.has(collectionName) || this.persisted.has(collectionName);
  }

  private async ensureCollection(collectionName: string, dimension?: number): Promise<HnswCollection> {
    const existing = await this.getExistingCollection(collectionName);
    if (existing) return existing;

    const dim = dimension ?? this.defaultDimension;
    await this.createCollection(collectionName, dim);
    return this.collections.get(collectionName)!;
  }

  private resizeIfNeeded(collection: HnswCollection): void {
    if (collection.nextLabel >= collection.maxElements - 1) {
      const newMax = collection.maxElements * 2;
      collection.index.resizeIndex(newMax);
      collection.maxElements = newMax;
    }
  }

  async upsert(
    collectionName: string,
    documents: VectorDocument[],
    options?: UpsertOptions,
  ): Promise<UpsertResult> {
    this.ensureInitialized();

    const dimension = documents[0]?.embedding?.length;
    const collection = await this.ensureCollection(collectionName, dimension);

    const errors: Array<{ id: string; message: string; details?: any }> = [];
    const upsertedIds: string[] = [];

    for (const doc of documents) {
      try {
        if (doc.embedding.length !== collection.dimension) {
          errors.push({
            id: doc.id,
            message: `Embedding dimension ${doc.embedding.length} does not match collection dimension ${collection.dimension}.`,
            details: { expected: collection.dimension, got: doc.embedding.length },
          });
          continue;
        }

        // Check if document already exists
        const existingLabel = collection.idToLabel.get(doc.id);

        if (existingLabel !== undefined) {
          // Update: hnswlib doesn't support in-place update, so we mark old and add new
          // We reuse the same label to avoid wasting space
          collection.index.addPoint(doc.embedding, existingLabel);
          collection.metadata.set(doc.id, {
            metadata: doc.metadata,
            textContent: doc.textContent,
          });
        } else {
          // Insert new
          this.resizeIfNeeded(collection);
          const label = collection.nextLabel++;
          collection.index.addPoint(doc.embedding, label);
          collection.labelToId.set(label, doc.id);
          collection.idToLabel.set(doc.id, label);
          collection.metadata.set(doc.id, {
            metadata: doc.metadata,
            textContent: doc.textContent,
          });
        }

        upsertedIds.push(doc.id);
      } catch (error) {
        errors.push({
          id: doc.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (upsertedIds.length > 0) {
      this.markDirty(collectionName);
    }

    return {
      upsertedCount: upsertedIds.length,
      upsertedIds,
      failedCount: errors.length,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  async query(
    collectionName: string,
    queryEmbedding: number[],
    options?: QueryOptions,
  ): Promise<QueryResult> {
    this.ensureInitialized();

    const collection = await this.getExistingCollection(collectionName);
    if (!collection) {
      return {
        documents: [],
        queryId: `hnsw-query-${uuidv4()}`,
        stats: { totalCandidates: 0, filteredCandidates: 0, returnedCount: 0 },
      };
    }

    if (queryEmbedding.length !== collection.dimension) {
      throw new GMIError(
        `Query embedding dimension ${queryEmbedding.length} does not match collection dimension ${collection.dimension}.`,
        GMIErrorCode.VALIDATION_ERROR,
        { expected: collection.dimension, got: queryEmbedding.length },
        'HnswlibVectorStore',
      );
    }

    const currentCount = collection.idToLabel.size;
    if (currentCount === 0) {
      return {
        documents: [],
        queryId: `hnsw-query-${uuidv4()}`,
        stats: { totalCandidates: 0, filteredCandidates: 0, returnedCount: 0 },
      };
    }

    // Request more candidates than topK to allow for metadata filtering
    const topK = options?.topK ?? 10;
    const searchK = Math.min(currentCount, topK * 3); // Over-fetch for filtering

    // Perform HNSW search
    const result = collection.index.searchKnn(queryEmbedding, searchK);
    const { neighbors, distances } = result;

    // Process results
    const candidates: RetrievedVectorDocument[] = [];

    for (let i = 0; i < neighbors.length; i++) {
      const label = neighbors[i];
      const distance = distances[i];
      const docId = collection.labelToId.get(label);

      if (!docId) continue;

      const docData = collection.metadata.get(docId);
      if (!docData) continue;

      // Convert distance to similarity score
      let similarityScore: number;
      switch (collection.similarityMetric) {
        case 'cosine':
          // hnswlib cosine returns 1 - cosine_similarity
          similarityScore = 1 - distance;
          break;
        case 'euclidean':
          // Negate distance for "higher is better"
          similarityScore = -distance;
          break;
        case 'dotproduct':
          // hnswlib ip returns negative inner product
          similarityScore = -distance;
          break;
        default:
          similarityScore = 1 - distance;
      }

      // Apply minimum similarity threshold
      if (options?.minSimilarityScore !== undefined && similarityScore < options.minSimilarityScore) {
        continue;
      }

      // Apply metadata filter
      if (options?.filter && !this.matchesFilter(docData.metadata, options.filter)) {
        continue;
      }

      const embedding = options?.includeEmbedding ? collection.index.getPoint(label) : [];
      const retrievedDoc: RetrievedVectorDocument = {
        id: docId,
        embedding: Array.isArray(embedding) ? embedding : [],
        similarityScore,
      };

      if (options?.includeMetadata !== false && docData.metadata) {
        retrievedDoc.metadata = docData.metadata;
      }

      if (options?.includeTextContent && docData.textContent) {
        retrievedDoc.textContent = docData.textContent;
      }

      candidates.push(retrievedDoc);
    }

    // Sort by similarity (descending) and take topK
    candidates.sort((a, b) => b.similarityScore - a.similarityScore);
    const results = candidates.slice(0, topK);

    return {
      documents: results,
      queryId: `hnsw-query-${uuidv4()}`,
      stats: {
        totalCandidates: currentCount,
        filteredCandidates: candidates.length,
        returnedCount: results.length,
      },
    };
  }

  async scanByMetadata(
    collectionName: string,
    options?: MetadataScanOptions,
  ): Promise<MetadataScanResult> {
    this.ensureInitialized();

    const collection = await this.getExistingCollection(collectionName);
    if (!collection) {
      return {
        documents: [],
        stats: { totalCandidates: 0, returnedCount: 0 },
      };
    }

    const limit = Math.max(1, options?.limit ?? 100);
    const documents: RetrievedVectorDocument[] = [];

    for (const [docId, docData] of collection.metadata) {
      if (options?.filter && !this.matchesFilter(docData.metadata, options.filter)) {
        continue;
      }

      const label = collection.idToLabel.get(docId);
      const embedding = options?.includeEmbedding && label !== undefined
        ? collection.index.getPoint(label)
        : [];

      const scannedDoc: RetrievedVectorDocument = {
        id: docId,
        embedding: Array.isArray(embedding) ? embedding : [],
        similarityScore: 1,
      };

      if (options?.includeMetadata !== false && docData.metadata) {
        scannedDoc.metadata = docData.metadata;
      }
      if (options?.includeTextContent && docData.textContent) {
        scannedDoc.textContent = docData.textContent;
      }

      documents.push(scannedDoc);
      if (documents.length >= limit) break;
    }

    return {
      documents,
      stats: {
        totalCandidates: collection.metadata.size,
        returnedCount: documents.length,
      },
    };
  }

  async delete(
    collectionName: string,
    ids?: string[],
    options?: DeleteOptions,
  ): Promise<DeleteResult> {
    this.ensureInitialized();

    const collection = await this.getExistingCollection(collectionName);
    if (!collection) {
      return { deletedCount: 0 };
    }

    if (options?.deleteAll) {
      const count = collection.idToLabel.size;
      // Rebuild empty index
      const spaceType = this.getSpaceType(collection.similarityMetric);
      const newIndex = new this.HierarchicalNSW(spaceType, collection.dimension);
      newIndex.initIndex(10000, this.hnswM, this.hnswEfConstruction);
      newIndex.setEf(this.hnswEfSearch);

      collection.index = newIndex;
      collection.labelToId.clear();
      collection.idToLabel.clear();
      collection.metadata.clear();
      collection.nextLabel = 0;
      collection.maxElements = 10000;

      this.markDirty(collectionName);
      return { deletedCount: count };
    }

    let deletedCount = 0;

    if (ids && ids.length > 0) {
      for (const id of ids) {
        const label = collection.idToLabel.get(id);
        if (label !== undefined) {
          try {
            collection.index.markDelete(label);
          } catch {
            // Some versions may not support markDelete
          }
          collection.labelToId.delete(label);
          collection.idToLabel.delete(id);
          collection.metadata.delete(id);
          deletedCount++;
        }
      }
    }

    if (options?.filter) {
      const toDelete: string[] = [];
      for (const [docId, docData] of collection.metadata) {
        if (this.matchesFilter(docData.metadata, options.filter)) {
          toDelete.push(docId);
        }
      }
      for (const id of toDelete) {
        const label = collection.idToLabel.get(id);
        if (label !== undefined) {
          try {
            collection.index.markDelete(label);
          } catch {
            // Fallback: skip mark delete
          }
          collection.labelToId.delete(label);
          collection.idToLabel.delete(id);
          collection.metadata.delete(id);
          deletedCount++;
        }
      }
    }

    if (deletedCount > 0) {
      this.markDirty(collectionName);
    }
    return { deletedCount };
  }

  async checkHealth(): Promise<{ isHealthy: boolean; details?: any }> {
    return {
      isHealthy: this.isInitialized,
      details: {
        providerId: this.providerId,
        type: 'hnswlib',
        collectionCount: this.collections.size,
        collections: Array.from(this.collections.entries()).map(([name, col]) => ({
          name,
          dimension: col.dimension,
          documentCount: col.idToLabel.size,
          maxElements: col.maxElements,
          similarityMetric: col.similarityMetric,
        })),
      },
    };
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      try {
        clearTimeout(this.flushTimer);
      } catch {
        // Ignore.
      }
      this.flushTimer = null;
    }

    try {
      await this.flushPersistence();
    } catch {
      // Ignore; best-effort.
    }

    this.collections.clear();
    this.isInitialized = false;
  }

  async getStats(collectionName?: string): Promise<Record<string, any>> {
    this.ensureInitialized();

    if (collectionName) {
      const collection = await this.getExistingCollection(collectionName);
      if (!collection) {
        return { error: `Collection '${collectionName}' not found.` };
      }
      return {
        name: collectionName,
        dimension: collection.dimension,
        documentCount: collection.idToLabel.size,
        maxElements: collection.maxElements,
        similarityMetric: collection.similarityMetric,
        hnswM: this.hnswM,
        hnswEfConstruction: this.hnswEfConstruction,
        hnswEfSearch: this.hnswEfSearch,
      };
    }

    const collectionNames = new Set<string>([
      ...this.persisted.keys(),
      ...this.collections.keys(),
    ]);

    return {
      totalCollections: collectionNames.size,
      totalDocuments: Array.from(this.collections.values()).reduce(
        (sum, col) => sum + col.idToLabel.size, 0,
      ),
      collections: Array.from(this.collections.entries()).map(([name, col]) => ({
        name,
        dimension: col.dimension,
        documentCount: col.idToLabel.size,
      })),
    };
  }

  // ===========================================================================
  // Metadata Filtering (matches InMemoryVectorStore/SqlVectorStore pattern)
  // ===========================================================================

  private matchesFilter(
    metadata: Record<string, MetadataValue> | undefined,
    filter: MetadataFilter,
  ): boolean {
    if (!metadata) return false;

    for (const [key, condition] of Object.entries(filter)) {
      const value = metadata[key];

      if (typeof condition === 'string' || typeof condition === 'number' || typeof condition === 'boolean') {
        if (value !== condition) return false;
        continue;
      }

      const fieldCondition = condition as MetadataFieldCondition;

      if (fieldCondition.$eq !== undefined && value !== fieldCondition.$eq) return false;
      if (fieldCondition.$ne !== undefined && value === fieldCondition.$ne) return false;

      if (fieldCondition.$gt !== undefined) {
        if (typeof value === 'number') {
          if (typeof fieldCondition.$gt !== 'number' || value <= fieldCondition.$gt) return false;
        } else if (typeof value === 'string') {
          if (value <= String(fieldCondition.$gt)) return false;
        } else {
          return false;
        }
      }
      if (fieldCondition.$gte !== undefined) {
        if (typeof value === 'number') {
          if (typeof fieldCondition.$gte !== 'number' || value < fieldCondition.$gte) return false;
        } else if (typeof value === 'string') {
          if (value < String(fieldCondition.$gte)) return false;
        } else {
          return false;
        }
      }
      if (fieldCondition.$lt !== undefined) {
        if (typeof value === 'number') {
          if (typeof fieldCondition.$lt !== 'number' || value >= fieldCondition.$lt) return false;
        } else if (typeof value === 'string') {
          if (value >= String(fieldCondition.$lt)) return false;
        } else {
          return false;
        }
      }
      if (fieldCondition.$lte !== undefined) {
        if (typeof value === 'number') {
          if (typeof fieldCondition.$lte !== 'number' || value > fieldCondition.$lte) return false;
        } else if (typeof value === 'string') {
          if (value > String(fieldCondition.$lte)) return false;
        } else {
          return false;
        }
      }

      if (fieldCondition.$in !== undefined) {
        if (!fieldCondition.$in.includes(value as MetadataScalarValue)) return false;
      }
      if (fieldCondition.$nin !== undefined) {
        if (fieldCondition.$nin.includes(value as MetadataScalarValue)) return false;
      }

      if (fieldCondition.$exists !== undefined) {
        const exists = value !== undefined && value !== null;
        if (fieldCondition.$exists !== exists) return false;
      }

      if (fieldCondition.$contains !== undefined) {
        if (Array.isArray(value)) {
          if (!value.includes(fieldCondition.$contains)) return false;
        } else if (typeof value === 'string') {
          if (!value.includes(String(fieldCondition.$contains))) return false;
        } else {
          return false;
        }
      }

      if (fieldCondition.$all !== undefined) {
        if (!Array.isArray(value)) return false;
        for (const item of fieldCondition.$all) {
          if (!value.includes(item)) return false;
        }
      }

      if (fieldCondition.$textSearch !== undefined) {
        const searchTerm = fieldCondition.$textSearch.toLowerCase();
        if (typeof value === 'string') {
          if (!value.toLowerCase().includes(searchTerm)) return false;
        } else {
          return false;
        }
      }
    }

    return true;
  }
}
