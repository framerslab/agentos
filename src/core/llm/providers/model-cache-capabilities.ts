/**
 * @fileoverview Per-model prompt-cache capability helper for Anthropic models.
 *
 * Anthropic prompt caching is uniform in API shape (`cache_control` markers,
 * 4-breakpoint cap) but MODEL-DEPENDENT in two behaviors that matter for
 * correct cache economics:
 *
 *  1. **Minimum cacheable prefix** — a marked prefix below the model's floor
 *     silently never caches (create=0, no error). Floors per the pricing
 *     docs: 4096 tokens (Opus 4.5-4.8, Haiku 4.5), 2048 (Fable/Mythos 5,
 *     Sonnet 4.6, Haiku 3.x), 1024 (Sonnet 3.7-4.5).
 *
 *  2. **Prior-turn thinking retention** — on Opus 4.5+ and Sonnet 4.6+ (and
 *     Fable/Mythos), thinking blocks from previous assistant turns are KEPT
 *     in context by default, participate in prompt caching, and are billed
 *     only when shown; on earlier Opus/Sonnet models and ALL Haiku models
 *     the server strips them from context BEFORE caching. Client-side
 *     handling should mirror the server: pass blocks back verbatim on
 *     retaining models (byte-stable prefix -> incremental cache reads) and
 *     may strip on non-retaining models (pure wire savings; cache-neutral
 *     because the server discards them pre-cache either way).
 *
 * Kept pure (no provider/SDK imports) like `model-thinking.ts` /
 * `model-effort.ts` so unit tests import no provider code. Matching is
 * prefix-tolerant (`anthropic/`, `anthropic:`, `anthropic.` and dated or
 * suffixed ids) with no `^` anchor, and defaults are chosen for UNKNOWN
 * (future) claude models: modern semantics (retains thinking) and the most
 * conservative floor (4096) so heuristics built on the floor stay
 * quiet-biased rather than noisy.
 */

/** Cache-relevant capabilities for one Anthropic model id. */
export interface AnthropicCacheCapabilities {
  /** Whether the auto-cache path should place markers at all. */
  supportsPromptCaching: boolean;
  /** Marked prefixes below this token floor silently never cache. */
  minCacheablePrefixTokens: number;
  /**
   * Whether the server keeps prior-turn thinking blocks in context/caching.
   * True -> pass them back verbatim (byte-stable prefix). False -> the
   * server strips pre-cache; client-side stripping is cache-neutral.
   */
  retainsPriorThinkingInContext: boolean;
}

const MODERN_FLOOR = 4096;

/**
 * Resolve the cache capabilities for an Anthropic model id.
 *
 * @param modelId Anthropic-side model id, bare or provider-prefixed, with or
 *   without a date suffix (e.g. `claude-haiku-4-5-20251001`,
 *   `anthropic/claude-opus-4-8`).
 */
export function resolveCacheCapabilities(modelId: string): AnthropicCacheCapabilities {
  const id = modelId.toLowerCase();

  if (!/claude/.test(id)) {
    // Not an Anthropic model — the auto-cache path should stand down
    // entirely (explicit caller markers still pass through untouched).
    return {
      supportsPromptCaching: false,
      minCacheablePrefixTokens: MODERN_FLOOR,
      retainsPriorThinkingInContext: false,
    };
  }

  // --- Haiku: never retains prior thinking, floors per generation ---
  if (/claude-haiku-4-5|claude-4-5-haiku/.test(id)) {
    return { supportsPromptCaching: true, minCacheablePrefixTokens: 4096, retainsPriorThinkingInContext: false };
  }
  if (/claude-3-5-haiku|claude-3-haiku/.test(id)) {
    return { supportsPromptCaching: true, minCacheablePrefixTokens: 2048, retainsPriorThinkingInContext: false };
  }

  // --- Fable / Mythos: modern semantics, 2048 floor ---
  if (/claude-(fable|mythos)-/.test(id)) {
    return { supportsPromptCaching: true, minCacheablePrefixTokens: 2048, retainsPriorThinkingInContext: true };
  }

  // --- Opus ---
  if (/claude-opus-4-(5|6|7|8)/.test(id)) {
    return { supportsPromptCaching: true, minCacheablePrefixTokens: 4096, retainsPriorThinkingInContext: true };
  }
  if (/claude-opus-4|claude-3-opus/.test(id)) {
    // Opus 4.0/4.1 and Opus 3: pre-retention era. Floor not documented in
    // the current pricing table — keep the conservative 4096.
    return { supportsPromptCaching: true, minCacheablePrefixTokens: 4096, retainsPriorThinkingInContext: false };
  }

  // --- Sonnet ---
  if (/claude-sonnet-4-6|claude-sonnet-5/.test(id)) {
    return { supportsPromptCaching: true, minCacheablePrefixTokens: 2048, retainsPriorThinkingInContext: true };
  }
  if (/claude-sonnet-4|claude-3-7-sonnet|claude-3-5-sonnet|claude-3-sonnet/.test(id)) {
    return { supportsPromptCaching: true, minCacheablePrefixTokens: 1024, retainsPriorThinkingInContext: false };
  }

  // Unknown / future claude model: assume modern semantics with the most
  // conservative floor, so floor-based heuristics stay quiet-biased.
  return {
    supportsPromptCaching: true,
    minCacheablePrefixTokens: MODERN_FLOOR,
    retainsPriorThinkingInContext: true,
  };
}
