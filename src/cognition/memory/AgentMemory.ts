/**
 * @fileoverview AgentMemory — high-level facade spanning both AgentOS memory backends.
 *
 * Provides a simple, developer-friendly API that can either:
 * - wrap `CognitiveMemoryManager` for observer/reflector/prospective workflows, or
 * - wrap the standalone `Memory` facade for SQLite-first local memory.
 *
 * Users don't need to know about PAD mood models, HEXACO traits, SQLite table
 * layout, or the internal memory architecture.
 *
 * Usage:
 * ```typescript
 * import { AgentMemory } from '@framers/agentos';
 *
 * // Option A: Wrap an existing CognitiveMemoryManager (wunderland does this)
 * const cognitive = AgentMemory.wrap(existingManager);
 *
 * // Option B: Create SQLite-backed standalone memory
 * const memory = await AgentMemory.sqlite({ path: './brain.sqlite' });
 *
 * // Simple API
 * await memory.remember("User prefers dark mode");
 * const results = await memory.recall("what does the user prefer?");
 *
 * // Advanced cognitive-only APIs remain available when backed by
 * // CognitiveMemoryManager.
 * await cognitive.observe('user', "Can you help me with my TMJ?");
 * const context = await cognitive.getContext("TMJ treatment", { tokenBudget: 2000 });
 * ```
 *
 * @module agentos/memory/AgentMemory
 */

import type {
  MemoryTrace,
  MemoryType,
  MemoryScope,
  MemorySourceType,
  ScoredMemoryTrace,
  AssembledMemoryContext,
  MemoryHealthReport,
  CognitiveRetrievalResult,
  WorkingMemorySlot,
  MemoryGraphSnapshot,
  ObservationPipelineStats,
  CognitiveMemorySnapshot,
  MemoryTypeStats,
  TrustCapability,
} from './core/types.js';
import type { PADState, CognitiveMemoryConfig } from './core/config.js';
import type { ICognitiveMemoryManager } from './CognitiveMemoryManager.js';
import { CognitiveMemoryManager } from './CognitiveMemoryManager.js';
import type { ObservationNote } from './pipeline/observation/MemoryObserver.js';
import type { ProspectiveMemoryItem } from './retrieval/prospective/ProspectiveMemoryManager.js';
import { Memory as StandaloneMemory } from './io/facade/Memory.js';
import type { MemoryRetrievalPolicy } from '../rag/unified/policy.js';
import type {
  MemoryConfig,
  IngestOptions,
  IngestResult,
  ExportOptions,
  ImportOptions,
  ImportResult,
  MemoryHealth as StandaloneMemoryHealth,
} from './io/facade/types.js';

// ── Neutral mood (no emotional bias in encoding/retrieval) ──
const NEUTRAL_MOOD: PADState = { valence: 0, arousal: 0, dominance: 0 };

// ── Public types ──

export interface RecallResult {
  /** Relevant memory traces sorted by relevance. */
  memories: ScoredMemoryTrace[];
  /** Partially retrieved traces (tip-of-the-tongue). */
  partial: CognitiveRetrievalResult['partiallyRetrieved'];
  /** Retrieval diagnostics. */
  diagnostics: CognitiveRetrievalResult['diagnostics'];
}

export interface RememberResult {
  /** The stored trace. Undefined when `success` is false. */
  trace?: MemoryTrace;
  success: boolean;
}

export interface SearchOptions {
  /** Maximum results. Default: 10. */
  limit?: number;
  /** Memory type filter. */
  types?: MemoryType[];
  /** Tags filter. */
  tags?: string[];
  /** Minimum confidence. Default: 0. */
  minConfidence?: number;
  /**
   * Restrict results to traces whose trust policy permits the listed
   * capability (or all of them when given an array). Use when the recall
   * is going into an auth-sensitive prompt or a fact-claim assertion.
   */
  usableFor?: TrustCapability | TrustCapability[];
  /** Shared retrieval policy surface. */
  policy?: MemoryRetrievalPolicy;
  /** Live PAD mood for mood-congruent recall ranking. Omitted → neutral (no bias). */
  currentMood?: PADState;
}

type StandaloneMemoryBackend = Pick<
  StandaloneMemory,
  'remember' | 'recall' | 'consolidate' | 'health' | 'close' | 'ingest' | 'importFrom' | 'export' | 'feedback'
>;

function isStandaloneMemoryBackend(value: unknown): value is StandaloneMemoryBackend {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as StandaloneMemoryBackend).remember === 'function' &&
    typeof (value as StandaloneMemoryBackend).recall === 'function' &&
    typeof (value as StandaloneMemoryBackend).close === 'function'
  );
}

/**
 * High-level memory facade for AI agents.
 *
 * Wraps either `ICognitiveMemoryManager` or the standalone `Memory` facade
 * with a simple API that hides PAD mood models, HEXACO traits, SQLite
 * storage details, and internal architecture.
 */
export class AgentMemory {
  private manager?: ICognitiveMemoryManager;
  private standalone?: StandaloneMemoryBackend;
  private _initialized = false;

  constructor(backend?: ICognitiveMemoryManager | StandaloneMemoryBackend) {
    if (isStandaloneMemoryBackend(backend)) {
      this.standalone = backend;
      this._initialized = true;
      return;
    }

    this.manager = backend ?? new CognitiveMemoryManager();
  }

  /**
   * Create an AgentMemory wrapping an existing CognitiveMemoryManager.
   * Use this in wunderland where the manager is already constructed.
   */
  static wrap(manager: ICognitiveMemoryManager): AgentMemory {
    const mem = new AgentMemory(manager);
    mem._initialized = true; // assume the passed manager is already initialized
    return mem;
  }

  /**
   * Create an AgentMemory wrapping the standalone SQLite-first Memory facade.
   */
  static wrapMemory(memory: StandaloneMemoryBackend): AgentMemory {
    return new AgentMemory(memory);
  }

  /**
   * Create an initialized SQLite-backed AgentMemory for standalone usage.
   */
  static async sqlite(config?: MemoryConfig): Promise<AgentMemory> {
    const memory = await StandaloneMemory.createSqlite(config);
    return AgentMemory.wrapMemory(memory);
  }

  /**
   * Initialize the cognitive-manager path. Only needed when constructing the
   * legacy cognitive backend directly (not via `AgentMemory.wrap()` or
   * `AgentMemory.sqlite()`).
   */
  async initialize(config: CognitiveMemoryConfig): Promise<void> {
    if (this._initialized) return;
    if (!this.manager) {
      this._initialized = true;
      return;
    }
    await this.manager.initialize(config);
    this._initialized = true;
  }

  /**
   * Store information in long-term memory.
   *
   * @example
   * await memory.remember("User prefers dark mode");
   * await memory.remember("Deploy by Friday", { type: 'prospective', tags: ['deadline'] });
   */
  async remember(
    content: string,
    options?: {
      type?: MemoryType;
      scope?: MemoryScope;
      scopeId?: string;
      sourceType?: MemorySourceType;
      tags?: string[];
      entities?: string[];
      importance?: number;
      /**
       * Set when encoding a subjective trace produced by
       * {@link PerspectiveObserver}. Threads the source-event identifiers into
       * the trace's MechanismMetadata so Reconsolidation halves drift on
       * perspective traces and audit queries can back-reference the
       * objective source event.
       */
      perspectiveSource?: { eventId: string; eventHash: string };
    },
  ): Promise<RememberResult> {
    this.ensureReady();
    try {
      const trace = this.standalone
        ? await this.standalone.remember(content, {
            type: options?.type ?? 'episodic',
            scope: options?.scope ?? 'thread',
            scopeId: options?.scopeId,
            tags: options?.tags,
            entities: options?.entities,
            importance: options?.importance,
          })
        : await this.manager!.encode(content, NEUTRAL_MOOD, 'neutral', {
            type: options?.type ?? 'episodic',
            scope: options?.scope ?? 'thread',
            scopeId: options?.scopeId,
            sourceType: options?.sourceType ?? 'user_statement',
            tags: options?.tags,
            entities: options?.entities,
            contentSentiment: options?.importance,
            perspectiveSource: options?.perspectiveSource,
          });
      return { trace, success: true };
    } catch {
      return { trace: undefined, success: false };
    }
  }

  /**
   * Recall memories relevant to a query.
   *
   * @example
   * const results = await memory.recall("what does the user prefer?");
   * for (const m of results.memories) {
   *   console.log(m.content, m.retrievalScore);
   * }
   */
  async recall(query: string, options?: SearchOptions): Promise<RecallResult> {
    this.ensureReady();
    if (this.standalone) {
      return this.recallFromStandalone(query, options);
    }

    const result = await this.manager!.retrieve(query, options?.currentMood ?? NEUTRAL_MOOD, {
      topK: options?.limit ?? 10,
      types: options?.types,
      tags: options?.tags,
      minConfidence: options?.minConfidence,
      usableFor: options?.usableFor,
      policy: options?.policy,
    });
    return {
      memories: result.retrieved,
      partial: result.partiallyRetrieved,
      diagnostics: result.diagnostics,
    };
  }

  /**
   * Search memories (alias for recall with simpler return).
   */
  async search(query: string, options?: SearchOptions): Promise<ScoredMemoryTrace[]> {
    const result = await this.recall(query, options);
    return result.memories;
  }

  /**
   * Feed a conversation turn to the observational memory system.
   * The Observer creates dense notes when the token threshold is reached.
   *
   * @example
   * await memory.observe('user', "Can you help me debug this?");
   * await memory.observe('assistant', "Sure! The issue is in your useEffect...");
   */
  async observe(
    role: 'user' | 'assistant' | 'system' | 'tool',
    content: string,
    options?: { currentMood?: PADState; contentSentiment?: number },
  ): Promise<ObservationNote[] | null> {
    this.ensureReady();
    if (!this.manager) {
      this.throwUnsupportedForStandalone('observe');
    }
    return (
      this.manager.observe?.(role, content, options?.currentMood ?? NEUTRAL_MOOD, {
        contentSentiment: options?.contentSentiment,
      }) ?? null
    );
  }

  /**
   * Get assembled memory context for prompt injection within a token budget.
   */
  async getContext(
    query: string,
    options?: { tokenBudget?: number; currentMood?: PADState },
  ): Promise<AssembledMemoryContext> {
    this.ensureReady();
    if (!this.manager) {
      this.throwUnsupportedForStandalone('getContext');
    }
    return this.manager.assembleForPrompt(
      query,
      options?.tokenBudget ?? 2000,
      options?.currentMood ?? NEUTRAL_MOOD,
    );
  }

  /**
   * Register a prospective memory (reminder/intention).
   */
  async remind(
    input: Omit<ProspectiveMemoryItem, 'id' | 'triggered' | 'createdAt' | 'cueEmbedding'> & {
      cueText?: string;
    },
  ): Promise<ProspectiveMemoryItem | null> {
    this.ensureReady();
    if (!this.manager) {
      this.throwUnsupportedForStandalone('remind');
    }
    return this.manager.registerProspective?.(input) ?? null;
  }

  /** List active reminders. */
  async reminders(): Promise<ProspectiveMemoryItem[]> {
    this.ensureReady();
    if (!this.manager) {
      this.throwUnsupportedForStandalone('reminders');
    }
    return this.manager.listProspective?.() ?? [];
  }

  /** Run consolidation cycle. */
  async consolidate(): Promise<void> {
    this.ensureReady();
    if (this.standalone) {
      await this.standalone.consolidate();
      return;
    }
    await this.manager?.runConsolidation?.();
  }

  /** Memory health diagnostics. */
  async health(): Promise<MemoryHealthReport> {
    this.ensureReady();
    if (this.standalone) {
      return this.mapStandaloneHealth(await this.standalone.health());
    }
    return this.manager!.getMemoryHealth();
  }

  /** Shutdown and release resources. */
  async shutdown(): Promise<void> {
    if (!this._initialized) return;
    if (this.standalone) {
      await this.standalone.close();
      this._initialized = false;
      return;
    }
    await this.manager?.shutdown();
    this._initialized = false;
  }

  /**
   * Ingest files, directories, or URLs. Available only when backed by the
   * standalone SQLite-first Memory facade.
   */
  async ingest(source: string, options?: IngestOptions): Promise<IngestResult> {
    this.ensureReady();
    if (!this.standalone) {
      this.throwUnsupportedForCognitive('ingest');
    }
    return this.standalone.ingest(source, options);
  }

  /**
   * Import previously exported memory data. Available only when backed by the
   * standalone SQLite-first Memory facade.
   */
  async importFrom(source: string, options?: ImportOptions): Promise<ImportResult> {
    this.ensureReady();
    if (!this.standalone) {
      this.throwUnsupportedForCognitive('importFrom');
    }
    return this.standalone.importFrom(source, options);
  }

  /**
   * Export memory data. Available only when backed by the standalone
   * SQLite-first Memory facade.
   */
  async export(outputPath: string, options?: ExportOptions): Promise<void> {
    this.ensureReady();
    if (!this.standalone) {
      this.throwUnsupportedForCognitive('export');
    }
    await this.standalone.export(outputPath, options);
  }

  /**
   * Record used/ignored retrieval feedback. Available only when backed by the
   * standalone SQLite-first Memory facade.
   */
  feedback(traceId: string, signal: 'used' | 'ignored', query?: string): void {
    this.ensureReady();
    if (!this.standalone) {
      this.throwUnsupportedForCognitive('feedback');
    }
    void this.standalone.feedback(traceId, signal, query);
  }

  // =========================================================================
  // Extended API — visualization, stats, graph, export
  // =========================================================================

  /**
   * Get a serializable snapshot of the memory graph for visualization.
   * Returns nodes (traces), edges (associations), clusters, and aggregate stats.
   *
   * @throws When backed by standalone SQLite (requires CognitiveMemoryManager)
   * @returns Graph snapshot suitable for JSON serialization
   */
  async getGraph(): Promise<MemoryGraphSnapshot> {
    this.ensureReady();
    if (!this.manager) {
      this.throwUnsupportedForStandalone('getGraph');
    }

    const graph = this.manager.getGraph();
    const store = this.manager.getStore();

    // Build nodes from trace cache
    const nodes: MemoryGraphSnapshot['nodes'] = [];
    const allTraces = store.listTraces?.({ activeOnly: true }) ?? [];
    for (const trace of allTraces) {
      nodes.push({
        id: trace.id,
        type: trace.type,
        content: trace.content,
        strength: trace.encodingStrength,
        isFlashbulb: trace.encodingStrength >= 0.8,
        createdAt: trace.createdAt,
        lastAccessedAt: trace.lastAccessedAt,
        retrievalCount: trace.retrievalCount,
      });
    }

    // Build edges and clusters from graph (if available)
    const edges: MemoryGraphSnapshot['edges'] = [];
    let clusters: MemoryGraphSnapshot['clusters'] = [];

    if (graph) {
      // Collect edges from all nodes
      for (const node of nodes) {
        const nodeEdges = graph.getEdges(node.id);
        for (const edge of nodeEdges) {
          // Avoid duplicates (edges are bidirectional)
          if (edge.sourceId <= edge.targetId) {
            edges.push({
              sourceId: edge.sourceId,
              targetId: edge.targetId,
              type: edge.type,
              weight: edge.weight,
            });
          }
        }
      }

      // Detect clusters
      try {
        clusters = (await graph.detectClusters(3)).map((c) => ({
          clusterId: c.clusterId,
          memberIds: c.memberIds,
          density: c.density,
        }));
      } catch {
        // Clustering is non-critical
      }
    }

    return {
      nodes,
      edges,
      clusters,
      stats: {
        nodeCount: nodes.length,
        edgeCount: edges.length,
        clusterCount: clusters.length,
      },
    };
  }

  /**
   * Get spreading activation results from seed memories.
   * Returns memories that are associatively connected to the seeds.
   *
   * @param seedTraceIds - IDs of seed traces to activate from
   * @param opts - Optional depth and limit controls
   * @throws When backed by standalone SQLite
   */
  async getAssociations(
    seedTraceIds: string[],
    opts?: { maxDepth?: number; limit?: number }
  ): Promise<Array<{ memoryId: string; activation: number }>> {
    this.ensureReady();
    if (!this.manager) {
      this.throwUnsupportedForStandalone('getAssociations');
    }

    const graph = this.manager.getGraph();
    if (!graph) return [];

    const results = await graph.spreadingActivation(seedTraceIds, {
      maxDepth: opts?.maxDepth,
      maxResults: opts?.limit,
    });
    return results.map((r) => ({ memoryId: r.memoryId, activation: r.activation }));
  }

  /**
   * Get all traces filtered by memory type.
   *
   * @param type - Memory type to filter by (episodic, semantic, procedural, prospective, relational)
   * @param opts - Optional limit and minimum strength filter
   * @throws When backed by standalone SQLite
   */
  async getTracesByType(
    type: MemoryType,
    opts?: { limit?: number; minStrength?: number }
  ): Promise<ScoredMemoryTrace[]> {
    this.ensureReady();
    if (!this.manager) {
      this.throwUnsupportedForStandalone('getTracesByType');
    }

    const result = await this.manager.retrieve('', { valence: 0, arousal: 0, dominance: 0 }, {
      types: [type],
      topK: opts?.limit ?? 50,
      minConfidence: opts?.minStrength,
    });
    return result.retrieved;
  }

  /**
   * Get relational memory traces (trust signals, boundaries, emotional bonds).
   * Convenience wrapper around getTracesByType('relational').
   */
  async getRelationalMemories(opts?: { limit?: number }): Promise<ScoredMemoryTrace[]> {
    return this.getTracesByType('relational', opts);
  }

  /**
   * Get memory strength distribution by type.
   * Returns count, average strength, decaying count, and flashbulb count per type.
   *
   * @throws When backed by standalone SQLite
   */
  async getStrengthDistribution(): Promise<Record<MemoryType, MemoryTypeStats>> {
    this.ensureReady();
    if (!this.manager) {
      this.throwUnsupportedForStandalone('getStrengthDistribution');
    }

    const store = this.manager.getStore();
    const allTraces = store.listTraces?.({ activeOnly: true }) ?? [];

    const dist: Record<string, MemoryTypeStats> = {
      episodic: { count: 0, avgStrength: 0, decaying: 0, flashbulb: 0 },
      semantic: { count: 0, avgStrength: 0, decaying: 0, flashbulb: 0 },
      procedural: { count: 0, avgStrength: 0, decaying: 0, flashbulb: 0 },
      prospective: { count: 0, avgStrength: 0, decaying: 0, flashbulb: 0 },
      relational: { count: 0, avgStrength: 0, decaying: 0, flashbulb: 0 },
    };

    // Accumulate totals per type
    const strengthSums: Record<string, number> = {};
    for (const trace of allTraces) {
      const entry = dist[trace.type];
      if (!entry) continue;
      entry.count++;
      strengthSums[trace.type] = (strengthSums[trace.type] ?? 0) + trace.encodingStrength;
      if (trace.encodingStrength < 0.3) entry.decaying++;
      if (trace.encodingStrength >= 0.8) entry.flashbulb++;
    }

    // Compute averages
    for (const type of Object.keys(dist)) {
      if (dist[type].count > 0) {
        dist[type].avgStrength = (strengthSums[type] ?? 0) / dist[type].count;
      }
    }

    return dist as Record<MemoryType, MemoryTypeStats>;
  }

  /**
   * Get pairs of contradicting memory traces.
   *
   * @throws When backed by standalone SQLite
   */
  async getConflicts(): Promise<Array<{ traceA: string; traceB: string; type: string }>> {
    this.ensureReady();
    if (!this.manager) {
      this.throwUnsupportedForStandalone('getConflicts');
    }

    const graph = this.manager.getGraph();
    if (!graph) return [];

    const store = this.manager.getStore();
    const allTraces = store.listTraces?.({ activeOnly: true }) ?? [];
    const conflicts: Array<{ traceA: string; traceB: string; type: string }> = [];

    for (const trace of allTraces) {
      const contradictions = graph.getConflicts(trace.id);
      for (const edge of contradictions) {
        // Avoid duplicates
        if (edge.sourceId < edge.targetId) {
          conflicts.push({ traceA: edge.sourceId, traceB: edge.targetId, type: edge.type });
        }
      }
    }

    return conflicts;
  }

  /**
   * Get clusters of strongly associated memories.
   *
   * @param minSize - Minimum cluster size (default 3)
   * @throws When backed by standalone SQLite
   */
  async getClusters(minSize?: number): Promise<Array<{ clusterId: string; memberIds: string[]; density: number }>> {
    this.ensureReady();
    if (!this.manager) {
      this.throwUnsupportedForStandalone('getClusters');
    }

    const graph = this.manager.getGraph();
    if (!graph) return [];

    return graph.detectClusters(minSize ?? 3);
  }

  /**
   * Get working memory slots — what's currently "in focus".
   *
   * @throws When backed by standalone SQLite
   */
  async getWorkingMemory(): Promise<WorkingMemorySlot[]> {
    this.ensureReady();
    if (!this.manager) {
      this.throwUnsupportedForStandalone('getWorkingMemory');
    }

    return this.manager.getWorkingMemory().getSlots();
  }

  /**
   * Get observation pipeline stats (pending notes, compression ratio, reflection count).
   *
   * @throws When backed by standalone SQLite
   */
  async getObservationStats(): Promise<ObservationPipelineStats> {
    this.ensureReady();
    if (!this.manager) {
      this.throwUnsupportedForStandalone('getObservationStats');
    }

    const observer = this.manager.getObserver();
    return {
      pendingNotes: observer?.getAccumulatedNoteCount() ?? 0,
      pendingCompressed: observer?.getAccumulatedCompressedCount() ?? 0,
      totalNotesProduced: 0, // TODO: expose counter from observer
      totalReflectionsProduced: 0, // TODO: expose counter from reflector
      lastReflectionAt: null,
      avgCompressionRatio: 0,
    };
  }

  /**
   * Get active prospective memory items (reminders/intentions).
   * Alias for `reminders()` with a more descriptive name.
   */
  async getProspectiveItems(): Promise<ProspectiveMemoryItem[]> {
    return this.reminders();
  }

  /**
   * Force a reflection cycle (useful for testing / devtools).
   * Triggers the Observer's note extraction and the Reflector's consolidation
   * regardless of token thresholds.
   *
   * @throws When backed by standalone SQLite
   * @returns Reflection result with typed traces, or empty result if no observer
   */
  async forceReflection(): Promise<{ traces: number; superseded: number }> {
    this.ensureReady();
    if (!this.manager) {
      this.throwUnsupportedForStandalone('forceReflection');
    }

    const observer = this.manager.getObserver();
    if (!observer) return { traces: 0, superseded: 0 };

    // Force extract notes
    const notes = await observer.extractNotes();
    if (notes.length === 0) return { traces: 0, superseded: 0 };

    // Force reflect
    const reflector = (this.manager as any).reflector;
    if (!reflector) return { traces: 0, superseded: 0 };

    // Add notes and force reflection
    for (const note of notes) {
      reflector.pendingNotes = reflector.pendingNotes ?? [];
      reflector.pendingNotes.push(note);
    }
    const result = await reflector.reflect();
    return {
      traces: result.traces.length,
      superseded: result.supersededTraceIds.length,
    };
  }

  /**
   * Export full memory state as a serializable snapshot.
   * Used for companion portability across worlds in wilds-ai.
   *
   * @throws When backed by standalone SQLite
   */
  async exportSnapshot(): Promise<CognitiveMemorySnapshot> {
    this.ensureReady();
    if (!this.manager) {
      this.throwUnsupportedForStandalone('exportSnapshot');
    }

    const store = this.manager.getStore();
    const allTraces = store.listTraces?.({ activeOnly: true }) ?? [];
    const graph = this.manager.getGraph();
    const prospective = await (this.manager.listProspective?.() ?? []);

    // Collect graph edges
    const graphEdges: CognitiveMemorySnapshot['graphEdges'] = [];
    if (graph) {
      for (const trace of allTraces) {
        for (const edge of graph.getEdges(trace.id)) {
          if (edge.sourceId <= edge.targetId) {
            graphEdges.push({
              sourceId: edge.sourceId,
              targetId: edge.targetId,
              type: edge.type,
              weight: edge.weight,
              createdAt: edge.createdAt,
            });
          }
        }
      }
    }

    // Type distribution
    const typeDistribution: Record<string, number> = {
      episodic: 0, semantic: 0, procedural: 0, prospective: 0, relational: 0,
    };
    for (const trace of allTraces) {
      typeDistribution[trace.type] = (typeDistribution[trace.type] ?? 0) + 1;
    }

    return {
      version: '1.0.0',
      agentId: this.manager.getConfig().agentId,
      traces: allTraces,
      graphEdges,
      prospectiveItems: prospective.map((p) => ({
        id: p.id,
        content: p.content,
        triggerType: p.triggerType,
        importance: p.importance,
        triggered: p.triggered,
        createdAt: p.createdAt,
      })),
      metadata: {
        exportedAt: Date.now(),
        traceCount: allTraces.length,
        typeDistribution: typeDistribution as Record<MemoryType, number>,
      },
    };
  }

  /**
   * Import a memory snapshot (for character portability across worlds).
   * Encodes each trace and registers prospective items.
   *
   * @param snapshot - Previously exported snapshot
   * @throws When backed by standalone SQLite
   * @returns Count of imported traces and conflicts detected
   */
  async importSnapshot(snapshot: CognitiveMemorySnapshot): Promise<{ imported: number; conflicts: number }> {
    this.ensureReady();
    if (!this.manager) {
      this.throwUnsupportedForStandalone('importSnapshot');
    }

    let imported = 0;
    let conflicts = 0;

    for (const trace of snapshot.traces) {
      try {
        await this.manager.encode(
          trace.content,
          trace.emotionalContext ?? { valence: 0, arousal: 0, dominance: 0 },
          trace.emotionalContext?.gmiMood ?? 'neutral',
          {
            type: trace.type,
            scope: trace.scope,
            scopeId: trace.scopeId,
            sourceType: trace.provenance?.sourceType ?? 'external',
            tags: trace.tags,
            entities: trace.entities,
          }
        );
        imported++;
      } catch {
        conflicts++;
      }
    }

    // Re-register prospective items
    for (const item of snapshot.prospectiveItems) {
      if (!item.triggered) {
        try {
          await this.manager.registerProspective?.({
            content: item.content,
            triggerType: item.triggerType as any,
            importance: item.importance,
            recurring: false,
          });
        } catch {
          // Non-critical
        }
      }
    }

    return { imported, conflicts };
  }

  get isInitialized(): boolean {
    return this._initialized;
  }

  /** Access the underlying manager for advanced usage. */
  get raw(): ICognitiveMemoryManager {
    if (!this.manager) {
      throw new Error(
        'AgentMemory.raw is only available when backed by CognitiveMemoryManager. ' +
        'Use rawMemory for the standalone SQLite-backed Memory facade.',
      );
    }
    return this.manager;
  }

  /** Access the underlying standalone Memory facade for advanced usage. */
  get rawMemory(): StandaloneMemoryBackend | undefined {
    return this.standalone;
  }

  private ensureReady(): void {
    if (!this._initialized) {
      throw new Error(
        'AgentMemory not initialized. Call await memory.initialize(config), ' +
        'use AgentMemory.wrap(existingManager), or create a standalone instance with AgentMemory.sqlite(...).',
      );
    }
  }

  private async recallFromStandalone(query: string, options?: SearchOptions): Promise<RecallResult> {
    const requestedLimit = options?.limit ?? 10;
    const requestedTypes = options?.types ?? [];
    const needsPostFilter =
      requestedTypes.length > 1 ||
      (options?.tags?.length ?? 0) > 0 ||
      options?.minConfidence !== undefined;

    const resultLimit = needsPostFilter
      ? Math.max(requestedLimit * 3, 50)
      : requestedLimit;

    const recalled = await this.standalone!.recall(query, {
      limit: resultLimit,
      ...(requestedTypes.length === 1 ? { type: requestedTypes[0] } : {}),
    });

    const filtered = recalled.filter(({ trace }) => {
      if (requestedTypes.length > 1 && !requestedTypes.includes(trace.type)) {
        return false;
      }
      if ((options?.tags?.length ?? 0) > 0) {
        const traceTags = new Set(trace.tags);
        if (!options!.tags!.every((tag) => traceTags.has(tag))) {
          return false;
        }
      }
      if (
        options?.minConfidence !== undefined &&
        trace.provenance.confidence < options.minConfidence
      ) {
        return false;
      }
      return true;
    });

    return {
      memories: filtered.slice(0, requestedLimit).map(({ trace, score }) => ({
        ...trace,
        retrievalScore: score,
        scoreBreakdown: {
          strengthScore: trace.encodingStrength,
          similarityScore: score,
          recencyScore: 0,
          emotionalCongruenceScore: 0,
          graphActivationScore: 0,
          importanceScore: trace.provenance.confidence,
        },
      })),
      partial: [],
      diagnostics: {
        candidatesScanned: recalled.length,
        vectorSearchTimeMs: 0,
        scoringTimeMs: 0,
        totalTimeMs: 0,
      },
    };
  }

  private mapStandaloneHealth(health: StandaloneMemoryHealth): MemoryHealthReport {
    return {
      totalTraces: health.totalTraces,
      activeTraces: health.activeTraces,
      avgStrength: health.avgStrength,
      weakestTraceStrength: health.weakestTraceStrength,
      workingMemoryUtilization: 0,
      ...(health.lastConsolidation
        ? { lastConsolidationAt: Date.parse(health.lastConsolidation) }
        : {}),
      tracesPerType: {
        episodic: health.tracesPerType.episodic ?? 0,
        semantic: health.tracesPerType.semantic ?? 0,
        procedural: health.tracesPerType.procedural ?? 0,
        prospective: health.tracesPerType.prospective ?? 0,
        relational: health.tracesPerType.relational ?? 0,
      },
      tracesPerScope: {
        thread: health.tracesPerScope.thread ?? 0,
        user: health.tracesPerScope.user ?? 0,
        persona: health.tracesPerScope.persona ?? 0,
        organization: health.tracesPerScope.organization ?? 0,
      },
    };
  }

  private throwUnsupportedForStandalone(methodName: string): never {
    throw new Error(
      `AgentMemory.${methodName}() requires a CognitiveMemoryManager-backed instance. ` +
      `Use AgentMemory.wrap(existingManager) for observer, prompt-assembly, and reminder APIs.`,
    );
  }

  private throwUnsupportedForCognitive(methodName: string): never {
    throw new Error(
      `AgentMemory.${methodName}() requires the standalone SQLite-backed Memory facade. ` +
      `Use AgentMemory.sqlite(...) or import { Memory } from '@framers/agentos'.`,
    );
  }
}
