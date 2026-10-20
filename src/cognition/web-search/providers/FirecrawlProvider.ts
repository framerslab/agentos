/**
 * @module web-search/providers/FirecrawlProvider
 *
 * Firecrawl search provider — search + scrape in one API call.
 * Returns full extracted markdown content alongside search results.
 * Primary provider with 1.5x RRF weight.
 */
import type { IWebSearchProvider, WebSearchResult } from '../types';
import { ApiKeyPool } from '../../../core/providers/ApiKeyPool.js';
import { drawSearchKey, settleSearchAnswer } from './searchKeyFailure.js';

export class FirecrawlProvider implements IWebSearchProvider {
  readonly providerId = 'firecrawl' as const;
  readonly weight = 1.5;

  private readonly keyPool: ApiKeyPool;

  constructor(apiKey: string) {
    this.keyPool = new ApiKeyPool(apiKey, { id: 'firecrawl' });
  }

  isAvailable(): boolean {
    return this.keyPool.hasKeys;
  }

  /**
   * Searches with the next key of the pool. A rejected key (401), an unpaid account (402) or a throttle (429) marks
   * the key and throws, naming the status, as does any other answer that is not 2xx; the next search draws another
   * key.
   */
  async search(query: string, limit: number = 5): Promise<WebSearchResult[]> {
    const apiKey = drawSearchKey(this.keyPool, 'Firecrawl');
    const startedAt = Date.now();
    const res = await fetch('https://api.firecrawl.dev/v1/search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        limit,
        scrapeOptions: { formats: ['markdown'], onlyMainContent: true },
      }),
    });

    await settleSearchAnswer(this.keyPool, apiKey, res, 'Firecrawl', startedAt);

    const data = await res.json();
    if (!data.success || !Array.isArray(data.data)) return [];

    return data.data.map((r: Record<string, unknown>) => ({
      url: String(r.url ?? (r.metadata as Record<string, unknown>)?.sourceURL ?? ''),
      title: String(r.title ?? (r.metadata as Record<string, unknown>)?.title ?? ''),
      snippet: String(r.description ?? (r.metadata as Record<string, unknown>)?.description ?? ''),
      content: typeof r.markdown === 'string' ? r.markdown : undefined,
    }));
  }
}
