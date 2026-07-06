/**
 * @file OpenRouterProvider.retry-structured.test.ts
 * @description Covers the 2026-07-06 reliability + schema-enforcement pass:
 *              per-attempt key rotation with quota cooldown, bounded retry on
 *              transient failures, json_schema response_format forwarding
 *              paired with `provider.require_parameters` routing, the
 *              one-shot json_object degrade when no endpoint supports the
 *              schema, and mid-stream upstream-error surfacing.
 */
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterProvider } from '../implementations/OpenRouterProvider';
import { OpenRouterProviderError } from '../errors/OpenRouterProviderError';
import { ApiKeyPool } from '../../../providers/ApiKeyPool';
import type { ChatMessage } from '../IProvider';

const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];

function okResponse() {
  return {
    id: 'gen-1',
    object: 'chat.completion',
    created: 1,
    model: 'meta-llama/llama-3.3-70b-instruct',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function axiosError(status: number | undefined, message: string, headers?: Record<string, string>) {
  return {
    isAxiosError: true,
    message,
    response:
      status === undefined
        ? undefined
        : { status, data: { error: { message } }, headers: headers ?? {} },
  };
}

/** Bare provider with injected internals (initialize() hits the network). */
function makeProvider(clientRequest: ReturnType<typeof vi.fn>, keys = 'key-a,key-b') {
  const provider = new OpenRouterProvider();
  Object.assign(provider as unknown as Record<string, unknown>, {
    isInitialized: true,
    ensureInitialized: () => {},
    config: { apiKey: keys, requestTimeout: 1000, streamRequestTimeout: 1000 },
    keyPool: new ApiKeyPool(keys),
    client: { request: clientRequest },
  });
  return provider;
}

function authHeaderOfCall(request: ReturnType<typeof vi.fn>, callIdx: number): string {
  const cfg = request.mock.calls[callIdx][0] as { headers?: Record<string, string> };
  return cfg.headers?.Authorization ?? '';
}

describe('makeApiRequest retry + key rotation', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('retries a 429 on the next pool key and succeeds', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(axiosError(429, 'rate limited'))
      .mockResolvedValueOnce({ data: okResponse() });
    const provider = makeProvider(request);

    const result = await (provider as never as {
      makeApiRequest: (e: string, m: string, t?: number, b?: Record<string, unknown>) => Promise<unknown>;
    }).makeApiRequest('/chat/completions', 'POST', 1000, { model: 'x' });

    expect((result as { id: string }).id).toBe('gen-1');
    expect(request).toHaveBeenCalledTimes(2);
    // The 429'd key enters cooldown, so the retry draws the OTHER key.
    expect(authHeaderOfCall(request, 0)).toBe('Bearer key-a');
    expect(authHeaderOfCall(request, 1)).toBe('Bearer key-b');
  });

  it('retries transport-level failures (no HTTP response)', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(axiosError(undefined, 'socket hang up'))
      .mockResolvedValueOnce({ data: okResponse() });
    const provider = makeProvider(request);

    const result = await (provider as never as {
      makeApiRequest: (e: string, m: string, t?: number, b?: Record<string, unknown>) => Promise<unknown>;
    }).makeApiRequest('/chat/completions', 'POST', 1000, { model: 'x' });

    expect((result as { id: string }).id).toBe('gen-1');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a 400 request error', async () => {
    const request = vi.fn().mockRejectedValue(axiosError(400, 'bad request'));
    const provider = makeProvider(request);

    await expect(
      (provider as never as {
        makeApiRequest: (e: string, m: string, t?: number, b?: Record<string, unknown>) => Promise<unknown>;
      }).makeApiRequest('/chat/completions', 'POST', 1000, { model: 'x' }),
    ).rejects.toMatchObject({ httpStatus: 400, message: '[400] bad request' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('gives up after 3 attempts on persistent 5xx', async () => {
    const request = vi.fn().mockRejectedValue(axiosError(503, 'upstream down'));
    const provider = makeProvider(request);

    await expect(
      (provider as never as {
        makeApiRequest: (e: string, m: string, t?: number, b?: Record<string, unknown>) => Promise<unknown>;
      }).makeApiRequest('/chat/completions', 'POST', 1000, { model: 'x' }),
    ).rejects.toMatchObject({ httpStatus: 503 });
    expect(request).toHaveBeenCalledTimes(3);
  });
});

describe('json_schema forwarding + require_parameters routing', () => {
  let provider: OpenRouterProvider;
  let makeApiRequest: ReturnType<typeof vi.fn>;

  const jsonSchemaFormat = {
    type: 'json_schema',
    json_schema: {
      name: 'verdict',
      strict: true,
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    },
  };

  beforeEach(() => {
    provider = new OpenRouterProvider();
    makeApiRequest = vi.fn().mockResolvedValue(okResponse());
    Object.assign(provider as unknown as Record<string, unknown>, {
      ensureInitialized: () => {},
      config: { requestTimeout: 60000, streamRequestTimeout: 120000 },
      makeApiRequest,
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('forwards the json_schema response_format and adds require_parameters', async () => {
    await provider.generateCompletion('meta-llama/llama-3.3-70b-instruct', messages, {
      responseFormat: jsonSchemaFormat,
    } as never);
    const payload = makeApiRequest.mock.calls[0][3] as Record<string, unknown>;
    expect(payload.response_format).toEqual(jsonSchemaFormat);
    expect(payload.provider).toEqual({ require_parameters: true });
  });

  it('merges require_parameters over caller provider prefs instead of clobbering', async () => {
    await provider.generateCompletion('meta-llama/llama-3.3-70b-instruct', messages, {
      responseFormat: jsonSchemaFormat,
      customModelParams: { provider: { sort: 'latency' } },
    } as never);
    const payload = makeApiRequest.mock.calls[0][3] as Record<string, unknown>;
    expect(payload.provider).toEqual({ sort: 'latency', require_parameters: true });
  });

  it('json_object requests stay untouched (no provider prefs added)', async () => {
    await provider.generateCompletion('meta-llama/llama-3.3-70b-instruct', messages, {
      responseFormat: { type: 'json_object' },
    } as never);
    const payload = makeApiRequest.mock.calls[0][3] as Record<string, unknown>;
    expect(payload.response_format).toEqual({ type: 'json_object' });
    expect(payload.provider).toBeUndefined();
  });

  it('degrades to json_object once when no endpoint supports the schema', async () => {
    makeApiRequest
      .mockRejectedValueOnce(
        new OpenRouterProviderError(
          '[404] No endpoints found that support the requested parameters.',
          'API_REQUEST_FAILED',
          404,
        ),
      )
      .mockResolvedValueOnce(okResponse());

    await provider.generateCompletion('anthracite-org/magnum-v4-72b', messages, {
      responseFormat: jsonSchemaFormat,
    } as never);

    expect(makeApiRequest).toHaveBeenCalledTimes(2);
    const retryPayload = makeApiRequest.mock.calls[1][3] as Record<string, unknown>;
    expect(retryPayload.response_format).toEqual({ type: 'json_object' });
    expect(retryPayload.provider).toBeUndefined();
  });

  it('does not degrade on unrelated errors', async () => {
    makeApiRequest.mockRejectedValue(
      new OpenRouterProviderError('[401] bad key', 'API_REQUEST_FAILED', 401),
    );
    await expect(
      provider.generateCompletion('anthracite-org/magnum-v4-72b', messages, {
        responseFormat: jsonSchemaFormat,
      } as never),
    ).rejects.toMatchObject({ httpStatus: 401 });
    expect(makeApiRequest).toHaveBeenCalledTimes(1);
  });
});

describe('mid-stream upstream error surfacing', () => {
  it('yields the real upstream error message + code instead of "no choices"', async () => {
    const provider = new OpenRouterProvider();
    const sse = [
      'data: {"id":"gen-2","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"Once"},"finish_reason":null}]}\n',
      'data: {"id":"gen-2","error":{"code":502,"message":"Provider returned error"}}\n',
    ];
    const makeApiRequest = vi.fn().mockResolvedValue(Readable.from(sse));
    Object.assign(provider as unknown as Record<string, unknown>, {
      ensureInitialized: () => {},
      config: { requestTimeout: 1000, streamRequestTimeout: 1000 },
      makeApiRequest,
    });

    const chunks: Array<{ error?: { message: string; type?: string }; isFinal?: boolean }> = [];
    for await (const chunk of provider.generateCompletionStream('m', messages, {} as never)) {
      chunks.push(chunk as never);
    }

    const errChunk = chunks.find((c) => c.error);
    expect(errChunk).toBeDefined();
    expect(errChunk!.error!.message).toBe('[502] Provider returned error');
    expect(errChunk!.error!.type).toBe('upstream_error');
    expect(errChunk!.isFinal).toBe(true);
  });
});
