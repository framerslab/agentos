import { describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const generateCompletion = vi.fn();
  const getProvider = vi.fn(() => ({ generateCompletion }));
  const createProviderManager = vi.fn(async () => ({ getProvider }));
  return { generateCompletion, getProvider, createProviderManager };
});

vi.mock('../../model.js', () => ({
  resolveModelOption: vi.fn(() => ({ providerId: 'openai', modelId: 'gpt-4.1-mini' })),
  resolveProvider: vi.fn(() => ({
    providerId: 'openai',
    modelId: 'gpt-4.1-mini',
    apiKey: 'test-key',
  })),
  createProviderManager: hoisted.createProviderManager,
}));

import { agent } from '../../agent.js';

/**
 * AgentConfig.cache -> generateText passthrough (the thinking/effort idiom).
 *
 * The agent factory spreads baseOpts into every generate / session / stream
 * call, so a per-agent `cache` disposition must reach the provider layer's
 * completion options on each step. This is the seam long-loop callers (the
 * wilds codegen orchestrator) use to re-time the auto conversation-history
 * marker onto the 1h cache — without it, multi-minute tool gaps between agent
 * steps let the default-TTL tail expire and every step re-writes the prefix.
 */
describe('agent cache passthrough', () => {
  const okCompletion = {
    modelId: 'gpt-4.1-mini',
    usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
    choices: [{ message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }],
  };
  const lastCallOpts = () =>
    ((): unknown => {
      const calls = hoisted.generateCompletion.mock.calls as unknown[][];
      return calls[calls.length - 1]?.[2] ?? {};
    })() as {
      cache?: unknown;
    };

  it('forwards config.cache to the generate call', async () => {
    hoisted.generateCompletion.mockResolvedValue(okCompletion);
    const a = agent({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      memory: false,
      cache: { ttl: '1h' },
    });
    const result = await a.generate('hello');
    expect(result.text).toBe('ok');
    expect(lastCallOpts().cache).toEqual({ ttl: '1h' });
  });

  it('leaves cache unset when the agent config omits it', async () => {
    hoisted.generateCompletion.mockResolvedValue(okCompletion);
    const a = agent({ provider: 'openai', model: 'gpt-4.1-mini', memory: false });
    const result = await a.generate('hello');
    expect(result.text).toBe('ok');
    expect(lastCallOpts().cache).toBeUndefined();
  });
});
