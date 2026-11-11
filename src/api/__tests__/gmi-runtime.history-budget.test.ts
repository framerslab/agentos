/**
 * agent({ runtime: 'gmi' }) end to end: a session whose history is over the
 * prompt engine's history budget. The GMI's prompt engine gives the history 35
 * percent of the serving model's window and leaves the oldest messages out of
 * the request; the turn's result says how many it left out. Only the provider
 * classes are stubbed (helpers/stubProviders.ts), at their module boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
import { agent, type AgentOptions } from '../agent';
import { reply, script } from './helpers/stubProviders';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';

let n = 0;
const key = () => `k-history-budget-${++n}`;
const base = (apiKey: string) =>
  ({ runtime: 'gmi', provider: 'openai', model: 'stub-model', apiKey, fallbackProviders: [] }) as unknown as AgentOptions;

/**
 * The reported case: twelve messages of 20,000 characters, about 60,000 tokens
 * at the prompt engine's estimate of four characters a token, on the stub's
 * 128,000-token window, whose history budget is 35 percent of it (44,800).
 */
const LONG = 20_000;
const longHistory = () =>
  Array.from({ length: 12 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `m${i} ` + 'x'.repeat(LONG - `m${i} `.length),
  }));
/** One message's estimate: its characters over four, plus five tokens of overhead. */
const MESSAGE_TOKENS = Math.ceil(LONG / 4) + 5;

beforeEach(() => globalLLMProviderHealth.reset());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("agent({ runtime: 'gmi' }) history over the prompt budget", () => {
  it('send() reports the oldest messages the request left out, and messages() keeps them', async () => {
    const k = key(); const s = script('openai', k, { replies: [reply.text('Answered.')] });
    const session = agent(base(k)).session('s');
    session.reseed(longHistory() as never);
    const r = await session.send('now');
    expect(r.text).toBe('Answered.');
    // The request carried the newest eight messages and the turn's input: the four oldest left it.
    const sent = s.seen[0].messages.filter((m) => m.role !== 'system').map((m) => String(m.content).slice(0, 3));
    expect(sent).toEqual(['m4 ', 'm5 ', 'm6 ', 'm7 ', 'm8 ', 'm9 ', 'm10', 'm11', 'now']);
    expect(r.historyOmitted).toEqual({ messages: 4, tokens: 4 * MESSAGE_TOKENS });
    expect(session.messages()).toHaveLength(14);
  });

  it('stream() resolves the same report when the stream ends', async () => {
    const k = key(); script('openai', k, { replies: [reply.text('Streamed.')] });
    const session = agent(base(k)).session('s');
    session.reseed(longHistory() as never);
    const r = session.stream('now');
    expect(await r.text).toBe('Streamed.');
    expect(await r.historyOmitted).toEqual({ messages: 4, tokens: 4 * MESSAGE_TOKENS });
  });

  it('a turn whose request carries the whole history reports nothing left out', async () => {
    const k = key(); const s = script('openai', k, { replies: [reply.text('One.'), reply.text('Two.')] });
    const session = agent(base(k)).session('s');
    const first = await session.send('first');
    expect(first.historyOmitted).toBeUndefined();
    const second = session.stream('second');
    expect(await second.text).toBe('Two.');
    expect(await second.historyOmitted).toBeUndefined();
    expect(s.seen[1].messages.filter((m) => m.role !== 'system').map((m) => m.content)).toEqual(['first', 'One.', 'second']);
  });
});
