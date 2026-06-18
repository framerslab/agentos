import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { GeminiProvider } from '../implementations/GeminiProvider';

/** Minimal successful generateContent response so makeApiRequest resolves first try. */
function okGeminiResponse(): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers(),
    json: () =>
      Promise.resolve({
        candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      }),
    body: null,
  } as unknown as Response;
}

type RawRequest = (endpoint: string, body: unknown, requestTimeoutOverride?: number) => Promise<unknown>;

describe('GeminiProvider — per-call requestTimeout override (CR8)', () => {
  let provider: GeminiProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GeminiProvider();
    (provider as unknown as { config: Record<string, unknown> }).config = {
      baseURL: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'test-key',
      requestTimeout: 60000,
      maxRetries: 1,
    };
    fetchMock.mockResolvedValue(okGeminiResponse());
  });

  it('arms the abort timer with the per-call override instead of the config default', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const OVERRIDE = 234567;
    await (provider as unknown as { makeApiRequest: RawRequest }).makeApiRequest(
      '/models/gemini-2.5-flash:generateContent', {}, OVERRIDE,
    );
    expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === OVERRIDE)).toBe(true);
    setTimeoutSpy.mockRestore();
  });

  it('falls back to the config default timeout when no override is given', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const defaultTimeout = (provider as unknown as { config: { requestTimeout: number } }).config.requestTimeout;
    await (provider as unknown as { makeApiRequest: RawRequest }).makeApiRequest(
      '/models/gemini-2.5-flash:generateContent', {},
    );
    expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === defaultTimeout)).toBe(true);
    setTimeoutSpy.mockRestore();
  });
});
