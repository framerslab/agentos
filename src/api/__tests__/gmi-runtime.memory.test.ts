/**
 * agent({ runtime: 'gmi' }) end to end: cognitive memory built from the agent's
 * options, over the real provider manager, completion gateway, GMI, embedding
 * manager and cognitive memory manager. Only the provider classes are stubbed
 * (helpers/stubProviders.ts), at their module boundary; the OpenAI stub embeds
 * with a deterministic word hash.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
vi.mock('../../core/llm/providers/implementations/AnthropicProvider', async () => ({ AnthropicProvider: (await import('./helpers/stubProviders')).stubProviderClass('anthropic') }));
import { agent } from '../agent';
import { reply, script } from './helpers/stubProviders';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';

let n = 0;
const key = () => `k-memory-${++n}`;

beforeEach(() => globalLLMProviderHealth.reset());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("agent({ runtime: 'gmi' }) cognitive memory", () => {
  it("cognition: 'full' encodes the exchange; the second send's prompt carries the recalled fact", async () => {
    const k = key(); const emb = key();
    const s = script('openai', k, { replies: [reply.text('Noted.'), reply.text('It is in the vault.')] });
    const e = script('openai', emb, { replies: [] });
    const session = agent({ runtime: 'gmi', provider: 'openai', model: 'stub-model', apiKey: k, fallbackProviders: [], cognition: 'full', memory: { embedding: { provider: 'openai', model: 'text-embedding-3-small' } } as never }).session('s');
    // Read on the first send, not when the agent was made.
    vi.stubEnv('OPENAI_API_KEY', emb);
    await session.send('The deploy key lives in the vault under ops/deploy.');
    session.clear();
    await session.send('Where does the deploy key live?');
    // The cleared history cannot carry it: the fact reaches the prompt through recall.
    expect(JSON.stringify(s.seen[1].messages)).toContain('vault');
    expect(e.embedCalls).toBeGreaterThan(0);
  });

  it('cognitive memory and memoryProvider together: the bridge supplies context, getContext is skipped, observe still runs', async () => {
    const k = key(); const emb = key();
    const s = script('openai', k, { replies: [reply.text('Done.')] });
    script('openai', emb, { replies: [] });
    vi.stubEnv('OPENAI_API_KEY', emb);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const getContext = vi.fn(async () => ({ contextText: 'FROM PROVIDER' }));
    const observe = vi.fn(async () => undefined);
    await agent({ runtime: 'gmi', provider: 'openai', model: 'stub-model', apiKey: k, fallbackProviders: [], cognition: 'full', memoryProvider: { getContext, observe } }).session('s').send('hi');
    expect(getContext).not.toHaveBeenCalled();
    expect(JSON.stringify(s.seen[0].messages)).not.toContain('FROM PROVIDER');
    expect(warn.mock.calls.some(([message]) => String(message).includes('memoryProvider.getContext is skipped'))).toBe(true);
    await vi.waitFor(() => expect(observe).toHaveBeenCalledTimes(2));
  });

  it('an Anthropic chat model with full cognition embeds through the configured embedding provider', async () => {
    const k = key(); const emb = key();
    script('anthropic', k, { replies: [reply.text('Hi.')] });
    const e = script('openai', emb, { replies: [] });
    vi.stubEnv('OPENAI_API_KEY', emb);
    const r = await agent({ runtime: 'gmi', provider: 'anthropic', model: 'claude-x', apiKey: k, fallbackProviders: [], cognition: 'full', memory: { embedding: { provider: 'openai' } } as never }).session('s').send('remember tea');
    expect(r).toMatchObject({ text: 'Hi.', provider: 'anthropic' });
    expect(e.embedCalls).toBeGreaterThan(0);
  });

  it('memory with no embedding source: the agent is made, and its first call fails naming memory.embedding before any model call', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('OLLAMA_BASE_URL', '');
    const k = key(); const s = script('anthropic', k, { replies: [reply.text('Hi.')] });
    const a = agent({ runtime: 'gmi', provider: 'anthropic', model: 'claude-x', apiKey: k, fallbackProviders: [], cognition: 'full' });
    await expect(a.session('s').send('hi')).rejects.toThrow(/memory\.embedding/);
    expect(s.seen).toHaveLength(0);
  });
});
