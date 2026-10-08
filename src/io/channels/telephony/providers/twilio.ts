/**
 * @fileoverview Twilio telephony provider for AgentOS voice calls.
 *
 * Implements {@link IVoiceCallProvider} using the Twilio REST API v2010-04-01.
 *
 * ## REST API contract
 *
 * | Operation      | Method | Endpoint                                          | Body format     |
 * |----------------|--------|---------------------------------------------------|-----------------|
 * | Initiate call  | POST   | `/2010-04-01/Accounts/{sid}/Calls.json`           | form-encoded    |
 * | Hangup call    | POST   | `/2010-04-01/Accounts/{sid}/Calls/{callSid}.json` | form-encoded    |
 * | Play TTS       | POST   | `/2010-04-01/Accounts/{sid}/Calls/{callSid}.json` | form-encoded    |
 *
 * All requests use HTTP Basic authentication: `Authorization: Basic base64(accountSid:authToken)`.
 * Request bodies are `application/x-www-form-urlencoded` (not JSON), which is
 * Twilio's legacy convention for the 2010-04-01 API.
 *
 * ## Webhook verification: HMAC-SHA1
 *
 * Twilio signs every webhook request using HMAC-SHA1. The verification algorithm:
 *
 * 1. Start with the **full request URL** (including scheme, host, path, and any query string).
 * 2. Parse the POST body as form-encoded key-value pairs.
 * 3. Sort the parameters by key name in case-sensitive code-unit order
 *    (Twilio's "Unix-style" sort; `CallSid` sorts before `Called`).
 * 4. Concatenate each key+value pair (no separator) directly to the URL string.
 * 5. Compute `HMAC-SHA1(authToken, concatenatedString)`.
 * 6. Base64-encode the HMAC digest.
 * 7. Compare the result with the `X-Twilio-Signature` request header in
 *    constant time.
 *
 * If the computed signature matches the header, the request is authentic.
 *
 * ## Event mapping table
 *
 * | Twilio `CallStatus` | Normalised `kind`    |
 * |---------------------|----------------------|
 * | `ringing`           | `call-ringing`       |
 * | `in-progress`       | `call-answered`      |
 * | `completed`         | `call-completed`     |
 * | `failed`            | `call-failed`        |
 * | `busy`              | `call-busy`          |
 * | `no-answer`         | `call-no-answer`     |
 * | `canceled`          | `call-hangup-user`   |
 * | (+ `Digits` param)  | `call-dtmf`          |
 *
 * @module @framers/agentos/voice/providers/twilio
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { parse as parseQueryString, stringify as stringifyQueryString } from 'node:querystring';

import type {
  IVoiceCallProvider,
  InitiateCallInput,
  InitiateCallResult,
  HangupCallInput,
  PlayTtsInput,
} from '../IVoiceCallProvider.js';

import type {
  WebhookContext,
  WebhookVerificationResult,
  WebhookParseResult,
  NormalizedCallEvent,
} from '../types.js';

// ============================================================================
// Config
// ============================================================================

/**
 * Configuration for {@link TwilioVoiceProvider}.
 */
export interface TwilioVoiceProviderConfig {
  /** Twilio Account SID (starts with "AC"). */
  accountSid: string;
  /** Twilio Auth Token (used for both API auth and webhook HMAC verification). */
  authToken: string;
  /**
   * Optional fetch implementation override -- inject a mock in tests.
   * Defaults to the global `fetch`.
   */
  fetchImpl?: typeof fetch;
}

// ============================================================================
// TwilioVoiceProvider
// ============================================================================

/**
 * Compares a computed signature with the received one in constant time. A
 * length mismatch is a plain mismatch.
 *
 * @param expected - The signature computed from the request.
 * @param received - The signature header value.
 * @returns Whether they are equal.
 */
function signaturesMatch(expected: string, received: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The form fields that decide which call event a webhook produces. */
const TWILIO_EVENT_FIELDS = ['CallSid', 'CallStatus', 'Digits'];

/**
 * A form field's value when it has exactly one. The signed string sorts a
 * repeated key's values, so their order in the request is not signed, and a
 * key repeated with different values has no value to trust.
 *
 * @param params - The webhook's form fields.
 * @param name - The field name.
 * @returns The value, or undefined when the field is absent or conflicting.
 */
function singleTwilioField(params: URLSearchParams, name: string): string | undefined {
  const values = params.getAll(name);
  return values.length > 0 && values.every((value) => value === values[0]) ? values[0] : undefined;
}

/**
 * The forms of a webhook URL that twilio-node's `validateRequest` checks,
 * because Twilio signs some requests with the port and some without: the URL
 * without its port, the URL with its port (the scheme's standard port when it
 * has none), and both of those with the query re-encoded by
 * `node:querystring`. The URL exactly as given comes first.
 *
 * @param url - The full URL Twilio requested.
 * @returns The distinct URL forms to try.
 */
function twilioUrlVariants(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [url];
  }
  const withoutPort = new URL(parsed);
  withoutPort.port = '';
  const portForms = [withoutPort.toString(), parsed.port ? parsed.toString() : withStandardPort(parsed)];
  return [...new Set([url, ...portForms, ...portForms.map(withLegacyQueryString)])];
}

/** The URL with `:443` (https) or `:80` after the host, which `URL` itself would drop. */
function withStandardPort(parsed: URL): string {
  const port = parsed.protocol === 'https:' ? ':443' : ':80';
  const credentials = parsed.username || parsed.password
    ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ''}@`
    : '';
  return `${parsed.protocol}//${credentials}${parsed.host}${port}${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/**
 * The URL with its query re-encoded by `node:querystring`, as twilio-node's
 * legacy check does. `maxKeys: 0` lifts the parser's default 1,000-entry
 * cap: with the cap, entries past the first 1,000 are dropped, so padding a
 * signed URL with empty `&` entries and an extra parameter would normalize
 * back to the signed URL and the extra parameter would pass unsigned.
 */
function withLegacyQueryString(url: string): string {
  const parsed = new URL(url);
  if (!parsed.search) return url;
  const query = parseQueryString(parsed.search.slice(1), '&', '=', { maxKeys: 0 });
  parsed.search = '';
  return `${parsed.toString()}?${stringifyQueryString(query)}`;
}

/**
 * Twilio voice call provider.
 *
 * Uses the Twilio REST API 2010-04-01 for outbound call control and
 * HMAC-SHA1 for inbound webhook signature verification.
 *
 * @example
 * ```typescript
 * const provider = new TwilioVoiceProvider({
 *   accountSid: process.env.TWILIO_ACCOUNT_SID!,
 *   authToken:  process.env.TWILIO_AUTH_TOKEN!,
 * });
 * ```
 */
export class TwilioVoiceProvider implements IVoiceCallProvider {
  /** Provider identifier, always `'twilio'`. */
  readonly name = 'twilio' as const;

  /** Immutable configuration snapshot. */
  private readonly config: TwilioVoiceProviderConfig;

  /** Base URL for the Twilio REST API (2010-04-01 version). */
  private readonly baseUrl: string;

  /** Pre-computed `Authorization: Basic ...` header value. */
  private readonly authHeader: string;

  /** HTTP fetch implementation (injectable for testing). */
  private readonly fetch: typeof fetch;

  /**
   * @param config - Twilio credentials and optional overrides.
   */
  constructor(config: TwilioVoiceProviderConfig) {
    this.config = config;
    this.baseUrl = 'https://api.twilio.com/2010-04-01';
    // Twilio uses HTTP Basic auth with accountSid:authToken.
    this.authHeader =
      'Basic ' +
      Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64');
    this.fetch = config.fetchImpl ?? globalThis.fetch;
  }

  // ── Webhook ───────────────────────────────────────────────────────────────

  /**
   * Verify an incoming Twilio webhook request using HMAC-SHA1.
   *
   * ## Algorithm (step by step)
   *
   * 1. Extract the `X-Twilio-Signature` header from the request.
   * 2. Parse the request body as URL-encoded form data.
   * 3. Sort the keys in case-sensitive code-unit order, as twilio-node's
   *    `getExpectedTwilioSignature` does. A locale-aware sort puts `Called`
   *    before `CallSid` and fails every real voice webhook.
   * 4. Build the signed string: start with the full URL, then append each
   *    key + value (no delimiters between pairs). A repeated key contributes
   *    each distinct value, sorted, so a webhook whose `CallSid`,
   *    `CallStatus` or `Digits` repeats with different values is refused.
   * 5. Compute `HMAC-SHA1` of the signed string using the auth token as the key.
   * 6. Base64-encode the digest and compare it to the header value.
   * 7. Repeat with the URL with and without its port, as twilio-node does
   *    (see {@link twilioUrlVariants}); any match is valid.
   *
   * @param ctx - Raw webhook request context.
   * @returns Verification result with `valid: true` if the signature matches.
   */
  verifyWebhook(ctx: WebhookContext): WebhookVerificationResult {
    const signature = ctx.headers['x-twilio-signature'];
    if (!signature || Array.isArray(signature)) {
      return { valid: false, error: 'Missing x-twilio-signature header' };
    }

    // Step 2-3: Parse form body, sort params into the signed suffix. Values
    // are grouped in one pass: getAll() per key would rescan the whole body
    // for every key, quadratic work on a request that is not yet verified.
    const valuesByKey = new Map<string, Set<string>>();
    for (const [key, value] of new URLSearchParams(ctx.body.toString())) {
      const values = valuesByKey.get(key);
      if (values) values.add(value);
      else valuesByKey.set(key, new Set([value]));
    }
    // Sorting makes the order of a repeated key's values unsigned, so a
    // webhook whose event fields repeat with different values is refused
    // instead of read in some order.
    if (TWILIO_EVENT_FIELDS.some((name) => (valuesByKey.get(name)?.size ?? 0) > 1)) {
      return { valid: false, error: 'Conflicting repeated event fields' };
    }
    let signedParams = '';
    for (const key of [...valuesByKey.keys()].sort()) {
      for (const value of [...valuesByKey.get(key)!].sort()) {
        signedParams += key + value;
      }
    }

    // Step 4-7: HMAC-SHA1 over each URL form + params, compare base64 digests.
    const valid = twilioUrlVariants(ctx.url).some((url) =>
      signaturesMatch(
        createHmac('sha1', this.config.authToken).update(url + signedParams).digest('base64'),
        signature,
      ),
    );
    return {
      valid,
      ...(valid ? {} : { error: 'Signature mismatch' }),
    };
  }

  /**
   * Parse a Twilio webhook body into normalized {@link NormalizedCallEvent}s.
   *
   * Twilio sends webhooks with a form-encoded body containing `CallSid`,
   * `CallStatus`, and optionally `Digits` (for DTMF input from `<Gather>`).
   * Each webhook may produce one or two events (status + optional DTMF).
   *
   * @param ctx - Raw webhook request context.
   * @returns Parsed result containing zero or more normalized events.
   */
  parseWebhookEvent(ctx: WebhookContext): WebhookParseResult {
    const params = new URLSearchParams(ctx.body.toString());
    const callSid = singleTwilioField(params, 'CallSid') ?? '';
    const callStatus = singleTwilioField(params, 'CallStatus') ?? '';
    const digits = singleTwilioField(params, 'Digits');

    const timestamp = Date.now();
    const events: NormalizedCallEvent[] = [];

    /** Helper: shared base fields with a unique event ID for idempotency. */
    const base = () => ({
      eventId: randomUUID(),
      providerCallId: callSid,
      timestamp,
    });

    // Map Twilio CallStatus values to normalized event kinds.
    switch (callStatus) {
      case 'ringing':
        events.push({ ...base(), kind: 'call-ringing' });
        break;
      case 'in-progress':
        events.push({ ...base(), kind: 'call-answered' });
        break;
      case 'completed':
        events.push({ ...base(), kind: 'call-completed' });
        break;
      case 'failed':
        events.push({ ...base(), kind: 'call-failed' });
        break;
      case 'busy':
        events.push({ ...base(), kind: 'call-busy' });
        break;
      case 'no-answer':
        events.push({ ...base(), kind: 'call-no-answer' });
        break;
      case 'canceled':
        // Twilio uses "canceled" when the caller hangs up before the callee answers.
        events.push({ ...base(), kind: 'call-hangup-user' });
        break;
      default:
        // initiated / queued / etc. -- no normalized event emitted.
        // These are transient Twilio-internal states that don't map to
        // meaningful call lifecycle events.
        break;
    }

    // DTMF digit input (from <Gather> TwiML verb callback).
    // This can co-occur with a CallStatus update in the same webhook.
    if (digits != null && digits !== '') {
      events.push({
        ...base(),
        kind: 'call-dtmf',
        digit: digits,
      });
    }

    return { events };
  }

  // ── Call Control ──────────────────────────────────────────────────────────

  /**
   * Initiate an outbound call via the Twilio Calls API.
   *
   * Posts to `/Accounts/{accountSid}/Calls.json` with a **form-encoded** body
   * (not JSON -- this is Twilio's 2010-era API convention). All four status
   * callback events (`initiated`, `ringing`, `answered`, `completed`) are
   * requested so the {@link CallManager} receives the full state progression.
   *
   * @param input - Call initiation parameters (from/to numbers, webhook URLs).
   * @returns Result containing the Twilio `CallSid` on success.
   * @throws Never throws; returns `{ success: false, error: '...' }` on failure.
   */
  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    const url = `${this.baseUrl}/Accounts/${this.config.accountSid}/Calls.json`;

    // Build form-encoded body. Twilio expects this format, not JSON.
    const body = [
      `To=${encodeURIComponent(input.toNumber)}`,
      `From=${encodeURIComponent(input.fromNumber)}`,
      `Url=${encodeURIComponent(input.webhookUrl)}`,
      `StatusCallback=${encodeURIComponent(input.statusCallbackUrl ?? '')}`,
      `StatusCallbackEvent=initiated`,
      `StatusCallbackEvent=ringing`,
      `StatusCallbackEvent=answered`,
      `StatusCallbackEvent=completed`,
    ].join('&');

    const response = await this.fetch(url, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => String(response.status));
      return { providerCallId: '', success: false, error: `Twilio error ${response.status}: ${text}` };
    }

    const data = (await response.json()) as { sid: string };
    return { providerCallId: data.sid, success: true };
  }

  /**
   * Hang up an active call by POSTing `Status=completed`.
   *
   * Twilio uses the same Calls resource endpoint for both querying and
   * modifying a call. Setting `Status=completed` instructs Twilio to
   * immediately terminate the call.
   *
   * @param input - Contains the Twilio `CallSid` to hang up.
   */
  async hangupCall(input: HangupCallInput): Promise<void> {
    const url = `${this.baseUrl}/Accounts/${this.config.accountSid}/Calls/${input.providerCallId}.json`;

    await this.fetch(url, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'Status=completed',
    });
  }

  /**
   * Inject TTS into a live call using a TwiML `<Say>` verb.
   *
   * Sends a `Twiml` form parameter containing a minimal `<Response><Say>`
   * document. Twilio will parse the TwiML, synthesise the speech, and play
   * it to the caller in real-time.
   *
   * The optional `voice` attribute maps to Twilio's built-in voice names
   * (e.g., `alice`, `Polly.Joanna`).
   *
   * @param input - TTS parameters (text, voice, call ID).
   */
  async playTts(input: PlayTtsInput): Promise<void> {
    const url = `${this.baseUrl}/Accounts/${this.config.accountSid}/Calls/${input.providerCallId}.json`;

    const voiceAttr = input.voice ? ` voice="${input.voice}"` : '';
    const twiml = `<Response><Say${voiceAttr}>${input.text}</Say></Response>`;

    await this.fetch(url, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `Twiml=${encodeURIComponent(twiml)}`,
    });
  }
}
