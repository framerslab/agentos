import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { agent, type Agent, type AgentOptions } from '../agent';
import { ObjectGenerationError } from '../generateObject';
import { gmi } from '../gmi';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';
import { SCHEMA_INSTRUCTION_LEAD } from '../runtime/structuredReply';
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

/** The system text of one request, as the provider received it. */
function systemText(request: { messages: ReadonlyArray<{ role: string; content?: unknown }> }): string {
  return request.messages
    .filter(({ role }) => role === 'system')
    .map(({ content }) => (typeof content === 'string' ? content : JSON.stringify(content ?? '')))
    .join('\n');
}

beforeEach(() => globalLLMProviderHealth.reset());

describe.each(constructors)('$name response schema', ({ create }) => {
  function setupWith(options: Partial<AgentOptions>, ...replies: string[]) {
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
      ...options,
    });
    return { handle, provider };
  }
  const setup = (...replies: string[]) => setupWith({}, ...replies);

  it('requests a repair and rejects with the final validation error', async () => {
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

  it('states the schema in the system prompt of the first request and of the repair', async () => {
    const { handle, provider } = setup('three', '{"count":3}');
    try {
      const result = await handle.generate(question);
      expect(result.parsed).toEqual({ count: 3 });
      expect(provider.seen).toHaveLength(2);
      for (const request of provider.seen) {
        expect(systemText(request)).toContain(SCHEMA_INSTRUCTION_LEAD);
        expect(systemText(request)).toContain('count');
      }
    } finally {
      await handle.close();
    }
  });

  it("states the agent's schema when the call passes a response format of its own", async () => {
    const { handle, provider } = setup('{"count":3}');
    try {
      const result = await handle.generate(question, {
        responseFormat: { type: 'json_schema', json_schema: { name: 'anything', schema: { type: 'object' } } },
      });
      expect(result.parsed).toEqual({ count: 3 });
      expect(provider.seen).toHaveLength(1);
      expect(systemText(provider.seen[0])).toContain(SCHEMA_INSTRUCTION_LEAD);
      expect(systemText(provider.seen[0])).toContain('count');
    } finally {
      await handle.close();
    }
  });

  it('rejects the first invalid reply when controls.maxValidationRetries is 0', async () => {
    const { handle, provider } = setupWith({ controls: { maxValidationRetries: 0 } }, 'three', '{"count":3}');
    try {
      const result = handle.generate(question);
      await expect(result).rejects.toBeInstanceOf(ObjectGenerationError);
      await expect(result).rejects.toMatchObject({
        message: expect.stringMatching(/^Response is not valid JSON/),
        rawText: 'three',
      });
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
