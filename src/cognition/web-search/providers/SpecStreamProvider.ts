/**
 * @module web-search/providers/SpecStreamProvider
 *
 * SpecStream web search provider with extracted page excerpts in one API call.
 * Returns ranked live web results and passage excerpts alongside snippets.
 * Weighted at 1.5x RRF like Firecrawl because results include extracted page text.
 */
import type { IWebSearchProvider, WebSearchResult } from '../types';
import { ApiKeyPool } from '../../../core/providers/ApiKeyPool.js';
import { drawSearchKey, settleSearchAnswer } from './searchKeyFailure.js';

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Web search provider backed by SpecStream's `/v1/web-search` API, returning ranked results and passage excerpts.
 */
export class SpecStreamProvider implements IWebSearchProvider {
  readonly providerId = 'specstream' as const;
  readonly weight = 1.5;

  private readonly keyPool: ApiKeyPool;

  constructor(apiKey: string) {
    this.keyPool = new ApiKeyPool(apiKey, { id: 'specstream' });
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
    const apiKey = drawSearchKey(this.keyPool, 'SpecStream');
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch('https://api.specstream.ai/v1/web-search', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          q: query,
          num: limit,
          passages: true,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    await settleSearchAnswer(this.keyPool, apiKey, res, 'SpecStream', startedAt);

    const payload = (await res.json()) as {
      data?: { sources?: Array<Record<string, unknown>> };
    } | null;
    const sources = payload?.data?.sources;
    if (!Array.isArray(sources)) return [];

    return sources.map((r) => ({
      url: String(r.url ?? ''),
      title: String(r.title ?? ''),
      snippet: String(r.snippet ?? ''),
      content: typeof r.excerpt === 'string' && r.excerpt.length > 0 ? r.excerpt : undefined,
    }));
  }
}
