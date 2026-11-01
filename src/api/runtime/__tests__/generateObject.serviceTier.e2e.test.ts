/**
 * @file generateObject.serviceTier.e2e.test.ts
 * `serviceTier` and `customModelParams` on generateObject, through the public
 * API and the real OpenAIProvider with only fetch stubbed: the request body
 * OpenAI receives carries `service_tier` and the passthrough fields, on the
 * first attempt and on a validation retry, as generateText sends them.
 *
 * OpenAI's Chat Completions reference describes `service_tier` as the
 * processing type for the request ('auto', 'default', 'flex', 'priority'):
 * https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { generateObject } from '../generateObject.js';
import { generateText } from '../generateText.js';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';

const CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-6-luna';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** A chat completion whose message text is `content`. */
function chatCompletion(content: string): Response {
  return jsonResponse({
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1700000000,
    model: MODEL,
    service_tier: 'priority',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
  });
}

/** Lists models on GET and answers each POST with the next queued reply. */
function serve(replies: Array<() => Response>): void {
  const queue = [...replies];
  fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'GET') {
      return jsonResponse({ object: 'list', data: [{ id: MODEL, object: 'model', created: 1, owned_by: 'openai' }] });
    }
    const next = queue.shift();
    if (!next) throw new Error(`unexpected POST ${String(url)}`);
    return next();
  });
}

/** The POSTs fetch was handed: each one's URL and parsed JSON body. */
function posted(): Array<{ url: string; body: Record<string, unknown> }> {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    .map(([url, init]) => ({
      url: String(url),
      body: JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>,
    }));
}

beforeEach(() => {
  fetchMock.mockReset();
  globalLLMProviderHealth.reset();
});

describe('generateObject sends serviceTier and customModelParams to the provider', () => {
  it('a generateText call with the same options sends service_tier and the passthrough fields (the reference)', async () => {
    serve([() => chatCompletion('Jupiter')]);

    await generateText({
      model: `openai:${MODEL}`,
      apiKey: 'sk-tier-text',
      prompt: 'Which planet in the solar system is the largest?',
      fallbackProviders: [],
      serviceTier: 'priority',
      customModelParams: { seed: 7 },
    });

    expect(posted()).toHaveLength(1);
    expect(posted()[0].url).toBe(CHAT_URL);
    expect(posted()[0].body.service_tier).toBe('priority');
    expect(posted()[0].body.seed).toBe(7);
  });

  it("sends serviceTier: 'priority' as service_tier on OpenAI's request", async () => {
    serve([() => chatCompletion('{"planet":"Jupiter"}')]);
    const options = {
      model: `openai:${MODEL}`,
      apiKey: 'sk-tier-object',
      schema: z.object({ planet: z.string() }),
      prompt: 'Which planet in the solar system is the largest?',
      fallbackProviders: [],
      serviceTier: 'priority' as const,
    };

    const { object } = await generateObject(options);

    expect(object).toEqual({ planet: 'Jupiter' });
    expect(posted()).toHaveLength(1);
    expect(posted()[0].url).toBe(CHAT_URL);
    expect(posted()[0].body.service_tier).toBe('priority');
  });

  it('spreads customModelParams onto the request body', async () => {
    serve([() => chatCompletion('{"planet":"Jupiter"}')]);
    const options = {
      model: `openai:${MODEL}`,
      apiKey: 'sk-params-object',
      schema: z.object({ planet: z.string() }),
      prompt: 'Which planet in the solar system is the largest?',
      fallbackProviders: [],
      customModelParams: { seed: 7, metadata: { job: 'extract' } },
    };

    await generateObject(options);

    expect(posted()).toHaveLength(1);
    expect(posted()[0].body.seed).toBe(7);
    expect(posted()[0].body.metadata).toEqual({ job: 'extract' });
  });

  it('a validation retry carries service_tier and the passthrough fields too', async () => {
    serve([() => chatCompletion('not json at all'), () => chatCompletion('{"planet":"Jupiter"}')]);
    const options = {
      model: `openai:${MODEL}`,
      apiKey: 'sk-tier-retry',
      schema: z.object({ planet: z.string() }),
      prompt: 'Which planet in the solar system is the largest?',
      maxRetries: 1,
      fallbackProviders: [],
      serviceTier: 'flex' as const,
      customModelParams: { seed: 11 },
    };

    const { object } = await generateObject(options);

    expect(object).toEqual({ planet: 'Jupiter' });
    expect(posted()).toHaveLength(2);
    for (const request of posted()) {
      expect(request.body.service_tier).toBe('flex');
      expect(request.body.seed).toBe(11);
    }
  });

  it('sends no service_tier when the call names none', async () => {
    serve([() => chatCompletion('{"planet":"Jupiter"}')]);

    await generateObject({
      model: `openai:${MODEL}`,
      apiKey: 'sk-no-tier',
      schema: z.object({ planet: z.string() }),
      prompt: 'Which planet in the solar system is the largest?',
      fallbackProviders: [],
    });

    expect(posted()).toHaveLength(1);
    expect(posted()[0].body).not.toHaveProperty('service_tier');
  });
});
