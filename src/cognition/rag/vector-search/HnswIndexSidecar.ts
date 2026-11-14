/**
 * @fileoverview Shared HNSW index sidecar that sits alongside a SQLite database.
 * Provides O(log n) approximate nearest neighbor search via hnswlib-node,
 * with automatic activation at a configurable document count threshold
 * and graceful fallback when the native addon is unavailable.
 *
 * Used by both the RAG system (SqlVectorStore) and the Memory system (Brain).
 *
 * @module agentos/rag/vector-search/HnswIndexSidecar
 */

import * as fs from 'fs/promises';
import type {
  HnswSidecarConfig,
  HnswSidecarStats,
  HnswSearchResult,
} from './types';

/** Default HNSW parameters matching the literature recommendations. */
const DEFAULTS = {
  activationThreshold: 1000,
  hnswM: 16,
  hnswEfConstruction: 200,
  hnswEfSearch: 50,
  capacityIncrement: 1000,
} as const;

/** hnswlib-node space type mapping. */
const METRIC_TO_SPACE: Record<string, string> = {
  cosine: 'cosine',
  euclidean: 'l2',
  dotproduct: 'ip',
};

/**
 * HNSW index sidecar — manages an hnswlib-node index file alongside
 * a primary data store (SQLite, etc.).
 *
 * The primary store remains the source of truth. The HNSW index is
 * rebuildable from it at any time. This sidecar handles:
 * - Dynamic import of hnswlib-node (graceful if missing)
 * - Auto-activation at document count threshold
 * - Auto-resize when capacity is reached
 * - Persistence to disk (.hnsw + .hnsw.map.json)
 * - Dirty tracking with explicit save()
 */
export class HnswIndexSidecar {
  private config!: HnswSidecarConfig;
  private index: any = null;
  private hnswlib: any = null;

  /** Maps HNSW integer labels → document string IDs. */
  private labelToId: Map<number, string> = new Map();
  /** Maps document string IDs → HNSW integer labels. */
  private idToLabel: Map<string, number> = new Map();
  /** Next label to assign. */
  private nextLabel: number = 0;
  /** Current index capacity. */
  private capacity: number = 0;
  /** Whether index has unsaved changes. */
  private dirty: boolean = false;
  /** Whether hnswlib-node was successfully imported. */
  private hnswAvailable: boolean = false;

  /* ---- Lifecycle ------------------------------------------------- */

  /**
   * Initialize the sidecar. Attempts to dynamically import hnswlib-node.
   * If the import fails, the sidecar stays inactive (brute-force fallback).
   * If an existing index file is found, it's loaded from disk.
   */
  async initialize(config: HnswSidecarConfig): Promise<void> {
    this.config = {
      ...config,
      activationThreshold: config.activationThreshold ?? DEFAULTS.activationThreshold,
      hnswM: config.hnswM ?? DEFAULTS.hnswM,
      hnswEfConstruction: config.hnswEfConstruction ?? DEFAULTS.hnswEfConstruction,
      hnswEfSearch: config.hnswEfSearch ?? DEFAULTS.hnswEfSearch,
    };

    try {
      this.hnswlib = await import('hnswlib-node');
      this.hnswAvailable = true;
    } catch {
      this.hnswAvailable = false;
      return;
    }

    /* Try loading existing index from disk */
    await this.load();
  }

  /** Persist and release the index. */
  async shutdown(): Promise<void> {
    if (this.dirty) await this.save();
    this.index = null;
    this.labelToId.clear();
    this.idToLabel.clear();
    this.nextLabel = 0;
    this.capacity = 0;
  }

  /* ---- State ----------------------------------------------------- */

  /** True when the index is loaded AND has vectors (above threshold or loaded from disk). */
  isActive(): boolean {
    return this.index !== null && this.labelToId.size > 0;
  }

  /** True when hnswlib-node was successfully imported. */
  isAvailable(): boolean {
    return this.hnswAvailable;
  }

  /** Whether the index holds changes its last save did not write. */
  hasUnsavedChanges(): boolean {
    return this.dirty;
  }

  /** The ids of the vectors the index holds, a removed one left out. */
  ids(): string[] {
    return [...this.idToLabel.keys()];
  }

  /** Get statistics about the sidecar. */
  getStats(): HnswSidecarStats {
    return {
      active: this.isActive(),
      available: this.hnswAvailable,
      vectorCount: this.labelToId.size,
      capacity: this.capacity,
      indexPath: this.config?.indexPath ?? '',
    };
  }

  /* ---- Operations ------------------------------------------------ */

  /**
   * Add a single vector. Auto-resizes if capacity is reached.
   * Does nothing if hnswlib is unavailable or the item is already indexed.
   */
  async add(id: string, embedding: number[]): Promise<void> {
    if (!this.hnswAvailable) return;
    if (this.idToLabel.has(id)) return;

    if (!this.index) {
      /* Don't create index until threshold is crossed via rebuildFromData */
      return;
    }

    /* Auto-resize */
    if (this.nextLabel >= this.capacity) {
      this.capacity += DEFAULTS.capacityIncrement;
      this.index.resizeIndex(this.capacity);
    }

    const label = this.nextLabel++;
    this.index.addPoint(embedding, label);
    this.labelToId.set(label, id);
    this.idToLabel.set(id, label);
    this.dirty = true;
  }

  /**
   * Add multiple vectors at once. More efficient than calling add() in a loop.
   */
  async addBatch(items: Array<{ id: string; embedding: number[] }>): Promise<void> {
    for (const item of items) {
      await this.add(item.id, item.embedding);
    }
  }

  /**
   * Upsert a single vector into an active index.
   * Replaces the previous vector when the ID already exists.
   */
  async upsert(id: string, embedding: number[]): Promise<void> {
    if (!this.hnswAvailable) return;

    if (this.idToLabel.has(id)) {
      await this.remove(id);
    }

    await this.add(id, embedding);
  }

  /**
   * Upsert multiple vectors, replacing existing IDs in place.
   */
  async upsertBatch(items: Array<{ id: string; embedding: number[] }>): Promise<void> {
    for (const item of items) {
      await this.upsert(item.id, item.embedding);
    }
  }

  /**
   * Soft-delete a vector by marking its label as deleted in the HNSW graph.
   */
  async remove(id: string): Promise<void> {
    if (!this.index) return;
    const label = this.idToLabel.get(id);
    if (label === undefined) return;

    this.index.markDelete(label);
    this.labelToId.delete(label);
    this.idToLabel.delete(id);
    this.dirty = true;
  }

  /**
   * Soft-delete multiple vectors in one pass.
   */
  async removeBatch(ids: string[]): Promise<void> {
    for (const id of ids) {
      await this.remove(id);
    }
  }

  /**
   * Search for the top-K nearest neighbors.
   * Returns empty if the sidecar is inactive.
   */
  async search(query: number[], topK: number): Promise<HnswSearchResult[]> {
    if (!this.index || this.labelToId.size === 0) return [];

    const k = Math.min(topK, this.labelToId.size);
    const { neighbors, distances } = this.index.searchKnn(query, k);

    const results: HnswSearchResult[] = [];
    for (let i = 0; i < neighbors.length; i++) {
      const label = neighbors[i];
      const id = this.labelToId.get(label);
      if (!id) continue;

      /* Convert distance to similarity score */
      let score: number;
      switch (this.config.metric) {
        case 'cosine':
          score = 1 - distances[i];
          break;
        case 'euclidean':
          score = -distances[i];
          break;
        case 'dotproduct':
          score = -distances[i];
          break;
        default:
          score = 1 - distances[i];
      }

      results.push({ id, score });
    }

    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * Full rebuild of the HNSW index from source-of-truth data.
   * Called when the activation threshold is crossed or on manual rebuild.
   */
  async rebuildFromData(items: Array<{ id: string; embedding: number[] }>): Promise<void> {
    if (!this.hnswAvailable || items.length === 0) return;

    const space = METRIC_TO_SPACE[this.config.metric] ?? 'cosine';
    this.capacity = items.length + DEFAULTS.capacityIncrement;

    const HierarchicalNSW = this.hnswlib.HierarchicalNSW ?? this.hnswlib.default?.HierarchicalNSW;
    this.index = new HierarchicalNSW(space, this.config.dimensions);
    this.index.initIndex(this.capacity, this.config.hnswM, this.config.hnswEfConstruction);
    this.index.setEf(this.config.hnswEfSearch!);

    this.labelToId.clear();
    this.idToLabel.clear();
    this.nextLabel = 0;

    for (const item of items) {
      const label = this.nextLabel++;
      this.index.addPoint(item.embedding, label);
      this.labelToId.set(label, item.id);
      this.idToLabel.set(item.id, label);
    }

    this.dirty = true;
    await this.save();
  }

  /* ---- Persistence ----------------------------------------------- */

  /**
   * Save the HNSW index and label map to disk. A write that fails is logged and
   * leaves the changes unsaved: {@link hasUnsavedChanges} then answers true.
   */
  async save(): Promise<void> {
    if (!this.index || !this.dirty) return;

    try {
      // The index write returns a promise: awaited, a write that fails is caught
      // below and the changes stay marked as unsaved.
      await this.index.writeIndex(this.config.indexPath);

      const mapData = {
        nextLabel: this.nextLabel,
        capacity: this.capacity,
        entries: Array.from(this.labelToId.entries()),
      };
      await fs.writeFile(
        `${this.config.indexPath}.map.json`,
        JSON.stringify(mapData),
        'utf8',
      );

      this.dirty = false;
    } catch (err) {
      /* Best-effort persistence — index is rebuildable from source of truth */
      console.warn(`HnswIndexSidecar: failed to save index to ${this.config.indexPath}:`, err);
    }
  }

  /**
   * Load an existing HNSW index from disk.
   * Returns true if loaded successfully, false if no index exists.
   */
  async load(): Promise<boolean> {
    if (!this.hnswAvailable) return false;

    try {
      await fs.access(this.config.indexPath);
      await fs.access(`${this.config.indexPath}.map.json`);
    } catch {
      return false; /* No index files on disk */
    }

    try {
      const mapJson = await fs.readFile(`${this.config.indexPath}.map.json`, 'utf8');
      const mapData = JSON.parse(mapJson);

      const space = METRIC_TO_SPACE[this.config.metric] ?? 'cosine';
      const HierarchicalNSW = this.hnswlib.HierarchicalNSW ?? this.hnswlib.default?.HierarchicalNSW;
      this.index = new HierarchicalNSW(space, this.config.dimensions);
      this.index.readIndex(this.config.indexPath);
      this.index.setEf(this.config.hnswEfSearch!);

      this.nextLabel = mapData.nextLabel;
      this.capacity = mapData.capacity;
      this.labelToId = new Map(mapData.entries);
      this.idToLabel = new Map(
        mapData.entries.map(([label, id]: [number, string]) => [id, label]),
      );

      this.dirty = false;
      return true;
    } catch (err) {
      console.warn(`HnswIndexSidecar: failed to load index from ${this.config.indexPath}:`, err);
      return false;
    }
  }
}
