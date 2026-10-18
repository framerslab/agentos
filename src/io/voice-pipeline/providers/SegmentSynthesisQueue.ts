/**
 * @module voice-pipeline/providers/SegmentSynthesisQueue
 *
 * One sentence segment in flight at a time, for a streaming TTS adapter whose
 * provider answers the text it was sent with a terminal response (Deepgram
 * Aura's `Flushed`, ElevenLabs' `isFinal`). The queue cuts the text the
 * adapter is given into immutable sentence segments ({@link SentenceSegmenter}),
 * hands them to the provider one at a time, holds the newest audio frame of
 * the segment in flight and attaches the segment's boundary
 * ({@link TtsTextBoundary}) to that frame when the terminal response proves
 * the segment complete. Every earlier frame goes out without one. A segment
 * with no terminal response within `timeoutMs` ends without a boundary, and
 * so does one the adapter abandons because its socket closed first: a timeout
 * is not completion.
 *
 * `flush()` cuts the final, unterminated segment and resolves once every
 * segment queued so far has ended; the adapter's `flush_complete` goes out
 * once per `flush()` call, through `hooks.flushed`, and never for a segment's
 * completion. `cancel()` drops the queued segments, the held frame and the
 * segment in flight, and resolves the pending flushes without
 * `flush_complete`. `hold()` keeps the next segment from starting until
 * `release()`, for an adapter that must first let a stale response pass.
 *
 * @example
 * ```typescript
 * const segments = new SegmentSynthesisQueue({
 *   start: (segment) => send({ type: 'Speak', text: segment.text }),
 *   emit: (chunk) => session.emit('audio', chunk),
 *   flushed: () => session.emit('flush_complete'),
 * });
 * segments.push('Hello there. How are');
 * segments.frame(chunk); // held: the segment 'Hello there.' is in flight
 * segments.completed(); // the held frame goes out with the segment's boundary
 * ```
 */

import type { EncodedAudioChunk } from '../types.js';
import { SentenceSegmenter, boundaryOf, type TextSegment } from '../ttsTextBoundaries.js';

/** How long a segment waits for its terminal response before it ends without a boundary. */
export const DEFAULT_SEGMENT_TIMEOUT_MS = 5_000;

/** What the queue asks of its adapter. */
export interface SegmentSynthesisHooks {
  /**
   * Sends one segment to the provider. The segment is in flight from this call
   * until its terminal response, its timeout, its abandonment or a cancel;
   * `signal` aborts then, so a start that first awaits a socket sends nothing
   * after it. A start that throws or rejects ends the segment without a
   * boundary.
   *
   * @param segment - The segment, with its exact text and offsets.
   * @param signal - Aborted once the segment is no longer in flight.
   */
  start(segment: TextSegment, signal: AbortSignal): void | Promise<void>;
  /**
   * Hands a frame to the adapter's consumers, as its `audio` event.
   *
   * @param chunk - The frame, with its boundary when it ends a segment.
   */
  emit(chunk: EncodedAudioChunk): void;
  /** Every segment of one `flush()` call has ended: the adapter emits `flush_complete`. */
  flushed(): void;
  /**
   * The segment in flight had no terminal response within `timeoutMs`. Called
   * after its held frame went out and before the next segment starts, so the
   * adapter can `hold()` the queue while the late response may still arrive.
   *
   * @param segment - The segment that timed out.
   */
  timedOut?(segment: TextSegment): void;
  /** Milliseconds a segment waits for its terminal response. @defaultValue 5000 */
  timeoutMs?: number;
}

/** The segment in flight, with the newest frame held back for its boundary. */
interface Flight {
  segment: TextSegment;
  held?: EncodedAudioChunk;
  timer: ReturnType<typeof setTimeout>;
  abort: AbortController;
}

/** A `flush()` call waiting for the segments queued before it to end. */
interface FlushWaiter {
  until: number;
  resolve: () => void;
}

/**
 * Serializes an adapter's sentence segments through its provider's terminal
 * responses and marks each segment's last proven frame with its boundary.
 */
export class SegmentSynthesisQueue {
  private readonly segmenter = new SentenceSegmenter();
  private readonly pending: TextSegment[] = [];
  private flight?: Flight;
  private queued = 0;
  private ended = 0;
  private waiters: FlushWaiter[] = [];
  private holding = false;

  /**
   * @param hooks - The adapter's send, emit and `flush_complete`.
   */
  constructor(private readonly hooks: SegmentSynthesisHooks) {}

  /** The text of the segment in flight, what the provider has been sent since its last terminal response; empty between segments. */
  get inFlightText(): string {
    return this.flight?.segment.text ?? '';
  }

  /** Whether a segment is in flight. */
  get hasInFlight(): boolean {
    return this.flight !== undefined;
  }

  /**
   * Appends submitted text; each sentence it completes is queued, and the first starts at once when none is in flight.
   *
   * @param tokens - The text, as the reply submits it.
   */
  push(tokens: string): void {
    for (const segment of this.segmenter.push(tokens)) this.enqueue(segment);
  }

  /**
   * Queues the final, unterminated segment, if any, and resolves once every segment queued so far has ended.
   * The next text starts a new reply: its offsets count from 0 again.
   */
  flush(): Promise<void> {
    const last = this.segmenter.flush();
    if (last) this.enqueue(last);
    this.segmenter.reset();
    return new Promise<void>((resolve) => {
      this.waiters.push({ until: this.queued, resolve });
      // A flush with nothing left to wait for still settles after the caller has had its turn to listen.
      queueMicrotask(() => this.settle());
    });
  }

  /**
   * An audio frame arrived. While a segment is in flight the newest frame is held and the one held before it goes out
   * without a boundary; with no segment in flight the frame goes out at once, without one.
   *
   * @param chunk - The frame, without a boundary.
   */
  frame(chunk: EncodedAudioChunk): void {
    if (!this.flight) {
      this.hooks.emit(chunk);
      return;
    }
    const previous = this.flight.held;
    this.flight.held = chunk;
    if (previous) this.hooks.emit(previous);
  }

  /** The provider's terminal response: the held frame goes out with the segment's boundary. With nothing in flight, nothing happens. */
  completed(): void {
    const flight = this.flight;
    if (!flight) return;
    this.end(flight);
    if (flight.held) this.hooks.emit({ ...flight.held, textBoundary: boundaryOf(flight.segment) });
    this.finish();
  }

  /** The segment in flight ends without a terminal response: its held frame goes out without a boundary. */
  abandon(): void {
    const flight = this.flight;
    if (!flight) return;
    this.end(flight);
    if (flight.held) this.hooks.emit(flight.held);
    this.finish();
  }

  /** Drops the queued segments, the held frame and the segment in flight, forgets the text, and resolves the pending flushes without `flush_complete`. */
  cancel(): void {
    if (this.flight) this.end(this.flight);
    this.pending.length = 0;
    this.segmenter.reset();
    this.ended = this.queued;
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter.resolve();
  }

  /** Keeps the next segment from starting until {@link release}; the segment in flight is unaffected. */
  hold(): void {
    this.holding = true;
  }

  /** Lets the next queued segment start. */
  release(): void {
    this.holding = false;
    this.startNext();
  }

  private enqueue(segment: TextSegment): void {
    this.pending.push(segment);
    this.queued++;
    this.startNext();
  }

  private startNext(): void {
    if (this.flight || this.holding) return;
    const segment = this.pending.shift();
    if (!segment) return;
    const abort = new AbortController();
    const flight: Flight = {
      segment,
      abort,
      timer: setTimeout(() => this.timeout(flight), this.hooks.timeoutMs ?? DEFAULT_SEGMENT_TIMEOUT_MS),
    };
    this.flight = flight;
    let started: Promise<void>;
    try {
      started = Promise.resolve(this.hooks.start(segment, abort.signal));
    } catch (error) {
      started = Promise.reject(error);
    }
    started.catch(() => {
      if (this.flight === flight) this.abandon();
    });
  }

  private timeout(flight: Flight): void {
    if (this.flight !== flight) return;
    this.end(flight);
    if (flight.held) this.hooks.emit(flight.held);
    this.hooks.timedOut?.(flight.segment);
    this.finish();
  }

  /** Takes the segment out of flight: its timer cleared, its start aborted. */
  private end(flight: Flight): void {
    clearTimeout(flight.timer);
    flight.abort.abort();
    if (this.flight === flight) this.flight = undefined;
  }

  /** One more segment has ended: the flushes it completes settle, then the next segment starts. */
  private finish(): void {
    this.ended++;
    this.settle();
    this.startNext();
  }

  private settle(): void {
    const due = this.waiters.filter((waiter) => waiter.until <= this.ended);
    if (due.length === 0) return;
    this.waiters = this.waiters.filter((waiter) => waiter.until > this.ended);
    for (const waiter of due) {
      this.hooks.flushed();
      waiter.resolve();
    }
  }
}
