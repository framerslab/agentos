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
 * the provider completes with no frame, as an ellipsis alone can be, attaches
 * nothing: its text joins the boundary of the next segment of the reply that
 * ends on a frame, which then starts where it starts, so the boundaries stay
 * contiguous and the played prefix runs on past it. A segment
 * with no terminal response within `timeoutMs` ends without a boundary, and
 * so does one the adapter abandons because its socket closed first: a timeout
 * is not completion, and a segment completed with no frame before either is
 * proven by no boundary. The wait runs from the moment the adapter has asked for
 * the terminal response, `hooks.start` returning or resolving. While a start is
 * still pending and no segment waits behind it, the adapter may take a new
 * segment into the one in flight (`hooks.extend`), so the provider gets the
 * text now and one terminal response proves them together: the boundary then
 * covers the joined text, under the first segment's id.
 *
 * `flush()` cuts the final, unterminated segment and resolves once every
 * segment queued so far has ended; the adapter's `flush_complete` goes out
 * once per `flush()` call, through `hooks.flushed`, and never for a segment's
 * completion. `cancel()` drops the queued segments, the held frame and the
 * segment in flight, and resolves the pending flushes without
 * `flush_complete`. `lost()`, for a provider that is gone, ends the segment in
 * flight without a boundary, its held frame going out, drops the queued
 * segments and completes the pending flushes with `flush_complete`, so the
 * reply they belong to ends. `retry()`, for a segment whose provider failed
 * before its terminal response, ends it without a boundary, its held frame going
 * out, and queues it again at the front, nothing counted as ended, so the
 * adapter's next start is that segment's, on a fresh connection, and a flush
 * waiting for it goes on waiting. `hold()` keeps the next segment from starting
 * until `release()`, for an adapter that must first let a stale response pass.
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

/** A letter or a digit, in any script: a segment without one, such as an ellipsis or an emoji alone, has nothing to say. */
const SPEAKABLE = /[\p{L}\p{N}]/u;

/** Two contiguous segments as one, under the first one's id. */
function joined(first: TextSegment, next: TextSegment): TextSegment {
  return { segmentId: first.segmentId, start: first.start, end: next.end, text: first.text + next.text };
}

/** What the queue asks of its adapter. */
export interface SegmentSynthesisHooks {
  /**
   * Sends one segment to the provider and asks for its terminal response. The
   * segment is in flight from this call until its terminal response, its
   * timeout, its abandonment or a cancel; `signal` aborts then, so a start that
   * first awaits a socket or a slot sends nothing after it. The segment's wait
   * for the terminal response (`timeoutMs`) runs from the moment this returns
   * or resolves, since only then has the response been asked for. A start that
   * throws or rejects ends the segment without a boundary.
   *
   * @param segment - The segment, with its exact text and offsets.
   * @param signal - Aborted once the segment is no longer in flight.
   */
  start(segment: TextSegment, signal: AbortSignal): void | Promise<void>;
  /**
   * Takes a new segment into the one in flight while that one's `start` is
   * still pending and no segment waits behind it: the adapter sends the
   * segment's text, so one terminal response proves them together, and returns
   * `true`; `false` leaves the segment queued for a start of its own. Without
   * this hook every segment waits its turn.
   *
   * @param segment - The new segment, which follows the one in flight exactly.
   * @param signal - The signal of the segment in flight.
   */
  extend?(segment: TextSegment, signal: AbortSignal): boolean;
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
  /** The segment, with the segments taken into it. */
  segment: TextSegment;
  held?: EncodedAudioChunk;
  /** The wait for the terminal response, once it has been asked for. */
  timer?: ReturnType<typeof setTimeout>;
  abort: AbortController;
  /** Whether the terminal response has been asked for: `start` returned or resolved. */
  armed: boolean;
  /** How many queued segments the flight holds. */
  count: number;
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
  /** The segments waiting to start, in order, each with how many queued segments it holds: one, unless it is a flight sent again. */
  private readonly pending: Array<{ segment: TextSegment; count: number }> = [];
  private flight?: Flight;
  /**
   * The segments with nothing to say (no letter or digit) that the provider completed with no frame, joined, until the
   * segment after them ends: the boundary of the next segment that ends on a frame starts where they start, so the
   * played prefix runs on past a segment with nothing to hear, such as an ellipsis alone. A segment with words that
   * completes with no frame, one that starts elsewhere, as the next reply's first does, a timeout, an abandonment, a
   * loss and a cancel forget them.
   */
  private silent?: TextSegment;
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

  /** Whether a segment is in flight or queued, or a flush waits: the provider still owes the adapter a response. */
  get busy(): boolean {
    return this.flight !== undefined || this.pending.length > 0 || this.waiters.length > 0;
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

  /**
   * The provider's terminal response: the held frame goes out with the segment's boundary, which starts where the
   * segments with nothing to say completed with no frame just before it start, so the boundaries stay contiguous. A
   * segment completed with no frame attaches nothing: one with nothing to say joins them, and one with words, which
   * nothing proves was spoken, ends them, so the played prefix stops before it. With nothing in flight, nothing happens.
   */
  completed(): void {
    const flight = this.flight;
    if (!flight) return;
    this.end(flight);
    const segment = this.silent && this.silent.end === flight.segment.start ? joined(this.silent, flight.segment) : flight.segment;
    if (flight.held) {
      this.silent = undefined;
      this.hooks.emit({ ...flight.held, textBoundary: boundaryOf(segment) });
    } else this.silent = SPEAKABLE.test(flight.segment.text) ? undefined : segment;
    this.finish(flight);
  }

  /** The segment in flight ends without a terminal response: its held frame goes out without a boundary. */
  abandon(): void {
    const flight = this.flight;
    if (!flight) return;
    this.end(flight);
    this.silent = undefined;
    if (flight.held) this.hooks.emit(flight.held);
    this.finish(flight);
  }

  /**
   * The provider failed the segment in flight before its terminal response, and the adapter will send it again: the
   * segment ends without a boundary, its held frame going out, and is queued again at the front, with the segments it
   * held, so the next start is its own. Nothing is counted as ended: a flush waiting for it goes on waiting.
   */
  retry(): void {
    const flight = this.flight;
    if (!flight) return;
    this.end(flight);
    if (flight.held) this.hooks.emit(flight.held);
    this.pending.unshift({ segment: flight.segment, count: flight.count });
    this.startNext();
  }

  /**
   * The provider is gone: the segment in flight ends without a boundary, its held frame going out, the queued segments
   * are dropped and the text forgotten, and the pending flushes complete, with `flush_complete`, since every segment
   * queued before them has ended. A caller's `cancel()` differs in taking `flush_complete` with it.
   */
  lost(): void {
    const flight = this.flight;
    if (flight) {
      this.end(flight);
      if (flight.held) this.hooks.emit(flight.held);
    }
    this.silent = undefined;
    this.pending.length = 0;
    this.segmenter.reset();
    this.ended = this.queued;
    this.settle();
  }

  /** Drops the queued segments, the held frame and the segment in flight, forgets the text, and resolves the pending flushes without `flush_complete`. */
  cancel(): void {
    if (this.flight) this.end(this.flight);
    this.silent = undefined;
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
    this.queued++;
    const flight = this.flight;
    // A segment arriving while the one in flight has yet to ask for its terminal response may join it, when the
    // adapter takes it and no segment waits behind: one terminal response then proves them together.
    if (flight && !flight.armed && this.pending.length === 0 && this.hooks.extend?.(segment, flight.abort.signal)) {
      flight.segment = { segmentId: flight.segment.segmentId, start: flight.segment.start, end: segment.end, text: flight.segment.text + segment.text };
      flight.count++;
      return;
    }
    this.pending.push({ segment, count: 1 });
    this.startNext();
  }

  private startNext(): void {
    if (this.flight || this.holding) return;
    const next = this.pending.shift();
    if (!next) return;
    // Segments completed with no frame join only the segment that follows them in the same reply.
    if (this.silent && this.silent.end !== next.segment.start) this.silent = undefined;
    const flight: Flight = { segment: next.segment, abort: new AbortController(), armed: false, count: next.count };
    this.flight = flight;
    let started: Promise<void>;
    try {
      started = Promise.resolve(this.hooks.start(flight.segment, flight.abort.signal));
    } catch (error) {
      started = Promise.reject(error);
    }
    started.then(
      () => this.arm(flight),
      () => {
        if (this.flight === flight) this.abandon();
      }
    );
  }

  /** The terminal response has been asked for: the segment's wait for it begins. */
  private arm(flight: Flight): void {
    if (this.flight !== flight || flight.armed) return;
    flight.armed = true;
    flight.timer = setTimeout(() => this.timeout(flight), this.hooks.timeoutMs ?? DEFAULT_SEGMENT_TIMEOUT_MS);
  }

  private timeout(flight: Flight): void {
    if (this.flight !== flight) return;
    this.end(flight);
    this.silent = undefined;
    if (flight.held) this.hooks.emit(flight.held);
    this.hooks.timedOut?.(flight.segment);
    this.finish(flight);
  }

  /** Takes the segment out of flight: its timer cleared, its start aborted. */
  private end(flight: Flight): void {
    if (flight.timer !== undefined) clearTimeout(flight.timer);
    flight.abort.abort();
    if (this.flight === flight) this.flight = undefined;
  }

  /** A flight has ended, with every segment it held: the flushes it completes settle, then the next segment starts. */
  private finish(flight: Flight): void {
    this.ended += flight.count;
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
