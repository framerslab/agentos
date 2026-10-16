/**
 * @file agent-call-provider-credentials.e2e.test.ts
 * An agent's key is for the provider the agent names. A generate() or stream()
 * call that names another provider runs on that provider's key from the
 * environment, on either runtime; a call that keeps the agent's provider keeps
 * the agent's key. Runs over the real provider manager, generateText,
 * streamText, completion gateway and GMI; only the provider classes are
 * stubbed (helpers/stubProviders.ts), and a stub starts only with a key it was
 * scripted for, so a key sent to the wrong provider fails the call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
vi.mock('../../core/llm/providers/implementations/AnthropicProvider', async () => ({ AnthropicProvider: (await import('./helpers/stubProviders')).stubProviderClass('anthropic') }));
import { agent, type AgentOptions } from '../agent';
import { reply, script } from './helpers/stubProviders';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';

let n = 0;
const key = () => `k-call-provider-${++n}`;
const openAiAgent = (apiKey: string, runtime?: 'gmi') =>
  agent({ ...(runtime ? { runtime } : {}), provider: 'openai', model: 'stub-model', apiKey, fallbackProviders: [] } as unknown as AgentOptions);

beforeEach(() => globalLLMProviderHealth.reset());
afterEach(() => vi.unstubAllEnvs());

describe('agent(): a call that names another provider than the agent', () => {
  it("generate() runs it on that provider's key from the environment", async () => {
    const agentKey = key();
    const envKey = key();
    vi.stubEnv('ANTHROPIC_API_KEY', envKey);
    const anthropic = script('anthropic', envKey, { whole: true, replies: [reply.text('From Anthropic.')] });

    const r = await openAiAgent(agentKey).generate('hi', { provider: 'anthropic', model: 'claude-x' });

    expect(r.text).toBe('From Anthropic.');
    expect(anthropic.seen.map((s) => s.modelId)).toEqual(['claude-x']);
  });

  it("stream() runs it on that provider's key from the environment", async () => {
    const agentKey = key();
    const envKey = key();
    vi.stubEnv('ANTHROPIC_API_KEY', envKey);
    script('anthropic', envKey, { replies: [reply.text('Streamed from Anthropic.')] });

    const r = openAiAgent(agentKey).stream('hi', { provider: 'anthropic', model: 'claude-x' });
    // The result's promises settle once the stream has drained.
    let text = '';
    for await (const delta of r.textStream) text += delta;

    expect(text).toBe('Streamed from Anthropic.');
  });

  it("generate() with another model of the agent's provider keeps the agent's key", async () => {
    const agentKey = key();
    const openai = script('openai', agentKey, { whole: true, replies: [reply.text('Same provider.')] });

    const r = await openAiAgent(agentKey).generate('hi', { model: 'other-model' });

    expect(r.text).toBe('Same provider.');
    expect(openai.seen.map((s) => s.modelId)).toEqual(['other-model']);
  });

  it("generate() with a model whose prefix names another provider, and a key of the call's own, runs there on that key", async () => {
    const agentKey = key();
    const callKey = key();
    const anthropic = script('anthropic', callKey, { whole: true, replies: [reply.text('On the prefix provider.')] });

    const r = await openAiAgent(agentKey).generate('hi', { model: 'anthropic:claude-x', apiKey: callKey });

    expect(r.text).toBe('On the prefix provider.');
    expect(anthropic.seen.map((s) => s.modelId)).toEqual(['claude-x']);
  });

  it("generate() with a key of the call's own sends that key", async () => {
    const agentKey = key();
    const callKey = key();
    script('anthropic', callKey, { whole: true, replies: [reply.text('On the call key.')] });

    const r = await openAiAgent(agentKey).generate('hi', { provider: 'anthropic', model: 'claude-x', apiKey: callKey });

    expect(r.text).toBe('On the call key.');
  });
});

describe("agent({ runtime: 'gmi' }): a call that names another provider than the agent", () => {
  it("generate() runs the turn on that provider's key from the environment", async () => {
    const agentKey = key();
    const envKey = key();
    vi.stubEnv('ANTHROPIC_API_KEY', envKey);
    const anthropic = script('anthropic', envKey, { replies: [reply.text('From Anthropic.')] });

    const r = await openAiAgent(agentKey, 'gmi').generate('hi', { provider: 'anthropic', model: 'claude-x' });

    expect(r).toMatchObject({ text: 'From Anthropic.', provider: 'anthropic' });
    expect(anthropic.seen.map((s) => s.modelId)).toEqual(['claude-x']);
  });

  it("generate() with a model whose prefix names another provider runs there on its environment key, the agent's base URL left behind", async () => {
    const agentKey = key();
    const envKey = key();
    vi.stubEnv('ANTHROPIC_API_KEY', envKey);
    const anthropic = script('anthropic', envKey, { replies: [reply.text('From Anthropic.')] });
    const withProxy = agent({
      runtime: 'gmi',
      provider: 'openai',
      model: 'stub-model',
      apiKey: agentKey,
      baseUrl: 'http://openai-proxy.local/v1',
      fallbackProviders: [],
    } as unknown as AgentOptions);

    const r = await withProxy.generate('hi', { model: 'anthropic:claude-x' });

    expect(r).toMatchObject({ text: 'From Anthropic.', provider: 'anthropic' });
    expect(anthropic.seen.map((s) => s.modelId)).toEqual(['claude-x']);
  });

  it("generate() with another model of the agent's provider keeps the agent's key", async () => {
    const agentKey = key();
    const openai = script('openai', agentKey, { replies: [reply.text('Same provider.')] });

    const r = await openAiAgent(agentKey, 'gmi').generate('hi', { model: 'other-model' });

    expect(r).toMatchObject({ text: 'Same provider.', provider: 'openai' });
    expect(openai.seen.map((s) => s.modelId)).toEqual(['other-model']);
  });
});
