/**
 * @fileoverview Unit tests for {@link PlivoVoiceProvider}.
 *
 * All HTTP calls are intercepted via an injected `fetchImpl` -- no real
 * network traffic is made. Tests cover:
 * - HMAC-SHA256 webhook verification (v3 scheme with nonce), including
 *   signatures computed by the plivo-python SDK.
 * - Event mapping for every supported Plivo `CallStatus` value.
 * - DTMF digit extraction from the `Digits` form parameter.
 * - JSON body fallback parsing.
 * - Outbound call initiation with JSON body.
 * - Call hangup via HTTP DELETE (Plivo's RESTful convention).
 * - TTS via the `/Speak/` endpoint.
 * - Authentication header format (HTTP Basic).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  PlivoVoiceProvider,
  computePlivoV3Signature,
  pythonFloatRepr,
  type PlivoParams,
} from '../providers/plivo.js';
import type { WebhookContext } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AUTH_ID = 'MATEST12345';
const AUTH_TOKEN = 'test_plivo_auth_token';

/** Build a minimal mock Response that satisfies the fetch() contract. */
function makeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** The v3 signature of a POST to `url` carrying the URL-encoded `body`. */
function plivoSignature(url: string, body: string, nonce: string, authToken: string): string {
  return computePlivoV3Signature('POST', url, nonce, authToken, Object.fromEntries(new URLSearchParams(body)));
}

/** Build a WebhookContext with a correctly signed Plivo v3 signature header. */
function makeWebhookCtx(
  url: string,
  body: string,
  nonce = 'test-nonce-123',
  overrideHeaders?: Record<string, string>,
): WebhookContext {
  const sig = plivoSignature(url, body, nonce, AUTH_TOKEN);
  return {
    method: 'POST',
    url,
    headers: {
      'x-plivo-signature-v3-nonce': nonce,
      'x-plivo-signature-v3': sig,
      ...overrideHeaders,
    },
    body,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PlivoVoiceProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let provider: PlivoVoiceProvider;

  beforeEach(() => {
    fetchMock = vi.fn();
    provider = new PlivoVoiceProvider({
      authId: AUTH_ID,
      authToken: AUTH_TOKEN,
      fetchImpl: fetchMock as typeof fetch,
    });
  });

  // ── Metadata ───────────────────────────────────────────────────────────

  it('should have name "plivo"', () => {
    expect(provider.name).toBe('plivo');
  });

  // ── initiateCall ───────────────────────────────────────────────────────

  describe('initiateCall()', () => {
    it('should POST to /Account/{authId}/Call/ with JSON body containing from, to, and answer_url', async () => {
      fetchMock.mockResolvedValue(makeResponse({ request_uuid: 'req-uuid-001' }));

      const result = await provider.initiateCall({
        callId: 'call-1',
        fromNumber: '+15550000001',
        toNumber: '+15550000002',
        mode: 'notify',
        webhookUrl: 'https://example.com/answer',
      });

      expect(result).toEqual({ providerCallId: 'req-uuid-001', success: true });
      expect(fetchMock).toHaveBeenCalledOnce();

      const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`https://api.plivo.com/v1/Account/${AUTH_ID}/Call/`);
      expect(options.method).toBe('POST');

      const body = JSON.parse(options.body as string);
      expect(body.from).toBe('+15550000001');
      expect(body.to).toBe('+15550000002');
      expect(body.answer_url).toBe('https://example.com/answer');
      expect(body.answer_method).toBe('POST');
    });

    it('should send a Basic auth header with authId:authToken base64-encoded', async () => {
      fetchMock.mockResolvedValue(makeResponse({ request_uuid: 'r2' }));

      await provider.initiateCall({
        callId: 'c',
        fromNumber: '+1',
        toNumber: '+2',
        mode: 'notify',
        webhookUrl: 'https://example.com/wh',
      });

      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      const expectedAuth = 'Basic ' + Buffer.from(`${AUTH_ID}:${AUTH_TOKEN}`).toString('base64');
      expect((options.headers as Record<string, string>).Authorization).toBe(expectedAuth);
    });

    it('should return success: false with a descriptive error on non-2xx responses', async () => {
      fetchMock.mockResolvedValue(makeResponse({ error: 'not found' }, 404));

      const result = await provider.initiateCall({
        callId: 'c',
        fromNumber: '+1',
        toNumber: '+2',
        mode: 'notify',
        webhookUrl: 'https://example.com/wh',
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/404/);
    });
  });

  // ── hangupCall ─────────────────────────────────────────────────────────

  describe('hangupCall()', () => {
    it('should send DELETE to /Account/{authId}/Call/{uuid}/ (RESTful hangup convention)', async () => {
      fetchMock.mockResolvedValue(makeResponse({}, 204));

      await provider.hangupCall({ providerCallId: 'req-uuid-999' });

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`https://api.plivo.com/v1/Account/${AUTH_ID}/Call/req-uuid-999/`);
      expect(options.method).toBe('DELETE');
    });

    it('should include the Basic auth header on DELETE requests', async () => {
      fetchMock.mockResolvedValue(makeResponse({}, 204));

      await provider.hangupCall({ providerCallId: 'uuid-aaa' });

      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      const expectedAuth = 'Basic ' + Buffer.from(`${AUTH_ID}:${AUTH_TOKEN}`).toString('base64');
      expect((options.headers as Record<string, string>).Authorization).toBe(expectedAuth);
    });
  });

  // ── playTts ────────────────────────────────────────────────────────────

  describe('playTts()', () => {
    it('should POST to /Account/{authId}/Call/{uuid}/Speak/ with default voice WOMAN', async () => {
      fetchMock.mockResolvedValue(makeResponse({}));

      await provider.playTts({ providerCallId: 'uuid-100', text: 'Hello there' });

      const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`https://api.plivo.com/v1/Account/${AUTH_ID}/Call/uuid-100/Speak/`);
      const body = JSON.parse(options.body as string);
      expect(body.text).toBe('Hello there');
      expect(body.voice).toBe('WOMAN');
      expect(body.language).toBe('en-US');
    });

    it('should use the provided voice when specified instead of the default', async () => {
      fetchMock.mockResolvedValue(makeResponse({}));

      await provider.playTts({ providerCallId: 'uuid-101', text: 'Hi', voice: 'MAN' });

      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.voice).toBe('MAN');
    });
  });

  // ── verifyWebhook ──────────────────────────────────────────────────────

  describe('verifyWebhook()', () => {
    const url = 'https://example.com/plivo/webhook';
    const body = 'CallUUID=uuid-001&CallStatus=ringing';

    it('should return valid: true when the HMAC-SHA256 signature matches the computed digest', () => {
      const ctx = makeWebhookCtx(url, body);
      expect(provider.verifyWebhook(ctx).valid).toBe(true);
    });

    it('should return valid: false when the signature header has an incorrect value', () => {
      const ctx = makeWebhookCtx(url, body, 'test-nonce-123', {
        'x-plivo-signature-v3': 'wrong_signature',
      });
      expect(provider.verifyWebhook(ctx).valid).toBe(false);
    });

    it('should return valid: false when the signature header is missing entirely', () => {
      const ctx: WebhookContext = {
        method: 'POST',
        url,
        headers: { 'x-plivo-signature-v3-nonce': 'some-nonce' },
        body,
      };
      expect(provider.verifyWebhook(ctx)).toEqual({ valid: false, error: 'Missing Plivo signature headers' });
    });

    it('rejects a signature over only the URL and nonce, which the v3 scheme does not use', () => {
      const nonce = 'test-nonce-123';
      const urlAndNonceOnly = createHmac('sha256', AUTH_TOKEN).update(url + nonce).digest('base64');
      const ctx = makeWebhookCtx(url, body, nonce, { 'x-plivo-signature-v3': urlAndNonceOnly });
      expect(provider.verifyWebhook(ctx).valid).toBe(false);
    });

    it('rejects a request whose form fields changed after signing', () => {
      const ctx = makeWebhookCtx(url, body);
      expect(provider.verifyWebhook({ ...ctx, body: 'CallUUID=uuid-001&CallStatus=completed' }).valid).toBe(false);
    });

    it('accepts the main-account header and a comma-separated signature list', () => {
      const nonce = 'test-nonce-123';
      const sig = plivoSignature(url, body, nonce, AUTH_TOKEN);
      const viaMainAccount: WebhookContext = {
        method: 'POST',
        url,
        headers: { 'x-plivo-signature-v3-nonce': nonce, 'x-plivo-signature-ma-v3': sig },
        body,
      };
      expect(provider.verifyWebhook(viaMainAccount).valid).toBe(true);
      const listed = makeWebhookCtx(url, body, nonce, { 'x-plivo-signature-v3': `not-this-one,${sig}` });
      expect(provider.verifyWebhook(listed).valid).toBe(true);
    });

    it('rejects a form body dressed as JSON when the signature covers no fields', () => {
      // The signature of an empty POST to this URL, reused with a body that
      // fails to parse as JSON and so reads as form fields.
      const nonce = 'test-nonce-123';
      const emptyPostSignature = computePlivoV3Signature('POST', url, nonce, AUTH_TOKEN, {});
      const ctx: WebhookContext = {
        method: 'POST',
        url,
        headers: { 'x-plivo-signature-v3-nonce': nonce, 'x-plivo-signature-v3': emptyPostSignature },
        body: '{&CallUUID=uuid-001&CallStatus=completed',
      };
      expect(provider.verifyWebhook(ctx).valid).toBe(false);
      expect(provider.parseWebhookEvent(ctx).events[0]?.kind).toBe('call-completed');
    });

    it('refuses a callback whose CallStatus repeats with different values', () => {
      // The signature sorts repeated values, so swapping their order would
      // keep it valid while changing which status a first-value reader sees.
      const nonce = 'test-nonce-123';
      const repeatedBody = 'CallUUID=uuid-001&CallStatus=ringing&CallStatus=completed';
      const signature = computePlivoV3Signature('POST', url, nonce, AUTH_TOKEN, {
        CallUUID: 'uuid-001',
        CallStatus: ['ringing', 'completed'],
      });
      const ctx: WebhookContext = {
        method: 'POST',
        url,
        headers: { 'x-plivo-signature-v3-nonce': nonce, 'x-plivo-signature-v3': signature },
        body: repeatedBody,
      };
      expect(provider.verifyWebhook(ctx)).toEqual({ valid: false, error: 'Conflicting repeated event fields' });
      expect(provider.parseWebhookEvent(ctx).events).toEqual([]);
    });

    it('reads a signed JSON body nested eight objects deep and refuses one nested nine', () => {
      /** The call fields at the top, then a chain of nested objects, `levels` objects deep in all. */
      const nestedCallback = (levels: number): PlivoParams => {
        let inner: PlivoParams = { a: '', b: '' };
        for (let level = 3; level <= levels; level++) inner = { a: inner, b: '' };
        return { CallUUID: 'uuid-001', CallStatus: 'completed', deep: inner };
      };
      const nonce = 'test-nonce-123';
      const signed = (fields: PlivoParams): WebhookContext => ({
        method: 'POST',
        url,
        headers: {
          'x-plivo-signature-v3-nonce': nonce,
          'x-plivo-signature-v3': computePlivoV3Signature('POST', url, nonce, AUTH_TOKEN, fields),
        },
        body: JSON.stringify(fields),
      });
      const eight = signed(nestedCallback(8));
      expect(provider.verifyWebhook(eight)).toEqual({ valid: true });
      expect(provider.parseWebhookEvent(eight).events.map((event) => event.kind)).toEqual(['call-completed']);
      // One level deeper is refused while parsing, so neither method reads the top-level call fields.
      const nine = signed(nestedCallback(9));
      expect(provider.verifyWebhook(nine)).toEqual({ valid: false, error: 'Unreadable webhook body' });
      expect(provider.parseWebhookEvent(nine).events).toEqual([]);
    });

    it('refuses a JSON array holding an array or an object', () => {
      let nestedArrays: unknown = 'x';
      for (let level = 0; level < 50; level++) nestedArrays = [nestedArrays, ''];
      for (const extra of [nestedArrays, [{ k: 'v' }]]) {
        // CallStatus sits at the top, so a reader that let the body through would emit call-completed.
        const fields = { CallUUID: 'uuid-001', CallStatus: 'completed', Extra: extra };
        const ctx = makeWebhookCtx(url, JSON.stringify(fields), 'test-nonce-123', {
          'x-plivo-signature-v3': 'irrelevant',
        });
        expect(provider.verifyWebhook(ctx)).toEqual({ valid: false, error: 'Unreadable webhook body' });
        expect(provider.parseWebhookEvent(ctx).events).toEqual([]);
      }
    });

    it('verifies a signed framework-parsed body and reads its events', () => {
      const fields = { CallUUID: 'uuid-001', CallStatus: 'completed' };
      const nonce = 'test-nonce-123';
      const ctx: WebhookContext = {
        method: 'POST',
        url,
        headers: {
          'x-plivo-signature-v3-nonce': nonce,
          'x-plivo-signature-v3': computePlivoV3Signature('POST', url, nonce, AUTH_TOKEN, fields),
        },
        body: '',
        parsedBody: fields,
      };
      expect(provider.verifyWebhook(ctx)).toEqual({ valid: true });
      expect(provider.parseWebhookEvent(ctx).events.map((event) => event.kind)).toEqual(['call-completed']);
    });

    it('holds a framework-parsed body with numbers to the same signed-length limit', () => {
      // express.json() hands over numbers and arrays whatever the declared
      // type. A number sorted first used to turn the length budget into NaN
      // and switch the limit off for every field after it.
      const parsedBody = {
        A: 0,
        CallUUID: 'uuid-001',
        CallStatus: 'completed',
        ['k'.repeat(2048)]: Array(1024).fill(''),
      };
      const ctx: WebhookContext = {
        method: 'POST',
        url,
        headers: { 'x-plivo-signature-v3-nonce': 'test-nonce-123', 'x-plivo-signature-v3': 'irrelevant' },
        body: '',
        parsedBody: parsedBody as unknown as Record<string, string>,
      };
      expect(provider.verifyWebhook(ctx)).toEqual({ valid: false, error: 'Unreadable webhook body' });
    });

    it('refuses a JSON array whose key, written before every item, would sign to megabytes', () => {
      // 2,048 characters x 1,024 items is 2,097,152 characters of signed text
      // from a body under 6 KB, past the 1 MiB limit.
      const fields = { CallUUID: 'uuid-001', CallStatus: 'completed', ['k'.repeat(2048)]: Array(1024).fill('') };
      const ctx = makeWebhookCtx(url, JSON.stringify(fields), 'test-nonce-123', {
        'x-plivo-signature-v3': 'irrelevant',
      });
      expect(provider.verifyWebhook(ctx)).toEqual({ valid: false, error: 'Unreadable webhook body' });
    });

    it('verifies signatures made with different nonces', () => {
      const ctx1 = makeWebhookCtx(url, body, 'nonce-AAA');
      const ctx2 = makeWebhookCtx(url, body, 'nonce-BBB');
      expect(provider.verifyWebhook(ctx1).valid).toBe(true);
      expect(provider.verifyWebhook(ctx2).valid).toBe(true);
    });
  });

  // ── verifyWebhook against Plivo's own SDK ──────────────────────────────

  describe('verifyWebhook() against signatures from the plivo-python SDK', () => {
    // Expected values come from plivo-python 4.63.0's
    // plivo/utils/signature_v3.py (construct_post_url / construct_get_url /
    // get_signature_v3) for this token and nonce.
    const token = 'MAAUTHTOKEN0000000000';
    const nonce = '12345678901234567890';
    const cases: Array<[string, string, string, string, string]> = [
      [
        'POST with fields',
        'POST',
        'https://example.com/plivo/voice',
        'CallUUID=c-1&CallStatus=in-progress&From=%2B14155550100&To=%2B14155550199&Direction=inbound',
        '8g00KP5VB5XTGIlzoMOqUxqC/nkRHimbiEC1xVrz5Uw=',
      ],
      [
        'POST with fields and a query',
        'POST',
        'https://example.com/plivo/voice?tenant=a&b=2',
        'CallUUID=c-2&Digits=42',
        'SeOX6BnJwUb0m4yZrqItCMMBuY76tL+q+3n5qZ5LiGU=',
      ],
      ['POST with no fields', 'POST', 'https://example.com/plivo/voice', '', '/z0wpKhs0DmNvNLQiEvCTh0TQ6JJCARjszbxQoyc2eI='],
      [
        'GET with a query',
        'GET',
        'https://example.com/plivo/voice?CallUUID=c-3&From=%2B14155550100',
        '',
        'Iwm1lAZt5VMJXewswd0EI2sBjs4EfmKx7tuutAUK5L8=',
      ],
    ];

    it('accepts the SDK signature for a JSON body with true, false and null', () => {
      // plivo-python writes these as True, False and None:
      // ?CallStatuscompletedCallUUIDc-9ParentUUIDNoneRecordedTrueTransferredFalse
      const sdkSigned = new PlivoVoiceProvider({ authId: AUTH_ID, authToken: token, fetchImpl: fetchMock as typeof fetch });
      const url = 'https://example.com/plivo/voice';
      const body = '{"CallUUID":"c-9","CallStatus":"completed","Recorded":true,"Transferred":false,"ParentUUID":null}';
      const signedAs = (signature: string): WebhookContext => ({
        method: 'POST',
        url,
        headers: { 'x-plivo-signature-v3-nonce': nonce, 'x-plivo-signature-v3': signature },
        body,
      });
      expect(sdkSigned.verifyWebhook(signedAs('W7ki22L90EJZ/O9KEIATjkV876MVHMnhe74FiSkNWak='))).toEqual({ valid: true });
      // The same body with JavaScript's text for true, false and null.
      // plivo-node writes booleans this way; it throws on a null.
      const nodeStyle = computePlivoV3Signature(
        'POST',
        url,
        nonce,
        token,
        { CallUUID: 'c-9', CallStatus: 'completed', Recorded: 'true', Transferred: 'false', ParentUUID: 'null' },
        'js',
      );
      expect(sdkSigned.verifyWebhook(signedAs(nodeStyle))).toEqual({ valid: true });
      // A signature over a different value still fails.
      const otherValue = computePlivoV3Signature('POST', url, nonce, token, {
        CallUUID: 'c-9',
        CallStatus: 'completed',
        Recorded: 'False',
        Transferred: 'False',
        ParentUUID: 'None',
      });
      expect(sdkSigned.verifyWebhook(signedAs(otherValue)).valid).toBe(false);
    });

    it('accepts the SDK signature for a JSON body with floats, exponents and large integers', () => {
      // plivo-python writes json.loads' values with str():
      // ?Big12345678901234567890BillDuration60CallStatuscompletedCallUUIDc-10Duration1.0Exp100.0Neg-0.0Rate1e-07
      const sdkSigned = new PlivoVoiceProvider({ authId: AUTH_ID, authToken: token, fetchImpl: fetchMock as typeof fetch });
      const url = 'https://example.com/plivo/voice';
      const body =
        '{"CallUUID":"c-10","CallStatus":"completed","Duration":1.0,"Rate":1e-7,"BillDuration":60,' +
        '"Big":12345678901234567890,"Neg":-0.0,"Exp":1E2}';
      const signedAs = (signature: string): WebhookContext => ({
        method: 'POST',
        url,
        headers: { 'x-plivo-signature-v3-nonce': nonce, 'x-plivo-signature-v3': signature },
        body,
      });
      expect(sdkSigned.verifyWebhook(signedAs('tef1++fU/JT72b88JlRgwjiwHS8nnre9OBm/Y0mYIn4='))).toEqual({ valid: true });
      // The same body signed the way plivo-node prints JSON.parse's numbers.
      const nodeStyle = computePlivoV3Signature(
        'POST',
        url,
        nonce,
        token,
        {
          CallUUID: 'c-10',
          CallStatus: 'completed',
          Duration: '1',
          Rate: '1e-7',
          BillDuration: '60',
          Big: '12345678901234567000',
          Neg: '0',
          Exp: '100',
        },
        'js',
      );
      expect(sdkSigned.verifyWebhook(signedAs(nodeStyle))).toEqual({ valid: true });
    });

    /** A request carrying `signature` for `body`, signed with the SDK's token and nonce. */
    const sdkRequest = (method: string, url: string, body: string, signature: string): WebhookContext => ({
      method,
      url,
      headers: { 'x-plivo-signature-v3-nonce': nonce, 'x-plivo-signature-v3': signature },
      body,
    });

    it('accepts the SDK signature for JSON integers written from their tokens', () => {
      // plivo-python: ?Big123456789012345678901234567890CallStatuscompletedCallUUIDc-14Zero0
      // (json.loads reads -0 as the int 0, and the 30-digit integer exactly).
      const sdkSigned = new PlivoVoiceProvider({ authId: AUTH_ID, authToken: token, fetchImpl: fetchMock as typeof fetch });
      const body = '{"CallUUID":"c-14","CallStatus":"completed","Zero":-0,"Big":123456789012345678901234567890}';
      const ctx = sdkRequest('POST', 'https://example.com/plivo/voice', body, 'pOca7E/FxM7MmnBIoZj/IdQC5+OV1a0xlhXh5vi4HGg=');
      expect(sdkSigned.verifyWebhook(ctx)).toEqual({ valid: true });
    });

    it('accepts the SDK signature for a JSON array of strings', () => {
      // plivo-python: ?CallStatuscompletedCallUUIDc-11TagsaTagsb
      const sdkSigned = new PlivoVoiceProvider({ authId: AUTH_ID, authToken: token, fetchImpl: fetchMock as typeof fetch });
      const body = '{"CallUUID":"c-11","CallStatus":"completed","Tags":["b","a"]}';
      const ctx = sdkRequest('POST', 'https://example.com/plivo/voice', body, 'zq63ccD7N/cOoTTUonEz1STXKGlAVlCzv2O2e/gbvZc=');
      expect(sdkSigned.verifyWebhook(ctx)).toEqual({ valid: true });
    });

    it('accepts both sort orders when repeated values differ by code point and by UTF-16 unit', () => {
      // U+FF01 sorts before U+1F600 by code point (plivo-python signs Tag！Tag😀)
      // and after it by UTF-16 unit (JavaScript's default sort, Tag😀Tag！).
      const sdkSigned = new PlivoVoiceProvider({ authId: AUTH_ID, authToken: token, fetchImpl: fetchMock as typeof fetch });
      const url = 'https://example.com/plivo/voice';
      const body = 'CallUUID=c-1&Tag=%EF%BC%81&Tag=%F0%9F%98%80';
      const pythonSigned = 'QDpoprQGrRCVhswO1Se/jqBuQGjVQrvUwvRkUino+sY=';
      expect(sdkSigned.verifyWebhook(sdkRequest('POST', url, body, pythonSigned))).toEqual({ valid: true });
      const jsSigned = computePlivoV3Signature('POST', url, nonce, token, { CallUUID: 'c-1', Tag: ['！', '😀'] }, 'js');
      expect(jsSigned).not.toBe(pythonSigned);
      expect(sdkSigned.verifyWebhook(sdkRequest('POST', url, body, jsSigned))).toEqual({ valid: true });
    });

    it('accepts both readings of a GET query with non-ASCII text', () => {
      // plivo-python decodes the query one character per byte: Name=cafÃ©.
      const sdkSigned = new PlivoVoiceProvider({ authId: AUTH_ID, authToken: token, fetchImpl: fetchMock as typeof fetch });
      const url = 'https://example.com/plivo/voice?CallUUID=c-12&Name=caf%C3%A9';
      const pythonSigned = 'SGcRPuGJUj2TOBihDTgWnBPHTyoO98ppRPB3P1+U6lM=';
      expect(sdkSigned.verifyWebhook(sdkRequest('GET', url, '', pythonSigned))).toEqual({ valid: true });
      // Read as UTF-8 (Name=café), as plivo-node reads it.
      const utf8Signed = computePlivoV3Signature('GET', url, nonce, token, {}, 'js');
      expect(utf8Signed).not.toBe(pythonSigned);
      expect(sdkSigned.verifyWebhook(sdkRequest('GET', url, '', utf8Signed))).toEqual({ valid: true });
    });

    it('reads a JSON event field only when it is a string', () => {
      // plivo-python signs Digits1.0; JavaScript would read the digit as 1, so
      // the number counts as no Digits at all and only the status event remains.
      const sdkSigned = new PlivoVoiceProvider({ authId: AUTH_ID, authToken: token, fetchImpl: fetchMock as typeof fetch });
      const body = '{"CallUUID":"c-13","CallStatus":"in-progress","Digits":1.0}';
      const ctx = sdkRequest('POST', 'https://example.com/plivo/voice', body, 'Sf6ytcN6/6WIGUXFoXjaaNu3lZ80Zo5odb9/ccSZEj0=');
      expect(sdkSigned.verifyWebhook(ctx)).toEqual({ valid: true });
      const { events } = sdkSigned.parseWebhookEvent(ctx);
      expect(events.map((event) => [event.kind, event.providerCallId])).toEqual([['call-answered', 'c-13']]);
    });

    it.each(cases)('accepts the SDK signature for a %s', (_label, method, url, body, signature) => {
      const sdkSigned = new PlivoVoiceProvider({ authId: AUTH_ID, authToken: token, fetchImpl: fetchMock as typeof fetch });
      const ctx: WebhookContext = {
        method,
        url,
        headers: { 'x-plivo-signature-v3-nonce': nonce, 'x-plivo-signature-v3': signature },
        body,
      };
      expect(sdkSigned.verifyWebhook(ctx)).toEqual({ valid: true });
    });
  });

  // ── parseWebhookEvent ──────────────────────────────────────────────────

  describe('parseWebhookEvent()', () => {
    const url = 'https://example.com/plivo/webhook';

    // Table-driven test for all CallStatus -> kind mappings.
    const cases: Array<[string, string]> = [
      ['ringing', 'call-ringing'],
      ['in-progress', 'call-answered'],
      ['completed', 'call-completed'],
      ['busy', 'call-busy'],
      ['no-answer', 'call-no-answer'],
      ['failed', 'call-failed'],
    ];

    for (const [plivoStatus, expectedKind] of cases) {
      it(`should map CallStatus="${plivoStatus}" to kind="${expectedKind}"`, () => {
        const body = `CallUUID=uuid-001&CallStatus=${plivoStatus}`;
        const ctx = makeWebhookCtx(url, body);
        const result = provider.parseWebhookEvent(ctx);
        expect(result.events).toHaveLength(1);
        expect(result.events[0].kind).toBe(expectedKind);
        expect(result.events[0].providerCallId).toBe('uuid-001');
      });
    }

    it('should emit a call-dtmf event when Digits param is present (from <GetDigits> callback)', () => {
      const body = 'CallUUID=uuid-002&CallStatus=in-progress&Digits=9';
      const ctx = makeWebhookCtx(url, body);
      const result = provider.parseWebhookEvent(ctx);
      // Both call-answered and call-dtmf events should be emitted.
      expect(result.events).toHaveLength(2);
      const dtmf = result.events.find(e => e.kind === 'call-dtmf');
      expect(dtmf).toBeDefined();
      if (dtmf?.kind === 'call-dtmf') {
        expect(dtmf.digit).toBe('9');
      }
    });

    it('should emit no events for unknown CallStatus values like "queued"', () => {
      const body = 'CallUUID=uuid-003&CallStatus=queued';
      const ctx = makeWebhookCtx(url, body);
      const result = provider.parseWebhookEvent(ctx);
      expect(result.events).toHaveLength(0);
    });

    it('should parse a JSON body as a fallback when the body starts with "{"', () => {
      // Some Plivo callbacks may arrive as JSON instead of form-encoded.
      const body = JSON.stringify({ CallUUID: 'uuid-004', CallStatus: 'completed' });
      const ctx: WebhookContext = { method: 'POST', url, headers: {}, body };
      const result = provider.parseWebhookEvent(ctx);
      expect(result.events[0].kind).toBe('call-completed');
      expect(result.events[0].providerCallId).toBe('uuid-004');
    });

    it('reads a GET callback from its signed query and ignores the body', () => {
      const getUrl = 'https://example.com/plivo/webhook?CallUUID=uuid-get&CallStatus=completed';
      const nonce = 'test-nonce-123';
      const ctx: WebhookContext = {
        method: 'GET',
        url: getUrl,
        headers: {
          'x-plivo-signature-v3-nonce': nonce,
          'x-plivo-signature-v3': computePlivoV3Signature('GET', getUrl, nonce, AUTH_TOKEN),
        },
        body: 'CallUUID=uuid-forged&CallStatus=failed',
      };
      expect(provider.verifyWebhook(ctx)).toEqual({ valid: true });
      const { events } = provider.parseWebhookEvent(ctx);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'call-completed', providerCallId: 'uuid-get' });
    });

    it('should assign unique eventIds to multiple events for idempotency tracking', () => {
      const body = 'CallUUID=uuid-005&CallStatus=in-progress&Digits=1';
      const ctx = makeWebhookCtx(url, body);
      const result = provider.parseWebhookEvent(ctx);
      const ids = result.events.map(e => e.eventId);
      // Every event ID should be unique (UUIDs).
      expect(new Set(ids).size).toBe(ids.length);
    });
  });
});

describe('pythonFloatRepr()', () => {
  // Each expected string is Python 3's repr() of the same float.
  const cases: Array<[number, string]> = [
    [1.0, '1.0'],
    [1e-7, '1e-07'],
    [123.456, '123.456'],
    [1e16, '1e+16'],
    [1e15, '1000000000000000.0'],
    [0.0001, '0.0001'],
    [0.00001, '1e-05'],
    [100.0, '100.0'],
    [1.5e300, '1.5e+300'],
    [-0.0, '-0.0'],
    [5e-324, '5e-324'],
    [1.7976931348623157e308, '1.7976931348623157e+308'],
    [0.1, '0.1'],
    [2.5e-5, '2.5e-05'],
    [123456789.123, '123456789.123'],
  ];

  it.each(cases)('writes %s as %s', (value, expected) => {
    expect(pythonFloatRepr(value)).toBe(expected);
  });
});
