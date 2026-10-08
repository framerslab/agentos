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
 *    V2 family are accepted as well. Each callback is accepted once: the nonce
 *    of an accepted callback is remembered and a request that reuses it is
 *    dropped. A V2 signature covers the URL and the nonce, not the body, so it
 *    does not authenticate `From` or `Text` (see
 *    {@link PlivoSmsChannelAdapter.handleIncomingWebhook}).
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
  /** When true (default), inbound webhooks must carry a valid Plivo signature. */
  private verifySignatureEnabled = true;
  /** Pre-computed `Authorization: Basic ...` header value. */
  private authHeader: string | undefined;
  /** Fetch implementation (injectable for tests). */
  private readonly fetchImpl: typeof fetch;
  /**
   * Nonces of the callbacks accepted so far, so a request that reuses one is
   * refused. Kept across reconnects.
   */
  private readonly seenNonces: SeenNonces;

  /**
   * @param opts.fetchImpl - Override the global fetch (inject a mock in tests).
   * @param opts.retryConfig - Connection retry tuning (see BaseChannelAdapter).
   * @param opts.nonceTtlMs - How long the nonce of an accepted callback is
   *   remembered, in milliseconds. Default: 24 hours.
   * @param opts.maxNonces - How many nonces are remembered at once; past it
   *   the oldest is forgotten first. Default: 10,000.
   */
  constructor(opts?: {
    fetchImpl?: typeof fetch;
    retryConfig?: Partial<RetryConfig>;
    nonceTtlMs?: number;
    maxNonces?: number;
  }) {
    super(opts?.retryConfig);
    this.fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
    this.seenNonces = new SeenNonces(
      atLeastOneOr(opts?.nonceTtlMs, DEFAULT_NONCE_TTL_MS),
      atLeastOneOr(opts?.maxNonces, DEFAULT_MAX_NONCES),
    );
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
   * Handle an inbound Plivo SMS webhook. The host forwards Plivo's request here.
   *
   * When signature verification is enabled (the default), the request must
   * carry a valid Plivo signature over the URL Plivo requested, and each
   * callback is accepted once: a request whose nonce was already accepted is
   * dropped. Anything else is dropped as well (fail closed).
   *
   * What a valid signature proves depends on its family:
   *
   * - **V3** covers the URL, its query, the params and the nonce, so `From`,
   *   `Text` and `MessageUUID` are the ones Plivo sent.
   * - **V2** covers the URL and the nonce only. It does not authenticate
   *   `From`, `Text` or `MessageUUID`: whoever holds one callback's signature
   *   and nonce can send them again over a different body. Plivo's messaging
   *   documentation describes V2 for message callbacks.
   *
   * The nonce memory narrows that replay; it does not end it. Nonces are kept
   * in this process for `nonceTtlMs` (24 hours by default), `maxNonces` of
   * them at most, and Plivo's signatures carry no timestamp, so a callback
   * sent again after its nonce is forgotten, or to another process, is
   * accepted. Do not let an inbound message authorize an action by its sender
   * number alone.
   *
   * @param body - Parsed form body of Plivo's inbound-message POST. For a GET
   *   callback the params are read from the query string of `meta.url`, whose
   *   values win over `body`.
   * @param meta - Request metadata needed to verify the signature.
   */
  handleIncomingWebhook(
    body: Record<string, unknown>,
    meta?: {
      method?: string;
      /**
       * The exact externally-visible URL Plivo requested (must byte-match);
       * for a GET callback, with its query string.
       */
      url?: string;
      headers?: Record<string, string | string[] | undefined>;
    },
  ): void {
    if (this.status !== 'connected') {
      console.warn('[Plivo SMS] Dropping inbound webhook — adapter not connected.');
      return;
    }

    const method = (meta?.method ?? 'POST').toUpperCase();
    const url = meta?.url ?? this.webhookUrl;
    // A GET callback carries its params in the query string, and that is the
    // part a V3 signature covers. Reading them from the URL, over `body`,
    // keeps a field the signature does not cover out of the event.
    const fields = method === 'GET' && url ? { ...body, ...queryFields(url) } : body;

    if (this.verifySignatureEnabled) {
      const nonces = this.verifiedNonces(fields, { method, url, headers: meta?.headers ?? {} });
      if (!nonces) {
        console.warn('[Plivo SMS] Dropping inbound webhook — signature missing or invalid.');
        return;
      }
      if (!this.claimNonces(nonces)) {
        console.warn('[Plivo SMS] Dropping inbound webhook — its nonce was already used.');
        return;
      }
    }

    const from = String(fields.From ?? '');
    const text = String(fields.Text ?? '');
    const messageUuid = String(fields.MessageUUID ?? '');

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
      rawEvent: fields,
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
   * Verify an inbound request's signature and return the nonces it proved, or
   * `undefined` when no signature decides in its favour.
   *
   * Plivo sends more than one signature header and the one that matches depends
   * on the channel. Inbound messaging (SMS) is signed under
   * `X-Plivo-Signature-MA-V3`, while voice callbacks use the plain
   * `X-Plivo-Signature-V3`; Plivo's public docs also still document the older V2
   * scheme (`X-Plivo-Signature-MA-V2` / `X-Plivo-Signature-V2`). Both families
   * are accepted, and they do not prove the same thing:
   *
   * - The V3 family signs the URL, its query, the params and the V3 nonce
   *   (`X-Plivo-Signature-V3-Nonce`). A match covers the whole request.
   * - The V2 family signs the URL and the V2 nonce
   *   (`X-Plivo-Signature-V2-Nonce`) and nothing else. A match shows that Plivo
   *   signed this URL with this nonce once; the body under it can be anything.
   *   Accepting V2 is accepting that weaker proof: a V2 signature and nonce
   *   taken from one callback verify over a forged `From` and `Text`.
   *
   * So V3 decides whenever the request carries a V3 header: a V3 signature
   * that does not match is refused even if a V2 signature beside it matches.
   * V2 decides only for a request with no V3 header. Nothing here stops a
   * sender from leaving the V3 headers out; what limits a V2 replay is that
   * {@link claimNonces} accepts a nonce once, which is why a request verified
   * by V3 also returns its V2 nonce when its V2 signature is valid.
   *
   * Fails closed: missing URL/token, or the deciding family does not match →
   * `undefined`.
   */
  private verifiedNonces(
    fields: Record<string, unknown>,
    request: {
      method: string;
      url: string | undefined;
      headers: Record<string, string | string[] | undefined>;
    },
  ): string[] | undefined {
    const { method, url, headers } = request;
    const authToken = this.authToken;

    if (!url) {
      console.warn(
        '[Plivo SMS] Cannot verify inbound webhook — no request URL available. ' +
          'Set params.webhookUrl (or pass meta.url) when signature verification is enabled.',
      );
      return undefined;
    }
    if (!authToken) return undefined;

    const v3 = joinHeaders(headers, ['x-plivo-signature-ma-v3', 'x-plivo-signature-v3']);
    const v3Nonce = headerValue(headers, 'x-plivo-signature-v3-nonce');
    const v2 = joinHeaders(headers, ['x-plivo-signature-ma-v2', 'x-plivo-signature-v2']);
    const v2Nonce = headerValue(headers, 'x-plivo-signature-v2-nonce');

    // V2 family: MA-V2 for messaging, plain V2 for voice. URL + nonce only (no
    // params), keyed on the V2 nonce.
    let v2Nonces: string[] = [];
    if (v2 && v2Nonce) {
      try {
        const expected = computePlivoV2Signature({ url, nonce: v2Nonce, authToken });
        if (signatureMatches(v2, expected)) v2Nonces = [`v2:${v2Nonce}`];
      } catch {
        // malformed URL → V2 does not match
      }
    }

    // No V3 header on the request: V2 decides.
    if (!v3 && !v3Nonce) return v2Nonces.length > 0 ? v2Nonces : undefined;

    // V3 family: MA-V3 for inbound messaging, plain V3 for voice. Params folded
    // into the signed string, keyed on the V3 nonce. V3 decides alone; a valid
    // V2 signature only adds its nonce to the ones recorded.
    if (!v3 || !v3Nonce) return undefined;
    try {
      const expected = computePlivoV3Signature({
        method,
        url,
        nonce: v3Nonce,
        authToken,
        params: fields,
      });
      if (signatureMatches(v3, expected)) return [`v3:${v3Nonce}`, ...v2Nonces];
    } catch {
      // malformed URL/input → V3 does not match
    }
    return undefined;
  }

  /**
   * Record the nonces of a verified callback as used.
   *
   * @returns `false`, recording nothing, when any of them was used already.
   */
  private claimNonces(nonces: string[]): boolean {
    const now = Date.now();
    if (nonces.some((nonce) => this.seenNonces.has(nonce, now))) return false;
    for (const nonce of nonces) this.seenNonces.add(nonce, now);
    return true;
  }
}

// ============================================================================
// Signature helpers (exported for testing against the Plivo SDK golden fixture)
// ============================================================================

/**
 * Compute Plivo's V3 signature for a callback as `plivo-python`'s
 * `signature_v3.py` does: `base64(HMAC_SHA256(authToken, signedString))`,
 * where the signed string ends in `.` + nonce.
 *
 * With `base` = `{scheme}://{host}{path}`, `query` = the URL's query as `k=v`
 * pairs joined by `&` (names sorted, a repeated name's values sorted) and
 * `fields` = the params as `key`+`value` with no separators (keys sorted):
 *
 * - **POST with params**: `base` + `?` + `query` + (`.` if there is a query)
 *   + `fields`.
 * - **POST with no params**: `base`, then `?` + `query` if there is a query.
 * - **GET**: the params are part of the query. Those passed in `params` are
 *   merged into the URL's own (the URL's value wins on a shared name), and the
 *   signed string is `base`, then `?` + the merged `query` if there is one.
 *
 * Any method other than GET is signed as a POST, as in the reference.
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
  const query = queryValues(parsed);

  let signed = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  if (method.toUpperCase() === 'GET') {
    const merged = new Map<string, unknown>(Object.entries(params));
    for (const [name, values] of query) merged.set(name, values);
    const queryString = sortedQueryString(merged);
    if (queryString) signed += '?' + queryString;
  } else {
    const queryString = sortedQueryString(query);
    const hasParams = Object.keys(params).length > 0;
    if (queryString || hasParams) signed += '?' + queryString;
    if (queryString && hasParams) signed += '.'; // separator between query and params
    signed += sortedParamsString(params);
  }

  return createHmac('sha256', authToken).update(`${signed}.${nonce}`).digest('base64');
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

/** A URL's query values grouped by name, in the order they appear. */
function queryValues(parsed: URL): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const [name, value] of parsed.searchParams.entries()) {
    const values = grouped.get(name);
    if (values) values.push(value);
    else grouped.set(name, [value]);
  }
  return grouped;
}

/**
 * A URL's query fields by name: a string, or an array when the name repeats.
 * Text that is not a URL has none (signature verification refuses it).
 */
function queryFields(url: string): Record<string, string | string[]> {
  try {
    return Object.fromEntries(
      [...queryValues(new URL(url))].map(([name, values]): [string, string | string[]] => [
        name,
        values.length === 1 ? values[0] : values,
      ]),
    );
  } catch {
    return {};
  }
}

/** `k=v` pairs joined by `&`: names sorted, a repeated name's values sorted. */
function sortedQueryString(fields: ReadonlyMap<string, unknown>): string {
  const pairs: string[] = [];
  for (const name of [...fields.keys()].sort()) {
    const value = fields.get(name);
    const values = Array.isArray(value) ? value.map(String).sort() : [String(value)];
    for (const item of values) pairs.push(`${name}=${item}`);
  }
  return pairs.join('&');
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
// Seen nonces
// ============================================================================

/** How long the nonce of an accepted callback is remembered by default: 24 hours. */
const DEFAULT_NONCE_TTL_MS = 24 * 60 * 60 * 1000;

/** How many nonces are remembered at once by default. */
const DEFAULT_MAX_NONCES = 10_000;

/** `value` rounded down when it is a finite number of at least 1, else `fallback`. */
function atLeastOneOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback;
}

/**
 * The nonces of accepted callbacks, so a callback delivered again is refused.
 *
 * Held in memory and bounded twice: a nonce is forgotten `ttlMs` after it was
 * added, and once `maxEntries` are held the oldest is forgotten first. A
 * forgotten nonce is accepted again, so this narrows replay to callbacks older
 * than the window; Plivo's signatures carry no timestamp that would let an old
 * callback be refused by its age.
 */
class SeenNonces {
  /** Nonce → when it expires (ms since the epoch). Insertion order is age order. */
  private readonly expiresAt = new Map<string, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  /** Whether `nonce` was added and has not expired at `now`. */
  has(nonce: string, now: number): boolean {
    const expiry = this.expiresAt.get(nonce);
    return expiry !== undefined && expiry > now;
  }

  /** Remember `nonce` from `now`, forgetting what expired and, past the cap, the oldest. */
  add(nonce: string, now: number): void {
    // Every nonce has the same lifetime and they are added in time order, so
    // the expired ones come first.
    for (const [key, expiry] of this.expiresAt) {
      if (expiry > now) break;
      this.expiresAt.delete(key);
    }
    this.expiresAt.delete(nonce);
    this.expiresAt.set(nonce, now + this.ttlMs);
    while (this.expiresAt.size > this.maxEntries) {
      this.expiresAt.delete(this.expiresAt.keys().next().value as string);
    }
  }
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
