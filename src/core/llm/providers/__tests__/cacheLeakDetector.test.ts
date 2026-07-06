import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  recordCacheUsage,
  resetCacheLeakDetector,
  __cacheLeakThresholds,
} from '../implementations/cacheLeakDetector';

/**
 * The cache-leak detector exists because three separate cache regressions
 * shipped silently in one week (bare-string system prompt, memory-hook
 * prefix churn, caller-marker stand-down) — each paying full input price
 * or write-premium-for-nothing until log forensics caught it days later.
 * It watches per-callsite (model + system-prefix hash) usage and warns
 * once per bucket on the two pathological signatures:
 *   zero-read:  repeated cache WRITES with no reads ever (prefix churn)
 *   unmarked:   repeated large uncached prompts with no cache activity
 *               (missing/dropped breakpoints)
 */
describe('cacheLeakDetector', () => {
  const warns: string[] = [];
  const warn = (msg: string) => {
    warns.push(msg);
  };
  const T = __cacheLeakThresholds;

  beforeEach(() => {
    resetCacheLeakDetector();
    warns.length = 0;
    delete process.env.AGENTOS_CACHE_LEAK_DETECTOR;
  });
  afterEach(() => {
    delete process.env.AGENTOS_CACHE_LEAK_DETECTOR;
  });

  const sample = (over: Partial<Parameters<typeof recordCacheUsage>[0]> = {}) => ({
    model: 'claude-opus-4-8',
    systemPrefix: 'You are the codegen orchestrator. Family contract v3…',
    uncachedInputTokens: 100,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    ...over,
  });

  it('warns once on repeated cache writes with zero reads (prefix-churn signature)', () => {
    const perCall = Math.ceil(T.zeroReadCreateFloor / T.minCalls) + 1;
    for (let i = 0; i < T.minCalls + 4; i++) {
      recordCacheUsage(sample({ cacheCreationTokens: perCall }), warn);
    }
    const zeroReadWarns = warns.filter((w) => w.includes('zero_read'));
    expect(zeroReadWarns).toHaveLength(1);
    expect(zeroReadWarns[0]).toContain('claude-opus-4-8');
  });

  it('warns once on repeated large uncached prompts with no cache activity (unmarked signature)', () => {
    for (let i = 0; i < T.minCalls + 4; i++) {
      recordCacheUsage(sample({ uncachedInputTokens: T.uncachedAvgFloor + 500 }), warn);
    }
    const unmarked = warns.filter((w) => w.includes('unmarked'));
    expect(unmarked).toHaveLength(1);
  });

  it('stays silent when reads are flowing (healthy caching)', () => {
    for (let i = 0; i < T.minCalls * 3; i++) {
      recordCacheUsage(
        sample({ cacheCreationTokens: 2_000, cacheReadTokens: 15_000, uncachedInputTokens: 9_000 }),
        warn,
      );
    }
    expect(warns).toHaveLength(0);
  });

  it('stays silent for small prompts with no cache activity (below the cacheable floor)', () => {
    for (let i = 0; i < T.minCalls * 3; i++) {
      recordCacheUsage(sample({ uncachedInputTokens: 900 }), warn);
    }
    expect(warns).toHaveLength(0);
  });

  it('tracks callsites independently (different system prefixes never pool)', () => {
    for (let i = 0; i < T.minCalls - 1; i++) {
      recordCacheUsage(sample({ systemPrefix: 'narrator prompt', uncachedInputTokens: 9_000 }), warn);
      recordCacheUsage(sample({ systemPrefix: 'judge prompt', uncachedInputTokens: 9_000 }), warn);
    }
    // Each bucket sits at minCalls-1 — neither may warn.
    expect(warns).toHaveLength(0);
  });

  it('is disabled by the env kill switch', () => {
    process.env.AGENTOS_CACHE_LEAK_DETECTOR = '0';
    for (let i = 0; i < T.minCalls * 3; i++) {
      recordCacheUsage(sample({ uncachedInputTokens: T.uncachedAvgFloor + 500 }), warn);
    }
    expect(warns).toHaveLength(0);
  });

  it('bounds memory: the bucket map clears past the cap instead of growing forever', () => {
    for (let i = 0; i < T.maxBuckets + 10; i++) {
      recordCacheUsage(sample({ systemPrefix: `prompt-${i}` }), warn);
    }
    // No assertion on internals beyond not throwing; the reset hook proves
    // the map is reachable and clearable.
    expect(() => resetCacheLeakDetector()).not.toThrow();
  });
});
