/**
 * @fileoverview Configuration types for the Cognitive Memory System.
 * @module agentos/memory/config
 */

import type { IWorkingMemory } from '../../substrate/memory/IWorkingMemory.js';
import type { IKnowledgeGraph } from '../retrieval/graph/knowledge/IKnowledgeGraph.js';
import type { IVectorStore } from '../../../core/vector-store/IVectorStore.js';
import type { IEmbeddingManager } from '../../../core/embeddings/IEmbeddingManager.js';
import type { MemoryBudgetAllocation } from './types.js';
import type { RecallCaptureMode } from '../retrieval/recall/capture.js';
import type { RecallConstants } from '../retrieval/recall/fuse.js';
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

/**
 * A persona's cognitive memory settings. `createAgentCognitiveMemory` passes
 * each field but `featureDetectionStrategy` to the manager it builds, under
 * the same name in {@link CognitiveMemoryConfig}; a field or key left out, or
 * set to `undefined`, keeps the default. The type lists no `null`, and a
 * loaded persona holds none: `normalizePersonaDefinition`, which the
 * file-system `PersonaLoader` and `InMemoryPersonaLoader` run and `GMIManager`
 * runs again on every definition any loader returns (a host's own
 * `IPersonaLoader` included), drops a field set to `null`, a key set to `null`
 * inside a field, and a `cognitiveMemoryConfig` set to `null`, as a persona
 * read from JSON writes an unset key. A host that builds its manager from a persona
 * itself (`gmiManagerConfig.cognitiveMemoryFactory`) gets the persona so
 * normalized, and passes the fields the same way. `agent({ runtime: 'gmi' })` and `gmi()` build their persona from
 * their options, which set only `cognitiveMemoryConfig.recall`, from `memory.recall`.
 */
export interface CognitiveMemoryPersonaConfig {
  /**
   * Feature detection strategy. Nothing in agentos reads it yet:
   * `createAgentCognitiveMemory` runs `'keyword'`, as it has no LLM invoker for
   * `'llm'` or `'hybrid'`.
   *
   * @default 'keyword'
   */
  featureDetectionStrategy?: 'keyword' | 'llm' | 'hybrid';
  /** Working memory slot capacity override ({@link CognitiveMemoryConfig.workingMemoryCapacity}). */
  workingMemoryCapacity?: number;
  /**
   * Token budget share overrides (fractions of the block's budget; shares
   * adding up to more than 1 are scaled down, and a share that is not a
   * finite positive number counts as 0). Unused budget flows to the sections
   * that still have content. A share of exactly 0 turns its section off: it
   * gets no grant and no unused budget. A key left out or set to `undefined`
   * keeps its default share (a persona loader drops a key a JSON file sets to
   * `null`). `createAgentCognitiveMemory` passes it to the
   * manager it builds as {@link CognitiveMemoryConfig.tokenBudget}; a host that
   * builds its manager from a persona itself
   * (`gmiManagerConfig.cognitiveMemoryFactory`) passes it the same way.
   * `agent({ runtime: 'gmi' })` and `gmi()` build their persona from their
   * options, which set only `cognitiveMemoryConfig.recall`, so their memory
   * runs on the default shares.
   */
  tokenBudget?: Partial<MemoryBudgetAllocation>;
  /**
   * Recall settings ({@link CognitiveMemoryConfig.recall}): the memory block's
   * budget, the capture, the retrieval and the rerank. `createAgentCognitiveMemory`
   * passes them to the manager it builds, under the agent's own `memory.recall`.
   * A JSON persona can hold `rerank: 'none'` or a `local` setting; an `llm`
   * setting holds a function, so a persona built in code sets it.
   */
  recall?: MemoryRecallConfig;
  /** Encoding config overrides ({@link CognitiveMemoryConfig.encoding}). */
  encoding?: Partial<EncodingConfig>;
  /** Decay config overrides ({@link CognitiveMemoryConfig.decay}). */
  decay?: Partial<DecayConfig>;
  /**
   * Observer config (Batch 2; {@link CognitiveMemoryConfig.observer}). The
   * manager runs an observer only when the config carries an `llmInvoker`.
   */
  observer?: Partial<ObserverConfig>;
  /**
   * Reflector config (Batch 2; {@link CognitiveMemoryConfig.reflector}). The
   * manager runs a reflector only when the config carries an `llmInvoker`.
   */
  reflector?: Partial<ReflectorConfig>;
  /**
   * Memory graph config (Batch 2; {@link CognitiveMemoryConfig.graph}).
   * `createAgentCognitiveMemory` lays it over its `{ backend: 'knowledge-graph' }`;
   * the `'graphology'` backend needs graphology, an optional peer dependency.
   */
  graph?: Partial<MemoryGraphConfig>;
  /**
   * Infinite context config (Batch 3; {@link CognitiveMemoryConfig.infiniteContext}).
   * The manager runs infinite context only with
   * {@link CognitiveMemoryConfig.maxContextTokens}, which
   * `createAgentCognitiveMemory` does not set, so on that path it has no effect yet.
   */
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
  /**
   * Section shares of the memory block's budget, over
   * {@link DEFAULT_BUDGET_ALLOCATION}. A share of exactly 0 turns its section
   * off; a key left out or set to `undefined` or `null` keeps its default.
   */
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
   * Keeps each trace's stability, access count, reinforcement interval and
   * next reinforcement time across a restart: written to the Brain (with no
   * Brain, to the vector store's metadata) at every access and read back at
   * load (`MemoryStoreConfig.persistAccessState`).
   * `false` writes and loads them as before, for one release of
   * before-and-after measurement.
   *
   * @default true
   */
  persistAccessState?: boolean;

  /**
   * A reranker service the manager holds for its caller and never calls.
   *
   * Not read for memory recall: memory rerank is set in `recall.rerank`,
   * which offers a local model (the query and the memories stay in the
   * process) and the host's own model call. A service passed here is
   * returned by `getRerankerService()` for the caller's own use (a
   * `HybridRetriever` or `SessionRetriever` it builds) and is otherwise
   * ignored, with one `memory.recall.option_ignored` line
   * (`option: 'remote_provider'`) when the manager initialises. Through
   * 0.17.1 the manager reranked every recall with the service's default
   * provider.
   *
   * No remote reranking service is offered for memories. A host that sends
   * a person's memories to one itself reads docs/text/RERANKING.md,
   * "Memories and remote rerankers".
   *
   * @default undefined
   */
  rerankerService?: import('../../rag/reranking/RerankerService.js').RerankerService;

  /**
   * Optional memory archive, read by `CognitiveMemoryManager.rehydrate()`,
   * which returns a trace's archived verbatim content.
   *
   * The manager hands this archive to neither the temporal-gist mechanism
   * nor its consolidation pipeline, so setting it does not make gisting keep
   * a verbatim copy.
   *
   * @default undefined (no archive; rehydrate() returns null)
   * @see `IMemoryArchive`, the archive contract, exported from
   * `@framers/agentos/memory/archive/IMemoryArchive`
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

  /**
   * The manager's recall settings: the memory block's budget on a GMI turn and
   * what the manager records of each memory assembly. Read at every
   * `assembleForPrompt()`, so a change to a built manager's configuration
   * applies from its next turn, except `rerank`, whose provider is built
   * once: `applyRecallConfig()` changes it. `initialize()` checks the
   * values. A host of
   * `AgentOS.create` sets it on the manager its
   * `gmiManagerConfig.cognitiveMemoryFactory` builds; `agent()` and `gmi()`
   * set it from `memory.recall`.
   *
   * @default undefined (a 1600-token block, capture `'metadata'`, no ids in the reasoning trace)
   */
  recall?: ManagerRecallConfig;
}

/**
 * The recall settings of `memory.recall` on `agent()` and `gmi()`, of a
 * persona's `cognitiveMemoryConfig.recall`, and of a manager's `recall`.
 */
export interface MemoryRecallConfig {
  /**
   * `totalTokens`: the budget of the whole memory block a GMI turn sends, its
   * preamble included, in tokens of about 4 characters. An integer of at least
   * 0; at 0 the turn sends no block and records every candidate left out for
   * the budget. On `agent()` without `runtime: 'gmi'` it is the `tokenBudget`
   * handed to `memoryProvider.getContext` when
   * `memoryProviderOptions.tokenBudget` is unset.
   *
   * @default { totalTokens: 1600 }
   */
  budget?: { totalTokens?: number };
  /**
   * `'metadata'` returns a capture record (`MemoryRecallCapture`) with every assembled
   * context (`AssembledMemoryContext.capture`) and on a GMI turn's result;
   * `'metadata+stream'` also sends it on the runtime stream (a
   * `METADATA_UPDATE` carrying `memorySources`, and `memoryRecall` on the
   * `FINAL_RESPONSE`); `'off'` records nothing. The record holds ids, ranks,
   * scores, counts and timings, never a memory's text or the query's; ids and
   * scores can concern memories of the other scopes a turn reads (the
   * organization's, the persona's), so the host decides who sees a capture.
   *
   * @default 'metadata'
   */
  capture?: RecallCaptureMode;
  /**
   * How a turn finds its memories. `'dense'`: by meaning (the vector query
   * and its six-signal ranking), shown in Relevant Memories and Recent
   * Experiences. `'hybrid'`: by meaning, by the turn's exact words (the
   * store's full-text index through the storage adapter, or an in-process
   * index where memory has no store) and by recency, fused into one deduped
   * pool and shown as one Relevant Memories section. Both embed the query
   * once, and neither calls any other vendor.
   *
   * @default 'dense'
   */
  retrieval?: 'dense' | 'hybrid';
  /**
   * Reranks the recalled memories before they are shown. `'none'`: no
   * reranker. `{ kind: 'local' }`: a cross-encoder that runs in this
   * process, named by `model` (a Hugging Face model id) and a pinned
   * `revision` (a commit of the model's repository); the query and the
   * memories never leave the process. `{ kind: 'llm' }`: the host's own
   * model call (`invoke(system, user, model)`, called with `model`) scores
   * and ranks them, which sends the query and the first 200 characters of
   * each candidate memory to that model's provider. No remote reranking
   * service is offered for memories.
   *
   * A reranker that is loading, unavailable, slow or failing never fails a
   * turn: the order stands and the capture's `reranker` says why. The local
   * model loads when the manager initialises (`recallReady()` resolves when
   * it has); a load that fails is not retried. `timeoutMs` bounds one
   * rerank (default 1500 for `local`, 10000 for `llm`); `maxCandidates` is
   * how many of the best candidates are scored (default 20). Both are
   * positive integers. After three failures or timeouts in a row the rerank
   * is skipped for 60 seconds. Under `'dense'` the reranked candidates'
   * scores become `0.7 × retrieval score + 0.3 × rerank score` and order
   * them; under `'hybrid'` they are ordered by `0.7 × fused score / the
   * cut's best fused score + 0.3 × rerank score` and keep their scores.
   *
   * On a built manager, change it with `applyRecallConfig()`: the provider
   * is built once, so a value written to the configuration is not read.
   *
   * @default 'none'
   */
  rerank?:
    | 'none'
    | { kind: 'local'; model: string; revision: string; timeoutMs?: number; maxCandidates?: number }
    | {
        kind: 'llm';
        invoke: (system: string, user: string, model?: string) => Promise<string>;
        model: string;
        timeoutMs?: number;
        maxCandidates?: number;
      };
}

/**
 * A manager's recall settings: the public ones plus what a host or a bench
 * sets below the `agent()` and `gmi()` options.
 */
export interface ManagerRecallConfig extends MemoryRecallConfig {
  /**
   * Lists the ids of the memories the block shows (`includedMemoryIds`) in
   * the GMI's reasoning-trace entry "Cognitive memory context assembled.",
   * which otherwise carries counts only.
   *
   * @default false
   */
  traceIds?: boolean;
  /**
   * The embedding provider and model the memory was built with, copied to the
   * capture record's `embedder`. A label only: the manager embeds through its
   * `embeddingManager`. `agent()` and `gmi()` set it from the model their
   * memory resolved.
   */
  embedder?: { provider: string; model: string };
  /**
   * The hybrid recall's fusion and pool constants, each over its starting
   * value in `RECALL_CONSTANTS` (`rrfK` 60, `denseWeight` 0.7,
   * `sparseWeight` 0.3, `recencyWeight` 0, `overFetch` 3, `topK` 20,
   * `nearDuplicate` 0.8, `recentTopK` 10). Read under `retrieval: 'hybrid'`
   * only. For a bench that tunes them; a product leaves them.
   */
  constants?: Partial<RecallConstants>;
  /**
   * Whether a turn is a memory question, for the exact-words reserve of
   * `retrieval: 'hybrid'`. Replaces the built-in English rule
   * (`isMemoryQuestion`). A predicate that throws, or answers anything but
   * `true`, is read as no. A function, so it is set on the manager and has no
   * persona or JSON form.
   */
  memoryQuestion?: (turnText: string) => boolean;
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

/**
 * Each section's default share of the memory block's budget (after the
 * preamble). A share is the least a section with content gets: what an empty
 * or under-filled section leaves flows to the sections that still have
 * content, in `MEMORY_BUDGET_SPILL_ORDER` (Semantic Recall, Recent Episodic,
 * then the block's order), so a store holding only episodic traces can fill
 * the whole budget with them.
 */
export const DEFAULT_BUDGET_ALLOCATION: MemoryBudgetAllocation = {
  workingMemory: 0.15,
  semanticRecall: 0.40,
  recentEpisodic: 0.25,
  prospectiveAlerts: 0.05,
  graphAssociations: 0.05,
  observationNotes: 0.05,
  persistentMemory: 0.05,
};
