import { describe, expect, it, vi } from 'vitest';
import { TwilioVoiceProvider } from '../providers/twilio.js';
import { TelnyxVoiceProvider } from '../providers/telnyx.js';
import { PlivoVoiceProvider } from '../providers/plivo.js';
import type { IVoiceCallProvider } from '../IVoiceCallProvider.js';
import type { WebhookContext } from '../types.js';
const context = (body: string, url = 'https://example.test/callback'): WebhookContext => ({ method: 'POST', url, body, headers: {} });
describe('stable carrier events', () => {
  const providers: Array<{ name: string; provider: IVoiceCallProvider; status: string; digits: (occurrence: string) => string }> = [
    { name: 'twilio', provider: new TwilioVoiceProvider({ accountSid: 'a', authToken: 'fixture', protocol: 'carrier' }), status: 'CallSid=c&CallStatus=completed', digits: (n) => `CallSid=c&Digits=5&SequenceNumber=${n}` },
    { name: 'telnyx', provider: new TelnyxVoiceProvider({ apiKey: 'fixture', connectionId: 'a', protocol: 'carrier' }), status: JSON.stringify({ data: { id: 'delivery', event_type: 'call.hangup', payload: { call_control_id: 'c' } } }), digits: (n) => JSON.stringify({ data: { id: n, event_type: 'call.dtmf.received', payload: { call_control_id: 'c', digit: '5' } } }) },
    { name: 'plivo', provider: new PlivoVoiceProvider({ authId: 'a', authToken: 'fixture', protocol: 'carrier' }), status: 'CallUUID=c&RequestUUID=r&CallStatus=completed', digits: (n) => `CallUUID=c&RequestUUID=r&Digits=5&Timestamp=${n}` },
  ];
  for (const row of providers) {
    it(`${row.name} reproduces status ids and distinguishes repeated digit occurrences`, () => {
      const a = row.provider.parseWebhookEvent(context(row.status)).events;
      const b = row.provider.parseWebhookEvent(context(row.status)).events;
      expect(a).toHaveLength(1); expect(a[0]!.eventId).toBe(b[0]!.eventId);
      const first = row.provider.parseWebhookEvent(context(row.digits('1'))).events;
      const retry = row.provider.parseWebhookEvent(context(row.digits('1'))).events;
      const second = row.provider.parseWebhookEvent(context(row.digits('2'))).events;
      expect(first[0]!.eventId).toBe(retry[0]!.eventId); expect(first[0]!.eventId).not.toBe(second[0]!.eventId);
      expect(first[0]!.provider).toBe(row.name);
    });
  }
  it('refuses ambiguous DTMF and permits a signed callback occurrence key', () => {
    const p = providers[0]!.provider;
    expect(() => p.parseWebhookEvent(context('CallSid=c&Digits=5'))).toThrow('DTMF occurrence');
    const a = p.parseWebhookEvent(context('CallSid=c&Digits=5', 'https://example.test/callback?event_key=first'));
    const b = p.parseWebhookEvent(context('CallSid=c&Digits=5', 'https://example.test/callback?event_key=second'));
    expect(a.events[0]!.eventId).not.toBe(b.events[0]!.eventId);
  });
  it('does not use an unsigned GET body for Twilio identity or events', () => {
    const p = providers[0]!.provider;
    expect(p.parseWebhookEvent({ ...context('CallSid=forged&CallStatus=completed'), method: 'GET' }).events).toEqual([]);
  });
  it('retains explicitly selected legacy ids and refuses malformed Telnyx envelopes', () => {
    const p = new TwilioVoiceProvider({ accountSid: 'a', authToken: 'fixture', protocol: 'legacy' });
    expect(p.parseWebhookEvent(context('CallSid=c&CallStatus=completed')).events[0]!.eventId).not.toBe(p.parseWebhookEvent(context('CallSid=c&CallStatus=completed')).events[0]!.eventId);
    expect(providers[1]!.provider.parseWebhookEvent(context('null')).events).toEqual([]);
  });
});
it('requests Telnyx bidirectional PCMU only in carrier mode', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response('{"data":{"call_control_id":"call","call_session_id":"session"}}'));
  const input = { callId: 'local', fromNumber: '+15550000001', toNumber: '+15550000002', mode: 'conversation' as const, webhookUrl: 'https://example.test/callback', mediaStreamUrl: 'wss://example.test/media' };
  const carrier = new TelnyxVoiceProvider({ apiKey: 'fixture', connectionId: 'connection', fetchImpl: fetcher, protocol: 'carrier' });
  await carrier.initiateCall(input);
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toMatchObject({ stream_url: input.mediaStreamUrl, stream_bidirectional_mode: 'rtp', stream_bidirectional_codec: 'PCMU' });
  expect(carrier.verifyWebhook(context('{}')).valid).toBe(false);
  const legacy = new TelnyxVoiceProvider({ apiKey: 'fixture', connectionId: 'connection', fetchImpl: fetcher, protocol: 'legacy' });
  await legacy.initiateCall(input); expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).not.toHaveProperty('stream_url');
});
