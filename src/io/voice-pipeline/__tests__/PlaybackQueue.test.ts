/**
 * The played text a PlaybackQueue reports: the contiguous prefix of the
 * sentence segments whose last frame the transport acknowledged, read from the
 * boundaries the chunks carry, never from bytes sent, from the duration, or
 * from the legacy text field. The queue has one slot, so chunks are
 * acknowledged in the order they are sent; a segment whose last frame carries
 * no boundary (its terminal response never came) is never proven, and the
 * prefix stops before it whatever is acknowledged after.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { PlaybackQueue } from '../PlaybackQueue.js';
import type { EncodedAudioChunk, IPlaybackTransport, PlaybackReceipt, TtsTextBoundary, VoiceGeneration } from '../types.js';

const generation: VoiceGeneration = { workerGeneration: 1, inferenceGeneration: 1, transportEpoch: 1 };
const limits = { maxBytes: 64000, maxDurationMs: 2000 };

/** A 20 ms chunk of 16 kHz PCM, with the boundary of the segment it ends, when it ends one. */
const chunk = (textBoundary?: TtsTextBoundary): EncodedAudioChunk => ({
  audio: Buffer.alloc(640),
  format: 'pcm',
  container: 'raw',
  sampleRate: 16000,
  durationMs: 20,
  text: textBoundary?.text ?? '',
  generation: { ...generation },
  ...(textBoundary ? { textBoundary } : {}),
});

/** The boundary of a segment, from its start and its exact text. */
const boundary = (segmentId: string, start: number, text: string): TtsTextBoundary => ({ segmentId, start, end: start + text.length, text, final: true });

/**
 * A speaking transport whose playback waits settle when the test acknowledges them by sequence. With `late`, a wait
 * stays open past its abort, so a receipt can come after a cancel.
 */
function transport(late = false) {
  const waits: Array<(receipt: PlaybackReceipt) => void> = [];
  const t: IPlaybackTransport = Object.assign(new EventEmitter(), {
    id: 'transport-a',
    state: 'open' as const,
    sendAudio: vi.fn(async () => {}),
    sendControl: vi.fn(async () => {}),
    close() {},
    waitForPlayback: vi.fn(
      async (_generation: VoiceGeneration, sequence: number, signal: AbortSignal) =>
        new Promise<PlaybackReceipt>((resolve, reject) => {
          waits[sequence] = resolve;
          if (late) return;
          if (signal.aborted) reject(new Error('aborted'));
          else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        })
    ),
    clearPlayback: vi.fn(async () => {}),
  });
  const ack = (sequence: number): void => {
    waits[sequence]!({ generation: { ...generation }, sequence, playedSamples: 320, sampleRate: 16000 });
  };
  return { t, ack };
}

describe('PlaybackQueue played text', () => {
  it('reports the played text as the contiguous prefix of acknowledged boundaries', async () => {
    const f = transport();
    const q = new PlaybackQueue(f.t, generation, limits);
    const first = boundary('seg-1', 0, 'Hello there.');
    const second = boundary('seg-2', 12, ' How are you?');
    const fourth = boundary('seg-4', 31, ' Thanks.');

    // The first segment's last frame is sent with its boundary, and heard once the transport acknowledges it.
    let work = q.enqueue(chunk(first));
    await vi.waitFor(() => expect(f.t.waitForPlayback).toHaveBeenCalledTimes(1));
    expect(vi.mocked(f.t.sendAudio).mock.calls[0]![0]).toMatchObject({ sequence: 1, textBoundary: first });
    expect(q.stats().playedText).toBe('');
    f.ack(1);
    await work;
    expect(q.stats().playedText).toBe('Hello there.');

    // The second segment follows the first exactly: the prefix grows by its text.
    work = q.enqueue(chunk(second));
    await vi.waitFor(() => expect(f.t.waitForPlayback).toHaveBeenCalledTimes(2));
    f.ack(2);
    await work;
    expect(q.stats()).toMatchObject({ playedMs: 40, playedText: 'Hello there. How are you?' });

    // The third segment's last frame carries no boundary: its terminal response never came, so it is never proven.
    work = q.enqueue(chunk());
    await vi.waitFor(() => expect(f.t.waitForPlayback).toHaveBeenCalledTimes(3));
    f.ack(3);
    await work;
    expect(q.stats()).toMatchObject({ playedMs: 60, playedText: 'Hello there. How are you?' });

    // The fourth is acknowledged, but the prefix stops at the gap before it.
    work = q.enqueue(chunk(fourth));
    await vi.waitFor(() => expect(f.t.waitForPlayback).toHaveBeenCalledTimes(4));
    f.ack(4);
    await work;
    expect(q.stats()).toMatchObject({ playedMs: 80, playedText: 'Hello there. How are you?' });
  });

  it('advances nothing for a chunk a cancel discarded, even on a late receipt', async () => {
    const f = transport(true);
    const q = new PlaybackQueue(f.t, generation, limits);
    const pending = q.enqueue(chunk(boundary('seg-1', 0, 'Hello there.')));
    const rejected = expect(pending).rejects.toThrow('playback cancelled');
    await vi.waitFor(() => expect(f.t.waitForPlayback).toHaveBeenCalledOnce());

    const cancelling = q.cancel();
    // The transport's receipt comes after the cancel: the chunk was discarded, so it proves nothing.
    f.ack(1);
    await cancelling;
    await rejected;
    expect(q.stats()).toMatchObject({ playedMs: 0, playedText: '' });
  });

  it('a chunk without a boundary adds its samples to playedMs and nothing to playedText', async () => {
    const f = transport();
    const q = new PlaybackQueue(f.t, generation, limits);
    const work = q.enqueue(chunk());
    await vi.waitFor(() => expect(f.t.waitForPlayback).toHaveBeenCalledOnce());
    f.ack(1);
    await work;
    expect(q.stats()).toEqual({ bytes: 0, durationMs: 0, playedMs: 20, playedText: '' });
  });
});
