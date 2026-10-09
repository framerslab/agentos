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

/** The response bodies the next OpenRouter chat requests stream, in order. */
const openRouter = vi.hoisted(() => ({ bodies: [] as Array<() => NodeJS.ReadableStream> }));
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
          request: async ({ url }: { url: string }) => {
            if (url === '/models') return { data: { data: [] } };
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
import { reply, script } from './helpers/stubProviders';
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
      // Read from the stream the abort left behind: one failed call, metered and counted.
      await vi.waitFor(() =>
        expect(events.map((e) => [e.provider, e.model, e.finishReason, e.usage.promptTokens, e.usage.completionTokens])).toEqual([['openrouter', OR_MODEL, 'error', 12, 4]]),
      );
      expect(await session.usage()).toMatchObject({ promptTokens: 12, completionTokens: 4, totalTokens: 16 });
      expect(await a.usage()).toMatchObject({ promptTokens: 12, completionTokens: 4, totalTokens: 16 });
    } finally {
      usageLine.open();
    }
  });
});
