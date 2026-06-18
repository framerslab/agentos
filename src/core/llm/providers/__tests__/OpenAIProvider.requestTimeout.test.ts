import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { OpenAIProvider } from '../implementations/OpenAIProvider';

/** Minimal successful chat-completion response so makeApiRequest resolves on the first attempt. */
function okChatResponse(): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers(),
    json: () =>
      Promise.resolve({
        choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    body: null,
  } as unknown as Response;
}

// makeApiRequest is private + needs no initialization/network beyond fetch.
type RawRequest = (
  endpoint: string,
  method: string,
  apiKey: string,
  body: unknown,
  expectStream?: boolean,
  requestTimeoutOverride?: number,
) => Promise<unknown>;

describe('OpenAIProvider — per-call requestTimeout override (CR8)', () => {
  let provider: OpenAIProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new OpenAIProvider();
    // initialize() would set this.config (and hit the network for the model
    // list); set the minimal config makeApiRequest needs so we can unit-test
    // the timeout wiring in isolation.
    (provider as unknown as { config: Record<string, unknown> }).config = {
      baseURL: 'https://api.openai.com/v1',
      requestTimeout: 60000,
      maxRetries: 1,
    };
    fetchMock.mockResolvedValue(okChatResponse());
  });

  it('arms the abort timer with the per-call override instead of the config default', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const OVERRIDE = 123456;
    await (provider as unknown as { makeApiRequest: RawRequest }).makeApiRequest(
      '/chat/completions', 'POST', 'key', { model: 'gpt-4o' }, false, OVERRIDE,
    );
    const armedWithOverride = setTimeoutSpy.mock.calls.some(([, delay]) => delay === OVERRIDE);
    expect(armedWithOverride).toBe(true);
    setTimeoutSpy.mockRestore();
  });

  it('falls back to the config default timeout when no override is given', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const defaultTimeout = (provider as unknown as { config: { requestTimeout: number } }).config.requestTimeout;
    await (provider as unknown as { makeApiRequest: RawRequest }).makeApiRequest(
      '/chat/completions', 'POST', 'key', { model: 'gpt-4o' }, false,
    );
    const armedWithDefault = setTimeoutSpy.mock.calls.some(([, delay]) => delay === defaultTimeout);
    expect(armedWithDefault).toBe(true);
    setTimeoutSpy.mockRestore();
  });
});
