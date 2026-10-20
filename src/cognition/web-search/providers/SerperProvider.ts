/**
 * @module web-search/providers/SerperProvider
 *
 * Serper (Google Search) provider.
 */
import type { IWebSearchProvider, WebSearchResult } from '../types';
import { ApiKeyPool } from '../../../core/providers/ApiKeyPool.js';
import type { KeyFailureKind } from '../../../core/providers/quotaErrors.js';
import { drawSearchKey, messageOf, settleSearchAnswer } from './searchKeyFailure.js';

/**
 * Serper's answer to a key it does not accept: HTTP 403 with the body `{"message":"Unauthorized.","statusCode":403}`
 * (read 19 October 2026 with a made-up key). The shared classifier leaves a 403 alone unless its envelope names the
 * key, since a 403 can also deny a resource; this message names the key. A 401, 402 and 429 read as the classifier
 * reads them.
 */
function serperKeyFailure(status: number, body: string): KeyFailureKind | null {
  return status === 403 && messageOf(body).toLowerCase().startsWith('unauthorized') ? 'auth' : null;
}

export class SerperProvider implements IWebSearchProvider {
  readonly providerId = 'serper' as const;
  readonly weight = 1.0;

  private readonly keyPool: ApiKeyPool;

  constructor(apiKey: string) {
    this.keyPool = new ApiKeyPool(apiKey, { id: 'serper' });
  }

  isAvailable(): boolean {
    return this.keyPool.hasKeys;
  }

  /**
   * Searches with the next key of the pool. A rejected key (Serper's 403 "Unauthorized.", a 401), an unpaid account
   * (402) or a throttle (429) marks the key and throws, naming the status, as does any other answer that is not 2xx;
   * the next search draws another key.
   */
  async search(query: string, limit: number = 5): Promise<WebSearchResult[]> {
    const apiKey = drawSearchKey(this.keyPool, 'Serper');
    const startedAt = Date.now();
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: query, num: limit }),
    });
    await settleSearchAnswer(this.keyPool, apiKey, res, 'Serper', startedAt, serperKeyFailure);

    const data = await res.json();
    return (data.organic ?? []).map((r: Record<string, unknown>) => ({
      url: String(r.link ?? ''),
      title: String(r.title ?? ''),
      snippet: String(r.snippet ?? ''),
    }));
  }
}
