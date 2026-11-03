/**
 * @module core/providers/keyProbe
 *
 * What one probe of an API key found. The LLM providers' `probeApiKey()`
 * sends the request (the lightest authenticated read, or the smallest
 * billable request for a key taken out for `billing`) and reads its answer
 * here: the verdict through {@link classifyKeyFailure}, the HTTP status, the
 * vendor's message, the model the request went to and the Retry-After. The
 * key pool keeps the verdict alone; `probeProviderKey()` reports the rest.
 */
import type { ProbeResult } from './ApiKeyPool.js';
import { classifyKeyFailure, retryAfterMs, type KeyFailureKind } from './quotaErrors.js';

/** How long a probe waits for its answer by default: 10 seconds. */
export const DEFAULT_KEY_PROBE_TIMEOUT_MS = 10_000;

/** The longest vendor message a probe answer keeps, in characters. */
const MAX_MESSAGE_LENGTH = 300;

/** What one probe sends, beyond the key. */
export interface KeyProbeOptions {
  /**
   * The kind of the key's last failure. `billing` sends the smallest billable request, since a models list can
   * answer 200 with no credit left; any other kind, or none, sends the lightest authenticated read.
   */
  kind?: KeyFailureKind;
  /** The API base the request goes to, as the provider's `baseURL` takes it. Default: the provider's configured base, else its own endpoint. */
  baseURL?: string;
  /** The model the billable request goes to. Default: the provider's default model, else the probe's fallback model. */
  model?: string;
  /** How long the probe waits for its answer, in milliseconds. Default: 10 seconds. */
  timeoutMs?: number;
  /** Ends the probe when it fires. */
  signal?: AbortSignal;
}

/** Why a probe had no answer to read. */
export type KeyProbeFailure = 'timeout' | 'aborted' | 'network' | 'no_model';

/** What one probe found. */
export interface KeyProbeAnswer {
  /** `ok`, the failure kind the answer still shows, or `unknown` (an answer the classifier does not read, or none). */
  verdict: ProbeResult;
  /** The HTTP status of the answer that decided the verdict; absent when no answer came. */
  status?: number;
  /** The vendor's error message (`error.message`, else `message`), whitespace collapsed, at most 300 characters. */
  message?: string;
  /** The model the billable request went to; absent on an authenticated read. */
  model?: string;
  /** The answer's Retry-After in milliseconds (bounded to one hour), when it sent one above zero. */
  retryAfterMs?: number;
  /** Why no answer decided the verdict: the timeout, the caller's abort, a failed connection, or no model to send to. */
  failure?: KeyProbeFailure;
  /** The error a failed connection threw, as text. */
  error?: string;
}

/** A probe's signal: its own deadline and the caller's signal together. */
export interface KeyProbeDeadline {
  readonly signal: AbortSignal;
  /** Whether the deadline ended the probe. */
  timedOut(): boolean;
  /** Whether the caller's signal ended the probe. */
  callerAborted(): boolean;
  /** Clears the timer and the listener on the caller's signal. */
  dispose(): void;
}

/**
 * Starts a probe's deadline: a signal that fires after `timeoutMs` (10 seconds by default) or when the caller's
 * signal fires, whichever comes first. A caller's signal that has already fired fires it at once.
 */
export function startKeyProbeDeadline(options: Pick<KeyProbeOptions, 'timeoutMs' | 'signal'> = {}): KeyProbeDeadline {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? DEFAULT_KEY_PROBE_TIMEOUT_MS);
  const caller = options.signal;
  const onAbort = () => controller.abort();
  if (caller?.aborted) controller.abort();
  else caller?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    callerAborted: () => !timedOut && caller?.aborted === true,
    dispose: () => {
      clearTimeout(timer);
      caller?.removeEventListener('abort', onAbort);
    },
  };
}

/** A header of an answer, tolerating an answer object without a Headers instance. */
function headerOf(response: Response, name: string): string | null {
  const headers = (response as { headers?: unknown }).headers;
  if (headers && typeof (headers as Headers).get === 'function') return (headers as Headers).get(name);
  return null;
}

/** The vendor's message from an error body: `error.message`, else a top-level `message`. */
export function vendorErrorMessage(body: string): string | undefined {
  if (!body) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const outer = parsed as Record<string, unknown>;
  const inner = outer.error && typeof outer.error === 'object' ? (outer.error as Record<string, unknown>) : undefined;
  const raw = typeof inner?.message === 'string' ? inner.message : typeof outer.message === 'string' ? outer.message : undefined;
  if (raw === undefined) return undefined;
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH - 3)}...` : text;
}

/**
 * Reads a probe's answer: `ok` on a 2xx, else the kind {@link classifyKeyFailure} names or `unknown`, with the
 * status, the vendor's message, the model and the Retry-After.
 */
export async function readKeyProbeAnswer(response: Response, model?: string): Promise<KeyProbeAnswer> {
  const status = typeof response.status === 'number' ? response.status : undefined;
  const base: KeyProbeAnswer = { verdict: 'ok', ...(status !== undefined ? { status } : {}), ...(model ? { model } : {}) };
  if (response.ok) return base;
  const text = typeof response.text === 'function' ? await response.text().catch(() => '') : '';
  const message = vendorErrorMessage(text);
  const retryAfter = retryAfterMs(headerOf(response, 'retry-after'));
  return {
    ...base,
    verdict: (status !== undefined ? classifyKeyFailure(status, text) : null) ?? 'unknown',
    ...(message ? { message } : {}),
    ...(retryAfter !== null && retryAfter > 0 ? { retryAfterMs: retryAfter } : {}),
  };
}

/** The answer of a probe that has no model to send its billable request to. */
export function noModelKeyProbeAnswer(): KeyProbeAnswer {
  return { verdict: 'unknown', failure: 'no_model' };
}

/** The answer of a probe whose request threw: the deadline, the caller's abort, or a failed connection. */
export function failedKeyProbeAnswer(error: unknown, deadline: KeyProbeDeadline): KeyProbeAnswer {
  if (deadline.timedOut()) return { verdict: 'unknown', failure: 'timeout' };
  if (deadline.callerAborted()) return { verdict: 'unknown', failure: 'aborted' };
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  const code = cause && typeof cause === 'object' && typeof (cause as { code?: unknown }).code === 'string' ? (cause as { code: string }).code : undefined;
  const text = error instanceof Error ? error.message : String(error);
  return { verdict: 'unknown', failure: 'network', error: code ? `${text} (${code})` : text };
}
