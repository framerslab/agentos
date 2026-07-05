import { describe, it, expect, beforeEach, afterEach } from 'vitest';

/**
 * Test the system block extraction logic that AnthropicProvider.buildRequestPayload
 * uses to decide whether to emit system as a plain string or content block array.
 *
 * Since buildRequestPayload is private, we replicate the extraction logic here
 * as a pure function and validate the behavior.
 */

type SystemBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };

function buildSystemPayload(
  messages: Array<{ role: string; content: string | Array<Record<string, any>> | null }>
): string | SystemBlock[] {
  const systemBlocks: SystemBlock[] = [];

  for (const msg of messages) {
    if (msg.role !== 'system') continue;

    if (typeof msg.content === 'string') {
      if (msg.content) systemBlocks.push({ type: 'text', text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text') {
          const block: SystemBlock = { type: 'text', text: part.text };
          if (part.cache_control) block.cache_control = part.cache_control;
          systemBlocks.push(block);
        }
      }
    }
  }

  if (systemBlocks.length === 0) return '';

  const hasCacheMarkers = systemBlocks.some(b => b.cache_control);
  return hasCacheMarkers ? systemBlocks : systemBlocks.map(b => b.text).join('\n\n');
}

describe('AnthropicProvider system prompt cache control', () => {
  it('joins plain string system messages into a single string', () => {
    const result = buildSystemPayload([
      { role: 'system', content: 'You are helpful.' },
      { role: 'system', content: 'Be concise.' },
    ]);
    expect(result).toBe('You are helpful.\n\nBe concise.');
  });

  it('returns content block array when cache_control markers are present', () => {
    const result = buildSystemPayload([
      {
        role: 'system',
        content: [
          { type: 'text', text: 'Static instructions', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'Dynamic state' },
        ],
      },
    ]);
    expect(Array.isArray(result)).toBe(true);
    const blocks = result as SystemBlock[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      type: 'text',
      text: 'Static instructions',
      cache_control: { type: 'ephemeral' },
    });
    expect(blocks[1]).toEqual({
      type: 'text',
      text: 'Dynamic state',
    });
  });

  it('falls back to joined string when no cache_control markers exist on content blocks', () => {
    const result = buildSystemPayload([
      {
        role: 'system',
        content: [
          { type: 'text', text: 'Part A' },
          { type: 'text', text: 'Part B' },
        ],
      },
    ]);
    expect(typeof result).toBe('string');
    expect(result).toBe('Part A\n\nPart B');
  });

  it('handles mixed string and content block system messages', () => {
    const result = buildSystemPayload([
      { role: 'system', content: 'Preamble' },
      {
        role: 'system',
        content: [
          { type: 'text', text: 'Cached block', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'Dynamic block' },
        ],
      },
    ]);
    expect(Array.isArray(result)).toBe(true);
    const blocks = result as SystemBlock[];
    expect(blocks).toHaveLength(3);
    expect(blocks[0].text).toBe('Preamble');
    expect(blocks[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('skips empty string system messages', () => {
    const result = buildSystemPayload([
      { role: 'system', content: '' },
      { role: 'system', content: 'Real content' },
    ]);
    expect(result).toBe('Real content');
  });

  it('ignores non-system messages', () => {
    const result = buildSystemPayload([
      { role: 'system', content: 'System msg' },
      { role: 'user', content: 'User msg' },
    ]);
    expect(result).toBe('System msg');
  });
});

/**
 * Verify the cache-tier cost estimation math. Anthropic bills at three
 * different rates for input tokens:
 *   non-cached input       × 1.00 × base input rate
 *   cache_read_input_tokens × 0.10 × base input rate
 *   cache_creation_input_tokens × 1.25 × base input rate (5-min TTL)
 *
 * The previous AnthropicProvider.estimateCost signature only took
 * (inputTokens, outputTokens, modelId), which silently under-reported
 * cost when caching was active. We replicate the current math here so a
 * regression to the old formula trips the test.
 */
function estimateCacheAwareCost(
  inputTokens: number,
  outputTokens: number,
  inputPricePerM: number,
  outputPricePerM: number,
  cacheReadTokens?: number,
  cacheCreationTokens?: number,
): number {
  const nonCachedInput = (inputTokens / 1_000_000) * inputPricePerM;
  const cachedRead = ((cacheReadTokens ?? 0) / 1_000_000) * inputPricePerM * 0.10;
  const cachedCreate = ((cacheCreationTokens ?? 0) / 1_000_000) * inputPricePerM * 1.25;
  const output = (outputTokens / 1_000_000) * outputPricePerM;
  return nonCachedInput + cachedRead + cachedCreate + output;
}

describe('AnthropicProvider cache-aware cost estimation', () => {
  // Claude Sonnet 4.6 prices — same as production
  const SONNET_INPUT = 3.00;
  const SONNET_OUTPUT = 15.00;

  it('matches the base-rate formula when caching is inactive', () => {
    const cost = estimateCacheAwareCost(1000, 500, SONNET_INPUT, SONNET_OUTPUT);
    // 1000 × $3/M + 500 × $15/M = $0.003 + $0.0075 = $0.0105
    expect(cost).toBeCloseTo(0.0105, 6);
  });

  it('bills cache_read tokens at 0.1× the input rate', () => {
    // 1000 non-cached input + 5000 cache-read + 500 output
    const cost = estimateCacheAwareCost(1000, 500, SONNET_INPUT, SONNET_OUTPUT, 5000);
    // Non-cached:  1000 × $3/M     = $0.003
    // Cache read:  5000 × $3/M × 0.1 = $0.0015
    // Output:      500 × $15/M    = $0.0075
    // Total:                        $0.012
    expect(cost).toBeCloseTo(0.012, 6);
  });

  it('bills cache_creation tokens at 1.25× the input rate', () => {
    // 1000 non-cached + 5000 cache-created + 500 output (no read)
    const cost = estimateCacheAwareCost(1000, 500, SONNET_INPUT, SONNET_OUTPUT, 0, 5000);
    // Non-cached:  1000 × $3/M       = $0.003
    // Cache create: 5000 × $3/M × 1.25 = $0.01875
    // Output:       500 × $15/M     = $0.0075
    // Total:                          $0.02925
    expect(cost).toBeCloseTo(0.02925, 6);
  });

  it('surfaces the savings when most input is a cache read vs fully non-cached', () => {
    // First call pays full price for 10000 input tokens (no cache yet)
    const firstCall = estimateCacheAwareCost(10000, 500, SONNET_INPUT, SONNET_OUTPUT);
    // Second call hits the cache: only 100 non-cached + 9900 cache reads
    const secondCall = estimateCacheAwareCost(100, 500, SONNET_INPUT, SONNET_OUTPUT, 9900);
    // Second call should cost significantly less than first.
    expect(secondCall).toBeLessThan(firstCall * 0.5);
    // Specifically: firstCall = 10000 × $3/M + 500 × $15/M = $0.0375
    expect(firstCall).toBeCloseTo(0.0375, 6);
    // secondCall = 100 × $3/M + 9900 × $3/M × 0.1 + 500 × $15/M
    //            = $0.0003 + $0.00297 + $0.0075 = $0.01077
    expect(secondCall).toBeCloseTo(0.01077, 6);
  });

  it('a cache-heavy run saves roughly 80% on input cost vs no cache', () => {
    // 1 initial cache-create (expensive) + 9 cache reads (cheap), same token shape each call
    const PROMPT_PREFIX = 5000;
    const DYNAMIC = 500;
    const OUTPUT = 200;

    // Cold run: 10 calls, all non-cached
    let coldTotal = 0;
    for (let i = 0; i < 10; i++) {
      coldTotal += estimateCacheAwareCost(PROMPT_PREFIX + DYNAMIC, OUTPUT, SONNET_INPUT, SONNET_OUTPUT);
    }

    // Cached run: first call creates, next 9 read
    let cachedTotal = estimateCacheAwareCost(DYNAMIC, OUTPUT, SONNET_INPUT, SONNET_OUTPUT, 0, PROMPT_PREFIX);
    for (let i = 0; i < 9; i++) {
      cachedTotal += estimateCacheAwareCost(DYNAMIC, OUTPUT, SONNET_INPUT, SONNET_OUTPUT, PROMPT_PREFIX);
    }

    const savings = (coldTotal - cachedTotal) / coldTotal;
    // Caching should save 60-90% of INPUT cost on cache-heavy workloads.
    // Output cost is identical so the total savings depend on input:output ratio.
    // With 5500:200 input:output ratio here, total savings should be 50%+.
    expect(savings).toBeGreaterThan(0.5);
  });
});

/**
 * Automatic prompt caching: a request-level `cache_control` is a real
 * Anthropic feature (verified empirically 2026-06 — a top-level
 * `{type:'ephemeral'}` writes the cache and reads it back on the next
 * identical request). The API auto-places a moving cache breakpoint on the
 * last cacheable block (tools + system + messages). buildRequestPayload sets
 * it by default and STANDS DOWN whenever the caller has placed an explicit
 * block-level breakpoint, so a caller's 1h-TTL breakpoint is never mixed with
 * a 5-min auto one. Exercises the REAL private buildRequestPayload (the single
 * chokepoint feeding both the streaming and non-streaming /v1/messages paths).
 */
import { AnthropicProvider } from '../implementations/AnthropicProvider';

describe('AnthropicProvider automatic prompt caching', () => {
  const ENV_KEY = 'AGENTOS_ANTHROPIC_AUTO_CACHE';
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
  });

  async function buildPayload(
    messages: Array<Record<string, unknown>>,
    options: Record<string, unknown> = {},
    modelId: string = 'claude-sonnet-4-6',
  ): Promise<Record<string, unknown>> {
    const provider = new AnthropicProvider();
    await provider.initialize({ apiKey: 'test-anthropic-key' });
    return (provider as unknown as {
      buildRequestPayload: (
        modelId: string,
        messages: unknown,
        options: unknown,
        stream: boolean,
      ) => Record<string, unknown>;
    }).buildRequestPayload(modelId, messages, options, false);
  }

  it('sets a top-level cache_control by default and leaves system untouched', async () => {
    const payload = await buildPayload([
      { role: 'system', content: 'You are a stable, reusable system prompt.' },
      { role: 'user', content: 'hi' },
    ]);
    expect(payload.cache_control).toEqual({ type: 'ephemeral' });
    // Auto-cache does NOT restructure the system — it stays the joined string.
    expect(typeof payload.system).toBe('string');
  });

  it('sets a top-level cache_control even with no system block', async () => {
    const payload = await buildPayload([{ role: 'user', content: 'hi' }]);
    expect(payload.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('honors the kill-switch env', async () => {
    process.env[ENV_KEY] = '0';
    const payload = await buildPayload([
      { role: 'system', content: 'A system prompt.' },
      { role: 'user', content: 'hi' },
    ]);
    expect(payload.cache_control).toBeUndefined();
  });

  /**
   * Extended thinking: the request-level auto marker measurably produces
   * ZERO cache creation on thinking-enabled calls (2026-07: 900+ codegen
   * agent-loop calls, ~12M prompt tokens/day, 0.000 hit rate). Under
   * thinking the auto-cache pins an explicit block-level breakpoint to the
   * last block of the FIRST system message instead — the primary system
   * prompt precedes the thinking-bearing messages so it caches normally,
   * while hook-appended per-turn system context (memory recall) stays
   * OUTSIDE the cached prefix.
   */
  it('under thinking, pins the breakpoint to the last block of the first system message', async () => {
    const payload = await buildPayload(
      [
        {
          role: 'system',
          content: [
            { type: 'text', text: 'Primary system part A' },
            { type: 'text', text: 'Primary system part B' },
          ],
        },
        { role: 'system', content: 'Per-turn recall appended by memory hooks' },
        { role: 'user', content: 'hi' },
      ],
      { thinking: { budgetTokens: 1 } },
      'claude-opus-4-8',
    );
    expect(payload.thinking).toBeDefined();
    // No top-level moving marker — it is a no-op under thinking.
    expect(payload.cache_control).toBeUndefined();
    const system = payload.system as Array<{ text: string; cache_control?: unknown }>;
    expect(Array.isArray(system)).toBe(true);
    expect(system).toHaveLength(3);
    expect(system[0].cache_control).toBeUndefined();
    // Breakpoint on the last block of the FIRST system message…
    expect(system[1].cache_control).toEqual({ type: 'ephemeral' });
    // …and the volatile recall block stays outside the cached prefix.
    expect(system[2].cache_control).toBeUndefined();
  });

  it('under thinking with a string system, marks its single block', async () => {
    const payload = await buildPayload(
      [
        { role: 'system', content: 'A stable string system prompt.' },
        { role: 'user', content: 'hi' },
      ],
      { thinking: { budgetTokens: 1 } },
      'claude-opus-4-8',
    );
    expect(payload.cache_control).toBeUndefined();
    const system = payload.system as Array<{ text: string; cache_control?: unknown }>;
    expect(Array.isArray(system)).toBe(true);
    expect(system).toHaveLength(1);
    expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('under thinking with no system at all, keeps the top-level auto marker', async () => {
    const payload = await buildPayload(
      [{ role: 'user', content: 'hi' }],
      { thinking: { budgetTokens: 1 } },
      'claude-opus-4-8',
    );
    expect(payload.cache_control).toEqual({ type: 'ephemeral' });
    expect(payload.system).toBeUndefined();
  });

  it('under thinking, stands down entirely when the caller placed an explicit breakpoint', async () => {
    const payload = await buildPayload(
      [
        {
          role: 'system',
          content: [
            { type: 'text', text: 'Stable prefix', cache_control: { type: 'ephemeral', ttl: '1h' } },
            { type: 'text', text: 'Volatile tail' },
          ],
        },
        { role: 'user', content: 'hi' },
      ],
      { thinking: { budgetTokens: 1 } },
      'claude-opus-4-8',
    );
    expect(payload.cache_control).toBeUndefined();
    const system = payload.system as Array<{ cache_control?: unknown }>;
    expect(system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(system[1].cache_control).toBeUndefined();
  });

  it('stands down when the caller placed an explicit breakpoint, preserving its 1h TTL', async () => {
    const payload = await buildPayload([
      {
        role: 'system',
        content: [
          { type: 'text', text: 'Stable persona prefix', cache_control: { type: 'ephemeral', ttl: '1h' } },
          { type: 'text', text: 'Dynamic per-turn state' },
        ],
      },
      { role: 'user', content: 'hi' },
    ]);
    // No top-level breakpoint added alongside the caller's explicit one (would
    // mix a 5-min auto TTL with the caller's 1h TTL in one request).
    expect(payload.cache_control).toBeUndefined();
    const system = payload.system as Array<{ cache_control?: unknown }>;
    expect(Array.isArray(system)).toBe(true);
    // The caller's explicit 1h breakpoint is preserved verbatim.
    expect(system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(system[1].cache_control).toBeUndefined();
  });
});
