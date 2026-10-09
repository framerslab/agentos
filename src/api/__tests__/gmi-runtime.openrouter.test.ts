/**
 * A structured send through OpenRouter, on both runtimes, when no endpoint
 * takes the schema-enforced request: OpenRouterProvider retries it once in
 * json_object mode, and the retried request carries the schema in its system
 * prompt, once, in generateObject's words. Runs the real OpenRouter provider
 * over a scripted HTTP client; everything above it is real.
 */
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

type ChatRequestBody = { messages: Array<{ role: string; content: unknown }>; response_format?: Record<string, unknown> };
/** The scripted HTTP client's answers to the chat requests, in order, and the bodies of the chat requests it was sent. */
const openRouter = vi.hoisted(() => ({
  answers: [] as Array<(request: { responseType?: string }) => unknown>,
  bodies: [] as ChatRequestBody[],
}));
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
          request: async (request: { url: string; data?: unknown; responseType?: string }) => {
            if (request.url !== '/chat/completions') return { data: { data: [] } };
            openRouter.bodies.push(JSON.parse(JSON.stringify(request.data)) as ChatRequestBody);
            const answer = openRouter.answers.shift();
            if (!answer) throw new Error('openrouter: unexpected request');
            return { data: answer(request) };
          },
        },
        isInitialized: true,
      });
    }
  }
  return { ...real, OpenRouterProvider: ScriptedOpenRouterProvider };
});
import { agent, type AgentOptions } from '../agent';
import { generateObject } from '../generateObject';
import { buildSchemaInstructionText } from '../runtime/structuredReply';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';

const MODEL = 'openai/gpt-4o-mini';
let n = 0;
const key = () => `k-openrouter-${++n}`;

/** OpenRouter's refusal of a request no endpoint can serve with its parameters (here, the strict json_schema). */
const noEndpoints = (): never => {
  throw Object.assign(new Error('Request failed with status code 404'), {
    isAxiosError: true,
    response: { status: 404, headers: {}, data: { error: { code: 404, message: 'No endpoints found that can handle the requested parameters.' } } },
  });
};

/** An answer with `content`, streamed or whole, as the request asks for it. */
const answer = (content: string) => (request: { responseType?: string }): unknown => {
  const usage = { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 };
  if (request.responseType !== 'stream') {
    return { id: 'gen-1', object: 'chat.completion', created: 1, model: MODEL, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage };
  }
  const line = (fields: Record<string, unknown>) => `data: ${JSON.stringify({ id: 'gen-1', object: 'chat.completion.chunk', created: 1, model: MODEL, ...fields })}\n\n`;
  return Readable.from([
    line({ choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] }),
    line({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    line({ choices: [], usage }),
    'data: [DONE]\n\n',
  ]);
};

/** A message's text: its string content, or its text parts joined. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '')).join('\n');
}

/** How many times `text` occurs in the request's messages. */
function occurrences(body: ChatRequestBody, text: string): number {
  return body.messages.reduce((count, message) => count + textOf(message.content).split(text).length - 1, 0);
}

beforeEach(() => {
  globalLLMProviderHealth.reset();
  openRouter.answers.length = 0;
  openRouter.bodies.length = 0;
  // The provider warns when it degrades the request.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a structured send OpenRouter can serve only in json_object mode', () => {
  const schema = z.object({ city: z.string() });

  it.each([['legacy'], ['gmi']] as const)('%s runtime: the retried request carries the schema in its system prompt, once, in generateObject\'s words', async (runtime) => {
    openRouter.answers.push(noEndpoints, answer('{"city":"Lyon"}'));
    const session = agent({ runtime, provider: 'openrouter', model: MODEL, apiKey: key(), fallbackProviders: [] } as unknown as AgentOptions).session('s');

    const r = await session.send('Which city holds the Festival of Lights?', { responseSchema: schema, schemaName: 'place' });
    expect(r.object).toEqual({ city: 'Lyon' });

    expect(openRouter.bodies).toHaveLength(2);
    const [first, retry] = openRouter.bodies;
    // The first request carries the schema in its strict json_schema payload, not in its prompt.
    const format = first.response_format as { type: string; json_schema: { name: string; schema: Record<string, unknown> } };
    expect(format.type).toBe('json_schema');
    const instruction = buildSchemaInstructionText(format.json_schema.schema, format.json_schema.name);
    expect(occurrences(first, instruction)).toBe(0);
    // The retry has no schema payload, so its prompt carries the schema.
    expect(retry.response_format).toEqual({ type: 'json_object' });
    expect(retry.messages.filter((m) => m.role === 'system' && textOf(m.content).includes(instruction))).toHaveLength(1);
    expect(occurrences(retry, instruction)).toBe(1);
  });

  it('a request whose prompt states the schema already (generateObject) gets no second copy on the retry', async () => {
    openRouter.answers.push(noEndpoints, answer('{"city":"Lyon"}'));

    const r = await generateObject({ provider: 'openrouter', model: MODEL, apiKey: key(), fallbackProviders: [], schema, schemaName: 'place', prompt: 'Which city holds the Festival of Lights?' });
    expect(r.object).toEqual({ city: 'Lyon' });

    expect(openRouter.bodies).toHaveLength(2);
    const [first, retry] = openRouter.bodies;
    expect(first.response_format).toMatchObject({ type: 'json_schema' });
    expect(retry.response_format).toEqual({ type: 'json_object' });
    // generateObject's own schema instructions, and no copy beside them.
    const lead = 'The JSON MUST conform to this JSON Schema:';
    expect(occurrences(first, lead)).toBe(1);
    expect(occurrences(retry, lead)).toBe(1);
  });
});
