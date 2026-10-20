/**
 * @file TypedNetworkRetriever.ts
 * @description Retrieval adapter that turns the typed-network into a
 * source of {@link ScoredMemoryTrace}s — drop-in compatible with the
 * existing canonical-hybrid retrieval pipeline.
 *
 * **Pipeline (per query):**
 *
 * 1. Extract candidate entities from the query text via regex
 *    (proper nouns ≥ 3 chars, quoted strings).
 * 2. Find seed facts in the {@link TypedNetworkStore} whose
 *    `entities` set intersects the query entities.
 * 3. Run {@link TypedSpreadingActivation} from the seed set with
 *    Hindsight Eq. 12 max-aggregation.
 * 4. Take top-K activated facts (sorted by activation level
 *    descending).
 * 5. Convert each typed fact to a `ScoredMemoryTrace`-shaped object
 *    so the bench's reader pipeline picks it up alongside canonical
 *    chunks.
 *
 * The retriever is stateless aside from the store + spreading-
 * activation engine it wraps. Safe to share across concurrent
 * retrieves on the same store.
 *
 * @module @framers/agentos/memory/retrieval/typed-network/TypedNetworkRetriever
 */

import type { ScoredMemoryTrace, MemoryScope } from '../../core/types.js';
import type { TypedFact } from './types.js';
import type { TypedNetworkStore } from './TypedNetworkStore.js';
import type { TypedSpreadingActivation } from './TypedSpreadingActivation.js';

/**
 * Extract candidate entity strings from a query. Matches the
 * Mem0-v3-style regex extractor used at ingest time so query and
 * fact entities use the same canonicalization.
 *
 * Captures:
 * - Capitalized words ≥ 3 characters (proper nouns: "Berlin",
 *   "Docker", "TypeScript")
 * - Double-quoted strings ("hello world")
 * - Single-quoted strings ('like this')
 *
 * Returns deduplicated entity strings preserving original casing
 * (case-sensitive comparison happens upstream).
 */
export function extractQueryEntities(text: string): string[] {
  const properNouns = text.match(/\b[A-Z][a-zA-Z]{2,}\b/g) ?? [];
  const dq = text.match(/"([^"]+)"/g)?.map((s) => s.slice(1, -1)) ?? [];
  const sq = text.match(/'([^']+)'/g)?.map((s) => s.slice(1, -1)) ?? [];
  return [...new Set([...properNouns, ...dq, ...sq])];
}

/**
 * Construction options.
 */
export interface TypedNetworkRetrieverOptions {
  /** The typed-network store populated at ingest time. */
  store: TypedNetworkStore;
  /** Pre-constructed spreading-activation engine. */
  spreading: TypedSpreadingActivation;
  /** Maximum hops for spreading activation. Default 3. */
  maxDepth?: number;
  /** Activation cutoff for spreading. Default 0.05. */
  activationThreshold?: number;
}

/**
 * Per-query retrieval options.
 */
export interface TypedNetworkRetrieveOptions {
  /** Top-K facts to return after activation ranking. */
  topK: number;
  /** Memory scope (matches the canonical retrieval scope). */
  scope: { scope: MemoryScope; scopeId: string };
  /**
   * Pre-extracted query entities. Pass when the consumer has done
   * its own entity extraction (e.g. via a stronger NER model);
   * skipping passes the query through {@link extractQueryEntities}.
   */
  queryEntities?: string[];
}

/**
 * Adapter that produces canonical-shaped retrieval results from the
 * typed-network store. Plugs into the bench's existing reader
 * pipeline without requiring changes to downstream code.
 */
export class TypedNetworkRetriever {
  private readonly store: TypedNetworkStore;
  private readonly spreading: TypedSpreadingActivation;
  private readonly maxDepth: number;
  private readonly activationThreshold: number;

  constructor(opts: TypedNetworkRetrieverOptions) {
    this.store = opts.store;
    this.spreading = opts.spreading;
    this.maxDepth = opts.maxDepth ?? 3;
    this.activationThreshold = opts.activationThreshold ?? 0.05;
  }

  /**
   * Retrieve top-K typed facts for the query, formatted as
   * {@link ScoredMemoryTrace}s. Returns an empty array when no
   * query entities match seed facts in the store (e.g. queries with
   * no proper nouns or quoted strings, or queries whose entities
   * the typed network has not yet observed).
   */
  async retrieve(
    query: string,
    options: TypedNetworkRetrieveOptions,
  ): Promise<ScoredMemoryTrace[]> {
    const entities = options.queryEntities ?? extractQueryEntities(query);
    if (entities.length === 0) return [];

    // Seed selection: any fact whose entity set intersects the query
    // entities. Case-insensitive intersection because LLM-extracted
    // fact entities sometimes drop capitalization.
    const lowerEntities = new Set(entities.map((e) => e.toLowerCase()));
    const seedIds: string[] = [];
    for (const fact of this.store.iterateFacts()) {
      if (fact.entities.some((e) => lowerEntities.has(e.toLowerCase()))) {
        seedIds.push(fact.id);
      }
    }
    if (seedIds.length === 0) return [];

    // Spreading activation with Eq. 12 max-aggregate.
    const activations = this.spreading.spread(this.store, seedIds, {
      maxDepth: this.maxDepth,
      activationThreshold: this.activationThreshold,
    });

    // Rank by activation, take top-K.
    const ranked = [...activations.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, options.topK);

    const traces: ScoredMemoryTrace[] = [];
    for (const [factId, activation] of ranked) {
      const fact = this.store.getFact(factId);
      if (!fact) continue;
      traces.push(typedFactToScoredTrace(fact, activation, options.scope));
    }
    return traces;
  }
}

/**
 * Convert a {@link TypedFact} into a {@link ScoredMemoryTrace} for
 * the bench's downstream reader pipeline. Renders the bank label
 * inline in the content so the reader can distinguish typed facts
 * from raw chunks at prompt time.
 *
 * Defaults follow the pattern of {@link HybridRetriever}'s private
 * `factToScoredTrace` method: encoding strength 1, retrieval score =
 * activation level, neutral emotional context, lifecycle timestamps
 * drawn from the fact's mention timestamp.
 */
export function typedFactToScoredTrace(
  fact: TypedFact,
  activation: number,
  scope: { scope: MemoryScope; scopeId: string },
): ScoredMemoryTrace {
  const mentionMs = Date.parse(fact.temporal.mention);
  const ts = Number.isNaN(mentionMs) ? Date.now() : mentionMs;
  // Bank-prefixed content gives the reader a hint about fact kind.
  const content = `[${fact.bank}] ${fact.text}`;
  return {
    id: `typed-network:${fact.id}`,
    type: 'semantic',
    scope: scope.scope,
    scopeId: scope.scopeId,
    content,
    entities: fact.entities,
    tags: ['typed-network', `bank:${fact.bank}`],
    provenance: {
      sourceType: 'typed_network',
      sourceTimestamp: ts,
      confidence: fact.confidence,
      verificationCount: 0,
    },
    emotionalContext: {
      valence: 0,
      arousal: 0,
      dominance: 0,
      intensity: 0,
      gmiMood: '',
    },
    encodingStrength: 1,
    stability: 1,
    retrievalCount: 0,
    lastAccessedAt: ts,
    accessCount: 0,
    reinforcementInterval: 0,
    associatedTraceIds: [],
    createdAt: ts,
    updatedAt: ts,
    isActive: true,
    retrievalScore: activation,
    scoreBreakdown: {
      strengthScore: 1,
      similarityScore: 0,
      recencyScore: 0,
      emotionalCongruenceScore: 0,
      graphActivationScore: activation,
      importanceScore: fact.confidence,
    },
  };
}
