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

describe('scoped reconnection after a flush that ended the stream', () => {
  const identity: AudioIdentity = { scopeId: 'scope-a', callId: 'call-a', turnId: 'turn-a', generation: { workerGeneration: 1, inferenceGeneration: 1, transportEpoch: 1 } };
  const frameAt = (sequence: number): ScopedAudioFrame => ({ ...identity, samples: new Float32Array(320), sampleRate: 16000, channels: 1, timestamp: sequence * 20, sequence });
  /** A host session; with `reports`, its flush ends its stream and `inputEnded` says so. */
  const host = (reports: boolean) => {
    const opened: ScopedStreamingSTTSession[] = [];
    const provider = {
      providerId: 'host-a',
      isStreaming: true,
      startSession: vi.fn(async () => {
        let ended = false;
        const session = Object.assign(new EventEmitter(), {
          pushAudio() {},
          pushAudioScoped: vi.fn(async (_frame: ScopedAudioFrame) => {}),
          reset: vi.fn(async () => {}),
          flush: vi.fn(async () => {
            ended = reports;
          }),
          close: vi.fn(),
        });
        if (reports) Object.defineProperty(session, 'inputEnded', { get: () => ended, enumerable: true });
        opened.push(session);
        return session;
      }),
    };
    return { provider, opened };
  };

  it('reports the end and takes the close after the flush as the end, with no new session', async () => {
    const { provider, opened } = host(true);
    const session = await new ReconnectingSTT(provider, { minReplayMs: 0 }).startSession({ call: identity }) as ScopedStreamingSTTSession;
    const errors: Error[] = [];
    const closes = vi.fn();
    session.on('error', (error: Error) => errors.push(error));
    session.on('close', closes);
    await session.pushAudioScoped(frameAt(1));
    await session.flush();
    expect(session.inputEnded).toBe(true);
    opened[0].emit('close');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(provider.startSession).toHaveBeenCalledOnce();
    expect(closes).toHaveBeenCalledOnce();
    expect(errors).toEqual([]);
    expect(session.inputEnded).toBe(true);
  });

  it('drops a late frame of the current identity once the close that ended the stream ended the scoped session', async () => {
    const { provider, opened } = host(true);
    const session = await new ReconnectingSTT(provider, { minReplayMs: 0 }).startSession({ call: identity }) as ScopedStreamingSTTSession;
    session.on('error', () => {});
    await session.pushAudioScoped(frameAt(1));
    await session.flush();
    opened[0].emit('close');
    await expect(session.pushAudioScoped(frameAt(2))).resolves.toBeUndefined();
    await expect(session.pushAudioScoped({ ...frameAt(3), samples: new Float32Array(0) })).resolves.toBeUndefined();
    expect(opened[0].pushAudioScoped).toHaveBeenCalledTimes(1);
    expect(session.inputEnded).toBe(true);
    // A frame of another identity is still refused.
    await expect(session.pushAudioScoped({ ...frameAt(4), turnId: 'turn-b' })).rejects.toThrow('stale');
  });

  it('drops a frame after the flush that ended the stream: it reaches neither the provider nor a replay', async () => {
    const { provider, opened } = host(true);
    const session = await new ReconnectingSTT(provider, { minReplayMs: 0 }).startSession({ call: identity }) as ScopedStreamingSTTSession;
    session.on('error', () => {});
    await session.pushAudioScoped(frameAt(1));
    await session.flush();
    await expect(session.pushAudioScoped({ ...frameAt(2), samples: new Float32Array(0) })).resolves.toBeUndefined();
    await expect(session.pushAudioScoped(frameAt(3))).resolves.toBeUndefined();
    expect(opened[0].pushAudioScoped).toHaveBeenCalledTimes(1);
    // An error during the provider's drain is a failure and reconnects; the replay holds the audio before the flush alone.
    opened[0].emit('error', new Error('connection lost'));
    await vi.waitFor(() => expect(opened).toHaveLength(2));
    await session.flush();
    expect(vi.mocked(opened[1].pushAudioScoped).mock.calls.map(([frame]) => frame.sequence)).toEqual([1]);
    session.close();
  });

  it('ends on a close that reports the end of the stream while the flush is still pending', async () => {
    const { provider, opened } = host(true);
    const session = await new ReconnectingSTT(provider, { minReplayMs: 0 }).startSession({ call: identity }) as ScopedStreamingSTTSession;
    const errors: Error[] = [];
    const closes = vi.fn();
    session.on('error', (error: Error) => errors.push(error));
    session.on('close', closes);
    await session.pushAudioScoped(frameAt(1));
    // The provider sends its last result and closes before its flush resolves.
    const flush = vi.mocked(opened[0].flush);
    const drained = flush.getMockImplementation()!;
    flush.mockImplementationOnce(async () => {
      await drained();
      opened[0].emit('close');
    });
    await session.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closes).toHaveBeenCalledOnce();
    expect(provider.startSession).toHaveBeenCalledOnce();
    expect(errors).toEqual([]);
    expect(session.inputEnded).toBe(true);
  });

  it('reconnects on an error followed at once by a close, though the session reports the end of its stream', async () => {
    const { provider, opened } = host(true);
    const session = await new ReconnectingSTT(provider, { minReplayMs: 0 }).startSession({ call: identity }) as ScopedStreamingSTTSession;
    const errors: Error[] = [];
    const closes = vi.fn();
    session.on('error', (error: Error) => errors.push(error));
    session.on('close', closes);
    await session.pushAudioScoped(frameAt(1));
    await session.flush();
    // A provider that fails sends its error and its close in one go, after the flush that ended its stream.
    opened[0].emit('error', new Error('connection lost'));
    opened[0].emit('close');
    await vi.waitFor(() => expect(opened).toHaveLength(2));
    await session.flush();
    expect(vi.mocked(opened[1].pushAudioScoped).mock.calls.map(([frame]) => frame.sequence)).toEqual([1]);
    expect(closes).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
    session.close();
  });

  it('still reconnects on a close after a completed flush when the session reports no end', async () => {
    const { provider, opened } = host(false);
    const session = await new ReconnectingSTT(provider, { minReplayMs: 0 }).startSession({ call: identity }) as ScopedStreamingSTTSession;
    session.on('error', () => {});
    await session.pushAudioScoped(frameAt(1));
    await session.flush();
    expect(session.inputEnded).not.toBe(true);
    opened[0].emit('close');
    await vi.waitFor(() => expect(opened).toHaveLength(2));
    session.close();
  });
});
