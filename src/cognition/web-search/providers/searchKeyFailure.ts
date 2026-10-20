/**
 * @module web-search/providers/searchKeyFailure
 *
 * What the web-search providers do with the key a search sends and the
 * answer it gets: a draw that finds no key (every key of a pool of several is
 * out) sends nothing and throws; a 2xx records the key as good; any other
 * answer marks the key when the answer is the key's fault (a rejected key, a
 * spent plan, a throttle) and throws an error that names the provider and the
 * status, so a revoked key or a spent plan is a failure the caller can see,
 * never an empty result list. The search providers have no probe: a key marked
 * for `auth` or `billing` returns by time, once its recheck delay has run
 * (30 minutes, doubling with each failure up to 6 hours), and a key marked
 * for `quota` rests for the server's Retry-After or the cooldown.
 */
import type { ApiKeyPool } from '../../../core/providers/ApiKeyPool.js';
import { classifyKeyFailure, retryAfterMs, type KeyFailureKind } from '../../../core/providers/quotaErrors.js';

/** A provider's own reading of an answer the shared classifier does not name; null leaves it to the classifier. */
export type SearchKeyFailure = (status: number, body: string) => KeyFailureKind | null;

/** The longest piece of an error body that goes into the thrown error's message. */
const MAX_ERROR_BODY_CHARS = 500;

/** The key one search sends; throws without a request when every key of a pool of several is out. */
export function drawSearchKey(pool: ApiKeyPool, providerName: string): string {
  const key = pool.next();
  if (key === '') throw new Error(`${providerName} search: every API key is out of rotation`);
  return key;
}

/**
 * Settles one search answer against the key that sent it. A 2xx records the
 * key as good. Any other status marks the key when its own reading or the
 * shared classifier names a kind (`at` is the request's start, so an older
 * answer never undoes a newer one) and throws an error naming the provider and
 * the status, with the start of the answer's body.
 */
export async function settleSearchAnswer(
  pool: ApiKeyPool,
  key: string,
  res: Response,
  providerName: string,
  startedAt: number,
  ownKind?: SearchKeyFailure,
): Promise<void> {
  if (res.ok) {
    pool.markSuccess(key, startedAt);
    return;
  }
  const text = typeof res.text === 'function' ? await res.text().catch(() => '') : '';
  const kind = ownKind?.(res.status, text) ?? classifyKeyFailure(res.status, text);
  if (kind) {
    const header = typeof res.headers?.get === 'function' ? res.headers.get('retry-after') : null;
    const rest = kind === 'quota' ? retryAfterMs(header) : null;
    pool.markFailed(key, kind, { status: res.status, at: startedAt, ...(rest !== null ? { retryAfterMs: rest } : {}) });
  }
  throw new Error(`${providerName} search failed (${res.status}): ${text.slice(0, MAX_ERROR_BODY_CHARS)}`);
}

/** The `error.code` of a JSON envelope `{ error: { code } }`, or '' for a body that is not one. */
export function errorCodeOf(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown } } | null;
    const code = parsed && typeof parsed === 'object' ? parsed.error?.code : undefined;
    return typeof code === 'string' ? code : '';
  } catch {
    return '';
  }
}

/** The top-level `message` of a JSON body `{ message }`, or '' for a body that is not one. */
export function messageOf(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown } | null;
    const message = parsed && typeof parsed === 'object' ? parsed.message : undefined;
    return typeof message === 'string' ? message : '';
  } catch {
    return '';
  }
}
