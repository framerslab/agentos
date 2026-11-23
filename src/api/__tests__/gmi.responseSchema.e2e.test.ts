import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { agent, type Agent, type AgentOptions } from '../agent';
import { ObjectGenerationError } from '../generateObject';
import { gmi } from '../gmi';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';
import { reply, script } from './helpers/stubProviders';

vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({
  OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai'),
}));

const responseSchema = z.object({ count: z.number() });
const question = 'How many?';
let nextKey = 0;

const constructors: { name: string; create: (options: AgentOptions) => Agent }[] = [
  { name: 'legacy agent()', create: (options) => agent({ ...options, runtime: 'legacy' }) },
  { name: 'agent() on GMI', create: (options) => agent({ ...options, runtime: 'gmi' }) },
  { name: 'gmi()', create: gmi },
];

beforeEach(() => globalLLMProviderHealth.reset());

describe.each(constructors)('$name response schema', ({ create }) => {
  function setup(...replies: string[]) {
    const apiKey = `k-response-schema-${++nextKey}`;
    const provider = script('openai', apiKey, {
      whole: true,
      replies: replies.map((text) => reply.text(text)),
    });
    const handle = create({
      provider: 'openai',
      model: 'stub-model',
      apiKey,
      fallbackProviders: [],
      responseSchema,
    });
    return { handle, provider };
  }

  it('sends a repair turn and rejects with the final validation error', async () => {
    const first = 'three';
    const last = '{"count":"still three"}';
    const { handle, provider } = setup(first, last);
    try {
      const result = handle.generate(question);
      await expect(result).rejects.toBeInstanceOf(ObjectGenerationError);
      await expect(result).rejects.toMatchObject({
        message: 'Response failed Zod validation',
        rawText: last,
        validationErrors: expect.any(z.ZodError),
      });
      expect(provider.seen).toHaveLength(2);
      const repair = provider.seen[1].messages.filter(({ role }) => role !== 'system');
      expect(repair).toMatchObject([
        { role: 'user', content: question },
        { role: 'assistant', content: first },
        {
          role: 'user',
          content: expect.stringMatching(/^Your reply did not match the schema: .+\. Reply again with JSON that matches it\.$/s),
        },
      ]);
    } finally {
      await handle.close();
    }
  });

  it('sets parsed from a valid reply', async () => {
    const { handle, provider } = setup('```json\n{"count":3}\n```');
    try {
      const result = await handle.generate(question);
      expect(result.parsed).toEqual({ count: 3 });
      expect(provider.seen).toHaveLength(1);
    } finally {
      await handle.close();
    }
  });

  it('uses the schema passed to session.send()', async () => {
    const { handle, provider } = setup('{"label":"three"}');
    try {
      const result = await handle.session('schema').send(question, {
        responseSchema: z.object({ label: z.string() }),
      });
      expect(result.object).toEqual({ label: 'three' });
      expect(provider.seen).toHaveLength(1);
    } finally {
      await handle.close();
    }
  });
});
