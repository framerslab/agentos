/**
 * @fileoverview Configuration and shared types for cognitive mechanisms.
 *
 * Each mechanism is individually toggleable and tunable. When the top-level
 * `cognitiveMechanisms` field is `undefined` on `CognitiveMemoryConfig`,
 * the engine is never instantiated and zero code paths execute.
 *
 * @module agentos/memory/mechanisms/types
 */

import type { PADState } from '../core/config.js';
import type { MemorySourceType } from '../core/types.js';

/**
 * The tag of a correction: the trace a person's own correction of what is remembered of them is stored as.
 * Reconsolidation and temporal gist leave a trace that carries it as it is.
 */
export const CORRECTION_TAG = 'correction';

// ---------------------------------------------------------------------------
// Per-mechanism configs
// ---------------------------------------------------------------------------

/** Reconsolidation config (Nader, Schafe & Le Doux, 2000). */
export interface ReconsolidationConfig {
  /** @default true */
  enabled?: boolean;
  /** Fraction of PAD delta applied per retrieval. @default 0.05 */
  driftRate?: number;
  /** Maximum cumulative drift allowed per trace. @default 0.4 */
  maxDriftPerTrace?: number;
  /** Traces with importance >= this value resist drift. @default 9 */
  immuneAboveImportance?: number;
}

/** Retrieval-Induced Forgetting config (Anderson, Bjork & Bjork, 1994). */
export interface RetrievalInducedForgettingConfig {
  /** @default true */
  enabled?: boolean;
  /** Cosine similarity threshold to identify competitors. @default 0.7 */
  similarityThreshold?: number;
  /** Stability reduction factor for suppressed competitors. @default 0.12 */
  suppressionFactor?: number;
  /** Maximum competitors suppressed per query. @default 5 */
  maxSuppressionsPerQuery?: number;
}

/** Involuntary Recall config (Berntsen, 2009). */
export interface InvoluntaryRecallConfig {
  /** @default true */
  enabled?: boolean;
  /** Probability of surfacing an involuntary memory per assembly. @default 0.08 */
  probability?: number;
  /** Minimum age in days for involuntary recall candidates. @default 14 */
  minAgeDays?: number;
  /** Minimum Ebbinghaus strength for candidates. @default 0.15 */
  minStrength?: number;
}

/** Metacognitive Feeling-of-Knowing config (Nelson & Narens, 1990). */
export interface MetacognitiveFOKConfig {
  /** @default true */
  enabled?: boolean;
  /** Score threshold for partial activation zone. @default 0.3 */
  partialActivationThreshold?: number;
  /** Whether to surface TOT signals in assembled prompt. @default true */
  surfaceTipOfTongue?: boolean;
}

/** Temporal Gist config (Reyna & Brainerd, 1995). */
export interface TemporalGistConfig {
  /** @default true */
  enabled?: boolean;
  /** Age in days before gist extraction applies. @default 60 */
  ageThresholdDays?: number;
  /** Traces retrieved more than this many times are not gisted. @default 2 */
  minRetrievalCount?: number;
  /** Keep entity names in gist output. @default true */
  preserveEntities?: boolean;
  /** Keep emotional context in gist output. @default true */
  preserveEmotionalContext?: boolean;
}

/** Schema Encoding config (Bartlett, 1932; Tse et al., 2007). */
export interface SchemaEncodingConfig {
  /** @default true */
  enabled?: boolean;
  /** Cosine similarity to nearest cluster centroid for schema match. @default 0.75 */
  clusterSimilarityThreshold?: number;
  /** Encoding strength multiplier for schema-violating (novel) input. @default 1.3 */
  noveltyBoost?: number;
  /** Encoding strength multiplier for schema-congruent input. @default 0.85 */
  congruencyDiscount?: number;
}

/** Source Confidence Decay config (Johnson, Hashtroudi & Lindsay, 1993). */
export interface SourceConfidenceDecayConfig {
  /** @default true */
  enabled?: boolean;
  /** Per-source-type stability multiplier applied each consolidation cycle. */
  decayMultipliers?: Partial<Record<MemorySourceType, number>>;
}

/** Emotion Regulation config (Gross, 1998, 2015). */
export interface EmotionRegulationConfig {
  /** @default true */
  enabled?: boolean;
  /** Valence/arousal reduction rate per consolidation cycle. @default 0.15 */
  reappraisalRate?: number;
  /** Arousal above this triggers regulation. @default 0.8 */
  suppressionThreshold?: number;
  /** Maximum traces regulated per consolidation cycle. @default 10 */
  maxRegulationPerCycle?: number;
}

// ---------------------------------------------------------------------------
// Top-level config
// ---------------------------------------------------------------------------

/**
 * Per-mechanism toggle config for cognitive mechanisms.
 *
 * When present (even as `{}`), all mechanisms default to enabled with
 * sensible constants. When `undefined` on `CognitiveMemoryConfig`,
 * the engine is never instantiated.
 */
export interface CognitiveMechanismsConfig {
  reconsolidation?: Partial<ReconsolidationConfig>;
  retrievalInducedForgetting?: Partial<RetrievalInducedForgettingConfig>;
  involuntaryRecall?: Partial<InvoluntaryRecallConfig>;
  metacognitiveFOK?: Partial<MetacognitiveFOKConfig>;
  temporalGist?: Partial<TemporalGistConfig>;
  schemaEncoding?: Partial<SchemaEncodingConfig>;
  sourceConfidenceDecay?: Partial<SourceConfidenceDecayConfig>;
  emotionRegulation?: Partial<EmotionRegulationConfig>;
  /** 9th mechanism: Persona Drift (heuristic personality evolution from memory). */
  personaDrift?: Partial<import('./PersonaDriftMechanism.js').PersonaDriftConfig>;
}

// ---------------------------------------------------------------------------
// Shared output types
// ---------------------------------------------------------------------------

/** Metacognitive signal produced by FOK detection. */
export interface MetacognitiveSignal {
  type: 'tip_of_tongue' | 'low_confidence' | 'high_confidence';
  traceId: string;
  /** Feeling-of-knowing score, 0 (no idea) to 1 (certain it exists). */
  feelingOfKnowing: number;
  /** Partial info: entities, emotion, approximate timeframe. */
  partialInfo?: string;
}

/** A single reconsolidation drift event for audit trail. */
export interface DriftEvent {
  timestamp: number;
  beforePAD: PADState;
  afterPAD: PADState;
}

/** Optional metadata fields added to MemoryTrace.structuredData by mechanisms. */
export interface MechanismMetadata {
  /** Reconsolidation: cumulative absolute PAD drift. */
  cumulativeDrift?: number;
  /** Reconsolidation: audit trail of drift events. */
  driftHistory?: DriftEvent[];
  /** Temporal Gist: whether content has been compressed. */
  gisted?: boolean;
  /** Temporal Gist: SHA-256 of original content before gisting. */
  originalContentHash?: string;
  /** Schema Encoding: trace matched an existing schema cluster. */
  schemaCongruent?: boolean;
  /** Schema Encoding: trace violated all existing schemas (novel). */
  schemaViolating?: boolean;
  /** Schema Encoding: ID of the matched cluster. */
  schemaClusterId?: string;
  /** Source Confidence Decay: timestamp of last decay application. */
  lastSourceDecayAt?: number;
  /** Emotion Regulation: audit trail of reappraisal events. */
  reappraisalHistory?: Array<{
    reappraisedAt: number;
    previousValence: number;
    previousArousal: number;
  }>;
  /** PerspectiveObserver: trace was encoded through a persona lens. */
  perspectiveEncoded?: boolean;
  /** PerspectiveObserver: ID of the source objective event. */
  perspectiveSourceEventId?: string;
  /** PerspectiveObserver: SHA-256 of the source objective event content. */
  perspectiveSourceHash?: string;
}

// ---------------------------------------------------------------------------
// Resolved config (all fields required, used internally by engine)
// ---------------------------------------------------------------------------

export interface ResolvedReconsolidationConfig {
  enabled: boolean;
  driftRate: number;
  maxDriftPerTrace: number;
  immuneAboveImportance: number;
}

export interface ResolvedRIFConfig {
  enabled: boolean;
  similarityThreshold: number;
  suppressionFactor: number;
  maxSuppressionsPerQuery: number;
}

export interface ResolvedInvoluntaryRecallConfig {
  enabled: boolean;
  probability: number;
  minAgeDays: number;
  minStrength: number;
}

export interface ResolvedMetacognitiveFOKConfig {
  enabled: boolean;
  partialActivationThreshold: number;
  surfaceTipOfTongue: boolean;
}

export interface ResolvedTemporalGistConfig {
  enabled: boolean;
  ageThresholdDays: number;
  minRetrievalCount: number;
  preserveEntities: boolean;
  preserveEmotionalContext: boolean;
  /** Optional archive for write-ahead verbatim preservation before gisting. */
  archive?: import('../archive/IMemoryArchive.js').IMemoryArchive;
  /** Agent ID for archive records. Required when archive is set. */
  archiveAgentId?: string;
}

export interface ResolvedSchemaEncodingConfig {
  enabled: boolean;
  clusterSimilarityThreshold: number;
  noveltyBoost: number;
  congruencyDiscount: number;
}

export interface ResolvedSourceConfidenceDecayConfig {
  enabled: boolean;
  decayMultipliers: Record<MemorySourceType, number>;
}

export interface ResolvedEmotionRegulationConfig {
  enabled: boolean;
  reappraisalRate: number;
  suppressionThreshold: number;
  maxRegulationPerCycle: number;
}

/** Fully resolved config with all fields required. */
export interface ResolvedMechanismsConfig {
  reconsolidation: ResolvedReconsolidationConfig;
  retrievalInducedForgetting: ResolvedRIFConfig;
  involuntaryRecall: ResolvedInvoluntaryRecallConfig;
  metacognitiveFOK: ResolvedMetacognitiveFOKConfig;
  temporalGist: ResolvedTemporalGistConfig;
  schemaEncoding: ResolvedSchemaEncodingConfig;
  sourceConfidenceDecay: ResolvedSourceConfidenceDecayConfig;
  emotionRegulation: ResolvedEmotionRegulationConfig;
}
