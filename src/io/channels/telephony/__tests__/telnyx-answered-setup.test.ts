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
 * - A notify call hangs up once, ending `hangup-bot`, when the
 *   `call.speak.ended` webhook of its message's `speak` reports the message
 *   spoken whole; a message cut short, a `speak` the provider did not send
 *   and a legacy-profile provider hang nothing up.
 * - An inbound call the host admits is answered with one `answer` command
 *   carrying the media stream settings the dial uses, so the `call.answered`
 *   that follows moves it to `listening` with no `streaming_start`; a refused
 *   `answer` rejects, and a legacy-profile provider sends nothing.
 *
 * No network I/O is performed: the provider's fetch is a mock.
 */

import { describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';

import { CallManager } from '../CallManager.js';
import { TelnyxVoiceProvider } from '../providers/telnyx.js';
import { InMemoryTelephonyCallStore } from '../TelephonyCallStore.js';
import type { ITelephonyCallStore, VoiceCallConfig, WebhookContext } from '../types.js';

const CONNECTION_ID = 'conn-answered-setup';
const CALL_CONTROL_ID = 'v3:call-control-answered';
const MESSAGE = 'Your order has shipped.';
const VOICE = 'AWS.Polly.Joanna';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
/** The 32 raw key bytes, base64, as the Telnyx portal shows the public key. */
const PORTAL_PUBLIC_KEY = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');

/** A Telnyx webhook signed the way Telnyx signs it: Ed25519 over `{timestamp}|{body}`, with `payload` added to the event's payload. */
function signedEvent(eventType: string, id: string, payload: Record<string, unknown> = {}): WebhookContext {
  const body = JSON.stringify({
    data: {
      event_type: eventType,
      id,
      occurred_at: '2026-11-11T08:00:00.000Z',
      payload: { call_control_id: CALL_CONTROL_ID, call_session_id: 'session-answered-setup', ...payload },
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

function setUp(options: { protocol?: 'legacy' | 'carrier'; eventHandling?: VoiceCallConfig['eventHandling']; commandStatus?: number; streaming?: boolean } = {}) {
  const fetchMock = telnyxApi(options.commandStatus);
  const manager = new CallManager({
    provider: { provider: 'telnyx', config: { apiKey: 'KEY_answered_setup', connectionId: CONNECTION_ID, publicKey: PORTAL_PUBLIC_KEY, fromNumber: '+15550000001' } },
    webhookBaseUrl: 'https://example.test',
    streaming: { enabled: options.streaming ?? true },
    tts: { voice: VOICE },
    eventHandling: options.eventHandling,
    inboundPolicy: 'open',
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

/** The action names of the commands sent to the call, in order. */
const actions = (fetchMock: ReturnType<typeof telnyxApi>): string[] => commands(fetchMock).map(({ action }) => action);

/** The `client_state` a carrier-profile provider puts on a notify call's `speak`, which Telnyx echoes on the call's later webhooks. */
async function notifySpeakClientState(): Promise<unknown> {
  const fetchMock = telnyxApi();
  const provider = new TelnyxVoiceProvider({ apiKey: 'KEY_answered_setup', connectionId: CONNECTION_ID, publicKey: PORTAL_PUBLIC_KEY, protocol: 'carrier', fetchImpl: fetchMock });
  await provider.onCallAnswered({ callId: 'call-for-client-state', providerCallId: CALL_CONTROL_ID, direction: 'outbound', mode: 'notify', message: MESSAGE });
  return commands(fetchMock)[0]?.body.client_state;
}

describe('a carrier-profile Telnyx notify call hung up after its message', () => {
  it('hangs up once when the signed call.speak.ended webhook for the message commits to the store', async () => {
    const { manager, fetchMock } = setUp();
    const store = new InMemoryTelephonyCallStore();
    const ended: string[] = [];
    manager.on((event) => { if (event.type === 'call:ended') ended.push(event.call.state); });
    try {
      const call = await manager.initiateCall({ toNumber: '+15550000002', mode: 'notify', message: MESSAGE });
      await manager.persistCall(call.callId, store);
      await manager.processWebhookDurable('telnyx', signedEvent('call.answered', 'evt-answered'), store);
      await vi.waitFor(() => expect(actions(fetchMock)).toEqual(['speak']));

      // Telnyx sends call.speak.ended with the speak command's client_state when it has spoken the message.
      const spoken = signedEvent('call.speak.ended', 'evt-speak-ended', { client_state: commands(fetchMock)[0]?.body.client_state, status: 'completed' });
      const result = await manager.processWebhookDurable('telnyx', spoken, store);
      await vi.waitFor(() => expect(actions(fetchMock)).toEqual(['speak', 'hangup']));
      await vi.waitFor(() => expect(ended).toEqual(['hangup-bot']));
      expect(result).toEqual({ accepted: true, applied: 1 });
      expect(fetchMock.mock.calls.find(([input]) => String(input).endsWith('/actions/hangup'))?.[0]).toBe('https://api.telnyx.com/v2/calls/v3:call-control-answered/actions/hangup');
      expect(manager.getCall(call.callId)?.state).toBe('hangup-bot');

      // A retried call.speak.ended, and the call.hangup the hangup causes, change nothing and send nothing.
      expect(await manager.processWebhookDurable('telnyx', spoken, store)).toEqual({ accepted: true, applied: 0 });
      expect(await manager.processWebhookDurable('telnyx', signedEvent('call.hangup', 'evt-hangup', { hangup_cause: 'normal_clearing' }), store)).toEqual({ accepted: true, applied: 0 });
      await settle();
      expect(actions(fetchMock)).toEqual(['speak', 'hangup']);
      expect(ended).toEqual(['hangup-bot']);
      expect(manager.getCall(call.callId)?.state).toBe('hangup-bot');
    } finally {
      manager.dispose();
    }
  });

  it('hangs up on a call.speak.ended redelivered to another manager when the first hangup did not commit', async () => {
    const store = new InMemoryTelephonyCallStore();
    // Fails one transaction, the way a worker that stopped leaves it uncommitted.
    let failTransaction = 0;
    let transactions = 0;
    const flaky: ITelephonyCallStore = {
      withProvider: (provider, work) => (++transactions === failTransaction ? Promise.reject(new Error('store unavailable')) : store.withProvider(provider, work)),
    };
    const first = setUp();
    const second = setUp();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const call = await first.manager.initiateCall({ toNumber: '+15550000002', mode: 'notify', message: MESSAGE });
      await first.manager.persistCall(call.callId, flaky);
      await first.manager.processWebhookDurable('telnyx', signedEvent('call.answered', 'evt-answered'), flaky);
      await vi.waitFor(() => expect(actions(first.fetchMock)).toEqual(['speak']));
      const spoken = signedEvent('call.speak.ended', 'evt-speak-ended', { client_state: commands(first.fetchMock)[0]?.body.client_state, status: 'completed' });

      // The event commits; the hangup's own transaction, the next one, does not.
      failTransaction = transactions + 2;
      await expect(first.manager.processWebhookDurable('telnyx', spoken, flaky)).rejects.toThrow('store unavailable');

      // Telnyx redelivers the webhook it got no 2xx for, here to another manager on the same store.
      expect(await second.manager.processWebhookDurable('telnyx', spoken, store)).toEqual({ accepted: true, applied: 1 });
      expect(actions(second.fetchMock)).toEqual(['hangup']);
      expect(second.manager.getCall(call.callId)?.state).toBe('hangup-bot');
    } finally {
      consoleError.mockRestore();
      first.manager.dispose();
      second.manager.dispose();
    }
  });

  it('sends one hangup when two deliveries of the call.speak.ended are handled at once', async () => {
    const { manager, fetchMock } = setUp();
    const store = new InMemoryTelephonyCallStore();
    const ended: string[] = [];
    manager.on((event) => { if (event.type === 'call:ended') ended.push(event.call.state); });
    try {
      const call = await manager.initiateCall({ toNumber: '+15550000002', mode: 'notify', message: MESSAGE });
      await manager.persistCall(call.callId, store);
      await manager.processWebhookDurable('telnyx', signedEvent('call.answered', 'evt-answered'), store);
      await vi.waitFor(() => expect(actions(fetchMock)).toEqual(['speak']));
      const spoken = signedEvent('call.speak.ended', 'evt-speak-ended', { client_state: commands(fetchMock)[0]?.body.client_state, status: 'completed' });

      // Telnyx retries the webhook while the first delivery is still handled: both commit the event before either hangup commits.
      const deliveries = await Promise.all([manager.processWebhookDurable('telnyx', spoken, store), manager.processWebhookDurable('telnyx', spoken, store)]);
      expect(deliveries.map(({ accepted }) => accepted)).toEqual([true, true]);
      await settle();
      expect(actions(fetchMock)).toEqual(['speak', 'hangup']);
      expect(ended).toEqual(['hangup-bot']);
      expect(manager.getCall(call.callId)?.state).toBe('hangup-bot');
    } finally {
      manager.dispose();
    }
  });

  it('refuses the call.speak.ended webhook when the manager is disposed before the hangup, and a redelivery hangs up', async () => {
    const store = new InMemoryTelephonyCallStore();
    // Holds a committed transaction's result back, while the manager is disposed.
    let hold: Promise<void> | undefined;
    const held: ITelephonyCallStore = {
      withProvider: async (provider, work) => {
        const result = await store.withProvider(provider, work);
        if (hold) await hold;
        return result;
      },
    };
    const first = setUp();
    const second = setUp();
    try {
      const call = await first.manager.initiateCall({ toNumber: '+15550000002', mode: 'notify', message: MESSAGE });
      await first.manager.persistCall(call.callId, held);
      await first.manager.processWebhookDurable('telnyx', signedEvent('call.answered', 'evt-answered'), held);
      await vi.waitFor(() => expect(actions(first.fetchMock)).toEqual(['speak']));
      const spoken = signedEvent('call.speak.ended', 'evt-speak-ended', { client_state: commands(first.fetchMock)[0]?.body.client_state, status: 'completed' });

      let release: () => void = () => undefined;
      hold = new Promise<void>((resolve) => { release = resolve; });
      const delivery = first.manager.processWebhookDurable('telnyx', spoken, held);
      await settle();
      first.manager.dispose();
      release();
      await expect(delivery).rejects.toThrow('disposed');
      expect(actions(first.fetchMock)).toEqual(['speak']);

      expect(await second.manager.processWebhookDurable('telnyx', spoken, store)).toEqual({ accepted: true, applied: 1 });
      expect(actions(second.fetchMock)).toEqual(['hangup']);
      expect(second.manager.getCall(call.callId)?.state).toBe('hangup-bot');
    } finally {
      first.manager.dispose();
      second.manager.dispose();
    }
  });

  it.each(['carrier', 'legacy'] as const)('hangs up once through processWebhook with eventHandling %s, and ends the call once', async (eventHandling) => {
    const { manager, fetchMock } = setUp({ eventHandling });
    const ended: string[] = [];
    manager.on((event) => { if (event.type === 'call:ended') ended.push(event.call.state); });
    try {
      const call = await manager.initiateCall({ toNumber: '+15550000002', mode: 'notify', message: MESSAGE });
      manager.processWebhook('telnyx', signedEvent('call.answered', 'evt-answered'));
      await vi.waitFor(() => expect(actions(fetchMock)).toEqual(['speak']));
      const spoken = signedEvent('call.speak.ended', 'evt-speak-ended', { client_state: commands(fetchMock)[0]?.body.client_state, status: 'completed' });
      manager.processWebhook('telnyx', spoken);
      manager.processWebhook('telnyx', spoken);
      await vi.waitFor(() => expect(actions(fetchMock)).toEqual(['speak', 'hangup']));
      await vi.waitFor(() => expect(manager.getCall(call.callId)?.state).toBe('hangup-bot'));
      await vi.waitFor(() => expect(ended).toEqual(['hangup-bot']));

      // The call.hangup Telnyx posts for the hangup ends nothing again.
      manager.processWebhook('telnyx', signedEvent('call.hangup', 'evt-hangup', { hangup_cause: 'normal_clearing' }));
      await settle();
      expect(actions(fetchMock)).toEqual(['speak', 'hangup']);
      expect(ended).toEqual(['hangup-bot']);
      expect(manager.getCall(call.callId)?.state).toBe('hangup-bot');
    } finally {
      manager.dispose();
    }
  });

  it('ends the call once, hangup-bot, when the call.hangup the hangup causes arrives before Telnyx answers the hangup command', async () => {
    const { manager, fetchMock } = setUp({ eventHandling: 'carrier' });
    let answerHangup: () => void = () => undefined;
    const hangupAnswered = new Promise<void>((resolve) => { answerHangup = resolve; });
    const respond = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/actions/hangup')) await hangupAnswered;
      return respond!(input, init);
    });
    const ended: string[] = [];
    manager.on((event) => { if (event.type === 'call:ended') ended.push(event.call.state); });
    try {
      const call = await manager.initiateCall({ toNumber: '+15550000002', mode: 'notify', message: MESSAGE });
      manager.processWebhook('telnyx', signedEvent('call.answered', 'evt-answered'));
      await vi.waitFor(() => expect(actions(fetchMock)).toEqual(['speak']));
      manager.processWebhook('telnyx', signedEvent('call.speak.ended', 'evt-speak-ended', { client_state: commands(fetchMock)[0]?.body.client_state, status: 'completed' }));
      await vi.waitFor(() => expect(actions(fetchMock)).toEqual(['speak', 'hangup']));

      // Telnyx posts the call.hangup the command causes while the command's own response is still on its way.
      manager.processWebhook('telnyx', signedEvent('call.hangup', 'evt-hangup', { hangup_cause: 'normal_clearing' }));
      answerHangup();
      await vi.waitFor(() => expect(ended).not.toEqual([]));
      await settle();
      await settle();
      expect(ended).toEqual(['hangup-bot']);
      expect(manager.getCall(call.callId)?.state).toBe('hangup-bot');
    } finally {
      answerHangup();
      manager.dispose();
    }
  });

  it('writes a hangup Telnyx refuses to the console, and the call stays ended hangup-bot', async () => {
    const { manager, fetchMock } = setUp({ eventHandling: 'carrier' });
    const respond = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (input, init) => (String(input).endsWith('/actions/hangup')
      ? new Response(JSON.stringify({ errors: [{ title: 'Command refused' }] }), { status: 422, headers: { 'Content-Type': 'application/json' } })
      : respond!(input, init)));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const call = await manager.initiateCall({ toNumber: '+15550000002', mode: 'notify', message: MESSAGE });
      manager.processWebhook('telnyx', signedEvent('call.answered', 'evt-answered'));
      await vi.waitFor(() => expect(actions(fetchMock)).toEqual(['speak']));
      manager.processWebhook('telnyx', signedEvent('call.speak.ended', 'evt-speak-ended', { client_state: commands(fetchMock)[0]?.body.client_state, status: 'completed' }));
      await vi.waitFor(() => expect(consoleError).toHaveBeenCalledWith('[CallManager] Hangup failed:', expect.objectContaining({ message: 'Telnyx hangup failed: 422' })));
      expect(actions(fetchMock)).toEqual(['speak', 'hangup']);
      expect(manager.getCall(call.callId)?.state).toBe('hangup-bot');
    } finally {
      consoleError.mockRestore();
      manager.dispose();
    }
  });

  it.each(['call_hangup', 'cancelled_amd'])('hangs nothing up when the message ends with status %s', async (status) => {
    const { manager, fetchMock } = setUp();
    try {
      const call = await manager.initiateCall({ toNumber: '+15550000002', mode: 'notify', message: MESSAGE });
      manager.processWebhook('telnyx', signedEvent('call.answered', 'evt-answered'));
      await vi.waitFor(() => expect(actions(fetchMock)).toEqual(['speak']));
      manager.processWebhook('telnyx', signedEvent('call.speak.ended', 'evt-speak-ended', { client_state: commands(fetchMock)[0]?.body.client_state, status }));
      await settle();
      expect(actions(fetchMock)).toEqual(['speak']);
      expect(manager.getCall(call.callId)?.state).toBe('answered');
    } finally {
      manager.dispose();
    }
  });

  it('hangs nothing up for a speak the provider did not send, or with a legacy-profile provider', async () => {
    const clientState = await notifySpeakClientState();

    const carrier = setUp();
    const legacy = setUp({ protocol: 'legacy' });
    try {
      // The provider has spoken; the end of a speak with another client_state (the host's own) is not its message's.
      const carrierCall = await carrier.manager.initiateCall({ toNumber: '+15550000002', mode: 'notify', message: MESSAGE });
      carrier.manager.processWebhook('telnyx', signedEvent('call.answered', 'evt-answered'));
      await vi.waitFor(() => expect(actions(carrier.fetchMock)).toEqual(['speak']));
      carrier.manager.processWebhook('telnyx', signedEvent('call.speak.ended', 'evt-speak-ended', { client_state: Buffer.from('host-state').toString('base64'), status: 'completed' }));

      const legacyCall = await legacy.manager.initiateCall({ toNumber: '+15550000002', mode: 'notify', message: MESSAGE });
      legacy.manager.processWebhook('telnyx', signedEvent('call.answered', 'evt-answered'));
      legacy.manager.processWebhook('telnyx', signedEvent('call.speak.ended', 'evt-speak-ended', { client_state: clientState, status: 'completed' }));

      await settle();
      expect(actions(carrier.fetchMock)).toEqual(['speak']);
      expect(carrier.manager.getCall(carrierCall.callId)?.state).toBe('answered');
      expect(actions(legacy.fetchMock)).toEqual([]);
      expect(legacy.manager.getCall(legacyCall.callId)?.state).toBe('answered');
    } finally {
      carrier.manager.dispose();
      legacy.manager.dispose();
    }
  });
});

const CALLER = '+15550000003';
const OUR_NUMBER = '+15550000001';

/** The signed `call.initiated` webhook Telnyx posts for a call coming in to the application. */
const inboundInitiated = (): WebhookContext => signedEvent('call.initiated', 'evt-inbound-initiated', { direction: 'incoming', from: CALLER, to: OUR_NUMBER, state: 'parked' });

/** The stream settings a carrier-profile dial request carries, which the answer of an inbound call carries too. */
const STREAM_SETTINGS = { stream_url: 'wss://example.test/voice/media-stream', stream_track: 'inbound_track', stream_codec: 'PCMU', stream_bidirectional_mode: 'rtp', stream_bidirectional_codec: 'PCMU' };

describe('a carrier-profile Telnyx inbound call answered by AgentOS', () => {
  it('answers an admitted call once with the media stream settings, and its call.answered starts listening with no other command', async () => {
    const { manager, fetchMock } = setUp();
    const store = new InMemoryTelephonyCallStore();
    try {
      // The host's webhook route: admit the caller, persist the call, apply the webhook, answer.
      const initiated = inboundInitiated();
      const call = manager.handleInboundCall({ providerCallId: CALL_CONTROL_ID, provider: 'telnyx', fromNumber: CALLER, toNumber: OUR_NUMBER });
      expect(call).not.toBeNull();
      const callId = call!.callId;
      await manager.persistCall(callId, store);
      expect((await manager.processWebhookDurable('telnyx', initiated, store)).accepted).toBe(true);
      await manager.answerInboundCall(callId);

      expect(commands(fetchMock)).toEqual([{ action: 'answer', body: { command_id: `${callId}:answer`, ...STREAM_SETTINGS } }]);
      expect(fetchMock.mock.calls.find(([input]) => String(input).endsWith('/actions/answer'))?.[0]).toBe('https://api.telnyx.com/v2/calls/v3:call-control-answered/actions/answer');

      expect(await manager.processWebhookDurable('telnyx', signedEvent('call.answered', 'evt-inbound-answered'), store)).toEqual({ accepted: true, applied: 1 });
      await settle();
      expect(manager.getCall(callId)?.state).toBe('listening');

      // An answered call is not answered again, and the stream needs no streaming_start.
      await manager.answerInboundCall(callId);
      await settle();
      expect(actions(fetchMock)).toEqual(['answer']);
    } finally {
      manager.dispose();
    }
  });

  it.each(['carrier', 'legacy'] as const)('answers an admitted call through processWebhook with eventHandling %s', async (eventHandling) => {
    const { manager, fetchMock } = setUp({ eventHandling });
    try {
      const call = manager.handleInboundCall({ providerCallId: CALL_CONTROL_ID, provider: 'telnyx', fromNumber: CALLER, toNumber: OUR_NUMBER });
      manager.processWebhook('telnyx', inboundInitiated());
      await manager.answerInboundCall(call!.callId);
      manager.processWebhook('telnyx', signedEvent('call.answered', 'evt-inbound-answered'));
      await settle();
      expect(commands(fetchMock)).toEqual([{ action: 'answer', body: { command_id: `${call!.callId}:answer`, ...STREAM_SETTINGS } }]);
      expect(manager.getCall(call!.callId)?.state).toBe('listening');
    } finally {
      manager.dispose();
    }
  });

  it('answers without stream settings when streaming is off', async () => {
    const { manager, fetchMock } = setUp({ streaming: false });
    try {
      const call = manager.handleInboundCall({ providerCallId: CALL_CONTROL_ID, provider: 'telnyx', fromNumber: CALLER, toNumber: OUR_NUMBER });
      await manager.answerInboundCall(call!.callId);
      expect(commands(fetchMock)).toEqual([{ action: 'answer', body: { command_id: `${call!.callId}:answer` } }]);
    } finally {
      manager.dispose();
    }
  });

  it('rejects when Telnyx refuses the answer, and for a call that is not an admitted inbound call', async () => {
    const { manager } = setUp({ commandStatus: 422 });
    try {
      const call = manager.handleInboundCall({ providerCallId: CALL_CONTROL_ID, provider: 'telnyx', fromNumber: CALLER, toNumber: OUR_NUMBER });
      await expect(manager.answerInboundCall(call!.callId)).rejects.toThrow('Telnyx answer failed: 422');
      await expect(manager.answerInboundCall('no-such-call')).rejects.toThrow('no inbound call');
      const outbound = await manager.initiateCall({ toNumber: '+15550000002', mode: 'conversation' });
      await expect(manager.answerInboundCall(outbound.callId)).rejects.toThrow('no inbound call');
    } finally {
      manager.dispose();
    }
  });

  it('sends nothing with a legacy-profile provider, whose host answers the call', async () => {
    const { manager, fetchMock } = setUp({ protocol: 'legacy' });
    try {
      const call = manager.handleInboundCall({ providerCallId: CALL_CONTROL_ID, provider: 'telnyx', fromNumber: CALLER, toNumber: OUR_NUMBER });
      await manager.answerInboundCall(call!.callId);
      expect(commands(fetchMock)).toEqual([]);
    } finally {
      manager.dispose();
    }
  });
});
