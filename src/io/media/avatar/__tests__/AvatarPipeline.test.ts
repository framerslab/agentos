import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AvatarPipeline, type ImageGeneratorFn } from '../AvatarPipeline';
import type { IFaceEmbeddingService, FaceEmbedding, FaceComparisonResult } from '../../images/face/IFaceEmbeddingService';
import type { AvatarAcceptanceCheck, AvatarGenerationRequest } from '../types';
import type { AvatarIdentityDescriptor } from '../../../../api/types';
import { AVATAR_ANGLES, AVATAR_EMOTIONS } from '../prompts';

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
    extractEmbedding: vi.fn<(imageUrl: string) => Promise<FaceEmbedding>>().mockResolvedValue({
      vector: makeSimilarVector(),
      confidence: 0.99,
    }),
    compareFaces: vi.fn<(a: number[], b: number[], threshold?: number) => FaceComparisonResult>().mockReturnValue({
      similarity: 0.95,
      match: true,
    }),
  };
}

function createMockImageGenerator(): ImageGeneratorFn {
  let counter = 0;
  return vi.fn<ImageGeneratorFn>().mockImplementation(
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

// ---------------------------------------------------------------------------
// Caller-owned acceptance check, emotion list, angles and generator routing
// ---------------------------------------------------------------------------

describe('AvatarPipeline caller-owned options', () => {
  let faceService: IFaceEmbeddingService;
  let generateImage: ReturnType<typeof vi.fn> & ImageGeneratorFn;
  let pipeline: AvatarPipeline;

  beforeEach(() => {
    faceService = createMockFaceService();
    generateImage = createMockImageGenerator() as ReturnType<typeof vi.fn> & ImageGeneratorFn;
    pipeline = new AvatarPipeline(faceService, generateImage);
  });

  const promptsOf = (): string[] =>
    (generateImage as ReturnType<typeof vi.fn>).mock.calls.map(([prompt]) => String(prompt));

  // -------------------------------------------------------------------------
  // acceptanceCheck
  // -------------------------------------------------------------------------

  describe('acceptanceCheck', () => {
    it('replaces the embedding drift check: no embedding is extracted or compared', async () => {
      const acceptanceCheck = vi.fn<AvatarAcceptanceCheck>().mockResolvedValue({ accepted: true });

      const result = await pipeline.generate(
        makeRequest({
          stages: ['neutral_portrait', 'face_embedding', 'expression_sheet'],
          acceptanceCheck,
        }),
      );

      expect(faceService.extractEmbedding).not.toHaveBeenCalled();
      expect(faceService.compareFaces).not.toHaveBeenCalled();
      expect(result.identityPackage.faceEmbedding).toBeUndefined();
      expect(result.driftReport).toBeUndefined();

      const embeddingJob = result.jobs.find((j) => j.stage === 'face_embedding');
      expect(embeddingJob?.status).toBe('skipped');

      const portrait = result.identityPackage.anchors.neutralPortrait;
      const nonNeutral = AVATAR_EMOTIONS.filter((e) => e !== 'neutral');
      expect(acceptanceCheck).toHaveBeenCalledTimes(nonNeutral.length);
      for (const emotion of nonNeutral) {
        const label = `expression:${emotion}`;
        const job = result.jobs.find((j) => j.label === label);
        expect(job?.status).toBe('completed');
        expect(job?.acceptance).toEqual({ accepted: true });
        expect(acceptanceCheck).toHaveBeenCalledWith(
          expect.objectContaining({
            referenceUrl: portrait,
            candidateUrl: job?.imageUrl,
            stage: 'expression_sheet',
            label,
            attempt: 1,
          }),
        );
      }
    });

    it('regenerates a refused render up to maxRegenerationAttempts, then fails that job alone', async () => {
      const acceptanceCheck = vi.fn<AvatarAcceptanceCheck>().mockImplementation(async ({ label }) =>
        label === 'expression:sad'
          ? { accepted: false, reason: 'the eyes changed colour' }
          : { accepted: true },
      );

      const result = await pipeline.generate(
        makeRequest({
          stages: ['neutral_portrait', 'expression_sheet'],
          driftGuard: { maxRegenerationAttempts: 2 },
          acceptanceCheck,
        }),
      );

      const sad = result.jobs.find((j) => j.label === 'expression:sad');
      expect(sad?.status).toBe('failed');
      expect(sad?.attempts).toBe(2);
      expect(sad?.error).toBe('the eyes changed colour');
      expect(sad?.acceptance).toEqual({ accepted: false, reason: 'the eyes changed colour' });
      expect(sad?.imageUrl).toBeUndefined();

      const sheet = result.identityPackage.anchors.expressionSheet!;
      expect(sheet.sad).toBeUndefined();
      for (const emotion of AVATAR_EMOTIONS.filter((e) => e !== 'sad')) {
        expect(sheet[emotion]).toBeDefined();
      }
      // 1 portrait + 6 expressions + 1 regeneration of the refused one
      expect(generateImage).toHaveBeenCalledTimes(8);
    });

    it('keeps the render that passes after a refusal', async () => {
      let happyAttempts = 0;
      const acceptanceCheck = vi.fn<AvatarAcceptanceCheck>().mockImplementation(async ({ label }) => {
        if (label !== 'expression:happy') return { accepted: true };
        happyAttempts++;
        return happyAttempts === 1 ? { accepted: false, reason: 'lettering in the frame' } : { accepted: true };
      });

      const result = await pipeline.generate(
        makeRequest({
          stages: ['neutral_portrait', 'expression_sheet'],
          driftGuard: { maxRegenerationAttempts: 3 },
          acceptanceCheck,
        }),
      );

      const happy = result.jobs.find((j) => j.label === 'expression:happy');
      expect(happy?.status).toBe('completed');
      expect(happy?.attempts).toBe(2);
      expect(happy?.acceptance).toEqual({ accepted: true });
      const secondCandidate = acceptanceCheck.mock.calls
        .map(([args]) => args)
        .find((args) => args.label === 'expression:happy' && args.attempt === 2);
      expect(result.identityPackage.anchors.expressionSheet!.happy).toBe(secondCandidate?.candidateUrl);
    });

    it('tells the generator which attempt each redraw of a refused render is', async () => {
      const acceptanceCheck = vi.fn<AvatarAcceptanceCheck>().mockImplementation(async ({ label }) =>
        label === 'expression:sad' ? { accepted: false, reason: 'the same refused face' } : { accepted: true },
      );

      await pipeline.generate(
        makeRequest({
          stages: ['neutral_portrait', 'expression_sheet'],
          emotions: ['neutral', 'sad'],
          driftGuard: { maxRegenerationAttempts: 3 },
          acceptanceCheck,
        }),
      );

      const sadCalls = (generateImage as ReturnType<typeof vi.fn>).mock.calls
        .map(([, options]) => options)
        .filter((options) => options.label === 'expression:sad');
      // With a fixed seed, the attempt is the only argument that tells a redraw from the draw it replaces.
      expect(sadCalls).toEqual(
        [1, 2, 3].map((attempt) =>
          expect.objectContaining({ seed: 42, stage: 'expression_sheet', label: 'expression:sad', attempt }),
        ),
      );
    });

    it('draws and checks each image once when maxRegenerationAttempts is 0', async () => {
      const acceptanceCheck = vi.fn<AvatarAcceptanceCheck>().mockResolvedValue({ accepted: true });

      const result = await pipeline.generate(
        makeRequest({
          stages: ['neutral_portrait', 'expression_sheet', 'full_body', 'additional_angles'],
          emotions: ['neutral', 'happy'],
          angles: ['profile view'],
          driftGuard: { maxRegenerationAttempts: 0 },
          acceptanceCheck,
        }),
      );

      for (const label of ['expression:happy', 'full_body', 'angle:profile view']) {
        const job = result.jobs.find((j) => j.label === label);
        expect(job?.status).toBe('completed');
        expect(job?.attempts).toBe(1);
        expect(job?.acceptance).toEqual({ accepted: true });
      }
      expect(acceptanceCheck).toHaveBeenCalledTimes(3);
      // 1 portrait + 1 expression + 1 full body + 1 angle
      expect(generateImage).toHaveBeenCalledTimes(4);
    });

    it('draws and checks each image once when maxRegenerationAttempts is NaN', async () => {
      const acceptanceCheck = vi.fn<AvatarAcceptanceCheck>().mockResolvedValue({ accepted: true });

      const result = await pipeline.generate(
        makeRequest({
          stages: ['neutral_portrait', 'expression_sheet', 'full_body', 'additional_angles'],
          emotions: ['neutral', 'happy'],
          angles: ['profile view'],
          // What Number(process.env.X) gives for an unset variable.
          driftGuard: { maxRegenerationAttempts: Number(undefined) },
          acceptanceCheck,
        }),
      );

      for (const label of ['expression:happy', 'full_body', 'angle:profile view']) {
        const job = result.jobs.find((j) => j.label === label);
        expect(job?.status).toBe('completed');
        expect(job?.attempts).toBe(1);
        expect(job?.acceptance).toEqual({ accepted: true });
      }
      expect(acceptanceCheck).toHaveBeenCalledTimes(3);
      // 1 portrait + 1 expression + 1 full body + 1 angle
      expect(generateImage).toHaveBeenCalledTimes(4);
    });

    it('records the attempt limit it drew under in the identity package, 0 and NaN as 1', async () => {
      for (const asked of [0, -2, Number(undefined)]) {
        const result = await pipeline.generate(
          makeRequest({ stages: ['neutral_portrait'], driftGuard: { maxRegenerationAttempts: asked } }),
        );
        expect(result.identityPackage.driftGuard.maxRegenerationAttempts).toBe(1);
        expect(JSON.parse(JSON.stringify(result.identityPackage)).driftGuard.maxRegenerationAttempts).toBe(1);
      }
    });

    it('fails the job when the check throws and draws no more for it', async () => {
      const acceptanceCheck = vi.fn<AvatarAcceptanceCheck>().mockImplementation(async ({ label }) => {
        if (label === 'expression:angry') throw new Error('judge unavailable');
        return { accepted: true };
      });

      const result = await pipeline.generate(
        makeRequest({
          stages: ['neutral_portrait', 'expression_sheet'],
          driftGuard: { maxRegenerationAttempts: 3 },
          acceptanceCheck,
        }),
      );

      const angry = result.jobs.find((j) => j.label === 'expression:angry');
      expect(angry?.status).toBe('failed');
      expect(angry?.error).toBe('judge unavailable');
      expect(result.identityPackage.anchors.expressionSheet!.angry).toBeUndefined();
      // 1 portrait + 6 expressions, no regeneration after the throw
      expect(generateImage).toHaveBeenCalledTimes(7);
    });

    it('keeps the draws made and the last verdict when the check throws after a refusal', async () => {
      const acceptanceCheck = vi.fn<AvatarAcceptanceCheck>().mockImplementation(async ({ attempt }) => {
        if (attempt === 1) return { accepted: false, reason: 'eyes differ' };
        throw new Error('judge unavailable');
      });
      const completed: Array<{ label: string; attempts: number; acceptance: unknown }> = [];

      const result = await pipeline.generate(
        makeRequest({
          stages: ['neutral_portrait', 'expression_sheet'],
          emotions: ['happy'],
          driftGuard: { maxRegenerationAttempts: 3 },
          acceptanceCheck,
          onJobComplete: (job) => {
            completed.push({ label: job.label, attempts: job.attempts, acceptance: job.acceptance });
          },
        }),
      );

      const happy = result.jobs.find((j) => j.label === 'expression:happy');
      expect(happy?.status).toBe('failed');
      expect(happy?.error).toBe('judge unavailable');
      expect(happy?.attempts).toBe(2);
      expect(happy?.acceptance).toEqual({ accepted: false, reason: 'eyes differ' });
      expect(completed.find((j) => j.label === 'expression:happy')).toEqual({
        label: 'expression:happy',
        attempts: 2,
        acceptance: { accepted: false, reason: 'eyes differ' },
      });
      // 1 portrait + 2 draws of the expression, none after the throw
      expect(generateImage).toHaveBeenCalledTimes(3);
    });

    it('a refusal of one angle stops that angle alone', async () => {
      const acceptanceCheck = vi.fn<AvatarAcceptanceCheck>().mockImplementation(async ({ label }) =>
        label === 'angle:side view' ? { accepted: false, reason: 'a second figure in the frame' } : { accepted: true },
      );

      const result = await pipeline.generate(
        makeRequest({
          stages: ['neutral_portrait', 'additional_angles'],
          angles: ['front view', 'side view', 'back view'],
          driftGuard: { maxRegenerationAttempts: 1 },
          acceptanceCheck,
        }),
      );

      const byLabel = (label: string) => result.jobs.find((j) => j.label === label);
      expect(byLabel('angle:side view')?.status).toBe('failed');
      expect(byLabel('angle:side view')?.error).toBe('a second figure in the frame');
      expect(byLabel('angle:front view')?.status).toBe('completed');
      expect(byLabel('angle:back view')?.status).toBe('completed');
      expect(result.identityPackage.anchors.additionalAngles).toEqual([
        byLabel('angle:front view')?.imageUrl,
        byLabel('angle:back view')?.imageUrl,
      ]);
      expect(acceptanceCheck).toHaveBeenCalledWith(
        expect.objectContaining({
          referenceUrl: result.identityPackage.anchors.neutralPortrait,
          stage: 'additional_angles',
          label: 'angle:side view',
        }),
      );
      // 1 portrait + 3 angles, one attempt each
      expect(generateImage).toHaveBeenCalledTimes(4);
    });

    it('checks the full-body render against the anchor when given', async () => {
      const acceptanceCheck = vi.fn<AvatarAcceptanceCheck>().mockResolvedValue({ accepted: true });

      const result = await pipeline.generate(
        makeRequest({ stages: ['neutral_portrait', 'full_body'], acceptanceCheck }),
      );

      expect(acceptanceCheck).toHaveBeenCalledTimes(1);
      expect(acceptanceCheck).toHaveBeenCalledWith(
        expect.objectContaining({
          referenceUrl: result.identityPackage.anchors.neutralPortrait,
          candidateUrl: result.identityPackage.anchors.fullBody,
          stage: 'full_body',
          label: 'full_body',
        }),
      );
      expect(result.jobs.find((j) => j.stage === 'full_body')?.acceptance).toEqual({ accepted: true });
    });

    it('never checks the anchor portrait or the animated emotes', async () => {
      const acceptanceCheck = vi.fn<AvatarAcceptanceCheck>().mockResolvedValue({ accepted: true });

      await pipeline.generate(
        makeRequest({ stages: ['neutral_portrait', 'animated_emotes'], acceptanceCheck }),
      );

      expect(acceptanceCheck).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // additional_angles
  // -------------------------------------------------------------------------

  describe('additional_angles stage', () => {
    it('draws the default angles against the anchor when asked', async () => {
      const result = await pipeline.generate(
        makeRequest({ stages: ['neutral_portrait', 'additional_angles'] }),
      );

      const portrait = result.identityPackage.anchors.neutralPortrait;
      const angleJobs = result.jobs.filter((j) => j.stage === 'additional_angles');
      expect(angleJobs.map((j) => j.label).sort()).toEqual(
        AVATAR_ANGLES.map((a) => `angle:${a}`).sort(),
      );
      expect(angleJobs.every((j) => j.status === 'completed')).toBe(true);

      // 1 portrait + one image per default angle
      expect(generateImage).toHaveBeenCalledTimes(1 + AVATAR_ANGLES.length);
      const angleCalls = (generateImage as ReturnType<typeof vi.fn>).mock.calls.slice(1);
      for (const [prompt, options] of angleCalls) {
        expect(options.referenceImageUrl).toBe(portrait);
        expect(options.consistencyMode).toBe('balanced');
        expect(options.stage).toBe('additional_angles');
        expect(AVATAR_ANGLES.some((a) => String(prompt).includes(a))).toBe(true);
      }

      expect(result.identityPackage.anchors.additionalAngles).toEqual(
        AVATAR_ANGLES.map((a) => angleJobs.find((j) => j.label === `angle:${a}`)?.imageUrl),
      );
    });

    it('is absent when not asked, including the default stage set', async () => {
      const result = await pipeline.generate(makeRequest());

      expect(result.jobs.some((j) => j.stage === 'additional_angles')).toBe(false);
      expect(result.identityPackage.anchors.additionalAngles).toBeUndefined();
      expect(promptsOf().some((p) => AVATAR_ANGLES.some((a) => p.includes(a)))).toBe(false);
    });

    it('draws a caller angle list in place of the defaults and keeps its order under concurrency', async () => {
      const angles = ['front view', 'left side view', 'back view', 'right side view', 'from above'];
      generateImage.mockImplementation(async (prompt: string) => {
        const index = angles.findIndex((a) => prompt.endsWith(a));
        // later angles answer first, so completion order is the reverse of the list
        await new Promise((resolve) => setTimeout(resolve, index >= 0 ? (angles.length - index) * 5 : 0));
        return `https://images.test/${index >= 0 ? `angle-${index}` : 'portrait'}.png`;
      });

      const result = await pipeline.generate(
        makeRequest({ stages: ['neutral_portrait', 'additional_angles'], angles }),
      );

      expect(result.identityPackage.anchors.additionalAngles).toEqual(
        angles.map((_, index) => `https://images.test/angle-${index}.png`),
      );
      expect(promptsOf().some((p) => AVATAR_ANGLES.some((a) => p.includes(a)))).toBe(false);
    });

    it('drift-checks each angle against the anchor embedding when no acceptance check is given', async () => {
      const result = await pipeline.generate(
        makeRequest({ stages: ['neutral_portrait', 'face_embedding', 'additional_angles'] }),
      );

      for (const angle of AVATAR_ANGLES) {
        expect(result.driftReport?.scores[`angle:${angle}`]).toBeDefined();
      }
    });
  });

  // -------------------------------------------------------------------------
  // emotions
  // -------------------------------------------------------------------------

  describe('emotions', () => {
    it('an emotion list of two draws two', async () => {
      const result = await pipeline.generate(
        makeRequest({ stages: ['neutral_portrait', 'expression_sheet'], emotions: ['happy', 'sad'] }),
      );

      // 1 portrait + 2 expressions
      expect(generateImage).toHaveBeenCalledTimes(3);
      expect(Object.keys(result.identityPackage.anchors.expressionSheet!).sort()).toEqual(['happy', 'sad']);
      expect(promptsOf().some((p) => p.includes('flirty'))).toBe(false);
    });

    it('applies the list to the animated emotes as well', async () => {
      const result = await pipeline.generate(
        makeRequest({ stages: ['animated_emotes'], emotions: ['calm', 'proud'] }),
      );

      expect(generateImage).toHaveBeenCalledTimes(2);
      expect(Object.keys(result.identityPackage.anchors.animatedEmotes!).sort()).toEqual(['calm', 'proud']);
    });

    it('never draws an emotion the list leaves out', async () => {
      await pipeline.generate(
        makeRequest({
          stages: ['neutral_portrait', 'expression_sheet', 'animated_emotes'],
          emotions: ['neutral', 'happy', 'surprised'],
        }),
      );

      expect(promptsOf().some((p) => p.includes('flirty'))).toBe(false);
      expect(promptsOf().some((p) => p.includes('angry'))).toBe(false);
    });

    it('reuses the portrait for neutral and draws a repeated emotion once', async () => {
      const result = await pipeline.generate(
        makeRequest({
          stages: ['neutral_portrait', 'expression_sheet'],
          emotions: ['neutral', 'happy', 'happy'],
        }),
      );

      // 1 portrait + 1 expression
      expect(generateImage).toHaveBeenCalledTimes(2);
      const sheet = result.identityPackage.anchors.expressionSheet!;
      expect(sheet.neutral).toBe(result.identityPackage.anchors.neutralPortrait);
      expect(result.jobs.filter((j) => j.label === 'expression:happy')).toHaveLength(1);
    });

    it('returns an emotion named __proto__ as its own key in both maps', async () => {
      const result = await pipeline.generate(
        makeRequest({ stages: ['neutral_portrait', 'expression_sheet', 'animated_emotes'], emotions: ['__proto__', 'happy'] }),
      );

      const { expressionSheet, animatedEmotes } = result.identityPackage.anchors;
      expect(Object.keys(expressionSheet!).sort()).toEqual(['__proto__', 'happy']);
      expect(Object.keys(animatedEmotes!).sort()).toEqual(['__proto__', 'happy']);
      expect(typeof Object.getOwnPropertyDescriptor(expressionSheet, '__proto__')?.value).toBe('string');
      expect(JSON.parse(JSON.stringify(result.identityPackage.anchors)).expressionSheet).toHaveProperty(['__proto__']);
    });

    it('keeps the default set without a list', async () => {
      await pipeline.generate(makeRequest({ stages: ['animated_emotes'] }));
      expect(generateImage).toHaveBeenCalledTimes(AVATAR_EMOTIONS.length);
    });
  });

  // -------------------------------------------------------------------------
  // generator routing
  // -------------------------------------------------------------------------

  describe('generator options name the stage and label', () => {
    it('tells the caller-given generator which stage and label each call draws', async () => {
      await pipeline.generate(
        makeRequest({
          stages: ['neutral_portrait', 'expression_sheet', 'animated_emotes', 'full_body', 'additional_angles'],
          emotions: ['neutral', 'happy'],
          angles: ['profile view'],
        }),
      );

      const routed = (generateImage as ReturnType<typeof vi.fn>).mock.calls
        .map(([, options]) => `${options.stage}|${options.label}`)
        .sort();
      expect(routed).toEqual(
        [
          'neutral_portrait|neutral_portrait',
          'expression_sheet|expression:happy',
          'animated_emotes|emote:neutral',
          'animated_emotes|emote:happy',
          'full_body|full_body',
          'additional_angles|angle:profile view',
        ].sort(),
      );
    });
  });
});
