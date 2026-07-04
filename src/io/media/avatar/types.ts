/**
 * @file types.ts
 * Type definitions for the avatar generation pipeline.
 *
 * Covers the full lifecycle: request → staged jobs → drift audit → result.
 */

import type { AvatarIdentityDescriptor, AvatarIdentityPackage } from '../../../api/types.js';
import type { PolicyTier } from '../../../core/llm/routing/UncensoredModelCatalog.js';

// ---------------------------------------------------------------------------
// Pipeline stages
// ---------------------------------------------------------------------------

/**
 * Discrete stages of the avatar generation pipeline, executed in order.
 *
 * - `neutral_portrait` — Generate the canonical neutral-expression portrait.
 * - `face_embedding` — Extract a 512-dim face vector from the neutral portrait.
 * - `expression_sheet` — Generate emotion variants and drift-check each one.
 * - `animated_emotes` — Generate animated emote loops per emotion.
 * - `full_body` — Generate a full-body reference image.
 * - `additional_angles` — Generate extra viewpoint references (3/4, profile).
 */
export type AvatarGenerationStage =
  | 'neutral_portrait'
  | 'face_embedding'
  | 'expression_sheet'
  | 'animated_emotes'
  | 'full_body'
  | 'additional_angles';

// ---------------------------------------------------------------------------
// Request / Job / Report
// ---------------------------------------------------------------------------

/** Input to the avatar generation pipeline. */
export interface AvatarGenerationRequest {
  /** Character identifier for the generated identity package. */
  characterId: string;
  /** Identity descriptors driving image generation prompts. */
  identity: AvatarIdentityDescriptor;
  /** Which stages to execute (defaults to all). */
  stages?: AvatarGenerationStage[];
  /** Content policy tier forwarded to the image generator. */
  policyTier?: PolicyTier;
  /** Image generation parameters. */
  generationConfig: {
    /** Model identifier (e.g. "black-forest-labs/flux-schnell"). */
    baseModel: string;
    /** Provider identifier (e.g. "replicate"). */
    provider: string;
    /** Random seed for reproducible output. */
    seed?: number;
    /** Negative prompt to avoid unwanted artefacts. */
    negativePrompt?: string;
    /** Named style preset (provider-specific). */
    stylePreset?: string;
  };
  /** Drift-guard thresholds. */
  driftGuard?: {
    /** Minimum cosine similarity to the anchor face embedding. */
    faceSimilarity?: number;
    /** Reject images below the similarity threshold. */
    rejectBelowThreshold?: boolean;
    /** Maximum retries when generated face drifts. */
    maxRegenerationAttempts?: number;
  };
  /** Pre-existing anchors to reuse instead of regenerating. */
  existingAnchors?: {
    neutralPortrait?: string;
    faceEmbedding?: number[];
  };
  /**
   * Invoked after each pipeline job settles (completed or failed), before the
   * next job in the same worker lane starts. Lets callers persist per-emotion
   * results incrementally instead of waiting for the whole sheet — e.g. a UI
   * polling for expression images can render each one as it lands. Callback
   * errors are swallowed; the job records on the final result stay
   * authoritative. Jobs from concurrent lanes may invoke this interleaved, so
   * callers that mutate shared state must serialize their own writes.
   */
  onJobComplete?: (job: AvatarGenerationJob) => void | Promise<void>;
}

/** Tracking record for a single pipeline job. */
export interface AvatarGenerationJob {
  /** Which stage this job belongs to. */
  stage: AvatarGenerationStage;
  /** Human-readable label (e.g. "neutral_portrait", "expression:happy"). */
  label: string;
  /** Job status. */
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  /** Generated image URL on success. */
  imageUrl?: string;
  /** Drift similarity score (for expression/emote stages). */
  driftScore?: number;
  /** Number of regeneration attempts for this job. */
  attempts: number;
  /** Error message on failure. */
  error?: string;
  /** Wall-clock duration in milliseconds. */
  durationMs?: number;
}

/** Aggregate drift audit across all generated assets. */
export interface DriftAuditReport {
  /** Anchor face embedding used as the reference. */
  anchorEmbeddingDim: number;
  /** Per-image drift scores keyed by label. */
  scores: Record<string, number>;
  /** Labels of images that were rejected for excessive drift. */
  rejected: string[];
  /** Labels of images that were regenerated (at least once). */
  regenerated: string[];
  /** Overall pass/fail for the entire batch. */
  passed: boolean;
}

/** Output of a complete avatar generation pipeline run. */
export interface AvatarGenerationResult {
  /** The assembled identity package. */
  identityPackage: AvatarIdentityPackage;
  /** Per-stage job records for observability. */
  jobs: AvatarGenerationJob[];
  /** Drift audit report (present when face_embedding stage ran). */
  driftReport?: DriftAuditReport;
  /** Total wall-clock time in milliseconds. */
  totalDurationMs: number;
}
