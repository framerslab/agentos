/**
 * @fileoverview fetch names the request URL when it rejects one (a base URL
 * with `user:password@`, or one it cannot parse) and quotes a header value it
 * rejects, which carries the API key. AnthropicProvider's errors must not
 * pass either on: they reach callers, logs and spans.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { AnthropicProvider } from '../implementations/AnthropicProvider';

const BASE_URL = 'https://svc:gw-token@gateway.example/anthropic';
const API_KEY = 'sk-ant-secret-key-123';

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the call to reject');
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('AnthropicProvider request errors', () => {
  it('masks base-URL credentials when fetch rejects the streamed request URL', async () => {
    fetchMock.mockRejectedValue(
      new TypeError(`Request cannot be constructed from a URL that includes credentials: ${BASE_URL}/v1/messages`),
    );
    const provider = new AnthropicProvider();
    await provider.initialize({ apiKey: API_KEY, baseURL: BASE_URL, maxRetries: 1 });

    const error = await rejectionOf(
      provider.generateCompletion('claude-opus-5-5', [{ role: 'user', content: 'hi' }], {}),
    );

    expect(error.message).not.toContain('gw-token');
    expect(error.message).toContain('https://[redacted]@gateway.example/anthropic/v1/messages');
  });

  it('masks the API key when fetch rejects the key header', async () => {
    fetchMock.mockRejectedValue(new TypeError(`Headers.append: "${API_KEY}\u0000" is an invalid header value.`));
    const provider = new AnthropicProvider();
    await provider.initialize({ apiKey: API_KEY, maxRetries: 1 });

    const error = await rejectionOf(
      provider.generateCompletion('claude-opus-5-5', [{ role: 'user', content: 'hi' }], {}),
    );

    expect(error.message).not.toContain(API_KEY);
  });

  it('masks base-URL credentials on the non-streamed request path', async () => {
    fetchMock.mockRejectedValue(new TypeError(`Failed to parse URL from ${BASE_URL}/v1/messages`));
    const provider = new AnthropicProvider();
    await provider.initialize({ apiKey: API_KEY, baseURL: BASE_URL, maxRetries: 1, streamCompletions: false });

    const error = await rejectionOf(
      provider.generateCompletion('claude-opus-5-5', [{ role: 'user', content: 'hi' }], {}),
    );

    expect((error as { code?: string }).code).toBe('NETWORK_ERROR');
    expect(error.message).not.toContain('gw-token');
  });
});
