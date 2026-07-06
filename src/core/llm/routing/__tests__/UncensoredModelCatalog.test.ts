import { describe, it, expect, beforeEach } from 'vitest';
import {
  createUncensoredModelCatalog,
  type UncensoredModelCatalog,
} from '../UncensoredModelCatalog';

describe('UncensoredModelCatalog', () => {
  let catalog: UncensoredModelCatalog;

  beforeEach(() => {
    catalog = createUncensoredModelCatalog();
  });

  // -------------------------------------------------------------------------
  // getTextModels
  // -------------------------------------------------------------------------

  describe('getTextModels', () => {
    it('returns all live text models with no filter', () => {
      // Current catalog (2026-07-06 refresh): magnum-v4-72b,
      // llama-3.3-70b-instruct, hermes-3-70b, llama-3.1-8b-instruct.
      // hermes-3-405b was removed for continuity collapse (2026-06-28
      // 3-arm prod eval); Dolphin Mixtral / Dolphin 3.0 / MythoMax were
      // removed earlier — see the TEXT_MODELS comments.
      const models = catalog.getTextModels();
      expect(models).toHaveLength(4);
      expect(models.every((m) => m.modality === 'text')).toBe(true);
      expect(models.every((m) => m.providerId === 'openrouter')).toBe(true);
      expect(models.map((m) => m.modelId)).toContain('anthracite-org/magnum-v4-72b');
      expect(models.map((m) => m.modelId)).not.toContain('nousresearch/hermes-3-llama-3.1-405b');
    });

    it('filters by quality', () => {
      // High tier: magnum + llama-3.3-70b.
      const high = catalog.getTextModels({ quality: 'high' });
      expect(high).toHaveLength(2);
      expect(high.every((m) => m.quality === 'high')).toBe(true);

      // Low tier: the llama-3.1-8b last-resort link.
      const low = catalog.getTextModels({ quality: 'low' });
      expect(low).toHaveLength(1);
      expect(low[0].modelId).toBe('meta-llama/llama-3.1-8b-instruct');
    });

    it('filters by contentPermissions', () => {
      const erotic = catalog.getTextModels({
        contentPermissions: ['erotic'],
      });
      // Only the genuinely-uncensored entries carry the erotic
      // permission (magnum + hermes-70b); the stock Llama instruct
      // links serve mature-but-not-explicit traffic.
      expect(erotic).toHaveLength(2);
      expect(erotic.every((m) => m.contentPermissions.includes('erotic'))).toBe(
        true,
      );
    });

    it('filters by quality + contentPermissions together', () => {
      const highErotic = catalog.getTextModels({
        quality: 'high',
        contentPermissions: ['erotic'],
      });
      expect(highErotic).toHaveLength(1);
      expect(highErotic[0].modelId).toBe('anthracite-org/magnum-v4-72b');
    });
  });

  // -------------------------------------------------------------------------
  // getImageModels
  // -------------------------------------------------------------------------

  describe('getImageModels', () => {
    it('returns all 6 image models with no filter', () => {
      const models = catalog.getImageModels();
      expect(models).toHaveLength(6);
      expect(models.every((m) => m.modality === 'image')).toBe(true);
      expect(models.every((m) => m.providerId === 'replicate')).toBe(true);
    });

    it('filters by face-consistency capability', () => {
      const faceModels = catalog.getImageModels({
        capabilities: ['face-consistency'],
      });
      expect(faceModels).toHaveLength(2);
      expect(
        faceModels.every((m) => m.capabilities.includes('face-consistency')),
      ).toBe(true);
    });

    it('filters by video capability', () => {
      const videoModels = catalog.getImageModels({
        capabilities: ['video'],
      });
      expect(videoModels).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // getPreferredTextModel
  // -------------------------------------------------------------------------

  describe('getPreferredTextModel', () => {
    it('returns null for safe tier', () => {
      expect(catalog.getPreferredTextModel('safe')).toBeNull();
    });

    it('returns null for standard tier', () => {
      expect(catalog.getPreferredTextModel('standard')).toBeNull();
    });

    it('returns the magnum primary for private-adult tier', () => {
      const model = catalog.getPreferredTextModel('private-adult');
      expect(model).not.toBeNull();
      expect(model!.modelId).toBe('anthracite-org/magnum-v4-72b');
      expect(model!.quality).toBe('high');
      expect(model!.providerId).toBe('openrouter');
    });

    it('returns the fast multi-provider llama-3.3-70b for mature tier', () => {
      const model = catalog.getPreferredTextModel('mature');
      expect(model).not.toBeNull();
      expect(model!.modelId).toBe('meta-llama/llama-3.3-70b-instruct');
      expect(model!.quality).toBe('high');
    });

    it('respects contentIntent — erotic narrows to models with erotic permission', () => {
      const model = catalog.getPreferredTextModel('private-adult', 'erotic');
      expect(model).not.toBeNull();
      expect(model!.modelId).toBe('anthracite-org/magnum-v4-72b');
      expect(model!.contentPermissions).toContain('erotic');
      expect(model!.quality).toBe('high');
    });

    it('respects contentIntent — horror stays on a horror-permitted model', () => {
      const model = catalog.getPreferredTextModel('mature', 'horror');
      expect(model).not.toBeNull();
      expect(model!.contentPermissions).toContain('horror');
      expect(model!.modelId).toBe('meta-llama/llama-3.3-70b-instruct');
    });

    it('erotic intent on mature tier skips the non-erotic llama links', () => {
      const model = catalog.getPreferredTextModel('mature', 'erotic');
      expect(model).not.toBeNull();
      // llama-3.3-70b leads the mature ranking but carries no erotic
      // permission; the intent filter must drop it before ranking.
      expect(model!.modelId).toBe('anthracite-org/magnum-v4-72b');
    });
  });

  // -------------------------------------------------------------------------
  // getPreferredImageModel
  // -------------------------------------------------------------------------

  describe('getPreferredImageModel', () => {
    it('returns null for safe tier', () => {
      expect(catalog.getPreferredImageModel('safe')).toBeNull();
    });

    it('returns null for standard tier', () => {
      expect(catalog.getPreferredImageModel('standard')).toBeNull();
    });

    it('returns replicate model for private-adult tier', () => {
      const model = catalog.getPreferredImageModel('private-adult');
      expect(model).not.toBeNull();
      expect(model!.providerId).toBe('replicate');
      expect(model!.quality).toBe('high');
    });

    it('returns replicate model for mature tier', () => {
      const model = catalog.getPreferredImageModel('mature');
      expect(model).not.toBeNull();
      expect(model!.providerId).toBe('replicate');
    });

    it('filters by face-consistency capability', () => {
      const model = catalog.getPreferredImageModel('private-adult', [
        'face-consistency',
      ]);
      expect(model).not.toBeNull();
      expect(model!.capabilities).toContain('face-consistency');
    });

    it('returns null when no models match impossible capability filter', () => {
      const model = catalog.getPreferredImageModel('private-adult', [
        'teleportation',
      ]);
      expect(model).toBeNull();
    });
  });
});
