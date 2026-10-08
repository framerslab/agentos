/**
 * @fileoverview Plivo SMS Channel Adapter for AgentOS.
 *
 * Fills the `sms` channel slot using Plivo's Messaging API. Bidirectional:
 *
 * 1. **Outbound** — sends SMS via `POST /v1/Account/{authId}/Message/` using
 *    HTTP Basic auth (Auth ID / Auth Token).
 * 2. **Inbound** — Plivo POSTs incoming messages to a configured message URL.
 *    The host application forwards the request to {@link handleIncomingWebhook},
 *    which verifies Plivo's inbound-message signature before emitting. Inbound
 *    messaging is signed under `X-Plivo-Signature-MA-V3`; the plain V3 and the
 *    V2 family are accepted as well.
 *
 * The adapter does NOT start its own HTTP server; the host wires a route
 * (Express/Fastify/etc.) that forwards inbound requests here — the same
 * pattern used by {@link WhatsAppChannelAdapter}.
 *
 * Voice for Plivo already ships separately under `telephony/providers/plivo.ts`;
 * this adapter is SMS only.
 *
 * @example
 * ```typescript
 * const sms = new PlivoSmsChannelAdapter();
 * await sms.initialize({
 *   platform: 'plivo',
 *   credential: process.env.PLIVO_AUTH_TOKEN!, // Auth Token
 *   params: {
 *     authId: process.env.PLIVO_AUTH_ID!,
 *     phoneNumber: '+14150000002',            // Plivo sender number
 *     webhookUrl: 'https://myhost.example/plivo/inbound', // signed message URL
 *   },
 * });
 * ```
 *
 * @module @framers/agentos/channels/adapters/PlivoSmsChannelAdapter
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import type {
  ChannelAuthConfig,
  ChannelCapability,
  ChannelMessage,
  ChannelPlatform,
  ChannelSendResult,
  MessageContent,
  MessageContentBlock,
} from '../types.js';
import { BaseChannelAdapter } from './BaseChannelAdapter.js';
import type { RetryConfig } from './BaseChannelAdapter.js';

// ============================================================================
// PlivoSmsChannelAdapter
// ============================================================================

/**
 * Channel adapter for SMS backed by Plivo.
 *
 * Capabilities: text. (MMS media is out of scope for this adapter.)
 */
export class PlivoSmsChannelAdapter extends BaseChannelAdapter<PlivoSmsAuthParams> {
  readonly platform: ChannelPlatform = 'plivo';
  readonly displayName = 'Plivo SMS';
  readonly capabilities: readonly ChannelCapability[] = ['text'] as const;

  /** Plivo Auth ID (account id, used in the API path and Basic auth). */
  private authId: string | undefined;
  /** Plivo Auth Token (Basic auth password + inbound-webhook HMAC key). */
  private authToken: string | undefined;
  /** Sender number / short code / sender id used as `src`. */
  private phoneNumber: string | undefined;
  /** Externally-visible message URL Plivo signs, for inbound verification. */
  private webhookUrl: string | undefined;
  /** When true (default), inbound webhooks must carry a valid V3 signature. */
  private verifySignatureEnabled = true;
  /** Pre-computed `Authorization: Basic ...` header value. */
  private authHeader: string | undefined;
  /** Fetch implementation (injectable for tests). */
  private readonly fetchImpl: typeof fetch;

  /**
   * @param opts.fetchImpl - Override the global fetch (inject a mock in tests).
   * @param opts.retryConfig - Connection retry tuning (see BaseChannelAdapter).
   */
  constructor(opts?: { fetchImpl?: typeof fetch; retryConfig?: Partial<RetryConfig> }) {
    super(opts?.retryConfig);
    this.fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
  }

  // ── Abstract hook implementations ──

  protected async doConnect(
    auth: ChannelAuthConfig & { params?: PlivoSmsAuthParams },
  ): Promise<void> {
    const params = auth.params ?? ({} as PlivoSmsAuthParams);

    this.authId = params.authId;
    this.authToken = params.authToken ?? auth.credential;
    this.phoneNumber = params.phoneNumber;
    this.webhookUrl = params.webhookUrl;
    this.verifySignatureEnabled = params.verifySignature !== 'false';

    if (!this.authId) {
      throw new Error('Plivo authId is required for SMS.');
    }
    if (!this.authToken) {
      throw new Error(
        'Plivo Auth Token is required. Provide it as credential or params.authToken.',
      );
    }
    if (!this.phoneNumber) {
      throw new Error('A Plivo sender number (params.phoneNumber) is required.');
    }

    this.authHeader =
      'Basic ' + Buffer.from(`${this.authId}:${this.authToken}`).toString('base64');

    // Verify credentials by fetching the account. Tolerate failure — the
    // credentials may still be valid for messaging even if this GET fails.
    try {
      const resp = await this.fetchImpl(
        `https://api.plivo.com/v1/Account/${this.authId}/`,
        { headers: { Authorization: this.authHeader }, signal: AbortSignal.timeout(10_000) },
      );
      if (resp.ok) {
        const data = (await resp.json()) as Record<string, unknown>;
        this.platformInfo = {
          provider: 'plivo',
          authId: this.authId,
          phoneNumber: this.phoneNumber,
          accountName: data.name,
        };
        console.log(`[Plivo SMS] Connected (${data.name ?? this.authId}, ${this.phoneNumber})`);
        return;
      }
      if (resp.status === 401 || resp.status === 403) {
        throw new Error(`[Plivo SMS] Authentication failed (HTTP ${resp.status}) — check authId/authToken.`);
      }
      console.warn(`[Plivo SMS] Account verification returned HTTP ${resp.status}.`);
    } catch (err) {
      if (err instanceof Error && err.message.includes('Authentication failed')) {
        throw err;
      }
      console.warn(`[Plivo SMS] Account verification failed: ${err}`);
    }
    this.platformInfo = { provider: 'plivo', authId: this.authId, phoneNumber: this.phoneNumber };
    console.log(`[Plivo SMS] Connected (${this.phoneNumber})`);
  }

  protected async doSendMessage(
    conversationId: string,
    content: MessageContent,
  ): Promise<ChannelSendResult> {
    if (!this.authHeader || !this.authId || !this.phoneNumber) {
      throw new Error('[Plivo SMS] Adapter is not connected.');
    }

    // SMS carries text only; collapse text blocks into one message body.
    const text = content.blocks
      .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    if (!text) {
      throw new Error('[Plivo SMS] Only text content is supported and none was provided.');
    }

    const resp = await this.fetchImpl(
      `https://api.plivo.com/v1/Account/${this.authId}/Message/`,
      {
        method: 'POST',
        headers: {
          Authorization: this.authHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          src: this.phoneNumber,
          dst: conversationId,
          text,
          type: 'sms',
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!resp.ok) {
      const errText = await resp.text().catch(() => String(resp.status));
      throw new Error(`[Plivo SMS] Send failed — HTTP ${resp.status}: ${errText}`);
    }

    const data = (await resp.json()) as { message_uuid?: string[]; api_id?: string };
    const messageId = data.message_uuid?.[0] ?? data.api_id ?? '';

    return { messageId, timestamp: new Date().toISOString() };
  }

  protected async doShutdown(): Promise<void> {
    this.authHeader = undefined;
    this.authToken = undefined;
    this.authId = undefined;
    this.phoneNumber = undefined;
    console.log('[Plivo SMS] Adapter shut down.');
  }

  // ── Public: inbound webhook ──

  /**
   * Handle an inbound Plivo SMS webhook. The host forwards Plivo's POST here.
   *
   * When signature verification is enabled (the default), the request must
   * carry valid `X-Plivo-Signature-V3` / `-Nonce` headers and the URL Plivo
   * signed; otherwise the message is dropped (fail closed).
   *
   * @param body - Parsed form/JSON body of Plivo's inbound-message POST.
   * @param meta - Request metadata needed to verify the V3 signature.
   */
  handleIncomingWebhook(
    body: Record<string, unknown>,
    meta?: {
      method?: string;
      /** The exact externally-visible URL Plivo POSTed to (must byte-match). */
      url?: string;
      headers?: Record<string, string | string[] | undefined>;
    },
  ): void {
    if (this.status !== 'connected') {
      console.warn('[Plivo SMS] Dropping inbound webhook — adapter not connected.');
      return;
    }

    if (this.verifySignatureEnabled && !this.isFromPlivo(body, meta)) {
      console.warn('[Plivo SMS] Dropping inbound webhook — signature missing or invalid.');
      return;
    }

    const from = String(body.From ?? '');
    const text = String(body.Text ?? '');
    const messageUuid = String(body.MessageUUID ?? '');

    if (!from || !messageUuid) {
      console.warn('[Plivo SMS] Dropping inbound webhook — missing From or MessageUUID.');
      return;
    }

    const channelMessage: ChannelMessage = {
      messageId: messageUuid,
      platform: 'plivo',
      conversationId: from,
      conversationType: 'direct',
      sender: { id: from },
      content: [{ type: 'text', text }],
      text,
      timestamp: new Date().toISOString(),
      rawEvent: body,
    };

    this.emit({
      type: 'message',
      platform: 'plivo',
      conversationId: from,
      timestamp: channelMessage.timestamp,
      data: channelMessage,
    });
  }

  // ── Private: signature verification ──

  /**
   * Verify an inbound request genuinely came from Plivo.
   *
   * Plivo sends more than one signature header and the one that matches depends
   * on the channel. Inbound messaging (SMS) is signed under
   * `X-Plivo-Signature-MA-V3`, while voice callbacks use the plain
   * `X-Plivo-Signature-V3`; Plivo's public docs also still document the older V2
   * scheme (`X-Plivo-Signature-MA-V2` / `X-Plivo-Signature-V2`). To be robust we
   * accept the request if ANY family validates: the V3 family (body params folded
   * into the signed string, keyed on `X-Plivo-Signature-V3-Nonce`) or the V2
   * family (URL + nonce only, keyed on `X-Plivo-Signature-V2-Nonce`). Every
   * candidate must still match cryptographically, so accepting several families
   * cannot produce a false accept.
   *
   * Fails closed: missing URL/token, or no family matches → not from Plivo.
   */
  private isFromPlivo(
    body: Record<string, unknown>,
    meta?: { method?: string; url?: string; headers?: Record<string, string | string[] | undefined> },
  ): boolean {
    const headers = meta?.headers ?? {};
    const url = meta?.url ?? this.webhookUrl;
    const method = (meta?.method ?? 'POST').toUpperCase();

    if (!url) {
      console.warn(
        '[Plivo SMS] Cannot verify inbound webhook — no request URL available. ' +
          'Set params.webhookUrl (or pass meta.url) when signature verification is enabled.',
      );
      return false;
    }
    if (!this.authToken) return false;

    // V3 family: MA-V3 for inbound messaging, plain V3 for voice. Params folded
    // into the signed string, keyed on the V3 nonce.
    const v3 = joinHeaders(headers, ['x-plivo-signature-ma-v3', 'x-plivo-signature-v3']);
    const v3Nonce = headerValue(headers, 'x-plivo-signature-v3-nonce');
    if (v3 && v3Nonce) {
      try {
        const expected = computePlivoV3Signature({
          method,
          url,
          nonce: v3Nonce,
          authToken: this.authToken,
          params: body,
        });
        if (signatureMatches(v3, expected)) return true;
      } catch {
        // malformed URL/input for V3 → fall through to the V2 family
      }
    }

    // V2 family: MA-V2 for messaging, plain V2 for voice. URL + nonce only (no
    // params), keyed on the V2 nonce.
    const v2 = joinHeaders(headers, ['x-plivo-signature-ma-v2', 'x-plivo-signature-v2']);
    const v2Nonce = headerValue(headers, 'x-plivo-signature-v2-nonce');
    if (v2 && v2Nonce) {
      try {
        const expected = computePlivoV2Signature({ url, nonce: v2Nonce, authToken: this.authToken });
        if (signatureMatches(v2, expected)) return true;
      } catch {
        // malformed input → no family matched
      }
    }

    return false;
  }
}

// ============================================================================
// Signature helpers (exported for testing against the Plivo SDK golden fixture)
// ============================================================================

/**
 * Compute Plivo's X-Plivo-Signature-V3 for a callback, matching the algorithm
 * in `plivo-python`'s `signature_v3.py`.
 *
 * For a POST callback the signed string is:
 *   `{scheme}://{host}{path}?` + (query as sorted `k=v&…` + `.` if present)
 *   + sorted, separator-less `key`+`value` body params + `.` + nonce
 * then `base64(HMAC_SHA256(authToken, signedString))`.
 */
export function computePlivoV3Signature(input: {
  method: string;
  url: string;
  nonce: string;
  authToken: string;
  params: Record<string, unknown>;
}): string {
  const { method, url, nonce, authToken, params } = input;
  const parsed = new URL(url);
  const base = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  const isPost = method.toUpperCase() === 'POST';

  let signed = base + '?';

  // If the URL carried a query string, append it as sorted k=v&k=v.
  if (parsed.search && parsed.search.length > 1) {
    signed += [...parsed.searchParams.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    if (isPost) signed += '.'; // separator between query and the POST params
  }

  // POST callbacks append sorted key+value body params, then '.' + nonce.
  // GET callbacks are signed over the query string alone (params ARE the query).
  if (isPost) {
    signed += sortedParamsString(params) + '.' + nonce;
  }

  return createHmac('sha256', authToken).update(signed).digest('base64');
}

/**
 * Compute Plivo's V2-family signature (`X-Plivo-Signature-MA-V2` for messaging,
 * `X-Plivo-Signature-V2` for voice). Unlike V3 it folds in no params: strip the
 * query off the URL, append the V2 nonce, HMAC-SHA256 with the auth token, then
 * base64. Matches `plivo-python`'s `validate_signature`.
 */
export function computePlivoV2Signature(input: {
  url: string;
  nonce: string;
  authToken: string;
}): string {
  const { url, nonce, authToken } = input;
  const parsed = new URL(url);
  const base = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  return createHmac('sha256', authToken).update(base + nonce).digest('base64');
}

/** Sorted, separator-less `key`+`value` concatenation (recurses dicts, sorts lists). */
function sortedParamsString(params: Record<string, unknown>): string {
  let out = '';
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    if (Array.isArray(value)) {
      for (const item of [...value].map(String).sort()) out += key + item;
    } else if (value !== null && typeof value === 'object') {
      out += key + sortedParamsString(value as Record<string, unknown>);
    } else {
      out += key + String(value);
    }
  }
  return out;
}

/** Case-insensitive single-header lookup; for array-valued headers, takes the first. */
function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== name) continue;
    if (typeof v === 'string') return v;
    // Node/Express surface duplicated headers as arrays — use the first value.
    if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  }
  return undefined;
}

/** Comma-join the present values of several signature headers into one candidate list. */
function joinHeaders(
  headers: Record<string, string | string[] | undefined>,
  names: string[],
): string {
  return names
    .map((n) => headerValue(headers, n))
    .filter((v): v is string => !!v)
    .join(',');
}

/** Constant-time check that `expected` equals any of the comma-separated candidates. */
function signatureMatches(candidates: string, expected: string): boolean {
  const expectedBuf = Buffer.from(expected);
  return candidates.split(',').some((candidate) => {
    const candBuf = Buffer.from(candidate.trim());
    return candBuf.length === expectedBuf.length && timingSafeEqual(candBuf, expectedBuf);
  });
}

// ============================================================================
// Plivo SMS Auth Params
// ============================================================================

/** Platform-specific parameters for a Plivo SMS connection. */
export interface PlivoSmsAuthParams extends Record<string, string | undefined> {
  /** Plivo Auth ID (account identifier). Required. */
  authId?: string;
  /** Plivo Auth Token. If omitted, the `credential` field is used. */
  authToken?: string;
  /** Plivo sender number / short code / sender id used as `src`. Required. */
  phoneNumber?: string;
  /** Externally-visible message URL Plivo signs; used to verify inbound webhooks. */
  webhookUrl?: string;
  /** Set to the string `'false'` to disable inbound signature verification. */
  verifySignature?: string;
}
