/**
 * Acknowledged playback and supplier synthesis usage: one bounded, awaited
 * playback slot that holds the producer until the transport acknowledges the
 * chunk, supervised send failure, cancellation that clears the publisher and
 * refuses stale audio, and cumulative synthesis quantities that keep
 * cancelled work and bound request identities.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { PlaybackQueue } from '../PlaybackQueue.js';
import { TtsUsageMeter } from '../TtsUsageMeter.js';
import type { AudioIdentity, EncodedAudioChunk, IPlaybackTransport, PlaybackReceipt, StreamingTTSUsageEvent } from '../types.js';

const identity: AudioIdentity = {
  scopeId: 'scope-a',
  callId: 'call-a',
  turnId: 'turn-a',
  generation: { workerGeneration: 1, inferenceGeneration: 1, transportEpoch: 1 },
};
const chunk = (ms = 20): EncodedAudioChunk => ({
  audio: Buffer.alloc(ms * 32),
  format: 'pcm',
  container: 'raw',
  sampleRate: 16000,
  durationMs: ms,
  text: 'hello',
  generation: { ...identity.generation },
});

/** A speaking transport whose playback wait settles only on `ack()` or on abort. */
function transport() {
  let acknowledge!: (receipt: PlaybackReceipt) => void;
  const t: IPlaybackTransport = Object.assign(new EventEmitter(), {
    id: 'transport-a',
    state: 'open' as const,
    sendAudio: vi.fn(async () => {}),
    sendControl: vi.fn(async () => {}),
    close() {},
    waitForPlayback: vi.fn(async (_g: AudioIdentity['generation'], _s: number, signal: AbortSignal) => new Promise<PlaybackReceipt>((resolve, reject) => {
      acknowledge = resolve;
      if (signal.aborted) reject(new Error('aborted'));
      else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })),
    clearPlayback: vi.fn(async () => {}),
  });
  return { t, ack: () => acknowledge({ generation: { ...identity.generation }, sequence: 1, playedSamples: 320, sampleRate: 16000 }) };
}

describe('acknowledged playback', () => {
  it('holds capacity and producer completion until playback acknowledgement', async () => {
    const f = transport();
    const q = new PlaybackQueue(f.t, identity.generation, { maxBytes: 64000, maxDurationMs: 2000 });
    let complete = false;
    const work = q.enqueue(chunk()).then(() => { complete = true; });
    await vi.waitFor(() => expect(f.t.waitForPlayback).toHaveBeenCalledOnce());
    expect(complete).toBe(false);
    expect(q.stats()).toMatchObject({ bytes: 640, durationMs: 20, playedMs: 0 });
    await expect(q.enqueue(chunk())).rejects.toThrow('concurrent producer');
    f.ack();
    await work;
    await q.drain();
    expect(q.stats()).toEqual({ bytes: 0, durationMs: 0, playedMs: 20 });
  });

  it('rejects oversized audio and supervises send rejection', async () => {
    const f = transport();
    const q = new PlaybackQueue(f.t, identity.generation, { maxBytes: 64000, maxDurationMs: 2000 });
    await expect(q.enqueue(chunk(2001))).rejects.toThrow('playback bound');
    // A chunk refused before it reaches the transport is no failure of the transport's.
    expect(q.transportFailed).toBe(false);
    f.t.sendAudio = vi.fn(async () => { throw new Error('socket gone'); });
    await expect(q.enqueue(chunk())).rejects.toThrow('playback failed');
    expect(q.transportFailed).toBe(true);
    await expect(q.drain()).rejects.toThrow('playback failed');
    expect(q.stats().playedMs).toBe(0);
  });

  it('cancels stalled playback and refuses stale chunks or completions', async () => {
    const f = transport();
    const q = new PlaybackQueue(f.t, identity.generation, { maxBytes: 64000, maxDurationMs: 2000 });
    const pending = q.enqueue(chunk());
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(f.t.waitForPlayback).toHaveBeenCalledOnce());
    await q.cancel();
    await rejected;
    expect(f.t.clearPlayback).toHaveBeenCalledWith(identity.generation);
    expect(q.stats().playedMs).toBe(0);
    await expect(q.enqueue(chunk())).rejects.toThrow('playback cancelled');
    expect(q.transportFailed).toBe(false);
    const other = new PlaybackQueue(transport().t, { ...identity.generation, inferenceGeneration: 2 }, { maxBytes: 64000, maxDurationMs: 2000 });
    await expect(other.enqueue(chunk())).rejects.toThrow('stale audio');
    expect(other.transportFailed).toBe(false);
  });
});

describe('supplier synthesis usage', () => {
  const usage = (over: Partial<StreamingTTSUsageEvent> = {}): StreamingTTSUsageEvent => ({
    ...identity,
    providerId: 'local-a',
    requestId: 'request-a',
    acceptedCharacters: 5,
    generatedSamples: 320,
    sampleRate: 16000,
    status: 'running',
    final: false,
    ...over,
  });

  it('deduplicates cumulative reports and keeps actual cancelled work', () => {
    const meter = new TtsUsageMeter('scope-a', 'call-a', 2);
    meter.record(usage());
    meter.record(usage());
    meter.record(usage({ generatedSamples: 640, status: 'cancelled', final: true }));
    expect(meter.totals()).toEqual({ acceptedCharacters: 5, generatedSeconds: 0.04, requests: 1, pending: 0 });
    meter.record(usage({ generatedSamples: 640, status: 'cancelled', final: true }));
    expect(() => meter.record(usage({ generatedSamples: 320, final: true, status: 'completed' }))).toThrow();
    expect(() => meter.record(usage({ scopeId: 'scope-b' }))).toThrow('foreign usage');
  });

  it('retains unresolved usage as pending and bounds request identities', () => {
    const meter = new TtsUsageMeter('scope-a', 'call-a', 1);
    meter.record(usage());
    expect(meter.totals().pending).toBe(1);
    expect(() => meter.record(usage({ requestId: 'request-b' }))).toThrow('usage request bound');
  });
});
