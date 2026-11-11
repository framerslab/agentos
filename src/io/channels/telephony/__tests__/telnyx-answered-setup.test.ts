/**
 * @fileoverview A Telnyx Call Control call set up by AgentOS when it is answered.
 *
 * Twilio and Plivo read the host's answer XML when a call connects; Telnyx
 * takes commands instead. These tests run a {@link CallManager} with a
 * carrier-profile {@link TelnyxVoiceProvider} over Ed25519-signed webhooks,
 * through `processWebhookDurable` with the in-memory store and through
 * `processWebhook` in process, and read the commands the provider sends:
 *
 * - A notify call speaks its message with the `speak` command once, when the
 *   `call.answered` webhook first moves it to `answered`; a retried webhook
 *   sends nothing more.
 * - A conversation call, whose dial request carried the media stream URL,
 *   gets no command.
 * - A `speak` Telnyx refuses is written to the console, and the call's later
 *   webhooks still apply.
 * - A legacy-profile provider sends no command: its host sends them, as the
 *   telephony guide says.
 *
 * No network I/O is performed: the provider's fetch is a mock.
 */

import { describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';

import { CallManager } from '../CallManager.js';
import { TelnyxVoiceProvider } from '../providers/telnyx.js';
import { InMemoryTelephonyCallStore } from '../TelephonyCallStore.js';
import type { VoiceCallConfig, WebhookContext } from '../types.js';

const CONNECTION_ID = 'conn-answered-setup';
const CALL_CONTROL_ID = 'v3:call-control-answered';
const MESSAGE = 'Your order has shipped.';
const VOICE = 'AWS.Polly.Joanna';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
/** The 32 raw key bytes, base64, as the Telnyx portal shows the public key. */
const PORTAL_PUBLIC_KEY = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');

/** A Telnyx webhook signed the way Telnyx signs it: Ed25519 over `{timestamp}|{body}`. */
function signedEvent(eventType: string, id: string): WebhookContext {
  const body = JSON.stringify({
    data: {
      event_type: eventType,
      id,
      occurred_at: '2026-11-11T08:00:00.000Z',
      payload: { call_control_id: CALL_CONTROL_ID, call_session_id: 'session-answered-setup' },
    },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(null, Buffer.from(`${timestamp}|${body}`), privateKey).toString('base64');
  return {
    method: 'POST',
    url: 'https://example.test/voice/webhook/telnyx',
    headers: { 'telnyx-timestamp': timestamp, 'telnyx-signature-ed25519': signature },
    body,
  };
}

/** A fetch mock that answers the dial request with a call control id and every command with `commandStatus`. */
function telnyxApi(commandStatus = 200) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    const dial = url.endsWith('/v2/calls');
    const body = dial
      ? { data: { call_control_id: CALL_CONTROL_ID, call_session_id: 'session-answered-setup' } }
      : commandStatus === 200 ? { data: { result: 'ok' } } : { errors: [{ title: 'Command refused' }] };
    return new Response(JSON.stringify(body), { status: dial ? 200 : commandStatus, headers: { 'Content-Type': 'application/json' } });
  });
}

/** The commands sent to the call, by action name, with their JSON bodies. */
function commands(fetchMock: ReturnType<typeof telnyxApi>): Array<{ action: string; body: Record<string, unknown> }> {
  return fetchMock.mock.calls
    .map(([input, init]) => ({ url: String(input), init }))
    .filter(({ url }) => url.includes('/actions/'))
    .map(({ url, init }) => ({ action: url.slice(url.lastIndexOf('/') + 1), body: JSON.parse(String(init?.body)) as Record<string, unknown> }));
}

/** Lets the manager's fire-and-forget setup reach the mock. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function setUp(options: { protocol?: 'legacy' | 'carrier'; eventHandling?: VoiceCallConfig['eventHandling']; commandStatus?: number } = {}) {
  const fetchMock = telnyxApi(options.commandStatus);
  const manager = new CallManager({
    provider: { provider: 'telnyx', config: { apiKey: 'KEY_answered_setup', connectionId: CONNECTION_ID, publicKey: PORTAL_PUBLIC_KEY, fromNumber: '+15550000001' } },
    webhookBaseUrl: 'https://example.test',
    streaming: { enabled: true },
    tts: { voice: VOICE },
    eventHandling: options.eventHandling,
  });
  manager.registerProvider(new TelnyxVoiceProvider({
    apiKey: 'KEY_answered_setup',
    connectionId: CONNECTION_ID,
    publicKey: PORTAL_PUBLIC_KEY,
    protocol: options.protocol ?? 'carrier',
    fetchImpl: fetchMock,
  }));
  return { manager, fetchMock };
}

describe('a carrier-profile Telnyx call set up when it is answered', () => {
  it('speaks a notify call\'s message once when the signed call.answered webhook commits to the store', async () => {
    const { manager, fetchMock } = setUp();
    const store = new InMemoryTelephonyCallStore();
    try {
      const call = await manager.initiateCall({ toNumber: '+15550000002', mode: 'notify', message: MESSAGE });
      expect(call.providerCallId).toBe(CALL_CONTROL_ID);
      await manager.persistCall(call.callId, store);

      expect(await manager.processWebhookDurable('telnyx', signedEvent('call.initiated', 'evt-initiated'), store)).toEqual({ accepted: true, applied: 1 });
      await settle();
      expect(commands(fetchMock)).toEqual([]);

      expect(await manager.processWebhookDurable('telnyx', signedEvent('call.answered', 'evt-answered'), store)).toEqual({ accepted: true, applied: 1 });
      await vi.waitFor(() => expect(commands(fetchMock)).toHaveLength(1));
      const [speak] = commands(fetchMock);
      expect(speak.action).toBe('speak');
      expect(speak.body).toMatchObject({ payload: MESSAGE, voice: VOICE, language: 'en-US' });
      expect(fetchMock.mock.calls.find(([input]) => String(input).endsWith('/actions/speak'))?.[0]).toBe('https://api.telnyx.com/v2/calls/v3:call-control-answered/actions/speak');

      // Telnyx retries a webhook it got no 2xx for: the retry changes nothing and speaks nothing more.
      expect(await manager.processWebhookDurable('telnyx', signedEvent('call.answered', 'evt-answered'), store)).toEqual({ accepted: true, applied: 0 });
      await settle();
      expect(commands(fetchMock)).toHaveLength(1);
      expect(manager.getCall(call.callId)?.state).toBe('answered');
    } finally {
      manager.dispose();
    }
  });

  it.each(['carrier', 'legacy'] as const)('speaks a notify call\'s message once through processWebhook with eventHandling %s', async (eventHandling) => {
    const { manager, fetchMock } = setUp({ eventHandling });
    try {
      const call = await manager.initiateCall({ toNumber: '+15550000002', mode: 'notify', message: MESSAGE });
      manager.processWebhook('telnyx', signedEvent('call.initiated', 'evt-initiated'));
      manager.processWebhook('telnyx', signedEvent('call.answered', 'evt-answered'));
      manager.processWebhook('telnyx', signedEvent('call.answered', 'evt-answered'));
      await vi.waitFor(() => expect(commands(fetchMock)).toHaveLength(1));
      await settle();
      expect(commands(fetchMock)).toEqual([{ action: 'speak', body: expect.objectContaining({ payload: MESSAGE, voice: VOICE }) }]);
      expect(manager.getCall(call.callId)?.state).toBe('answered');
    } finally {
      manager.dispose();
    }
  });

  it('sends no command for a conversation call, whose dial request already carried the media stream URL', async () => {
    const { manager, fetchMock } = setUp();
    try {
      await manager.initiateCall({ toNumber: '+15550000002', mode: 'conversation' });
      const dial = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
      expect(dial.stream_url).toBe('wss://example.test/voice/media-stream');
      manager.processWebhook('telnyx', signedEvent('call.answered', 'evt-answered'));
      await settle();
      expect(commands(fetchMock)).toEqual([]);
    } finally {
      manager.dispose();
    }
  });

  it('writes a refused speak command to the console and goes on applying the call\'s webhooks', async () => {
    const { manager, fetchMock } = setUp({ commandStatus: 422 });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const call = await manager.initiateCall({ toNumber: '+15550000002', mode: 'notify', message: MESSAGE });
      expect(() => manager.processWebhook('telnyx', signedEvent('call.answered', 'evt-answered'))).not.toThrow();
      await vi.waitFor(() => expect(consoleError).toHaveBeenCalledWith('[CallManager] Setting up the answered call failed:', expect.objectContaining({ message: 'Telnyx speak failed: 422' })));
      expect(commands(fetchMock)).toHaveLength(1);
      manager.processWebhook('telnyx', signedEvent('call.hangup', 'evt-hangup'));
      expect(manager.getCall(call.callId)?.state).toBe('completed');
    } finally {
      consoleError.mockRestore();
      manager.dispose();
    }
  });

  it('leaves the commands to the host with a legacy-profile provider', async () => {
    const { manager, fetchMock } = setUp({ protocol: 'legacy' });
    try {
      const call = await manager.initiateCall({ toNumber: '+15550000002', mode: 'notify', message: MESSAGE });
      manager.processWebhook('telnyx', signedEvent('call.answered', 'evt-answered'));
      await settle();
      expect(manager.getCall(call.callId)?.state).toBe('answered');
      expect(commands(fetchMock)).toEqual([]);
    } finally {
      manager.dispose();
    }
  });
});
