/**
 * @file probeProviderKey.ts
 * Whether one API key works: the billing probe its provider's key pool sends,
 * read as a state a health check can act on.
 *
 * The key pool takes a key out when an answer says it is unpaid, revoked or
 * throttled, and brings it back once a probe passes. `probeProviderKey()`
 * sends that same probe with a key of the caller's, the smallest billable
 * request of the provider (a models list can answer 200 with no credit left),
 * and reads the answer through `classifyKeyFailure()`:
 *
 * | State | The answer |
 * |---|---|
 * | `ok` | 2xx |
 * | `exhausted` | `billing`: no credit left, or a spend limit reached |
 * | `invalid` | `auth`: a bad, revoked or expired key |
 * | `throttled` | `quota`: a rate limit |
 * | `unknown` | anything else, or no answer |
 *
 * @example
 * ```ts
 * import { probeProviderKey } from '@framers/agentos';
 *
 * const { state, detail } = await probeProviderKey({ provider: 'anthropic', apiKey: process.env.ANTHROPIC_KEY_2! });
 * if (state === 'exhausted') console.warn(`key 2 is out of credit: ${detail}`);
 * ```
 */
import { AnthropicProvider } from '../core/llm/providers/implementations/AnthropicProvider.js';
import { GeminiProvider } from '../core/llm/providers/implementations/GeminiProvider.js';
import { OpenAIProvider } from '../core/llm/providers/implementations/OpenAIProvider.js';
import { OpenRouterProvider } from '../core/llm/providers/implementations/OpenRouterProvider.js';
import { RequestyProvider } from '../core/llm/providers/implementations/RequestyProvider.js';
import { keyFingerprint } from '../core/providers/ApiKeyPool.js';
import { DEFAULT_KEY_PROBE_TIMEOUT_MS, MAX_KEY_PROBE_TIMEOUT_MS, type KeyProbeAnswer, type KeyProbeOptions } from '../core/providers/keyProbe.js';

/** What a probe found a key to be. */
export type ProviderKeyState = 'ok' | 'exhausted' | 'invalid' | 'throttled' | 'unknown';

/** The providers `probeProviderKey()` has a probe for: the five whose key pools probe their failed keys. */
export const PROBEABLE_KEY_PROVIDERS = ['anthropic', 'openai', 'gemini', 'openrouter', 'requesty'] as const;

/** A provider `probeProviderKey()` has a probe for. */
export type ProbeableKeyProvider = (typeof PROBEABLE_KEY_PROVIDERS)[number];

/** Options for {@link probeProviderKey}. */
export interface ProbeProviderKeyOptions {
  /** The provider the key belongs to: `anthropic`, `openai`, `gemini`, `openrouter` or `requesty`. */
  provider: ProbeableKeyProvider;
  /** One API key, sent as given once trimmed. A comma-separated list is refused: probe each key on its own. */
  apiKey: string;
  /**
   * The model the billable request goes to. Default: Anthropic `claude-haiku-4-5-20251001`, Gemini
   * `gemini-2.5-flash`, OpenAI the first GPT chat model `GET /models` lists, else its first o-series model with a
   * price (never a Responses-only one), OpenRouter and Requesty the cheapest chat model their catalog lists with a price
   * above zero. A model the key may not use answers 403 or 404, which reads as
   * `unknown`, so name one the account can call.
   */
  model?: string;
  /**
   * The provider's API base, as its `baseURL` takes it (`https://api.anthropic.com`, `https://api.openai.com/v1`,
   * `https://generativelanguage.googleapis.com/v1beta`, `https://openrouter.ai/api/v1`, `https://router.requesty.ai/v1`
   * are the defaults). An empty or whitespace-only string is unset.
   */
  baseUrl?: string;
  /** How long the probe waits for its answers, in milliseconds, a positive finite number. Default: 10 seconds. */
  timeoutMs?: number;
  /** Ends the probe when it fires; the probe then reports `unknown`. */
  signal?: AbortSignal;
}

/** What {@link probeProviderKey} found. */
export interface ProbeProviderKeyResult {
  /** What the answer says of the key. */
  state: ProviderKeyState;
  /**
   * One line for a person: the state, the HTTP status and the vendor's message (`key rejected (HTTP 401): invalid
   * x-api-key`), or why there was no answer. The key never appears in it; the vendor's text has it replaced with
   * `[key]`, and a failed connection's error has the key and the base URL's credentials replaced with `[redacted]`.
   */
  detail: string;
  /** The provider probed. */
  provider: ProbeableKeyProvider;
  /** The key's fingerprint ({@link keyFingerprint}): which key this was, without the key. */
  fingerprint: string;
  /** The HTTP status of the answer that decided the state; absent when no answer came. */
  httpStatus?: number;
  /** The model the billable request went to; absent when no billable request was sent. */
  model?: string;
  /** The Retry-After the answer sent, in milliseconds (bounded to one hour). */
  retryAfterMs?: number;
}

/** One probe, by provider: a fresh provider instance, so no pool, configuration or environment key takes part. */
const PROBES: Record<ProbeableKeyProvider, (apiKey: string, options: KeyProbeOptions) => Promise<KeyProbeAnswer>> = {
  anthropic: (apiKey, options) => new AnthropicProvider().probeApiKey(apiKey, options),
  openai: (apiKey, options) => new OpenAIProvider().probeApiKey(apiKey, options),
  gemini: (apiKey, options) => new GeminiProvider().probeApiKey(apiKey, options),
  openrouter: (apiKey, options) => new OpenRouterProvider().probeApiKey(apiKey, options),
  requesty: (apiKey, options) => new RequestyProvider().probeApiKey(apiKey, options),
};

/** The state a probe verdict reads as. */
const STATE_OF_VERDICT: Record<KeyProbeAnswer['verdict'], ProviderKeyState> = {
  ok: 'ok',
  billing: 'exhausted',
  auth: 'invalid',
  quota: 'throttled',
  unknown: 'unknown',
};

/** How a detail line names each state. */
const LABEL_OF_STATE: Record<Exclude<ProviderKeyState, 'ok'>, string> = {
  exhausted: 'no credit or a spend limit reached',
  invalid: 'key rejected',
  throttled: 'rate limited',
  unknown: 'no verdict',
};

/** Every occurrence of the key in a text, replaced with `[key]`. */
function withoutKey(text: string, apiKey: string): string {
  return text.split(apiKey).join('[key]');
}

/** The detail line of a probe's answer. */
function detailOf(state: ProviderKeyState, answer: KeyProbeAnswer, timeoutMs: number): string {
  switch (answer.failure) {
    case 'timeout':
      return `no answer within ${timeoutMs} ms`;
    case 'aborted':
      return 'aborted by the caller';
    case 'network':
      return `request failed: ${answer.error ?? 'no answer'}`;
    case 'no_model':
      return 'no model to send the billable request to; pass `model`';
    default:
      break;
  }
  const status = answer.status !== undefined ? `HTTP ${answer.status}` : 'no status';
  if (state === 'ok') return `key accepted: ${status}${answer.model ? ` on ${answer.model}` : ''}`;
  const retry = answer.retryAfterMs !== undefined ? `; retry after ${Math.ceil(answer.retryAfterMs / 1000)} s` : '';
  return `${LABEL_OF_STATE[state]} (${status})${answer.message ? `: ${answer.message}` : ''}${retry}`;
}

/**
 * Probes one API key with its provider's billing probe, the smallest billable request, and says what the answer
 * shows: `ok`, `exhausted` (no credit, or a spend limit reached), `invalid` (a bad, revoked or expired key),
 * `throttled` (a rate limit) or `unknown` (any other answer, or none). The answer is read by
 * `classifyKeyFailure()`, as a request's is in the key pool. A probe costs one request of one or a few output
 * tokens on a passing key.
 *
 * No key is read from the environment and no pool takes part: the probe sends the key it is given to the provider's
 * own endpoint, or to `baseUrl`. The one variable that changes what it sends is `AGENTOS_OPERATION_ID_HEADER`: on
 * Anthropic, OpenAI and OpenRouter it names the header each of the probe's requests carries an operation id in. It
 * never throws for an answer; it throws before any request for a provider it has no probe for (`RangeError`), a
 * missing key or a comma-separated list (`TypeError`), a `timeoutMs` that is not a positive finite number
 * (`RangeError`), and an `AGENTOS_OPERATION_ID_HEADER` those three providers refuse as a header name (`RangeError`).
 *
 * @param options The provider, the key, and optionally the model, the base URL, the timeout and an abort signal.
 * @returns The state, a detail line without the key, the key's fingerprint, and the status, model and Retry-After
 *   when the answer had them.
 *
 * @example
 * ```ts
 * const keys = process.env.ANTHROPIC_API_KEY!.split(',').map((key) => key.trim()).filter(Boolean);
 * const states = await Promise.all(keys.map((apiKey) => probeProviderKey({ provider: 'anthropic', apiKey })));
 * // [{ state: 'exhausted', detail: 'no credit or a spend limit reached (HTTP 400): Your credit balance is too low ...', ... },
 * //  { state: 'ok', detail: 'key accepted: HTTP 200 on claude-haiku-4-5-20251001', ... }]
 * ```
 */
export async function probeProviderKey(options: ProbeProviderKeyOptions): Promise<ProbeProviderKeyResult> {
  const provider = options.provider;
  if (!Object.prototype.hasOwnProperty.call(PROBES, provider)) {
    throw new RangeError(`probeProviderKey: no key probe for provider "${String(provider)}"; it probes ${PROBEABLE_KEY_PROVIDERS.join(', ')}.`);
  }
  const apiKey = typeof options.apiKey === 'string' ? options.apiKey.trim() : '';
  if (!apiKey) throw new TypeError('probeProviderKey: apiKey must be a non-empty string.');
  if (apiKey.includes(',')) throw new TypeError('probeProviderKey: apiKey holds a comma-separated list; probe each key on its own.');
  const timeoutMs = options.timeoutMs ?? DEFAULT_KEY_PROBE_TIMEOUT_MS;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`probeProviderKey: timeoutMs must be a positive finite number of milliseconds (got ${String(options.timeoutMs)}).`);
  }
  const fingerprint = keyFingerprint(apiKey);
  if (options.signal?.aborted) {
    return { state: 'unknown', detail: 'aborted by the caller', provider, fingerprint };
  }
  const baseURL = typeof options.baseUrl === 'string' && options.baseUrl.trim() ? options.baseUrl.trim().replace(/\/+$/, '') : undefined;
  const answer = await PROBES[provider](apiKey, {
    kind: 'billing',
    ...(baseURL ? { baseURL } : {}),
    ...(options.model ? { model: options.model } : {}),
    timeoutMs: Math.min(Math.ceil(timeoutMs), MAX_KEY_PROBE_TIMEOUT_MS),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const state = STATE_OF_VERDICT[answer.verdict];
  return {
    state,
    detail: withoutKey(detailOf(state, answer, timeoutMs), apiKey),
    provider,
    fingerprint,
    ...(answer.status !== undefined ? { httpStatus: answer.status } : {}),
    ...(answer.model ? { model: answer.model } : {}),
    ...(answer.retryAfterMs !== undefined ? { retryAfterMs: answer.retryAfterMs } : {}),
  };
}
