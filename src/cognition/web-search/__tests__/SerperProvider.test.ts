/**
 * @file SerperProvider.test.ts
 * A Serper key the API rejects (its HTTP 403 "Unauthorized.") is marked in the provider's pool and the search throws,
 * naming the status, instead of resolving to no results; the next search sends the other key; a 200 records the key
 * as good; an unpaid account (402) takes the key out; a throttle (429) rests it. `fetch` is stubbed; nothing leaves
 * the process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SerperProvider } from '../providers/SerperProvider';

const fetchMock = vi.fn();

function answer(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** The key each search carried in its X-API-KEY header, in order. */
function keysSent(): string[] {
  return fetchMock.mock.calls.map(([, init]) => String(((init as RequestInit).headers as Record<string, string>)['X-API-KEY']));
}

function poolOf(provider: SerperProvider): { snapshot(): Array<Record<string, unknown>> } {
  return (provider as unknown as { keyPool: { snapshot(): Array<Record<string, unknown>> } }).keyPool;
}

// The body Serper answered a made-up key with on 19 October 2026 (HTTP 403).
const unauthorized = { message: 'Unauthorized.', statusCode: 403 };
const found = { organic: [{ link: 'https://example.com/a', title: 'A', snippet: 'about a' }] };

describe('SerperProvider key failures', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws on a rejected key (403 "Unauthorized.") and marks it, sends the other key next, and records a 200 as good', async () => {
    const provider = new SerperProvider('serper-alpha-0001,serper-beta-0002');
    fetchMock.mockResolvedValueOnce(answer(403, unauthorized));
    await expect(provider.search('weather today')).rejects.toThrow('Serper search failed (403)');
    expect(poolOf(provider).snapshot()[0]).toMatchObject({ status: 'failed', kind: 'auth', failures: 1 });

    fetchMock.mockResolvedValueOnce(answer(200, found));
    expect(await provider.search('weather today')).toEqual([{ url: 'https://example.com/a', title: 'A', snippet: 'about a' }]);
    expect(keysSent()).toEqual(['serper-alpha-0001', 'serper-beta-0002']);
    expect(poolOf(provider).snapshot()[1]).toMatchObject({ status: 'ok', failures: 0 });
  });

  it('takes a key out on 402 and rests a throttled key, and sends nothing once every key is out', async () => {
    const provider = new SerperProvider('serper-alpha-0001,serper-beta-0002');
    fetchMock.mockResolvedValueOnce(answer(402, { message: 'Payment required', statusCode: 402 }));
    await expect(provider.search('weather today')).rejects.toThrow('Serper search failed (402)');
    fetchMock.mockResolvedValueOnce(answer(429, { message: 'Too many requests', statusCode: 429 }));
    await expect(provider.search('weather today')).rejects.toThrow('Serper search failed (429)');
    expect(poolOf(provider).snapshot().map((s) => [s.status, s.kind])).toEqual([
      ['failed', 'billing'],
      ['resting', 'quota'],
    ]);
  });

  it('leaves the key alone for a 403 that does not name it, and keeps a 200 with no results as an empty list', async () => {
    const provider = new SerperProvider('serper-only-0003');
    fetchMock.mockResolvedValueOnce(answer(403, { message: 'Forbidden: this plan does not include the endpoint', statusCode: 403 }));
    await expect(provider.search('weather today')).rejects.toThrow('Serper search failed (403)');
    expect(poolOf(provider).snapshot()[0]).toMatchObject({ status: 'ok', failures: 0 });
    fetchMock.mockResolvedValueOnce(answer(200, { organic: [] }));
    expect(await provider.search('weather today')).toEqual([]);
    expect(poolOf(provider).snapshot()[0]).toMatchObject({ status: 'ok', failures: 0 });
  });
});
