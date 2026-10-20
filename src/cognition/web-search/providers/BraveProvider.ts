/**
 * @module web-search/providers/BraveProvider
 *
 * Brave Search API provider.
 */
import type { IWebSearchProvider, WebSearchResult } from '../types';
import { ApiKeyPool } from '../../../core/providers/ApiKeyPool.js';
import type { KeyFailureKind } from '../../../core/providers/quotaErrors.js';
import { drawSearchKey, errorCodeOf, settleSearchAnswer } from './searchKeyFailure.js';

/**
 * Brave's answer to a subscription token it does not accept: HTTP 422 with `error.code` `SUBSCRIPTION_TOKEN_INVALID`
 * (read 19 October 2026 with a made-up token). A 422 with any other code is the request's fault and leaves the key
 * alone; a 401, 402 and 429 read as the shared classifier reads them.
 */
function braveKeyFailure(status: number, body: string): KeyFailureKind | null {
  return status === 422 && errorCodeOf(body) === 'SUBSCRIPTION_TOKEN_INVALID' ? 'auth' : null;
}

export class BraveProvider implements IWebSearchProvider {
  readonly providerId = 'brave' as const;
  readonly weight = 1.0;

  private readonly keyPool: ApiKeyPool;

  constructor(apiKey: string) {
    this.keyPool = new ApiKeyPool(apiKey, { id: 'brave' });
  }

  isAvailable(): boolean {
    return this.keyPool.hasKeys;
  }

  /**
   * Searches with the next key of the pool. A rejected token (Brave's 422 `SUBSCRIPTION_TOKEN_INVALID`, a 401), an
   * unpaid account (402) or a throttle (429) marks the key and throws, naming the status, as does any other answer
   * that is not 2xx; the next search draws another key.
   */
  async search(query: string, limit: number = 5): Promise<WebSearchResult[]> {
    const apiKey = drawSearchKey(this.keyPool, 'Brave');
    const params = new URLSearchParams({ q: query, count: String(limit) });
    const startedAt = Date.now();
    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
      headers: { 'X-Subscription-Token': apiKey },
    });
    await settleSearchAnswer(this.keyPool, apiKey, res, 'Brave', startedAt, braveKeyFailure);

    const data = await res.json();
    return (data.web?.results ?? []).map((r: Record<string, unknown>) => ({
      url: String(r.url ?? ''),
      title: String(r.title ?? ''),
      snippet: String(r.description ?? ''),
    }));
  }
}
