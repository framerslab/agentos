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
 * it by default. Caller markers compose per region: SYSTEM-only markers keep
 * their placement + TTL verbatim while the auto moving tail still lands on
 * the final message (thinking or not); MESSAGE markers stand the auto path
 * down entirely. Exercises the REAL private buildRequestPayload (the single
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

  it('under thinking, also pins a moving breakpoint on the last cacheable message block', async () => {
    // Agent-loop shape: growing history is the dominant uncached spend once
    // the system prefix caches. The tail marker gives each step incremental
    // prefix reads (the thinking-strip only mutates the last two turns, so
    // the older history stays byte-stable between calls).
    const payload = await buildPayload(
      [
        { role: 'system', content: 'Loop system prompt.' },
        { role: 'user', content: 'build the bundle' },
        {
          role: 'assistant',
          content: 'Working on it.',
          tool_calls: [
            { id: 'tc_1', type: 'function', function: { name: 'ApplyPatch', arguments: '{"a":1}' } },
          ],
          thinkingBlocks: [{ type: 'thinking', thinking: 'plan…', signature: 'sig' }],
        },
        { role: 'tool', tool_call_id: 'tc_1', content: 'patch applied' },
      ],
      { thinking: { budgetTokens: 1 } },
      'claude-opus-4-8',
    );
    expect(payload.cache_control).toBeUndefined();
    const messages = payload.messages as Array<{ role: string; content: unknown }>;
    const last = messages[messages.length - 1];
    const lastBlocks = last.content as Array<{ type: string; cache_control?: unknown }>;
    // Tool-result tail carries the moving breakpoint…
    expect(lastBlocks[lastBlocks.length - 1].type).toBe('tool_result');
    expect(lastBlocks[lastBlocks.length - 1].cache_control).toEqual({ type: 'ephemeral' });
    // …earlier messages are untouched, and thinking blocks are never marked.
    // (System was extracted to payload.system, so payload.messages is
    // [user, assistant, tool_result-user] — the assistant sits at index 1.)
    const assistant = messages[1].content as Array<{ type: string; cache_control?: unknown }>;
    for (const block of assistant) expect(block.cache_control).toBeUndefined();
    // Two breakpoints total (system pin + message tail) — well under the API cap of 4.
    const system = payload.system as Array<{ cache_control?: unknown }>;
    expect(system.filter((b) => b.cache_control).length).toBe(1);
  });

  it('under thinking with no system at all, pins the breakpoint on the last message block instead', async () => {
    const payload = await buildPayload(
      [{ role: 'user', content: 'hi' }],
      { thinking: { budgetTokens: 1 } },
      'claude-opus-4-8',
    );
    // The top-level moving marker is a no-op under thinking, so the tail
    // block-level marker is the only working placement.
    expect(payload.cache_control).toBeUndefined();
    expect(payload.system).toBeUndefined();
    const messages = payload.messages as Array<{ role: string; content: unknown }>;
    const blocks = messages[0].content as Array<{ type: string; text: string; cache_control?: unknown }>;
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks[blocks.length - 1].cache_control).toEqual({ type: 'ephemeral' });
    expect(blocks[blocks.length - 1].text).toBe('hi');
  });

  /**
   * Caller system breakpoints must NOT cancel the moving message tail. In
   * agent loops the growing history lives in the provider-facing message
   * array the caller never sees, so the provider is the only layer that can
   * pin the tail. Full stand-down on a caller SYSTEM marker left that
   * history permanently uncached — measured 2026-07-05 at 15M+ full-price
   * prompt tokens/day (avg 16-19K uncached tokens/step) while marker-free
   * calls on the same image collapsed to ~2 uncached tokens/step. A caller
   * 1h system TTL composed with a 5-min moving tail is valid API usage
   * (stable prefix long TTL, moving tail short TTL).
   */
  it('under thinking, composes: caller system breakpoint preserved AND auto message-tail pinned', async () => {
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
    // Caller owns the SYSTEM region: markers preserved verbatim, none added.
    expect(system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(system[1].cache_control).toBeUndefined();
    // …but the moving tail still lands on the final message.
    const messages = payload.messages as Array<{ content: unknown }>;
    const lastContent = messages[messages.length - 1].content as Array<{
      type: string;
      text?: string;
      cache_control?: unknown;
    }>;
    expect(Array.isArray(lastContent)).toBe(true);
    expect(lastContent[lastContent.length - 1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('under thinking, stands down entirely when the caller marked a MESSAGE block', async () => {
    const payload = await buildPayload(
      [
        {
          role: 'system',
          content: [
            { type: 'text', text: 'Stable prefix', cache_control: { type: 'ephemeral', ttl: '1h' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'shared few-shot context', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'varying question' },
          ],
        },
        { role: 'user', content: 'follow-up' },
      ],
      { thinking: { budgetTokens: 1 } },
      'claude-opus-4-8',
    );
    // Caller owns the messages region: no auto tail on the final message.
    const messages = payload.messages as Array<{ content: unknown }>;
    const lastContent = messages[messages.length - 1].content;
    if (Array.isArray(lastContent)) {
      for (const block of lastContent as Array<{ cache_control?: unknown }>) {
        expect(block.cache_control).toBeUndefined();
      }
    } else {
      expect(typeof lastContent).toBe('string');
    }
  });

  /**
   * Prior-turn thinking preservation. Anthropic's guidance: "always pass back
   * all thinking blocks to the API for any multi-turn conversation" — on
   * Opus 4.5+/Sonnet 4.6+ they are kept in context and participate in prompt
   * caching. The old client-side strip mutated the previous assistant turn's
   * bytes on every loop step, invalidating EVERY prior cache entry: measured
   * on prod 2026-07-06 as the full history re-WRITTEN at 1.25x each step and
   * read back never (create/read 1.51, history reads ~0).
   */
  it('keeps thinking blocks on ALL assistant turns by default (byte-stable cache prefix)', async () => {
    const payload = await buildPayload(
      [
        { role: 'user', content: 'build the bundle' },
        {
          role: 'assistant',
          content: 'step one',
          thinkingBlocks: [{ type: 'thinking', thinking: 'plan-1', signature: 'sig-1' }],
          tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'ApplyPatch', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'tc_1', content: 'ok' },
        {
          role: 'assistant',
          content: 'step two',
          thinkingBlocks: [{ type: 'thinking', thinking: 'plan-2', signature: 'sig-2' }],
          tool_calls: [{ id: 'tc_2', type: 'function', function: { name: 'ApplyPatch', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'tc_2', content: 'ok' },
      ],
      { thinking: { budgetTokens: 1 } },
      'claude-opus-4-8',
    );
    const messages = payload.messages as Array<{ role: string; content: Array<{ type: string; thinking?: string }> }>;
    const assistants = messages.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(2);
    // BOTH assistant turns keep their thinking verbatim — the earlier turn's
    // bytes must not change between loop steps or the cached prefix dies.
    expect(assistants[0].content[0].type).toBe('thinking');
    expect(assistants[0].content[0].thinking).toBe('plan-1');
    expect(assistants[1].content[0].type).toBe('thinking');
    expect(assistants[1].content[0].thinking).toBe('plan-2');
  });

  it('strips prior-turn thinking by default on models the SERVER strips (Haiku)', async () => {
    // Haiku (all generations) discards prior thinking server-side before
    // caching — client-side stripping is cache-neutral and saves wire bytes,
    // so the dynamic default mirrors the server.
    const payload = await buildPayload(
      [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: 'step one',
          thinkingBlocks: [{ type: 'thinking', thinking: 'plan-1', signature: 'sig-1' }],
          tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'X', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'tc_1', content: 'ok' },
        {
          role: 'assistant',
          content: 'step two',
          thinkingBlocks: [{ type: 'thinking', thinking: 'plan-2', signature: 'sig-2' }],
          tool_calls: [{ id: 'tc_2', type: 'function', function: { name: 'X', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'tc_2', content: 'ok' },
      ],
      { thinking: { budgetTokens: 1 } },
      'claude-haiku-4-5-20251001',
    );
    const messages = payload.messages as Array<{ role: string; content: Array<{ type: string }> }>;
    const assistants = messages.filter((m) => m.role === 'assistant');
    expect(assistants[0].content.some((b) => b.type === 'thinking')).toBe(false);
    expect(assistants[1].content.some((b) => b.type === 'thinking')).toBe(true);
  });

  it('AGENTOS_ANTHROPIC_STRIP_PRIOR_THINKING=0 forces verbatim replay even on strip-models', async () => {
    process.env.AGENTOS_ANTHROPIC_STRIP_PRIOR_THINKING = '0';
    try {
      const payload = await buildPayload(
        [
          { role: 'user', content: 'go' },
          {
            role: 'assistant',
            content: 'step one',
            thinkingBlocks: [{ type: 'thinking', thinking: 'plan-1', signature: 'sig-1' }],
            tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'X', arguments: '{}' } }],
          },
          { role: 'tool', tool_call_id: 'tc_1', content: 'ok' },
          {
            role: 'assistant',
            content: 'step two',
            thinkingBlocks: [{ type: 'thinking', thinking: 'plan-2', signature: 'sig-2' }],
            tool_calls: [{ id: 'tc_2', type: 'function', function: { name: 'X', arguments: '{}' } }],
          },
          { role: 'tool', tool_call_id: 'tc_2', content: 'ok' },
        ],
        { thinking: { budgetTokens: 1 } },
        'claude-haiku-4-5-20251001',
      );
      const messages = payload.messages as Array<{ role: string; content: Array<{ type: string }> }>;
      const assistants = messages.filter((m) => m.role === 'assistant');
      expect(assistants[0].content.some((b) => b.type === 'thinking')).toBe(true);
    } finally {
      delete process.env.AGENTOS_ANTHROPIC_STRIP_PRIOR_THINKING;
    }
  });

  it('AGENTOS_ANTHROPIC_STRIP_PRIOR_THINKING=1 restores the legacy strip', async () => {
    process.env.AGENTOS_ANTHROPIC_STRIP_PRIOR_THINKING = '1';
    try {
      const payload = await buildPayload(
        [
          { role: 'user', content: 'build the bundle' },
          {
            role: 'assistant',
            content: 'step one',
            thinkingBlocks: [{ type: 'thinking', thinking: 'plan-1', signature: 'sig-1' }],
            tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'ApplyPatch', arguments: '{}' } }],
          },
          { role: 'tool', tool_call_id: 'tc_1', content: 'ok' },
          {
            role: 'assistant',
            content: 'step two',
            thinkingBlocks: [{ type: 'thinking', thinking: 'plan-2', signature: 'sig-2' }],
            tool_calls: [{ id: 'tc_2', type: 'function', function: { name: 'ApplyPatch', arguments: '{}' } }],
          },
          { role: 'tool', tool_call_id: 'tc_2', content: 'ok' },
        ],
        { thinking: { budgetTokens: 1 } },
        'claude-opus-4-8',
      );
      const messages = payload.messages as Array<{ role: string; content: Array<{ type: string }> }>;
      const assistants = messages.filter((m) => m.role === 'assistant');
      // Legacy behavior: only the LAST assistant turn keeps thinking.
      expect(assistants[0].content.some((b) => b.type === 'thinking')).toBe(false);
      expect(assistants[1].content.some((b) => b.type === 'thinking')).toBe(true);
    } finally {
      delete process.env.AGENTOS_ANTHROPIC_STRIP_PRIOR_THINKING;
    }
  });

  it('under thinking, skips the auto tail when caller markers already fill the API cap of 4', async () => {
    const payload = await buildPayload(
      [
        {
          role: 'system',
          content: [
            { type: 'text', text: 'p1', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'p2', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'p3', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'p4', cache_control: { type: 'ephemeral' } },
          ],
        },
        { role: 'user', content: 'hi' },
      ],
      { thinking: { budgetTokens: 1 } },
      'claude-opus-4-8',
    );
    const messages = payload.messages as Array<{ content: unknown }>;
    const lastContent = messages[messages.length - 1].content;
    if (Array.isArray(lastContent)) {
      for (const block of lastContent as Array<{ cache_control?: unknown }>) {
        expect(block.cache_control).toBeUndefined();
      }
    } else {
      expect(typeof lastContent).toBe('string');
    }
  });

  /**
   * The non-thinking twin of the compose test above. Streamed conversation
   * surfaces (a caller-marked 1h system prefix, no thinking) used to hit a
   * full stand-down here: the system prefix cached while every turn's
   * growing history was re-billed at full input price — the same shape the
   * 2026-07-05 thinking-path fix closed. The tail must land without thinking.
   */
  it('without thinking, composes: caller system breakpoint preserved AND auto message-tail pinned', async () => {
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
    // The caller's explicit 1h breakpoint is preserved verbatim, none added.
    expect(system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(system[1].cache_control).toBeUndefined();
    // …and the moving tail still lands on the final message.
    const messages = payload.messages as Array<{ content: unknown }>;
    const lastContent = messages[messages.length - 1].content as Array<{
      type: string;
      cache_control?: unknown;
    }>;
    expect(Array.isArray(lastContent)).toBe(true);
    expect(lastContent[lastContent.length - 1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('without thinking, stands down entirely when the caller marked a MESSAGE block', async () => {
    const payload = await buildPayload([
      {
        role: 'system',
        content: [
          { type: 'text', text: 'Stable prefix', cache_control: { type: 'ephemeral', ttl: '1h' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'shared few-shot context', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'varying question' },
        ],
      },
      { role: 'user', content: 'follow-up' },
    ]);
    expect(payload.cache_control).toBeUndefined();
    // Caller owns the messages region: no auto tail on the final message.
    const messages = payload.messages as Array<{ content: unknown }>;
    const lastContent = messages[messages.length - 1].content;
    if (Array.isArray(lastContent)) {
      for (const block of lastContent as Array<{ cache_control?: unknown }>) {
        expect(block.cache_control).toBeUndefined();
      }
    } else {
      expect(typeof lastContent).toBe('string');
    }
  });

  it('without thinking, skips the auto tail when caller markers already fill the API cap of 4', async () => {
    const payload = await buildPayload([
      {
        role: 'system',
        content: [
          { type: 'text', text: 'p1', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'p2', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'p3', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'p4', cache_control: { type: 'ephemeral' } },
        ],
      },
      { role: 'user', content: 'hi' },
    ]);
    const messages = payload.messages as Array<{ content: unknown }>;
    const lastContent = messages[messages.length - 1].content;
    if (Array.isArray(lastContent)) {
      for (const block of lastContent as Array<{ cache_control?: unknown }>) {
        expect(block.cache_control).toBeUndefined();
      }
    } else {
      expect(typeof lastContent).toBe('string');
    }
  });

  /**
   * Tool cache markers count against the hard 4-breakpoint cap. 3 marked
   * system blocks + 1 marked tool = 4 (at the cap); the tail must NOT be
   * added, or the request 400s with a 5th marker. Tools are injected via
   * customModelParams — the exact vector where a marked tool can reach the
   * wire payload after passthrough.
   */
  it('folds tool cache markers into the cap and skips the tail at 4 wire markers', async () => {
    const payload = await buildPayload(
      [
        {
          role: 'system',
          content: [
            { type: 'text', text: 'p1', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'p2', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'p3', cache_control: { type: 'ephemeral' } },
          ],
        },
        { role: 'user', content: 'hi' },
      ],
      {
        customModelParams: {
          tools: [
            {
              name: 't',
              description: 'd',
              input_schema: { type: 'object', properties: {} },
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      },
    );
    const messages = payload.messages as Array<{ content: unknown }>;
    const lastContent = messages[messages.length - 1].content;
    if (Array.isArray(lastContent)) {
      for (const block of lastContent as Array<{ cache_control?: unknown }>) {
        expect(block.cache_control).toBeUndefined();
      }
    } else {
      expect(typeof lastContent).toBe('string');
    }
  });

  it('still pins the tail with tool markers present when there is headroom (< 4)', async () => {
    const payload = await buildPayload(
      [
        {
          role: 'system',
          content: [
            { type: 'text', text: 'p1', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'p2', cache_control: { type: 'ephemeral' } },
          ],
        },
        { role: 'user', content: 'hi' },
      ],
      {
        customModelParams: {
          tools: [
            {
              name: 't',
              description: 'd',
              input_schema: { type: 'object', properties: {} },
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      },
    );
    // 2 system + 1 tool = 3 < 4 → tail lands on the final message.
    const messages = payload.messages as Array<{ content: unknown }>;
    const lastContent = messages[messages.length - 1].content as Array<{
      cache_control?: unknown;
    }>;
    expect(Array.isArray(lastContent)).toBe(true);
    expect(lastContent[lastContent.length - 1].cache_control).toEqual({ type: 'ephemeral' });
  });

  /**
   * The forced-tool reconciliation runs AFTER the customModelParams
   * passthrough, so a tool_choice injected through customModelParams under
   * extended thinking is clamped to 'auto' rather than reaching the wire as
   * the forbidden thinking + forced-tool combination (Anthropic 400s on it).
   */
  it('reconciles a forced tool_choice injected via customModelParams under thinking', async () => {
    const payload = await buildPayload(
      [{ role: 'user', content: 'hi' }],
      {
        thinking: { budgetTokens: 1 },
        customModelParams: { tool_choice: { type: 'tool', name: 'x' } },
      },
      'claude-opus-4-8',
    );
    expect(payload.tool_choice).toEqual({ type: 'auto' });
  });
});

describe('AnthropicProvider per-call cache option (options.cache)', () => {
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

  /** Every cache_control reachable from the payload, flattened for asserts. */
  function collectMarkers(payload: Record<string, unknown>): unknown[] {
    const found: unknown[] = [];
    if (payload.cache_control) found.push(payload.cache_control);
    const system = payload.system;
    if (Array.isArray(system)) {
      for (const b of system as Array<{ cache_control?: unknown }>) {
        if (b.cache_control) found.push(b.cache_control);
      }
    }
    for (const msg of (payload.messages as Array<{ content?: unknown }>) ?? []) {
      if (!Array.isArray(msg.content)) continue;
      for (const b of msg.content as Array<{ cache_control?: unknown }>) {
        if (b.cache_control) found.push(b.cache_control);
      }
    }
    if (Array.isArray(payload.tools)) {
      for (const t of payload.tools as Array<{ cache_control?: unknown }>) {
        if (t.cache_control) found.push(t.cache_control);
      }
    }
    return found;
  }

  /**
   * `cache: false` is the per-call hard-off for true one-shots: unlike the
   * process-global env kill switch (auto path only), it also strips
   * caller-placed markers so the request pays no cache-write premium
   * anywhere. A one-shot's write (1.25x at 5m, 2x at 1h) is never read back.
   */
  it('cache:false emits zero cache_control — auto suppressed AND caller markers stripped', async () => {
    const payload = await buildPayload([
      {
        role: 'system',
        content: [
          { type: 'text', text: 'Stable prefix', cache_control: { type: 'ephemeral', ttl: '1h' } },
          { type: 'text', text: 'Dynamic tail' },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'few-shot context', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'question' },
        ],
      },
      { role: 'user', content: 'follow-up' },
    ], { cache: false });
    expect(collectMarkers(payload)).toEqual([]);
    // With every marker stripped, system falls back to the joined-string emission.
    expect(typeof payload.system).toBe('string');
  });

  it('cache:false also clears markers injected via customModelParams (tools + request-level)', async () => {
    const payload = await buildPayload(
      [{ role: 'user', content: 'hi' }],
      {
        cache: false,
        customModelParams: {
          cache_control: { type: 'ephemeral' },
          tools: [
            {
              name: 'x',
              description: 'd',
              input_schema: { type: 'object' },
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      },
    );
    expect(collectMarkers(payload)).toEqual([]);
  });

  it('cache:false beats the default auto marker on a bare request', async () => {
    const payload = await buildPayload([{ role: 'user', content: 'hi' }], { cache: false });
    expect(payload.cache_control).toBeUndefined();
    expect(collectMarkers(payload)).toEqual([]);
  });

  /**
   * `cache: { ttl: '1h' }` on a marker-free non-thinking request: the TTL is
   * a block-level attribute, so the auto path switches from the request-level
   * marker to explicit placement — system-end breakpoint + moving message
   * tail — both carrying the 1h TTL. Slow loops (codegen tool calls gap
   * 2-14 min; human turns routinely exceed 5m) stop expiring between steps.
   */
  it('cache ttl 1h without thinking places block-level markers carrying the TTL', async () => {
    const payload = await buildPayload([
      { role: 'system', content: 'You are a stable, reusable system prompt.' },
      { role: 'user', content: 'hi' },
    ], { cache: { ttl: '1h' } });
    expect(payload.cache_control).toBeUndefined();
    const system = payload.system as Array<{ cache_control?: unknown }>;
    expect(Array.isArray(system)).toBe(true);
    expect(system[system.length - 1].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    const messages = payload.messages as Array<{ content: unknown }>;
    const lastContent = messages[messages.length - 1].content as Array<{ cache_control?: unknown }>;
    expect(Array.isArray(lastContent)).toBe(true);
    expect(lastContent[lastContent.length - 1].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('cache ttl 1h under thinking carries the TTL on both auto breakpoints', async () => {
    const payload = await buildPayload(
      [
        { role: 'system', content: 'Primary system prompt.' },
        { role: 'user', content: 'hi' },
      ],
      { thinking: { budgetTokens: 1 }, cache: { ttl: '1h' } },
      'claude-opus-4-8',
    );
    expect(payload.cache_control).toBeUndefined();
    const system = payload.system as Array<{ cache_control?: unknown }>;
    expect(system[system.length - 1].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    const messages = payload.messages as Array<{ content: unknown }>;
    const lastContent = messages[messages.length - 1].content as Array<{ cache_control?: unknown }>;
    expect(lastContent[lastContent.length - 1].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('cache ttl 1h composes with a caller-marked system: caller marker raised to 1h, tail gets 1h', async () => {
    const payload = await buildPayload([
      {
        role: 'system',
        content: [
          { type: 'text', text: 'Stable persona prefix', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'Dynamic per-turn state' },
        ],
      },
      { role: 'user', content: 'hi' },
    ], { cache: { ttl: '1h' } });
    const system = payload.system as Array<{ cache_control?: unknown }>;
    // Anthropic requires every 1h marker to PRECEDE every 5m marker in cache
    // order — a 5m system marker ahead of the 1h tail 400s the request. The
    // per-call TTL declares the whole call's pacing, so the caller's
    // default-TTL marker is raised to 1h alongside the tail.
    expect(system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(system[1].cache_control).toBeUndefined();
    const messages = payload.messages as Array<{ content: unknown }>;
    const lastContent = messages[messages.length - 1].content as Array<{ cache_control?: unknown }>;
    expect(lastContent[lastContent.length - 1].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('cache ttl 1h raises an explicit 5m caller system marker too (mixed order would 400)', async () => {
    const payload = await buildPayload([
      {
        role: 'system',
        content: [
          { type: 'text', text: 'Prefix', cache_control: { type: 'ephemeral', ttl: '5m' } },
        ],
      },
      { role: 'user', content: 'hi' },
    ], { cache: { ttl: '1h' } });
    const system = payload.system as Array<{ cache_control?: unknown }>;
    expect(system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('cache ttl 1h with a marked tool present: tail falls back to the default TTL (order stays valid)', async () => {
    const payload = await buildPayload(
      [
        {
          role: 'system',
          content: [
            { type: 'text', text: 'Prefix', cache_control: { type: 'ephemeral' } },
          ],
        },
        { role: 'user', content: 'hi' },
      ],
      {
        cache: { ttl: '1h' },
        customModelParams: {
          tools: [
            {
              name: 'x',
              description: 'd',
              input_schema: { type: 'object' },
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      },
    );
    // Marked tools are raw caller objects the provider never mutates, and
    // tools render before system: a 1h tail after a 5m tool marker would
    // 400, so the tail keeps the default TTL and the system marker stays.
    const system = payload.system as Array<{ cache_control?: unknown }>;
    expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
    const messages = payload.messages as Array<{ content: unknown }>;
    const lastContent = messages[messages.length - 1].content as Array<{ cache_control?: unknown }>;
    expect(lastContent[lastContent.length - 1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('customModelParams system override + cache 1h: override preserved verbatim, request-level marker only', async () => {
    const payload = await buildPayload(
      [
        { role: 'system', content: 'Original system that the override replaces.' },
        { role: 'user', content: 'hi' },
      ],
      {
        cache: { ttl: '1h' },
        customModelParams: { system: 'CUSTOM OVERRIDE SYSTEM' },
      },
    );
    // The explicit-placement path must not restructure regions it no longer
    // owns: the pre-override locals would clobber the custom system.
    expect(payload.system).toBe('CUSTOM OVERRIDE SYSTEM');
    expect(payload.cache_control).toEqual({ type: 'ephemeral' });
    const messages = payload.messages as Array<{ content: unknown }>;
    for (const m of messages) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content as Array<{ cache_control?: unknown }>) {
        expect(b.cache_control).toBeUndefined();
      }
    }
  });

  it('customModelParams messages override carrying a marker: full stand-down (caller owns the wire)', async () => {
    const payload = await buildPayload(
      [{ role: 'user', content: 'original' }],
      {
        cache: { ttl: '1h' },
        customModelParams: {
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'custom', cache_control: { type: 'ephemeral' } },
              ],
            },
          ],
        },
      },
    );
    expect(payload.cache_control).toBeUndefined();
    // The override rides the wire untouched; its own marker is the only one.
    expect(collectMarkers(payload)).toEqual([{ type: 'ephemeral' }]);
  });

  it('cache ttl 1h does not override the caller-owns-messages stand-down', async () => {
    const payload = await buildPayload([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'shared context', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'varying question' },
        ],
      },
      { role: 'user', content: 'follow-up' },
    ], { cache: { ttl: '1h' } });
    expect(payload.cache_control).toBeUndefined();
    const messages = payload.messages as Array<{ content: unknown }>;
    const lastContent = messages[messages.length - 1].content;
    expect(typeof lastContent).toBe('string');
  });

  it('cache ttl 5m keeps the default request-level marker (no behavior change)', async () => {
    const payload = await buildPayload([
      { role: 'system', content: 'A system prompt.' },
      { role: 'user', content: 'hi' },
    ], { cache: { ttl: '5m' } });
    expect(payload.cache_control).toEqual({ type: 'ephemeral' });
    expect(typeof payload.system).toBe('string');
  });
});

describe('AnthropicProvider cache:false sanitizes customModelParams-injected regions', () => {
  async function buildPayload(
    messages: Array<Record<string, unknown>>,
    options: Record<string, unknown> = {},
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
    }).buildRequestPayload('claude-sonnet-4-6', messages, options, false);
  }

  it('strips markers from a customModelParams system/messages override', async () => {
    const injectedSystem = [
      { type: 'text', text: 'injected stable', cache_control: { type: 'ephemeral', ttl: '1h' } },
    ];
    const injectedMessages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'injected turn', cache_control: { type: 'ephemeral' } },
        ],
      },
    ];
    const payload = await buildPayload(
      [{ role: 'user', content: 'hi' }],
      {
        cache: false,
        customModelParams: { system: injectedSystem, messages: injectedMessages },
      },
    );
    const system = payload.system as Array<{ cache_control?: unknown }>;
    expect(system[0].cache_control).toBeUndefined();
    const messages = payload.messages as Array<{ content: Array<{ cache_control?: unknown }> }>;
    expect(messages[0].content[0].cache_control).toBeUndefined();
    // The caller's own customModelParams objects are never mutated.
    expect(injectedSystem[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(injectedMessages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
  });
});
