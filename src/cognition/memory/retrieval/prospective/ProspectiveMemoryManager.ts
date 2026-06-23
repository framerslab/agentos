/**
 * @fileoverview Prospective Memory Manager — goal/intention-triggered reminders.
 *
 * Prospective memory = memory for future intentions (e.g., "remind me to...",
 * "I need to...", "when X happens, do Y").
 *
 * Trigger types:
 * - time_based: Fires at or after a specified timestamp
 * - event_based: Fires when a named event occurs
 * - context_based: Fires when semantic similarity to a cue exceeds threshold
 *
 * Checked each turn before prompt construction. Triggered items are
 * injected into the "Reminders" section of the assembled memory context.
 *
 * @module agentos/memory/prospective/ProspectiveMemoryManager
 */

import type { IEmbeddingManager } from '../../../../core/embeddings/IEmbeddingManager.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProspectiveTriggerType = 'time_based' | 'event_based' | 'context_based';

export interface ProspectiveMemoryItem {
  id: string;
  /** What the agent should remember to do. */
  content: string;
  /** How this memory is triggered. */
  triggerType: ProspectiveTriggerType;
  /** For time_based: Unix ms when this should fire. */
  triggerAt?: number;
  /** For event_based: event name to match. */
  triggerEvent?: string;
  /** For context_based: embedding of the cue phrase. */
  cueEmbedding?: number[];
  /** For context_based: raw cue text (for display). */
  cueText?: string;
  /** Minimum similarity for context-based triggers. @default 0.7 */
  similarityThreshold?: number;
  /** Importance / priority. */
  importance: number;
  /** Whether this has been triggered and delivered. */
  triggered: boolean;
  /** Whether to re-trigger (recurring). */
  recurring: boolean;
  /** Creation timestamp. */
  createdAt: number;
  /** Source trace ID (if linked to a memory trace). */
  sourceTraceId?: string;
  /**
   * Optional visibility/restriction rank (higher = more restricted). When set,
   * the item is withheld from {@link ProspectiveMemoryManager.check} whenever
   * the caller's `maxTierRank` is lower. Generic: callers map their own tier
   * system (e.g. content policy tiers) to a numeric rank.
   */
  tierRank?: number;
}

// ---------------------------------------------------------------------------
// ProspectiveMemoryManager
// ---------------------------------------------------------------------------

let pmIdCounter = 0;

export class ProspectiveMemoryManager {
  private items: Map<string, ProspectiveMemoryItem> = new Map();
  private embeddingManager?: IEmbeddingManager;

  constructor(embeddingManager?: IEmbeddingManager) {
    this.embeddingManager = embeddingManager;
  }

  /**
   * Register a new prospective memory item.
   */
  async register(
    input: Omit<ProspectiveMemoryItem, 'id' | 'triggered' | 'createdAt' | 'cueEmbedding'> & { cueText?: string },
  ): Promise<ProspectiveMemoryItem> {
    const id = `pm_${Date.now()}_${++pmIdCounter}`;

    let cueEmbedding: number[] | undefined;
    if (input.triggerType === 'context_based' && input.cueText && this.embeddingManager) {
      const resp = await this.embeddingManager.generateEmbeddings({ texts: input.cueText });
      cueEmbedding = resp.embeddings[0];
    }

    const item: ProspectiveMemoryItem = {
      ...input,
      id,
      cueEmbedding,
      triggered: false,
      createdAt: Date.now(),
    };

    this.items.set(id, item);
    return item;
  }

  /**
   * Check all prospective memories against the current context.
   * Returns items that should fire this turn.
   */
  async check(context: {
    now?: number;
    events?: string[];
    queryText?: string;
    queryEmbedding?: number[];
    /**
     * Optional visibility ceiling. Items whose `tierRank` is greater than this
     * are withheld (not fired, not marked triggered) so they remain eligible
     * on a later turn at a higher ceiling. Omitted / non-finite → no gating.
     */
    maxTierRank?: number;
  }): Promise<ProspectiveMemoryItem[]> {
    const now = context.now ?? Date.now();
    const triggered: ProspectiveMemoryItem[] = [];

    for (const item of this.items.values()) {
      // Withhold items above the caller's visibility ceiling BEFORE trigger
      // evaluation, so a withheld item is never consumed (its `triggered` flag
      // stays false) and can still fire later when the ceiling is raised.
      if (
        Number.isFinite(item.tierRank) &&
        Number.isFinite(context.maxTierRank) &&
        (item.tierRank as number) > (context.maxTierRank as number)
      ) {
        continue;
      }

      if (item.triggered && !item.recurring) continue;

      let shouldFire = false;

      switch (item.triggerType) {
        case 'time_based':
          if (item.triggerAt && now >= item.triggerAt) {
            shouldFire = true;
          }
          break;

        case 'event_based':
          if (item.triggerEvent && context.events?.includes(item.triggerEvent)) {
            shouldFire = true;
          }
          break;

        case 'context_based':
          if (item.cueEmbedding && context.queryEmbedding) {
            const similarity = cosineSimilarity(item.cueEmbedding, context.queryEmbedding);
            if (similarity >= (item.similarityThreshold ?? 0.7)) {
              shouldFire = true;
            }
          }
          break;
      }

      if (shouldFire) {
        item.triggered = true;
        triggered.push(item);
      }
    }

    // Sort by importance descending
    triggered.sort((a, b) => b.importance - a.importance);
    return triggered;
  }

  /**
   * Remove a prospective memory item.
   */
  remove(id: string): boolean {
    return this.items.delete(id);
  }

  /**
   * Get all active (non-triggered or recurring) items.
   */
  getActive(): ProspectiveMemoryItem[] {
    return Array.from(this.items.values()).filter(
      (item) => !item.triggered || item.recurring,
    );
  }

  /**
   * Get total item count.
   */
  getCount(): number {
    return this.items.size;
  }

  /**
   * Clear all items.
   */
  clear(): void {
    this.items.clear();
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
