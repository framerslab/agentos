import { describe, expect, it, vi } from 'vitest';
import { factoryFixture } from './factoryFixtures.js';
import { captureVoiceScope } from '../VoiceScopeContext.js';
import { InMemoryCompoundCreditStore } from '../../../safety/runtime/CompoundCreditStore.js';
describe('configured call lifetime', () => {
  it('reopens the configured provider with fallback disabled and drains its replacement', async () => {
    const f = await factoryFixture(); const { runtime } = await f.attach();
    const old = structuredClone(f.identity()); const transcript = vi.fn(); runtime.orchestrator.on('transcript', transcript);
    expect(f.request.agent.providerPolicy.fallback).toBe('none');
    f.stt.emit('error', new Error('connection lost'));
    await vi.waitFor(() => expect(f.recognitionSessions).toHaveLength(2));
    await vi.waitFor(() => expect(f.recognitionSessions[1].reset).toHaveBeenCalled());
    expect(f.recognitionAdapter.calls).toBe(1);
    f.stt.emit('transcript', { ...old, text: 'stale', isFinal: true, confidence: 1 });
    expect(transcript).not.toHaveBeenCalled();
    await f.manager.requestEnd('scope-a', 'call-a', 'client_stop');
    for (let step = 0; step < 10; step++) await f.manager.advance('scope-a', 'call-a');
    expect(f.recognitionSessions[1].flush).toHaveBeenCalledOnce();
    expect(f.recognitionSessions[1].close).toHaveBeenCalledOnce(); expect(runtime.released).toBe(true);
  });
  it('recognizes PCM through a receiver-bound class factory and waits for acknowledged synthesis', async () => {
    const f = await factoryFixture(); const { runtime, physical, acknowledge } = await f.attach();
    expect(f.recognitionAdapter.calls).toBe(1); expect(f.request.agent.providerPolicy.fallback).toBe('none');
    f.recognize(); physical.emit('audio', { samples: new Float32Array(320), sampleRate: 16000, timestamp: Date.now() });
    await vi.waitFor(() => expect(physical.waitForPlayback).toHaveBeenCalledOnce());
    expect(f.reasoning.send).toHaveBeenCalledOnce(); expect(f.ttsSessions).toHaveLength(1);
    expect(physical.sendControl).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'agent_done' }));
    acknowledge(); await vi.waitFor(() => expect(physical.sendControl).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent_done' })));
    await f.manager.requestEnd('scope-a', 'call-a', 'client_stop');
    for (let step = 0; step < 10; step++) await f.manager.advance('scope-a', 'call-a');
    const state = await f.store.withTransaction('scope-a', async (tx) => (await tx.get('calls', 'call-a'))?.value);
    expect(state?.call.state).toBe('ended'); expect(runtime.released).toBe(true);
    expect(state?.call.usage.supplierComponents).toEqual(expect.arrayContaining([
      expect.objectContaining({ component: 'synthesis_accepted_character', quantity: 5, status: 'complete' }),
      expect.objectContaining({ component: 'synthesis_sample_16000', quantity: 320, status: 'complete' }),
    ]));
  });
  it.each(['client_stop', 'purged'] as const)('drains the closing generation before media release for %s', async (reason) => {
    const f = await factoryFixture(); const { runtime, physical } = await f.attach(); const transcript = vi.fn();
    runtime.orchestrator.on('transcript', transcript); const identity = structuredClone(f.identity());
    vi.mocked(f.stt.flush).mockImplementation(async () => {
      expect(physical.close).not.toHaveBeenCalled(); expect(f.stt.close).not.toHaveBeenCalled();
      f.stt.emit('transcript', { ...identity, text: 'closing final', confidence: 1, isFinal: true });
      f.stt.emit('transcript', { ...identity, generation: { ...identity.generation, inferenceGeneration: identity.generation.inferenceGeneration + 1 }, text: 'obsolete', confidence: 1, isFinal: true });
    });
    await f.manager.requestEnd('scope-a', 'call-a', reason);
    for (let step = 0; step < 10; step++) await f.manager.advance('scope-a', 'call-a');
    expect(physical.close).toHaveBeenCalledOnce(); expect(runtime.released).toBe(true);
    if (reason === 'purged') { expect(f.stt.flush).not.toHaveBeenCalled(); expect(transcript).not.toHaveBeenCalled(); }
    else { expect(f.stt.flush).toHaveBeenCalledOnce(); expect(transcript).toHaveBeenCalledOnce(); expect(transcript.mock.calls[0]?.[0].text).toBe('closing final'); }
    expect(f.reasoning.send).not.toHaveBeenCalled();
  });
  it('retries final persistence after one failed transaction and settles once', async () => {
    const f = await factoryFixture(); const { runtime } = await f.attach();
    const settle = vi.spyOn(f.hooks, 'settleOnce'); await f.manager.requestEnd('scope-a', 'call-a', 'client_stop');
    for (let step = 0; step < 6; step++) await f.manager.advance('scope-a', 'call-a');
    const transaction = vi.spyOn(f.store, 'withTransaction').mockRejectedValueOnce(new Error('store temporarily unavailable'));
    await expect(runtime.confirmStopped()).rejects.toThrow('store temporarily unavailable');
    const nativeCalls = f.fence.mock.calls.length;
    await expect(runtime.releaseSlots()).rejects.toThrow('stop evidence');
    expect((await f.store.withTransaction('scope-a', (tx) => tx.list('slots')))[0]?.value.released).toBe(false);
    transaction.mockRestore(); await runtime.confirmStopped(); expect(f.fence.mock.calls.length).toBe(nativeCalls);
    for (let step = 0; step < 5; step++) await f.manager.advance('scope-a', 'call-a');
    expect(runtime.released).toBe(true); expect(settle).toHaveBeenCalledOnce();
    expect((await f.manager.get('scope-a', 'call-a'))?.state).toBe('ended');
  });
  it.each([3, 65])('captures an explicit synthesis ceiling of %i with a typed end reason', async (ceiling) => {
    const limits = { maxTextCharacters: 1000, maxSynthesisRequests: ceiling }; const f = await factoryFixture(limits);
    f.request.agent.limits.maxTurns = 100; f.request.agent.reasoning.attemptLimits.maxAttempts = 100;
    await f.store.withTransaction('scope-a', async (tx) => { const row = await tx.get('calls', 'call-a'); if (!row) throw new Error('fixture missing'); row.value.limits.maxTurns = 100; row.value.call.attemptAllowance.limits = f.request.agent.reasoning.attemptLimits; await tx.put('calls', 'call-a', row.value, row.version); });
    limits.maxSynthesisRequests = 1; const { runtime, physical, acknowledge } = await f.attach();
    for (let index = 0; index < ceiling; index++) {
      const spoken = runtime.orchestrator.pushToTTS('hello');
      await vi.waitFor(() => expect(physical.waitForPlayback).toHaveBeenCalledTimes(index + 1)); acknowledge(); await spoken;
    }
    await expect(runtime.orchestrator.pushToTTS('hello')).rejects.toThrow('synthesis request bound');
    await vi.waitFor(async () => expect((await f.manager.get('scope-a', 'call-a'))?.endReason).toBe('budget_exhausted'));
    expect(f.ttsSessions).toHaveLength(ceiling);
    for (let step = 0; step < 10; step++) await f.manager.advance('scope-a', 'call-a');
    expect(runtime.released).toBe(true);
  });
  it('shares one preparation, freezes the revision and acquires both slots before any provider request', async () => {
    const f = await factoryFixture(); const [a, b] = await Promise.all([f.factory.startSession(f.request), f.factory.startSession(f.request)]);
    expect(a).toBe(b); expect(f.reasoning.send).not.toHaveBeenCalled(); expect(a.orchestrator.state).toBe('idle');
    f.request.agent.prompt = 'changed'; expect(a.agent.prompt).not.toBe('changed');
    expect(await f.store.withTransaction('scope-a', (tx) => tx.list('slots'))).toHaveLength(1);
    await a.abortModelAndTools(); await a.cancelTts(); await a.releaseMedia(); await a.confirmStopped(); await a.releaseSlots();
  });
  it('fans real PCM through the configured owned detectors and persists quantity-only reports', async () => {
    const f = await factoryFixture(); const { runtime, physical } = await f.attach();
    physical.emit('audio', { samples: new Float32Array(320).fill(0.2), sampleRate: 16000, timestamp: Date.now() });
    await vi.waitFor(() => expect(f.vad.pushAudio).toHaveBeenCalledOnce()); expect(f.endpoint.pushAudio).toHaveBeenCalledOnce();
    expect(f.frames[0]).toMatchObject({ scopeId: 'scope-a', callId: 'call-a', sequence: 1, generation: runtime.binding.generation });
    await runtime.heartbeat(); expect((await f.store.withTransaction('scope-a', async (tx) => (await tx.get('calls', 'call-a'))!.value)).reportSequence).toBeGreaterThan(0);
    await runtime.abortModelAndTools(); await runtime.cancelTts(); await runtime.releaseMedia(); await runtime.confirmStopped(); await runtime.releaseSlots();
    expect(f.dispose).toHaveBeenCalled();
  });
  it('refuses a hosted counting budget, wrong principal and a nonexistent ledger hold before slot admission', async () => {
    const f = await factoryFixture();
    const scope = captureVoiceScope({ ...f.request.scope, policy: { ...f.request.scope.policy, mode: 'hosted' } });
    await expect(f.factory.startSession({ ...f.request, scope, agent: { ...f.request.agent, providerPolicy: { ...f.request.agent.providerPolicy, mode: 'hosted' } } })).rejects.toThrow();
    await expect(f.factory.startSession({ ...f.request, scope: captureVoiceScope({ ...f.request.scope, principal: { kind: 'service_key', principalId: 'foreign' } }) })).rejects.toThrow('call authority');
    await expect(f.factory.startSession({ ...f.request, funding: { kind: 'credit', store: new InMemoryCompoundCreditStore(), holdId: 'missing' } })).rejects.toThrow('hold');
    expect(await f.store.withTransaction('scope-a', (tx) => tx.list('slots'))).toHaveLength(0);
  });
  it('retains capacity when native stop cannot be proved', async () => {
    const f = await factoryFixture(); const { runtime } = await f.attach(); f.refuseFence();
    await runtime.abortModelAndTools(); await expect(runtime.cancelTts()).rejects.toThrow();
    await expect(runtime.confirmStopped()).rejects.toThrow(); await expect(runtime.releaseSlots()).rejects.toThrow('stop evidence');
    const leases = await f.store.withTransaction('scope-a', (tx) => tx.list('slots')); expect(leases[0]!.value.released).toBe(false);
    // A failed call remains for host reconciliation; the factory's deadline timer is stopped by the abort hook.
  });
  it('stops locally after fifteen seconds even when a heartbeat has not completed', async () => {
    vi.useFakeTimers();
    try {
      const f = await factoryFixture(); const runtime = await f.factory.startSession(f.request);
      let finishRenew!: () => void; const renew = vi.spyOn(f.limiter, 'renew').mockImplementation(() => new Promise((resolve) => { finishRenew = () => resolve(undefined); }));
      await vi.advanceTimersByTimeAsync(15001); expect(renew).toHaveBeenCalledOnce(); expect(runtime.scope.signal.aborted).toBe(true);
      expect((await f.manager.get('scope-a', 'call-a'))!.state).toBe('ending');
      expect((await f.store.withTransaction('scope-a', (tx) => tx.list('slots')))[0]!.value.released).toBe(false);
      finishRenew(); await runtime.cancelTts(); await runtime.releaseMedia(); await runtime.confirmStopped(); await runtime.releaseSlots();
    } finally { vi.useRealTimers(); }
  });
});
