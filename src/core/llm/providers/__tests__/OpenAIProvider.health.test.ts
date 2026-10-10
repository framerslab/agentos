/**
 * @fileoverview OpenAIProvider's health check asks for the default model's
 * record, or for the model list when no default is set. It used to ask for
 * `gpt-3.5-turbo` in that case, a model OpenAI retires on 2026-10-23
 * (https://developers.openai.com/api/docs/deprecations), after which a
 * working key would have reported unhealthy.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { OpenAIProvider } from '../implementations/OpenAIProvider';

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** An initialized provider: its model listing at initialization succeeds. */
async function provider(defaultModelId?: string): Promise<OpenAIProvider> {
  fetchMock.mockResolvedValueOnce(ok({ object: 'list', data: [] }));
  const p = new OpenAIProvider();
  await p.initialize({ apiKey: 'sk-openai-test', maxRetries: 1, defaultModelId });
  fetchMock.mockClear();
  return p;
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('OpenAIProvider.checkHealth', () => {
  it('lists the models when no default model is set, naming no model of its own', async () => {
    const p = await provider();
    fetchMock.mockResolvedValueOnce(ok({ object: 'list', data: [] }));

    expect(await p.checkHealth()).toEqual({ isHealthy: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.openai.com/v1/models');
  });

  it('asks for the default model when one is set', async () => {
    const p = await provider('gpt-4o');
    fetchMock.mockResolvedValueOnce(ok({ id: 'gpt-4o', object: 'model' }));

    expect(await p.checkHealth()).toEqual({ isHealthy: true });
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.openai.com/v1/models/gpt-4o');
  });

  it('reports unhealthy when the request fails', async () => {
    const p = await provider();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'Incorrect API key provided.' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );

    expect((await p.checkHealth()).isHealthy).toBe(false);
  });
});
