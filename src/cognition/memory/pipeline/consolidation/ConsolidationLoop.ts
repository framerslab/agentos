/**
 * @fileoverview ConsolidationLoop — self-improving background memory maintenance.
 *
 * Runs 6 ordered consolidation steps that mirror the brain's offline
 * slow-wave-sleep consolidation process:
 *
 * 1. **Prune** — soft-delete traces whose Ebbinghaus strength has decayed
 *    below the configurable `pruneThreshold`.
 * 2. **Merge** — deduplicate near-identical traces. Uses embedding cosine
 *    similarity when available, falls back to exact content-hash comparison.
 * 3. **Strengthen** — read retrieval-feedback co-usage signals and record
 *    Hebbian co-activation edges in the memory graph.
 * 4. **Derive** — (requires LLM) detect clusters of related memories and
 *    synthesise higher-level insight traces from them.
 * 5. **Compact** — promote old, high-retrieval episodic traces to semantic
 *    type (lightweight episodic-to-semantic migration).
 * 6. **Re-index** — rebuild the FTS5 index and log the consolidation run
 *    to the `consolidation_log` table.
 *
 * A simple boolean mutex prevents concurrent runs. If `run()` is called
 * while a cycle is already in progress, it returns immediately with zero
 * counts.
 *
 * @module agentos/memory/consolidation/ConsolidationLoop
 */

import { sha256 } from '../../core/util/crossPlatformCrypto.js';
import type { ConsolidationResult, ExtendedConsolidationConfig } from '../../io/facade/types.js';
import type { Brain } from '../../retrieval/store/Brain.js';
import type { IMemoryGraph } from '../../retrieval/graph/IMemoryGraph.js';
import type { PersonalityMutationStore } from '../../../emergent/PersonalityMutationStore.js';
import { computeCurrentStrength } from '../../core/decay/DecayModel.js';
import type { MemoryTrace, MemoryType, MemoryScope } from '../../core/types.js';
import {
  buildInitialTraceMetadata,
  parseTraceMetadata,
  readPersistedDecayState,
  withPersistedDecayState,
} from '../../retrieval/store/tracePersistence.js';

// ---------------------------------------------------------------------------
// Internal row type for memory_traces queries
// ---------------------------------------------------------------------------

/** Raw row shape returned by SQLite queries on `memory_traces`. */
interface TraceRow {
  id: string;
  type: string;
  scope: string;
  content: string;
  embedding: Buffer | null;
  strength: number;
  created_at: number;
  last_accessed: number | null;
  retrieval_count: number;
  tags: string;
  emotions: string;
  metadata: string;
  deleted: number;
}

/** Row shape for retrieval_feedback co-usage queries. */
interface FeedbackCoUsageRow {
  trace_id: string;
  query: string | null;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default prune threshold — traces weaker than this are soft-deleted. */
const DEFAULT_PRUNE_THRESHOLD = 0.05;

/** Default merge threshold — cosine similarity above this triggers merge. */
const DEFAULT_MERGE_THRESHOLD = 0.95;

/** Default max new insights derived per consolidation cycle. */
const DEFAULT_MAX_DERIVED = 5;

/** Default minimum cluster size for the derive step. */
const DEFAULT_MIN_CLUSTER_SIZE = 5;

/** Age threshold for compact step (7 days in ms). */
const COMPACT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Minimum retrieval count for an episodic trace to be compacted. */
const COMPACT_MIN_RETRIEVAL_COUNT = 3;

// ---------------------------------------------------------------------------
// ConsolidationLoop
// ---------------------------------------------------------------------------

/**
 * Self-improving background consolidation loop with 6 ordered steps:
 * prune, merge, strengthen, derive, compact, re-index.
 *
 * All database operations use the async `StorageAdapter` API through
 * the shared {@link Brain} connection. The `run()` method is async
 * to accommodate both the database calls and the LLM-backed derive step.
 */
export class ConsolidationLoop {
  /**
   * Simple mutex flag. When `true`, a consolidation cycle is in progress
   * and any concurrent `run()` call returns immediately with zero counts.
   */
  private _running = false;

  /**
   * @param brain       - The agent's SQLite brain database connection.
   * @param memoryGraph - The memory association graph for co-activation and clustering.
   * @param options     - Optional LLM invoker, embedding function, and
   *   personality mutation store for derive, merge, and decay steps respectively.
   */
  constructor(
    private readonly brain: Brain,
    private readonly memoryGraph: IMemoryGraph,
    private readonly options?: {
      /** LLM function for deriving insights from memory clusters. */
      llmInvoker?: (prompt: string) => Promise<string>;
      /** Embedding function for computing trace similarity. */
      embedFn?: (texts: string[]) => Promise<number[][]>;
      /**
       * Optional personality mutation store for Ebbinghaus-style decay.
       *
       * When provided, each consolidation cycle decays all active personality
       * mutations and prunes those whose strength falls below the threshold.
       */
      personalityMutationStore?: PersonalityMutationStore;
      /**
       * Decay rate subtracted from each personality mutation's strength per cycle.
       * Mutations at or below 0.1 after decay are pruned.
       * @default 0.05
       */
      personalityDecayRate?: number;
    },
  ) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Run one full consolidation cycle.
   *
   * The mutex prevents concurrent runs — if `_running` is already true,
   * returns immediately with a zero-count result.
   *
   * @param config - Optional overrides for consolidation thresholds.
   * @returns Consolidation statistics (pruned, merged, derived, compacted, durationMs).
   */
  async run(config?: Partial<ExtendedConsolidationConfig>): Promise<ConsolidationResult> {
    // Mutex guard — if already running, return zero-count result immediately.
    if (this._running) {
      return {
        pruned: 0,
        merged: 0,
        derived: 0,
        compacted: 0,
        durationMs: 0,
        personalityDecayed: 0,
      };
    }

    this._running = true;
    const startTime = Date.now();

    try {
      const pruneThreshold = config?.pruneThreshold ?? DEFAULT_PRUNE_THRESHOLD;
      const mergeThreshold = config?.mergeThreshold ?? DEFAULT_MERGE_THRESHOLD;
      const maxDerived = config?.maxDerivedPerCycle ?? DEFAULT_MAX_DERIVED;
      const minClusterSize = config?.minClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE;

      // Step 1: Prune
      const pruned = await this._prune(pruneThreshold);

      // Step 2: Merge
      const merged = await this._merge(mergeThreshold);

      // Step 3: Strengthen (co-activation from feedback)
      const strengthened = await this._strengthen();

      // Step 4: Derive (requires LLM)
      const derived = await this._derive(minClusterSize, maxDerived);

      // Step 5: Compact (episodic → semantic promotion)
      const compacted = await this._compact();

      // Step 5.5: Personality mutation decay (between compact and reindex)
      const personalityDecayed = await this._decayPersonality();

      // Step 6: Re-index (FTS rebuild + consolidation log)
      const durationMs = Date.now() - startTime;
      await this._reindex(pruned, merged, derived + strengthened, compacted, durationMs);

      return {
        pruned,
        merged,
        derived: derived + strengthened,
        compacted,
        durationMs,
        personalityDecayed,
      };
    } finally {
      this._running = false;
    }
  }

  /**
   * Whether consolidation is currently running.
   * Useful for callers to check before scheduling a new run.
   */
  get isRunning(): boolean {
    return this._running;
  }

  // ---------------------------------------------------------------------------
  // Step 1: Prune — soft-delete traces below strength threshold
  // ---------------------------------------------------------------------------

  /**
   * Query all non-deleted traces and soft-delete those whose current
   * Ebbinghaus strength has decayed below `threshold`.
   *
   * @param threshold - Minimum strength to survive pruning.
   * @returns Number of traces pruned.
   */
  private async _prune(threshold: number): Promise<number> {
    const now = Date.now();
    const brainId = this.brain.brainId;
    const rows = await this.brain.all<TraceRow>(
      `SELECT id, type, scope, content, embedding, strength, created_at,
              last_accessed, retrieval_count, tags, emotions, metadata, deleted
       FROM memory_traces
       WHERE brain_id = ? AND deleted = 0`,
      [brainId],
    );

    let pruned = 0;

    for (const row of rows) {
      const trace = this._rowToMinimalTrace(row);
      const strength = computeCurrentStrength(trace, now);
      if (strength < threshold) {
        await this.brain.run(
          `UPDATE memory_traces SET deleted = 1 WHERE brain_id = ? AND id = ?`,
          [brainId, row.id],
        );
        pruned++;
      }
    }

    return pruned;
  }

  // ---------------------------------------------------------------------------
  // Step 2: Merge — deduplicate near-identical traces
  // ---------------------------------------------------------------------------

  /**
   * Find and merge trace pairs with very similar content.
   *
   * When an embedding function is available, cosine similarity is used.
   * Otherwise falls back to exact content hash comparison (SHA-256).
   *
   * Merge semantics:
   * - The trace with more retrievals survives; the other is soft-deleted.
   * - Tags are unioned (JSON arrays merged, deduplicated).
   * - Emotional vectors are averaged.
   * - The survivor takes the maximum strength of the pair.
   *
   * @param threshold - Cosine similarity above which two traces are merged.
   * @returns Number of traces merged (deleted).
   */
  private async _merge(threshold: number): Promise<number> {
    const rows = await this.brain.all<TraceRow>(
      `SELECT id, type, scope, content, embedding, strength, created_at,
              last_accessed, retrieval_count, tags, emotions, metadata, deleted
       FROM memory_traces
       WHERE brain_id = ? AND deleted = 0`,
      [this.brain.brainId],
    );

    if (rows.length < 2) return 0;

    let merged = 0;
    const deletedIds = new Set<string>();

    if (this.options?.embedFn) {
      // Embedding-based merge: compute all embeddings, then compare pairwise.
      const texts = rows.map((r) => r.content);
      const embeddings = await this.options.embedFn(texts);

      for (let i = 0; i < rows.length; i++) {
        if (deletedIds.has(rows[i]!.id)) continue;
        for (let j = i + 1; j < rows.length; j++) {
          if (deletedIds.has(rows[j]!.id)) continue;
          const sim = this._cosineSimilarity(embeddings[i]!, embeddings[j]!);
          if (sim >= threshold) {
            await this._mergeTracePair(rows[i]!, rows[j]!, deletedIds);
            merged++;
          }
        }
      }
    } else {
      // Fallback: exact content hash comparison.
      const hashMap = new Map<string, TraceRow>();

      for (const row of rows) {
        if (deletedIds.has(row.id)) continue;
        const hash = await sha256(row.content);
        const existing = hashMap.get(hash);
        if (existing && !deletedIds.has(existing.id)) {
          await this._mergeTracePair(existing, row, deletedIds);
          merged++;
        } else {
          hashMap.set(hash, row);
        }
      }
    }

    return merged;
  }

  /**
   * Merge two traces: keep the one with more retrievals, soft-delete the other.
   * Union tags, average emotions, take max strength.
   *
   * @param a          - First trace row.
   * @param b          - Second trace row.
   * @param deletedIds - Set tracking which IDs have been soft-deleted this cycle.
   */
  private async _mergeTracePair(a: TraceRow, b: TraceRow, deletedIds: Set<string>): Promise<void> {
    const survivor = a.retrieval_count >= b.retrieval_count ? a : b;
    const loser = survivor === a ? b : a;

    // Union tags.
    let survivorTags: string[] = [];
    let loserTags: string[] = [];
    try { survivorTags = JSON.parse(survivor.tags); } catch { /* empty */ }
    try { loserTags = JSON.parse(loser.tags); } catch { /* empty */ }
    const mergedTags = [...new Set([...survivorTags, ...loserTags])];

    // Average emotions.
    let survivorEmotions: Record<string, number> = {};
    let loserEmotions: Record<string, number> = {};
    try { survivorEmotions = JSON.parse(survivor.emotions); } catch { /* empty */ }
    try { loserEmotions = JSON.parse(loser.emotions); } catch { /* empty */ }
    const avgEmotions = this._averageEmotions(survivorEmotions, loserEmotions);

    // Max strength.
    const maxStrength = Math.max(survivor.strength, loser.strength);
    const survivorMetadata = parseTraceMetadata(survivor.metadata);
    const loserMetadata = parseTraceMetadata(loser.metadata);
    const survivorDecay = readPersistedDecayState(survivorMetadata, survivor.retrieval_count);
    const loserDecay = readPersistedDecayState(loserMetadata, loser.retrieval_count);
    const mergedLastAccessed = Math.max(
      survivor.last_accessed ?? survivor.created_at,
      loser.last_accessed ?? loser.created_at,
    );
    // Provenance audit: merging a near-duplicate is the canonical "external
    // confirmation" event for the survivor. Bump verificationCount by 1 +
    // any pre-existing count the loser carried, and stamp lastVerifiedAt so
    // downstream policy (trust gating, freshness checks) can see when the
    // survivor was last confirmed against a corroborating memory.
    const survivorVerificationCount =
      typeof survivorMetadata.verificationCount === 'number'
        ? survivorMetadata.verificationCount
        : 0;
    const loserVerificationCount =
      typeof loserMetadata.verificationCount === 'number'
        ? loserMetadata.verificationCount
        : 0;
    const mergedVerificationCount = survivorVerificationCount + loserVerificationCount + 1;

    const mergedMetadata = JSON.stringify({
      ...withPersistedDecayState(survivorMetadata, {
        stability: Math.max(survivorDecay.stability, loserDecay.stability),
        accessCount: survivorDecay.accessCount + loserDecay.accessCount,
        reinforcementInterval: Math.max(
          survivorDecay.reinforcementInterval,
          loserDecay.reinforcementInterval,
        ),
        ...((survivorDecay.nextReinforcementAt !== undefined ||
          loserDecay.nextReinforcementAt !== undefined)
          ? {
              nextReinforcementAt: Math.max(
                survivorDecay.nextReinforcementAt ?? 0,
                loserDecay.nextReinforcementAt ?? 0,
              ),
            }
          : {}),
      }),
      verificationCount: mergedVerificationCount,
      lastVerifiedAt: Date.now(),
    });

    // Update survivor.
    await this.brain.run(
      `UPDATE memory_traces
       SET tags = ?, emotions = ?, strength = ?, retrieval_count = ?, last_accessed = ?, metadata = ?
       WHERE brain_id = ? AND id = ?`,
      [
        JSON.stringify(mergedTags),
        JSON.stringify(avgEmotions),
        maxStrength,
        survivor.retrieval_count + loser.retrieval_count,
        mergedLastAccessed,
        mergedMetadata,
        this.brain.brainId,
        survivor.id,
      ],
    );

    // Soft-delete loser.
    await this.brain.run(
      `UPDATE memory_traces SET deleted = 1 WHERE brain_id = ? AND id = ?`,
      [this.brain.brainId, loser.id],
    );

    deletedIds.add(loser.id);
  }

  // ---------------------------------------------------------------------------
  // Step 3: Strengthen — co-activation from retrieval feedback
  // ---------------------------------------------------------------------------

  /**
   * Query the `retrieval_feedback` table for traces that were co-used
   * (same query string, both with signal = 'used') and record Hebbian
   * co-activation edges in the memory graph.
   *
   * @returns Number of co-activation pairs strengthened.
   */
  private async _strengthen(): Promise<number> {
    const brainId = this.brain.brainId;
    // Find all queries where at least 2 traces were 'used'.
    const queryRows = await this.brain.all<{ query: string }>(
      `SELECT query FROM retrieval_feedback
       WHERE brain_id = ? AND signal = 'used' AND query IS NOT NULL
       GROUP BY query
       HAVING COUNT(DISTINCT trace_id) >= 2`,
      [brainId],
    );

    let strengthened = 0;

    for (const { query } of queryRows) {
      const traceRows = await this.brain.all<FeedbackCoUsageRow>(
        `SELECT DISTINCT trace_id, query FROM retrieval_feedback
         WHERE brain_id = ? AND signal = 'used' AND query = ?`,
        [brainId, query],
      );

      const traceIds = traceRows.map((r) => r.trace_id);
      if (traceIds.length >= 2) {
        // Ensure nodes exist before recording co-activation.
        for (const id of traceIds) {
          if (!this.memoryGraph.hasNode(id)) {
            await this.memoryGraph.addNode(id, {
              type: 'episodic',
              scope: 'thread',
              scopeId: 'consolidation',
              strength: 1.0,
              createdAt: Date.now(),
            });
          }
        }
        await this.memoryGraph.recordCoActivation(traceIds);
        strengthened++;
      }
    }

    return strengthened;
  }

  // ---------------------------------------------------------------------------
  // Step 4: Derive — LLM-based insight synthesis from clusters
  // ---------------------------------------------------------------------------

  /**
   * Detect memory clusters and use the LLM to derive higher-level insights.
   *
   * Skips entirely if no `llmInvoker` was provided. For each of the top-N
   * clusters (by size), collects member trace contents and sends them to the
   * LLM with a concise instruction prompt.
   *
   * @param minClusterSize - Minimum cluster size for `detectClusters()`.
   * @param maxDerived     - Maximum number of insights to create this cycle.
   * @returns Number of insight traces created.
   */
  private async _derive(minClusterSize: number, maxDerived: number): Promise<number> {
    if (!this.options?.llmInvoker) return 0;

    const clusters = await this.memoryGraph.detectClusters(minClusterSize);
    if (clusters.length === 0) return 0;

    // Sort by cluster size descending, take top N.
    const sorted = [...clusters].sort((a, b) => b.memberIds.length - a.memberIds.length);
    const topClusters = sorted.slice(0, maxDerived);

    let derived = 0;

    for (const cluster of topClusters) {
      // Collect content from cluster member traces.
      const contents: string[] = [];
      for (const memberId of cluster.memberIds) {
        const row = await this.brain.get<{ content: string }>(
          `SELECT content FROM memory_traces WHERE brain_id = ? AND id = ? AND deleted = 0`,
          [this.brain.brainId, memberId],
        );
        if (row) contents.push(row.content);
      }

      if (contents.length < 2) continue;

      try {
        const prompt =
          'Given these related memories, derive one concise higher-level insight:\n\n' +
          contents.join('\n');

        const insight = await this.options.llmInvoker(prompt);
        if (!insight?.trim()) continue;

        // Store as a new semantic trace.
        const now = Date.now();
        const id = `insight_${now}_${derived}`;

        await this.brain.run(
          `INSERT INTO memory_traces
             (brain_id, id, type, scope, content, strength, created_at, retrieval_count, tags, emotions, metadata, deleted)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            this.brain.brainId,
            id,
            'semantic',
            'user',
            insight.trim(),
            0.7,
            now,
            0,
            JSON.stringify(['derived', 'insight']),
            JSON.stringify({}),
            JSON.stringify(buildInitialTraceMetadata({ sourceCluster: cluster.clusterId })),
            0,
          ],
        );

        derived++;
      } catch {
        // LLM failures are non-critical; skip this cluster.
      }
    }

    return derived;
  }

  // ---------------------------------------------------------------------------
  // Step 5: Compact — episodic → semantic migration for old high-retrieval traces
  // ---------------------------------------------------------------------------

  /**
   * Find episodic traces older than 7 days with high retrieval count and
   * promote them to semantic type.
   *
   * This is a lightweight version of compaction — full LLM-based summarization
   * via the CompactionEngine is deferred. For now, the trace type is simply
   * changed to 'semantic' and the timestamp is logged.
   *
   * @returns Number of traces compacted.
   */
  private async _compact(): Promise<number> {
    const now = Date.now();
    const cutoff = now - COMPACT_AGE_MS;

    const brainId = this.brain.brainId;
    const rows = await this.brain.all<{ id: string }>(
      `SELECT id FROM memory_traces
       WHERE brain_id = ? AND deleted = 0
         AND type = 'episodic'
         AND created_at < ?
         AND retrieval_count >= ?`,
      [brainId, cutoff, COMPACT_MIN_RETRIEVAL_COUNT],
    );

    if (rows.length === 0) return 0;

    for (const row of rows) {
      await this.brain.run(
        `UPDATE memory_traces SET type = 'semantic' WHERE brain_id = ? AND id = ?`,
        [brainId, row.id],
      );
    }

    return rows.length;
  }

  // ---------------------------------------------------------------------------
  // Step 5.5: Personality decay — reduce mutation strengths and prune expired
  // ---------------------------------------------------------------------------

  /**
   * Decay all active personality mutations by the configured rate.
   *
   * Delegates to {@link PersonalityMutationStore.decayAll} when a store is
   * provided. Mutations whose strength drops at or below 0.1 are pruned.
   *
   * This step sits between compact and reindex to ensure personality decay
   * is captured in the same consolidation cycle as memory maintenance.
   *
   * @returns Number of personality mutations pruned (deleted), or 0 if no
   *   store is configured.
   */
  private async _decayPersonality(): Promise<number> {
    if (!this.options?.personalityMutationStore) {
      return 0;
    }

    const rate = this.options.personalityDecayRate ?? 0.05;

    try {
      const result = await this.options.personalityMutationStore.decayAll(rate);
      return result.decayed + result.pruned;
    } catch {
      // Personality decay failures are non-critical — do not block consolidation.
      return 0;
    }
  }

  // ---------------------------------------------------------------------------
  // Step 6: Re-index — FTS rebuild + consolidation log
  // ---------------------------------------------------------------------------

  /**
   * Rebuild the FTS5 index to reflect any content changes from the cycle,
   * and write a summary row to the `consolidation_log` table.
   *
   * @param pruned    - Number of traces pruned.
   * @param merged    - Number of traces merged.
   * @param derived   - Number of insights derived (includes strengthened edges).
   * @param compacted - Number of traces compacted.
   * @param durationMs - Total cycle duration in milliseconds.
   */
  private async _reindex(
    pruned: number,
    merged: number,
    derived: number,
    compacted: number,
    durationMs: number,
  ): Promise<void> {
    // Rebuild the brain's full-text index from its traces.
    try {
      const rebuild = this.brain.fullTextRebuild();
      await this.brain.run(rebuild.sql, rebuild.params);
    } catch {
      // FTS rebuild may fail if the table structure has drifted; non-critical.
    }

    // Log the consolidation run.
    await this.brain.run(
      `INSERT INTO consolidation_log (brain_id, ran_at, pruned, merged, derived, compacted, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [this.brain.brainId, Date.now(), pruned, merged, derived, compacted, durationMs],
    );
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Convert a raw `TraceRow` into a minimal `MemoryTrace`-compatible shape
   * that `computeCurrentStrength()` can consume.
   *
   * Only the fields required by the Ebbinghaus formula are populated:
   * `encodingStrength`, `stability` (derived from strength as a proxy),
   * and `lastAccessedAt`.
   *
   * @param row - Raw SQLite row from `memory_traces`.
   * @returns A minimal MemoryTrace object.
   */
  private _rowToMinimalTrace(row: TraceRow): MemoryTrace {
    const now = Date.now();
    const metadata = parseTraceMetadata(row.metadata);
    const decayState = readPersistedDecayState(metadata, row.retrieval_count);
    return {
      id: row.id,
      type: row.type as MemoryType,
      scope: row.scope as MemoryScope,
      scopeId: typeof metadata.scopeId === 'string' ? metadata.scopeId : '',
      content: row.content,
      entities: Array.isArray(metadata.entities)
        ? metadata.entities.filter((entity): entity is string => typeof entity === 'string')
        : [],
      tags: [],
      provenance: {
        sourceType: 'observation',
        sourceTimestamp: row.created_at,
        confidence: 1,
        verificationCount:
          typeof metadata.verificationCount === 'number' ? metadata.verificationCount : 0,
        lastVerifiedAt:
          typeof metadata.lastVerifiedAt === 'number' ? metadata.lastVerifiedAt : undefined,
        contradictedBy: Array.isArray(metadata.contradictedBy)
          ? (metadata.contradictedBy as string[])
          : undefined,
      },
      emotionalContext: {
        valence: 0,
        arousal: 0,
        dominance: 0,
        intensity: 0,
        gmiMood: 'neutral',
      },
      // The `strength` column stores the current encoding strength.
      encodingStrength: row.strength,
      stability: decayState.stability,
      retrievalCount: row.retrieval_count,
      lastAccessedAt: row.last_accessed ?? row.created_at,
      accessCount: decayState.accessCount,
      reinforcementInterval: decayState.reinforcementInterval,
      ...(decayState.nextReinforcementAt !== undefined
        ? { nextReinforcementAt: decayState.nextReinforcementAt }
        : {}),
      associatedTraceIds: [],
      createdAt: row.created_at,
      updatedAt: now,
      isActive: row.deleted === 0,
    };
  }

  /**
   * Compute cosine similarity between two embedding vectors.
   *
   * @param a - First vector.
   * @param b - Second vector.
   * @returns Cosine similarity in [-1, 1].
   */
  private _cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;

    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dot += a[i]! * b[i]!;
      normA += a[i]! * a[i]!;
      normB += b[i]! * b[i]!;
    }

    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  /**
   * Average two emotion objects by computing the mean of all shared numeric keys.
   *
   * @param a - First emotion record.
   * @param b - Second emotion record.
   * @returns Averaged emotion record.
   */
  private _averageEmotions(
    a: Record<string, number>,
    b: Record<string, number>,
  ): Record<string, number> {
    const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const result: Record<string, number> = {};

    for (const key of allKeys) {
      const va = a[key] ?? 0;
      const vb = b[key] ?? 0;
      result[key] = (va + vb) / 2;
    }

    return result;
  }
}
