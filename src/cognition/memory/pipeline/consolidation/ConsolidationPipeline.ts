/**
 * @fileoverview Consolidation Pipeline — background memory maintenance.
 *
 * Runs periodically (default: hourly) to maintain memory health:
 * 1. Decay sweep — apply Ebbinghaus to all traces, soft-delete below threshold
 * 2. Replay — re-process recent traces, find co-activation patterns, create graph edges
 * 3. Schema integration — cluster episodic traces, LLM-summarize into semantic nodes
 * 4. Conflict resolution — scan CONTRADICTS edges, resolve by confidence + personality
 * 5. Spaced repetition — boost traces past nextReinforcementAt
 * 6. Hybrid feature re-classification — if hybrid strategy, re-run LLM on keyword-only traces
 *
 * @module agentos/memory/consolidation/ConsolidationPipeline
 */

import type { MemoryTrace, MemoryType, MemoryScope } from '../../core/types.js';
import type { ConsolidationConfig, DecayConfig, HexacoTraits } from '../../core/config.js';
import { DEFAULT_DECAY_CONFIG } from '../../core/config.js';
import { computeCurrentStrength, findPrunableTraces } from '../../core/decay/DecayModel.js';
import type { IMemoryGraph, MemoryCluster } from '../../retrieval/graph/IMemoryGraph.js';
import type { MemoryStore } from '../../retrieval/store/MemoryStore.js';

/** Append `value` to `list` (creating it if absent) without producing a duplicate. */
function uniqueAppend(list: string[] | undefined, value: string): string[] {
  if (!list) return [value];
  if (list.includes(value)) return list;
  return [...list, value];
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConsolidationResult {
  /** Traces pruned (soft-deleted). */
  prunedCount: number;
  /** Co-activation edges created. */
  edgesCreated: number;
  /** Schema nodes created from episodic clusters. */
  schemasCreated: number;
  /** Conflicts resolved. */
  conflictsResolved: number;
  /** Traces reinforced via spaced repetition. */
  reinforcedCount: number;
  /** Total traces processed. */
  totalProcessed: number;
  /** Duration in ms. */
  durationMs: number;
  /** Archived traces dropped by retention sweep. */
  archivedPruned: number;
}

export interface ConsolidationPipelineConfig {
  store: MemoryStore;
  graph?: IMemoryGraph;
  traits: HexacoTraits;
  agentId: string;
  decay?: Partial<DecayConfig>;
  consolidation?: Partial<ConsolidationConfig>;
  /** LLM invoker for schema integration (optional). */
  llmInvoker?: (systemPrompt: string, userPrompt: string) => Promise<string>;
  /** Optional cognitive mechanisms engine for consolidation-time hooks. */
  mechanismsEngine?: import('../../mechanisms/CognitiveMechanismsEngine.js').CognitiveMechanismsEngine;
  /** Optional memory archive for retention sweep (step 7). */
  archive?: import('../../archive/IMemoryArchive.js').IMemoryArchive;
  /** Retention configuration for the archive sweep. */
  archiveRetention?: import('../../archive/IMemoryArchive.js').MemoryArchiveRetentionConfig;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONSOLIDATION: Required<ConsolidationConfig> = {
  enabled: true,
  intervalMs: 3_600_000,
  maxTracesPerCycle: 500,
  mergeSimilarityThreshold: 0.92,
  minClusterSize: 5,
  // Facade-level lifecycle extensions — defaults match ExtendedConsolidationConfig.
  trigger: 'interval',
  every: 3_600_000,
  pruneThreshold: 0.05,
  mergeThreshold: 0.92,
  deriveInsights: true,
  maxDerivedPerCycle: 10,
};

// ---------------------------------------------------------------------------
// ConsolidationPipeline
// ---------------------------------------------------------------------------

export class ConsolidationPipeline {
  private config: ConsolidationPipelineConfig;
  private consolidationConfig: Required<ConsolidationConfig>;
  private decayConfig: DecayConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRunAt: number = 0;

  constructor(config: ConsolidationPipelineConfig) {
    this.config = config;
    this.consolidationConfig = {
      ...DEFAULT_CONSOLIDATION,
      ...config.consolidation,
    };
    this.decayConfig = { ...DEFAULT_DECAY_CONFIG, ...config.decay };
  }

  /**
   * Start the periodic consolidation timer.
   *
   * The timer is `.unref()`'d so it does NOT keep the Node event loop
   * alive on its own. Long-running agents keep the process alive
   * through their own mechanisms (HTTP server, message bus, etc.);
   * short-lived contexts (benches, scripts) can exit cleanly once
   * their meaningful work completes. Callers that need a guaranteed
   * consolidation cycle before shutdown should call `runConsolidation()`
   * directly or trigger it via {@link CognitiveMemoryManager.runConsolidation}.
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => { void this.run(); },
      this.consolidationConfig.intervalMs,
    );
    // Allow Node to exit even if the timer is pending. Works on both
    // Node and jsdom; has no effect in the browser.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * Stop the periodic consolidation timer.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run a single consolidation cycle.
   */
  async run(): Promise<ConsolidationResult> {
    const startTime = Date.now();
    const result: ConsolidationResult = {
      prunedCount: 0,
      edgesCreated: 0,
      schemasCreated: 0,
      conflictsResolved: 0,
      reinforcedCount: 0,
      totalProcessed: 0,
      durationMs: 0,
      archivedPruned: 0,
    };

    const now = Date.now();

    // Gather traces from the store (scope: user for this agent)
    const traces = await this.config.store.getByScope('user' as MemoryScope, this.config.agentId);
    const batch = traces.slice(0, this.consolidationConfig.maxTracesPerCycle);
    result.totalProcessed = batch.length;

    // --- Step 1: Decay sweep ---
    result.prunedCount = await this.decaySweep(batch, now);

    // --- Step 2: Co-activation replay ---
    if (this.config.graph) {
      result.edgesCreated = await this.replayCoActivation(batch, now);
    }

    // --- Step 3: Schema integration ---
    if (this.config.graph && this.config.llmInvoker) {
      result.schemasCreated = await this.schemaIntegration();
    }

    // --- Step 4: Conflict resolution ---
    if (this.config.graph) {
      result.conflictsResolved = await this.resolveConflicts(batch);
    }

    // --- Step 5: Spaced repetition reinforcement ---
    result.reinforcedCount = await this.spacedRepetitionSweep(batch, now);

    // --- Step 6: Cognitive mechanisms (temporal gist, source decay, emotion regulation) ---
    if (this.config.mechanismsEngine) {
      const llmFn = this.config.llmInvoker
        ? (prompt: string) => this.config.llmInvoker!('You are a memory consolidation assistant.', prompt)
        : undefined;
      await this.config.mechanismsEngine.onConsolidation(batch, llmFn);
    }

    // --- Step 7: Prune archive (retention sweep with access-log awareness) ---
    result.archivedPruned = 0;
    if (this.config.archive) {
      const maxAgeMs = this.config.archiveRetention?.maxAgeMs ?? 365 * 86_400_000;
      const candidates = await this.config.archive.list({ olderThanMs: maxAgeMs });

      for (const candidate of candidates) {
        // Skip traces that were recently rehydrated — they're still in active use
        const lastAccess = await this.config.archive.lastAccessedAt(candidate.traceId);
        if (lastAccess !== null && (Date.now() - lastAccess) < maxAgeMs) {
          continue;
        }
        await this.config.archive.drop(candidate.traceId);
        result.archivedPruned++;
      }
    }

    result.durationMs = Date.now() - startTime;
    this.lastRunAt = now;
    return result;
  }

  /** Get timestamp of last consolidation run. */
  getLastRunAt(): number {
    return this.lastRunAt;
  }

  // =========================================================================
  // Step 1: Decay sweep
  // =========================================================================

  private async decaySweep(traces: MemoryTrace[], now: number): Promise<number> {
    const prunable = findPrunableTraces(traces, now, this.decayConfig);
    for (const traceId of prunable) {
      await this.config.store.softDelete(traceId);
    }
    return prunable.length;
  }

  // =========================================================================
  // Step 2: Co-activation replay
  // =========================================================================

  private async replayCoActivation(traces: MemoryTrace[], now: number): Promise<number> {
    if (!this.config.graph) return 0;

    let edgesCreated = 0;
    const recentTraces = traces.filter(
      (t) => t.isActive && (now - t.createdAt) < 86_400_000, // last 24 hours
    );

    // Find traces that share entities → create SHARED_ENTITY edges
    const entityIndex = new Map<string, string[]>();
    for (const trace of recentTraces) {
      for (const entity of trace.entities) {
        const list = entityIndex.get(entity) ?? [];
        list.push(trace.id);
        entityIndex.set(entity, list);
      }
    }

    for (const [, traceIds] of entityIndex) {
      if (traceIds.length < 2) continue;
      for (let i = 0; i < traceIds.length && i < 10; i++) {
        for (let j = i + 1; j < traceIds.length && j < 10; j++) {
          if (this.config.graph.hasNode(traceIds[i]) && this.config.graph.hasNode(traceIds[j])) {
            await this.config.graph.addEdge({
              sourceId: traceIds[i],
              targetId: traceIds[j],
              type: 'SHARED_ENTITY',
              weight: 0.5,
              createdAt: now,
            });
            edgesCreated++;
          }
        }
      }
    }

    // Find temporally adjacent traces → create TEMPORAL_SEQUENCE edges
    const sorted = [...recentTraces].sort((a, b) => a.createdAt - b.createdAt);
    for (let i = 0; i < sorted.length - 1; i++) {
      const gap = sorted[i + 1].createdAt - sorted[i].createdAt;
      if (gap < 300_000) { // Within 5 minutes
        if (this.config.graph.hasNode(sorted[i].id) && this.config.graph.hasNode(sorted[i + 1].id)) {
          await this.config.graph.addEdge({
            sourceId: sorted[i].id,
            targetId: sorted[i + 1].id,
            type: 'TEMPORAL_SEQUENCE',
            weight: 0.3,
            createdAt: now,
          });
          edgesCreated++;
        }
      }
    }

    return edgesCreated;
  }

  // =========================================================================
  // Step 3: Schema integration
  // =========================================================================

  private async schemaIntegration(): Promise<number> {
    if (!this.config.graph || !this.config.llmInvoker) return 0;

    const clusters = await this.config.graph.detectClusters(this.consolidationConfig.minClusterSize);
    let schemasCreated = 0;

    for (const cluster of clusters) {
      // Gather content from cluster members
      const contents: string[] = [];
      for (const id of cluster.memberIds) {
        const trace = this.config.store.getTrace(id);
        if (trace) contents.push(trace.content);
      }
      if (contents.length < this.consolidationConfig.minClusterSize) continue;

      try {
        const summary = await this.config.llmInvoker(
          'Summarize the following related memories into a single semantic knowledge statement. Be concise (1-2 sentences). Output only the summary.',
          contents.join('\n---\n'),
        );

        if (summary.trim()) {
          // Store as a new semantic trace
          const now = Date.now();
          const schemaTrace: MemoryTrace = {
            id: `schema_${now}_${schemasCreated}`,
            type: 'semantic',
            scope: 'user',
            scopeId: this.config.agentId,
            content: summary.trim(),
            entities: [],
            tags: ['schema', 'consolidated'],
            provenance: {
              sourceType: 'reflection',
              sourceTimestamp: now,
              confidence: 0.8,
              verificationCount: cluster.memberIds.length,
            },
            emotionalContext: { valence: 0, arousal: 0, dominance: 0, intensity: 0, gmiMood: '' },
            encodingStrength: 0.7,
            stability: 7_200_000, // 2 hours (schemas are more stable)
            retrievalCount: 0,
            lastAccessedAt: now,
            accessCount: 0,
            reinforcementInterval: 7_200_000,
            associatedTraceIds: cluster.memberIds,
            createdAt: now,
            updatedAt: now,
            consolidatedAt: now,
            isActive: true,
          };

          await this.config.store.store(schemaTrace);

          // Add SCHEMA_INSTANCE edges from cluster members to schema
          if (this.config.graph) {
            await this.config.graph.addNode(schemaTrace.id, {
              type: 'semantic',
              scope: 'user',
              scopeId: this.config.agentId,
              strength: 0.7,
              createdAt: now,
            });

            for (const memberId of cluster.memberIds) {
              if (this.config.graph.hasNode(memberId)) {
                await this.config.graph.addEdge({
                  sourceId: memberId,
                  targetId: schemaTrace.id,
                  type: 'SCHEMA_INSTANCE',
                  weight: 0.6,
                  createdAt: now,
                });
              }
            }
          }

          schemasCreated++;
        }
      } catch {
        // LLM failure is non-critical
      }
    }

    return schemasCreated;
  }

  // =========================================================================
  // Step 4: Conflict resolution
  // =========================================================================

  private async resolveConflicts(traces: MemoryTrace[]): Promise<number> {
    if (!this.config.graph) return 0;

    const clamp = (v: number | undefined): number => v == null ? 0.5 : Math.max(0, Math.min(1, v));
    const honesty = clamp(this.config.traits.honesty);
    let resolved = 0;

    /**
     * Record the contradiction relationship on both sides before discarding the
     * loser. The winner gains the loser in its `contradictedBy` list so future
     * readers know which memory tried to dispute it; the loser keeps the symmetric
     * record so a forensic inspection of an inactive trace explains what won.
     * Both updates also bump `lastVerifiedAt` because the conflict resolution
     * pass is itself a verification event for the winner.
     *
     * In-memory mutation only for now — the SQL schema does not yet have a
     * column for `contradictedBy`/`lastVerifiedAt`, so this audit trail is
     * scoped to the current process. Durable persistence is a follow-up.
     */
    const recordContradiction = (winner: MemoryTrace, loser: MemoryTrace): void => {
      const now = Date.now();
      winner.provenance.contradictedBy = uniqueAppend(
        winner.provenance.contradictedBy,
        loser.id,
      );
      winner.provenance.lastVerifiedAt = now;
      loser.provenance.contradictedBy = uniqueAppend(
        loser.provenance.contradictedBy,
        winner.id,
      );
      loser.provenance.lastVerifiedAt = now;
    };

    for (const trace of traces) {
      if (!trace.isActive) continue;
      const conflicts = this.config.graph.getConflicts(trace.id);

      for (const conflict of conflicts) {
        const otherId = conflict.sourceId === trace.id ? conflict.targetId : conflict.sourceId;
        const other = this.config.store.getTrace(otherId);
        if (!other || !other.isActive) continue;

        // Determine which trace to keep
        if (honesty > 0.6) {
          // High honesty: prefer newer information
          const loser = trace.createdAt > other.createdAt ? other : trace;
          const winner = loser === trace ? other : trace;
          recordContradiction(winner, loser);
          // Persist the winner's updated audit trail before the loser is
          // dropped. The loser keeps its symmetric record in-memory; the
          // softDelete also writes the deletion to SQL so future loads see
          // both sides of the contradiction.
          await this.config.store.persistTraceMetadata(winner.id);
          await this.config.store.persistTraceMetadata(loser.id);
          await this.config.store.softDelete(loser.id);
          resolved++;
        } else {
          // Default: prefer higher confidence
          if (Math.abs(trace.provenance.confidence - other.provenance.confidence) > 0.2) {
            const loser = trace.provenance.confidence < other.provenance.confidence ? trace : other;
            const winner = loser === trace ? other : trace;
            recordContradiction(winner, loser);
            await this.config.store.persistTraceMetadata(winner.id);
            await this.config.store.persistTraceMetadata(loser.id);
            await this.config.store.softDelete(loser.id);
            resolved++;
          }
          // If confidence is similar, let both coexist
        }
      }
    }

    return resolved;
  }

  // =========================================================================
  // Step 5: Spaced repetition sweep
  // =========================================================================

  private async spacedRepetitionSweep(traces: MemoryTrace[], now: number): Promise<number> {
    let reinforced = 0;

    for (const trace of traces) {
      if (!trace.isActive) continue;
      if (!trace.nextReinforcementAt) continue;
      if (now < trace.nextReinforcementAt) continue;

      // Boost the trace via recordAccess
      await this.config.store.recordAccess(trace.id);
      reinforced++;
    }

    return reinforced;
  }
}
