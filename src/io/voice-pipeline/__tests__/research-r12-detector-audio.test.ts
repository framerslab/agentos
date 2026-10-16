/**
 * Scoped detector audio: one sequenced, bounded 16 kHz mono fan-out to
 * recognition, voice activity and endpointing; the eight-second endpoint
 * window; and the reset fence of the event-only endpoint adapter.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { AudioFanout } from '../AudioFanout.js';
import { AudioWindowRing } from '../AudioWindowRing.js';
import { adaptEndpointDetector } from '../adaptEndpointDetector.js';
import type { AudioFrame, AudioIdentity, IAudioEndpointDetector, IVadSession, ScopedAudioFrame } from '../types.js';

const identity: AudioIdentity = {
  scopeId: 'scope-a',
  callId: 'call-a',
  turnId: 'turn-a',
  generation: { workerGeneration: 1, inferenceGeneration: 1, transportEpoch: 1 },
};
const frame = (timestamp: number, n = 320): AudioFrame => ({ timestamp, sampleRate: 16000, samples: new Float32Array(n).fill(0.25), channels: 1 });

/** Recording consumers: what reached recognition, voice activity and endpointing, in order. */
function consumers() {
  const stt: ScopedAudioFrame[] = [];
  const vadFrames: ScopedAudioFrame[] = [];
  const endpointFrames: ScopedAudioFrame[] = [];
  const vad: IVadSession = Object.assign(new EventEmitter(), {
    pushAudio: async (f: ScopedAudioFrame) => { vadFrames.push(f); },
    reset: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  });
  const endpoint: IAudioEndpointDetector = Object.assign(new EventEmitter(), {
    mode: 'semantic' as const,
    pushAudio: async (f: ScopedAudioFrame) => { endpointFrames.push(f); },
    pushVadEvent: vi.fn(async () => {}),
    pushTranscript: vi.fn(async () => {}),
    reset: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  });
  return { stt, vadFrames, endpointFrames, vad, endpoint };
}

describe('scoped detector audio', () => {
  it('delivers one copied sequence to STT, VAD and endpointing and refuses non-normalized input', async () => {
    const c = consumers();
    const gaps = vi.fn();
    const fan = new AudioFanout({
      identity: () => identity,
      stt: async (f) => { c.stt.push(f); },
      vad: c.vad,
      endpoint: c.endpoint,
      maxFrames: 4,
      maxSamples: 1280,
      onGap: gaps,
    });
    const input = frame(0);
    expect(fan.offer(input)).toBe(true);
    input.samples.fill(0);
    expect(fan.offer(frame(20))).toBe(true);
    await fan.drain();
    for (const frames of [c.stt, c.vadFrames, c.endpointFrames]) {
      expect(frames.map((f) => f.sequence)).toEqual([1, 2]);
      expect(frames[0]).toMatchObject(identity);
      expect(frames[0]!.samples[0]).toBe(0.25);
    }
    expect(() => fan.offer({ ...frame(40), sampleRate: 48000 })).toThrow('normalized');
    expect(() => fan.offer({ ...frame(40), channels: 2 })).toThrow('normalized');
    await fan.dispose();
    expect(c.vad.dispose).toHaveBeenCalledOnce();
    expect(c.endpoint.dispose).toHaveBeenCalledOnce();
  });

  it('bounds in-flight input, consolidates overflow into a gap and resets before admitting more', async () => {
    const c = consumers();
    let unblock!: () => void;
    const gaps = vi.fn();
    c.vad.pushAudio = async () => new Promise<void>((resolve) => { unblock = resolve; });
    const fan = new AudioFanout({
      identity: () => identity,
      stt: async () => {},
      vad: c.vad,
      endpoint: c.endpoint,
      maxFrames: 2,
      maxSamples: 640,
      onGap: gaps,
    });
    fan.offer(frame(0));
    await vi.waitFor(() => expect(unblock).toBeTypeOf('function'));
    fan.offer(frame(20));
    expect(fan.offer(frame(40))).toBe(false);
    expect(fan.stats().samples).toBeLessThanOrEqual(640);
    expect(gaps).toHaveBeenCalledOnce();
    expect(gaps.mock.calls[0]![0]).toMatchObject({ reason: 'overflow', lostMs: 40, scopeId: 'scope-a' });
    unblock();
    await fan.drain();
    // Once before the first frame, and once more after the gap.
    expect(c.vad.reset).toHaveBeenCalledTimes(2);
    expect(c.endpoint.reset).toHaveBeenCalledTimes(2);
    expect(c.endpointFrames).toHaveLength(1);
    await fan.dispose();
  });

  it('truncates exactly to eight seconds and pads according to the manifest', () => {
    const ring = new AudioWindowRing();
    ring.push(new Float32Array(16000 * 9).fill(0.5));
    expect(ring.length).toBe(128000);
    expect(ring.window('left')).toHaveLength(128000);
    ring.reset();
    ring.push(new Float32Array([1, 2]));
    expect(Array.from(ring.window('right').slice(0, 3))).toEqual([1, 2, 0]);
    expect(Array.from(ring.window('left').slice(-3))).toEqual([0, 1, 2]);
    ring.reset();
    expect(ring.window('left').every((x) => x === 0)).toBe(true);
  });

  it('discards old event-only detector completions after reset', async () => {
    const instances: EventEmitter[] = [];
    const adapter = adaptEndpointDetector(() => {
      const d = Object.assign(new EventEmitter(), { mode: 'heuristic' as const, pushVadEvent() {}, pushTranscript() {}, reset: vi.fn() });
      instances.push(d);
      return d;
    }, identity);
    const turns = vi.fn();
    adapter.on('turn_complete', turns);
    await adapter.reset({ ...identity, turnId: 'turn-b' });
    const turn = { transcript: 'hello', confidence: 1, durationMs: 20, reason: 'manual' as const };
    instances[0]!.emit('turn_complete', turn);
    expect(turns).not.toHaveBeenCalled();
    instances[1]!.emit('turn_complete', turn);
    expect(turns.mock.calls[0]![0]).toMatchObject({ turnId: 'turn-b', scopeId: 'scope-a' });
    await adapter.dispose();
    instances[1]!.emit('turn_complete', turn);
    expect(turns).toHaveBeenCalledOnce();
  });
});
