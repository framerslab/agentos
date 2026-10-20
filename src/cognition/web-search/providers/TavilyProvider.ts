/**
 * @module web-search/providers/TavilyProvider
 *
 * Tavily AI-optimized search provider.
 */
import type { IWebSearchProvider, WebSearchResult } from '../types';
import { ApiKeyPool } from '../../../core/providers/ApiKeyPool.js';
import type { KeyFailureKind } from '../../../core/providers/quotaErrors.js';
import { drawSearchKey, settleSearchAnswer } from './searchKeyFailure.js';

/**
 * Tavily's answers for a spent allowance: 432 when a key's or the plan's usage limit is reached, 433 when the
 * pay-as-you-go limit is (https://docs.tavily.com/documentation/api-reference/endpoint/search, read 19 October 2026).
 * Both hold until the plan or the limit is changed, so the key goes out as unpaid (`billing`) instead of resting for
 * a cooldown and failing again. A 401 (a wrong or missing key) and a 429 read as the shared classifier reads them.
 */
function tavilyKeyFailure(status: number): KeyFailureKind | null {
  return status === 432 || status === 433 ? 'billing' : null;
}

export class TavilyProvider implements IWebSearchProvider {
  readonly providerId = 'tavily' as const;
  readonly weight = 1.0;

  private readonly keyPool: ApiKeyPool;

  constructor(apiKey: string) {
    this.keyPool = new ApiKeyPool(apiKey, { id: 'tavily' });
  }

  isAvailable(): boolean {
    return this.keyPool.hasKeys;
  }

  /**
   * Searches with the next key of the pool. A rejected key (401) or a spent allowance (432, 433) marks the key and
   * throws, naming the status, as does any other answer that is not 2xx; the next search draws another key.
   */
  async search(query: string, limit: number = 5): Promise<WebSearchResult[]> {
    const apiKey = drawSearchKey(this.keyPool, 'Tavily');
    const startedAt = Date.now();
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: 'advanced',
        include_answer: false,
        include_raw_content: false,
        max_results: limit,
      }),
    });
    await settleSearchAnswer(this.keyPool, apiKey, res, 'Tavily', startedAt, tavilyKeyFailure);

    const data = await res.json();
    return (data.results ?? []).map((r: Record<string, unknown>) => ({
      url: String(r.url ?? ''),
      title: String(r.title ?? ''),
      snippet: String(r.content ?? ''),
      relevanceScore: typeof r.score === 'number' ? r.score : 0.5,
    }));
  }
}
