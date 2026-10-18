/**
 * @module core/providers/quotaErrors
 *
 * Cross-provider classification of the errors an API key can cause.
 *
 * `isQuotaError()` is the broad test the TTS, STT and web-search providers
 * use to rotate a key: quota and billing answers alike. `classifyKeyFailure()`
 * is the finer test the LLM providers use with {@link ApiKeyPool.markFailed}:
 * it names the kind of failure (quota, auth, billing) by the HTTP status first
 * and by the parsed error envelope second, never by a search of the raw body,
 * so a request that was itself invalid never takes a working key out of
 * rotation. `retryAfterMs()` normalizes a Retry-After header.
 */

const QUOTA_STATUS_CODES = new Set([429, 402, 456]);
const QUOTA_BODY_SIGNALS = [
  'quota_exceeded',
  'rate_limit_exceeded',
  'insufficient_quota',
  'overloaded_error',
  'resource_exhausted',
  'rate_limit',
];

/**
 * Whether an HTTP response signals a quota or billing exhaustion that a key
 * pool should treat as "rest this key": 429, 402 or 456, or a body naming one
 * of the providers' quota signals.
 */
export function isQuotaError(status: number, body: string): boolean {
  if (QUOTA_STATUS_CODES.has(status)) return true;
  if (!body) return false;
  const lower = body.toLowerCase();
  return QUOTA_BODY_SIGNALS.some((signal) => lower.includes(signal));
}

/** The kinds of failure a key can cause: a throttle or spent quota, a bad or revoked key, an unpaid account. */
export type KeyFailureKind = 'quota' | 'auth' | 'billing';

/** Anthropic's message when an organization's credit is gone (HTTP 400, type invalid_request_error). */
const CREDIT_BALANCE_PREFIX = 'your credit balance is too low';

interface ErrorEnvelope {
  type?: string;
  code?: string;
  message?: string;
  /** Google's `error.status` (INVALID_ARGUMENT, RESOURCE_EXHAUSTED, ...). */
  status?: string;
  /** The `reason` of each entry of Google's `error.details` (API_KEY_INVALID, ...). */
  reasons?: string[];
}

function lower(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

/** The provider's error envelope: `{ error: { type, code, message } }` or the object itself; null for a body that is not JSON. */
function envelopeOf(body: string): ErrorEnvelope | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const outer = parsed as Record<string, unknown>;
    const inner = outer.error && typeof outer.error === 'object' ? (outer.error as Record<string, unknown>) : outer;
    const details = Array.isArray(inner.details) ? inner.details : [];
    const reasons = details
      .map((detail) => (detail && typeof detail === 'object' ? lower((detail as Record<string, unknown>).reason) : ''))
      .filter((reason) => reason.length > 0);
    return { type: lower(inner.type), code: lower(inner.code), message: lower(inner.message), status: lower(inner.status), reasons };
  } catch {
    return null;
  }
}

/**
 * The kind of key failure an HTTP answer is, or null when the answer is not
 * the key's fault (a bad request, a missing model, a server error, a 403 for
 * a disallowed model or region).
 *
 * - 401: `auth`. 403: `auth` only for an envelope type `authentication_error`
 *   (Anthropic), a code `invalid_api_key` (OpenAI), or a message starting
 *   "Invalid authorization token" (Requesty's answer to a bad key, read 17 Oct
 *   2026). A `permission_error` or `insufficient_permissions` is a denial of a
 *   resource the key may not use (a model, a feature, a region), not a revoked
 *   key, and leaves the key in rotation.
 * - 402: `billing`. 429: `billing` when the envelope's type or code is
 *   `insufficient_quota` (OpenAI bills that way), else `quota`. 456: `quota`.
 * - 400: `billing` for Anthropic's credit-balance envelope (type
 *   `invalid_request_error`, a message starting "Your credit balance is too
 *   low"); `auth` for Google's invalid-key envelope (a `details` entry with
 *   reason `API_KEY_INVALID`, or the message "API key not valid", which the
 *   Gemini API answers with HTTP 400, read 17 Oct 2026); every other 400 is
 *   null.
 * - A body that is not JSON classifies by status alone.
 */
export function classifyKeyFailure(status: number, body: string): KeyFailureKind | null {
  const envelope = envelopeOf(body);
  const type = envelope?.type ?? '';
  const code = envelope?.code ?? '';
  const message = envelope?.message ?? '';
  const reasons = envelope?.reasons ?? [];
  switch (status) {
    case 401:
      return 'auth';
    case 403:
      // A permission_error or insufficient_permissions names a resource the
      // key may not use (a model, a feature), not a revoked key: left alone.
      return type === 'authentication_error' || code === 'invalid_api_key' || message.startsWith('invalid authorization token') ? 'auth' : null;
    case 402:
      return 'billing';
    case 429:
      return type === 'insufficient_quota' || code === 'insufficient_quota' ? 'billing' : 'quota';
    case 456:
      return 'quota';
    case 400:
      if (type === 'invalid_request_error' && message.startsWith(CREDIT_BALANCE_PREFIX)) return 'billing';
      if (reasons.includes('api_key_invalid') || message.startsWith('api key not valid')) return 'auth';
      return null;
    default:
      return null;
  }
}

/** The longest rest a Retry-After header may ask for, one hour. */
export const DEFAULT_MAX_RETRY_AFTER_MS = 60 * 60_000;

/**
 * A Retry-After header as milliseconds: delta-seconds (a whole non-negative
 * number) or an HTTP-date, bounded to `max`; null for a missing or malformed
 * header, so the caller falls back to its own backoff.
 */
export function retryAfterMs(
  header: string | null | undefined,
  now: number = Date.now(),
  max: number = DEFAULT_MAX_RETRY_AFTER_MS,
): number | null {
  if (header === null || header === undefined) return null;
  const value = header.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds)) return null;
    return Math.min(seconds * 1000, max);
  }
  // An HTTP-date (IMF-fixdate, RFC 850 or asctime) begins with a weekday name.
  if (!/^[A-Za-z]{3}/.test(value)) return null;
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  return Math.min(Math.max(date - now, 0), max);
}
