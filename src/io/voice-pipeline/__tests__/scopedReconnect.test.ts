/**
 * Scoped same-provider reconnection: a session opened with `config.call`
 * forwards scoped frames, replays them with their identity into a session of
 * the same provider, drops the replay on reset, refuses frames and results of
 * an earlier identity, and drains the replacement on flush.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { ReconnectingSTT } from '../ReconnectingSTT.js';
import type { AudioIdentity, ScopedStreamingSTTSession, ScopedAudioFrame } from '../types.js';

describe('scoped same-provider reconnection', () => {
  it('forwards scoped frames, resets replay, rejects stale input and drains the replacement', async () => {
    const identity: AudioIdentity = { scopeId: 'scope-a', callId: 'call-a', turnId: 'turn-a', generation: { workerGeneration: 1, inferenceGeneration: 1, transportEpoch: 1 } };
    const opened: ScopedStreamingSTTSession[] = [];
    const provider = {
      providerId: 'local-a',
      isStreaming: true,
      startSession: vi.fn(async () => {
        const session = Object.assign(new EventEmitter(), { pushAudio() {}, pushAudioScoped: vi.fn(async () => {}), reset: vi.fn(async () => {}), flush: vi.fn(async () => {}), close: vi.fn() });
        opened.push(session);
        return session;
      }),
    };
    const session = await new ReconnectingSTT(provider, { minReplayMs: 0 }).startSession({ call: identity }) as ScopedStreamingSTTSession;
    const output = vi.fn();
    session.on('transcript', output);
    session.on('error', () => {});
    const frame: ScopedAudioFrame = { ...identity, samples: new Float32Array(320), sampleRate: 16000, channels: 1, timestamp: 0, sequence: 1 };
    await session.pushAudioScoped(frame);
    opened[0].emit('error', new Error('connection lost'));
    await vi.waitFor(() => expect(opened).toHaveLength(2));
    await session.flush();
    expect(opened[1].pushAudioScoped).toHaveBeenCalledWith(frame);
    expect(opened[1].flush).toHaveBeenCalledOnce();
    const next = { ...identity, turnId: 'turn-b', generation: { ...identity.generation, inferenceGeneration: 2 } };
    await session.reset(next);
    await expect(session.pushAudioScoped(frame)).rejects.toThrow('stale');
    opened[0].emit('transcript', { ...identity, text: 'stale', isFinal: true, confidence: 1 });
    opened[1].emit('error', new Error('connection lost'));
    await vi.waitFor(() => expect(opened).toHaveLength(3));
    await session.flush();
    expect(opened[2].pushAudioScoped).not.toHaveBeenCalled();
    expect(output).not.toHaveBeenCalled();
    expect(provider.startSession.mock.calls).toHaveLength(3);
    session.close();
  });
});
