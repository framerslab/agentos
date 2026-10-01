/**
 * @fileoverview Per-model prompt-cache capability helper for Anthropic models.
 *
 * Anthropic prompt caching is uniform in API shape (`cache_control` markers,
 * 4-breakpoint cap) but MODEL-DEPENDENT in two behaviors that matter for
 * correct cache economics:
 *
 *  1. **Minimum cacheable prefix**: a marked prefix below the model's floor
 *     silently never caches (create=0, no error). Floors per Anthropic's
 *     prompt-caching docs (2026-09-30):
 *
 *     | Floor | Models |
 *     | --- | --- |
 *     | 512 | Fable 5 / 5.1, Mythos 5 / 5.1, Opus 5 / 5.5, Sonnet 5.5 |
 *     | 1024 | Opus 4.8, Sonnet 5, Sonnet 4.6, Sonnet 4.5 and older Sonnet, Opus 4.0 / 4.1, Opus 3 |
 *     | 2048 | Opus 4.7, Mythos Preview, Haiku 3.x |
 *     | 4096 | Opus 4.5 / 4.6, Haiku 4.5 |
 *
 *     The floors are not monotonic across generations, so each model gets
 *     its own row. Probes agree: nothing cached at about 820 tokens on the
 *     1024-floor models, Sonnet 5 did not cache at 830 tokens, and Opus 4.5
 *     did not cache at 561.
 *
 *  2. **Prior-turn thinking retention**: on Opus 4.5+ and Sonnet 4.6+ (and
 *     Fable/Mythos), thinking blocks from previous assistant turns are KEPT
 *     in context by default, participate in prompt caching, and are billed
 *     only when shown; on earlier Opus/Sonnet models and ALL Haiku models
 *     the server strips them from context BEFORE caching. Client-side
 *     handling should mirror the server: pass blocks back verbatim on
 *     retaining models (byte-stable prefix -> incremental cache reads) and
 *     may strip on non-retaining models (pure wire savings; cache-neutral
 *     because the server discards them pre-cache either way).
 *
 * The floor's one consumer is the cache-leak detector's `unmarked` threshold
 * (cacheLeakDetector.ts); retention also drives the prior-thinking strip in
 * AnthropicProvider.
 *
 * Kept pure (no provider/SDK imports) like `model-thinking.ts` /
 * `model-effort.ts` so unit tests import no provider code. Matching is
 * prefix-tolerant (`anthropic/`, `anthropic:`, `anthropic.` and dated or
 * suffixed ids) with no `^` anchor. An UNKNOWN (future) claude model gets
 * modern semantics (retains thinking) and a 4096 floor, the highest of the
 * table, so heuristics built on the floor stay quiet-biased rather than
 * noisy.
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

/** Floor for unknown claude ids: the highest in the table, so quiet-biased. */
const MODERN_FLOOR = 4096;

/** Capabilities of a claude model that supports prompt caching. */
function caps(floor: number, retainsPriorThinking: boolean): AnthropicCacheCapabilities {
  return {
    supportsPromptCaching: true,
    minCacheablePrefixTokens: floor,
    retainsPriorThinkingInContext: retainsPriorThinking,
  };
}

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
  if (/claude-haiku-4-5|claude-4-5-haiku/.test(id)) return caps(4096, false);
  if (/claude-3-5-haiku|claude-3-haiku/.test(id)) return caps(2048, false);

  // --- Fable, Mythos, Opus 5.x and Sonnet 5.5: modern semantics ---
  // Mythos Preview runs before the Mythos 5.x match, which it does not share.
  if (/claude-mythos-preview/.test(id)) return caps(2048, true);
  // `sonnet-5-5\b` keeps Sonnet 5 (1024, below) out of this row.
  if (/claude-(fable|mythos)-5|claude-opus-5|claude-sonnet-5-5\b/.test(id)) return caps(512, true);

  // --- Opus 4.x ---
  if (/claude-opus-4-8/.test(id)) return caps(1024, true);
  if (/claude-opus-4-7/.test(id)) return caps(2048, true);
  if (/claude-opus-4-(5|6)/.test(id)) return caps(4096, true);
  // Opus 4.0 / 4.1 and Opus 3: pre-retention era.
  if (/claude-opus-4|claude-3-opus/.test(id)) return caps(1024, false);

  // --- Sonnet ---
  if (/claude-sonnet-4-6|claude-sonnet-5/.test(id)) return caps(1024, true);
  if (/claude-sonnet-4|claude-3-7-sonnet|claude-3-5-sonnet|claude-3-sonnet/.test(id)) {
    return caps(1024, false);
  }

  // Unknown / future claude model: modern semantics with the highest floor,
  // so floor-based heuristics stay quiet-biased.
  return caps(MODERN_FLOOR, true);
}
