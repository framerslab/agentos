/**
 * @file TavilyProvider.test.ts
 * A Tavily key the API rejects (401) or whose allowance is spent (432, 433) is marked in the provider's pool and the
 * search throws, naming the status, instead of resolving to no results; the next search sends the other key; a 200
 * records the key as good; a throttled key rests for the server's Retry-After; a pool whose every key is out sends
 * nothing. `fetch` is stubbed; nothing leaves the process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TavilyProvider } from '../providers/TavilyProvider';

const fetchMock = vi.fn();

/** An answer as Tavily sends it: a JSON body, a status and headers. */
function answer(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** The key each search carried in its body's `api_key`, in order. */
function keysSent(): string[] {
  return fetchMock.mock.calls.map(([, init]) => String(JSON.parse(String((init as RequestInit).body)).api_key));
}

function poolOf(provider: TavilyProvider): { snapshot(): Array<Record<string, unknown>> } {
  return (provider as unknown as { keyPool: { snapshot(): Array<Record<string, unknown>> } }).keyPool;
}

// The body Tavily answered a made-up key with on 19 October 2026 (HTTP 401).
const unauthorized = { detail: { error: 'Unauthorized: missing or invalid API key.' } };
const found = { results: [{ url: 'https://example.com/a', title: 'A', content: 'about a', score: 0.9 }] };

describe('TavilyProvider key failures', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws on a rejected key and marks it, sends the other key next, and records a 200 as good', async () => {
    const provider = new TavilyProvider('tvly-alpha-0001,tvly-beta-0002');
    fetchMock.mockResolvedValueOnce(answer(401, unauthorized));
    await expect(provider.search('weather today')).rejects.toThrow('Tavily search failed (401)');
    expect(poolOf(provider).snapshot()[0]).toMatchObject({ status: 'failed', kind: 'auth', failures: 1 });

    fetchMock.mockResolvedValueOnce(answer(200, found));
    expect(await provider.search('weather today')).toEqual([{ url: 'https://example.com/a', title: 'A', snippet: 'about a', relevanceScore: 0.9 }]);
    expect(keysSent()).toEqual(['tvly-alpha-0001', 'tvly-beta-0002']);
    const [a, b] = poolOf(provider).snapshot();
    expect(a).toMatchObject({ status: 'failed', kind: 'auth' });
    expect(b).toMatchObject({ status: 'ok', failures: 0 });
    expect(typeof b.lastOkAt).toBe('number');
  });

  it('takes a key out as unpaid on a spent allowance (432, 433), and sends nothing once every key is out', async () => {
    const provider = new TavilyProvider('tvly-alpha-0001,tvly-beta-0002');
    fetchMock.mockResolvedValueOnce(answer(432, { detail: { error: "This request exceeds your plan's set usage limit." } }));
    await expect(provider.search('weather today')).rejects.toThrow('Tavily search failed (432)');
    fetchMock.mockResolvedValueOnce(answer(433, { detail: { error: 'This request exceeds the pay-as-you-go limit.' } }));
    await expect(provider.search('weather today')).rejects.toThrow('Tavily search failed (433)');
    expect(poolOf(provider).snapshot().map((s) => [s.status, s.kind])).toEqual([
      ['failed', 'billing'],
      ['failed', 'billing'],
    ]);
    await expect(provider.search('weather today')).rejects.toThrow('Tavily search: every API key is out of rotation');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rests a throttled key for the server's Retry-After", async () => {
    const provider = new TavilyProvider('tvly-alpha-0001,tvly-beta-0002');
    const before = Date.now();
    fetchMock.mockResolvedValueOnce(answer(429, { detail: { error: 'Too many requests' } }, { 'retry-after': '7' }));
    await expect(provider.search('weather today')).rejects.toThrow('Tavily search failed (429)');
    const [a] = poolOf(provider).snapshot();
    expect(a).toMatchObject({ status: 'resting', kind: 'quota' });
    expect((a.until as number) - before).toBeGreaterThan(6000);
    expect((a.until as number) - before).toBeLessThanOrEqual(7100);
  });

  it("throws on the request's own fault (400) without marking the key, and keeps a 200 with no results as an empty list", async () => {
    const provider = new TavilyProvider('tvly-only-0003');
    fetchMock.mockResolvedValueOnce(answer(400, { detail: { error: 'Query is too short. Min query length is 2 characters.' } }));
    await expect(provider.search('q')).rejects.toThrow('Tavily search failed (400)');
    expect(poolOf(provider).snapshot()[0]).toMatchObject({ status: 'ok', failures: 0 });
    fetchMock.mockResolvedValueOnce(answer(200, { results: [] }));
    expect(await provider.search('weather today')).toEqual([]);
    expect(poolOf(provider).snapshot()[0]).toMatchObject({ status: 'ok', failures: 0 });
  });
});
