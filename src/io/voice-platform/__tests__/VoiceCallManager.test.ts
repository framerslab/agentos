import { describe, expect, it } from 'vitest';
import { VoiceCallManager, CALL_END_MESSAGES, canonicalVoiceHash } from '../VoiceCallManager.js';
import { CallEndReasonSchema, CreateWebCallSchema } from '../contracts/index.js';
import { InMemoryVoiceStore } from '../stores/memory.js';
import { storedCall } from './callFixtures.js';
import { managerHooks } from './managerFixtures.js';

function fixture() {
  const store = new InMemoryVoiceStore(); const external = managerHooks(); let now = 1000;
  const manager = new VoiceCallManager({ store, hooks: external.hooks, now: () => now, workerLeaseMs: 15000 });
  const seed = storedCall();
  const request = CreateWebCallSchema.parse({ agentId: 'agent-a', maxDurationSeconds: 600, clientOrigin: seed.clientOrigin, proofKeyThumbprint: seed.proofKeyThumbprint, idempotencyKey: 'create-a' });
  return { store, external, manager, seed, request, time: (at: number) => { now = at; } };
}
async function prepared(f: ReturnType<typeof fixture>) {
  const call = await f.manager.create({ scopeId: 'scope-a', request: f.request, seed: f.seed });
  await f.manager.advance('scope-a', call.callId); await f.manager.advance('scope-a', call.callId); await f.manager.advance('scope-a', call.callId);
  return call.callId;
}
async function drain(f: ReturnType<typeof fixture>, id: string) { for (let i = 0; i < 10; i++) await f.manager.advance('scope-a', id); }

describe('durable voice calls', () => {
  it.each(['retained', 'delivery', 'none'] as const)('persists the %s drain before one stable terminal event across restart', async (mode) => {
    const f = fixture(); f.seed.call.contentRetention = { state: mode === 'delivery' ? 'delivery_pending' : mode, expiresAt: mode === 'none' ? null : 60000 }; const id = await prepared(f);
    const transcript = mode === 'retained' ? { availability: 'retained' as const, transcriptRef: 'transcript-a', expiresAt: 60000 } : { availability: 'unavailable' as const, reason: 'not_retained' as const };
    f.external.hooks.drainTranscripts = async () => ({ transcript, ...(mode === 'delivery' ? { deliveryRef: 'sealed-a' } : {}) });
    await f.manager.requestEnd('scope-a', id, 'client_stop');
    for (let step = 0; step < 5; step++) await f.manager.advance('scope-a', id);
    expect((await f.store.withTransaction('scope-a', async (tx) => (await tx.get('calls', id))?.value))?.transcriptDrain).toEqual({ transcript, ...(mode === 'delivery' ? { deliveryRef: 'sealed-a' } : {}) });
    const restarted = new VoiceCallManager({ store: f.store, hooks: f.external.hooks, now: () => 2000, workerLeaseMs: 15000 });
    for (let step = 0; step < 6; step++) await restarted.advance('scope-a', id);
    const terminal = (await restarted.events('scope-a', id)).filter((event) => event.type !== 'call.started');
    expect(terminal).toHaveLength(1); expect(terminal[0]?.payload).toMatchObject({ transcript });
    const segment = { turnId: 'turn-a', role: 'user', text: 'protected words', startedAt: 1000, endedAt: 1100, interrupted: false };
    const delivered: unknown[] = []; let opened = 0;
    for (let retry = 0; retry < 2; retry++) await restarted.withTerminalDelivery('scope-a', id, async (ref, consume) => { expect(ref).toBe('sealed-a'); opened++; await consume([segment]); }, async (event) => { delivered.push(event); });
    expect(delivered[0]).toEqual(delivered[1]); expect(delivered[0]).toMatchObject({ eventId: terminal[0]?.eventId, payload: { transcript: mode === 'delivery' ? { availability: 'delivery', segments: [segment] } : transcript } });
    expect(opened).toBe(mode === 'delivery' ? 2 : 0);
    expect(JSON.stringify(await restarted.events('scope-a', id))).not.toContain('protected words');
  });
  it('rejects a protected delivery when purge wins before the decrypt callback', async () => {
    const f = fixture(); f.seed.call.contentRetention = { state: 'delivery_pending', expiresAt: 60000 }; const id = await prepared(f); f.external.hooks.drainTranscripts = async () => ({ transcript: { availability: 'unavailable', reason: 'not_retained' }, deliveryRef: 'sealed-a' });
    await f.manager.requestEnd('scope-a', id, 'client_stop'); await drain(f, id); let delivered = false;
    await expect(f.manager.withTerminalDelivery('scope-a', id, async (_ref, consume) => {
      await f.store.withTransaction('scope-a', async (tx) => { const row = await tx.get('calls', id); if (!row) throw new Error('fixture missing'); row.value.contentFenced = true; await tx.put('calls', id, row.value, row.version); });
      await consume([]);
    }, async () => { delivered = true; })).rejects.toThrow('terminal delivery fenced');
    expect(delivered).toBe(false);
  });
  it('prepares one call before effects, resumes the same creation and conflicts on changed input', async () => {
    const f = fixture();
    const calls = await Promise.all(Array.from({ length: 12 }, () => f.manager.create({ scopeId: 'scope-a', request: f.request, seed: f.seed })));
    expect(new Set(calls.map((c) => c.callId)).size).toBe(1); expect(f.external.effects).toEqual([]);
    await expect(f.manager.create({ scopeId: 'scope-a', request: { ...f.request, maxDurationSeconds: 500 }, seed: f.seed })).rejects.toThrow('idempotency conflict');
    const id = calls[0]!.callId;
    await expect(f.manager.connected('scope-a', id, 1, 1)).rejects.toThrow('not ready');
    for (let i = 0; i < 3; i++) await f.manager.advance('scope-a', id);
    expect(f.external.effects).toEqual(['reserve', 'prepare', 'dispatch']);
    expect((await f.manager.get('scope-a', id))!.state).toBe('connecting');
    expect(await f.manager.get('scope-b', id)).toBeUndefined();
  });
  it('emits one started and one terminal event and preserves reconnect usage and limits', async () => {
    const f = fixture(); const id = await prepared(f);
    f.time(2000); await f.manager.connected('scope-a', id, 1, 1); await f.manager.connected('scope-a', id, 1, 1);
    f.time(2600); await f.manager.detached('scope-a', id, 1, 1);
    f.time(10000); await f.manager.connected('scope-a', id, 1, 2);
    f.time(10500); await f.manager.requestEnd('scope-a', id, 'client_stop');
    await drain(f, id); await f.manager.requestEnd('scope-a', id, 'provider_failure'); await drain(f, id);
    const call = (await f.manager.get('scope-a', id))!;
    expect(call).toMatchObject({ state: 'ended', endReason: 'client_stop', usage: { connectedMs: 1100, billableSeconds: 2 }, agentRevision: 1 });
    expect((await f.manager.events('scope-a', id)).map((e) => e.type)).toEqual(['call.started', 'call.ended']);
    expect(f.external.effects).toEqual(['reserve', 'prepare', 'dispatch', 'abort', 'tts', 'playback', 'transcripts', 'media', 'fence', 'slots', 'settle']);
  });
  it('recovers a lost effect response only after the controller action is fenced', async () => {
    const f = fixture(); f.external.fail('prepare'); const id = (await f.manager.create({ scopeId: 'scope-a', request: f.request, seed: f.seed })).callId;
    await f.manager.advance('scope-a', id);
    await expect(f.manager.advance('scope-a', id)).rejects.toThrow('injected failure');
    f.external.setFenced(false); f.time(40000);
    expect(await f.manager.recoverAction('scope-a', id)).toBe(false);
    expect(f.external.effects).toEqual(['reserve', 'prepare']);
    f.external.setFenced(true);
    expect(await f.manager.recoverAction('scope-a', id)).toBe(true);
    await f.manager.requestEnd('scope-a', id, 'setup_timeout'); await drain(f, id);
    expect((await f.manager.get('scope-a', id))!).toMatchObject({ state: 'failed', usage: { connectedMs: 0, billableSeconds: 0 } });
    expect(f.external.effects.filter((x) => x === 'reserve')).toHaveLength(1);
    expect(f.external.effects).not.toContain('dispatch');
  });
  it('keeps ending and its hold until all fences are confirmed; purge never drains transcripts', async () => {
    const f = fixture(); const id = await prepared(f);
    f.time(2000); await f.manager.connected('scope-a', id, 1, 1);
    await f.manager.requestEnd('scope-a', id, 'purged'); f.external.setFenced(false);
    for (let i = 0; i < 6; i++) await f.manager.advance('scope-a', id); await f.manager.requestEnd('scope-a', id, 'purged');
    await expect(f.manager.advance('scope-a', id)).rejects.toThrow('fence incomplete');
    expect((await f.manager.get('scope-a', id))!.state).toBe('ending');
    expect(f.external.effects).not.toContain('slots'); expect(f.external.effects).not.toContain('settle'); expect(f.external.effects).not.toContain('transcripts');
    f.external.setFenced(true); f.time(40000); await f.manager.recoverAction('scope-a', id); await drain(f, id);
    expect((await f.manager.get('scope-a', id))!.contentRetention.state).toBe('purged');
    expect((await f.manager.events('scope-a', id)).filter((e) => e.type !== 'call.started')).toHaveLength(1);
  });
  it('worker loss clips unknown tail, cannot renew after expiry and does not reset silence on greeting', async () => {
    const f = fixture(); const id = await prepared(f);
    f.time(2000); await f.manager.connected('scope-a', id, 1, 1);
    f.time(2500); await f.manager.report('scope-a', id, { sequence: 1, workerGeneration: 1, transportEpoch: 1, supplierComponents: [] });
    f.time(18000);
    await expect(f.manager.report('scope-a', id, { sequence: 2, workerGeneration: 1, transportEpoch: 1, supplierComponents: [] })).rejects.toThrow('lease expired');
    await f.manager.tick('scope-a', id); await drain(f, id);
    expect((await f.manager.get('scope-a', id))!).toMatchObject({ endReason: 'worker_lost', usage: { connectedMs: 500, billableSeconds: 1 } });
  });
  it('has a safe stable message for every terminal reason and bounds silence, duration, turns and reconnect', async () => {
    expect(Object.keys(CALL_END_MESSAGES).sort()).toEqual([...CallEndReasonSchema.options].sort());
    for (const limit of ['silence', 'duration', 'turns', 'reconnect'] as const) {
      const f = fixture(); f.seed.limits.silenceTimeoutMs = 500; f.seed.limits.maxDurationSeconds = 1; f.seed.limits.maxTurns = 1; f.seed.limits.reconnectGraceMs = 100;
      if (limit !== 'silence') f.seed.limits.silenceTimeoutMs = 10000;
      const id = await prepared(f); f.time(2000); await f.manager.connected('scope-a', id, 1, 1);
      if (limit === 'turns') await f.manager.completedTurn('scope-a', id, 1, 1, 1, 1);
      if (limit === 'reconnect') await f.manager.detached('scope-a', id, 1, 1);
      f.time(limit === 'duration' ? 3000 : limit === 'silence' ? 2500 : 2100);
      await f.manager.tick('scope-a', id);
      expect((await f.manager.get('scope-a', id))!.endReason).toBe({ silence: 'silence_limit', duration: 'duration_limit', turns: 'turn_limit', reconnect: 'participant_disconnected' }[limit]);
    }
  });
  it('commits the turn limit with the turn that reaches it', async () => {
    const f = fixture(); f.seed.limits.maxTurns = 2; const id = await prepared(f);
    f.time(2000); await f.manager.connected('scope-a', id, 1, 1);
    await f.manager.completedTurn('scope-a', id, 1, 1, 1, 1);
    expect((await f.manager.get('scope-a', id))!).toMatchObject({ state: 'connected', endReason: null });
    await f.manager.completedTurn('scope-a', id, 1, 1, 1, 2);
    expect((await f.manager.get('scope-a', id))!).toMatchObject({ state: 'ending', endReason: 'turn_limit' });
  });
  it('keeps a failed call failed, with its reason, when a purge reaches its cleanup', async () => {
    const f = fixture(); const id = await prepared(f);
    f.time(2000); await f.manager.connected('scope-a', id, 1, 1);
    f.time(18000); await f.manager.tick('scope-a', id); await f.manager.advance('scope-a', id);
    await f.manager.requestEnd('scope-a', id, 'purged'); await drain(f, id);
    expect((await f.manager.get('scope-a', id))!).toMatchObject({ state: 'failed', endReason: 'worker_lost', contentRetention: { state: 'purged' } });
    const terminal = (await f.manager.events('scope-a', id)).filter((e) => e.type !== 'call.started');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ type: 'call.failed', payload: { endReason: 'worker_lost', transcript: { availability: 'unavailable', reason: 'purged' } } });
    expect(f.external.effects).toContain('fence-content'); expect(f.external.effects).not.toContain('transcripts');
  });
  it('creates a call whose principal leaves its optional issuer undefined, as a stored row reads back', async () => {
    const f = fixture(); f.seed.call.initiatingPrincipal = { kind: 'member', principalId: 'member-a', issuerRef: undefined };
    const call = await f.manager.create({ scopeId: 'scope-a', request: f.request, seed: f.seed });
    f.seed.call.initiatingPrincipal = { kind: 'member', principalId: 'member-a' };
    expect((await f.manager.create({ scopeId: 'scope-a', request: f.request, seed: f.seed })).callId).toBe(call.callId);
    expect(canonicalVoiceHash([{ b: undefined, a: 1 }])).toBe(canonicalVoiceHash([{ a: 1 }]));
  });
});
