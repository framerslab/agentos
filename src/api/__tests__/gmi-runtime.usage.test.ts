/**
 * agent({ runtime: 'gmi' }) end to end: where a turn's usage goes. The usage
 * ledger holds a turn by the time the call returns, as it holds a generateText
 * call, and the process-wide usage observer hears every model call of a turn:
 * each step with the hop that served it, and each attempt that failed before
 * any output and was billed. Runs over the real provider manager, completion
 * gateway, GMI and session store; only the provider classes are stubbed
 * (helpers/stubProviders.ts), at their module boundary.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
vi.mock('../../core/llm/providers/implementations/AnthropicProvider', async () => ({ AnthropicProvider: (await import('./helpers/stubProviders')).stubProviderClass('anthropic') }));

/** The response bodies the next OpenRouter chat requests stream, in order, and a copy of each chat request's payload. */
const openRouter = vi.hoisted(() => ({ bodies: [] as Array<() => NodeJS.ReadableStream>, sent: [] as Array<Record<string, any>> }));
// The real OpenRouter provider over a scripted HTTP client (its initialize() would fetch the model list).
vi.mock('../../core/llm/providers/implementations/OpenRouterProvider', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../core/llm/providers/implementations/OpenRouterProvider')>();
  const { ApiKeyPool } = await import('../../core/providers/ApiKeyPool');
  class ScriptedOpenRouterProvider extends real.OpenRouterProvider {
    override async initialize(config: { apiKey: string }): Promise<void> {
      Object.assign(this as unknown as Record<string, unknown>, {
        config: { apiKey: config.apiKey, baseURL: 'https://openrouter.test/api/v1', requestTimeout: 1_000, streamRequestTimeout: 5_000 },
        keyPool: new ApiKeyPool(config.apiKey),
        client: {
          request: async ({ url, data }: { url: string; data?: unknown }) => {
            if (url === '/models') return { data: { data: [] } };
            openRouter.sent.push(JSON.parse(JSON.stringify(data ?? {})));
            const body = openRouter.bodies.shift();
            if (!body) throw new Error('openrouter: unexpected request');
            return { data: body() };
          },
        },
        isInitialized: true,
      });
    }
  }
  return { ...real, OpenRouterProvider: ScriptedOpenRouterProvider };
});
import { agent, type AgentOptions } from '../agent';
import { SpendBudget } from '../runtime/spendBudget';
import { reply, script, systemTextOf } from './helpers/stubProviders';
import { setGlobalLlmObserver, type LlmUsageEvent } from '../observers';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';
import { GMIErrorCode } from '../../core/utils/errors';

let n = 0;
const key = () => `k-usage-${++n}`;
const base = (apiKey: string, extra: Record<string, unknown> = {}) =>
  ({ runtime: 'gmi', provider: 'openai', model: 'stub-model', apiKey, fallbackProviders: [], ...extra }) as unknown as AgentOptions;
const lookup = { name: 'lookup', description: 'Look up.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, execute: async () => ({ success: true, output: 'ok' }) };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** A gate a scripted response waits on, and the function that opens it. */
function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}
const OR_MODEL = 'anthropic/claude-sonnet-5.5';
/** One OpenRouter SSE line. */
const orLine = (fields: Record<string, unknown>): string =>
  `data: ${JSON.stringify({ id: 'gen-1', object: 'chat.completion.chunk', created: 1, model: OR_MODEL, ...fields })}`;
/** An OpenRouter response body: each line in turn, a promise waited for, a function called when the lines before it are out. */
function sseBody(steps: Array<string | Promise<void> | (() => void)>): NodeJS.ReadableStream {
  return Readable.from(
    (async function* () {
      for (const step of steps) {
        if (typeof step === 'string') yield Buffer.from(`${step}\n\n`);
        else if (typeof step === 'function') step();
        else await step;
      }
    })(),
  );
}

let ledgerDir: string;
let ledgerPath: string;
let events: LlmUsageEvent[];

/** The ledger's rows as they are on disk now, oldest first. */
function ledgerRows(): Array<Record<string, unknown>> {
  return readFileSync(ledgerPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
  globalLLMProviderHealth.reset();
  openRouter.bodies.length = 0;
  openRouter.sent.length = 0;
  ledgerDir = mkdtempSync(join(tmpdir(), 'agentos-gmi-usage-'));
  ledgerPath = join(ledgerDir, 'ledger.jsonl');
  events = [];
  setGlobalLlmObserver((event) => {
    events.push(event);
  });
});

afterEach(() => {
  setGlobalLlmObserver(null);
  rmSync(ledgerDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("agent({ runtime: 'gmi' }) usage", () => {
  it('the usage ledger holds a turn by the time its call returns, so usage() read right after counts it', async () => {
    const k = key(); script('openai', k, { replies: [reply.text('Hello.'), reply.text('Streamed.')] });
    const a = agent(base(k, { usageLedger: { enabled: true, path: ledgerPath } }));
    const session = a.session('s');

    await session.send('hi');
    // Read at once, with no wait: generateText writes its row before it returns, and with the
    // ledger enabled usage() reads the ledger alone.
    expect(existsSync(ledgerPath)).toBe(true);
    expect(ledgerRows()).toMatchObject([{ sessionId: 's', source: 'agent.session.send', providerId: 'openai', modelId: 'stub-model', totalTokens: 15 }]);
    expect((await session.usage()).totalTokens).toBe(15);

    const streamed = session.stream('again');
    expect(await streamed.text).toBe('Streamed.');
    expect(ledgerRows().map((row) => row.source)).toEqual(['agent.session.send', 'agent.session.stream']);
    expect((await a.usage()).totalTokens).toBe(30);
  });

  it('the usage observer hears each model call of a turn, a tool step and the answer, under the surface the caller used', async () => {
    const k = key(); script('openai', k, { replies: [reply.tools([{ id: 'c1', name: 'lookup', args: { q: 'x' } }]), reply.text('Found.'), reply.text('Streamed.')] });
    const session = agent(base(k, { tools: [lookup] })).session('s');

    await session.send('find x');
    expect(events.map((e) => [e.provider, e.model, e.finishReason, e.usage.totalTokens, e.surface])).toEqual([
      ['openai', 'stub-model', 'tool-calls', 14, 'generateText'],
      ['openai', 'stub-model', 'stop', 15, 'generateText'],
    ]);

    events.length = 0;
    expect(await session.stream('again').text).toBe('Streamed.');
    expect(events.map((e) => [e.finishReason, e.usage.totalTokens, e.surface])).toEqual([['stop', 15, 'streamText']]);
  });

  it("each model call of a turn carries the account the agent's budget names, on send and stream; with none the field is absent", async () => {
    const k = key(); script('openai', k, { replies: [reply.tools([{ id: 'c1', name: 'lookup', args: { q: 'x' } }]), reply.text('Found.'), reply.text('Streamed.'), reply.text('Plain.')] });
    const session = agent(base(k, { tools: [lookup], budget: { maxCostUSD: 100, unpriced: 'allow', accountId: 'acct-1' } })).session('s');

    await session.send('find x');
    expect(await session.stream('again').text).toBe('Streamed.');
    expect(events.map((e) => [e.finishReason, e.accountId])).toEqual([
      ['tool-calls', 'acct-1'],
      ['stop', 'acct-1'],
      ['stop', 'acct-1'],
    ]);

    events.length = 0;
    await session.send('once more', { budget: { maxCostUSD: 100, unpriced: 'allow' } });
    expect(events).toHaveLength(1);
    expect(events[0]).not.toHaveProperty('accountId');
  });

  it("accountIdOf names a turn's account: the agent's, a generate() or stream() call's in its place, and a budget's account wins", async () => {
    const k = key(); script('openai', k, { replies: [reply.text('One.'), reply.text('Two.'), reply.text('Three.'), reply.text('Four.')] });
    const a = agent(base(k, { accountIdOf: () => 'acct-agent' }));

    await a.session('s').send('hi');
    await a.generate('hi', { accountIdOf: () => 'acct-call' });
    expect(await a.stream('hi', { accountIdOf: () => 'acct-stream' }).text).toBe('Three.');
    await a.generate('hi', { budget: { maxCostUSD: 100, unpriced: 'allow', accountId: 'acct-budget' } });
    expect(events.map((e) => e.accountId)).toEqual(['acct-agent', 'acct-call', 'acct-stream', 'acct-budget']);
  });

  it('an attempt that failed before any output and was billed is metered once, beside the hop that answered', async () => {
    const k = key(); const fb = key();
    const billedFailure = Object.assign(new Error('overloaded'), { httpStatus: 529, details: { usage: { promptTokens: 12, completionTokens: 4, totalTokens: 16 } } });
    script('anthropic', k, { replies: [billedFailure] });
    script('openai', fb, { replies: [reply.text('Recovered.')] });
    vi.stubEnv('OPENAI_API_KEY', fb);
    const a = agent({ ...base(k), provider: 'anthropic', model: 'claude-x', fallbackProviders: [{ provider: 'openai', model: 'stub-model' }], usageLedger: { enabled: true, path: ledgerPath } });

    const r = await a.session('s').send('hi');
    expect(r).toMatchObject({ text: 'Recovered.', provider: 'openai', usage: { promptTokens: 24, completionTokens: 7, totalTokens: 31 } });
    expect(events.map((e) => [e.provider, e.model, e.finishReason, e.usage.totalTokens, e.fallbackDepth])).toEqual([
      ['anthropic', 'claude-x', 'error', 16, undefined],
      ['openai', 'stub-model', 'stop', 15, 1],
    ]);
    expect(ledgerRows().map((row) => [row.providerId, row.totalTokens]).sort()).toEqual([['anthropic', 16], ['openai', 15]]);
    expect((await a.usage('s')).totalTokens).toBe(31);
  });

  it("a billed failed attempt and the hop that answered both carry the account", async () => {
    const k = key(); const fb = key();
    const billedFailure = Object.assign(new Error('overloaded'), { httpStatus: 529, details: { usage: { promptTokens: 12, completionTokens: 4, totalTokens: 16 } } });
    script('anthropic', k, { replies: [billedFailure] });
    script('openai', fb, { replies: [reply.text('Recovered.')] });
    vi.stubEnv('OPENAI_API_KEY', fb);
    const a = agent({ ...base(k), provider: 'anthropic', model: 'claude-x', fallbackProviders: [{ provider: 'openai', model: 'stub-model' }], accountIdOf: () => 'acct-1' });

    await a.session('s').send('hi');
    expect(events.map((e) => [e.provider, e.finishReason, e.accountId])).toEqual([
      ['anthropic', 'error', 'acct-1'],
      ['openai', 'stop', 'acct-1'],
    ]);
  });

  it("a model call that close() stopped keeps its bill: the usage OpenRouter reports after close() returned is metered and counted", async () => {
    // OpenRouter streams text, then ends the answer on a content_filter finish, which it holds
    // while it waits for the usage-only line; close() runs 50 ms after the finish, and the
    // usage line arrives once close() has returned.
    const finishSent = gate(); const usageLine = gate();
    openRouter.bodies.push(() =>
      sseBody([
        orLine({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Partial answer' }, finish_reason: null }] }),
        orLine({ choices: [{ index: 0, delta: { content: '' }, finish_reason: 'content_filter' }] }),
        finishSent.open,
        usageLine.opened,
        orLine({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } }),
        'data: [DONE]',
      ]),
    );
    const a = agent({ runtime: 'gmi', provider: 'openrouter', model: OR_MODEL, apiKey: key(), fallbackProviders: [], accountIdOf: () => 'acct-late' } as unknown as AgentOptions);
    const session = a.session('s');
    try {
      const outcome = session.send('hi').then(() => 'resolved', (error: unknown) => error);
      await finishSent.opened;
      await sleep(50);
      await session.close();
      expect(await outcome).toMatchObject({ code: GMIErrorCode.LLM_PROVIDER_ERROR, message: expect.stringMatching(/abort/i) });
      expect(events).toEqual([]);

      usageLine.open();
      // Read from the stream the abort left behind: one failed call, metered and counted.
      await vi.waitFor(() =>
        expect(events.map((e) => [e.provider, e.model, e.finishReason, e.usage.promptTokens, e.usage.completionTokens])).toEqual([['openrouter', OR_MODEL, 'error', 12, 4]]),
      );
      expect(events[0]).toMatchObject({ accountId: 'acct-late' });
      expect(await session.usage()).toMatchObject({ promptTokens: 12, completionTokens: 4, totalTokens: 16 });
      expect(await a.usage()).toMatchObject({ promptTokens: 12, completionTokens: 4, totalTokens: 16 });
    } finally {
      usageLine.open();
    }
  });

  it('a model call close() stopped after a normal finish keeps its bill: the usage line OpenRouter sends after close() returned is metered and counted', async () => {
    // OpenRouter streams text and ends the answer on a 'stop' finish; close() runs 50 ms after
    // the finish, before the usage-only line, which arrives once close() has returned.
    const finishSent = gate(); const usageLine = gate();
    openRouter.bodies.push(() =>
      sseBody([
        orLine({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Partial answer' }, finish_reason: null }] }),
        orLine({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        finishSent.open,
        usageLine.opened,
        orLine({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } }),
        'data: [DONE]',
      ]),
    );
    const a = agent({ runtime: 'gmi', provider: 'openrouter', model: OR_MODEL, apiKey: key(), fallbackProviders: [] } as unknown as AgentOptions);
    const session = a.session('s');
    try {
      const outcome = session.send('hi').then(() => 'resolved', (error: unknown) => error);
      await finishSent.opened;
      await sleep(50);
      await session.close();
      expect(await outcome).toMatchObject({ code: GMIErrorCode.LLM_PROVIDER_ERROR, message: expect.stringMatching(/abort/i) });
      expect(events).toEqual([]);

      usageLine.open();
      await vi.waitFor(() =>
        expect(events.map((e) => [e.provider, e.model, e.finishReason, e.usage.promptTokens, e.usage.completionTokens])).toEqual([['openrouter', OR_MODEL, 'error', 12, 4]]),
      );
      expect(await session.usage()).toMatchObject({ promptTokens: 12, completionTokens: 4, totalTokens: 16 });
      expect(await a.usage()).toMatchObject({ promptTokens: 12, completionTokens: 4, totalTokens: 16 });
    } finally {
      usageLine.open();
    }
  });

  it('a model call close() stopped after it reported usage is counted once: the late report adds only what it reports beyond that', async () => {
    // OpenRouter's finish line reports 12 tokens; close() runs before the usage-only line, which
    // reports the request's running total, 16, once close() has returned.
    const finishSent = gate(); const usageLine = gate();
    openRouter.bodies.push(() =>
      sseBody([
        orLine({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Partial answer' }, finish_reason: null }] }),
        orLine({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }),
        finishSent.open,
        usageLine.opened,
        orLine({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } }),
        'data: [DONE]',
      ]),
    );
    const a = agent({ runtime: 'gmi', provider: 'openrouter', model: OR_MODEL, apiKey: key(), fallbackProviders: [] } as unknown as AgentOptions);
    const session = a.session('s');
    const bills = () => events.map((e) => [e.finishReason, e.usage.promptTokens, e.usage.completionTokens, e.usage.totalTokens]);
    try {
      const outcome = session.send('hi').then(() => 'resolved', (error: unknown) => error);
      await finishSent.opened;
      await sleep(50);
      await session.close();
      expect(await outcome).toMatchObject({ code: GMIErrorCode.LLM_PROVIDER_ERROR, message: expect.stringMatching(/abort/i) });
      // The stopped call's bill as its finish line reported it.
      expect(bills()).toEqual([['error', 10, 2, 12]]);
      expect(await session.usage()).toMatchObject({ promptTokens: 10, completionTokens: 2, totalTokens: 12 });

      usageLine.open();
      // Only the part of the 16 beyond the 12 already counted is added: 16 in all, not 28.
      await vi.waitFor(() => expect(bills()).toEqual([['error', 10, 2, 12], ['error', 2, 2, 4]]));
      expect(await session.usage()).toMatchObject({ promptTokens: 12, completionTokens: 4, totalTokens: 16 });
      expect(await a.usage()).toMatchObject({ promptTokens: 12, completionTokens: 4, totalTokens: 16 });
    } finally {
      usageLine.open();
    }
  });

  it("a model call close() stopped is charged to the agent's budget as billed, and its late report adds what it reports beyond that", async () => {
    // The script of the case above: 12 tokens on the finish line before close(), 16 in all on the usage line after it.
    const finishSent = gate(); const usageLine = gate();
    openRouter.bodies.push(() =>
      sseBody([
        orLine({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Partial answer' }, finish_reason: null }] }),
        orLine({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }),
        finishSent.open,
        usageLine.opened,
        orLine({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } }),
        'data: [DONE]',
      ]),
    );
    const budget = new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 100_000, unpriced: 'allow' });
    const a = agent({ runtime: 'gmi', provider: 'openrouter', model: OR_MODEL, apiKey: key(), fallbackProviders: [], budget } as unknown as AgentOptions);
    const session = a.session('s');
    try {
      const outcome = session.send('hi').then(() => 'resolved', (error: unknown) => error);
      await finishSent.opened;
      await sleep(50);
      await session.close();
      expect(await outcome).toMatchObject({ code: GMIErrorCode.LLM_PROVIDER_ERROR });
      // The stopped call's bill after its content, charged in the turn.
      expect(budget.tokensUsed()).toBe(12);
      usageLine.open();
      // The late report, charged once it arrives: 4 more, 16 in all.
      await vi.waitFor(() => expect(budget.tokensUsed()).toBe(16));
    } finally {
      usageLine.open();
    }
  });

  it('keeps cache counts across a tool step and the final answer', async () => {
    const usage = { promptTokens: 12, completionTokens: 3, totalTokens: 15,
      cacheReadInputTokens: 20, cacheCreationInputTokens: 30, cacheCreationExtendedInputTokens: 5, inclusiveInputTokens: 62 };
    const tool = reply.tools([{ id: 'cache-tool', name: 'lookup', args: { q: 'x' } }]);
    (tool.at(-1) as any).usage = usage;
    const k = key(); script('openai', k, { replies: [tool, reply.text('Found.', 'stub-model', usage)] });
    const a = agent(base(k, { tools: [lookup] }));
    try {
      const result = await a.session('cache-usage').send('Find x.');
      expect(result.usage).toMatchObject({ cacheReadTokens: 40, cacheCreationTokens: 60,
        cacheCreationExtendedTokens: 10, inclusiveInputTokens: 124 });
    } finally { await a.close(); }
  });

  it('keeps an OpenAI GMI system as one string and onBeforeGeneration system as the joined base', async () => {
    const k = key(); const s = script('openai', k, { replies: [reply.text('Hello.')] });
    let baseSystem: unknown;
    const a = agent(base(k, { systemBlocks: [{ text: 'Policy' }],
      onBeforeGeneration: (context: any) => { baseSystem = context.system; },
    }));
    try {
      const result = await a.generate('Hello.');
      const system = s.seen[0].messages.filter((message) => message.role === 'system');
      expect(system).toEqual([{ role: 'system', content: 'Policy' }]);
      expect(systemTextOf(s.seen[0].messages)).toBe('Policy');
      expect(baseSystem).toBe('Policy');
      expect(result.usage).not.toHaveProperty('cacheReadTokens');
      expect(result.usage).not.toHaveProperty('cacheCreationTokens');
      expect(result.usage).not.toHaveProperty('cacheCreationExtendedTokens');
    } finally { await a.close(); }
  });

  it('rebuilds the split as one system string on an OpenAI fallback hop', async () => {
    const k = key(); const fallbackKey = key();
    const primary = script('anthropic', k, { replies: [Object.assign(new Error('overloaded'), { httpStatus: 529 })] });
    const fallback = script('openai', fallbackKey, { replies: [reply.text('Recovered.')] });
    vi.stubEnv('OPENAI_API_KEY', fallbackKey);
    const a = agent({ ...base(k), provider: 'anthropic', model: 'claude-sonnet-4-6',
      systemBlocks: [{ text: 'Policy', cacheBreakpoint: true }, { text: 'Clock' }],
      fallbackProviders: [{ provider: 'openai', model: 'stub-model' }],
    });
    try {
      await a.generate('Hi.');
      expect(primary.seen[0].messages.filter((message) => message.role === 'system')).toHaveLength(2);
      expect(fallback.seen[0].messages.filter((message) => message.role === 'system')).toEqual([{ role: 'system', content: 'Policy\n\nClock' }]);
      expect(systemTextOf(primary.seen[0].messages)).toBe(systemTextOf(fallback.seen[0].messages));
    } finally { await a.close(); }
  });

  // A fallback entry's own `cache` replaces the turn's on its hop (the gateway sends the hop with it), so the hop's
  // prompt is built for that setting, not for the turn's.
  it("sends one system string to an OpenRouter Claude fallback hop whose entry sets cache false", async () => {
    const k = key();
    script('openai', k, { replies: [Object.assign(new Error('overloaded'), { httpStatus: 529 })] });
    vi.stubEnv('OPENROUTER_API_KEY', key());
    openRouter.bodies.push(() =>
      sseBody([
        orLine({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Recovered.' }, finish_reason: null }] }),
        orLine({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        orLine({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } }),
        'data: [DONE]',
      ]),
    );
    const a = agent(base(k, { cognition: { mechanisms: false }, chainOfThought: false,
      systemBlocks: [{ text: 'Policy', cacheBreakpoint: true }, { text: 'Clock' }],
      fallbackProviders: [{ provider: 'openrouter', model: 'anthropic/claude-sonnet-4-6', cache: false }],
    }));
    try {
      expect(await a.session('s').send('Hi.')).toMatchObject({ text: 'Recovered.', provider: 'openrouter' });
      expect(openRouter.sent.map((payload) => payload.model)).toEqual(['anthropic/claude-sonnet-4-6']);
      const system = openRouter.sent[0].messages.filter((message: { role: string }) => message.role === 'system');
      expect(system.map((message: { content: unknown }) => message.content), 'a hop sent with caching off gets one system string').toEqual(['Policy\n\nClock']);
      expect(JSON.stringify(openRouter.sent[0])).not.toContain('cache_control');
    } finally { await a.close(); }
  });

  it("marks the fixed block for one hour on an Anthropic fallback hop whose entry sets that lifetime over the agent's cache false", async () => {
    const k = key(); const fallbackKey = key();
    script('openai', k, { replies: [Object.assign(new Error('overloaded'), { httpStatus: 529 })] });
    const fallback = script('anthropic', fallbackKey, { replies: [reply.text('Recovered.')] });
    vi.stubEnv('ANTHROPIC_API_KEY', fallbackKey);
    const a = agent(base(k, { cache: false,
      systemBlocks: [{ text: 'Policy', cacheBreakpoint: true }, { text: 'Clock' }],
      fallbackProviders: [{ provider: 'anthropic', model: 'claude-sonnet-4-6', cache: { ttl: '1h' } }],
    }));
    try {
      expect(await a.session('s').send('Hi.')).toMatchObject({ text: 'Recovered.', provider: 'anthropic' });
      // The precondition: the gateway sends the hop with its entry's setting.
      expect(fallback.seen[0].options.cache).toEqual({ ttl: '1h' });
      expect(fallback.seen[0].messages.filter((message) => message.role === 'system'), 'a hop sent with caching on gets the marked fixed block').toEqual([
        { role: 'system', content: [{ type: 'text', text: 'Policy', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
        { role: 'system', content: 'Clock' },
      ]);
    } finally { await a.close(); }
  });
});
