/**
 * @module voice-pipeline/AudioFanout
 *
 * One sequenced, bounded input queue that delivers each normalized 16 kHz mono
 * frame to recognition, the audio endpoint detector and the voice activity
 * session, in that order, with the call's scope and fences stamped on it once.
 * The capture boundary normalizes the audio; the fan-out validates that and
 * never resamples per consumer. Overflow, out-of-order input and skipped wire
 * sequences become content-free gap reports, and the consumers are reset
 * before the next admitted frame, so no speech is replayed across a gap.
 */

import {
  copyAudioIdentity,
  type AudioFrame,
  type AudioGapEvent,
  type AudioIdentity,
  type IAudioEndpointDetector,
  type IVadSession,
  type ScopedAudioFrame,
} from './types.js';

/** The factory binds all consumers to the same scope and supplies a content-free gap callback. */
export interface AudioFanoutOptions {
  /** The identity to stamp on the next admitted frame and to reset the detectors with. */
  identity(): AudioIdentity;
  /** Recognition's consumer; resolves once the frame is admitted. */
  stt(frame: ScopedAudioFrame): Promise<void>;
  /** The voice activity session; the fan-out owns and disposes it. */
  vad: IVadSession;
  /** The audio endpoint detector; the fan-out owns and disposes it. */
  endpoint: IAudioEndpointDetector;
  /** Most frames queued or in flight. */
  maxFrames: number;
  /** Most samples queued or in flight. */
  maxSamples: number;
  /** Synchronous invalidation only. It must not await this fan-out's drain. */
  onGap(event: AudioGapEvent): void;
}

/** One sequenced, bounded input queue. Every consumer completes a frame before the next begins. */
export class AudioFanout {
  private queue: ScopedAudioFrame[] = [];
  private samples = 0;
  private frames = 0;
  private sequence = 0;
  private lastTimestamp = -Infinity;
  private lastWireSequence = 0;
  private revision = 0;
  private resetPending = true;
  private running?: Promise<void>;
  private failure?: Error;
  private disposed = false;

  /**
   * Takes ownership of the voice activity session and the endpoint detector.
   *
   * @param options - The consumers, the queue bounds and the gap callback.
   * @throws {Error} When a queue bound is not a positive safe integer.
   */
  constructor(private readonly options: AudioFanoutOptions) {
    if (![options.maxFrames, options.maxSamples].every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error('invalid audio queue bound');
  }

  /** Synchronous bounded admission, including the in-flight frame; false reports an overflow gap. */
  offer(input: AudioFrame): boolean {
    if (this.disposed) return false;
    if (this.failure) throw this.failure;
    if (
      input.sampleRate !== 16000 ||
      (input.channels ?? 1) !== 1 ||
      !Number.isFinite(input.timestamp) ||
      input.samples.length === 0 ||
      input.samples.some((s) => !Number.isFinite(s) || Math.abs(s) > 1)
    ) {
      throw new Error('input must be normalized mono 16 kHz PCM');
    }
    if (input.sequence !== undefined) {
      if (!Number.isSafeInteger(input.sequence) || input.sequence <= this.lastWireSequence) {
        this.gap('sequence', input.samples.length / 16);
        return false;
      }
      if (this.lastWireSequence > 0 && input.sequence !== this.lastWireSequence + 1) this.gap('sequence', 0);
      this.lastWireSequence = input.sequence;
    }
    if (input.timestamp < this.lastTimestamp) {
      this.gap('sequence', input.samples.length / 16);
      return false;
    }
    this.lastTimestamp = input.timestamp;
    if (this.frames + 1 > this.options.maxFrames || this.samples + input.samples.length > this.options.maxSamples) {
      this.gap('overflow', input.samples.length / 16);
      return false;
    }
    const identity = copyAudioIdentity(this.options.identity());
    this.queue.push({
      ...input,
      ...identity,
      generation: { ...identity.generation },
      channels: 1,
      sampleRate: 16000,
      sequence: ++this.sequence,
      samples: input.samples.slice(),
    });
    this.frames++;
    this.samples += input.samples.length;
    this.start();
    return true;
  }

  /** Invalidates queued audio and resets consumers before their next admitted frame. */
  gap(reason: AudioGapEvent['reason'], lostMs: number): void {
    if (!Number.isFinite(lostMs) || lostMs < 0) throw new Error('invalid audio gap');
    const queued = this.queue.reduce((n, f) => n + f.samples.length, 0);
    this.samples -= queued;
    this.frames -= this.queue.length;
    this.queue = [];
    this.revision++;
    this.resetPending = true;
    this.options.onGap({ ...copyAudioIdentity(this.options.identity()), reason, lostMs: lostMs + queued / 16, afterSequence: this.sequence });
    this.start();
  }

  /** Clears without reporting loss, for an already-recorded turn, interruption or detach. */
  reset(): void {
    const queued = this.queue.reduce((n, f) => n + f.samples.length, 0);
    this.samples -= queued;
    this.frames -= this.queue.length;
    this.queue = [];
    this.revision++;
    this.resetPending = true;
    this.start();
  }

  private start(): void {
    if (this.running || this.disposed) return;
    this.running = this.pump()
      .catch(() => {
        this.failure = new Error('audio consumer failed');
        this.queue = [];
        this.samples = 0;
        this.frames = 0;
      })
      .finally(() => {
        this.running = undefined;
        if (!this.disposed && !this.failure && (this.queue.length > 0 || this.resetPending)) this.start();
      });
  }

  private async pump(): Promise<void> {
    while (!this.disposed) {
      if (this.resetPending) {
        this.resetPending = false;
        const identity = copyAudioIdentity(this.options.identity());
        await this.options.vad.reset(identity);
        await this.options.endpoint.reset(identity);
      }
      const frame = this.queue.shift();
      if (!frame) {
        if (this.resetPending) continue;
        return;
      }
      const revision = this.revision;
      try {
        await this.options.stt(frame);
        if (revision !== this.revision || this.disposed) continue;
        // Endpoint retains this frame before VAD can ask it to evaluate the window.
        await this.options.endpoint.pushAudio(frame);
        if (revision !== this.revision || this.disposed) continue;
        await this.options.vad.pushAudio(frame);
      } finally {
        this.samples -= frame.samples.length;
        this.frames--;
      }
    }
  }

  /** Waits for admitted work and surfaces a consumer failure to its call supervisor. */
  async drain(): Promise<void> {
    while (this.running) await this.running;
    if (this.failure) throw this.failure;
  }

  /** Content-free current occupancy, including in-flight work. */
  stats(): { frames: number; samples: number } {
    return { frames: this.frames, samples: this.samples };
  }

  /** The factory transfers ownership to this object; disposal awaits each owned detector once. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.queue = [];
    await this.running;
    const results = await Promise.allSettled([this.options.vad.dispose(), this.options.endpoint.dispose()]);
    this.frames = 0;
    this.samples = 0;
    if (results.some((r) => r.status === 'rejected')) throw new Error('audio disposal incomplete');
  }
}
