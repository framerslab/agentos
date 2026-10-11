/**
 * @fileoverview OpenAIProvider's health check asks for the default model's
 * record, or for the model list when no default is set. It used to ask for
 * `gpt-3.5-turbo` in that case, a model OpenAI retires on 2026-10-23
 * (https://developers.openai.com/api/docs/deprecations), after which a
 * working key would have reported unhealthy.
 *
 * The check sends the key a request would send: one key of a comma-separated
 * key list (the provider's key pool), or the OAuth flow's token. Groq,
 * Mistral, Together, xAI and LiteLLM pass their health check to this one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { OpenAIProvider } from '../implementations/OpenAIProvider';

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/**
 * A transport that answers as the API does: a bearer token that is one of
 * `keys` gets the model list, any other token a 401.
 */
function apiAccepting(keys: string[]) {
  return async (_url: string, init?: RequestInit): Promise<Response> => {
    const authorization = new Headers(init?.headers).get('authorization');
    if (keys.some((key) => authorization === `Bearer ${key}`)) return ok({ object: 'list', data: [] });
    return new Response(JSON.stringify({ error: { message: 'Incorrect API key provided.' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  };
}

/** The Authorization header of the last request the transport received. */
function lastAuthorization(): string | null {
  const init = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]?.[1] as RequestInit | undefined;
  return new Headers(init?.headers).get('authorization');
}

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

  it('sends one key of a comma-separated key list, as a request does', async () => {
    fetchMock.mockImplementation(apiAccepting(['sk-first', 'sk-second']));
    const p = new OpenAIProvider();
    await p.initialize({ apiKey: 'sk-first,sk-second', maxRetries: 1 });

    expect(await p.checkHealth()).toEqual({ isHealthy: true });
    expect(lastAuthorization()).toMatch(/^Bearer sk-(first|second)$/);
  });

  it("sends the OAuth flow's token when the provider authenticates through OAuth", async () => {
    fetchMock.mockImplementation(apiAccepting(['oauth-access-token']));
    const p = new OpenAIProvider();
    await p.initialize({
      apiKey: '',
      maxRetries: 1,
      oauthFlow: { getAccessToken: async () => 'oauth-access-token' },
    });

    expect(await p.checkHealth()).toEqual({ isHealthy: true });
    expect(lastAuthorization()).toBe('Bearer oauth-access-token');
  });
});
