/**
 * @file AvatarPipeline.ts
 * Core orchestrator for staged avatar image generation.
 *
 * Executes the avatar pipeline stages in order — neutral portrait, face
 * embedding extraction, expression sheet, animated emotes, full body —
 * with cosine-similarity drift checking against the anchor face embedding.
 * Images that drift too far from the anchor are regenerated up to a
 * configurable maximum number of attempts.
 */

import { randomUUID } from 'crypto';
import type { IFaceEmbeddingService } from '../images/face/IFaceEmbeddingService.js';
import type { PolicyTier } from '../../../core/llm/routing/UncensoredModelCatalog.js';
import type {
  AvatarGenerationRequest,
  AvatarGenerationResult,
  AvatarGenerationJob,
  AvatarGenerationStage,
  DriftAuditReport,
} from './types.js';
import type { AvatarIdentityPackage } from '../../../api/types.js';
import { AVATAR_EMOTIONS, buildPortraitPrompt, buildExpressionPrompt, buildEmotePrompt } from './prompts.js';

// ---------------------------------------------------------------------------
// Image generator function signature
// ---------------------------------------------------------------------------

/**
 * Function that generates an image from a text prompt.
 *
 * Abstracts away the underlying provider (Replicate, Stability, etc.)
 * so the pipeline does not depend on a concrete image provider.
 *
 * @param prompt - Text prompt describing the desired image.
 * @param options - Generation options forwarded to the provider.
 * @returns URL of the generated image.
 */
export type ImageGeneratorFn = (
  prompt: string,
  options: {
    seed?: number;
    negativePrompt?: string;
    stylePreset?: string;
    policyTier?: PolicyTier;
    /** Reference image URL for character/face consistency. */
    referenceImageUrl?: string;
    /** Pre-computed face embedding vector for drift detection. */
    faceEmbedding?: number[];
    /** Consistency mode: 'strict' for expressions, 'balanced' for body. */
    consistencyMode?: 'strict' | 'balanced' | 'loose';
  },
) => Promise<string>;

// ---------------------------------------------------------------------------
// Default thresholds
// ---------------------------------------------------------------------------

const DEFAULT_DRIFT_SIMILARITY = 0.6;
const DEFAULT_REJECT_BELOW_THRESHOLD = true;
const DEFAULT_MAX_REGEN_ATTEMPTS = 3;

const ALL_STAGES: AvatarGenerationStage[] = [
  'neutral_portrait',
  'face_embedding',
  'expression_sheet',
  'animated_emotes',
  'full_body',
];

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * Orchestrates multi-stage avatar image generation with drift detection.
 *
 * Stages run in dependency order. The expression sheet and animated emote
 * stages drift-check each generated image against the anchor face embedding
 * and regenerate on low similarity.
 */
/**
 * Cap on concurrent image generations within a single expression-sheet or
 * emote-sheet render. The per-emotion jobs are independent — each reads the
 * shared neutral-portrait anchor + face embedding and writes only its own
 * result — so they run in bounded-parallel batches instead of one slow
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

export class AvatarPipeline {
  private readonly faceService: IFaceEmbeddingService;
  private readonly generateImage: ImageGeneratorFn;

  /**
   * @param faceService - Face embedding extraction and comparison service.
   * @param generateImage - Image generation function (prompt → URL).
   */
  constructor(faceService: IFaceEmbeddingService, generateImage: ImageGeneratorFn) {
    this.faceService = faceService;
    this.generateImage = generateImage;
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
    const jobs: AvatarGenerationJob[] = [];

    const driftConfig = {
      faceSimilarity: request.driftGuard?.faceSimilarity ?? DEFAULT_DRIFT_SIMILARITY,
      rejectBelowThreshold: request.driftGuard?.rejectBelowThreshold ?? DEFAULT_REJECT_BELOW_THRESHOLD,
      maxRegenerationAttempts: request.driftGuard?.maxRegenerationAttempts ?? DEFAULT_MAX_REGEN_ATTEMPTS,
    };

    // Mutable state accumulated across stages
    let neutralPortraitUrl = request.existingAnchors?.neutralPortrait ?? '';
    let faceEmbedding: number[] | undefined = request.existingAnchors?.faceEmbedding;
    const expressionSheet: Record<string, string> = {};
    const animatedEmotes: Record<string, string> = {};
    let fullBodyUrl: string | undefined;

    const driftScores: Record<string, number> = {};
    const driftRejected: string[] = [];
    const driftRegenerated: string[] = [];

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
          seed: request.generationConfig.seed,
          negativePrompt: request.generationConfig.negativePrompt,
          stylePreset: request.generationConfig.stylePreset,
          policyTier: request.policyTier,
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
    }

    // -----------------------------------------------------------------------
    // Stage: face_embedding
    // -----------------------------------------------------------------------
    if (stages.includes('face_embedding') && !faceEmbedding && neutralPortraitUrl) {
      const job = this.createJob('face_embedding', 'face_embedding');
      const jobStart = Date.now();
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
      job.durationMs = Date.now() - jobStart;
      jobs.push(job);
    }

    // -----------------------------------------------------------------------
    // Stage: expression_sheet
    // -----------------------------------------------------------------------
    if (stages.includes('expression_sheet')) {
      await runBounded(AVATAR_EMOTIONS, EMOTION_GENERATION_CONCURRENCY, async (emotion) => {
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
          const prompt = buildExpressionPrompt(request.identity, emotion);
          let imageUrl: string | undefined;
          let bestScore = -1;
          let attempts = 0;

          while (attempts < driftConfig.maxRegenerationAttempts) {
            attempts++;
            const url = await this.generateImage(prompt, {
              seed: request.generationConfig.seed,
              negativePrompt: request.generationConfig.negativePrompt,
              stylePreset: request.generationConfig.stylePreset,
              policyTier: request.policyTier,
              referenceImageUrl: neutralPortraitUrl || undefined,
              faceEmbedding: faceEmbedding ?? undefined,
              consistencyMode: 'strict',
            });

            // Drift check against anchor embedding
            if (faceEmbedding) {
              try {
                const generated = await this.faceService.extractEmbedding(url);
                const comparison = this.faceService.compareFaces(
                  faceEmbedding,
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
                  driftRegenerated.push(label);
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

          if (imageUrl) {
            expressionSheet[emotion] = imageUrl;
            job.imageUrl = imageUrl;
            job.driftScore = bestScore >= 0 ? bestScore : undefined;
            job.status = 'completed';

            if (bestScore >= 0) {
              driftScores[label] = bestScore;
              if (bestScore < driftConfig.faceSimilarity && driftConfig.rejectBelowThreshold) {
                driftRejected.push(label);
              }
            }
          } else {
            job.status = 'failed';
            job.error = 'All regeneration attempts failed drift check.';
          }

          job.attempts = attempts;
        } catch (err) {
          job.status = 'failed';
          job.error = err instanceof Error ? err.message : String(err);
        }

        job.durationMs = Date.now() - jobStart;
        jobs.push(job);
      });
    }

    // -----------------------------------------------------------------------
    // Stage: animated_emotes
    // -----------------------------------------------------------------------
    if (stages.includes('animated_emotes')) {
      await runBounded(AVATAR_EMOTIONS, EMOTION_GENERATION_CONCURRENCY, async (emotion) => {
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
          });
          animatedEmotes[emotion] = url;
          job.imageUrl = url;
          job.status = 'completed';
          job.attempts = 1;
        } catch (err) {
          job.status = 'failed';
          job.error = err instanceof Error ? err.message : String(err);
        }

        job.durationMs = Date.now() - jobStart;
        jobs.push(job);
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
        fullBodyUrl = await this.generateImage(prompt, {
          seed: request.generationConfig.seed,
          negativePrompt: request.generationConfig.negativePrompt,
          stylePreset: request.generationConfig.stylePreset,
          policyTier: request.policyTier,
          referenceImageUrl: neutralPortraitUrl || undefined,
          faceEmbedding: faceEmbedding ?? undefined,
          consistencyMode: 'balanced',
        });
        job.imageUrl = fullBodyUrl;
        job.status = 'completed';
        job.attempts = 1;
      } catch (err) {
        job.status = 'failed';
        job.error = err instanceof Error ? err.message : String(err);
      }

      job.durationMs = Date.now() - jobStart;
      jobs.push(job);
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
    if (faceEmbedding) {
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

  private createJob(stage: AvatarGenerationStage, label: string): AvatarGenerationJob {
    return {
      stage,
      label,
      status: 'pending',
      attempts: 0,
    };
  }
}
