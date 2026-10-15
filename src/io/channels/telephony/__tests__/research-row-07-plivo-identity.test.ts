import { describe, expect, it, vi } from 'vitest';
import { PlivoVoiceProvider } from '../providers/plivo.js';
import { CallManager } from '../CallManager.js';
import { InMemoryTelephonyCallStore } from '../TelephonyCallStore.js';
import { computePlivoV3Signature } from '../providers/plivo.js';
import type { ITelephonyCallStore, WebhookContext } from '../types.js';
describe('Plivo request and call identity', () => {
  it('maps the signed request alias to the real call before speech or hangup', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{"request_uuid":"request-a"}', { status: 200 }));
    const provider = new PlivoVoiceProvider({ authId: 'account', authToken: 'fixture', fetchImpl: fetcher, protocol: 'carrier' });
    const manager = new CallManager({ provider: { provider: 'plivo', config: { authId: 'account', authToken: 'fixture', fromNumber: '+15550000001' } }, eventHandling: 'carrier', webhookBaseUrl: 'https://example.test' }); manager.registerProvider(provider);
    const call = await manager.initiateCall({ toNumber: '+15550000002' });
    expect(call).toMatchObject({ providerCallId: 'request:request-a', providerRequestId: 'request-a' });
    const request = JSON.parse(String(fetcher.mock.calls[0]![1]!.body)); expect(request.ring_url).toBe('https://example.test/voice/status/plivo'); expect(request.hangup_url).toBe(request.ring_url);
    await expect(provider.playTts({ providerCallId: call.providerCallId!, text: 'pending' })).rejects.toThrow('call identity pending');
    const store = new InMemoryTelephonyCallStore(); await manager.persistCall(call.callId, store);
    const fields = { CallUUID: 'call-a', RequestUUID: 'request-a', CallStatus: 'in-progress' };
    const url = 'https://example.test/voice/status/plivo'; const nonce = 'fixture-nonce';
    const ctx: WebhookContext = { method: 'POST', url, body: new URLSearchParams(fields).toString(), headers: { 'x-plivo-signature-v3-nonce': nonce, 'x-plivo-signature-v3': computePlivoV3Signature('POST', url, nonce, 'fixture', fields) } };
    expect(await manager.processWebhookDurable('plivo', ctx, store)).toMatchObject({ accepted: true, applied: 1 });
    expect(manager.getCall(call.callId)).toMatchObject({ providerCallId: 'call-a', providerRequestId: 'request-a', state: 'listening' });
    await manager.hangupCall(call.callId);
    expect(String(fetcher.mock.calls[fetcher.mock.calls.length - 1]![0])).toContain('/Call/call-a/');
    manager.dispose();
  });
  it('hangs up the bound call leg when a hangup queued behind the binding callback fails to commit', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{"request_uuid":"request-a"}', { status: 200 }));
    const provider = new PlivoVoiceProvider({ authId: 'account', authToken: 'fixture', fetchImpl: fetcher, protocol: 'carrier' });
    const manager = new CallManager({ provider: { provider: 'plivo', config: { authId: 'account', authToken: 'fixture', fromNumber: '+15550000001' } }, eventHandling: 'carrier', webhookBaseUrl: 'https://example.test' }); manager.registerProvider(provider);
    // The store holds the next transaction open once `hold` is set, and refuses every transaction once `refuse` is set.
    const inner = new InMemoryTelephonyCallStore(); let release!: () => void; const released = new Promise<void>((resolve) => { release = resolve; });
    const control = { hold: false, held: false, refuse: false };
    const store: ITelephonyCallStore = { withProvider: async (name, work) => {
      if (control.refuse) throw new Error('store unavailable');
      const hold = control.hold; control.hold = false;
      return inner.withProvider(name, async (tx) => { const result = await work(tx); if (hold) { control.held = true; await released; } return result; });
    } };
    try {
      const call = await manager.initiateCall({ toNumber: '+15550000002' }); await manager.persistCall(call.callId, store);
      const fields = { CallUUID: 'call-a', RequestUUID: 'request-a', CallStatus: 'in-progress' };
      const url = 'https://example.test/voice/status/plivo'; const nonce = 'fixture-nonce';
      const ctx: WebhookContext = { method: 'POST', url, body: new URLSearchParams(fields).toString(), headers: { 'x-plivo-signature-v3-nonce': nonce, 'x-plivo-signature-v3': computePlivoV3Signature('POST', url, nonce, 'fixture', fields) } };
      control.hold = true; const binding = manager.processWebhookDurable('plivo', ctx, store);
      await vi.waitFor(() => expect(control.held).toBe(true));
      // The hangup reads the manager's record while it still holds the pending request identity, then waits behind the binding.
      control.refuse = true; const hangup = manager.hangupCall(call.callId); release();
      await expect(hangup).rejects.toThrow('store unavailable');
      expect(await binding).toMatchObject({ accepted: true, applied: 1 });
      expect(String(fetcher.mock.calls[fetcher.mock.calls.length - 1]![0])).toContain('/Call/call-a/');
    } finally { release(); manager.dispose(); }
  });
  it('cancels a pending request through Request, never through Call', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const p = new PlivoVoiceProvider({ authId: 'account', authToken: 'fixture', fetchImpl: fetcher, protocol: 'carrier' });
    await p.hangupCall({ providerCallId: 'request:request-a' });
    expect(String(fetcher.mock.calls[0]![0])).toContain('/Request/request-a/');
  });
});
