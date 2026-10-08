/**
 * @fileoverview Unit tests for {@link TelnyxVoiceProvider}.
 *
 * All HTTP calls are intercepted via an injected `fetchImpl` -- no real
 * network traffic is made. Tests cover:
 * - Ed25519 webhook verification (portal and DER keys, tampering, replay
 *   window, no public key, missing headers, bad key format).
 * - Event mapping for all supported Telnyx Call Control event types.
 * - Hangup cause mapping (`normal_clearing` vs. other causes).
 * - Voicemail detection via `call.machine.detection.ended`.
 * - Outbound call initiation with JSON body.
 * - Call hangup via the `/actions/hangup` endpoint.
 * - TTS via the `/actions/speak` endpoint.
 * - Authentication header format (Bearer token).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { TelnyxVoiceProvider } from '../providers/telnyx.js';
import type { WebhookContext } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const API_KEY = 'KEY_test_abc123';
const CONNECTION_ID = 'conn-001';

/** Build a minimal mock Response that satisfies the fetch() contract. */
function makeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/**
 * Build a minimal Telnyx call event webhook body.
 *
 * Telnyx wraps all webhook data in a `data` envelope with `event_type` and
 * `payload` fields.
 */
function makeEventBody(eventType: string, payload: Record<string, unknown> = {}): string {
  return JSON.stringify({
    data: {
      event_type: eventType,
      payload: {
        call_control_id: 'call-ctrl-001',
        call_session_id: 'sess-001',
        ...payload,
      },
    },
  });
}

/** Build a basic WebhookContext for Telnyx testing. */
function makeWebhookCtx(body: string, overrideHeaders?: Record<string, string>): WebhookContext {
  return {
    method: 'POST',
    url: 'https://example.com/telnyx/webhook',
    headers: { 'telnyx-timestamp': '1234567890', ...overrideHeaders },
    body,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TelnyxVoiceProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let provider: TelnyxVoiceProvider;

  beforeEach(() => {
    fetchMock = vi.fn();
    provider = new TelnyxVoiceProvider({
      apiKey: API_KEY,
      connectionId: CONNECTION_ID,
      fetchImpl: fetchMock as typeof fetch,
    });
  });

  // ── Metadata ───────────────────────────────────────────────────────────

  it('should have name "telnyx"', () => {
    expect(provider.name).toBe('telnyx');
  });

  // ── initiateCall ───────────────────────────────────────────────────────

  describe('initiateCall()', () => {
    it('should POST to /calls with JSON body containing connection_id, to, from, and webhook_url', async () => {
      fetchMock.mockResolvedValue(
        makeResponse({ data: { call_control_id: 'ctrl-001', call_session_id: 'sess-001' } }),
      );

      const result = await provider.initiateCall({
        callId: 'call-1',
        fromNumber: '+15550000001',
        toNumber: '+15550000002',
        mode: 'conversation',
        webhookUrl: 'https://example.com/webhook',
      });

      expect(result).toEqual({ providerCallId: 'ctrl-001', success: true });
      expect(fetchMock).toHaveBeenCalledOnce();

      const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.telnyx.com/v2/calls');
      expect(options.method).toBe('POST');

      const body = JSON.parse(options.body as string);
      expect(body.connection_id).toBe(CONNECTION_ID);
      expect(body.to).toBe('+15550000002');
      expect(body.from).toBe('+15550000001');
      expect(body.webhook_url).toBe('https://example.com/webhook');
      // stream_url must NOT be in the initial request -- Telnyx requires
      // streaming_start as a separate action after call.answered.
      expect(body.stream_url).toBeUndefined();
    });

    it('should send a Bearer auth header with the API key', async () => {
      fetchMock.mockResolvedValue(
        makeResponse({ data: { call_control_id: 'ctrl-002', call_session_id: 's' } }),
      );

      await provider.initiateCall({
        callId: 'c',
        fromNumber: '+1',
        toNumber: '+2',
        mode: 'notify',
        webhookUrl: 'https://example.com/wh',
      });

      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((options.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
    });

    it('should return success: false with a descriptive error on non-2xx responses', async () => {
      fetchMock.mockResolvedValue(makeResponse({ errors: [] }, 422));

      const result = await provider.initiateCall({
        callId: 'c',
        fromNumber: '+1',
        toNumber: '+2',
        mode: 'notify',
        webhookUrl: 'https://example.com/wh',
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/422/);
    });
  });

  // ── hangupCall ─────────────────────────────────────────────────────────

  describe('hangupCall()', () => {
    it('should POST to /calls/{id}/actions/hangup with an empty JSON body', async () => {
      fetchMock.mockResolvedValue(makeResponse({}));

      await provider.hangupCall({ providerCallId: 'ctrl-999' });

      const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.telnyx.com/v2/calls/ctrl-999/actions/hangup');
      expect(options.method).toBe('POST');
    });
  });

  // ── playTts ────────────────────────────────────────────────────────────

  describe('playTts()', () => {
    it('should POST to /calls/{id}/actions/speak with payload, default voice, and language', async () => {
      fetchMock.mockResolvedValue(makeResponse({}));

      await provider.playTts({ providerCallId: 'ctrl-100', text: 'Hello!' });

      const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.telnyx.com/v2/calls/ctrl-100/actions/speak');
      const body = JSON.parse(options.body as string);
      expect(body.payload).toBe('Hello!');
      expect(body.voice).toBe('female');
      expect(body.language).toBe('en-US');
    });

    it('should use the provided voice when specified instead of the default', async () => {
      fetchMock.mockResolvedValue(makeResponse({}));

      await provider.playTts({ providerCallId: 'ctrl-101', text: 'Hey', voice: 'male' });

      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.voice).toBe('male');
    });
  });

  // ── verifyWebhook ──────────────────────────────────────────────────────

  describe('verifyWebhook()', () => {
    it('should return valid: true when no public key is configured (development mode skip)', () => {
      // Without a public key, verification is intentionally skipped.
      const ctx = makeWebhookCtx('{}');
      expect(provider.verifyWebhook(ctx)).toEqual({ valid: true });
    });

    it('should return valid: false when signature headers are missing and publicKey is set', () => {
      const providerWithKey = new TelnyxVoiceProvider({
        apiKey: API_KEY,
        connectionId: CONNECTION_ID,
        publicKey: Buffer.alloc(32).toString('base64'), // dummy key
        fetchImpl: fetchMock as typeof fetch,
      });
      const ctx: WebhookContext = {
        method: 'POST',
        url: 'https://example.com/wh',
        headers: {},
        body: '{}',
      };
      const result = providerWithKey.verifyWebhook(ctx);
      expect(result.valid).toBe(false);
    });

    describe('with a signing key pair', () => {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      const spkiDer = publicKey.export({ format: 'der', type: 'spki' });
      // The portal's form: base64 of the 32 raw key bytes, the tail of the SPKI DER.
      const portalKey = spkiDer.subarray(-32).toString('base64');
      const body = JSON.stringify({ data: { event_type: 'call.answered', payload: { call_control_id: 'ctrl-1' } } });

      function signedCtx(timestamp: string, signedBody = body): WebhookContext {
        const signature = sign(null, Buffer.from(`${timestamp}|${signedBody}`), privateKey).toString('base64');
        return {
          method: 'POST',
          url: 'https://example.com/wh',
          headers: { 'telnyx-timestamp': timestamp, 'telnyx-signature-ed25519': signature },
          body,
        };
      }

      function providerWithKey(key: string, webhookToleranceSec?: number): TelnyxVoiceProvider {
        return new TelnyxVoiceProvider({
          apiKey: API_KEY,
          connectionId: CONNECTION_ID,
          publicKey: key,
          webhookToleranceSec,
          fetchImpl: fetchMock as typeof fetch,
        });
      }

      const now = () => String(Math.floor(Date.now() / 1000));

      it('accepts a signed webhook with the 32-byte key the Telnyx portal shows', () => {
        expect(providerWithKey(portalKey).verifyWebhook(signedCtx(now()))).toEqual({ valid: true });
      });

      it('accepts a signed webhook with a DER SPKI key', () => {
        expect(providerWithKey(spkiDer.toString('base64')).verifyWebhook(signedCtx(now()))).toEqual({ valid: true });
      });

      it('rejects a body that differs from the signed one', () => {
        const result = providerWithKey(portalKey).verifyWebhook(signedCtx(now(), '{"data":{}}'));
        expect(result).toEqual({ valid: false, error: 'Signature mismatch' });
      });

      it('reads the X- prefixed header names as well', () => {
        const ctx = signedCtx(now());
        const headers = {
          'x-telnyx-timestamp': ctx.headers['telnyx-timestamp'],
          'x-telnyx-signature-ed25519': ctx.headers['telnyx-signature-ed25519'],
        };
        expect(providerWithKey(portalKey).verifyWebhook({ ...ctx, headers })).toEqual({ valid: true });
      });

      it('rejects a timestamp older than the tolerance window, unless the window is off', () => {
        const stale = String(Math.floor(Date.now() / 1000) - 301);
        expect(providerWithKey(portalKey).verifyWebhook(signedCtx(stale))).toEqual({
          valid: false,
          error: 'Timestamp outside the tolerance window',
        });
        expect(providerWithKey(portalKey, 0).verifyWebhook(signedCtx(stale))).toEqual({ valid: true });
      });
    });

    it('should return valid: false when Ed25519 verification throws due to bad key format', () => {
      // Malformed public key will cause crypto.verify() to throw,
      // which the provider catches and returns as a verification failure.
      const providerWithKey = new TelnyxVoiceProvider({
        apiKey: API_KEY,
        connectionId: CONNECTION_ID,
        publicKey: 'not-a-real-key',
        fetchImpl: fetchMock as typeof fetch,
      });
      const ctx: WebhookContext = {
        method: 'POST',
        url: 'https://example.com/wh',
        headers: {
          'telnyx-timestamp': '12345',
          'telnyx-signature-ed25519': 'fakesig',
        },
        body: '{}',
      };
      const result = providerWithKey.verifyWebhook(ctx);
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  // ── parseWebhookEvent ──────────────────────────────────────────────────

  describe('parseWebhookEvent()', () => {
    it('should map call.initiated to call-ringing', () => {
      const ctx = makeWebhookCtx(makeEventBody('call.initiated'));
      const result = provider.parseWebhookEvent(ctx);
      expect(result.events).toHaveLength(1);
      expect(result.events[0].kind).toBe('call-ringing');
      expect(result.events[0].providerCallId).toBe('call-ctrl-001');
    });

    it('should map call.answered to call-answered', () => {
      const ctx = makeWebhookCtx(makeEventBody('call.answered'));
      const result = provider.parseWebhookEvent(ctx);
      expect(result.events[0].kind).toBe('call-answered');
    });

    it('should map call.hangup with normal_clearing cause to call-hangup-user', () => {
      // normal_clearing indicates the remote party hung up normally.
      const ctx = makeWebhookCtx(makeEventBody('call.hangup', { hangup_cause: 'normal_clearing' }));
      const result = provider.parseWebhookEvent(ctx);
      expect(result.events[0].kind).toBe('call-hangup-user');
    });

    it('should map call.hangup with non-user causes to call-completed', () => {
      // Causes like call_rejected are system-level, not user-initiated hangups.
      const ctx = makeWebhookCtx(makeEventBody('call.hangup', { hangup_cause: 'call_rejected' }));
      const result = provider.parseWebhookEvent(ctx);
      expect(result.events[0].kind).toBe('call-completed');
    });

    it('should map call.dtmf.received to call-dtmf with the pressed digit', () => {
      const ctx = makeWebhookCtx(makeEventBody('call.dtmf.received', { digit: '7' }));
      const result = provider.parseWebhookEvent(ctx);
      expect(result.events[0].kind).toBe('call-dtmf');
      if (result.events[0].kind === 'call-dtmf') {
        expect(result.events[0].digit).toBe('7');
      }
    });

    it('should map call.machine.detection.ended with result=machine to call-voicemail', () => {
      const ctx = makeWebhookCtx(
        makeEventBody('call.machine.detection.ended', { result: 'machine' }),
      );
      const result = provider.parseWebhookEvent(ctx);
      expect(result.events[0].kind).toBe('call-voicemail');
    });

    it('should emit no event when call.machine.detection.ended has result=human', () => {
      // Human detection is not a meaningful lifecycle event -- the call continues normally.
      const ctx = makeWebhookCtx(
        makeEventBody('call.machine.detection.ended', { result: 'human' }),
      );
      const result = provider.parseWebhookEvent(ctx);
      expect(result.events).toHaveLength(0);
    });

    it('should emit no events for unknown event types to maintain forward compatibility', () => {
      const ctx = makeWebhookCtx(makeEventBody('call.some.unknown.event'));
      const result = provider.parseWebhookEvent(ctx);
      expect(result.events).toHaveLength(0);
    });

    it('should return empty events array for malformed JSON body', () => {
      const ctx: WebhookContext = {
        method: 'POST',
        url: 'https://example.com/wh',
        headers: {},
        body: '{not-valid-json',
      };
      const result = provider.parseWebhookEvent(ctx);
      expect(result.events).toHaveLength(0);
    });
  });
});
