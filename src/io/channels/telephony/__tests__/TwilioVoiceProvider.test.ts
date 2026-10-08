/**
 * @fileoverview Unit tests for {@link TwilioVoiceProvider}.
 *
 * All HTTP calls are intercepted via an injected `fetchImpl` -- no real
 * network traffic is made. Tests cover:
 * - HMAC-SHA1 webhook verification (valid, invalid, missing header).
 * - Event mapping for every supported Twilio `CallStatus` value.
 * - DTMF digit extraction from the `Digits` form parameter.
 * - Outbound call initiation with form-encoded body format.
 * - Call hangup via `Status=completed`.
 * - TTS injection via the `Twiml` parameter.
 * - Authentication header format (HTTP Basic).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { TwilioVoiceProvider } from '../providers/twilio.js';
import type { WebhookContext } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACCOUNT_SID = 'ACtest1234567890';
const AUTH_TOKEN = 'test_auth_token';

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
 * Compute the expected Twilio HMAC-SHA1 signature for a given URL + form body.
 *
 * Reproduces Twilio's signing algorithm: URL + sorted key-value pairs, then
 * HMAC-SHA1 with the auth token, base64-encoded.
 */
function twilioSignature(url: string, body: string): string {
  const params = new URLSearchParams(body);
  let data = url;
  for (const key of [...new Set(params.keys())].sort()) {
    for (const value of [...new Set(params.getAll(key))].sort()) data += key + value;
  }
  return createHmac('sha1', AUTH_TOKEN).update(data).digest('base64');
}

/** Build a WebhookContext with a correctly signed Twilio signature header. */
function makeWebhookCtx(url: string, body: string, overrideHeaders?: Record<string, string>): WebhookContext {
  const sig = twilioSignature(url, body);
  return {
    method: 'POST',
    url,
    headers: { 'x-twilio-signature': sig, ...overrideHeaders },
    body,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TwilioVoiceProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let provider: TwilioVoiceProvider;

  beforeEach(() => {
    fetchMock = vi.fn();
    provider = new TwilioVoiceProvider({
      accountSid: ACCOUNT_SID,
      authToken: AUTH_TOKEN,
      fetchImpl: fetchMock as typeof fetch,
    });
  });

  // ── Metadata ───────────────────────────────────────────────────────────

  it('should have name "twilio"', () => {
    expect(provider.name).toBe('twilio');
  });

  // ── initiateCall ───────────────────────────────────────────────────────

  describe('initiateCall()', () => {
    it('should POST to /Accounts/{sid}/Calls.json with form-encoded body and status callback events', async () => {
      fetchMock.mockResolvedValue(makeResponse({ sid: 'CA001' }));

      const result = await provider.initiateCall({
        callId: 'call-1',
        fromNumber: '+15550000001',
        toNumber: '+15550000002',
        mode: 'notify',
        webhookUrl: 'https://example.com/webhook',
        statusCallbackUrl: 'https://example.com/status',
      });

      expect(result).toEqual({ providerCallId: 'CA001', success: true });
      expect(fetchMock).toHaveBeenCalledOnce();

      const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Calls.json`);
      expect(options.method).toBe('POST');
      expect(options.headers).toMatchObject({ 'Content-Type': 'application/x-www-form-urlencoded' });

      // Verify the form-encoded body contains the expected parameters.
      const body = options.body as string;
      expect(body).toContain('To=%2B15550000002');
      expect(body).toContain('From=%2B15550000001');
      expect(body).toContain('StatusCallbackEvent=initiated');
      expect(body).toContain('StatusCallbackEvent=ringing');
      expect(body).toContain('StatusCallbackEvent=answered');
      expect(body).toContain('StatusCallbackEvent=completed');
    });

    it('should return success: false with a descriptive error on non-2xx responses', async () => {
      fetchMock.mockResolvedValue(makeResponse({ message: 'Not found' }, 404));

      const result = await provider.initiateCall({
        callId: 'call-2',
        fromNumber: '+15550000001',
        toNumber: '+15550000002',
        mode: 'notify',
        webhookUrl: 'https://example.com/webhook',
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/404/);
    });

    it('should send a Basic auth header with accountSid:authToken base64-encoded', async () => {
      fetchMock.mockResolvedValue(makeResponse({ sid: 'CA002' }));

      await provider.initiateCall({
        callId: 'call-3',
        fromNumber: '+1',
        toNumber: '+2',
        mode: 'notify',
        webhookUrl: 'https://example.com/wh',
      });

      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      const expectedAuth = 'Basic ' + Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64');
      expect((options.headers as Record<string, string>).Authorization).toBe(expectedAuth);
    });
  });

  // ── hangupCall ─────────────────────────────────────────────────────────

  describe('hangupCall()', () => {
    it('should POST Status=completed to /Accounts/{sid}/Calls/{callSid}.json', async () => {
      fetchMock.mockResolvedValue(makeResponse({}));

      await provider.hangupCall({ providerCallId: 'CA999' });

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/Calls/CA999.json');
      expect(options.method).toBe('POST');
      expect(options.body).toBe('Status=completed');
    });
  });

  // ── playTts ────────────────────────────────────────────────────────────

  describe('playTts()', () => {
    it('should POST TwiML <Say> without voice attribute when voice is omitted', async () => {
      fetchMock.mockResolvedValue(makeResponse({}));

      await provider.playTts({ providerCallId: 'CA100', text: 'Hello world' });

      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = decodeURIComponent(options.body as string).replace('Twiml=', '');
      expect(body).toBe('<Response><Say>Hello world</Say></Response>');
    });

    it('should include the voice attribute in TwiML when voice is provided', async () => {
      fetchMock.mockResolvedValue(makeResponse({}));

      await provider.playTts({ providerCallId: 'CA101', text: 'Hey there', voice: 'alice' });

      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = decodeURIComponent(options.body as string).replace('Twiml=', '');
      expect(body).toBe('<Response><Say voice="alice">Hey there</Say></Response>');
    });
  });

  // ── verifyWebhook ──────────────────────────────────────────────────────

  describe('verifyWebhook()', () => {
    const url = 'https://example.com/twilio/webhook';
    const body = 'CallSid=CA001&CallStatus=ringing&From=%2B15550000001';

    it('should return valid: true when the HMAC-SHA1 signature matches', () => {
      const ctx = makeWebhookCtx(url, body);
      expect(provider.verifyWebhook(ctx)).toEqual({ valid: true });
    });

    it('should return valid: false with "Signature mismatch" when the signature is wrong', () => {
      const ctx: WebhookContext = {
        method: 'POST',
        url,
        headers: { 'x-twilio-signature': 'wrong_sig' },
        body,
      };
      const result = provider.verifyWebhook(ctx);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/mismatch/i);
    });

    it('accepts the signature twilio-node computes when case-sensitive and locale order differ', () => {
      // Expected value from twilio-node 5.13.1's getExpectedTwilioSignature
      // (src/webhooks/webhooks.ts), which sorts keys with the default sort:
      // CallSid and CallStatus come before Called and Caller.
      const signed = new TwilioVoiceProvider({
        accountSid: ACCOUNT_SID,
        authToken: 'twilio-test-token',
        fetchImpl: fetchMock as typeof fetch,
      });
      const ctx: WebhookContext = {
        method: 'POST',
        url: 'https://example.com/twilio/voice',
        headers: { 'x-twilio-signature': 'vTMYeb4FrYjNFHkuYMDv271CgVI=' },
        body:
          'AccountSid=AC123&CallSid=CA123&CallStatus=ringing&Called=%2B14155550199' +
          '&Caller=%2B14155550100&From=%2B14155550100&To=%2B14155550199',
      };
      expect(signed.verifyWebhook(ctx)).toEqual({ valid: true });
    });

    it('accepts a signature over the URL with or without its standard port', () => {
      const withPort = makeWebhookCtx('https://example.com:443/twilio/webhook', body);
      expect(provider.verifyWebhook({ ...withPort, url })).toEqual({ valid: true });
      const withoutPort = makeWebhookCtx(url, body);
      expect(provider.verifyWebhook({ ...withoutPort, url: 'https://example.com:443/twilio/webhook' })).toEqual({
        valid: true,
      });
    });

    it('refuses a webhook whose CallStatus repeats with different values', () => {
      // The signed string sorts repeated values, so swapping their order
      // would keep the signature valid while changing the status read.
      const ctx = makeWebhookCtx(url, 'CallSid=CA001&CallStatus=ringing&CallStatus=completed');
      expect(provider.verifyWebhook(ctx)).toEqual({ valid: false, error: 'Conflicting repeated event fields' });
      expect(provider.parseWebhookEvent(ctx).events).toEqual([]);
    });

    it('rejects an unsigned query parameter added after 1,000 empty entries', () => {
      const signedUrl = 'https://example.com/twilio/webhook?tenant=a';
      const signed = makeWebhookCtx(signedUrl, body);
      const padded = `${signedUrl}${'&'.repeat(1000)}extra=unsigned`;
      expect(provider.verifyWebhook({ ...signed, url: padded }).valid).toBe(false);
      expect(provider.verifyWebhook(signed)).toEqual({ valid: true });
    });

    it('rejects a signature over a different path', () => {
      const otherPath = makeWebhookCtx('https://example.com/twilio/other', body);
      expect(provider.verifyWebhook({ ...otherPath, url }).valid).toBe(false);
    });

    it('should return valid: false when the x-twilio-signature header is missing', () => {
      const ctx: WebhookContext = {
        method: 'POST',
        url,
        headers: {},
        body,
      };
      expect(provider.verifyWebhook(ctx).valid).toBe(false);
    });
  });

  // ── parseWebhookEvent ──────────────────────────────────────────────────

  describe('parseWebhookEvent()', () => {
    const url = 'https://example.com/twilio/webhook';

    // Table-driven test for all CallStatus -> kind mappings.
    const cases: Array<[string, string]> = [
      ['ringing', 'call-ringing'],
      ['in-progress', 'call-answered'],
      ['completed', 'call-completed'],
      ['failed', 'call-failed'],
      ['busy', 'call-busy'],
      ['no-answer', 'call-no-answer'],
      ['canceled', 'call-hangup-user'],
    ];

    for (const [twilioStatus, expectedKind] of cases) {
      it(`should map CallStatus="${twilioStatus}" to kind="${expectedKind}"`, () => {
        const body = `CallSid=CA001&CallStatus=${twilioStatus}`;
        const ctx = makeWebhookCtx(url, body);
        const result = provider.parseWebhookEvent(ctx);
        expect(result.events).toHaveLength(1);
        expect(result.events[0].kind).toBe(expectedKind);
        expect(result.events[0].providerCallId).toBe('CA001');
      });
    }

    it('should emit a call-dtmf event alongside the status event when Digits param is present', () => {
      // Twilio can include DTMF digits in the same webhook as a status update
      // (e.g., from a <Gather> verb that also reports call status).
      const body = 'CallSid=CA002&CallStatus=in-progress&Digits=5';
      const ctx = makeWebhookCtx(url, body);
      const result = provider.parseWebhookEvent(ctx);
      // Both call-answered and call-dtmf events should be emitted.
      expect(result.events).toHaveLength(2);
      const dtmf = result.events.find(e => e.kind === 'call-dtmf');
      expect(dtmf).toBeDefined();
      if (dtmf?.kind === 'call-dtmf') {
        expect(dtmf.digit).toBe('5');
      }
    });

    it('should emit no events for unknown CallStatus values like "queued"', () => {
      const body = 'CallSid=CA003&CallStatus=queued';
      const ctx = makeWebhookCtx(url, body);
      const result = provider.parseWebhookEvent(ctx);
      expect(result.events).toHaveLength(0);
    });

    it('should assign unique eventIds to each event for idempotency tracking', () => {
      const body = 'CallSid=CA004&CallStatus=in-progress&Digits=3';
      const ctx = makeWebhookCtx(url, body);
      const result = provider.parseWebhookEvent(ctx);
      const ids = result.events.map(e => e.eventId);
      // Every event ID should be unique (UUIDs).
      expect(new Set(ids).size).toBe(ids.length);
    });
  });
});
