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
 * - `additional_angles` — Generate extra viewpoint references against the
 *   anchor portrait, one per angle (by default the three-quarter and profile
 *   views; {@link AvatarGenerationRequest.angles} replaces them). It runs only
 *   when named in {@link AvatarGenerationRequest.stages}.
 */
export type AvatarGenerationStage =
  | 'neutral_portrait'
  | 'face_embedding'
  | 'expression_sheet'
  | 'animated_emotes'
  | 'full_body'
  | 'additional_angles';

// ---------------------------------------------------------------------------
// Caller-owned acceptance check
// ---------------------------------------------------------------------------

/** What the pipeline hands a caller's acceptance check for one candidate image. */
export interface AvatarAcceptanceCheckArgs {
  /** The anchor portrait the candidate was drawn against; undefined when the run has none. */
  referenceUrl?: string;
  /** The image just generated. */
  candidateUrl: string;
  /** The stage that drew the candidate. */
  stage: AvatarGenerationStage;
  /** The job's label (e.g. "expression:happy", "angle:profile view", "full_body"). */
  label: string;
  /** Which attempt this candidate is, starting at 1. */
  attempt: number;
}

/** A caller's verdict on one candidate image. */
export interface AvatarAcceptanceVerdict {
  /** True keeps the candidate; false regenerates it while attempts remain. */
  accepted: boolean;
  /** Why the candidate was refused (or any note on an accepted one). */
  reason?: string;
}

/**
 * A caller's acceptance check, run on every image drawn against the anchor
 * (the expression sheet, the additional angles and the full-body image). When
 * given it replaces the embedding drift check: the pipeline extracts and
 * compares no face embedding, skips the `face_embedding` stage and returns no
 * drift report. A refused candidate is drawn again, up to
 * `driftGuard.maxRegenerationAttempts` draws in all; a job whose every attempt is
 * refused fails with the last reason and its image is left out of the
 * identity package. A check that throws fails that job with the error's
 * message and draws no more for it; the job keeps the draws made in
 * `attempts` and the check's last verdict in `acceptance`. A caller that
 * wants to keep a render its check could not judge returns
 * `{ accepted: true }` itself.
 */
export type AvatarAcceptanceCheck = (
  args: AvatarAcceptanceCheckArgs,
) => Promise<AvatarAcceptanceVerdict>;

// ---------------------------------------------------------------------------
// Request / Job / Report
// ---------------------------------------------------------------------------

/** Input to the avatar generation pipeline. */
export interface AvatarGenerationRequest {
  /** Character identifier for the generated identity package. */
  characterId: string;
  /** Identity descriptors driving image generation prompts. */
  identity: AvatarIdentityDescriptor;
  /**
   * Which stages to execute. Defaults to every stage but `additional_angles`,
   * which runs only when named here.
   */
  stages?: AvatarGenerationStage[];
  /**
   * The emotions the `expression_sheet` and `animated_emotes` stages draw, in
   * place of `AVATAR_EMOTIONS` (prompts.ts). A repeated emotion is drawn once;
   * `neutral` in the expression sheet reuses the anchor portrait. An emotion
   * left out of the list is never drawn.
   */
  emotions?: readonly string[];
  /**
   * The viewpoints the `additional_angles` stage draws, each as words
   * appended to the portrait prompt, in place of `AVATAR_ANGLES` (prompts.ts).
   * A repeated angle is drawn once. The identity package's
   * `anchors.additionalAngles` lists the accepted images in this order; each
   * job's label (`angle:<words>`) maps an angle to its image.
   */
  angles?: readonly string[];
  /** A caller's acceptance check in place of the embedding drift check. */
  acceptanceCheck?: AvatarAcceptanceCheck;
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
    /**
     * Maximum attempts per image when its face drifts or the acceptance check
     * refuses it: draws in all, the first included. Below 1, or NaN, counts as 1,
     * and the identity package's `driftGuard` records the limit drawn under.
     */
    maxRegenerationAttempts?: number;
  };
  /** Pre-existing anchors to reuse instead of regenerating. */
  existingAnchors?: {
    neutralPortrait?: string;
    faceEmbedding?: number[];
  };
  /**
   * Invoked after each pipeline job settles (completed, failed or skipped), before the
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
  /** Drift similarity score (for the expression sheet and the additional angles). */
  driftScore?: number;
  /** The caller's acceptance check's last verdict on this job, when one ran. */
  acceptance?: AvatarAcceptanceVerdict;
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
  /**
   * Drift audit report (present when the run had a face embedding and no
   * acceptance check; with an acceptance check the jobs carry each verdict).
   */
  driftReport?: DriftAuditReport;
  /** Total wall-clock time in milliseconds. */
  totalDurationMs: number;
}
