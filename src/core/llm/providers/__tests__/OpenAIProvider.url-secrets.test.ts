/**
 * @fileoverview OpenAIProvider's network error named its base URL verbatim,
 * so a gateway base URL with `user:password@` put its credentials into the
 * error every OpenAI-compatible provider raises, and from there into logs and
 * spans.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { OpenAIProvider } from '../implementations/OpenAIProvider';

const BASE_URL = 'https://svc:gw-token@gateway.example/v1';

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the call to reject');
}

/** An initialized provider: its model listing at initialization succeeds. */
async function provider(baseURL: string): Promise<OpenAIProvider> {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ object: 'list', data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  const p = new OpenAIProvider();
  await p.initialize({ apiKey: 'sk-openai-test', maxRetries: 1, baseURL });
  return p;
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('OpenAIProvider request errors', () => {
  it('masks base-URL credentials in the network error', async () => {
    const p = await provider(BASE_URL);
    fetchMock.mockRejectedValue(
      new TypeError(`Request cannot be constructed from a URL that includes credentials: ${BASE_URL}/chat/completions`),
    );

    const error = await rejectionOf(p.generateCompletion('gpt-4.1', [{ role: 'user', content: 'hi' }], {}));

    expect((error as { code?: string }).code).toBe('NETWORK_ERROR');
    expect(error.message).not.toContain('gw-token');
    expect(error.message).toContain('https://[redacted]@gateway.example/v1');
  });
});
