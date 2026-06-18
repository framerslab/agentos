/**
 * @fileoverview Configuration types for the Cognitive Memory System.
 * @module agentos/memory/config
 */

import type { IWorkingMemory } from '../../substrate/memory/IWorkingMemory.js';
import type { IKnowledgeGraph } from '../retrieval/graph/knowledge/IKnowledgeGraph.js';
import type { IVectorStore } from '../../../core/vector-store/IVectorStore.js';
import type { IEmbeddingManager } from '../../../core/embeddings/IEmbeddingManager.js';
import type { MemoryBudgetAllocation } from './types.js';
import type { InfiniteContextConfig } from '../pipeline/context/types.js';

// ---------------------------------------------------------------------------
// PAD state (inlined to avoid circular dep with wunderland)
// ---------------------------------------------------------------------------

/** Pleasure-Arousal-Dominance emotional state. */
export interface PADState {
  valence: number;   // -1..1
  arousal: number;   // -1..1
  dominance: number; // -1..1
}

// ---------------------------------------------------------------------------
// HEXACO traits (inlined to avoid circular dep with wunderland)
// ---------------------------------------------------------------------------

export interface HexacoTraits {
  honesty?: number;
  emotionality?: number;
  extraversion?: number;
  agreeableness?: number;
  conscientiousness?: number;
  openness?: number;
}

// ---------------------------------------------------------------------------
// Sub-configs
// ---------------------------------------------------------------------------

export interface EncodingConfig {
  /** Base encoding strength before personality modulation. @default 0.5 */
  baseStrength: number;
  /** Emotional intensity threshold for flashbulb memory. @default 0.8 */
  flashbulbThreshold: number;
  /** Strength multiplier for flashbulb memories. @default 2.0 */
  flashbulbStrengthMultiplier: number;
  /** Stability multiplier for flashbulb memories. @default 5.0 */
  flashbulbStabilityMultiplier: number;
  /** Base stability in ms (how long before strength halves). @default 3_600_000 (1 hour) */
  baseStabilityMs: number;
}

export interface DecayConfig {
  /** Minimum strength before a trace is soft-deleted. @default 0.05 */
  pruningThreshold: number;
  /** Half-life for recency boost (ms). @default 86_400_000 (24 hours) */
  recencyHalfLifeMs: number;
  /** Cosine similarity threshold for interference detection. @default 0.7 */
  interferenceThreshold: number;
}

export interface ObserverConfig {
  /** Token threshold before observer activates. @default 30_000 */
  activationThresholdTokens: number;
  /**
   * Message-count threshold before the observer activates. Fires the observer
   * in conversational use, where turns are far too small to ever reach the
   * token threshold. Activation is `tokens OR messages`. @default 20
   */
  activationThresholdMessages?: number;
  /** LLM model ID for observation extraction (per-persona). */
  modelId?: string;
  /** LLM invoker function. */
  llmInvoker?: (systemPrompt: string, userPrompt: string) => Promise<string>;
}

export interface ReflectorConfig {
  /** Token threshold for notes before reflection triggers. @default 40_000 */
  activationThresholdTokens: number;
  /**
   * Accumulated-note-count threshold before reflection triggers. Fires
   * consolidation in conversational use, where note tokens never reach the
   * token threshold. Activation is `tokens OR notes`. @default 6
   */
  activationThresholdNotes?: number;
  /** LLM model ID for reflection/consolidation (per-persona). */
  modelId?: string;
  /** LLM invoker function. */
  llmInvoker?: (systemPrompt: string, userPrompt: string) => Promise<string>;
}

export interface PersistentMemorySource {
  /**
   * Read markdown memory that should be injected into every assembled prompt.
   * Implementations are expected to handle missing/unreadable backing stores
   * and return an empty string when no persistent memory is available.
   */
  read: () => string | Promise<string>;
}

/**
 * Configuration for the memory graph subsystem.
 *
 * The memory graph powers spreading activation (Collins & Quillian model),
 * Hebbian co-activation learning ("neurons that fire together wire together"),
 * conflict detection, clustering, and graph-boosted retrieval scoring.
 *
 * Enabled by default when CognitiveMemoryManager is initialized.
 * Set `disabled: true` to opt out entirely.
 */
export interface MemoryGraphConfig {
  /**
   * Set to true to disable the memory graph entirely.
   * When disabled, spreading activation, Hebbian co-activation,
   * and graph-based retrieval boosting are all skipped.
   * @default false
   */
  disabled?: boolean;
  /** Which graph backend to use. @default 'knowledge-graph' */
  backend?: 'graphology' | 'knowledge-graph';
  /** Max hops for spreading activation. @default 3 */
  maxDepth?: number;
  /** Activation decay per hop (0-1). @default 0.5 */
  decayPerHop?: number;
  /** Minimum activation to continue spreading (0-1). @default 0.1 */
  activationThreshold?: number;
  /** Hebbian learning rate for co-activation edge strengthening (0-1). @default 0.1 */
  hebbianLearningRate?: number;
}

/**
 * Default memory graph configuration.
 * Graph is enabled by default with the KnowledgeGraph backend,
 * providing spreading activation and Hebbian learning out of the box.
 */
export const DEFAULT_GRAPH_CONFIG: Required<Omit<MemoryGraphConfig, 'disabled'>> & { disabled: false } = {
  disabled: false,
  backend: 'knowledge-graph',
  maxDepth: 3,
  decayPerHop: 0.5,
  activationThreshold: 0.1,
  hebbianLearningRate: 0.1,
};

export interface ConsolidationConfig {
  /**
   * Whether the periodic consolidation timer is active. Set to false
   * for short-lived contexts (benches, tests, one-shot scripts) where
   * a lingering `setInterval` would keep the Node event loop alive
   * past the meaningful work.
   *
   * When false, `CognitiveMemoryManager` still constructs the
   * pipeline so `runConsolidation()` works on-demand; only the
   * auto-started timer is suppressed.
   * @default true
   */
  enabled?: boolean;
  /** How often to run consolidation (ms). @default 3_600_000 (1 hour) */
  intervalMs: number;
  /** Max traces to process per cycle. @default 500 */
  maxTracesPerCycle: number;
  /** Similarity threshold for merging redundant traces. @default 0.92 */
  mergeSimilarityThreshold: number;
  /** Minimum cluster size for schema integration. @default 5 */
  minClusterSize: number;

  // ---- Facade / lifecycle extensions ----

  /**
   * What event or schedule triggers a consolidation run.
   * - `'turns'`    – fire after every N conversation turns (`every` = turn count).
   * - `'interval'` – fire on a wall-clock timer (`every` = milliseconds).
   * - `'manual'`   – only fire when explicitly requested.
   * @default 'interval'
   */
  trigger?: 'turns' | 'interval' | 'manual';

  /**
   * Numeric complement to `trigger`.
   * When `trigger='turns'` this is the turn count; when `trigger='interval'`
   * this is the millisecond period.
   * @default 3_600_000
   */
  every?: number;

  /**
   * Minimum Ebbinghaus strength below which a trace is pruned.
   * Must be between 0 and 1.
   * @default 0.05
   */
  pruneThreshold?: number;

  /**
   * Cosine similarity above which two traces are candidates for merging.
   * Must be between 0 and 1.
   * @default 0.92
   */
  mergeThreshold?: number;

  /**
   * Whether the consolidation engine should derive new insight traces from
   * clusters of related memories during each cycle.
   * @default true
   */
  deriveInsights?: boolean;

  /**
   * Maximum number of new insight traces the engine may derive per cycle.
   * Guards against unbounded graph growth.
   * @default 10
   */
  maxDerivedPerCycle?: number;
}

// ---------------------------------------------------------------------------
// Per-persona cognitive memory overrides
// ---------------------------------------------------------------------------

export interface CognitiveMemoryPersonaConfig {
  /** Feature detection strategy. @default 'keyword' */
  featureDetectionStrategy?: 'keyword' | 'llm' | 'hybrid';
  /** Working memory slot capacity override. */
  workingMemoryCapacity?: number;
  /** Token budget allocation percentages override. */
  tokenBudget?: Partial<MemoryBudgetAllocation>;
  /** Encoding config overrides. */
  encoding?: Partial<EncodingConfig>;
  /** Decay config overrides. */
  decay?: Partial<DecayConfig>;
  /** Observer config (Batch 2). */
  observer?: Partial<ObserverConfig>;
  /** Reflector config (Batch 2). */
  reflector?: Partial<ReflectorConfig>;
  /** Memory graph config (Batch 2). */
  graph?: Partial<MemoryGraphConfig>;
  /** Infinite context config (Batch 3). */
  infiniteContext?: Partial<InfiniteContextConfig>;
}

// ---------------------------------------------------------------------------
// Top-level config
// ---------------------------------------------------------------------------

export interface CognitiveMemoryConfig {
  // --- Existing AgentOS dependencies ---
  workingMemory: IWorkingMemory;
  knowledgeGraph: IKnowledgeGraph;
  vectorStore: IVectorStore;
  embeddingManager: IEmbeddingManager;

  // --- Agent identity ---
  agentId: string;
  traits: HexacoTraits;
  /** Callback to get current mood from MoodEngine or similar. */
  moodProvider: () => PADState;

  // --- Feature detection ---
  /** @default 'keyword' */
  featureDetectionStrategy: 'keyword' | 'llm' | 'hybrid';
  /** Required when strategy is 'llm' or 'hybrid'. */
  featureDetectionLlmInvoker?: (systemPrompt: string, userPrompt: string) => Promise<string>;

  // --- Tuning ---
  encoding?: Partial<EncodingConfig>;
  decay?: Partial<DecayConfig>;
  /** @default 7 (Miller's number) */
  workingMemoryCapacity?: number;
  tokenBudget?: Partial<MemoryBudgetAllocation>;

  // --- Batch 2 (optional, no-op when absent) ---
  observer?: Partial<ObserverConfig>;
  reflector?: Partial<ReflectorConfig>;
  graph?: Partial<MemoryGraphConfig>;
  consolidation?: Partial<ConsolidationConfig>;

  /**
   * Optional persistent markdown memory source injected into every prompt.
   *
   * This is separate from active working memory: working memory is the
   * bounded cognitive focus, while persistent memory is durable agent/user
   * state such as profile notes, preferences, and identity anchors.
   */
  persistentMemory?: PersistentMemorySource;

  // --- Cognitive Mechanisms (optional, no-op when absent) ---
  /** Optional per-mechanism cognitive science extensions (reconsolidation, RIF, FOK, etc.). */
  cognitiveMechanisms?: import('../mechanisms/types.js').CognitiveMechanismsConfig;

  // --- Batch 3: Infinite Context (optional, no-op when absent) ---
  /** Infinite context window config. Enables transparent compaction for forever conversations. */
  infiniteContext?: Partial<InfiniteContextConfig>;
  /** Max context window size in tokens (required for infinite context). */
  maxContextTokens?: number;

  // --- Vector store collection prefix ---
  /** @default 'cogmem' */
  collectionPrefix?: string;

  /**
   * Step 13: enable graph activation. Propagates to
   * `MemoryStoreConfig.enableGraphActivation`. When true, the internal
   * `MemoryStore` upserts entity nodes + `related_to:co_occurs` edges
   * at encode time (from `trace.entities`), and seeds Anderson
   * spreading activation from query-extracted entities at retrieve to
   * compute the sixth composite-scoring signal. Default: false (legacy
   * behavior, `graphActivation` signal is a silent zero).
   *
   * @default false
   */
  enableGraphActivation?: boolean;

  // --- Persistence (optional) ---
  /**
   * Optional Brain instance for durable persistence.
   *
   * When provided, memory traces, knowledge graph nodes/edges,
   * prospective items, and observation pipeline state are persisted
   * to the brain's SQL tables via sql-storage-adapter. The in-memory
   * vector index remains the hot read path; Brain is the durable
   * backing store that survives process restarts.
   *
   * Falls back to in-memory-only storage when omitted.
   *
   * @default undefined (in-memory only)
   * @see {@link Brain} — the cross-platform persistence layer
   */
  brain?: import('../retrieval/store/Brain.js').Brain;

  /**
   * Optional reranker service for post-retrieval quality improvement.
   *
   * When provided, retrieved memory traces are reranked after the
   * cognitive scoring pipeline (vector similarity + strength + recency +
   * emotional congruence + graph activation + importance). The reranker
   * score is blended with the existing composite score at a 0.7/0.3
   * weighting to preserve cognitive signals while boosting semantically
   * relevant results.
   *
   * Recommended: Cohere rerank-v3.5 primary, LLM-Judge fallback.
   *
   * @default undefined (no reranking)
   */
  rerankerService?: import('../../rag/reranking/RerankerService.js').RerankerService;

  /**
   * Optional memory archive for write-ahead verbatim preservation.
   *
   * When provided, TemporalGist preserves the original content in cold
   * storage before overwriting with the gist. Enables on-demand rehydration
   * via `CognitiveMemoryManager.rehydrate()`.
   *
   * @default undefined (no archive, gist is destructive)
   * @see {@link IMemoryArchive} — the archive contract
   */
  archive?: import('../archive/IMemoryArchive.js').IMemoryArchive;

  /**
   * Stage E: optional Hindsight 4-network typed observer wiring.
   *
   * When provided, `encode()` additionally extracts typed facts (World /
   * Experience / Opinion / Observation banks) via the configured LLM and
   * persists them in an in-memory `TypedNetworkStore`. `retrieve()` runs
   * typed-graph spreading activation (`'full'` variant only) and produces
   * a 4-way RRF fused ranking that's merged into the existing scoring.
   *
   * Variants:
   * - `'minimal'`: bank routing + observer only (no graph traversal at retrieve).
   * - `'full'`: minimal + spreading activation per Hindsight Eq. 12 + 4-way RRF.
   *
   * @default undefined (Stage E disabled, zero-cost no-op)
   * @see `packages/agentos-bench/docs/specs/2026-04-26-hindsight-4network-observer-design.md`
   */
  typedNetwork?: TypedNetworkRuntimeConfig;
}

/**
 * Stage E runtime config for the typed-network observer + retrieval fusion.
 */
export interface TypedNetworkRuntimeConfig {
  /**
   * Variant selector.
   * - `'minimal'`: 4-bank routing only at encode; no spreading activation.
   * - `'full'`: minimal + spreading activation + 4-way RRF at retrieve.
   */
  variant: 'minimal' | 'full';
  /** LLM adapter for the 6-step extraction call. */
  observerLLM: import('../retrieval/typed-network/index.js').ITypedExtractionLLM;
  /**
   * Whether `encode()` invokes the typed-network observer per call.
   *
   * - `false` (default): manager NEVER calls the observer at encode. The consumer
   *   is responsible for invoking `getTypedNetworkObserver()?.extract(...)` at
   *   whatever granularity makes sense (typically session boundaries).
   * - `true`: manager calls the observer on every `encode()` with the full input
   *   text and writes facts into the store namespaced by the trace ID.
   *
   * Default is `false` to prevent the bench-style double-extraction pattern
   * (manager extracts per-encode AND consumer extracts per-session). When in
   * doubt, leave this `false` and let the consumer drive extraction explicitly.
   */
  extractAtEncode?: boolean;
  /**
   * Weight applied to the typed-network ranking when merging into the
   * standard cognitive score. 0.0 ignores typed-network; 1.0 uses only
   * typed-network. Default 0.5. RESERVED for Phase 4.4 fusion; currently unused.
   */
  weight?: number;
  /** Spreading-activation max depth. Default 3. */
  maxDepth?: number;
  /** Spreading-activation per-hop decay δ. Default 0.5. */
  decay?: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_ENCODING_CONFIG: EncodingConfig = {
  baseStrength: 0.5,
  flashbulbThreshold: 0.8,
  flashbulbStrengthMultiplier: 2.0,
  flashbulbStabilityMultiplier: 5.0,
  baseStabilityMs: 3_600_000,
};

export const DEFAULT_DECAY_CONFIG: DecayConfig = {
  pruningThreshold: 0.05,
  recencyHalfLifeMs: 86_400_000,
  interferenceThreshold: 0.7,
};

export const DEFAULT_BUDGET_ALLOCATION: MemoryBudgetAllocation = {
  workingMemory: 0.15,
  semanticRecall: 0.40,
  recentEpisodic: 0.25,
  prospectiveAlerts: 0.05,
  graphAssociations: 0.05,
  observationNotes: 0.05,
  persistentMemory: 0.05,
};
