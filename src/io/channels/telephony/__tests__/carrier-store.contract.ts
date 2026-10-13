import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CallManager } from '../CallManager.js';
import { TwilioVoiceProvider } from '../providers/twilio.js';
import type { CallRecord, ITelephonyCallStore, WebhookContext } from '../types.js';
/** Neutral durable outbound record. */
export const storedCall = (id = 'local', provider = 'twilio'): CallRecord => ({ callId: id, provider, providerCallId: 'remote', direction: 'outbound', mode: 'conversation', fromNumber: '+15550000001', toNumber: '+15550000002', state: 'initiated', transcript: [], processedEventIds: [], createdAt: 1 });
/** Both instances must share transactional state. */
export interface CarrierStoreFixture { first: ITelephonyCallStore; second: ITelephonyCallStore; close(): Promise<void> }
/** Actual signature verification remains in the path before the state transaction. */
export function signedStatus(status: string): WebhookContext {
  const url = 'https://example.test/status'; const body = new URLSearchParams({ CallSid: 'remote', CallStatus: status }).toString();
  const params = new URLSearchParams(body); let signed = url; for (const key of [...params.keys()].sort()) signed += key + params.get(key);
  return { method: 'POST', url, body, headers: { 'x-twilio-signature': createHmac('sha1', 'fixture').update(signed).digest('base64') } };
}
/** A carrier-profile manager whose Twilio provider sends its REST requests to `fetchImpl`, which by default answers at once without a network. */
function carrierManager(fetchImpl: typeof fetch = vi.fn<typeof fetch>(async () => new Response('{}'))): CallManager {
  const m = new CallManager({ provider: { provider: 'mock' }, eventHandling: 'carrier' });
  m.registerProvider(new TwilioVoiceProvider({ accountSid: 'account', authToken: 'fixture', protocol: 'carrier', fetchImpl }));
  return m;
}
/** Tests persistent identity, state monotonicity, rollback, aliases and isolation. */
export function carrierStoreContract(name: string, open: () => Promise<CarrierStoreFixture>): void {
  describe(name, () => {
    it('races duplicate callbacks across managers, then restarts and refuses terminal replay', async () => {
      const h = await open();
      const make = () => { const m = new CallManager({ provider: { provider: 'mock' }, eventHandling: 'carrier' }); m.registerProvider(new TwilioVoiceProvider({ accountSid: 'account', authToken: 'fixture', protocol: 'carrier' })); return m; };
      const a = make(); const b = make();
      try {
        await h.first.withProvider('twilio', (tx) => tx.put(storedCall()));
        const results = await Promise.all([a.processWebhookDurable('twilio', signedStatus('in-progress'), h.first), b.processWebhookDurable('twilio', signedStatus('in-progress'), h.second)]);
        expect(results.map((r) => r.applied).sort()).toEqual([0, 1]);
        expect(await h.second.withProvider('twilio', (tx) => tx.get('local'))).toMatchObject({ state: 'listening', processedEventIds: [expect.any(String)] });
        const third = make(); let ended = 0; third.on((e) => { if (e.type === 'call:ended') ended += 1; });
        try {
          await third.processWebhookDurable('twilio', signedStatus('completed'), h.second);
          await third.processWebhookDurable('twilio', signedStatus('completed'), h.second);
          await third.processWebhookDurable('twilio', signedStatus('ringing'), h.second);
          expect(ended).toBe(1); expect((await h.first.withProvider('twilio', (tx) => tx.get('local')))?.state).toBe('completed');
        } finally { third.dispose(); }
      } finally { a.dispose(); b.dispose(); await h.close(); }
    });
    it('does not consume invalid or unknown callbacks and rolls back rejected writes', async () => {
      const h = await open(); const m = new CallManager({ provider: { provider: 'mock' } }); m.registerProvider(new TwilioVoiceProvider({ accountSid: 'account', authToken: 'fixture', protocol: 'carrier' }));
      try {
        expect(await m.processWebhookDurable('twilio', { ...signedStatus('completed'), headers: {} }, h.first)).toEqual({ accepted: false, applied: 0 });
        await expect(m.processWebhookDurable('twilio', signedStatus('completed'), h.first)).rejects.toThrow('unknown carrier call');
        await expect(h.first.withProvider('twilio', async (tx) => { await tx.put(storedCall()); throw new Error('rollback'); })).rejects.toThrow('rollback');
        expect(await h.second.withProvider('twilio', (tx) => tx.get('local'))).toBeUndefined();
        await h.first.withProvider('twilio', (tx) => tx.put(storedCall()));
        expect(await m.processWebhookDurable('twilio', signedStatus('completed'), h.second)).toEqual({ accepted: true, applied: 1 });
      } finally { m.dispose(); await h.close(); }
    });
    it('keeps the bot speech a manager records between callbacks, and commits it to the store', async () => {
      const h = await open(); const m = carrierManager();
      try {
        await h.first.withProvider('twilio', (tx) => tx.put(storedCall()));
        await m.processWebhookDurable('twilio', signedStatus('in-progress'), h.first);
        m.speakText('local', 'one moment');
        expect(await m.processWebhookDurable('twilio', signedStatus('in-progress'), h.second)).toEqual({ accepted: true, applied: 0 });
        const spoken = { state: 'speaking', transcript: [{ speaker: 'bot', text: 'one moment', isFinal: true }] };
        expect(m.getCall('local')).toMatchObject(spoken);
        expect(await h.second.withProvider('twilio', (tx) => tx.get('local'))).toMatchObject(spoken);
      } finally { m.dispose(); await h.close(); }
    });
    it('ends a call its manager hangs up once, in the store, so a later completion callback changes nothing', async () => {
      const h = await open(); const m = carrierManager(); const ended: string[] = [];
      m.on((e) => { if (e.type === 'call:ended') ended.push(e.call.state); });
      try {
        await h.first.withProvider('twilio', (tx) => tx.put(storedCall()));
        await m.processWebhookDurable('twilio', signedStatus('in-progress'), h.first);
        await m.hangupCall('local');
        const completion = await m.processWebhookDurable('twilio', signedStatus('completed'), h.second);
        expect(ended).toEqual(['hangup-bot']);
        expect(m.getCall('local')?.state).toBe('hangup-bot');
        expect((await h.second.withProvider('twilio', (tx) => tx.get('local')))?.state).toBe('hangup-bot');
        expect(completion).toEqual({ accepted: true, applied: 0 });
      } finally { m.dispose(); await h.close(); }
    });
    it('ends a call as hung up by its manager when the completion callback arrives before the carrier answers the hangup request', async () => {
      let answer!: () => void; const answered = new Promise<Response>((resolve) => { answer = () => resolve(new Response('{}')); });
      const fetchImpl = vi.fn<typeof fetch>(() => answered);
      const h = await open(); const m = carrierManager(fetchImpl); const ended: string[] = [];
      m.on((e) => { if (e.type === 'call:ended') ended.push(e.call.state); });
      try {
        await h.first.withProvider('twilio', (tx) => tx.put(storedCall()));
        await m.processWebhookDurable('twilio', signedStatus('in-progress'), h.first);
        const hangup = m.hangupCall('local');
        await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
        const completion = await m.processWebhookDurable('twilio', signedStatus('completed'), h.second);
        answer(); await hangup;
        expect(ended).toEqual(['hangup-bot']);
        expect((await h.second.withProvider('twilio', (tx) => tx.get('local')))?.state).toBe('hangup-bot');
        expect(m.getCall('local')?.state).toBe('hangup-bot');
        expect(completion).toEqual({ accepted: true, applied: 0 });
      } finally { answer(); m.dispose(); await h.close(); }
    });
    it('rejects alias rebinding and keeps providers separate', async () => {
      const h = await open();
      try {
        await h.first.withProvider('twilio', (tx) => tx.put(storedCall()));
        await expect(h.second.withProvider('twilio', (tx) => tx.put(storedCall('other')))).rejects.toThrow('carrier alias conflict');
        await h.second.withProvider('plivo', (tx) => tx.put(storedCall('other', 'plivo')));
        expect((await h.first.withProvider('twilio', (tx) => tx.find('remote')))?.callId).toBe('local');
        expect((await h.first.withProvider('plivo', (tx) => tx.find('remote')))?.callId).toBe('other');
      } finally { await h.close(); }
    });
  });
}
