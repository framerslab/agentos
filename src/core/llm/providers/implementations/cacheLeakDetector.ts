/**
 * @file cacheLeakDetector.ts
 * @description In-process telemetry that catches silent prompt-cache
 * regressions at the provider layer.
 *
 * Three separate cache regressions shipped silently in one week of
 * 2026-07 — a bare-string system prompt that never emitted a breakpoint,
 * a memory-recall hook that prepended ahead of the cached prefix and
 * churned it every turn, and a caller-marker stand-down that cancelled
 * the auto history-tail — each billing full input price (or write
 * premium with zero reads) until multi-hour log forensics caught it.
 * The signatures are mechanical, so this detector watches for them per
 * callsite and emits ONE structured warning per bucket:
 *
 *   `zero_read`  — repeated cache WRITES with no reads ever. The prefix
 *                  is being re-written every call (churn ahead of the
 *                  breakpoint), paying the 1.25x write premium for
 *                  nothing back.
 *   `unmarked`   — repeated LARGE uncached prompts with no cache
 *                  activity at all. Breakpoints are missing, dropped in
 *                  conversion, or stood down; the caller re-pays full
 *                  input price on every call. Only fires when the
 *                  average uncached size clears the largest per-model
 *                  cacheable minimum (4096 tokens), so legitimately
 *                  sub-minimum prompts never flag.
 *
 * A callsite is identified as `model | hash(first 256 chars of the
 * system prompt)` — stable across calls from the same prompt-assembly
 * path without any caller plumbing. Warn-once semantics per bucket keep
 * the log quiet; the bucket map is size-capped and clears past the cap
 * (coarse, but the detector is a tripwire, not an accounting system).
 *
 * Kill switch: `AGENTOS_CACHE_LEAK_DETECTOR=0` (or `false`).
 */

import { resolveCacheCapabilities } from '../model-cache-capabilities.js';

export interface CacheUsageSample {
  /** Resolved model id the request ran on. */
  model: string;
  /** The request's system prompt text (first block when structured). */
  systemPrefix: string;
  /** `usage.input_tokens` — tokens billed at FULL input price. */
  uncachedInputTokens: number;
  /** `usage.cache_read_input_tokens` (0.1x price). */
  cacheReadTokens: number;
  /** `usage.cache_creation_input_tokens` (1.25-2x price). */
  cacheCreationTokens: number;
}

interface Bucket {
  calls: number;
  uncached: number;
  reads: number;
  creates: number;
  warnedZeroRead: boolean;
  warnedUnmarked: boolean;
}

/** Tuning constants, exported for tests (not part of the public API). */
export const __cacheLeakThresholds = {
  /** Calls from one callsite before any verdict — one-shots never flag. */
  minCalls: 8,
  /** Total cache-write tokens before zero-read churn is worth a warning. */
  zeroReadCreateFloor: 50_000,
  /**
   * FALLBACK average uncached tokens/call before "nothing cached" is
   * suspicious, used when the model id resolves no capabilities. The live
   * threshold is the MODEL's own cacheable-prefix floor (4096/2048/1024 —
   * see model-cache-capabilities.ts), so e.g. a Sonnet 4.6 callsite paying
   * 3K uncached tokens/call with zero cache activity flags even though it
   * sits under the Opus floor.
   */
  uncachedAvgFloor: 4_096,
  /** Bucket-map size cap; the map clears past it. */
  maxBuckets: 256,
} as const;

const buckets = new Map<string, Bucket>();

/** FNV-1a 32-bit — tiny, deterministic, no deps; collision risk irrelevant
 *  at 256 buckets of telemetry. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/**
 * Record one request's cache usage and warn (once per callsite bucket) on a
 * pathological signature. Never throws; disabled via
 * `AGENTOS_CACHE_LEAK_DETECTOR=0`.
 *
 * @param sample - Per-request usage + callsite identity inputs.
 * @param warn - Warning sink; defaults to `console.warn`. Injected for tests.
 */
export function recordCacheUsage(
  sample: CacheUsageSample,
  warn: (message: string) => void = console.warn,
): void {
  const env = process.env.AGENTOS_CACHE_LEAK_DETECTOR;
  if (env === '0' || env === 'false') return;

  try {
    const T = __cacheLeakThresholds;
    if (buckets.size > T.maxBuckets) buckets.clear();

    const key = `${sample.model}|${fnv1a(sample.systemPrefix.slice(0, 256))}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { calls: 0, uncached: 0, reads: 0, creates: 0, warnedZeroRead: false, warnedUnmarked: false };
      buckets.set(key, bucket);
    }
    bucket.calls += 1;
    bucket.uncached += sample.uncachedInputTokens || 0;
    bucket.reads += sample.cacheReadTokens || 0;
    bucket.creates += sample.cacheCreationTokens || 0;

    if (bucket.calls < T.minCalls) return;

    // Per-model cacheable-prefix floor: prompts below it CANNOT cache, so
    // "no cache activity" is only suspicious above the model's own floor.
    const caps = resolveCacheCapabilities(sample.model);
    if (!caps.supportsPromptCaching) return;
    const unmarkedFloor = caps.minCacheablePrefixTokens || T.uncachedAvgFloor;

    if (!bucket.warnedZeroRead && bucket.reads === 0 && bucket.creates >= T.zeroReadCreateFloor) {
      bucket.warnedZeroRead = true;
      warn(
        `[agentos cache-leak] zero_read: callsite=${key} calls=${bucket.calls} `
        + `cacheCreates=${bucket.creates} cacheReads=0 — the cached prefix is being `
        + `re-written every call (churn ahead of the breakpoint?); paying the write `
        + `premium with nothing read back. model=${sample.model}`,
      );
    }

    if (
      !bucket.warnedUnmarked
      && bucket.creates === 0
      && bucket.reads === 0
      && bucket.uncached / bucket.calls >= unmarkedFloor
    ) {
      bucket.warnedUnmarked = true;
      warn(
        `[agentos cache-leak] unmarked: callsite=${key} calls=${bucket.calls} `
        + `avgUncachedTokens=${Math.round(bucket.uncached / bucket.calls)} with zero cache `
        + `activity — breakpoints missing/dropped/stood-down; full input price every call. `
        + `model=${sample.model}`,
      );
    }
  } catch {
    // Telemetry must never break a request.
  }
}

/** Test hook: clear all buckets. */
export function resetCacheLeakDetector(): void {
  buckets.clear();
}
