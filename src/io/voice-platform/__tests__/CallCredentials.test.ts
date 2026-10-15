import { describe, expect, it } from 'vitest';
import { CallCredentials, exchangeRequestHash, controlRequestHash } from '../CallCredentials.js';
import { VoiceCallManager } from '../VoiceCallManager.js';
import { InMemoryVoiceStore } from '../stores/memory.js';
import { storedCall } from './callFixtures.js';
import { managerHooks } from './managerFixtures.js';
import { browserIdentity } from './credentialFixtures.js';

async function fixture() {
  const store = new InMemoryVoiceStore(); const identity = browserIdentity(); const effects = managerHooks(); let now = 1000; let allowed = true;
  const state = storedCall(); state.proofKeyThumbprint = identity.thumbprint; state.call.state = 'connecting'; state.call.workerGeneration = 1; state.call.inferenceGeneration = 1; state.preparationStep = 3;
  await store.withTransaction('scope-a', (tx) => tx.put('calls', 'call-a', state, 0));
  const service = new CallCredentials({ store, now: () => now, ttlMs: 120000, proofWindowMs: 30000,
    key: { id: 'test', key: new Uint8Array(32).fill(1) }, authorize: async () => { if (!allowed) throw new Error('authorization revoked'); },
    issueMedia: (binding, token) => ({ url: `wss://media.example.test/calls/${binding.callId}`, token }),
  });
  const manager = new VoiceCallManager({ store, hooks: effects.hooks, now: () => now, workerLeaseMs: 15000 });
  const grant = await service.issueGrant('scope-a', 'call-a', 'grant-request-a');
  const connect = (exchangeKey = 'exchange-a', origin = state.clientOrigin, requestHash = exchangeRequestHash('call-a', grant.grantId, exchangeKey, origin)) => ({
    exchangeKey, requestHash, proof: identity.proof({ operation: 'connect', callId: 'call-a', credentialId: grant.grantId, origin, operationKey: exchangeKey, requestHash, issuedAt: now, nonce: `proof-${exchangeKey}` }),
  });
  return { store, service, manager, grant, connect, identity, origin: state.clientOrigin, time: (at: number) => { now = at; }, revokePolicy: () => { allowed = false; }, effects };
}
describe('call credentials', () => {
  it('recovers the exact committed exchange across concurrent and lost responses without new dispatch', async () => {
    const f = await fixture();
    const results = await Promise.all(Array.from({ length: 10 }, () => f.service.exchange('scope-a', 'call-a', f.grant.token, f.origin, f.connect())));
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(results[0]!.transportEpoch).toBe(1); expect(f.effects.effects).toEqual([]);
    await f.service.consumeMedia('scope-a', 'call-a', results[0]!.token, f.origin, 1);
    expect(await f.service.exchange('scope-a', 'call-a', f.grant.token, f.origin, f.connect())).toEqual(results[0]);
    await expect(f.service.consumeMedia('scope-a', 'call-a', results[0]!.token, f.origin, 1)).rejects.toThrow('credential refused');
    await expect(f.service.exchange('scope-a', 'call-a', f.grant.token, f.origin, f.connect('exchange-b'))).rejects.toThrow('exchange conflict');
  });
  it('refuses a forged hash, foreign call/scope/origin, wrong key and expired recovery', async () => {
    const f = await fixture();
    await expect(f.service.exchange('scope-b', 'call-a', f.grant.token, f.origin, f.connect())).rejects.toThrow();
    await expect(f.service.exchange('scope-a', 'call-b', f.grant.token, f.origin, f.connect())).rejects.toThrow();
    await expect(f.service.exchange('scope-a', 'call-a', f.grant.token, 'https://foreign.example.test', f.connect())).rejects.toThrow();
    await expect(f.service.exchange('scope-a', 'call-a', f.grant.token, f.origin, f.connect('exchange-a', f.origin, '0'.repeat(64)))).rejects.toThrow('request hash mismatch');
    const bad = f.connect(); bad.proof.publicKey = browserIdentity().proof({ operation: 'connect', callId: 'call-a', credentialId: f.grant.grantId, origin: f.origin, operationKey: 'exchange-a', requestHash: bad.requestHash, issuedAt: 1000, nonce: 'other' }).publicKey;
    await expect(f.service.exchange('scope-a', 'call-a', f.grant.token, f.origin, bad)).rejects.toThrow('proof refused');
    await f.service.exchange('scope-a', 'call-a', f.grant.token, f.origin, f.connect()); f.time(121000);
    await expect(f.service.exchange('scope-a', 'call-a', f.grant.token, f.origin, f.connect())).rejects.toThrow();
  });
  it('stops without media or a server key and recovers one receipt, then refuses renewal and revoked retries', async () => {
    const f = await fixture(); const connection = await f.service.exchange('scope-a', 'call-a', f.grant.token, f.origin, f.connect());
    await f.service.consumeMedia('scope-a', 'call-a', connection.token, f.origin, 1);
    await f.manager.connected('scope-a', 'call-a', 1, 1); await f.manager.detached('scope-a', 'call-a', 1, 1);
    const credentialId = connection.controlCredential.token.split('.')[0]!;
    const key = 'stop-a'; const requestHash = controlRequestHash('stop', 'call-a', credentialId, key, f.origin);
    const input = { idempotencyKey: key, proof: f.identity.proof({ operation: 'stop', callId: 'call-a', credentialId, origin: f.origin, operationKey: key, requestHash, issuedAt: 1000, nonce: 'stop-proof' }) };
    const receipt = await f.service.stop('scope-a', 'call-a', connection.controlCredential.token, f.origin, input);
    expect(receipt).toEqual({ callId: 'call-a', stopId: 'stop-a', state: 'ending' });
    for (let i = 0; i < 10; i++) await f.manager.advance('scope-a', 'call-a');
    expect(await f.service.stop('scope-a', 'call-a', connection.controlCredential.token, f.origin, input)).toEqual(receipt);
    await expect(f.service.renewControl('scope-a', 'call-a', connection.controlCredential.token, f.origin, { idempotencyKey: key, proof: input.proof })).rejects.toThrow();
    await f.service.revokeCall('scope-a', 'call-a');
    await expect(f.service.stop('scope-a', 'call-a', connection.controlCredential.token, f.origin, input)).rejects.toThrow();
  });
  it('answers a first stop after the server ended the call with a receipt of the state reached', async () => {
    const f = await fixture(); const connection = await f.service.exchange('scope-a', 'call-a', f.grant.token, f.origin, f.connect());
    await f.service.consumeMedia('scope-a', 'call-a', connection.token, f.origin, 1);
    await f.manager.connected('scope-a', 'call-a', 1, 1);
    f.time(16000); await f.manager.tick('scope-a', 'call-a');
    expect((await f.manager.get('scope-a', 'call-a'))!).toMatchObject({ state: 'ending', endReason: 'worker_lost' });
    const credentialId = connection.controlCredential.token.split('.')[0]!;
    const stop = (key: string) => {
      const requestHash = controlRequestHash('stop', 'call-a', credentialId, key, f.origin);
      return { idempotencyKey: key, proof: f.identity.proof({ operation: 'stop', callId: 'call-a', credentialId, origin: f.origin, operationKey: key, requestHash, issuedAt: 16000, nonce: `${key}-proof` }) };
    };
    const receipt = await f.service.stop('scope-a', 'call-a', connection.controlCredential.token, f.origin, stop('stop-a'));
    expect(receipt).toEqual({ callId: 'call-a', stopId: 'stop-a', state: 'ending' });
    for (let i = 0; i < 10; i++) await f.manager.advance('scope-a', 'call-a');
    expect(await f.service.stop('scope-a', 'call-a', connection.controlCredential.token, f.origin, stop('stop-a'))).toEqual(receipt);
    expect(await f.service.stop('scope-a', 'call-a', connection.controlCredential.token, f.origin, stop('stop-b'))).toEqual({ callId: 'call-a', stopId: 'stop-b', state: 'failed' });
    expect((await f.manager.get('scope-a', 'call-a'))!).toMatchObject({ state: 'failed', endReason: 'worker_lost' });
    await f.service.revokeCall('scope-a', 'call-a');
    await expect(f.service.stop('scope-a', 'call-a', connection.controlCredential.token, f.origin, stop('stop-c'))).rejects.toThrow('credential refused');
  });
  it('renews control once, recovers that response and grants no media authority to control', async () => {
    const f = await fixture(); const c = await f.service.exchange('scope-a', 'call-a', f.grant.token, f.origin, f.connect());
    const credentialId = c.controlCredential.token.split('.')[0]!; const key = 'renew-a';
    const requestHash = controlRequestHash('renew_control', 'call-a', credentialId, key, f.origin);
    const input = { idempotencyKey: key, proof: f.identity.proof({ operation: 'renew_control', callId: 'call-a', credentialId, origin: f.origin, operationKey: key, requestHash, issuedAt: 1000, nonce: 'renew-proof' }) };
    const renewed = await f.service.renewControl('scope-a', 'call-a', c.controlCredential.token, f.origin, input);
    expect(renewed.token).not.toBe(c.controlCredential.token);
    expect(await f.service.renewControl('scope-a', 'call-a', c.controlCredential.token, f.origin, input)).toEqual(renewed);
    await expect(f.service.consumeMedia('scope-a', 'call-a', renewed.token, f.origin, 1)).rejects.toThrow();
    f.revokePolicy();
    await expect(f.service.renewControl('scope-a', 'call-a', c.controlCredential.token, f.origin, input)).rejects.toThrow('authorization revoked');
  });
  it('persists only hashes and sealed results and a replacement grant allocates a newer epoch', async () => {
    const f = await fixture(); const first = await f.service.exchange('scope-a', 'call-a', f.grant.token, f.origin, f.connect());
    const replacement = await f.service.issueGrant('scope-a', 'call-a', 'replacement-a');
    const key = 'exchange-next'; const requestHash = exchangeRequestHash('call-a', replacement.grantId, key, f.origin);
    const second = await f.service.exchange('scope-a', 'call-a', replacement.token, f.origin, { exchangeKey: key, requestHash, proof: f.identity.proof({ operation: 'connect', callId: 'call-a', credentialId: replacement.grantId, origin: f.origin, operationKey: key, requestHash, issuedAt: 1000, nonce: 'next-proof' }) });
    expect(second.transportEpoch).toBe(2);
    await expect(f.service.consumeMedia('scope-a', 'call-a', first.token, f.origin, 1)).rejects.toThrow();
    const persisted = await f.store.withTransaction('scope-a', async (tx) => JSON.stringify([await tx.list('credentials'), await tx.list('idempotency')]));
    for (const token of [f.grant.token, replacement.token, first.token, first.controlCredential.token, second.token]) expect(persisted).not.toContain(token);
    expect(JSON.stringify(f.service)).toBe('"[CallCredentials]"');
  });
});
