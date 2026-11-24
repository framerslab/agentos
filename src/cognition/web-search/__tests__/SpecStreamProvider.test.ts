/**
 * @file SpecStreamProvider.test.ts
 * A SpecStream key the API rejects (401) or an unpaid account (402) is marked in the provider's pool and the search
 * throws, naming the status; the next search sends the other key; a 200 records the key as good and maps sources with
 * excerpts; a pool whose every key is out sends nothing. `fetch` is stubbed; nothing leaves the process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpecStreamProvider } from '../providers/SpecStreamProvider';

const fetchMock = vi.fn();

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** The key each search carried in its Authorization header, in order. */
function keysSent(): string[] {
  return fetchMock.mock.calls.map(([, init]) =>
    String(((init as RequestInit).headers as Record<string, string>).Authorization).replace(/^Bearer /, ''),
  );
}

function poolOf(provider: SpecStreamProvider): { snapshot(): Array<Record<string, unknown>> } {
  return (provider as unknown as { keyPool: { snapshot(): Array<Record<string, unknown>> } }).keyPool;
}

const unauthorized = { error: { code: 'unauthorized', message: 'Invalid API key' } };
const found = {
  data: {
    sources: [
      {
        url: 'https://example.com/a',
        title: 'A',
        snippet: 'about a',
        excerpt: 'Full excerpt for a',
      },
    ],
  },
};

describe('SpecStreamProvider', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws on a rejected key and marks it, sends the other key next, and records a 200 as good', async () => {
    const provider = new SpecStreamProvider('ss-alpha-0001,ss-beta-0002');
    fetchMock.mockResolvedValueOnce(answer(401, unauthorized));
    await expect(provider.search('weather today')).rejects.toThrow('SpecStream search failed (401)');
    expect(poolOf(provider).snapshot()[0]).toMatchObject({ status: 'failed', kind: 'auth', failures: 1 });

    fetchMock.mockResolvedValueOnce(answer(200, found));
    expect(await provider.search('weather today', 7)).toEqual([
      {
        url: 'https://example.com/a',
        title: 'A',
        snippet: 'about a',
        content: 'Full excerpt for a',
      },
    ]);
    expect(keysSent()).toEqual(['ss-alpha-0001', 'ss-beta-0002']);
    expect(poolOf(provider).snapshot()[1]).toMatchObject({ status: 'ok', failures: 0 });

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://api.specstream.ai/v1/web-search');
    expect(init.method).toBe('POST');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toEqual({
      q: 'weather today',
      num: 7,
      passages: true,
    });
  });

  it('recovers a cooled-down key back to ok on a subsequent 200', async () => {
    const provider = new SpecStreamProvider('ss-alpha-0001');
    const pool = (
      provider as unknown as {
        keyPool: {
          markFailed(key: string, kind: 'quota', detail: { retryAfterMs: number; status: number }): void;
          snapshot(): Array<Record<string, unknown>>;
        };
      }
    ).keyPool;
    pool.markFailed('ss-alpha-0001', 'quota', { retryAfterMs: 0, status: 429 });
    expect(pool.snapshot()[0]).toMatchObject({ status: 'resting', kind: 'quota', failures: 0 });

    fetchMock.mockResolvedValueOnce(answer(200, found));
    await provider.search('weather today');
    expect(pool.snapshot()[0]).toMatchObject({ status: 'ok', failures: 0 });
  });

  it('takes the other key out on 402, then sends nothing once every key is out', async () => {
    const provider = new SpecStreamProvider('ss-alpha-0001,ss-beta-0002');
    fetchMock.mockResolvedValueOnce(answer(401, unauthorized));
    await expect(provider.search('weather today')).rejects.toThrow('SpecStream search failed (401)');
    fetchMock.mockResolvedValueOnce(answer(402, { error: { code: 'insufficient_balance' } }));
    await expect(provider.search('weather today')).rejects.toThrow('SpecStream search failed (402)');
    expect(poolOf(provider).snapshot().map((s) => [s.status, s.kind])).toEqual([
      ['failed', 'auth'],
      ['failed', 'billing'],
    ]);
    await expect(provider.search('weather today')).rejects.toThrow(
      'SpecStream search: every API key is out of rotation',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('omits content when excerpt is absent and returns [] when sources are missing', async () => {
    const provider = new SpecStreamProvider('ss-alpha-0001');
    fetchMock.mockResolvedValueOnce(
      answer(200, {
        data: {
          sources: [{ url: 'https://example.com/b', title: 'B', snippet: 'about b' }],
        },
      }),
    );
    expect(await provider.search('b')).toEqual([
      { url: 'https://example.com/b', title: 'B', snippet: 'about b', content: undefined },
    ]);

    fetchMock.mockResolvedValueOnce(answer(200, { data: {} }));
    expect(await provider.search('empty')).toEqual([]);
  });
});
