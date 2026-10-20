/**
 * @file BraveProvider.test.ts
 * A Brave subscription token the API rejects (its HTTP 422 `SUBSCRIPTION_TOKEN_INVALID`) is marked in the provider's
 * pool and the search throws, naming the status, instead of resolving to no results; the next search sends the other
 * token; a 200 records the token as good; a 422 with another code is the request's fault; a throttle (429) rests the
 * token. `fetch` is stubbed; nothing leaves the process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BraveProvider } from '../providers/BraveProvider';

const fetchMock = vi.fn();

function answer(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** The token each search carried in its X-Subscription-Token header, in order. */
function tokensSent(): string[] {
  return fetchMock.mock.calls.map(([, init]) => String(((init as RequestInit).headers as Record<string, string>)['X-Subscription-Token']));
}

function poolOf(provider: BraveProvider): { snapshot(): Array<Record<string, unknown>> } {
  return (provider as unknown as { keyPool: { snapshot(): Array<Record<string, unknown>> } }).keyPool;
}

// The body Brave answered a made-up token with on 19 October 2026 (HTTP 422).
const invalidToken = {
  error: { code: 'SUBSCRIPTION_TOKEN_INVALID', detail: 'The provided subscription token is invalid.', meta: { component: 'authentication' }, status: 422 },
  type: 'ErrorResponse',
};
const found = { web: { results: [{ url: 'https://example.com/a', title: 'A', description: 'about a' }] } };

describe('BraveProvider key failures', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws on a rejected token (422 SUBSCRIPTION_TOKEN_INVALID) and marks it, sends the other token next, and records a 200 as good', async () => {
    const provider = new BraveProvider('brave-alpha-0001,brave-beta-0002');
    fetchMock.mockResolvedValueOnce(answer(422, invalidToken));
    await expect(provider.search('weather today')).rejects.toThrow('Brave search failed (422)');
    expect(poolOf(provider).snapshot()[0]).toMatchObject({ status: 'failed', kind: 'auth', failures: 1 });

    fetchMock.mockResolvedValueOnce(answer(200, found));
    expect(await provider.search('weather today')).toEqual([{ url: 'https://example.com/a', title: 'A', snippet: 'about a' }]);
    expect(tokensSent()).toEqual(['brave-alpha-0001', 'brave-beta-0002']);
    expect(poolOf(provider).snapshot()[1]).toMatchObject({ status: 'ok', failures: 0 });
  });

  it('leaves the token alone for a 422 with another code, and rests a throttled token', async () => {
    const provider = new BraveProvider('brave-alpha-0001,brave-beta-0002');
    fetchMock.mockResolvedValueOnce(answer(422, { error: { code: 'VALIDATION', detail: 'Unable to validate request parameter(s)', status: 422 }, type: 'ErrorResponse' }));
    await expect(provider.search('weather today')).rejects.toThrow('Brave search failed (422)');
    expect(poolOf(provider).snapshot()[0]).toMatchObject({ status: 'ok', failures: 0 });
    fetchMock.mockResolvedValueOnce(answer(429, { error: { code: 'RATE_LIMITED', detail: 'Request rate limit exceeded', status: 429 }, type: 'ErrorResponse' }));
    await expect(provider.search('weather today')).rejects.toThrow('Brave search failed (429)');
    expect(poolOf(provider).snapshot().filter((s) => s.status === 'resting')).toHaveLength(1);
  });

  it('keeps a 200 with no results as an empty list, with no change to the token', async () => {
    const provider = new BraveProvider('brave-only-0003');
    fetchMock.mockResolvedValueOnce(answer(200, { web: { results: [] } }));
    expect(await provider.search('weather today')).toEqual([]);
    expect(poolOf(provider).snapshot()[0]).toMatchObject({ status: 'ok', failures: 0 });
  });
});
