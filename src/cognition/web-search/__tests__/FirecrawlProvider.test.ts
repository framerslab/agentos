/**
 * @file FirecrawlProvider.test.ts
 * A Firecrawl key the API rejects (401) or an unpaid account (402) is marked in the provider's pool and the search
 * throws, naming the status; the next search sends the other key; a 200 records the key as good; a pool whose every
 * key is out sends nothing. `fetch` is stubbed; nothing leaves the process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FirecrawlProvider } from '../providers/FirecrawlProvider';

const fetchMock = vi.fn();

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** The key each search carried in its Authorization header, in order. */
function keysSent(): string[] {
  return fetchMock.mock.calls.map(([, init]) => String(((init as RequestInit).headers as Record<string, string>).Authorization).replace(/^Bearer /, ''));
}

function poolOf(provider: FirecrawlProvider): { snapshot(): Array<Record<string, unknown>> } {
  return (provider as unknown as { keyPool: { snapshot(): Array<Record<string, unknown>> } }).keyPool;
}

// The body Firecrawl answered a made-up key with on 19 October 2026 (HTTP 401).
const unauthorized = { success: false, error: 'Unauthorized: Invalid token' };
const found = { success: true, data: [{ url: 'https://example.com/a', title: 'A', description: 'about a', markdown: '# A' }] };

describe('FirecrawlProvider key failures', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws on a rejected key and marks it, sends the other key next, and records a 200 as good', async () => {
    const provider = new FirecrawlProvider('fc-alpha-0001,fc-beta-0002');
    fetchMock.mockResolvedValueOnce(answer(401, unauthorized));
    await expect(provider.search('weather today')).rejects.toThrow('Firecrawl search failed (401)');
    expect(poolOf(provider).snapshot()[0]).toMatchObject({ status: 'failed', kind: 'auth', failures: 1 });

    fetchMock.mockResolvedValueOnce(answer(200, found));
    expect(await provider.search('weather today')).toEqual([{ url: 'https://example.com/a', title: 'A', snippet: 'about a', content: '# A' }]);
    expect(keysSent()).toEqual(['fc-alpha-0001', 'fc-beta-0002']);
    expect(poolOf(provider).snapshot()[1]).toMatchObject({ status: 'ok', failures: 0 });
  });

  it('takes the other key out on 402, then sends nothing once every key is out', async () => {
    const provider = new FirecrawlProvider('fc-alpha-0001,fc-beta-0002');
    fetchMock.mockResolvedValueOnce(answer(401, unauthorized));
    await expect(provider.search('weather today')).rejects.toThrow('Firecrawl search failed (401)');
    fetchMock.mockResolvedValueOnce(answer(402, { success: false, error: 'Payment required' }));
    await expect(provider.search('weather today')).rejects.toThrow('Firecrawl search failed (402)');
    expect(poolOf(provider).snapshot().map((s) => [s.status, s.kind])).toEqual([
      ['failed', 'auth'],
      ['failed', 'billing'],
    ]);
    await expect(provider.search('weather today')).rejects.toThrow('Firecrawl search: every API key is out of rotation');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
