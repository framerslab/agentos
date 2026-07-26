import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AIModelProviderManager } from '../src/core/llm/providers/AIModelProviderManager';
import { YouComProvider } from '../src/core/llm/providers/implementations/YouComProvider';

type MockResponseInit = {
  ok?: boolean;
  status?: number;
  statusText?: string;
};

function mockResponse(body: unknown, init: MockResponseInit = {}): Response {
  const status = init.status ?? 200;
  const ok = init.ok ?? (status >= 200 && status < 300);
  return {
    ok,
    status,
    statusText: init.statusText ?? (ok ? 'OK' : 'Error'),
    json: async () => body,
  } as Response;
}

describe('YouComProvider Integration', () => {
  let provider: YouComProvider;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    provider = new YouComProvider();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    if (provider.isInitialized) {
      await provider.shutdown();
    }
    vi.unstubAllGlobals();
  });

  it('initializes successfully and exposes its provider metadata', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ results: {}, metadata: { query: 'test' } }));

    await provider.initialize({});

    expect(provider.isInitialized).toBe(true);
    expect(provider.providerId).toBe('youcom');
    expect(provider.defaultModelId).toBe('youcom-search');
  });

  it('lists available models', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ results: {}, metadata: { query: 'test' } }));

    await provider.initialize({});
    const models = await provider.listAvailableModels();

    expect(models).toHaveLength(2);
    expect(models[0].modelId).toBe('youcom-search');
    expect(models[0].displayName).toBe('You.com Web Search');
    expect(models[0].capabilities).toContain('search');
    expect(models[1].modelId).toBe('youcom-news');
  });

  it('normalizes search responses and uses the documented endpoint and auth header', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ results: {}, metadata: { query: 'test' } }))
      .mockResolvedValueOnce(
        mockResponse({
          results: {
            web: [
              {
                title: 'AgentOS docs',
                url: 'https://example.com/agentos',
                description: 'AgentOS docs overview',
                snippets: ['AgentOS docs overview', 'More detail'],
              },
            ],
            news: [
              {
                title: 'You.com news item',
                url: 'https://news.example.com/youcom',
                description: 'A recent You.com update',
                snippets: ['A recent You.com update'],
                published_at: '2026-07-26T10:00:00Z',
              },
            ],
          },
          metadata: { search_uuid: 'abc-123' },
        })
      );

    await provider.initialize({ apiKey: 'test-key' });
    const result = await provider.search('TypeScript AI agent frameworks', { count: 3 });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [requestInput, requestInit] = fetchMock.mock.calls[1];
    const requestUrl = new URL(String(requestInput));

    expect(`${requestUrl.origin}${requestUrl.pathname}`).toBe('https://ydc-index.io/v1/search');
    expect(requestUrl.searchParams.get('query')).toBe('TypeScript AI agent frameworks');
    expect(requestUrl.searchParams.get('count')).toBe('3');
    expect(requestUrl.searchParams.get('freshness')).toBeNull();
    expect(requestInit).toMatchObject({
      method: 'GET',
      headers: {
        'User-Agent': 'AgentOS/1.0 (YouComProvider)',
        Accept: 'application/json',
        'X-API-Key': 'test-key',
      },
    });

    expect(result.web).toEqual([
      {
        title: 'AgentOS docs',
        url: 'https://example.com/agentos',
        description: 'AgentOS docs overview',
        snippets: ['AgentOS docs overview', 'More detail'],
      },
    ]);
    expect(result.news).toEqual([
      {
        title: 'You.com news item',
        url: 'https://news.example.com/youcom',
        description: 'A recent You.com update',
        snippets: ['A recent You.com update'],
        published_at: '2026-07-26T10:00:00Z',
      },
    ]);
    expect(result.metadata).toEqual({ search_uuid: 'abc-123' });
  });

  it('defaults news searches to a freshness hint instead of sending an undocumented type parameter', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ results: {}, metadata: { query: 'test' } }))
      .mockResolvedValueOnce(mockResponse({ results: { news: [] }, metadata: {} }));

    await provider.initialize({});
    await provider.search('AI agent frameworks', { type: 'news', count: 5 });

    const requestUrl = new URL(String(fetchMock.mock.calls[1][0]));
    expect(requestUrl.searchParams.get('type')).toBeNull();
    expect(requestUrl.searchParams.get('freshness')).toBe('week');
  });

  it('reports unhealthy when the connectivity probe fails', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ results: {}, metadata: { query: 'test' } }))
      .mockResolvedValueOnce(mockResponse({ results: {}, metadata: {} }, { ok: false, status: 503, statusText: 'Service Unavailable' }));

    await provider.initialize({});
    const health = await provider.checkHealth();

    expect(health.isHealthy).toBe(false);
    expect(health.details).toEqual({ apiKeyConfigured: false });
  });

  it('rejects invalid explicit counts before issuing a request', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ results: {}, metadata: { query: 'test' } }));

    await provider.initialize({});
    await expect(provider.search('TypeScript AI agent frameworks', { count: 0 })).rejects.toThrow(
      'You.com search count must be an integer between 1 and 100.'
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws for unsupported completion generation', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ results: {}, metadata: { query: 'test' } }));

    await provider.initialize({});
    await expect(
      provider.generateCompletion('youcom-search', [{ role: 'user', content: 'Hello' }], {})
    ).rejects.toThrow('YouComProvider does not support text completion');
  });

  it('registers through the provider manager', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ results: {}, metadata: { query: 'test' } }));

    const manager = new AIModelProviderManager();
    await manager.initialize({
      providers: [
        {
          providerId: 'youcom',
          enabled: true,
          config: {},
        },
      ],
    });

    const resolved = manager.getProvider('youcom');

    expect(resolved).toBeDefined();
    expect(resolved?.providerId).toBe('youcom');
    expect(resolved?.defaultModelId).toBe('youcom-search');
  });
});
