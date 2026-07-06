/**
 * @fileoverview Uncensored model catalog for policy-aware routing.
 *
 * Maps content policy tiers to curated lists of uncensored text and image
 * models available through OpenRouter (text) and Replicate (image). The
 * catalog is the single source of truth consumed by {@link PolicyAwareRouter}
 * and {@link PolicyAwareImageRouter} to select models that honour the
 * agent's content policy without imposing upstream safety filters.
 *
 * @module core/llm/routing/UncensoredModelCatalog
 */

// ---------------------------------------------------------------------------
// Shared policy types (re-exported for convenience)
// ---------------------------------------------------------------------------

/** Content policy tier governing model selection. */
export type PolicyTier = 'safe' | 'standard' | 'mature' | 'private-adult';

/** Finer-grained content intent hint within a policy tier. */
export type ContentIntent = 'general' | 'romantic' | 'erotic' | 'violent' | 'horror';

// ---------------------------------------------------------------------------
// Catalog entry
// ---------------------------------------------------------------------------

/** A single model entry in the uncensored catalog. */
export interface CatalogEntry {
  /** OpenRouter / Replicate model identifier. */
  modelId: string;
  /** Human-readable display name. */
  displayName: string;
  /** Provider that hosts this model (e.g. 'openrouter', 'replicate'). */
  providerId: string;
  /** Modality: 'text' for LLMs, 'image' for diffusion/GAN. */
  modality: 'text' | 'image';
  /** Quality tier used for preference ordering. */
  quality: 'high' | 'medium' | 'low';
  /** Content permission tags describing what the model allows. */
  contentPermissions: ContentIntent[];
  /** Provider-specific capability tags (e.g. 'face-consistency', 'video'). */
  capabilities: string[];
}

// ---------------------------------------------------------------------------
// Catalog interface
// ---------------------------------------------------------------------------

/** Read-only catalog of uncensored models. */
export interface UncensoredModelCatalog {
  /**
   * Return all text model entries, optionally filtered.
   * @param filter - Optional quality or content permission filter.
   */
  getTextModels(filter?: {
    quality?: CatalogEntry['quality'];
    contentPermissions?: ContentIntent[];
  }): CatalogEntry[];

  /**
   * Return all image model entries, optionally filtered.
   * @param filter - Optional capability filter.
   */
  getImageModels(filter?: { capabilities?: string[] }): CatalogEntry[];

  /**
   * Return the preferred text model for a given policy tier.
   * Returns null for safe/standard tiers (use default censored model).
   * @param tier - Content policy tier.
   * @param contentIntent - Optional content intent for finer selection.
   */
  getPreferredTextModel(
    tier: PolicyTier,
    contentIntent?: ContentIntent,
  ): CatalogEntry | null;

  /**
   * Return the preferred image model for a given policy tier.
   * Returns null for safe/standard tiers.
   * @param tier - Content policy tier.
   * @param capabilities - Optional required capabilities.
   */
  getPreferredImageModel(
    tier: PolicyTier,
    capabilities?: string[],
  ): CatalogEntry | null;
}

// ---------------------------------------------------------------------------
// Built-in catalog data
// ---------------------------------------------------------------------------

/**
 * Curated text models available via OpenRouter.
 *
 * Selection criteria for private-adult tier:
 * - Must be genuinely uncensored (no safety-trained refusals)
 * - Must follow system prompt instructions reliably
 * - Must be actively hosted on OpenRouter (not deprecated)
 *
 * Last updated: 2026-07-06 — refreshed off the Hermes-3-only lineup onto
 * the production-validated ladder (3-arm prod eval, 2026-06-28, Opus
 * judge): magnum-v4-72b held consistent in-character prose with zero
 * quality flags; llama-3.3-70b stayed reliable across multi-provider
 * hosting; hermes-3-405b collapsed into continuity failures (repeated
 * states / re-introduced NPCs) and is removed. Hermes 3 70B is retained
 * as a mid-tier fallback for breadth. llama-3.1-8b is the cheap
 * last-resort link, never a primary.
 */
const TEXT_MODELS: CatalogEntry[] = [
  {
    modelId: 'anthracite-org/magnum-v4-72b',
    displayName: 'Magnum v4 72B',
    providerId: 'openrouter',
    modality: 'text',
    quality: 'high',
    contentPermissions: ['general', 'romantic', 'erotic', 'violent', 'horror'],
    capabilities: ['chat', 'json_mode'],
  },
  {
    modelId: 'meta-llama/llama-3.3-70b-instruct',
    displayName: 'Llama 3.3 70B Instruct',
    providerId: 'openrouter',
    modality: 'text',
    quality: 'high',
    contentPermissions: ['general', 'romantic', 'violent', 'horror'],
    capabilities: ['chat', 'tool_use', 'json_mode'],
  },
  {
    modelId: 'nousresearch/hermes-3-llama-3.1-70b',
    displayName: 'Hermes 3 70B',
    providerId: 'openrouter',
    modality: 'text',
    quality: 'medium',
    contentPermissions: ['general', 'romantic', 'erotic', 'violent', 'horror'],
    capabilities: ['chat', 'tool_use', 'json_mode'],
  },
  {
    modelId: 'meta-llama/llama-3.1-8b-instruct',
    displayName: 'Llama 3.1 8B Instruct',
    providerId: 'openrouter',
    modality: 'text',
    quality: 'low',
    contentPermissions: ['general', 'romantic', 'violent'],
    capabilities: ['chat', 'json_mode'],
  },
  // Removed `nousresearch/hermes-3-llama-3.1-405b` on 2026-07-06: the
  // 2026-06-28 3-arm production eval showed it collapsing into
  // continuity failures by mid-session (the exact incoherence class the
  // narrative-state program exists to fix), and at ~30 tok/s it was also
  // the slowest link in the chain. The 70B variant stays as a mid-tier
  // fallback; magnum-v4-72b takes the quality slot.
  // Removed `cognitivecomputations/dolphin3.0-llama3.1-8b` — OpenRouter
  // returns "not a valid model ID" on every call. The entry was dead
  // weight in the retry chain, burning a round-trip + 100ms before
  // failing over to the next candidate.
  // Removed `cognitivecomputations/dolphin-mixtral-8x22b` — OpenRouter
  // returns "No endpoints found" on every call. Same story: pure
  // latency in the fallback path with no functional benefit. If the
  // upstream fixes its catalog, re-add with the same config.
  // Removed `gryphe/mythomax-l2-13b` on 2026-04-21. The coherence
  // gate caught its SQL/DAX training-data leaks but not its other
  // failure modes: classical-literature rambling (triggered on
  // "Avoiding the direct question, Remarks to the curious, as I
  // recall... Greek, Roman, and Norse writers, from Homer's epics to
  // Ovid's myths..."), fantasy-farewell slop ("we might meet in
  // another life, another world. Until then, I must return to the
  // shadows of history, and you to your mortal realm. Farewell.")
  // and occasional Devanagari token corruption. All surfaced in
  // production as Cleopatra VII responses and made a $10 companion
  // chat look like a broken chatbot demo.
];

/** Curated image models available via Replicate. */
const IMAGE_MODELS: CatalogEntry[] = [
  {
    modelId: 'lucataco/realvisxl-v4.0',
    displayName: 'RealVisXL v4.0',
    providerId: 'replicate',
    modality: 'image',
    quality: 'high',
    contentPermissions: ['general', 'romantic', 'erotic'],
    capabilities: ['txt2img', 'img2img', 'photorealistic'],
  },
  {
    modelId: 'stability-ai/sdxl',
    displayName: 'SDXL',
    providerId: 'replicate',
    modality: 'image',
    quality: 'high',
    contentPermissions: ['general', 'romantic', 'erotic', 'violent', 'horror'],
    capabilities: ['txt2img', 'img2img'],
  },
  {
    modelId: 'zsxkib/instant-id',
    displayName: 'Instant ID',
    providerId: 'replicate',
    modality: 'image',
    quality: 'medium',
    contentPermissions: ['general', 'romantic'],
    capabilities: ['txt2img', 'face-consistency'],
  },
  {
    modelId: 'lucataco/ip-adapter-faceid-sdxl',
    displayName: 'IP-Adapter FaceID SDXL',
    providerId: 'replicate',
    modality: 'image',
    quality: 'medium',
    contentPermissions: ['general', 'romantic', 'erotic'],
    capabilities: ['txt2img', 'img2img', 'face-consistency'],
  },
  {
    modelId: 'lucataco/animate-diff',
    displayName: 'AnimateDiff',
    providerId: 'replicate',
    modality: 'image',
    quality: 'medium',
    contentPermissions: ['general', 'romantic', 'violent'],
    capabilities: ['txt2img', 'video'],
  },
  {
    modelId: 'stability-ai/stable-video-diffusion',
    displayName: 'Stable Video Diffusion',
    providerId: 'replicate',
    modality: 'image',
    quality: 'high',
    contentPermissions: ['general', 'romantic'],
    capabilities: ['img2video', 'video'],
  },
];

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a default {@link UncensoredModelCatalog} populated with curated
 * OpenRouter text models and Replicate image models.
 */
export function createUncensoredModelCatalog(): UncensoredModelCatalog {
  return {
    getTextModels(filter) {
      let results = [...TEXT_MODELS];
      if (filter?.quality) {
        results = results.filter((e) => e.quality === filter.quality);
      }
      if (filter?.contentPermissions?.length) {
        results = results.filter((e) =>
          filter.contentPermissions!.every((p) =>
            e.contentPermissions.includes(p),
          ),
        );
      }
      return results;
    },

    getImageModels(filter) {
      let results = [...IMAGE_MODELS];
      if (filter?.capabilities?.length) {
        results = results.filter((e) =>
          filter.capabilities!.every((c) => e.capabilities.includes(c)),
        );
      }
      return results;
    },

    getPreferredTextModel(tier, contentIntent) {
      if (tier === 'safe' || tier === 'standard') {
        return null;
      }

      let candidates = [...TEXT_MODELS];

      // Filter by content intent when provided
      if (contentIntent) {
        candidates = candidates.filter((e) =>
          e.contentPermissions.includes(contentIntent),
        );
      }

      // For private-adult tier, prioritize models that are both genuinely
      // uncensored AND high quality. Magnum v4 72B is the strongest vetted
      // uncensored model (2026-06-28 3-arm prod eval: consistent
      // in-character prose, zero quality flags); llama-3.3-70b is the
      // reliable multi-provider second link; Hermes 3 70B is mid-tier
      // breadth; llama-3.1-8b is the cheap last resort.
      if (tier === 'private-adult') {
        const preferred = [
          'anthracite-org/magnum-v4-72b',
          'meta-llama/llama-3.3-70b-instruct',
          'nousresearch/hermes-3-llama-3.1-70b',
          'meta-llama/llama-3.1-8b-instruct',
          // hermes-3-405b removed 2026-07-06 (continuity collapse in the
          // 3-arm eval); Dolphin Mixtral 8x22B, Dolphin 3.0 8B, and
          // MythoMax L2 13B removed earlier — see TEXT_MODELS for each
          // removal's rationale.
        ];
        candidates.sort((a, b) => {
          const aIdx = preferred.indexOf(a.modelId);
          const bIdx = preferred.indexOf(b.modelId);
          if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
          if (aIdx !== -1) return -1;
          if (bIdx !== -1) return 1;
          return 0;
        });
        return candidates[0] ?? null;
      }

      // For `mature` tier, prefer the fast multi-provider llama-3.3-70b
      // over the single-provider magnum. The quality delta on mature
      // (non-explicit) narration is below the noise floor for most
      // readers; the latency + host-availability delta dominates UX
      // (production report 2026-05-05: "resolving turn seems to take way
      // too long"). private-adult users above explicitly opt into the
      // magnum quality path; mature users — the broad consumer case —
      // get the fast path.
      if (tier === 'mature') {
        const matureRanking = [
          'meta-llama/llama-3.3-70b-instruct',
          'anthracite-org/magnum-v4-72b',
          'nousresearch/hermes-3-llama-3.1-70b',
          'meta-llama/llama-3.1-8b-instruct',
        ];
        candidates.sort((a, b) => {
          const aIdx = matureRanking.indexOf(a.modelId);
          const bIdx = matureRanking.indexOf(b.modelId);
          if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
          if (aIdx !== -1) return -1;
          if (bIdx !== -1) return 1;
          return 0;
        });
        return candidates[0] ?? null;
      }

      // Other tiers: stable-sort by quality high → medium → low.
      const qualityOrder: Record<string, number> = {
        high: 0,
        medium: 1,
        low: 2,
      };
      candidates.sort(
        (a, b) => qualityOrder[a.quality] - qualityOrder[b.quality],
      );

      return candidates[0] ?? null;
    },

    getPreferredImageModel(tier, capabilities) {
      if (tier === 'safe' || tier === 'standard') {
        return null;
      }

      let candidates = [...IMAGE_MODELS];

      if (capabilities?.length) {
        candidates = candidates.filter((e) =>
          capabilities.every((c) => e.capabilities.includes(c)),
        );
      }

      // Sort: high > medium > low
      const qualityOrder: Record<string, number> = {
        high: 0,
        medium: 1,
        low: 2,
      };
      candidates.sort(
        (a, b) => qualityOrder[a.quality] - qualityOrder[b.quality],
      );

      return candidates[0] ?? null;
    },
  };
}
