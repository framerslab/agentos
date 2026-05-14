/**
 * @fileoverview Unified memory store wrapping IVectorStore + IKnowledgeGraph.
 *
 * Handles:
 * - Embedding and storing memory traces in vector store
 * - Recording as episodic memories in knowledge graph
 * - Querying with decay-aware scoring
 * - Access tracking for spaced repetition
 *
 * @module agentos/memory/store/MemoryStore
 */

import type {
  IVectorStore,
  VectorDocument,
  QueryOptions,
  MetadataFilter,
} from '../../../../core/vector-store/IVectorStore.js';
import type { IEmbeddingManager } from '../../../../core/embeddings/IEmbeddingManager.js';
import type { IKnowledgeGraph } from '../graph/knowledge/IKnowledgeGraph.js';
import type {
  MemoryTrace,
  MemoryType,
  MemoryScope,
  CognitiveRetrievalOptions,
  ScoredMemoryTrace,
  PartiallyRetrievedTrace,
} from '../../core/types.js';
import type { PADState, DecayConfig } from '../../core/config.js';
import { DEFAULT_DECAY_CONFIG } from '../../core/config.js';
import {
  computeCurrentStrength,
  updateOnRetrieval,
  type RetrievalUpdateResult,
} from '../../core/decay/DecayModel.js';
import {
  scoreAndRankTraces,
  detectPartiallyRetrieved,
  DEFAULT_SCORING_WEIGHTS,
  type CandidateTrace,
  type ScoringContext,
  type ScoringWeights,
} from '../../core/decay/RetrievalPriorityScorer.js';
import {
  extractEntities,
  slugifyEntityId,
} from '../graph/extraction/index.js';
import { spreadActivation } from '../graph/SpreadingActivation.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface MemoryStoreConfig {
  vectorStore: IVectorStore;
  embeddingManager: IEmbeddingManager;
  knowledgeGraph: IKnowledgeGraph;
  /** Collection name prefix. @default 'cogmem' */
  collectionPrefix: string;
  /** Embedding dimension (auto-detected if possible). */
  embeddingDimension?: number;
  decayConfig?: DecayConfig;
  /** Optional cognitive mechanisms engine for retrieval-time hooks. */
  mechanismsEngine?: import('../../mechanisms/CognitiveMechanismsEngine.js').CognitiveMechanismsEngine;
  /** Optional mood provider for reconsolidation drift during recordAccess. */
  moodProvider?: () => PADState;
  /**
   * Step 13: enable graph activation. When true, `store` upserts entity
   * nodes and `co_occurs` edges at ingest (from `trace.entities`), and
   * `query` seeds Anderson spreading activation from query-extracted
   * entities to compute the per-candidate `graphActivation` score
   * (weight 0.10 in `RetrievalPriorityScorer`). Default: false, which
   * preserves the legacy `graphActivation: 0` behavior for all
   * candidates.
   */
  enableGraphActivation?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectionName(prefix: string, scope: MemoryScope, scopeId: string): string {
  return `${prefix}_${scope}_${scopeId}`;
}

function scopeKey(scope: MemoryScope, scopeId: string): string {
  return `${scope}:${scopeId}`;
}

function traceToMetadata(trace: MemoryTrace): Record<string, any> {
  return {
    type: trace.type,
    scope: trace.scope,
    scopeId: trace.scopeId,
    encodingStrength: trace.encodingStrength,
    stability: trace.stability,
    retrievalCount: trace.retrievalCount,
    lastAccessedAt: trace.lastAccessedAt,
    accessCount: trace.accessCount,
    emotionalValence: trace.emotionalContext.valence,
    emotionalArousal: trace.emotionalContext.arousal,
    emotionalIntensity: trace.emotionalContext.intensity,
    confidence: trace.provenance.confidence,
    sourceType: trace.provenance.sourceType,
    importance: trace.provenance.confidence, // use confidence as proxy
    // Provenance audit fields. Persisted into the vector store metadata so
    // verification events and contradiction records survive process restarts;
    // without these, every reload of a trace would reset the audit trail.
    verificationCount: trace.provenance.verificationCount ?? 0,
    lastVerifiedAt: trace.provenance.lastVerifiedAt,
    contradictedBy: trace.provenance.contradictedBy,
    // Trust policy. Persisted as a JSON-serialised string because the
    // vector-store metadata layer cannot represent nested objects with
    // mixed types portably across backends (Pinecone, Qdrant, Postgres).
    // Read back via metadataToTracePartial.
    policyJson: trace.policy ? JSON.stringify(trace.policy) : undefined,
    createdAt: trace.createdAt,
    isActive: trace.isActive ? 1 : 0,
    tags: trace.tags.join(','),
    entities: trace.entities.join(','),
  };
}

/** Parse a JSON string and return `undefined` on any failure. */
function safeParseJson<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function metadataToTracePartial(metadata: Record<string, any>): Partial<MemoryTrace> {
  return {
    type: metadata.type as MemoryType,
    scope: metadata.scope as MemoryScope,
    scopeId: metadata.scopeId as string,
    encodingStrength: metadata.encodingStrength as number,
    stability: metadata.stability as number,
    retrievalCount: metadata.retrievalCount as number,
    lastAccessedAt: metadata.lastAccessedAt as number,
    accessCount: metadata.accessCount as number,
    emotionalContext: {
      valence: metadata.emotionalValence as number,
      arousal: metadata.emotionalArousal as number,
      dominance: 0,
      intensity: metadata.emotionalIntensity as number,
      gmiMood: '',
    },
    provenance: {
      sourceType: metadata.sourceType as any,
      confidence: metadata.confidence as number,
      verificationCount:
        typeof metadata.verificationCount === 'number' ? metadata.verificationCount : 0,
      lastVerifiedAt:
        typeof metadata.lastVerifiedAt === 'number' ? metadata.lastVerifiedAt : undefined,
      contradictedBy: Array.isArray(metadata.contradictedBy)
        ? (metadata.contradictedBy as string[])
        : undefined,
      sourceTimestamp: metadata.createdAt as number,
    },
    policy: typeof metadata.policyJson === 'string'
      ? safeParseJson<import('../../core/types.js').MemoryTrustPolicy>(metadata.policyJson)
      : undefined,
    createdAt: metadata.createdAt as number,
    isActive: metadata.isActive === 1,
    tags: typeof metadata.tags === 'string' ? metadata.tags.split(',').filter(Boolean) : [],
    entities:
      typeof metadata.entities === 'string' ? metadata.entities.split(',').filter(Boolean) : [],
  };
}

// ---------------------------------------------------------------------------
// MemoryStore
// ---------------------------------------------------------------------------

export class MemoryStore {
  private config: MemoryStoreConfig;
  private decay: DecayConfig;
  /** Cache of full MemoryTrace objects by ID. */
  private traceCache: Map<string, MemoryTrace> = new Map();
  /** Cache embeddings by trace ID to avoid re-generating on metadata-only updates. */
  private embeddingCache: Map<string, number[]> = new Map();
  /** Track concrete scopes we have seen, so retrieval never falls back to a fake wildcard scope. */
  private knownScopes: Map<string, { scope: MemoryScope; scopeId: string }> = new Map();
  /** Optional cognitive mechanisms engine for retrieval-time hooks. */
  private mechanismsEngine?: import('../../mechanisms/CognitiveMechanismsEngine.js').CognitiveMechanismsEngine;
  /**
   * Optional Brain for durable write-through persistence.
   * When set, store/softDelete/recordAccess also write to the brain's SQL tables.
   * The in-memory vector index remains the hot read path (fast); the brain is
   * the durable backing store that survives process restarts.
   */
  private brain: import('./Brain.js').Brain | null = null;

  constructor(config: MemoryStoreConfig) {
    this.config = config;
    this.decay = config.decayConfig ?? DEFAULT_DECAY_CONFIG;
    this.mechanismsEngine = config.mechanismsEngine;
  }

  /**
   * Attach a Brain for durable write-through persistence.
   * Once attached, all store/softDelete/recordAccess operations also
   * write to the brain's `memory_traces` table.
   *
   * @param brain - Brain instance (already initialized with schema)
   */
  setBrain(brain: import('./Brain.js').Brain): void {
    this.brain = brain;
  }

  /**
   * Access the attached Brain for export/import operations.
   * Returns null when no brain is attached (in-memory only mode).
   */
  getBrain(): import('./Brain.js').Brain | null {
    return this.brain;
  }

  // =========================================================================
  // Store
  // =========================================================================

  /**
   * Store a new memory trace: embed content, upsert into vector store,
   * and record as episodic memory in the knowledge graph.
   */
  async store(trace: MemoryTrace): Promise<void> {
    const collection = collectionName(this.config.collectionPrefix, trace.scope, trace.scopeId);

    // Generate embedding
    const embeddingResponse = await this.config.embeddingManager.generateEmbeddings({
      texts: trace.content,
    });
    const embedding = embeddingResponse.embeddings[0];

    try {
      const exists = this.config.vectorStore.collectionExists
        ? await this.config.vectorStore.collectionExists(collection)
        : true;
      if (!exists) {
        await this.config.vectorStore.createCollection?.(
          collection,
          this.config.embeddingDimension ?? embedding.length,
          { overwriteIfExists: false },
        );
      }
    } catch {
      // Some providers auto-create collections or do not expose existence checks reliably.
    }

    // Upsert into vector store
    const doc: VectorDocument = {
      id: trace.id,
      textContent: trace.content,
      embedding,
      metadata: traceToMetadata(trace),
    };

    await this.config.vectorStore.upsert(collection, [doc]);

    // Record in knowledge graph as episodic memory. Step 13: thread
    // `trace.entities` through as `entityIds` (slugified for deterministic
    // lookup). Previously hardcoded to `[]`, which silenced the sixth
    // signal in the composite scoring formula.
    const entityIds = (trace.entities ?? [])
      .map(slugifyEntityId)
      .filter((id) => id.length > 0);
    try {
      await this.config.knowledgeGraph.recordMemory({
        type: trace.type === 'episodic' ? 'conversation' : 'discovery',
        summary: trace.content.substring(0, 200),
        description: trace.content,
        participants: [trace.scopeId],
        valence: trace.emotionalContext.valence,
        importance: trace.encodingStrength,
        entityIds,
        embedding,
        occurredAt: new Date(trace.createdAt).toISOString(),
        outcome: 'unknown',
        context: {
          memoryTraceId: trace.id,
          scope: trace.scope,
          scopeId: trace.scopeId,
          type: trace.type,
        },
      });
    } catch {
      // Knowledge graph may not be available; non-critical
    }

    // Step 13: upsert entity nodes and co-occurrence edges when the
    // feature flag is on. Non-critical; swallows errors so an unavailable
    // KG backend does not block encoding.
    if (this.config.enableGraphActivation) {
      await this.ingestEntityGraph(trace);
    }

    // Cache trace and its embedding (avoids re-generation on recordAccess)
    this.traceCache.set(trace.id, trace);
    this.embeddingCache.set(trace.id, embedding);
    this.registerScope(trace.scope, trace.scopeId);

    // Write-through to Brain for durability.
    // The SQL row mirrors the in-memory cache so traces survive restart.
    if (this.brain) {
      try {
        const { dialect } = this.brain.features;
        await this.brain.run(
          dialect.insertOrReplace(
            'memory_traces',
            ['brain_id', 'id', 'type', 'scope', 'content', 'embedding', 'strength', 'created_at', 'last_accessed', 'retrieval_count', 'tags', 'emotions', 'metadata', 'deleted'],
            ['?', '?', '?', '?', '?', '?', '?', '?', '?', '?', '?', '?', '?', '0'],
            'brain_id, id',
          ),
          [
            this.brain.brainId,
            trace.id,
            trace.type,
            trace.scope,
            trace.content,
            null, // embedding managed by vector store, not SQL
            trace.encodingStrength,
            trace.createdAt,
            trace.lastAccessedAt,
            trace.retrievalCount,
            JSON.stringify(trace.tags),
            JSON.stringify(trace.emotionalContext),
            JSON.stringify({
              scopeId: trace.scopeId,
              provenance: trace.provenance,
              entities: trace.entities,
              stability: trace.stability,
              importance: trace.importance,
              associatedTraceIds: trace.associatedTraceIds,
              structuredData: trace.structuredData,
            }),
          ]
        );
      } catch {
        // Write-through is best-effort — in-memory store is primary
      }
    }
  }

  // =========================================================================
  // Query
  // =========================================================================

  /**
   * Query memory traces with cognitive scoring.
   */
  async query(
    queryText: string,
    currentMood: PADState,
    options: CognitiveRetrievalOptions = {}
  ): Promise<{
    scored: ScoredMemoryTrace[];
    partial: PartiallyRetrievedTrace[];
    /**
     * Per-stage wall-clock timings. Surfaced so
     * {@link CognitiveMemoryManager} can populate its diagnostics
     * with real numbers instead of the former 0-placeholder.
     */
    timings: {
      vectorSearchMs: number;
      scoringMs: number;
    };
  }> {
    const now = Date.now();
    const topK = options.topK ?? 20;

    // Determine which collections to search
    const scopes = options.scopes?.length ? options.scopes : this.getKnownScopes();
    if (scopes.length === 0) {
      return { scored: [], partial: [], timings: { vectorSearchMs: 0, scoringMs: 0 } };
    }

    // Generate query embedding
    const embeddingResponse = await this.config.embeddingManager.generateEmbeddings({
      texts: queryText,
    });
    const queryEmbedding = embeddingResponse.embeddings[0];

    // Build metadata filter
    const metadataFilter: Record<string, any> = { isActive: { $eq: 1 } };
    if (options.types?.length) {
      metadataFilter.type = { $in: options.types };
    }
    if (options.minConfidence != null) {
      metadataFilter.confidence = { $gte: options.minConfidence };
    }
    if (options.timeRange?.after) {
      metadataFilter.createdAt = { $gte: options.timeRange.after };
    }

    // Step 13: compute graph activation for this query. Extract query
    // entities, seed spreading activation from their entity nodes, build
    // a per-entity-ID activation map. Per-candidate activation is computed
    // inside the candidate loop as max over the trace's entity IDs. When
    // the flag is off or no query entities are extracted, the map stays
    // empty and all candidates get graphActivation = 0 (legacy).
    const activationByEntityId: Map<string, number> = new Map();
    if (this.config.enableGraphActivation) {
      const queryEntities = extractEntities(queryText);
      const seedIds = queryEntities
        .map(slugifyEntityId)
        .filter((id) => id.length > 0);
      if (seedIds.length > 0) {
        try {
          const activated = await spreadActivation({
            seedIds,
            getNeighbors: async (nodeId) => {
              const rels = await this.config.knowledgeGraph.getRelations(
                nodeId,
                { direction: 'both' },
              );
              return rels
                .filter((r) => r.type === 'related_to' && r.label === 'co_occurs')
                .map((r) => ({
                  id: r.sourceId === nodeId ? r.targetId : r.sourceId,
                  weight: r.weight ?? 1,
                }));
            },
          });
          for (const node of activated) {
            activationByEntityId.set(node.memoryId, node.activation);
          }
          // Seeds themselves always count as fully-activated self-matches.
          for (const id of seedIds) {
            if (!activationByEntityId.has(id)) {
              activationByEntityId.set(id, 1);
            }
          }
        } catch {
          // Non-critical: activation failure falls back to legacy behavior.
        }
      }
    }

    // Search across scopes
    const allCandidates: CandidateTrace[] = [];
    const vectorSearchStart = Date.now();

    for (const { scope, scopeId } of scopes) {
      const collection = collectionName(this.config.collectionPrefix, scope, scopeId);

      try {
        const results = await this.config.vectorStore.query(collection, queryEmbedding, {
          topK: topK * 2, // over-fetch for re-ranking
          filter: metadataFilter as MetadataFilter,
          includeMetadata: true,
        });

        for (const result of results.documents) {
          const tracePartial = metadataToTracePartial(result.metadata ?? {});
          const cached = this.traceCache.get(result.id);

          const trace: MemoryTrace =
            cached ??
            ({
              id: result.id,
              content: result.textContent ?? '',
              structuredData: undefined,
              associatedTraceIds: [],
              reinforcementInterval: 3_600_000,
              updatedAt: Date.now(),
              ...tracePartial,
            } as MemoryTrace);

          if (!cached) {
            this.traceCache.set(trace.id, trace);
          }
          if (trace.scope && trace.scopeId) {
            this.registerScope(trace.scope, trace.scopeId);
          }

          // Step 13: per-candidate activation score. Max over the
          // trace's entity IDs (slugified) against the query-seeded
          // activation map. Zero when the feature flag is off, no
          // query entities matched, or the trace has no entities.
          let graphActivation = 0;
          if (this.config.enableGraphActivation && activationByEntityId.size > 0) {
            const ids = (trace.entities ?? [])
              .map(slugifyEntityId)
              .filter((id) => id.length > 0);
            for (const id of ids) {
              const a = activationByEntityId.get(id);
              if (a !== undefined && a > graphActivation) graphActivation = a;
            }
          }
          allCandidates.push({
            trace,
            vectorSimilarity: result.similarityScore ?? 0,
            graphActivation,
          });
        }
      } catch {
        // Collection may not exist yet; skip
      }
    }

    const vectorSearchMs = Date.now() - vectorSearchStart;

    // Score and rank — optional per-call scoringWeights override
    // enables ablation studies (zero one signal at a time).
    const effectiveWeights: ScoringWeights | undefined = options.scoringWeights
      ? { ...DEFAULT_SCORING_WEIGHTS, ...options.scoringWeights }
      : undefined;
    const scoringContext: ScoringContext = {
      currentMood,
      now,
      neutralMood: options.neutralMood,
      decayConfig: this.decay,
      weights: effectiveWeights,
    };

    const scoringStart = Date.now();
    const scored = scoreAndRankTraces(allCandidates, scoringContext).slice(0, topK);
    const partial = detectPartiallyRetrieved(allCandidates, now);
    const scoringMs = Date.now() - scoringStart;

    // Cognitive mechanisms: RIF + FOK
    if (this.mechanismsEngine && scored.length > 0) {
      const cutoff = scored[scored.length - 1].retrievalScore;
      this.mechanismsEngine.onRetrieval(scored, allCandidates, cutoff, []);
    }

    return { scored, partial, timings: { vectorSearchMs, scoringMs } };
  }

  // =========================================================================
  // Access tracking
  // =========================================================================

  /**
   * Record that a memory was accessed (retrieved).
   * Updates decay parameters via spaced repetition.
   */
  async recordAccess(traceId: string): Promise<RetrievalUpdateResult | null> {
    const trace = this.traceCache.get(traceId);
    if (!trace) return null;

    const now = Date.now();
    const update = updateOnRetrieval(trace, now);

    // Apply updates to cached trace
    trace.encodingStrength = update.encodingStrength;
    trace.stability = update.stability;
    trace.retrievalCount = update.retrievalCount;
    trace.lastAccessedAt = update.lastAccessedAt;
    trace.accessCount = update.accessCount;
    trace.reinforcementInterval = update.reinforcementInterval;
    trace.nextReinforcementAt = update.nextReinforcementAt;
    trace.updatedAt = now;

    // Cognitive mechanisms: reconsolidation drift on access
    if (this.mechanismsEngine && this.config.moodProvider) {
      const mood = this.config.moodProvider();
      this.mechanismsEngine.onAccess(trace, mood);
    }

    // Update vector store metadata, reusing cached embedding to avoid
    // wasteful re-embedding on every access.
    const collection = collectionName(this.config.collectionPrefix, trace.scope, trace.scopeId);
    try {
      let embedding = this.embeddingCache.get(trace.id);
      if (!embedding) {
        // Embedding not cached (e.g. loaded from a prior process). Generate once and cache.
        const embeddingResponse = await this.config.embeddingManager.generateEmbeddings({
          texts: trace.content,
        });
        embedding = embeddingResponse.embeddings[0];
        this.embeddingCache.set(trace.id, embedding);
      }
      await this.config.vectorStore.upsert(collection, [
        {
          id: trace.id,
          textContent: trace.content,
          embedding,
          metadata: traceToMetadata(trace),
        },
      ]);
    } catch {
      // Non-critical update
    }

    // Write-through: update access metadata in the durable SQL store
    if (this.brain) {
      try {
        await this.brain.run(
          'UPDATE memory_traces SET last_accessed = ?, retrieval_count = ?, strength = ? WHERE brain_id = ? AND id = ?',
          [trace.lastAccessedAt, trace.retrievalCount, trace.encodingStrength, this.brain.brainId, traceId]
        );
      } catch {
        // Best-effort persistence
      }
    }

    return update;
  }

  // =========================================================================
  // Batch operations
  // =========================================================================

  /**
   * Get all traces for a scope (for consolidation pipeline).
   *
   * **Limitation**: This primarily returns traces from the in-process cache.
   * Traces that were persisted to the vector store in a prior process lifetime
   * (or by another process) will only be returned if the cache is empty for this
   * scope, in which case we fall back to querying the vector store with a
   * zero-vector and metadata filter. The fallback is approximate (limited by
   * topK) and does not guarantee completeness.
   */
  async getByScope(scope: MemoryScope, scopeId: string, type?: MemoryType): Promise<MemoryTrace[]> {
    // Return from cache + filter
    const results: MemoryTrace[] = [];
    for (const trace of this.traceCache.values()) {
      if (trace.scope === scope && trace.scopeId === scopeId) {
        if (!type || trace.type === type) {
          results.push(trace);
        }
      }
    }

    // Fallback: if cache is empty for this scope, query the vector store.
    if (results.length === 0) {
      try {
        const collection = collectionName(this.config.collectionPrefix, scope, scopeId);
        const dim = this.config.embeddingDimension ?? 1536;
        const zeroVector = new Array(dim).fill(0);
        const filter: MetadataFilter = { isActive: 1 };
        if (type) {
          filter.type = type;
        }
        const queryResult = await this.config.vectorStore.query(collection, zeroVector, {
          topK: 500,
          filter,
          includeMetadata: true,
          includeTextContent: true,
        });
        for (const doc of queryResult.documents) {
          if (!doc.metadata) continue;
          const cached = this.traceCache.get(doc.id);
          if (cached) {
            results.push(cached);
          } else {
            // Reconstruct trace from vector store metadata.
            const partial = metadataToTracePartial(doc.metadata as Record<string, any>);
            const trace: MemoryTrace = {
              id: doc.id,
              content: doc.textContent ?? '',
              associatedTraceIds: [],
              reinforcementInterval: 0,
              updatedAt: (partial.createdAt as number) ?? Date.now(),
              ...partial,
            } as MemoryTrace;
            this.traceCache.set(trace.id, trace);
            results.push(trace);
          }
        }
      } catch {
        // Vector store query may fail (collection not found, etc.); return empty.
      }
    }

    return results;
  }

  /**
   * Soft-delete a trace.
   */
  async softDelete(traceId: string): Promise<void> {
    const trace = this.traceCache.get(traceId);
    if (trace) {
      trace.isActive = false;
      trace.updatedAt = Date.now();
    }

    // Write-through: mark trace as deleted in the durable SQL store
    if (this.brain) {
      try {
        await this.brain.run('UPDATE memory_traces SET deleted = 1 WHERE brain_id = ? AND id = ?', [this.brain.brainId, traceId]);
      } catch {
        // Best-effort persistence
      }
    }
  }

  /**
   * Get a trace by ID.
   */
  getTrace(traceId: string): MemoryTrace | undefined {
    return this.traceCache.get(traceId);
  }

  /**
   * Get trace count.
   */
  getTraceCount(): number {
    return this.traceCache.size;
  }

  /**
   * Get active trace count.
   */
  getActiveTraceCount(): number {
    let count = 0;
    for (const trace of this.traceCache.values()) {
      if (trace.isActive) count++;
    }
    return count;
  }

  /**
   * List cached traces for diagnostics and tooling.
   */
  listTraces(options?: {
    activeOnly?: boolean;
    type?: MemoryType;
    scope?: MemoryScope;
    scopeId?: string;
  }): MemoryTrace[] {
    const traces: MemoryTrace[] = [];
    for (const trace of this.traceCache.values()) {
      if (options?.activeOnly && !trace.isActive) {
        continue;
      }
      if (options?.type && trace.type !== options.type) {
        continue;
      }
      if (options?.scope && trace.scope !== options.scope) {
        continue;
      }
      if (options?.scopeId && trace.scopeId !== options.scopeId) {
        continue;
      }
      traces.push({ ...trace });
    }
    return traces.sort((a, b) => b.createdAt - a.createdAt);
  }

  private registerScope(scope: MemoryScope, scopeId: string): void {
    if (!scopeId) return;
    this.knownScopes.set(scopeKey(scope, scopeId), { scope, scopeId });
  }

  private getKnownScopes(): Array<{ scope: MemoryScope; scopeId: string }> {
    return [...this.knownScopes.values()];
  }

  /**
   * Step 13: upsert entity nodes for every label in `trace.entities` and
   * create bidirectional `co_occurs` relations between every pair. Uses
   * deterministic slug IDs via {@link slugifyEntityId}. Idempotent.
   *
   * Called from `store(trace)` only when `config.enableGraphActivation`
   * is true. Non-critical: errors are caught and swallowed so an
   * unavailable KG backend never blocks encoding.
   *
   * @param trace - The memory trace just persisted via `store`.
   */
  private async ingestEntityGraph(trace: MemoryTrace): Promise<void> {
    const labels = trace.entities ?? [];
    if (labels.length === 0) return;

    const kg = this.config.knowledgeGraph;
    const now = new Date().toISOString();

    const ids: string[] = [];
    for (const label of labels) {
      const id = slugifyEntityId(label);
      if (!id) continue;
      try {
        await kg.upsertEntity({
          id,
          type: 'concept',
          label,
          confidence: 1,
          source: { type: 'conversation', timestamp: now },
          properties: {},
        });
        ids.push(id);
      } catch {
        // Non-critical.
      }
    }

    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        try {
          await kg.upsertRelation({
            sourceId: ids[i],
            targetId: ids[j],
            type: 'related_to',
            label: 'co_occurs',
            weight: 1,
            bidirectional: true,
            confidence: 1,
            source: { type: 'conversation', timestamp: now },
            properties: { traceId: trace.id, timestamp: now },
          });
        } catch {
          // Non-critical.
        }
      }
    }
  }
}
