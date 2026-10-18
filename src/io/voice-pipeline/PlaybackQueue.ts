/**
 * @module voice-pipeline/PlaybackQueue
 *
 * The awaited, bounded playback queue between a pull-contract synthesis
 * producer and a speaking transport. It has one occupied slot: `enqueue`
 * resolves only after the transport acknowledges that the chunk played, so the
 * producer waits before producing the next chunk, and a second concurrent
 * `enqueue` is refused instead of queued. The byte and duration ceilings cover
 * the whole slot, including the native send and the acknowledgement. Played
 * duration counts acknowledged samples alone, never bytes merely sent, and so
 * does the played text: the contiguous prefix of the sentence segments whose
 * last frame, marked with its boundary ({@link TtsTextBoundary}), the
 * transport acknowledged. Cancellation invalidates the queue synchronously,
 * clears the publisher, forgets the chunks sent and not yet acknowledged, and
 * waits for the outstanding send and acknowledgement to settle; each
 * inference generation gets a new queue.
 */

import { inspectPcm16 } from './audioFormat.js';
import { PlayedTextTracker } from './ttsTextBoundaries.js';
import { sameVoiceGeneration, type EncodedAudioChunk, type IPlaybackTransport, type VoiceGeneration } from './types.js';

/** Capacity includes the one chunk awaiting send or playback completion. */
export interface PlaybackQueueLimits {
  /** Most decoded PCM bytes in the slot. */
  maxBytes: number;
  /** Most audio in the slot, in milliseconds; at most 2,000. */
  maxDurationMs: number;
}

/** Awaited single-producer queue. One slot avoids an unbounded list of pending capacity promises. */
export class PlaybackQueue {
  private readonly generation: VoiceGeneration;
  private readonly abort = new AbortController();
  private readonly tracker = new PlayedTextTracker();
  private sequence = 0;
  private bytes = 0;
  private durationMs = 0;
  private playedMs = 0;
  private pending?: Promise<void>;
  private failure?: Error;
  private cancelled = false;
  private cancelling?: Promise<void>;

  /**
   * Binds the queue to one inference generation of one speaking transport.
   *
   * @param transport - Sends the audio, acknowledges its playback and clears it.
   * @param generation - The fences this queue plays; a chunk carrying any other generation is stale. It is copied.
   * @param limits - The slot's byte and duration ceilings.
   * @throws {Error} When `maxBytes` is not a positive safe integer, or `maxDurationMs` is not finite, above 0 and at most 2,000.
   */
  constructor(private readonly transport: IPlaybackTransport, generation: Readonly<VoiceGeneration>, private readonly limits: PlaybackQueueLimits) {
    this.generation = { ...generation };
    if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes <= 0 || !Number.isFinite(limits.maxDurationMs) || limits.maxDurationMs <= 0 || limits.maxDurationMs > 2000) throw new Error('invalid playback bound');
  }

  /** Resolves only for an exactly matching playback receipt; parallel calls violate the producer contract. */
  async enqueue(chunk: EncodedAudioChunk): Promise<void> {
    if (this.cancelled) throw new Error('playback cancelled');
    if (this.failure) throw this.failure;
    if (this.pending) throw new Error('concurrent producer');
    if (!chunk.generation || !sameVoiceGeneration(chunk.generation, this.generation)) throw new Error('stale audio');
    const pcm = inspectPcm16(chunk);
    if (pcm.pcm.length > this.limits.maxBytes || pcm.durationMs > this.limits.maxDurationMs || chunk.audio.length > this.limits.maxBytes + 4096) throw new Error('playback bound exceeded');
    this.bytes = pcm.pcm.length;
    this.durationMs = pcm.durationMs;
    const sequence = ++this.sequence;
    // A chunk that ends a segment is recorded under its sequence before it is sent; its receipt makes the segment heard.
    this.tracker.sent(sequence, chunk.textBoundary);
    const work = (async () => {
      // The producer owns the bytes until this promise settles and must not mutate them meanwhile.
      await this.transport.sendAudio({ ...chunk, sequence, generation: { ...this.generation } });
      if (this.cancelled) throw new Error('playback cancelled');
      const receipt = await this.transport.waitForPlayback(this.generation, sequence, this.abort.signal);
      if (this.cancelled || !sameVoiceGeneration(receipt.generation, this.generation) || receipt.sequence !== sequence || receipt.sampleRate !== pcm.sampleRate || receipt.playedSamples !== pcm.samples) throw new Error('invalid playback receipt');
      this.playedMs += receipt.playedSamples / receipt.sampleRate * 1000;
      this.tracker.acknowledged(sequence);
    })();
    this.pending = work;
    try {
      await work;
    } catch {
      this.failure = new Error(this.cancelled ? 'playback cancelled' : 'playback failed');
      throw this.failure;
    } finally {
      if (this.pending === work) this.pending = undefined;
      this.bytes = 0;
      this.durationMs = 0;
    }
  }

  /** Finishes only after synthesis has stopped producing and its last chunk is acknowledged. */
  async drain(): Promise<void> {
    await this.pending;
    if (this.failure) throw this.failure;
    if (this.cancelled) throw new Error('playback cancelled');
  }

  /** Invalidates before I/O, clears the physical queue, and waits for supervised outstanding work. */
  cancel(): Promise<void> {
    if (this.cancelling) return this.cancelling;
    this.cancelled = true;
    this.abort.abort();
    // A receipt that comes for a discarded chunk proves nothing.
    this.tracker.cleared();
    this.cancelling = (async () => {
      const results = await Promise.allSettled([this.transport.clearPlayback(this.generation), this.pending ?? Promise.resolve()]);
      if (results[0]!.status === 'rejected') throw new Error('playback clear incomplete');
    })();
    return this.cancelling;
  }

  /**
   * Whether a chunk's send, its playback acknowledgement or its receipt failed: the transport's failure, after which
   * every `enqueue` and `drain` rejects. A chunk the queue refuses before it reaches the transport (stale, over the
   * bound, sent while another is in the slot) and a cancellation leave it `false`.
   */
  get transportFailed(): boolean {
    return this.failure !== undefined && !this.cancelled;
  }

  /**
   * Occupancy, acknowledged duration, and the text proven played: the contiguous prefix of the segments whose last
   * frame the transport acknowledged, exactly as submitted, empty while none is. The numbers are content-free; the
   * text is the reply's and belongs in its conversation item, never in a log line.
   */
  stats(): { bytes: number; durationMs: number; playedMs: number; playedText: string } {
    return { bytes: this.bytes, durationMs: this.durationMs, playedMs: this.playedMs, playedText: this.tracker.playedText };
  }
}
