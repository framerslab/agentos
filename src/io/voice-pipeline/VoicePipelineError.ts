/**
 * @module voice-pipeline/VoicePipelineError
 *
 * Structured error class for voice pipeline failures. Carries enough shape
 * for chains and circuit breakers to classify and react without stringly
 * matching error.message.
 */

import { hasQuotaBodySignal, QUOTA_STATUS_CODES } from '../../core/providers/quotaErrors.js';
import { describeReason, isError } from './describeReason.js';

/** A quota status (429, 402 or 456) standing as its own number in a message, as `HTTP 402` or `failed: 456 {...}`. */
const QUOTA_STATUS_PATTERN = new RegExp(`\\b(?:${[...QUOTA_STATUS_CODES].join('|')})\\b`);

/**
 * The class of a provider failure, as {@link VoicePipelineError.classifyError}
 * reads it:
 *
 * - `auth`: a 401 or 403, "unauthorized", "invalid api key" or "forbidden".
 *   Not retryable.
 * - `quota`: a throttle or a spent quota or credit. A 429, 402 or 456, "rate
 *   limit", "too many", or one of the quota body signals the key pools rotate
 *   on (`quota_exceeded`, `rate_limit_exceeded`, `insufficient_quota`,
 *   `overloaded_error`, `resource_exhausted`, `rate_limit`). Retryable.
 * - `service`: a 5xx, "internal server", "bad gateway", "gateway timeout" or
 *   "service unavailable". Retryable.
 * - `network`: an error named `TimeoutError`, which `AbortSignal.timeout()`
 *   rejects a request with, the codes `ECONNRESET`, `ETIMEDOUT` and
 *   `ENOTFOUND`, "socket hang up" or "network". Retryable.
 * - `unknown`: anything else, a caller's own abort (`AbortError`) included.
 */
export type HealthErrorClass =
  | 'auth'
  | 'quota'
  | 'network'
  | 'service'
  | 'unknown';

export interface VoicePipelineErrorInit {
  kind: 'stt' | 'tts' | 'transport';
  provider: string;
  errorClass: HealthErrorClass;
  message: string;
  cause?: unknown;
  retryable: boolean;
}

export class VoicePipelineError extends Error {
  readonly kind: VoicePipelineErrorInit['kind'];
  readonly provider: string;
  readonly errorClass: HealthErrorClass;
  readonly retryable: boolean;
  readonly cause?: unknown;

  constructor(init: VoicePipelineErrorInit) {
    super(init.message);
    this.name = 'VoicePipelineError';
    this.kind = init.kind;
    this.provider = init.provider;
    this.errorClass = init.errorClass;
    this.retryable = init.retryable;
    this.cause = init.cause;
  }

  /**
   * Best-effort classification of an arbitrary error into a voice-pipeline
   * error with a well-known errorClass ({@link HealthErrorClass} lists what
   * each class covers). The tests run in that list's order, so a 401 or 403 is
   * `auth` whatever else its message says. Preserves the original error as
   * `cause` so upstream inspection can still recover provider-specific
   * detail. A value that is no `Error` gets its message from
   * `describeReason()`, so one `String()` cannot print (an object without a
   * prototype, a revoked proxy) is named by its type, `an unprintable
   * object`, where formatting it would throw from the classification.
   */
  static classifyError(
    err: unknown,
    meta: { kind: VoicePipelineErrorInit['kind']; provider: string }
  ): VoicePipelineError {
    const raw = isError(err) ? err : new Error(describeReason(err));
    const msg = raw.message ?? '';
    const code = errorCode(err);

    let errorClass: HealthErrorClass = 'unknown';
    let retryable = true;

    if (/\b401\b|unauthori[sz]ed|invalid api key|forbidden|\b403\b/i.test(msg)) {
      errorClass = 'auth';
      retryable = false;
    } else if (QUOTA_STATUS_PATTERN.test(msg) || /rate.?limit|too many/i.test(msg) || hasQuotaBodySignal(msg)) {
      errorClass = 'quota';
      retryable = true;
    } else if (/\b5\d\d\b|internal server|bad gateway|gateway timeout|service unavailable/i.test(msg)) {
      errorClass = 'service';
      retryable = true;
    } else if (
      errorName(err) === 'TimeoutError' ||
      code === 'ECONNRESET' ||
      code === 'ETIMEDOUT' ||
      code === 'ENOTFOUND' ||
      /econnreset|etimedout|enotfound|socket hang up|network/i.test(msg)
    ) {
      errorClass = 'network';
      retryable = true;
    }

    return new VoicePipelineError({
      kind: meta.kind,
      provider: meta.provider,
      errorClass,
      message: msg || 'unknown voice pipeline error',
      cause: err,
      retryable,
    });
  }
}

/**
 * A failure value's `name`, such as `'TimeoutError'` for the rejection of a
 * request whose `AbortSignal.timeout()` fired, or `''` when it has none or
 * refuses the read.
 *
 * @param err - What a provider threw or rejected with.
 * @returns The value's `name`, or `''`.
 */
function errorName(err: unknown): unknown {
  try {
    return (err as { name?: unknown } | null | undefined)?.name ?? '';
  } catch {
    return '';
  }
}

/**
 * A failure value's `code`, such as Node's `'ECONNRESET'`, or `''` when it
 * has none or refuses the read: a revoked proxy throws on every property
 * read.
 *
 * @param err - What a provider threw or rejected with.
 * @returns The value's `code`, or `''`.
 */
function errorCode(err: unknown): unknown {
  try {
    return (err as { code?: unknown } | null | undefined)?.code ?? '';
  } catch {
    return '';
  }
}

/**
 * Aggregate thrown by `StreamingSTTChain` / `StreamingTTSChain` when every
 * candidate provider fails. Carries the per-provider error list so callers
 * can display a breakdown rather than a single confusing message.
 */
export class AggregateVoiceError extends Error {
  readonly attempts: VoicePipelineError[];

  constructor(attempts: VoicePipelineError[]) {
    const summary = attempts
      .map((a) => `${a.provider}: ${a.errorClass} \u2014 ${a.message}`)
      .join('; ');
    super(`All ${attempts.length} providers failed \u2014 ${summary}`);
    this.name = 'AggregateVoiceError';
    this.attempts = attempts;
  }
}
