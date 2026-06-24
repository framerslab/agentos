import type { RetrievalConfidenceSummary } from '../../rag/unified/confidence.js';
import type {
  MemoryRetrievalPolicy,
  MemoryRetrievalProfile,
} from '../../rag/unified/policy.js';

/**
 * @fileoverview Core types for the Cognitive Memory System.
 *
 * Grounded in cognitive science models:
 * - Atkinson-Shiffrin (sensory → STM → LTM)
 * - Baddeley's working memory (slot-based, capacity-limited)
 * - Tulving's LTM taxonomy (episodic vs semantic)
 * - Ebbinghaus forgetting curve (strength decay over time)
 * - PAD emotional model (valence/arousal/dominance tagging)
 *
 * @module agentos/memory/types
 */

// ---------------------------------------------------------------------------
// Memory classification
// ---------------------------------------------------------------------------

/** Long-term memory subtypes (Tulving's taxonomy + extensions). */
export type MemoryType = 'episodic' | 'semantic' | 'procedural' | 'prospective' | 'relational';

/** Visibility / ownership scope for a memory trace. */
export type MemoryScope = 'thread' | 'user' | 'persona' | 'organization';

/**
 * How the content of this memory was originally produced.
 *
 * Source type drives trust ranking and confidence-decay multiplier. Higher-
 * trust sources (`identity_provider`, `system_config`, `tool_result`,
 * `human_approval`) decay slowest; derived/inferred sources
 * (`agent_inference`, `memory_summary`, `reflection`) decay fastest. See
 * `SourceConfidenceDecay` mechanism for the per-type multipliers.
 */
export type MemorySourceType =
  | 'user_statement'
  | 'agent_inference'
  | 'tool_result'
  | 'observation'
  | 'reflection'
  | 'external'
  | 'fact_graph'
  | 'typed_network'
  // Enterprise / production-grade sources added to disambiguate the
  // `external` catch-all and reflect real-world trust hierarchies.
  /** Document chunk retrieved via RAG (vector search, knowledge corpus). */
  | 'retrieved_document'
  /** Explicit human approval event (HITL gate, manual confirmation). */
  | 'human_approval'
  /** System of record for identity (Okta, LDAP, IdP lookup result). */
  | 'identity_provider'
  /** Declared application/runtime configuration (env, agency config). */
  | 'system_config'
  /** Successful response from an external API/webhook (more specific than `external`). */
  | 'external_api'
  /** Derived summary produced by collapsing a cluster of prior memories. */
  | 'memory_summary';

// ---------------------------------------------------------------------------
// Provenance (source monitoring — prevents confabulation)
// ---------------------------------------------------------------------------

export interface MemoryProvenance {
  sourceType: MemorySourceType;
  /** Back-reference to originating conversation, tool call, etc. */
  sourceId?: string;
  /** Timestamp of the original source information. */
  sourceTimestamp: number;
  /** 0-1 confidence we have in this memory's accuracy. */
  confidence: number;
  /** How many times this memory has been externally confirmed. */
  verificationCount: number;
  lastVerifiedAt?: number;
  /** IDs of other traces that contradict this one. */
  contradictedBy?: string[];
}

// ---------------------------------------------------------------------------
// Emotional context (PAD model snapshot at encoding time)
// ---------------------------------------------------------------------------

export interface EmotionalContext {
  /** Pleasure / valence dimension, -1 (negative) to 1 (positive). */
  valence: number;
  /** Arousal dimension, 0 (calm) to 1 (excited). */
  arousal: number;
  /** Dominance dimension, -1 (submissive) to 1 (dominant). */
  dominance: number;
  /** Derived emotional intensity: |valence| * arousal. */
  intensity: number;
  /** GMIMood enum string at encoding time. */
  gmiMood: string;
}

// ---------------------------------------------------------------------------
// Trust policy (per-trace capability gating)
// ---------------------------------------------------------------------------

/**
 * What this memory is allowed to be used for, irrespective of how relevant
 * a retrieval marks it. Policy is set at encoding time from the source-type
 * defaults table ({@link DEFAULT_TRUST_POLICY_BY_SOURCE}) and may be
 * tightened (never loosened) by downstream callers.
 *
 * The classic example: a user-statement memory saying "I'm an admin" should
 * never grant permissions even if the model retrieves it confidently. Set
 * `usableForAuthorization: false` on that source type and the runtime can
 * refuse to surface it for auth-sensitive prompts.
 */
export interface MemoryTrustPolicy {
  /**
   * Whether this memory may be used as evidence that the user (or any
   * entity it describes) has a permission/role/capability. Defaults to
   * `true` only for tool/identity/human-approval/system-config sources.
   */
  usableForAuthorization: boolean;
  /**
   * Whether this memory may be used to personalize responses (tone, prior
   * preferences, conversation continuity). Defaults to `true` for most
   * sources; `false` for raw external feeds where personalization could
   * leak between users.
   */
  usableForPersonalization: boolean;
  /**
   * Whether this memory may be cited as a factual claim in generated
   * output. Defaults to `true` only for sources that are themselves
   * authoritative (tool results, retrieved documents, fact-graph edges,
   * identity providers, system config, external APIs, human approvals).
   */
  usableForFactClaim: boolean;
  /**
   * If set, the memory must be re-verified (via a fresh tool call /
   * lookup / human confirmation) within this many milliseconds of its
   * `provenance.lastVerifiedAt` before it can be used for the
   * capabilities above. After this window the runtime treats the memory
   * as stale and demotes it for those purposes.
   */
  requiresReverificationAfterMs?: number;
}

/**
 * Default trust policies keyed by source type. Encoded into a new
 * `MemoryTrace.policy` at creation time so a memory's policy reflects how
 * it was originally produced, not how it was later retrieved.
 *
 * Trust ranking summary:
 *   identity_provider / system_config / human_approval / tool_result
 *     → full trust (authorize + personalize + fact-claim).
 *   retrieved_document / fact_graph / external_api
 *     → fact-claim only; reverify periodically.
 *   user_statement / agent_inference / observation / reflection /
 *     typed_network / memory_summary
 *     → personalization only; never grant auth or stand as a fact.
 *   external
 *     → catch-all; conservative defaults (no auth, no fact-claim).
 */
export const DEFAULT_TRUST_POLICY_BY_SOURCE: Record<MemorySourceType, MemoryTrustPolicy> = {
  user_statement: {
    usableForAuthorization: false,
    usableForPersonalization: true,
    usableForFactClaim: false,
  },
  agent_inference: {
    usableForAuthorization: false,
    usableForPersonalization: true,
    usableForFactClaim: false,
    requiresReverificationAfterMs: 3_600_000, // 1h
  },
  tool_result: {
    usableForAuthorization: true,
    usableForPersonalization: true,
    usableForFactClaim: true,
  },
  observation: {
    usableForAuthorization: false,
    usableForPersonalization: true,
    usableForFactClaim: false,
  },
  reflection: {
    usableForAuthorization: false,
    usableForPersonalization: true,
    usableForFactClaim: false,
    requiresReverificationAfterMs: 3_600_000,
  },
  external: {
    usableForAuthorization: false,
    usableForPersonalization: false,
    usableForFactClaim: false,
  },
  fact_graph: {
    usableForAuthorization: false,
    usableForPersonalization: true,
    usableForFactClaim: true,
  },
  typed_network: {
    usableForAuthorization: false,
    usableForPersonalization: true,
    usableForFactClaim: false,
  },
  retrieved_document: {
    usableForAuthorization: false,
    usableForPersonalization: false,
    usableForFactClaim: true,
    requiresReverificationAfterMs: 86_400_000, // 24h
  },
  human_approval: {
    usableForAuthorization: true,
    usableForPersonalization: true,
    usableForFactClaim: true,
  },
  identity_provider: {
    usableForAuthorization: true,
    usableForPersonalization: true,
    usableForFactClaim: true,
    requiresReverificationAfterMs: 3_600_000,
  },
  system_config: {
    usableForAuthorization: true,
    usableForPersonalization: false,
    usableForFactClaim: true,
  },
  external_api: {
    usableForAuthorization: false,
    usableForPersonalization: true,
    usableForFactClaim: true,
    requiresReverificationAfterMs: 3_600_000,
  },
  memory_summary: {
    usableForAuthorization: false,
    usableForPersonalization: true,
    usableForFactClaim: false,
    requiresReverificationAfterMs: 3_600_000,
  },
};

/** A capability that {@link canUseFor} can gate against. */
export type TrustCapability = 'authorization' | 'personalization' | 'factClaim';

/**
 * Whether a memory may be used for a given capability right now. Combines
 * the per-trace `policy` flag with the `requiresReverificationAfterMs`
 * staleness check (using `provenance.lastVerifiedAt` as the anchor and
 * falling back to `provenance.sourceTimestamp` when never re-verified).
 *
 * Pass `now` for deterministic testing; defaults to `Date.now()`.
 */
export function canUseFor(
  trace: Pick<MemoryTrace, 'policy' | 'provenance'>,
  capability: TrustCapability,
  now: number = Date.now(),
): boolean {
  const policy = trace.policy;
  if (!policy) return true; // no policy = no gating
  const flag =
    capability === 'authorization'
      ? policy.usableForAuthorization
      : capability === 'personalization'
        ? policy.usableForPersonalization
        : policy.usableForFactClaim;
  if (!flag) return false;
  if (policy.requiresReverificationAfterMs == null) return true;
  const lastVerified = trace.provenance.lastVerifiedAt ?? trace.provenance.sourceTimestamp;
  return now - lastVerified <= policy.requiresReverificationAfterMs;
}

// ---------------------------------------------------------------------------
// Content feature classification
// ---------------------------------------------------------------------------

export interface ContentFeatures {
  hasNovelty: boolean;
  hasProcedure: boolean;
  hasEmotion: boolean;
  hasSocialContent: boolean;
  hasCooperation: boolean;
  hasEthicalContent: boolean;
  hasContradiction: boolean;
  /** 0-1 relevance to current task / active goal. */
  topicRelevance: number;
}

// ---------------------------------------------------------------------------
// The universal memory envelope
// ---------------------------------------------------------------------------

export interface MemoryTrace {
  id: string;
  type: MemoryType;
  scope: MemoryScope;
  scopeId: string;

  // --- Content ---
  content: string;
  structuredData?: Record<string, unknown>;
  entities: string[];
  tags: string[];

  // --- Provenance ---
  provenance: MemoryProvenance;

  // --- Emotional context ---
  emotionalContext: EmotionalContext;

  // --- Ebbinghaus decay model ---
  /** S_0: initial encoding strength, set at creation. */
  encodingStrength: number;
  /** Optional normalized salience score used by some consolidation/retrieval paths. */
  importance?: number;
  /** Time constant (ms); grows with each successful retrieval. */
  stability: number;
  /** Number of times this trace has been successfully retrieved. */
  retrievalCount: number;
  /** Unix ms of last retrieval. */
  lastAccessedAt: number;
  /** Total access count (includes non-retrieval touches). */
  accessCount: number;

  // --- Spaced repetition ---
  /** Current interval (ms); doubles on each successful recall. */
  reinforcementInterval: number;
  /** When this memory is next due for reinforcement review. */
  nextReinforcementAt?: number;

  // --- Graph linkage ---
  associatedTraceIds: string[];

  // --- Trust policy ---
  /**
   * Per-trace capability gating. Set at encoding time from the source-type
   * defaults table ({@link DEFAULT_TRUST_POLICY_BY_SOURCE}). When absent, the
   * runtime treats the memory as unrestricted; callers should use
   * {@link canUseFor} to gate against authorization / personalization /
   * fact-claim use cases.
   */
  policy?: MemoryTrustPolicy;

  // --- Lifecycle ---
  createdAt: number;
  updatedAt: number;
  consolidatedAt?: number;
  isActive: boolean;
}

// ---------------------------------------------------------------------------
// Working memory slot (Baddeley's model)
// ---------------------------------------------------------------------------

export interface WorkingMemorySlot {
  slotId: string;
  /** Reference to the underlying MemoryTrace (or a transient key). */
  traceId: string;
  /** 0-1 activation level; determines if slot is "in focus". */
  activationLevel: number;
  /** When this trace entered working memory (Unix ms). */
  enteredAt: number;
  /** Maintenance rehearsal counter. */
  rehearsalCount: number;
  /** How much attention is allocated to this slot (0-1). */
  attentionWeight: number;
}

// ---------------------------------------------------------------------------
// Encoding weights (HEXACO → attention modulation)
// ---------------------------------------------------------------------------

export interface EncodingWeights {
  noveltyAttention: number;
  proceduralAttention: number;
  emotionalSensitivity: number;
  socialAttention: number;
  cooperativeAttention: number;
  ethicalAttention: number;
}

// ---------------------------------------------------------------------------
// Encoding result
// ---------------------------------------------------------------------------

export interface EncodingResult {
  initialStrength: number;
  stability: number;
  importance: number;
  isFlashbulb: boolean;
}

// ---------------------------------------------------------------------------
// Retrieval types
// ---------------------------------------------------------------------------

export interface CognitiveRetrievalOptions {
  topK?: number;
  types?: MemoryType[];
  scopes?: Array<{ scope: MemoryScope; scopeId: string }>;
  tags?: string[];
  entities?: string[];
  minConfidence?: number;
  /**
   * Restrict results to traces whose trust policy permits the listed
   * capabilities. Pass a single capability or an array (AND semantics: a
   * trace must permit every requested capability). Applies the same
   * staleness check as {@link canUseFor} when the policy declares
   * `requiresReverificationAfterMs`.
   */
  usableFor?: TrustCapability | TrustCapability[];
  timeRange?: { after?: number; before?: number };
  /** If true, skip emotional congruence bias (useful for factual lookups). */
  neutralMood?: boolean;
  /**
   * Optional visibility ceiling for prospective alerts. Items registered with a
   * `tierRank` greater than this are withheld from the assembled "Reminders"
   * section. Used only for prospective gating in `assembleForPrompt`;
   * `retrieve` ignores it.
   */
  maxTierRank?: number;
  /**
   * Enable HyDE (Hypothetical Document Embedding) for memory retrieval.
   *
   * When `true` and a HyDE retriever is configured on the memory manager,
   * the system generates a hypothetical memory trace matching the query
   * before embedding. This produces embeddings that are closer to actual
   * stored memories, improving recall — especially for vague or abstract
   * recall prompts (e.g. "that thing we discussed about deployment").
   *
   * Adds one LLM call per retrieval. Use for important lookups where
   * recall quality matters more than latency.
   *
   * @default false
   */
  hyde?: boolean;
  /** Shared retrieval profile and confidence policy. */
  policy?: MemoryRetrievalPolicy;
  /**
   * Override the 6-signal retrieval weights for this call. Missing
   * keys fall back to {@link DEFAULT_SCORING_WEIGHTS}. Useful for
   * ablation studies (zero one weight at a time and measure
   * Δaccuracy) and for A/B testing alternate weight configurations
   * without mutating global defaults.
   */
  scoringWeights?: Partial<import('./decay/RetrievalPriorityScorer.js').ScoringWeights>;
}

export interface ScoredMemoryTrace extends MemoryTrace {
  /** Composite retrieval score (0-1). */
  retrievalScore: number;
  /** Individual score components for debugging. */
  scoreBreakdown: {
    strengthScore: number;
    similarityScore: number;
    recencyScore: number;
    emotionalCongruenceScore: number;
    graphActivationScore: number;
    importanceScore: number;
  };
}

export interface PartiallyRetrievedTrace {
  traceId: string;
  confidence: number;
  partialContent: string;
  suggestedCues: string[];
}

export interface CognitiveRetrievalResult {
  retrieved: ScoredMemoryTrace[];
  partiallyRetrieved: PartiallyRetrievedTrace[];
  diagnostics: {
    candidatesScanned: number;
    vectorSearchTimeMs: number;
    scoringTimeMs: number;
    totalTimeMs: number;
    policyProfile?: MemoryRetrievalProfile;
    suppressed?: 'weak_hits';
    confidence?: RetrievalConfidenceSummary;
    escalations?: string[];
    /**
     * Step-4: when a `HybridRetriever` runs with a `hydeRetriever`
     * attached, the first ~120 chars of the generated hypothesis
     * are surfaced here for post-hoc analysis of which queries
     * benefited from expansion.
     */
    hyde?: { hypothesis: string };
    /**
     * Step-5: post-retrieve FactSupersession pass diagnostics.
     * Populated only when a bench adapter or downstream consumer
     * ran `FactSupersession.resolve()` over the retrieved traces.
     */
    factSupersession?: {
      droppedIds: string[];
      parseOk: boolean;
      llmLatencyMs: number;
      notes?: string[];
    };
    /**
     * Step-6: when `HybridRetriever` runs with `splitAmbiguousThreshold`
     * set, the bottom fraction of traces by first-pass rerank score
     * are split at sentence boundaries and rescored. Replacements are
     * recorded here for post-hoc analysis.
     */
    splitOnAmbiguous?: {
      threshold: number;
      candidateCount: number;
      replacedIds: string[];
    };
    /**
     * Per-stage ranked trace IDs for the hybrid retrieval pipeline
     * (dense → sparse → merged → reranked → final). Populated by
     * `HybridRetriever` so downstream consumers can compute per-stage
     * retrieval-quality metrics (Recall@K, NDCG@K, MRR) and attribute
     * losses to the stage that caused them. Absent for non-hybrid
     * retrieval paths.
     */
    stageIds?: {
      dense: string[];
      sparse: string[];
      merged: string[];
      reranked: string[];
      final: string[];
    };
    /**
     * Stage E: optional Hindsight typed-network output as canonical-shaped
     * scored traces. When the manager is configured with `typedNetwork` and
     * the variant supports retrieval-side activation (`'full'`), the manager
     * delegates to a `TypedNetworkRetriever` which performs seed-finding
     * (proper-noun + quoted-string entity extraction, case-insensitive
     * intersection), spreading activation, and top-K ranking. Top-K results
     * are surfaced as `ScoredMemoryTrace[]` for drop-in compatibility with
     * the canonical retrieval pipeline (bank-prefixed content, namespaced
     * IDs `typed-network:<factId>`, sourceType `'typed_network'`).
     *
     * Absent when typed-network is not configured. Empty when the retriever
     * found no seed matches in the typed-network store.
     *
     * Phase 4.3 MVP: surfaced in diagnostics but NOT merged into the primary
     * `retrieved` ranking. Phase 4.4 fusion lands when consumers wire the
     * merged ranking. See `2026-04-26-hindsight-4network-observer-design.md`.
     */
    retrievedTypedTraces?: ScoredMemoryTrace[];
  };
}

// ---------------------------------------------------------------------------
// Prompt assembly types
// ---------------------------------------------------------------------------

export interface MemoryBudgetAllocation {
  workingMemory: number;
  semanticRecall: number;
  recentEpisodic: number;
  prospectiveAlerts: number;
  graphAssociations: number;
  observationNotes: number;
  persistentMemory: number;
}

export interface AssembledMemoryContext {
  contextText: string;
  tokensUsed: number;
  allocation: MemoryBudgetAllocation;
  includedMemoryIds: string[];
}

// ---------------------------------------------------------------------------
// Health / diagnostics
// ---------------------------------------------------------------------------

export interface MemoryHealthReport {
  totalTraces: number;
  activeTraces: number;
  avgStrength: number;
  weakestTraceStrength: number;
  workingMemoryUtilization: number;
  lastConsolidationAt?: number;
  tracesPerType: Record<MemoryType, number>;
  tracesPerScope: Record<MemoryScope, number>;
}

// ---------------------------------------------------------------------------
// API surface types (for downstream visualization, stats, and export)
// ---------------------------------------------------------------------------

/**
 * Serializable snapshot of the full memory graph for visualization.
 * Contains nodes (traces), edges (associations), clusters, and aggregate stats.
 * Used by wilds-ai companion sidebar, memory graph view, and devtools.
 */
export interface MemoryGraphSnapshot {
  nodes: Array<{
    id: string;
    type: MemoryType;
    content: string;
    strength: number;
    isFlashbulb: boolean;
    createdAt: number;
    lastAccessedAt: number;
    retrievalCount: number;
  }>;
  edges: Array<{
    sourceId: string;
    targetId: string;
    type: string;
    weight: number;
  }>;
  clusters: Array<{ clusterId: string; memberIds: string[]; density: number }>;
  stats: {
    nodeCount: number;
    edgeCount: number;
    clusterCount: number;
  };
}

/**
 * Observation pipeline health stats for devtools/monitoring.
 * Exposes the state of the 3-tier pipeline: notes → compressed → reflected.
 */
export interface ObservationPipelineStats {
  /** Number of raw observation notes pending compression. */
  pendingNotes: number;
  /** Number of compressed observations pending reflection. */
  pendingCompressed: number;
  /** Total observation notes produced since initialization. */
  totalNotesProduced: number;
  /** Total reflection cycles completed. */
  totalReflectionsProduced: number;
  /** Timestamp of last reflection cycle, or null if none. */
  lastReflectionAt: number | null;
  /** Average compression ratio (input tokens / output tokens). */
  avgCompressionRatio: number;
}

/**
 * Full exportable memory state for character portability across worlds.
 * Used for companion export/import in wilds-ai.
 */
export interface CognitiveMemorySnapshot {
  /** Snapshot format version. */
  version: string;
  /** Agent/entity ID that owns this memory. */
  agentId: string;
  /** All active memory traces. */
  traces: MemoryTrace[];
  /** Graph edges between traces. */
  graphEdges: Array<{ sourceId: string; targetId: string; type: string; weight: number; createdAt: number }>;
  /** Active prospective memory items. */
  prospectiveItems: Array<{ id: string; content: string; triggerType: string; importance: number; triggered: boolean; createdAt: number; tierRank?: number }>;
  /** Snapshot metadata for import validation. */
  metadata: {
    exportedAt: number;
    traceCount: number;
    typeDistribution: Record<MemoryType, number>;
  };
}

/** Strength distribution stats per memory type. */
export interface MemoryTypeStats {
  /** Total traces of this type. */
  count: number;
  /** Average encoding strength across traces. */
  avgStrength: number;
  /** Number of traces below 0.3 strength (fading). */
  decaying: number;
  /** Number of flashbulb-strength traces (above 0.8). */
  flashbulb: number;
}

export type {
  EmbeddingConfig,
  ExtendedConsolidationConfig,
  IngestionConfig,
  MemoryConfig,
  RememberOptions,
  RecallOptions,
  IngestOptions,
  IngestResult,
  ExportOptions,
  ImportOptions,
  ImportResult,
  ConsolidationResult,
  MemoryHealth,
  LoadOptions,
  LoadedDocument,
  DocumentMetadata,
  DocumentChunk,
  ExtractedImage,
  ExtractedTable,
} from '../io/facade/types.js';

export type {
  CompactionEntry,
  CompactionInput,
  CompactionResult,
  ContextMessage,
  ICompactionStrategy,
  InfiniteContextConfig,
  SummaryChainNode,
} from '../pipeline/context/types.js';
