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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
vi.mock('../../core/llm/providers/implementations/AnthropicProvider', async () => ({ AnthropicProvider: (await import('./helpers/stubProviders')).stubProviderClass('anthropic') }));
import { agent, type AgentOptions } from '../agent';
import { reply, script } from './helpers/stubProviders';
import { setGlobalLlmObserver, type LlmUsageEvent } from '../observers';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';

let n = 0;
const key = () => `k-usage-${++n}`;
const base = (apiKey: string, extra: Record<string, unknown> = {}) =>
  ({ runtime: 'gmi', provider: 'openai', model: 'stub-model', apiKey, fallbackProviders: [], ...extra }) as unknown as AgentOptions;
const lookup = { name: 'lookup', description: 'Look up.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, execute: async () => ({ success: true, output: 'ok' }) };

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
});
