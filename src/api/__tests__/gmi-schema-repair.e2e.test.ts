import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Memory } from '../../cognition/memory/io/facade/Memory';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';
import { ObjectGenerationError } from '../generateObject';
import { gmi, type GmiOptions } from '../gmi';
import { reply, script, type ProviderScript } from './helpers/stubProviders';

vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({
  OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai'),
}));

const schema = z.object({ count: z.number() });
const question = 'How many birdhouses should I build?';
const invalid = '{"count":"three"}';
const accepted = '{"count":3}';
const agentKey = 'gmi-schema-repair';
const usage = { promptTokens: 12, completionTokens: 3, totalTokens: 15 };
let nextKey = 0;
let directory: string;
let handle: ReturnType<typeof gmi> | undefined;

beforeEach(async () => {
  globalLLMProviderHealth.reset();
  directory = await mkdtemp(join(tmpdir(), 'gmi-schema-repair-'));
});

afterEach(async () => {
  try {
    await handle?.close();
  } finally {
    handle = undefined;
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});

function open(providerScript: Partial<ProviderScript>, options: Partial<GmiOptions> = {}) {
  const apiKey = `k-gmi-schema-repair-${++nextKey}`;
  const provider = script('openai', apiKey, providerScript);
  const embeddingKey = `${apiKey}-embedding`;
  script('openai', embeddingKey);
  vi.stubEnv('OPENAI_API_KEY', embeddingKey);
  const path = join(directory, 'brain.sqlite');
  const agent = gmi({
    provider: 'openai',
    model: 'stub-model',
    apiKey,
    fallbackProviders: [],
    cognition: { memory: { embedding: { provider: 'openai' }, store: { path } }, mechanisms: false },
    learning: { agentKey, mode: 'off' },
    ...options,
  });
  handle = agent;
  return {
    agent,
    provider,
    async filed() {
      const memory = await Memory.createSqlite(path, { brainId: agentKey, graph: false, selfImprove: false, decay: false });
      try {
        const traces = await memory.recentTraces(0);
        return traces.map(({ type, content }) => ({ type, content })).sort((a, b) => a.type.localeCompare(b.type));
      } finally {
        await memory.close();
      }
    },
  };
}

describe('GMI schema repair', () => {
  it('files only the original question and accepted reply when a repair succeeds', async () => {
    const { agent, provider, filed } = open({
      replies: [reply.text(invalid), reply.text(accepted)],
    });
    const session = agent.session('s1', { userId: 'u1' });
    const [result] = await Promise.allSettled([
      session.send(question, { responseSchema: schema, maxValidationRetries: 1 }),
    ]);

    expect(await filed()).toEqual([
      { type: 'episodic', content: question },
      { type: 'semantic', content: accepted },
    ]);
    expect(result).toMatchObject({ status: 'fulfilled', value: { text: accepted, object: { count: 3 } } });
    expect(provider.seen).toHaveLength(2);
    expect(session.messages()).toEqual([
      { role: 'user', content: question },
      { role: 'assistant', content: accepted },
    ]);
  });

  it('files nothing when every attempt fails validation and still counts their usage', async () => {
    const last = '{"count":"still three"}';
    const { agent, provider, filed } = open({
      replies: [reply.text(invalid, 'stub-model', usage), reply.text(last, 'stub-model', usage)],
    });
    const session = agent.session('s1', { userId: 'u1' });
    const result = session.send(question, { responseSchema: schema, maxValidationRetries: 1 });

    await expect(result).rejects.toBeInstanceOf(ObjectGenerationError);
    expect(await filed()).toEqual([]);
    await expect(result).rejects.toMatchObject({ rawText: last });
    expect(provider.seen).toHaveLength(2);
    expect(session.messages()).toEqual([]);
    expect(await session.usage()).toMatchObject({ totalTokens: 2 * usage.totalTokens });
  });

  it('keeps the original question and long tool result in the repair request', async () => {
    const toolResult = 'Birdhouse inventory: ' + 'nest '.repeat(1600);
    const { agent, provider } = open({
      window: 4096,
      replies: [reply.tools([{ id: 'c1', name: 'inventory', args: {} }]), reply.text(invalid), reply.text(accepted)],
    }, {
      responseSchema: schema,
      tools: {
        inventory: {
          description: 'Read the birdhouse inventory.',
          execute: async () => toolResult,
        },
      },
    });

    expect((await agent.generate(question)).parsed).toEqual({ count: 3 });
    expect(provider.seen).toHaveLength(3);
    const messages = provider.seen[2].messages;
    expect(messages.filter(({ role }) => role === 'user').map(({ content }) => content)).toContain(question);
    expect(messages.some(({ role, content }) => role === 'tool' && String(content).includes(toolResult))).toBe(true);
    expect(provider.seen[2].options.tools ?? []).toEqual([]);
  });
});
