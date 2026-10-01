/**
 * @file TogetherProvider.integration.test.ts
 * TogetherProvider's default model must be one Together serverless serves:
 * the old default (Meta-Llama-3.1-70B-Instruct-Turbo) was removed on
 * 2026-02-25, so any call or fallback to the Together default failed with
 * model-not-found. Runs the real OpenAI delegate against a stubbed fetch and
 * checks the request that reaches Together's endpoint, plus the defaults
 * table that auto-resolution reads.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { TogetherProvider } from '../implementations/TogetherProvider';
import { PROVIDER_DEFAULTS } from '../../../../api/runtime/provider-defaults.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: unknown, init?: { method?: string }) => {
    if ((init?.method ?? 'GET') === 'GET') {
      return jsonResponse({ object: 'list', data: [] });
    }
    return jsonResponse({
      id: 'chatcmpl-together',
      object: 'chat.completion',
      created: 1,
      model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    });
  });
});

describe('TogetherProvider default model', () => {
  it('sends the default to Together\'s chat endpoint as a served model id', async () => {
    const provider = new TogetherProvider();
    await provider.initialize({ apiKey: 'tog-integration-key' });

    const result = await provider.generateCompletion(
      provider.defaultModelId!,
      [{ role: 'user', content: 'hi' }],
      {},
    );

    const post = fetchMock.mock.calls.find(
      ([, init]) => (init as { method?: string } | undefined)?.method === 'POST',
    );
    expect(String(post?.[0])).toBe('https://api.together.xyz/v1/chat/completions');
    const body = JSON.parse(String((post?.[1] as { body?: unknown }).body)) as { model: string };
    expect(body.model).toBe('meta-llama/Llama-3.3-70B-Instruct-Turbo');
    expect(result.choices[0]?.message?.content).toBe('hi');
  });

  it('keeps the auto-resolution default in step with the provider and its catalog', async () => {
    const provider = new TogetherProvider();
    await provider.initialize({ apiKey: 'tog-integration-defaults' });
    const ids = (await provider.listAvailableModels()).map((m) => m.modelId);

    expect(PROVIDER_DEFAULTS.together.text).toBe(provider.defaultModelId);
    expect(ids).toContain(PROVIDER_DEFAULTS.together.text);
    expect(ids).toContain(PROVIDER_DEFAULTS.together.cheap);
  });
});
