import { expect, it } from 'vitest';
import { CallManager } from '../CallManager.js';
import { PlivoVoiceProvider, computePlivoV3Signature } from '../providers/plivo.js';
import { InMemoryTelephonyCallStore } from '../TelephonyCallStore.js';
import { carrierStoreContract, storedCall } from './carrier-store.contract.js';
carrierStoreContract('memory carrier transactions', async () => {
  const store = new InMemoryTelephonyCallStore(); return { first: store, second: store, close: async () => undefined };
});
it('retains one Plivo binding across a new manager and rejects another call leg for the request', async () => {
  const store = new InMemoryTelephonyCallStore();
  await store.withProvider('plivo', (tx) => tx.put({ ...storedCall('local', 'plivo'), providerCallId: 'request:r', providerRequestId: 'r' }));
  const make = () => { const m = new CallManager({ provider: { provider: 'mock' } }); m.registerProvider(new PlivoVoiceProvider({ authId: 'account', authToken: 'fixture', protocol: 'carrier' })); return m; };
  const send = async (manager: CallManager, call: string) => {
    const url = 'https://example.test/status'; const fields = { CallUUID: call, RequestUUID: 'r', CallStatus: 'in-progress' }; const nonce = 'fixture';
    return manager.processWebhookDurable('plivo', { method: 'POST', url, body: new URLSearchParams(fields).toString(), headers: { 'x-plivo-signature-v3-nonce': nonce, 'x-plivo-signature-v3': computePlivoV3Signature('POST', url, nonce, 'fixture', fields) } }, store);
  };
  const a = make(); const b = make();
  try { expect(await send(a, 'leg')).toMatchObject({ applied: 1 }); expect(await send(b, 'leg')).toMatchObject({ applied: 0 }); await expect(send(b, 'foreign')).rejects.toThrow('carrier call identity conflict'); expect((await store.withProvider('plivo', (tx) => tx.find('request:r')))?.providerCallId).toBe('leg'); }
  finally { a.dispose(); b.dispose(); }
});
