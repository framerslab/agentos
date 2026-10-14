import { describe, expect, it, vi } from 'vitest';
import { physicalTransport, transportFixture } from './transportFixtures.js';

describe('logical call transport', () => {
  for (const phase of ['recognition', 'reasoning', 'playback'] as const) it(`reattaches during ${phase} with one conversation, unchanged limits and one settlement`, async () => {
    const f = await transportFixture(phase); const first = await f.connect(); const closed = vi.fn(); f.binding.on('close', closed);
    const initial = await f.manager.get('scope-a', 'call-a');
    if (phase !== 'recognition') { f.turn(); await vi.waitFor(() => expect(f.runtime.state).toBe('speaking')); }
    const old = f.identity(); f.time(1600); await f.binding.detach('socket_lost', 1);
    expect(closed).not.toHaveBeenCalled(); expect(f.interrupted).toContainEqual(old);
    expect(f.agentAbort).toHaveBeenCalled(); expect(f.vad.reset).toHaveBeenCalled();
    first.physical.emit('audio', { samples: new Float32Array(320), sampleRate: 16000, timestamp: 1700 });
    f.endpoint.emit('turn_complete', { ...old, transcript: 'old', confidence: 1, durationMs: 20, reason: 'manual' });
    f.time(2000); const next = await f.connect(); expect(next.connection.transportEpoch).toBe(2);
    const resumed = (await f.manager.get('scope-a', 'call-a'))!;
    expect(resumed.workerGeneration).toBe(1); expect(resumed.attemptAllowance).toEqual(initial!.attemptAllowance);
    expect(resumed.startedAt).toBe(1000); expect(f.effects.effects).toEqual([]);
    expect(await f.store.withTransaction('scope-a', (tx) => tx.list('slots'))).toHaveLength(1);
    await expect(f.binding.sendAudio({ scopeId: 'scope-a', callId: 'call-a', generation: old.generation, sequence: 1, audio: Buffer.alloc(640), format: 'pcm', sampleRate: 16000, durationMs: 20, text: '' })).rejects.toThrow('stale');
    f.time(2600); await f.binding.end('client_stop'); await f.runtime.stopSession();
    for (let i = 0; i < 10; i++) await f.manager.advance('scope-a', 'call-a');
    expect((await f.manager.get('scope-a', 'call-a'))!.usage).toMatchObject({ connectedMs: 1200, billableSeconds: 2 });
    expect((await f.manager.events('scope-a', 'call-a')).map((e) => e.type)).toEqual(['call.started', 'call.ended']);
    expect(f.effects.effects.filter((x) => x === 'settle')).toHaveLength(1); expect(closed).toHaveBeenCalledOnce();
  });
  it('refuses participant mismatch, consumed credentials, stale epochs and expired slots before starting', async () => {
    const f = await transportFixture(); const c = await f.grant(); const physical = physicalTransport().transport;
    const input = { token: c.token, origin: f.seed.clientOrigin, transportEpoch: c.transportEpoch, participantId: 'foreign', transport: 'websocket' as const, physical };
    await expect(f.binding.reattach(input)).rejects.toThrow(); expect(f.runtime.state).toBe('idle');
    await f.binding.reattach({ ...input, participantId: f.seed.participantId });
    await expect(f.binding.reattach({ ...input, participantId: f.seed.participantId })).rejects.toThrow();
    f.time(17000); await expect(f.connect()).rejects.toThrow(); await f.binding.end('worker_lost'); await f.runtime.stopSession();
  });
  it('coalesces socket loss, ignores stale closes and refuses revival after stop', async () => {
    const f = await transportFixture(); const a = await f.connect();
    await Promise.all([f.binding.detach('lost', 1), f.binding.detach('lost', 1)]);
    expect((await f.manager.get('scope-a', 'call-a'))!.inferenceGeneration).toBe(2);
    await f.connect(); a.physical.emit('close');
    expect(f.binding.state).toBe('open'); await f.binding.end('purged');
    await expect(f.connect()).rejects.toThrow(); await f.runtime.stopSession();
  });
  it('does not admit reconnect until inference cancellation finishes', async () => {
    const f = await transportFixture('playback'); await f.connect(); f.turn();
    await vi.waitFor(() => expect(f.runtime.state).toBe('speaking'));
    let release!: () => void; f.setFence(() => new Promise<void>((resolve) => { release = resolve; })); const detach = f.binding.detach('lost', 1); const c = await f.grant();
    await expect(f.binding.reattach({ token: c.token, origin: f.seed.clientOrigin, participantId: f.seed.participantId, transportEpoch: c.transportEpoch, transport: 'websocket', physical: physicalTransport().transport })).rejects.toThrow('binding busy');
    await vi.waitFor(() => expect(release).toBeTypeOf('function')); release(); f.setFence(async () => {}); await detach; await f.binding.end('client_stop'); await f.runtime.stopSession();
  });
  it('keeps a generation the pipeline records while the attachment is still completing', async () => {
    const f = await transportFixture(); const connected = f.manager.connected.bind(f.manager);
    vi.spyOn(f.manager, 'connected').mockImplementationOnce(async (...args) => {
      // A provider gap interrupts the call the pipeline has just started, before the connection is recorded.
      f.stt.emit('stt:gap', { lostMs: 20 });
      await vi.waitFor(() => expect(f.identity().generation.inferenceGeneration).toBe(2));
      return connected(...args);
    });
    await f.connect();
    const live = f.identity().generation;
    expect(f.binding.generation).toEqual(live);
    await expect(f.binding.sendControl(Object.assign({ type: 'agent_thinking' as const }, { scopeId: 'scope-a', callId: 'call-a', generation: live }))).resolves.toBeUndefined();
    await f.binding.end('client_stop'); await f.runtime.stopSession();
  });
});
