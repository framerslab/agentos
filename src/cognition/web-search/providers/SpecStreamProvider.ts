/**
 * @module web-search/providers/SpecStreamProvider
 *
 * SpecStream web search provider. Returns ranked live web results; a passage excerpt, when the API sends one, is used
 * as the snippet. Full page content is left to providers that extract it (Firecrawl), so a deduplicated result keeps
 * that content whatever order the providers are registered in.
 */
import type { IWebSearchProvider, WebSearchResult } from '../types';
import { ApiKeyPool } from '../../../core/providers/ApiKeyPool.js';
import { drawSearchKey, settleSearchAnswer } from './searchKeyFailure.js';

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Web search provider backed by SpecStream's `/v1/web-search` API, returning ranked results whose snippet is the
 * passage excerpt when one is present.
 */
export class SpecStreamProvider implements IWebSearchProvider {
  readonly providerId = 'specstream' as const;
  readonly weight = 1.0;

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
    let payload: { data?: { sources?: Array<Record<string, unknown>> } } | null;
    try {
      const res = await fetch('https://api.specstream.ai/v1/web-search', {
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

      await settleSearchAnswer(this.keyPool, apiKey, res, 'SpecStream', startedAt);

      payload = (await res.json()) as {
        data?: { sources?: Array<Record<string, unknown>> };
      } | null;
    } finally {
      clearTimeout(timer);
    }

    const sources = payload?.data?.sources;
    if (!Array.isArray(sources)) return [];

    return sources.map((r) => ({
      url: String(r.url ?? ''),
      title: String(r.title ?? ''),
      snippet: typeof r.excerpt === 'string' && r.excerpt.length > 0 ? r.excerpt : String(r.snippet ?? ''),
    }));
  }
}
