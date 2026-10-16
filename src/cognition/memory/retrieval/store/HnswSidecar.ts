/**
 * @fileoverview Memory-specific HNSW sidecar adapter.
 * @module memory/store/HnswSidecar
 *
 * Thin compatibility wrapper around the canonical {@link HnswIndexSidecar}
 * from `rag/vector-search/`. Preserves the Memory subsystem's constructor-based
 * API (sqlitePath, autoThreshold, etc.) and delegates to the shared implementation.
 *
 * New code should use `HnswIndexSidecar` from `rag/vector-search/` directly.
 *
 * @see rag/vector-search/HnswIndexSidecar for the canonical implementation
 */

import { createHash } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { HnswIndexSidecar } from '../../../rag/vector-search/HnswIndexSidecar.js';

// ---------------------------------------------------------------------------
// Types (kept for backward compatibility)
// ---------------------------------------------------------------------------

/** Configuration for the memory-specific HNSW sidecar wrapper. */
export interface HnswSidecarConfig {
  /** Path to brain.sqlite — the HNSW files are written in the same directory. */
  sqlitePath: string;
  /**
   * The brain whose vectors the index holds. A database can hold several
   * brains and a directory several databases, so with a brain id the index is
   * `<database file name>.<digest>.hnsw`, the digest a SHA-256 of the
   * database file name and the brain id: no two brains or databases share an
   * index file. Without one the index is `brain.hnsw`, one per directory.
   */
  brainId?: string;
  /** Embedding dimensions. */
  dimensions: number;
  /** Auto-build threshold. Below this count, brute-force is used. @default 1000 */
  autoThreshold?: number;
  /** HNSW M parameter (connections per node). @default 16 */
  m?: number;
  /** HNSW efConstruction (build quality). @default 200 */
  efConstruction?: number;
  /** HNSW efSearch (query quality). @default 50 */
  efSearch?: number;
}

/** Result from a KNN query. */
export interface HnswQueryResult {
  /** Trace ID. */
  id: string;
  /** Distance from query vector (lower = closer for cosine distance). */
  distance: number;
}

/**
 * The index file for `config`: per database file and brain when the config
 * names a brain, `brain.hnsw` in the database's directory otherwise.
 *
 * The digest keeps brain ids of any spelling apart, including ones that differ
 * only in case on a file system that ignores case, or that hold a path
 * separator; the database file name is repeated in front, with characters
 * outside `[A-Za-z0-9._-]` replaced, so a reader can tell which file an index
 * belongs to.
 */
function hnswIndexPath(config: Pick<HnswSidecarConfig, 'sqlitePath' | 'brainId'>): string {
  const directory = dirname(config.sqlitePath);
  if (config.brainId === undefined) return join(directory, 'brain.hnsw');
  const databaseFile = basename(config.sqlitePath);
  const digest = createHash('sha256')
    .update(`${databaseFile}\u0000${config.brainId}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return join(directory, `${databaseFile.replace(/[^A-Za-z0-9._-]/g, '_')}.${digest}.hnsw`);
}

// ---------------------------------------------------------------------------
// HnswSidecar — thin adapter over HnswIndexSidecar
// ---------------------------------------------------------------------------

/**
 * Memory-specific HNSW sidecar that wraps the canonical {@link HnswIndexSidecar}.
 *
 * Maintains the original constructor-based API expected by `Memory` facade
 * and `Brain` consumers, while delegating all index operations to the
 * shared RAG implementation.
 */
export class HnswSidecar {
  private readonly _delegate: HnswIndexSidecar;
  private readonly _indexPath: string;
  private readonly _mapPath: string;
  private readonly _config: Required<Omit<HnswSidecarConfig, 'brainId'>>;

  constructor(config: HnswSidecarConfig) {
    this._config = {
      autoThreshold: 1000,
      m: 16,
      efConstruction: 200,
      efSearch: 50,
      ...config,
    };
    this._indexPath = hnswIndexPath(config);
    this._mapPath = this._indexPath + '.map.json';
    this._delegate = new HnswIndexSidecar();
  }

  /** Whether the HNSW index is currently active and queryable. */
  get isActive(): boolean {
    return this._delegate.isActive();
  }

  /** Number of vectors currently indexed. */
  get size(): number {
    return this._delegate.getStats().vectorCount;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Initialize the sidecar. Loads existing index from disk if present.
   * If hnswlib-node is not installed, silently stays inactive.
   */
  async init(): Promise<void> {
    await this._delegate.initialize({
      indexPath: this._indexPath,
      dimensions: this._config.dimensions,
      metric: 'cosine',
      activationThreshold: this._config.autoThreshold,
      hnswM: this._config.m,
      hnswEfConstruction: this._config.efConstruction,
      hnswEfSearch: this._config.efSearch,
    });
  }

  /**
   * Add a vector to the index. If below threshold, does nothing.
   * If threshold is crossed, caller should call rebuildFromData().
   *
   * @param traceId    - The trace ID to associate with this vector.
   * @param embedding  - The embedding vector.
   * @param _totalCount - Current total trace count (unused, kept for API compat).
   */
  async add(traceId: string, embedding: number[], _totalCount: number): Promise<void> {
    await this._delegate.add(traceId, embedding);
  }

  /**
   * Query the HNSW index for top-K nearest neighbors.
   * Returns trace IDs sorted by distance (closest first).
   *
   * @param embedding - Query vector.
   * @param topK      - Number of results to return.
   * @returns Array of { id, distance } sorted by distance ascending.
   */
  query(embedding: number[], topK: number): HnswQueryResult[] {
    /* Synchronous wrapper — HnswIndexSidecar.search() is async but the
       underlying hnswlib-node searchKnn is synchronous, so we call it
       via a blocking pattern for backward compatibility. We convert the
       score-based results back to distance-based results. */

    // We need synchronous access, but the delegate is async. Since the
    // underlying hnswlib-node operations are synchronous, we access
    // the delegate's internal state directly for search. To maintain
    // the sync API, we perform the search synchronously by calling
    // the delegate's search and using a workaround.
    // Instead, we return empty if not active and do a direct sync call.
    if (!this._delegate.isActive()) return [];

    // Use a sync approach: we know the delegate wraps hnswlib-node which
    // is synchronous under the hood. We'll collect results asynchronously
    // but since this is called from sync code, we need a different approach.
    // The simplest backward-compatible fix is to cache results. However,
    // looking at usage in Memory.ts, query() is always called within an
    // async context. We'll return via a promise-like pattern.

    // Actually, re-examining: the delegate's search() returns a Promise,
    // but the original HnswSidecar.query() was synchronous. The underlying
    // hnswlib-node searchKnn IS synchronous. The delegate just wraps it
    // in async. We need to keep this sync for backward compatibility.
    // Solution: access the delegate's internal index directly since both
    // implementations use the same hnswlib-node API.
    const stats = this._delegate.getStats();
    if (stats.vectorCount === 0) return [];

    // For backward compat, perform the search via the async delegate
    // and return a placeholder. But this breaks the sync contract.
    // Better solution: keep the original sync search logic here.
    return this._syncQuery(embedding, topK);
  }

  /**
   * Remove a trace from the index by marking its label as deleted.
   * HNSW doesn't support true deletion — cleaned up on rebuild.
   *
   * @param traceId - The trace ID to remove.
   */
  remove(traceId: string): void {
    // Fire-and-forget since original was sync
    void this._delegate.remove(traceId);
  }

  /**
   * Rebuild the entire index from a set of id/embedding pairs.
   * Called on first threshold crossing or when the index file is missing/corrupt.
   * Filters out dimension-mismatched vectors before delegating.
   *
   * @param data - Array of { id, embedding } to index.
   */
  async rebuildFromData(data: { id: string; embedding: number[] }[]): Promise<void> {
    if (data.length === 0) return;
    // Filter out dimension-mismatched vectors (feature from original impl)
    const dim = this._config.dimensions;
    const filtered = data.filter(item => item.embedding.length === dim);
    await this._delegate.rebuildFromData(filtered);
  }

  /**
   * Persist index and label map to disk.
   * Called after rebuildFromData() and periodically after adds.
   */
  saveToDisk(): void {
    void this._delegate.save();
  }

  /**
   * Delete index files from disk and deactivate.
   */
  destroy(): void {
    void this._delegate.shutdown();
    try {
      if (existsSync(this._indexPath)) unlinkSync(this._indexPath);
      if (existsSync(this._mapPath)) unlinkSync(this._mapPath);
    } catch {
      // Best effort cleanup
    }
  }

  // ---------------------------------------------------------------------------
  // Internal — sync query for backward compatibility
  // ---------------------------------------------------------------------------

  /**
   * Synchronous query that accesses the delegate's internal index.
   * This is needed because the original HnswSidecar.query() was synchronous,
   * and Memory.ts calls it in a synchronous context within an async function.
   */
  private _syncQuery(embedding: number[], topK: number): HnswQueryResult[] {
    // Access the delegate's internals for sync search. The delegate stores
    // its state in private fields; we use a type assertion to reach them.
    const delegate = this._delegate as any;
    const index = delegate.index;
    const labelToId: Map<number, string> = delegate.labelToId;

    if (!index || labelToId.size === 0) return [];

    const k = Math.min(topK, labelToId.size);
    try {
      const result = index.searchKnn(embedding, k);
      const hits: HnswQueryResult[] = [];

      for (let i = 0; i < result.neighbors.length; i++) {
        const label = result.neighbors[i];
        const id = labelToId.get(label);
        if (id) {
          hits.push({ id, distance: result.distances[i] });
        }
      }

      return hits;
    } catch {
      return [];
    }
  }
}
