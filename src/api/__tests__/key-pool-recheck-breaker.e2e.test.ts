/**
 * @file key-pool-recheck-breaker.e2e.test.ts
 * A pool whose keys were all refused gets them back at their recheck without the provider health breaker opening
 * again: the pool probes a failed key `recheckMs` after its failure (not at the next tick of an interval fixed when the
 * provider started), and the call that half-closes the breaker is served by the key the probe brought back. Drives
 * generateText through the real resolver, provider manager, AnthropicProvider and health registry, with fake timers;
 * only fetch is stubbed, answering by the key a request carries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { generateText } from '../generateText.js';
import { shutdownProviderManagers } from '../model.js';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry.js';

const K0 = 'sk-ant-recheck-alpha-0000';
const K1 = 'sk-ant-recheck-beta-1111';
const MINUTE = 60_000;

/** The keys the stubbed API refuses with its 401 envelope. */
const refused = new Set<string>();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** One `data:` line per event. */
function sse(events: unknown[]): Response {
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const served = () =>
  sse([
    { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Served.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ]);

/** The key a request carried in its x-api-key header. */
const keyOf = (init?: RequestInit) => new Headers(init?.headers).get('x-api-key') ?? '';

/** Each request in call order: a probe (the models list) or a request (a message), and its key. */
const sent = () =>
  fetchMock.mock.calls.map(([url, init]) => ({ kind: String(url).includes('/v1/models') ? 'probe' : 'request', key: keyOf(init as RequestInit) }));

const ask = () => generateText({ provider: 'anthropic', model: 'claude-opus-5-5', prompt: 'Hello?', fallbackProviders: [] });

const savedOpenRouterKey = process.env.OPENROUTER_API_KEY;

describe('a pool whose keys were refused, at their recheck', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-18T12:00:00Z'));
    fetchMock.mockReset();
    refused.clear();
    globalLLMProviderHealth.reset();
    vi.stubEnv('ANTHROPIC_API_KEY', `${K0},${K1}`);
    vi.stubEnv('AGENTOS_KEY_POOL_STRATEGY_ANTHROPIC', 'ordered');
    // Without the Anthropic key the resolver would reroute to OpenRouter; keep it out.
    delete process.env.OPENROUTER_API_KEY;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      if (refused.has(keyOf(init))) return json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401);
      if (String(url).includes('/v1/models')) return json({ data: [], has_more: false, first_id: null, last_id: null });
      if (String(url).includes('/v1/messages')) return served();
      throw new Error(`unexpected request ${String(url)}`);
    });
  });

  afterEach(async () => {
    await shutdownProviderManagers();
    globalLLMProviderHealth.reset();
    vi.unstubAllEnvs();
    if (savedOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedOpenRouterKey;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('probes the keys at the recheck and serves the call that half-closes the breaker, which stays closed', async () => {
    // The provider starts at T=0 and serves.
    expect((await ask()).text).toBe('Served.');

    // At T=10 both keys are refused (a key rotation at the console): the call hops from K0 to K1, every key is out,
    // and the 401 opens the auth breaker until T=40, the keys' recheck.
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    refused.add(K0);
    refused.add(K1);
    await expect(ask()).rejects.toMatchObject({ code: 'ALL_KEYS_FAILED', httpStatus: 401 });
    expect(globalLLMProviderHealth.getStats('anthropic')).toMatchObject({ state: 'open', totalTrips: 1 });

    // The keys are restored at T=20. At T=40 the pool probes both and takes them back.
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    refused.clear();
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    expect(sent().filter((s) => s.kind === 'probe').map((s) => s.key)).toEqual([K0, K1]);

    // The call at T=40 half-closes the breaker and is served by K0; the breaker does not open again.
    expect((await ask()).text).toBe('Served.');
    const requests = sent().filter((s) => s.kind === 'request');
    expect(requests.map((s) => s.key)).toEqual([K0, K0, K1, K0]);
    expect(globalLLMProviderHealth.getStats('anthropic')).toMatchObject({ state: 'closed', totalTrips: 1 });
    expect(globalLLMProviderHealth.isOpen('anthropic')).toBe(false);
  });
});
