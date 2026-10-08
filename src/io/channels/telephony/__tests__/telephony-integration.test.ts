/**
 * @fileoverview Telephony integration tests.
 *
 * Exercises two end-to-end paths without any real network I/O:
 *
 * ## Suite 1: Media stream path
 * ```
 * TwilioMediaStreamParser -> TelephonyStreamTransport -> AudioFrame events
 * ```
 * Validates that real Twilio JSON messages flow through the parser and
 * transport, producing correctly-shaped AudioFrame events with Float32
 * samples normalised to [-1, 1].
 *
 * ## Suite 2: Webhook state machine path
 * ```
 * TwilioVoiceProvider + CallManager -> state transitions
 * ```
 * Validates the full ringing -> answered -> completed lifecycle via
 * HMAC-SHA1 signed webhooks processed by the CallManager.
 *
 * No network I/O is performed -- WebSocket and HTTP interactions are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHmac } from 'node:crypto';

import { TwilioMediaStreamParser } from '../parsers/TwilioMediaStreamParser.js';
import { TelephonyStreamTransport } from '../TelephonyStreamTransport.js';
import { CallManager } from '../CallManager.js';
import { TwilioVoiceProvider } from '../providers/twilio.js';
import type { AudioFrame } from '../../../voice-pipeline/types.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Build a minimal mock WebSocket-like EventEmitter with send() and close(). */
function createMockWS(): EventEmitter & { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  const ws = new EventEmitter();
  (ws as any).send = vi.fn();
  (ws as any).close = vi.fn();
  return ws as EventEmitter & { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
}

/** Build a mu-law silence buffer (0x7f = zero-crossing in G.711 mu-law). */
function mulawBytes(count = 16): Buffer {
  return Buffer.alloc(count, 0x7f);
}

/** Build a Twilio `start` JSON string with call metadata. */
function twilioStart(streamSid = 'MX_STREAM_001', callSid = 'CA_CALL_001'): string {
  return JSON.stringify({
    event: 'start',
    streamSid,
    start: { callSid, streamSid, mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 } },
  });
}

/** Build a Twilio `media` JSON string with base64-encoded mu-law audio. */
function twilioMedia(streamSid = 'MX_STREAM_001', payloadBytes = 16): string {
  return JSON.stringify({
    event: 'media',
    streamSid,
    media: {
      track: 'inbound',
      payload: mulawBytes(payloadBytes).toString('base64'),
    },
  });
}

/** Build a Twilio `dtmf` JSON string for a key-press event. */
function twilioDtmf(streamSid = 'MX_STREAM_001', digit = '7', duration = 200): string {
  return JSON.stringify({
    event: 'dtmf',
    streamSid,
    dtmf: { digit, duration },
  });
}

/** Build a Twilio `stop` JSON string for stream termination. */
function twilioStop(streamSid = 'MX_STREAM_001'): string {
  return JSON.stringify({ event: 'stop', streamSid });
}

/**
 * Compute the Twilio HMAC-SHA1 webhook signature.
 *
 * Reproduces Twilio's signing: URL + sorted key-value pairs, HMAC-SHA1,
 * base64-encoded.
 */
function twilioSig(authToken: string, url: string, body: string): string {
  const params = new URLSearchParams(body);
  let data = url;
  for (const key of [...new Set(params.keys())].sort()) {
    for (const value of [...new Set(params.getAll(key))].sort()) data += key + value;
  }
  return createHmac('sha1', authToken).update(data).digest('base64');
}

// ---------------------------------------------------------------------------
// Suite 1: TwilioMediaStreamParser + TelephonyStreamTransport (media stream)
// ---------------------------------------------------------------------------

describe('TwilioMediaStreamParser + TelephonyStreamTransport integration', () => {
  let ws: ReturnType<typeof createMockWS>;
  let parser: TwilioMediaStreamParser;
  let transport: TelephonyStreamTransport;

  beforeEach(() => {
    ws = createMockWS();
    parser = new TwilioMediaStreamParser();
    transport = new TelephonyStreamTransport(ws, parser, { outputSampleRate: 16000 });
  });

  it('should start in "connecting" state before any Twilio messages arrive', () => {
    expect(transport.state).toBe('connecting');
  });

  it('should transition to "open" after receiving a Twilio start message', () => {
    ws.emit('message', twilioStart());
    expect(transport.state).toBe('open');
  });

  it('should send a connected acknowledgment JSON message after receiving start', () => {
    ws.emit('message', twilioStart('MX1', 'CA1'));
    // TwilioMediaStreamParser.formatConnected returns the connected handshake.
    expect((ws.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    const sent = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    expect(sent).toMatchObject({ event: 'connected', protocol: 'Call' });
  });

  it('should emit an "audio" event with Float32Array AudioFrame when media messages arrive', () => {
    ws.emit('message', twilioStart());

    const frames: AudioFrame[] = [];
    transport.on('audio', (f: AudioFrame) => frames.push(f));

    ws.emit('message', twilioMedia('MX_STREAM_001', 16));

    expect(frames).toHaveLength(1);
    const frame = frames[0];
    expect(frame.samples).toBeInstanceOf(Float32Array);
    expect(frame.sampleRate).toBe(16000);
    expect(typeof frame.timestamp).toBe('number');
  });

  it('should normalise Float32 samples to the [-1, 1] range', () => {
    ws.emit('message', twilioStart());
    const frames: AudioFrame[] = [];
    transport.on('audio', (f: AudioFrame) => frames.push(f));
    ws.emit('message', twilioMedia('MX_STREAM_001', 64));

    const { samples } = frames[0];
    for (let i = 0; i < samples.length; i++) {
      expect(samples[i]).toBeGreaterThanOrEqual(-1);
      expect(samples[i]).toBeLessThanOrEqual(1);
    }
  });

  it('should emit "dtmf" event with digit and durationMs when DTMF arrives', () => {
    ws.emit('message', twilioStart());

    const dtmfEvents: Array<{ digit: string; durationMs?: number }> = [];
    transport.on('dtmf', (d) => dtmfEvents.push(d));

    ws.emit('message', twilioDtmf('MX_STREAM_001', '7', 200));

    expect(dtmfEvents).toHaveLength(1);
    expect(dtmfEvents[0].digit).toBe('7');
    expect(dtmfEvents[0].durationMs).toBe(200);
  });

  it('should emit "close" and transition to "closed" when stop message arrives', () => {
    ws.emit('message', twilioStart());

    let closedFired = false;
    transport.on('close', () => { closedFired = true; });

    ws.emit('message', twilioStop());

    expect(closedFired).toBe(true);
    expect(transport.state).toBe('closed');
  });

  it('should emit "close" and transition to "closed" when WebSocket closes unexpectedly', () => {
    ws.emit('message', twilioStart());

    let closedFired = false;
    transport.on('close', () => { closedFired = true; });

    ws.emit('close');

    expect(closedFired).toBe(true);
    expect(transport.state).toBe('closed');
  });

  it('should not emit a second "close" when WS close fires after stop message', () => {
    ws.emit('message', twilioStart());

    let closeCount = 0;
    transport.on('close', () => { closeCount++; });

    ws.emit('message', twilioStop());
    ws.emit('close');

    // Only one close event should fire, not two.
    expect(closeCount).toBe(1);
  });

  it('should discard outbound media messages (track=outbound) to prevent echo', () => {
    ws.emit('message', twilioStart());

    const frames: AudioFrame[] = [];
    transport.on('audio', (f: AudioFrame) => frames.push(f));

    const outboundMsg = JSON.stringify({
      event: 'media',
      streamSid: 'MX_STREAM_001',
      media: { track: 'outbound', payload: mulawBytes(16).toString('base64') },
    });
    ws.emit('message', outboundMsg);

    expect(frames).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: CallManager + TwilioVoiceProvider webhook state transitions
// ---------------------------------------------------------------------------

describe('CallManager + TwilioVoiceProvider integration', () => {
  const ACCOUNT_SID = 'ACtest_integration';
  const AUTH_TOKEN = 'secret_integration_token';
  const WEBHOOK_URL = 'https://example.com/voice/webhook/twilio';

  let fetchMock: ReturnType<typeof vi.fn>;
  let provider: TwilioVoiceProvider;
  let manager: CallManager;

  beforeEach(() => {
    fetchMock = vi.fn();

    provider = new TwilioVoiceProvider({
      accountSid: ACCOUNT_SID,
      authToken: AUTH_TOKEN,
      fetchImpl: fetchMock as typeof fetch,
    });

    manager = new CallManager({
      provider: { provider: 'twilio', config: { accountSid: 'test', authToken: 'test', phoneNumber: '+1' } } as any,
      webhookBaseUrl: 'https://example.com',
    });

    manager.registerProvider(provider);
  });

  /** Build a signed webhook context for a URL-encoded body. */
  function makeCtx(body: string) {
    const sig = twilioSig(AUTH_TOKEN, WEBHOOK_URL, body);
    return {
      method: 'POST' as const,
      url: WEBHOOK_URL,
      headers: { 'x-twilio-signature': sig } as Record<string, string>,
      body,
    };
  }

  it('should register the twilio provider and retrieve it by name', () => {
    expect(manager.getProvider('twilio')).toBe(provider);
  });

  it('should initiate an outbound call and create a CallRecord in "initiated" state', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ sid: 'CA_OUT_001' }),
      text: async () => '{"sid":"CA_OUT_001"}',
    });

    const call = await manager.initiateCall({
      toNumber: '+15550001234',
      fromNumber: '+15559876543',
      mode: 'conversation',
    });

    expect(call.state).toBe('initiated');
    expect(call.toNumber).toBe('+15550001234');
    expect(call.provider).toBe('twilio');
    expect(call.providerCallId).toBe('CA_OUT_001');
  });

  it('should transition to "ringing" when a call-ringing webhook arrives', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ sid: 'CA_RING_001' }),
      text: async () => '{"sid":"CA_RING_001"}',
    });

    const events: string[] = [];
    manager.on((e) => { events.push(e.type); });

    await manager.initiateCall({ toNumber: '+15550001111', fromNumber: '+15559991111' });

    const body = new URLSearchParams({
      CallSid: 'CA_RING_001',
      CallStatus: 'ringing',
      From: '+15559991111',
      To: '+15550001111',
    }).toString();

    manager.processWebhook('twilio', makeCtx(body));

    const call = manager.getActiveCalls()[0];
    expect(call?.state).toBe('ringing');
    expect(events).toContain('call:ringing');
  });

  it('should transition through answered to completed via sequential webhooks', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ sid: 'CA_FULL_001' }),
      text: async () => '{"sid":"CA_FULL_001"}',
    });

    const stateHistory: string[] = [];
    manager.on((e) => { stateHistory.push(e.type); });

    await manager.initiateCall({ toNumber: '+15550002222', fromNumber: '+15559992222' });

    const callSid = 'CA_FULL_001';

    const makeBody = (status: string) =>
      new URLSearchParams({ CallSid: callSid, CallStatus: status, From: '+15559992222', To: '+15550002222' }).toString();

    // Process the full lifecycle: ringing -> in-progress -> completed.
    manager.processWebhook('twilio', makeCtx(makeBody('ringing')));
    manager.processWebhook('twilio', makeCtx(makeBody('in-progress')));
    manager.processWebhook('twilio', makeCtx(makeBody('completed')));

    const call = manager.getActiveCalls()[0];
    expect(call.state).toBe('completed');
    expect(stateHistory).toContain('call:ringing');
    expect(stateHistory).toContain('call:answered');
    expect(stateHistory).toContain('call:ended');
  });

  it('should reject a webhook with an invalid signature and log a warning', () => {
    const badCtx = {
      method: 'POST' as const,
      url: WEBHOOK_URL,
      headers: { 'x-twilio-signature': 'bad_signature' } as Record<string, string>,
      body: new URLSearchParams({ CallSid: 'CA_BAD', CallStatus: 'ringing' }).toString(),
    };

    // processWebhook logs a warning and returns without processing events.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    manager.processWebhook('twilio', badCtx);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Webhook verification failed'));
    warnSpy.mockRestore();
  });

  it('should emit call:initiated event when a call is successfully initiated', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ sid: 'CA_EVT_001' }),
      text: async () => '{"sid":"CA_EVT_001"}',
    });

    const events: string[] = [];
    manager.on((e) => { events.push(e.type); });

    await manager.initiateCall({ toNumber: '+15550003333', fromNumber: '+15559993333' });
    expect(events).toContain('call:initiated');
  });
});
