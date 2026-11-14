/**
 * @file AvatarPipeline.ts
 * Core orchestrator for staged avatar image generation.
 *
 * Executes the avatar pipeline stages in order — neutral portrait, face
 * embedding extraction, expression sheet, animated emotes, full body,
 * additional angles — with cosine-similarity drift checking against the
 * anchor face embedding, or a caller's acceptance check in its place.
 * Images that drift too far from the anchor, or that the caller's check
 * refuses, are regenerated up to a configurable maximum number of attempts.
 */

import { randomUUID } from 'crypto';
import type { IFaceEmbeddingService } from '../images/face/IFaceEmbeddingService.js';
import type { PolicyTier } from '../../../core/llm/routing/UncensoredModelCatalog.js';
import type {
  AvatarAcceptanceCheck,
  AvatarAcceptanceVerdict,
  AvatarGenerationRequest,
  AvatarGenerationResult,
  AvatarGenerationJob,
  AvatarGenerationStage,
  DriftAuditReport,
} from './types.js';
import type { AvatarIdentityPackage } from '../../../api/types.js';
import {
  AVATAR_ANGLES,
  AVATAR_EMOTIONS,
  buildAnglePrompt,
  buildPortraitPrompt,
  buildExpressionPrompt,
  buildEmotePrompt,
} from './prompts.js';

// ---------------------------------------------------------------------------
// Image generator function signature
// ---------------------------------------------------------------------------

/** Options the pipeline passes to the image generator on every call. */
export interface ImageGeneratorOptions {
  seed?: number;
  negativePrompt?: string;
  stylePreset?: string;
  policyTier?: PolicyTier;
  /** Reference image URL for character/face consistency. */
  referenceImageUrl?: string;
  /** Pre-computed face embedding vector for drift detection. */
  faceEmbedding?: number[];
  /** Consistency mode: 'strict' for expressions, 'balanced' for body and angles. */
  consistencyMode?: 'strict' | 'balanced' | 'loose';
  /** The stage this call draws for, so a caller can route or account per stage. */
  stage?: AvatarGenerationStage;
  /** The job's label (e.g. "expression:happy", "angle:profile view"). */
  label?: string;
  /**
   * Which draw of this image the call is, starting at 1, on the images the
   * pipeline may draw again (the expression sheet, the additional angles, and
   * the full-body image under an acceptance check). A generator that sends a
   * fixed seed varies it by this number, or every redraw repeats the image
   * that was refused.
   */
  attempt?: number;
}

/**
 * Function that generates an image from a text prompt.
 *
 * Abstracts away the underlying provider (Replicate, Stability, etc.)
 * so the pipeline does not depend on a concrete image provider. The
 * options name the stage and the job's label, so one function can route
 * each stage to its own provider or model.
 *
 * @param prompt - Text prompt describing the desired image.
 * @param options - Generation options forwarded to the provider.
 * @returns URL of the generated image.
 */
export type ImageGeneratorFn = (
  prompt: string,
  options: ImageGeneratorOptions,
) => Promise<string>;

// ---------------------------------------------------------------------------
// Default thresholds
// ---------------------------------------------------------------------------

const DEFAULT_DRIFT_SIMILARITY = 0.6;
const DEFAULT_REJECT_BELOW_THRESHOLD = true;
const DEFAULT_MAX_REGEN_ATTEMPTS = 3;

/** The stages a request without `stages` runs: every stage but `additional_angles`. */
const ALL_STAGES: AvatarGenerationStage[] = [
  'neutral_portrait',
  'face_embedding',
  'expression_sheet',
  'animated_emotes',
  'full_body',
];

/**
 * Cap on concurrent image generations within a single expression-sheet,
 * emote-sheet or angles render. The per-item jobs are independent — each
 * reads the shared neutral-portrait anchor + face embedding and writes only
 * its own result — so they run in bounded-parallel batches instead of one slow
 * sequential pass. An 8-emotion sheet drops from ~8× a single image's wall
 * time to ~2×. Bounded (not an unbounded `Promise.all`) so the underlying
 * image provider isn't flooded / rate-limited.
 */
const EMOTION_GENERATION_CONCURRENCY = 4;

/**
 * Run `fn` over `items` with at most `limit` concurrent in-flight calls.
 * A fixed pool of workers drains a shared cursor, so the slowest item never
 * blocks the others and the concurrency ceiling is never exceeded.
 */
async function runBounded<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++;
      await fn(items[index]!);
    }
  };
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

/**
 * Sets a key as the map's own property, so a caller's emotion named `__proto__` is kept as a key like any other
 * instead of reaching the object's prototype.
 */
function setOwn(map: Record<string, string>, key: string, value: string): void {
  Object.defineProperty(map, key, { value, enumerable: true, writable: true, configurable: true });
}

/** A caller's list with repeats removed, first occurrence kept, or the default list. */
function listOrDefault(list: readonly string[] | undefined, fallback: readonly string[]): string[] {
  return [...new Set(list ?? fallback)];
}

/** Drift-guard settings resolved from the request. */
interface DriftConfig {
  faceSimilarity: number;
  rejectBelowThreshold: boolean;
  maxRegenerationAttempts: number;
}

/** The outcome of drawing one image under a check. */
interface CheckedDraw {
  /** The image kept, or undefined when every attempt was refused. */
  imageUrl?: string;
  /** Attempts made. */
  attempts: number;
  /** Best drift similarity seen, or -1 when no drift score was taken. */
  bestScore: number;
  /** The acceptance check's last verdict, when the caller's check ran. */
  verdict?: AvatarAcceptanceVerdict;
  /** The message of the acceptance check's throw, which ended the draws. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * Orchestrates multi-stage avatar image generation with drift detection.
 *
 * Stages run in dependency order. The expression sheet and additional angle
 * stages drift-check each generated image against the anchor face embedding
 * and regenerate on low similarity. A request's `acceptanceCheck` replaces
 * the drift check on those stages and also checks the full-body image.
 */
export class AvatarPipeline {
  private readonly faceService: IFaceEmbeddingService;
  private readonly generateImage: ImageGeneratorFn;

  /**
   * @param faceService - Face embedding extraction and comparison service.
   *   Never called on a request that carries an `acceptanceCheck`.
   * @param generateImage - Image generation function (prompt → URL).
   */
  constructor(faceService: IFaceEmbeddingService, generateImage: ImageGeneratorFn) {
    this.faceService = faceService;
    this.generateImage = generateImage;
  }

  /**
   * Fire the caller's `onJobComplete` hook for a settled job. Await inside a
   * try/catch so a throwing callback can neither abort the pipeline nor
   * reorder subsequent jobs in the same worker lane; the job records on the
   * final result remain the authoritative outcome.
   */
  private async notifyJobComplete(
    request: AvatarGenerationRequest,
    job: AvatarGenerationJob,
  ): Promise<void> {
    if (!request.onJobComplete) return;
    try {
      await request.onJobComplete(job);
    } catch {
      // Caller-side persistence is best-effort; swallow and continue.
    }
  }

  /**
   * Execute the avatar generation pipeline.
   *
   * @param request - Generation request with identity, stages, and config.
   * @returns Result containing the identity package, job records, and drift report.
   */
  async generate(request: AvatarGenerationRequest): Promise<AvatarGenerationResult> {
    const startTime = Date.now();
    const stages = request.stages ?? ALL_STAGES;
    const emotions = listOrDefault(request.emotions, AVATAR_EMOTIONS);
    const angles = listOrDefault(request.angles, AVATAR_ANGLES);
    const acceptanceCheck = request.acceptanceCheck;
    const jobs: AvatarGenerationJob[] = [];

    const driftConfig: DriftConfig = {
      faceSimilarity: request.driftGuard?.faceSimilarity ?? DEFAULT_DRIFT_SIMILARITY,
      rejectBelowThreshold: request.driftGuard?.rejectBelowThreshold ?? DEFAULT_REJECT_BELOW_THRESHOLD,
      // Every checked image is drawn at least once, so below 1 or NaN means one draw, and the package records that.
      maxRegenerationAttempts: Math.max(1, (request.driftGuard?.maxRegenerationAttempts ?? DEFAULT_MAX_REGEN_ATTEMPTS) || 1),
    };

    // Mutable state accumulated across stages
    let neutralPortraitUrl = request.existingAnchors?.neutralPortrait ?? '';
    let faceEmbedding: number[] | undefined = request.existingAnchors?.faceEmbedding;
    const expressionSheet: Record<string, string> = {};
    const animatedEmotes: Record<string, string> = {};
    let fullBodyUrl: string | undefined;
    const additionalAngles: string[] = [];

    const driftScores: Record<string, number> = {};
    const driftRejected: string[] = [];
    const driftRegenerated: string[] = [];

    const baseOptions = (): ImageGeneratorOptions => ({
      seed: request.generationConfig.seed,
      negativePrompt: request.generationConfig.negativePrompt,
      stylePreset: request.generationConfig.stylePreset,
      policyTier: request.policyTier,
    });

    // -----------------------------------------------------------------------
    // Stage: neutral_portrait
    // -----------------------------------------------------------------------
    if (stages.includes('neutral_portrait') && !neutralPortraitUrl) {
      const job = this.createJob('neutral_portrait', 'neutral_portrait');
      const jobStart = Date.now();
      try {
        job.status = 'running';
        const prompt = buildPortraitPrompt(request.identity);
        neutralPortraitUrl = await this.generateImage(prompt, {
          ...baseOptions(),
          stage: 'neutral_portrait',
          label: job.label,
        });
        job.imageUrl = neutralPortraitUrl;
        job.status = 'completed';
        job.attempts = 1;
      } catch (err) {
        job.status = 'failed';
        job.error = err instanceof Error ? err.message : String(err);
      }
      job.durationMs = Date.now() - jobStart;
      jobs.push(job);
      await this.notifyJobComplete(request, job);
    }

    // -----------------------------------------------------------------------
    // Stage: face_embedding
    // -----------------------------------------------------------------------
    if (stages.includes('face_embedding') && !faceEmbedding && neutralPortraitUrl) {
      const job = this.createJob('face_embedding', 'face_embedding');
      const jobStart = Date.now();
      if (acceptanceCheck) {
        // The caller's check replaces the drift check, so no embedding is computed.
        job.status = 'skipped';
      } else {
        try {
          job.status = 'running';
          const result = await this.faceService.extractEmbedding(neutralPortraitUrl);
          faceEmbedding = result.vector;
          job.status = 'completed';
          job.attempts = 1;
        } catch (err) {
          job.status = 'failed';
          job.error = err instanceof Error ? err.message : String(err);
        }
      }
      job.durationMs = Date.now() - jobStart;
      jobs.push(job);
      await this.notifyJobComplete(request, job);
    }

    const settle = (job: AvatarGenerationJob, drawn: CheckedDraw): void => {
      this.settleCheckedJob(job, drawn, driftConfig, driftScores, driftRejected, Boolean(acceptanceCheck));
    };

    // -----------------------------------------------------------------------
    // Stage: expression_sheet
    // -----------------------------------------------------------------------
    if (stages.includes('expression_sheet')) {
      await runBounded(emotions, EMOTION_GENERATION_CONCURRENCY, async (emotion) => {
        // Neutral portrait is already the anchor; skip re-generating it
        if (emotion === 'neutral') {
          if (neutralPortraitUrl) {
            expressionSheet.neutral = neutralPortraitUrl;
          }
          return;
        }

        const label = `expression:${emotion}`;
        const job = this.createJob('expression_sheet', label);
        const jobStart = Date.now();

        try {
          job.status = 'running';
          const drawn = await this.drawChecked({
            stage: 'expression_sheet',
            label,
            prompt: buildExpressionPrompt(request.identity, emotion),
            options: {
              ...baseOptions(),
              referenceImageUrl: neutralPortraitUrl || undefined,
              faceEmbedding: faceEmbedding ?? undefined,
              consistencyMode: 'strict',
            },
            referenceUrl: neutralPortraitUrl || undefined,
            driftEmbedding: faceEmbedding,
            acceptanceCheck,
            driftConfig,
            driftRegenerated,
          });
          if (drawn.imageUrl) {
            setOwn(expressionSheet, emotion, drawn.imageUrl);
          }
          settle(job, drawn);
        } catch (err) {
          job.status = 'failed';
          job.error = err instanceof Error ? err.message : String(err);
        }

        job.durationMs = Date.now() - jobStart;
        jobs.push(job);
        await this.notifyJobComplete(request, job);
      });
    }

    // -----------------------------------------------------------------------
    // Stage: animated_emotes
    // -----------------------------------------------------------------------
    if (stages.includes('animated_emotes')) {
      await runBounded(emotions, EMOTION_GENERATION_CONCURRENCY, async (emotion) => {
        const label = `emote:${emotion}`;
        const job = this.createJob('animated_emotes', label);
        const jobStart = Date.now();

        try {
          job.status = 'running';
          const prompt = buildEmotePrompt(emotion);
          const url = await this.generateImage(prompt, {
            seed: request.generationConfig.seed,
            negativePrompt: request.generationConfig.negativePrompt,
            policyTier: request.policyTier,
            stage: 'animated_emotes',
            label,
          });
          setOwn(animatedEmotes, emotion, url);
          job.imageUrl = url;
          job.status = 'completed';
          job.attempts = 1;
        } catch (err) {
          job.status = 'failed';
          job.error = err instanceof Error ? err.message : String(err);
        }

        job.durationMs = Date.now() - jobStart;
        jobs.push(job);
        await this.notifyJobComplete(request, job);
      });
    }

    // -----------------------------------------------------------------------
    // Stage: full_body
    // -----------------------------------------------------------------------
    if (stages.includes('full_body')) {
      const job = this.createJob('full_body', 'full_body');
      const jobStart = Date.now();

      try {
        job.status = 'running';
        const basePrompt = buildPortraitPrompt(request.identity);
        const prompt = basePrompt.replace(/^portrait of/, 'full body shot of');
        const options: ImageGeneratorOptions = {
          ...baseOptions(),
          referenceImageUrl: neutralPortraitUrl || undefined,
          faceEmbedding: faceEmbedding ?? undefined,
          consistencyMode: 'balanced',
          stage: 'full_body',
          label: job.label,
        };
        if (acceptanceCheck) {
          // Only the caller's check runs here; the full-body image takes no drift check.
          const drawn = await this.drawChecked({
            stage: 'full_body',
            label: job.label,
            prompt,
            options,
            referenceUrl: neutralPortraitUrl || undefined,
            driftEmbedding: undefined,
            acceptanceCheck,
            driftConfig,
            driftRegenerated,
          });
          fullBodyUrl = drawn.imageUrl;
          settle(job, drawn);
        } else {
          fullBodyUrl = await this.generateImage(prompt, options);
          job.imageUrl = fullBodyUrl;
          job.status = 'completed';
          job.attempts = 1;
        }
      } catch (err) {
        job.status = 'failed';
        job.error = err instanceof Error ? err.message : String(err);
      }

      job.durationMs = Date.now() - jobStart;
      jobs.push(job);
      await this.notifyJobComplete(request, job);
    }

    // -----------------------------------------------------------------------
    // Stage: additional_angles
    // -----------------------------------------------------------------------
    if (stages.includes('additional_angles')) {
      const angleUrls = new Map<string, string>();
      await runBounded(angles, EMOTION_GENERATION_CONCURRENCY, async (angle) => {
        const label = `angle:${angle}`;
        const job = this.createJob('additional_angles', label);
        const jobStart = Date.now();

        try {
          job.status = 'running';
          const drawn = await this.drawChecked({
            stage: 'additional_angles',
            label,
            prompt: buildAnglePrompt(request.identity, angle),
            options: {
              ...baseOptions(),
              referenceImageUrl: neutralPortraitUrl || undefined,
              faceEmbedding: faceEmbedding ?? undefined,
              consistencyMode: 'balanced',
            },
            referenceUrl: neutralPortraitUrl || undefined,
            driftEmbedding: faceEmbedding,
            acceptanceCheck,
            driftConfig,
            driftRegenerated,
          });
          if (drawn.imageUrl) {
            angleUrls.set(angle, drawn.imageUrl);
          }
          settle(job, drawn);
        } catch (err) {
          job.status = 'failed';
          job.error = err instanceof Error ? err.message : String(err);
        }

        job.durationMs = Date.now() - jobStart;
        jobs.push(job);
        await this.notifyJobComplete(request, job);
      });
      // The angles render concurrently; the package lists them in the request's order.
      for (const angle of angles) {
        const url = angleUrls.get(angle);
        if (url) additionalAngles.push(url);
      }
    }

    // -----------------------------------------------------------------------
    // Assemble identity package
    // -----------------------------------------------------------------------
    const now = new Date().toISOString();
    const identityPackage: AvatarIdentityPackage = {
      id: randomUUID(),
      characterId: request.characterId,
      identity: request.identity,
      anchors: {
        neutralPortrait: neutralPortraitUrl,
        expressionSheet: Object.keys(expressionSheet).length > 0 ? expressionSheet : undefined,
        animatedEmotes: Object.keys(animatedEmotes).length > 0 ? animatedEmotes : undefined,
        fullBody: fullBodyUrl,
        additionalAngles: additionalAngles.length > 0 ? additionalAngles : undefined,
      },
      faceEmbedding,
      driftGuard: driftConfig,
      generationConfig: request.generationConfig,
      createdAt: now,
      updatedAt: now,
    };

    // -----------------------------------------------------------------------
    // Drift report
    // -----------------------------------------------------------------------
    let driftReport: DriftAuditReport | undefined;
    if (faceEmbedding && !acceptanceCheck) {
      driftReport = {
        anchorEmbeddingDim: faceEmbedding.length,
        scores: driftScores,
        rejected: driftRejected,
        regenerated: [...new Set(driftRegenerated)],
        passed: driftRejected.length === 0,
      };
    }

    return {
      identityPackage,
      jobs,
      driftReport,
      totalDurationMs: Date.now() - startTime,
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Draw one image against the anchor, regenerating while attempts remain.
   *
   * With the caller's acceptance check, a candidate is kept when the check
   * accepts it and nothing else is checked. Without it, a candidate is
   * compared with the anchor embedding by cosine similarity: the best-scoring
   * candidate is kept and drawing stops at the first match; a candidate whose
   * face cannot be extracted is kept as it is. With neither, the first
   * candidate is kept. A throw from the generator propagates. A throw from the
   * check ends the draws and comes back as `error`, with the attempts made and
   * the check's last verdict, so the job records them.
   */
  private async drawChecked(args: {
    stage: AvatarGenerationStage;
    label: string;
    prompt: string;
    options: ImageGeneratorOptions;
    referenceUrl: string | undefined;
    driftEmbedding: number[] | undefined;
    acceptanceCheck: AvatarAcceptanceCheck | undefined;
    driftConfig: DriftConfig;
    driftRegenerated: string[];
  }): Promise<CheckedDraw> {
    const { stage, label, prompt, referenceUrl, driftEmbedding, acceptanceCheck, driftConfig } = args;
    let imageUrl: string | undefined;
    let bestScore = -1;
    let attempts = 0;
    let verdict: AvatarAcceptanceVerdict | undefined;

    // Every checked image is drawn at least once, so 0 or NaN means one draw, never none.
    const maxAttempts = Math.max(1, driftConfig.maxRegenerationAttempts || 1);
    while (attempts < maxAttempts) {
      attempts++;
      const options: ImageGeneratorOptions = { ...args.options, stage, label, attempt: attempts };
      const url = await this.generateImage(prompt, options);

      if (acceptanceCheck) {
        let answer: Awaited<ReturnType<AvatarAcceptanceCheck>>;
        try {
          answer = await acceptanceCheck({
            referenceUrl,
            candidateUrl: url,
            stage,
            label,
            attempt: attempts,
          });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          return { imageUrl: undefined, attempts, bestScore, verdict, error };
        }
        const accepted = answer?.accepted === true;
        verdict = answer?.reason !== undefined ? { accepted, reason: answer.reason } : { accepted };
        if (accepted) {
          imageUrl = url;
          break;
        }
        continue;
      }

      // Drift check against anchor embedding
      if (driftEmbedding) {
        try {
          const generated = await this.faceService.extractEmbedding(url);
          const comparison = this.faceService.compareFaces(
            driftEmbedding,
            generated.vector,
            driftConfig.faceSimilarity,
          );
          if (comparison.similarity > bestScore) {
            bestScore = comparison.similarity;
            imageUrl = url;
          }
          if (comparison.match) {
            break; // Acceptable drift
          }
          if (attempts > 1) {
            args.driftRegenerated.push(label);
          }
        } catch {
          // If face extraction fails on the generated image, accept it
          imageUrl = url;
          break;
        }
      } else {
        // No anchor embedding available — accept the first result
        imageUrl = url;
        break;
      }
    }

    return { imageUrl, attempts, bestScore, verdict };
  }

  /** Record a checked draw's outcome on its job and in the drift report's tallies. */
  private settleCheckedJob(
    job: AvatarGenerationJob,
    drawn: CheckedDraw,
    driftConfig: DriftConfig,
    driftScores: Record<string, number>,
    driftRejected: string[],
    callerChecked: boolean,
  ): void {
    if (drawn.verdict) {
      job.acceptance = drawn.verdict;
    }

    if (drawn.imageUrl) {
      job.imageUrl = drawn.imageUrl;
      job.driftScore = drawn.bestScore >= 0 ? drawn.bestScore : undefined;
      job.status = 'completed';

      if (drawn.bestScore >= 0) {
        driftScores[job.label] = drawn.bestScore;
        if (drawn.bestScore < driftConfig.faceSimilarity && driftConfig.rejectBelowThreshold) {
          driftRejected.push(job.label);
        }
      }
    } else {
      job.status = 'failed';
      job.error = drawn.error ?? (callerChecked
        ? (drawn.verdict?.reason ?? 'Refused by the acceptance check.')
        : 'All regeneration attempts failed drift check.');
    }

    job.attempts = drawn.attempts;
  }

  private createJob(stage: AvatarGenerationStage, label: string): AvatarGenerationJob {
    return {
      stage,
      label,
      status: 'pending',
      attempts: 0,
    };
  }
}
