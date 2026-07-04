import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AvatarPipeline, type ImageGeneratorFn } from '../AvatarPipeline';
import type { IFaceEmbeddingService, FaceEmbedding, FaceComparisonResult } from '../../images/face/IFaceEmbeddingService';
import type { AvatarGenerationRequest } from '../types';
import type { AvatarIdentityDescriptor } from '../../../../api/types';
import { AVATAR_EMOTIONS } from '../prompts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const identity: AvatarIdentityDescriptor = {
  displayName: 'Test Character',
  ageBand: 'adult',
  faceDescriptor: 'square jaw, blue eyes',
  hairDescriptor: 'short brown hair',
  styleNotes: 'photorealistic',
};

function makeRequest(overrides?: Partial<AvatarGenerationRequest>): AvatarGenerationRequest {
  return {
    characterId: 'char-001',
    identity,
    generationConfig: {
      baseModel: 'flux-schnell',
      provider: 'replicate',
      seed: 42,
      negativePrompt: 'blurry',
    },
    ...overrides,
  };
}

/** Embedding vector that always returns the same 512-dim unit vector. */
function makeAnchorVector(): number[] {
  const v = new Array(512).fill(0);
  v[0] = 1;
  return v;
}

/** A slightly perturbed version of the anchor vector (high similarity). */
function makeSimilarVector(): number[] {
  const v = makeAnchorVector();
  v[1] = 0.05;
  return v;
}

/** A very different vector (low similarity). */
function makeDifferentVector(): number[] {
  const v = new Array(512).fill(0);
  v[100] = 1;
  return v;
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockFaceService(): IFaceEmbeddingService {
  return {
    extractEmbedding: vi.fn<[string], Promise<FaceEmbedding>>().mockResolvedValue({
      vector: makeSimilarVector(),
      confidence: 0.99,
    }),
    compareFaces: vi.fn<[number[], number[], number?], FaceComparisonResult>().mockReturnValue({
      similarity: 0.95,
      match: true,
    }),
  };
}

function createMockImageGenerator(): ImageGeneratorFn {
  let counter = 0;
  return vi.fn<Parameters<ImageGeneratorFn>, ReturnType<ImageGeneratorFn>>().mockImplementation(
    async (_prompt, _options) => {
      counter++;
      return `https://images.test/generated-${counter}.png`;
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AvatarPipeline', () => {
  let faceService: IFaceEmbeddingService;
  let generateImage: ReturnType<typeof vi.fn> & ImageGeneratorFn;
  let pipeline: AvatarPipeline;

  beforeEach(() => {
    faceService = createMockFaceService();
    generateImage = createMockImageGenerator() as ReturnType<typeof vi.fn> & ImageGeneratorFn;
    pipeline = new AvatarPipeline(faceService, generateImage);
  });

  // -------------------------------------------------------------------------
  // neutral_portrait
  // -------------------------------------------------------------------------

  describe('neutral portrait generation', () => {
    it('generates a neutral portrait and records the job', async () => {
      const result = await pipeline.generate(
        makeRequest({ stages: ['neutral_portrait'] }),
      );

      expect(generateImage).toHaveBeenCalledTimes(1);
      expect(result.identityPackage.anchors.neutralPortrait).toMatch(/^https:\/\/images\.test\//);
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].stage).toBe('neutral_portrait');
      expect(result.jobs[0].status).toBe('completed');
      expect(result.jobs[0].attempts).toBe(1);
    });

    it('skips neutral_portrait when existingAnchors.neutralPortrait is provided', async () => {
      const result = await pipeline.generate(
        makeRequest({
          stages: ['neutral_portrait'],
          existingAnchors: { neutralPortrait: 'https://existing.test/portrait.png' },
        }),
      );

      expect(generateImage).not.toHaveBeenCalled();
      expect(result.identityPackage.anchors.neutralPortrait).toBe('https://existing.test/portrait.png');
      // No job recorded because stage was skipped
      expect(result.jobs).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // face_embedding
  // -------------------------------------------------------------------------

  describe('face embedding extraction', () => {
    it('extracts embedding from the neutral portrait', async () => {
      const result = await pipeline.generate(
        makeRequest({ stages: ['neutral_portrait', 'face_embedding'] }),
      );

      expect(faceService.extractEmbedding).toHaveBeenCalledTimes(1);
      expect(result.identityPackage.faceEmbedding).toBeDefined();
      expect(result.identityPackage.faceEmbedding!.length).toBe(512);

      const embeddingJob = result.jobs.find((j) => j.stage === 'face_embedding');
      expect(embeddingJob).toBeDefined();
      expect(embeddingJob!.status).toBe('completed');
    });

    it('skips face_embedding when existingAnchors.faceEmbedding is provided', async () => {
      const existing = makeAnchorVector();
      const result = await pipeline.generate(
        makeRequest({
          stages: ['neutral_portrait', 'face_embedding'],
          existingAnchors: { faceEmbedding: existing },
        }),
      );

      // extractEmbedding should NOT be called for the anchor
      // (it generates a portrait first, then skips embedding extraction)
      expect(result.identityPackage.faceEmbedding).toEqual(existing);
      const embeddingJob = result.jobs.find((j) => j.stage === 'face_embedding');
      expect(embeddingJob).toBeUndefined(); // skipped entirely
    });
  });

  // -------------------------------------------------------------------------
  // expression_sheet
  // -------------------------------------------------------------------------

  describe('expression sheet generation', () => {
    it('generates 6 emotion images (neutral reuses portrait)', async () => {
      const result = await pipeline.generate(
        makeRequest({
          stages: ['neutral_portrait', 'face_embedding', 'expression_sheet'],
        }),
      );

      const sheet = result.identityPackage.anchors.expressionSheet!;
      expect(sheet).toBeDefined();

      // All 7 emotions should be present in the sheet
      for (const emotion of AVATAR_EMOTIONS) {
        expect(sheet[emotion]).toBeDefined();
      }

      // Neutral reuses the portrait URL (not re-generated)
      expect(sheet.neutral).toBe(result.identityPackage.anchors.neutralPortrait);

      // 6 expression images generated (excluding neutral) + 1 portrait = 7 total
      // generateImage: 1 portrait + 6 expressions = 7
      expect(generateImage).toHaveBeenCalledTimes(7);
    });

    it('generates the expression images concurrently, not one-at-a-time', async () => {
      // Track how many generateImage calls overlap. A sequential loop can
      // never exceed 1 in flight; the bounded-parallel version overlaps.
      let inFlight = 0;
      let maxInFlight = 0;
      generateImage.mockImplementation(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight--;
        return 'https://images.test/expr.png';
      });

      const result = await pipeline.generate(
        makeRequest({
          stages: ['neutral_portrait', 'face_embedding', 'expression_sheet'],
        }),
      );

      // The 6 non-neutral expressions must run in parallel.
      expect(maxInFlight).toBeGreaterThanOrEqual(2);
      // All emotions still present, none dropped by the concurrency change.
      const sheet = result.identityPackage.anchors.expressionSheet!;
      for (const emotion of AVATAR_EMOTIONS) {
        expect(sheet[emotion]).toBeDefined();
      }
    });

    it('records drift scores for each expression', async () => {
      const result = await pipeline.generate(
        makeRequest({
          stages: ['neutral_portrait', 'face_embedding', 'expression_sheet'],
        }),
      );

      expect(result.driftReport).toBeDefined();
      expect(result.driftReport!.scores).toBeDefined();

      // Each non-neutral emotion should have a drift score
      const nonNeutralEmotions = AVATAR_EMOTIONS.filter((e) => e !== 'neutral');
      for (const emotion of nonNeutralEmotions) {
        const label = `expression:${emotion}`;
        expect(result.driftReport!.scores[label]).toBeDefined();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Drift checking and regeneration
  // -------------------------------------------------------------------------

  describe('drift checking and regeneration', () => {
    it('regenerates images when drift is too high', async () => {
      let callCount = 0;
      (faceService.compareFaces as ReturnType<typeof vi.fn>).mockImplementation(
        (_a: number[], _b: number[], threshold = 0.6) => {
          callCount++;
          // Fail the first two comparisons, pass the third
          if (callCount <= 2) {
            return { similarity: 0.3, match: false };
          }
          return { similarity: 0.85, match: true };
        },
      );

      const result = await pipeline.generate(
        makeRequest({
          stages: ['neutral_portrait', 'face_embedding', 'expression_sheet'],
          driftGuard: { maxRegenerationAttempts: 3 },
        }),
      );

      // The first two drift comparisons fail, so exactly two expressions are
      // regenerated once. Expression images render concurrently, so WHICH two
      // retry is not deterministic — assert the aggregate rather than a single
      // emotion's attempt count. 1 portrait + 6 expressions + 2 retries = 9.
      expect(generateImage).toHaveBeenCalledTimes(9);
      const expressionJobs = result.jobs.filter((j) => j.stage === 'expression_sheet');
      const totalAttempts = expressionJobs.reduce((sum, j) => sum + (j.attempts ?? 0), 0);
      expect(totalAttempts).toBe(8); // 6 base attempts + 2 regenerations
      expect(expressionJobs.every((j) => j.status === 'completed')).toBe(true);
    });

    it('records rejected labels when all attempts drift too far', async () => {
      (faceService.compareFaces as ReturnType<typeof vi.fn>).mockReturnValue({
        similarity: 0.2,
        match: false,
      });

      const result = await pipeline.generate(
        makeRequest({
          stages: ['neutral_portrait', 'face_embedding', 'expression_sheet'],
          driftGuard: {
            maxRegenerationAttempts: 2,
            faceSimilarity: 0.6,
            rejectBelowThreshold: true,
          },
        }),
      );

      expect(result.driftReport).toBeDefined();
      expect(result.driftReport!.rejected.length).toBeGreaterThan(0);
      expect(result.driftReport!.passed).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // policyTier passthrough
  // -------------------------------------------------------------------------

  describe('policyTier passthrough', () => {
    it('forwards policyTier to the image generator', async () => {
      await pipeline.generate(
        makeRequest({
          stages: ['neutral_portrait'],
          policyTier: 'mature',
        }),
      );

      expect(generateImage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ policyTier: 'mature' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Using existing anchors/embedding
  // -------------------------------------------------------------------------

  describe('using existing anchors and embedding', () => {
    it('uses existing portrait and embedding for expression sheet', async () => {
      const existingEmbedding = makeAnchorVector();

      const result = await pipeline.generate(
        makeRequest({
          stages: ['expression_sheet'],
          existingAnchors: {
            neutralPortrait: 'https://existing.test/portrait.png',
            faceEmbedding: existingEmbedding,
          },
        }),
      );

      // Should NOT generate a neutral portrait
      expect(result.identityPackage.anchors.neutralPortrait).toBe('https://existing.test/portrait.png');
      expect(result.identityPackage.faceEmbedding).toEqual(existingEmbedding);

      // Should generate 6 expression images (neutral reuses existing)
      expect(generateImage).toHaveBeenCalledTimes(6);

      // Drift checks should use the provided embedding
      expect(faceService.compareFaces).toHaveBeenCalled();
    });

    it('passes referenceImageUrl from existing portrait to expression generator', async () => {
      await pipeline.generate(
        makeRequest({
          stages: ['expression_sheet'],
          existingAnchors: {
            neutralPortrait: 'https://existing.test/portrait.png',
            faceEmbedding: makeAnchorVector(),
          },
        }),
      );

      // Each expression call should include the reference image
      const calls = (generateImage as ReturnType<typeof vi.fn>).mock.calls;
      for (const [, options] of calls) {
        expect(options.referenceImageUrl).toBe('https://existing.test/portrait.png');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Full pipeline
  // -------------------------------------------------------------------------

  describe('full pipeline', () => {
    it('runs all stages in order', async () => {
      const result = await pipeline.generate(makeRequest());

      // neutral_portrait (1) + face_embedding (0 images) +
      // expression_sheet (6) + animated_emotes (7) + full_body (1) = 15 image calls
      expect(generateImage).toHaveBeenCalledTimes(15);

      expect(result.identityPackage.anchors.neutralPortrait).toBeDefined();
      expect(result.identityPackage.faceEmbedding).toBeDefined();
      expect(result.identityPackage.anchors.expressionSheet).toBeDefined();
      expect(result.identityPackage.anchors.animatedEmotes).toBeDefined();
      expect(result.identityPackage.anchors.fullBody).toBeDefined();

      expect(result.identityPackage.characterId).toBe('char-001');
      expect(result.identityPackage.identity).toEqual(identity);
      expect(result.identityPackage.generationConfig.baseModel).toBe('flux-schnell');
      expect(result.identityPackage.createdAt).toBeDefined();
      expect(result.identityPackage.updatedAt).toBeDefined();

      expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
      expect(result.driftReport).toBeDefined();
    });

    it('produces a valid UUID for the identity package id', async () => {
      const result = await pipeline.generate(makeRequest({ stages: ['neutral_portrait'] }));
      expect(result.identityPackage.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // animated_emotes
  // -------------------------------------------------------------------------

  describe('animated emotes generation', () => {
    it('generates emotes for all 7 emotions', async () => {
      const result = await pipeline.generate(
        makeRequest({ stages: ['animated_emotes'] }),
      );

      const emotes = result.identityPackage.anchors.animatedEmotes!;
      expect(emotes).toBeDefined();
      expect(Object.keys(emotes)).toHaveLength(7);

      for (const emotion of AVATAR_EMOTIONS) {
        expect(emotes[emotion]).toBeDefined();
      }
    });
  });

  // -------------------------------------------------------------------------
  // full_body
  // -------------------------------------------------------------------------

  describe('full body generation', () => {
    it('generates a full body image with modified prompt', async () => {
      const result = await pipeline.generate(
        makeRequest({ stages: ['neutral_portrait', 'full_body'] }),
      );

      expect(result.identityPackage.anchors.fullBody).toBeDefined();

      // The second call should be the full_body prompt
      const calls = (generateImage as ReturnType<typeof vi.fn>).mock.calls;
      const fullBodyCall = calls[1];
      expect(fullBodyCall[0]).toContain('full body shot of');
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('records failed jobs without crashing the pipeline', async () => {
      (generateImage as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce('https://images.test/portrait.png')
        .mockRejectedValueOnce(new Error('API timeout'));

      const result = await pipeline.generate(
        makeRequest({
          stages: ['neutral_portrait', 'full_body'],
        }),
      );

      expect(result.jobs).toHaveLength(2);
      expect(result.jobs[0].status).toBe('completed');
      expect(result.jobs[1].status).toBe('failed');
      expect(result.jobs[1].error).toBe('API timeout');
    });
  });

  // -------------------------------------------------------------------------
  // Incremental job-completion callback
  // -------------------------------------------------------------------------

  describe('onJobComplete callback', () => {
    it('fires once per settled job with the job record', async () => {
      const seen: Array<{ stage: string; label: string; status: string }> = [];
      const result = await pipeline.generate(
        makeRequest({
          stages: ['neutral_portrait', 'face_embedding', 'expression_sheet'],
          onJobComplete: (job) => {
            seen.push({ stage: job.stage, label: job.label, status: job.status });
          },
        }),
      );

      expect(seen).toHaveLength(result.jobs.length);
      // Every non-neutral expression surfaced through the callback, each
      // settled as completed (neutral reuses the portrait — no job).
      const expressionLabels = seen
        .filter((j) => j.stage === 'expression_sheet')
        .map((j) => j.label);
      for (const emotion of AVATAR_EMOTIONS.filter((e) => e !== 'neutral')) {
        expect(expressionLabels).toContain(`expression:${emotion}`);
      }
      expect(seen.every((j) => j.status === 'completed')).toBe(true);
    });

    it('swallows callback errors without failing jobs or the pipeline', async () => {
      const result = await pipeline.generate(
        makeRequest({
          stages: ['neutral_portrait', 'expression_sheet'],
          onJobComplete: () => {
            throw new Error('caller persistence exploded');
          },
        }),
      );

      expect(result.jobs.every((j) => j.status === 'completed')).toBe(true);
      expect(result.identityPackage.anchors.neutralPortrait).toBeTruthy();
    });
  });
});
