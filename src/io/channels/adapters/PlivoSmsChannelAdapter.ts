/**
 * @fileoverview Plivo SMS Channel Adapter for AgentOS.
 *
 * Fills the `sms` channel slot using Plivo's Messaging API. Bidirectional:
 *
 * 1. **Outbound** — sends SMS via `POST /v1/Account/{authId}/Message/` using
 *    HTTP Basic auth (Auth ID / Auth Token).
 * 2. **Inbound** — Plivo POSTs incoming messages to a configured message URL.
 *    The host application forwards the request to {@link handleIncomingWebhook},
 *    which verifies the `X-Plivo-Signature-V3` signature before emitting.
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
        { headers: { Authorization: this.authHeader } },
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
   * Verify an inbound request carries a valid Plivo X-Plivo-Signature-V3.
   * Fails closed: missing headers/URL/token → not from Plivo.
   */
  private isFromPlivo(
    body: Record<string, unknown>,
    meta?: { method?: string; url?: string; headers?: Record<string, string | string[] | undefined> },
  ): boolean {
    const headers = meta?.headers ?? {};
    const signature = headerValue(headers, 'x-plivo-signature-v3');
    const nonce = headerValue(headers, 'x-plivo-signature-v3-nonce');
    const url = meta?.url ?? this.webhookUrl;
    const method = (meta?.method ?? 'POST').toUpperCase();

    if (!signature || !nonce || !url || !this.authToken) return false;

    let expected: string;
    try {
      expected = computePlivoV3Signature({ method, url, nonce, authToken: this.authToken, params: body });
    } catch {
      return false; // malformed URL/input is untrusted, not a crash
    }

    const expectedBuf = Buffer.from(expected);
    return signature.split(',').some((candidate) => {
      const candBuf = Buffer.from(candidate.trim());
      return candBuf.length === expectedBuf.length && timingSafeEqual(candBuf, expectedBuf);
    });
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
