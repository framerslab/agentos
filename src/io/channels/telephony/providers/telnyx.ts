/**
 * @fileoverview Telnyx telephony provider for AgentOS voice calls.
 *
 * Implements {@link IVoiceCallProvider} using the Telnyx Call Control v2 API.
 *
 * ## REST API contract
 *
 * | Operation      | Method | Endpoint                                 | Body format |
 * |----------------|--------|------------------------------------------|-------------|
 * | Initiate call  | POST   | `/v2/calls`                              | JSON        |
 * | Hangup call    | POST   | `/v2/calls/{id}/actions/hangup`          | JSON        |
 * | Play TTS       | POST   | `/v2/calls/{id}/actions/speak`           | JSON        |
 * | Start stream   | POST   | `/v2/calls/{id}/actions/streaming_start` | JSON        |
 *
 * All requests use Bearer token authentication: `Authorization: Bearer {apiKey}`.
 * Request bodies are JSON (unlike Twilio's form-encoded convention).
 *
 * ## Streaming after `call.answered`
 *
 * Telnyx requires a two-step flow for media streaming:
 * 1. Initiate the call via `POST /v2/calls` with a `webhook_url`.
 * 2. When the `call.answered` webhook fires, issue a separate
 *    `POST /v2/calls/{id}/actions/streaming_start` request with the
 *    WebSocket URL. This is handled by the CallManager, not by this provider.
 *
 * ## Webhook verification: Ed25519
 *
 * Telnyx signs webhooks using Ed25519 public key cryptography:
 *
 * 1. Telnyx generates a signed payload: `{timestamp}|{rawBody}`.
 * 2. The signature is computed with the account's Ed25519 private key.
 * 3. The Telnyx portal shows the public key as base64 of its 32 raw bytes,
 *    the form telnyx-node passes to tweetnacl. A base64 DER SPKI blob is
 *    accepted too.
 * 4. Headers: `Telnyx-Timestamp` (the timestamp) and
 *    `Telnyx-Signature-Ed25519` (base64-encoded Ed25519 signature), as
 *    telnyx-node and telnyx-python read them. The `X-` prefixed names are
 *    read as well.
 * 5. Verification: decode the signature from base64, construct the payload
 *    string `{timestamp}|{body}`, and verify using `crypto.verify()` with
 *    the key as DER SPKI. As in telnyx-node, a timestamp more than 300
 *    seconds old is rejected.
 *
 * When no public key is configured, verification is skipped (returns
 * `valid: true`) to support development environments.
 *
 * ## Event mapping table (hangup_cause)
 *
 * | Telnyx `event_type`              | `hangup_cause`            | Normalised `kind`    |
 * |----------------------------------|---------------------------|----------------------|
 * | `call.initiated`                 | --                        | `call-ringing`       |
 * | `call.answered`                  | --                        | `call-answered`      |
 * | `call.hangup`                    | `normal_clearing`         | `call-hangup-user`   |
 * | `call.hangup`                    | `user_busy`               | `call-hangup-user`   |
 * | `call.hangup`                    | `originator_cancel`       | `call-hangup-user`   |
 * | `call.hangup`                    | (anything else)           | `call-completed`     |
 * | `call.dtmf.received`             | --                        | `call-dtmf`          |
 * | `call.machine.detection.ended`   | result=`machine`          | `call-voicemail`     |
 * | `call.machine.detection.ended`   | result=`human`            | (no event)           |
 *
 * @module @framers/agentos/voice/providers/telnyx
 */

import { verify } from 'node:crypto';
import { randomUUID } from 'node:crypto';

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
 * Configuration for {@link TelnyxVoiceProvider}.
 */
export interface TelnyxVoiceProviderConfig {
  /** Telnyx API key (starts with "KEY"). */
  apiKey: string;
  /** Telnyx connection/application ID for call routing. */
  connectionId: string;
  /**
   * Ed25519 public key for webhook verification, base64-encoded: the 32-byte
   * key as the Telnyx portal shows it, or a DER SPKI blob.
   *
   * When omitted, webhook verification is skipped (always returns `valid: true`).
   * This is acceptable for development but should always be set in production.
   */
  publicKey?: string;
  /**
   * How old a webhook's `Telnyx-Timestamp` may be, in seconds, before it is
   * rejected as a replay. Defaults to 300, telnyx-node's default; 0 turns
   * the check off.
   */
  webhookToleranceSec?: number;
  /**
   * Optional fetch implementation override -- inject a mock in tests.
   * Defaults to the global `fetch`.
   */
  fetchImpl?: typeof fetch;
}

// ============================================================================
// Internal types
// ============================================================================

/**
 * Shape of Telnyx webhook payload.
 *
 * Telnyx wraps all webhook data in a `data` envelope containing the
 * `event_type` discriminant and a `payload` object with call-specific fields.
 */
interface TelnyxWebhookPayload {
  data: {
    event_type: string;
    payload: {
      call_control_id?: string;
      call_session_id?: string;
      /** Reason the call was terminated (e.g., `normal_clearing`, `user_busy`). */
      hangup_cause?: string;
      /** DTMF digit pressed by the caller. */
      digit?: string;
      /** AMD result: `'machine'` or `'human'`. */
      result?: string;
      [key: string]: unknown;
    };
  };
}

// ============================================================================
// TelnyxVoiceProvider
// ============================================================================

/** DER header of an Ed25519 SubjectPublicKeyInfo; the 32 raw key bytes follow it. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Default webhook replay window in seconds, telnyx-node's `DEFAULT_TOLERANCE`. */
const DEFAULT_WEBHOOK_TOLERANCE_SEC = 300;

/**
 * The configured public key as DER SPKI. A 32-byte key (the portal's form)
 * gets the Ed25519 SPKI header; anything else is taken as DER SPKI already.
 *
 * @param publicKey - The base64 public key from the config.
 * @returns The key bytes for `crypto.verify()` with `format: 'der'`.
 */
function telnyxPublicKeyDer(publicKey: string): Buffer {
  const bytes = Buffer.from(publicKey, 'base64');
  return bytes.length === 32 ? Buffer.concat([ED25519_SPKI_PREFIX, bytes]) : bytes;
}

/**
 * Telnyx voice call provider.
 *
 * Uses the Telnyx Call Control v2 API for outbound call initiation and
 * in-call actions (hangup, speak). Webhook verification uses Ed25519 public
 * key signing.
 *
 * @example
 * ```typescript
 * const provider = new TelnyxVoiceProvider({
 *   apiKey:       process.env.TELNYX_API_KEY!,
 *   connectionId: process.env.TELNYX_CONNECTION_ID!,
 *   publicKey:    process.env.TELNYX_PUBLIC_KEY,   // optional
 * });
 * ```
 */
export class TelnyxVoiceProvider implements IVoiceCallProvider {
  /** Provider identifier, always `'telnyx'`. */
  readonly name = 'telnyx' as const;

  /** Immutable configuration snapshot. */
  private readonly config: TelnyxVoiceProviderConfig;

  /** Base URL for the Telnyx v2 API. */
  private readonly baseUrl: string;

  /** Pre-computed `Authorization: Bearer ...` header value. */
  private readonly authHeader: string;

  /** HTTP fetch implementation (injectable for testing). */
  private readonly fetch: typeof fetch;

  /**
   * @param config - Telnyx credentials and optional overrides.
   */
  constructor(config: TelnyxVoiceProviderConfig) {
    this.config = config;
    this.baseUrl = 'https://api.telnyx.com/v2';
    this.authHeader = `Bearer ${config.apiKey}`;
    this.fetch = config.fetchImpl ?? globalThis.fetch;
  }

  // ── Webhook ───────────────────────────────────────────────────────────────

  /**
   * Verify an incoming Telnyx webhook using Ed25519 signature verification.
   *
   * ## Algorithm (step by step)
   *
   * 1. If no public key is configured, skip verification (return `valid: true`).
   *    This supports development environments without cryptographic setup.
   * 2. Extract the `Telnyx-Timestamp` and `Telnyx-Signature-Ed25519` headers
   *    (or their `X-` prefixed forms).
   * 3. Decode the signature from base64 into a raw byte Buffer.
   * 4. Construct the signed payload: `"{timestamp}|{rawBody}"`.
   * 5. Decode the public key from base64 into DER SPKI ({@link telnyxPublicKeyDer}).
   * 6. Call `crypto.verify(null, payload, { key, format: 'der', type: 'spki' }, signature)`.
   * 7. Reject a timestamp older than `webhookToleranceSec` (default 300).
   * 8. Return the verification result.
   *
   * @param ctx - Raw webhook request context.
   * @returns Verification result. Returns `{ valid: true }` when no public key
   *   is configured (development mode).
   */
  verifyWebhook(ctx: WebhookContext): WebhookVerificationResult {
    // Skip verification when no public key is configured -- allows
    // development without needing to set up Ed25519 key pairs.
    if (!this.config.publicKey) {
      return { valid: true };
    }

    const timestamp = ctx.headers['telnyx-timestamp'] ?? ctx.headers['x-telnyx-timestamp'];
    const sigHeader = ctx.headers['telnyx-signature-ed25519'] ?? ctx.headers['x-telnyx-signature-ed25519'];

    if (!timestamp || Array.isArray(timestamp) || !sigHeader || Array.isArray(sigHeader)) {
      return { valid: false, error: 'Missing Telnyx signature headers' };
    }

    const signature = Buffer.from(sigHeader, 'base64');
    // Telnyx signs the concatenation of timestamp, pipe separator, and raw body.
    const payload = Buffer.from(`${timestamp}|${ctx.body.toString()}`);

    let valid: boolean;
    try {
      valid = verify(
        null, // Ed25519 does not use a separate hash algorithm parameter.
        payload,
        {
          key: telnyxPublicKeyDer(this.config.publicKey),
          format: 'der',
          type: 'spki',
        },
        signature,
      );
    } catch {
      // crypto.verify throws on malformed keys or invalid DER encoding.
      return { valid: false, error: 'Verification failed' };
    }
    if (!valid) {
      return { valid: false, error: 'Signature mismatch' };
    }

    // A signed timestamp older than the window is a replay. A non-numeric
    // timestamp fails the comparison and is rejected too.
    const toleranceSec = this.config.webhookToleranceSec ?? DEFAULT_WEBHOOK_TOLERANCE_SEC;
    const ageSec = Math.floor(Date.now() / 1000) - Number(timestamp);
    if (toleranceSec > 0 && !(ageSec <= toleranceSec)) {
      return { valid: false, error: 'Timestamp outside the tolerance window' };
    }
    return { valid: true };
  }

  /**
   * Parse a Telnyx webhook JSON body into normalized {@link NormalizedCallEvent}s.
   *
   * Telnyx sends all webhook payloads as JSON with a `data.event_type`
   * discriminant field. The `data.payload` object contains call-specific
   * fields like `call_control_id`, `hangup_cause`, `digit`, and `result`.
   *
   * ## Hangup cause mapping
   *
   * Telnyx's `call.hangup` event includes a `hangup_cause` field that must
   * be inspected to determine whether the user or the system terminated
   * the call:
   * - `normal_clearing` / `user_busy` / `originator_cancel` -> `call-hangup-user`
   * - All other causes (e.g., `call_rejected`, `unallocated_number`) -> `call-completed`
   *
   * @param ctx - Raw webhook request context.
   * @returns Parsed result containing zero or more normalized events.
   */
  parseWebhookEvent(ctx: WebhookContext): WebhookParseResult {
    let parsed: TelnyxWebhookPayload;
    try {
      parsed = JSON.parse(ctx.body.toString()) as TelnyxWebhookPayload;
    } catch {
      return { events: [] };
    }

    const { event_type, payload } = parsed.data;
    const providerCallId = payload.call_control_id ?? '';
    const timestamp = Date.now();
    const events: NormalizedCallEvent[] = [];

    /** Helper: shared base fields with a unique event ID for idempotency. */
    const base = () => ({ eventId: randomUUID(), providerCallId, timestamp });

    switch (event_type) {
      case 'call.initiated':
        events.push({ ...base(), kind: 'call-ringing' });
        break;

      case 'call.answered':
        events.push({ ...base(), kind: 'call-answered' });
        break;

      case 'call.hangup': {
        // Distinguish user-initiated hangup from normal call completion
        // by inspecting the hangup_cause field.
        const cause = (payload.hangup_cause as string | undefined) ?? '';
        const kind =
          cause === 'user_busy' || cause === 'normal_clearing' || cause === 'originator_cancel'
            ? 'call-hangup-user'
            : 'call-completed';
        events.push({ ...base(), kind });
        break;
      }

      case 'call.dtmf.received': {
        // DTMF arrives via webhook only (never over the media stream WebSocket).
        const digit = (payload.digit as string | undefined) ?? '';
        events.push({ ...base(), kind: 'call-dtmf', digit });
        break;
      }

      case 'call.machine.detection.ended':
        // Only emit voicemail for machine detection; human detection is a no-op.
        if (payload.result === 'machine') {
          events.push({ ...base(), kind: 'call-voicemail' });
        }
        break;

      default:
        // Unrecognized event type -- silently ignore for forward-compatibility.
        break;
    }

    return { events };
  }

  // ── Call Control ──────────────────────────────────────────────────────────

  /**
   * Initiate an outbound call via the Telnyx Call Control v2 API.
   *
   * POSTs to `/v2/calls` with a JSON body containing the `connection_id`,
   * phone numbers, and webhook URL. The `mediaStreamUrl` (if provided) is
   * stored internally for use after the call is answered -- it is NOT sent
   * in the initial call creation request because Telnyx requires
   * `streaming_start` to be issued as a separate action after `call.answered`.
   *
   * @param input - Call initiation parameters (from/to numbers, webhook URL).
   * @returns Result containing the Telnyx `call_control_id` on success.
   * @throws Never throws; returns `{ success: false, error: '...' }` on failure.
   */
  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    const url = `${this.baseUrl}/calls`;

    const response = await this.fetch(url, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        connection_id: this.config.connectionId,
        to: input.toNumber,
        from: input.fromNumber,
        webhook_url: input.webhookUrl,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => String(response.status));
      return { providerCallId: '', success: false, error: `Telnyx error ${response.status}: ${text}` };
    }

    const data = (await response.json()) as { data: { call_control_id: string; call_session_id: string } };
    return { providerCallId: data.data.call_control_id, success: true };
  }

  /**
   * Hang up an active call via the Telnyx Call Control hangup action.
   *
   * POSTs an empty JSON body to `/v2/calls/{call_control_id}/actions/hangup`.
   * Telnyx will terminate the call and fire a `call.hangup` webhook.
   *
   * @param input - Contains the Telnyx `call_control_id` to hang up.
   */
  async hangupCall(input: HangupCallInput): Promise<void> {
    const url = `${this.baseUrl}/calls/${input.providerCallId}/actions/hangup`;

    await this.fetch(url, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
  }

  /**
   * Speak text into a live call using Telnyx's text-to-speech speak action.
   *
   * POSTs a JSON body to `/v2/calls/{id}/actions/speak` with the text
   * `payload`, `voice` (default `'female'`), and `language` (default `'en-US'`).
   *
   * @param input - TTS parameters (text, optional voice, call ID).
   */
  async playTts(input: PlayTtsInput): Promise<void> {
    const url = `${this.baseUrl}/calls/${input.providerCallId}/actions/speak`;

    await this.fetch(url, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        payload: input.text,
        voice: input.voice ?? 'female',
        language: 'en-US',
      }),
    });
  }
}
