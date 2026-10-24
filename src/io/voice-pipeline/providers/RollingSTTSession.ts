/**
 * @module voice-pipeline/providers/RollingSTTSession
 *
 * One streaming session over successive sockets of the same provider, each
 * opened, authorized and funded on its own: a socket that reaches its funded
 * audio ceiling is drained and closed, and the next one takes the audio that
 * follows. Each successor is opened through the provider's own factory, so
 * authorization, the training opt-out, the parser, resampling and final
 * metering stay the provider's.
 */

import { EventEmitter } from 'node:events';
import type { AudioFrame, StreamingSTTSession, TranscriptEvent } from '../types.js';
import { SttConnectionAuthorizationError } from '../SttConnectionAuthorizationError.js';

/** A provider session over one funded socket, as {@link RollingSTTSession} drives it. */
export interface FundedSocketSession extends StreamingSTTSession {
  /** Wire seconds handed to the socket so far. */
  readonly audioSeconds: number;
  /** The socket's funded ceiling, in wire seconds. */
  readonly audioCeiling: number;
  /** The socket is open and takes audio. */
  readonly isOpen: boolean;
}

/**
 * A stable session facade over separately funded same-provider sockets.
 * Transcript times, word times included, are moved onto the facade's audio
 * clock by the seconds the earlier sockets carried. A socket the facade lets
 * go of, at a ceiling or at its own close, still delivers the transcripts it
 * emits as it closes, such as the empty final with which it takes back a line
 * it held open; a `close()` made from a transcript listener on one of those
 * ends the facade there, and no successor is authorized or opened. A
 * successor whose authorization is refused, or whose ceiling
 * holds no audio, ends the facade with a {@link SttConnectionAuthorizationError}:
 * no frame is sent past a funded ceiling and no other vendor is tried.
 */
export class RollingSTTSession extends EventEmitter implements StreamingSTTSession {
  private active: FundedSocketSession | undefined;
  private draining: FundedSocketSession | undefined;
  /** The socket the facade is closing: the transcripts it emits as it closes still go out. */
  private retiring: FundedSocketSession | undefined;
  private closed = false;
  private offsetMs = 0;
  private tail: Promise<void> = Promise.resolve();

  private constructor(private readonly open: () => Promise<FundedSocketSession>) {
    super();
  }

  /**
   * Opens the first socket and returns the facade over it.
   *
   * @param open - Opens one authorized socket of the provider.
   * @throws What `open` throws, or {@link SttConnectionAuthorizationError} for a first socket with no funded audio.
   */
  static async start(open: () => Promise<FundedSocketSession>): Promise<RollingSTTSession> {
    const session = new RollingSTTSession(open);
    await session.adopt();
    return session;
  }

  /** Opens the next funded socket and makes it the one in use, forwarding its events onto the facade's clock. */
  private async adopt(): Promise<void> {
    const socket = await this.open();
    if (this.closed || !socket.isOpen) {
      socket.close();
      throw new Error('STT socket closed before adoption');
    }
    if (!(socket.audioCeiling > 0)) {
      socket.close();
      throw new SttConnectionAuthorizationError();
    }
    this.active = socket;
    const offset = this.offsetMs;
    socket.on('transcript', (event: TranscriptEvent) => {
      if (socket !== this.retiring && (this.closed || this.active !== socket)) return;
      this.emit('transcript', {
        ...event,
        ...(event.startMs === undefined ? {} : { startMs: event.startMs + offset }),
        ...(event.endMs === undefined ? {} : { endMs: event.endMs + offset }),
        ...(event.words === undefined
          ? {}
          : { words: event.words.map((word) => ({ ...word, start: word.start + offset, end: word.end + offset })) }),
      });
    });
    // Supplier usage is not output: a socket's final report still belongs to its request after it is replaced.
    socket.on('usage', (event: unknown) => this.emit('usage', event));
    for (const name of ['speech_start', 'speech_end', 'vad', 'warning'] as const) {
      socket.on(name, (...args: unknown[]) => {
        if (!this.closed && this.active === socket) this.emit(name, ...args);
      });
    }
    socket.on('error', (error: Error) => {
      if (!this.closed && this.active === socket && this.listenerCount('error')) this.emit('error', error);
    });
    // A socket closed by the drain is replaced; any other close of the socket in use ends the facade.
    socket.on('close', () => {
      if (!this.closed && this.active === socket && this.draining !== socket) this.close();
    });
  }

  /**
   * Hands one frame on, draining, letting go of and replacing each socket whose funded ceiling it reaches. A close
   * made while a socket is let go of ends the frame there, with no successor.
   */
  private async send(frame: AudioFrame): Promise<void> {
    if (!Number.isSafeInteger(frame.sampleRate) || frame.sampleRate <= 0) throw new RangeError('invalid input sample rate');
    let consumed = 0;
    while (consumed < frame.samples.length && !this.closed) {
      const current = this.active;
      if (!current?.isOpen) throw new Error('STT socket closed');
      const left = current.audioCeiling - current.audioSeconds;
      const count = Math.min(frame.samples.length - consumed, Math.max(0, Math.floor(left * frame.sampleRate)));
      if (count === 0) {
        // A ceiling that holds no sample would open socket after socket without sending anything.
        if (current.audioSeconds === 0) throw new SttConnectionAuthorizationError();
        this.draining = current;
        try {
          await current.flush();
          if (this.closed) return;
          this.offsetMs += current.audioSeconds * 1000;
          this.active = undefined;
          this.draining = undefined;
          this.retire(current);
          // A transcript listener may close the facade on the retiring socket's closing transcript: no successor then.
          if (this.closed) return;
          await this.adopt();
        } finally {
          if (this.draining === current) this.draining = undefined;
        }
        continue;
      }
      await current.pushAudio({
        ...frame,
        samples: frame.samples.subarray(consumed, consumed + count),
        timestamp: frame.timestamp + (consumed / frame.sampleRate) * 1000,
      });
      consumed += count;
    }
  }

  /**
   * Sends the frame, splitting it at the current socket's funded ceiling and opening the next socket for the rest.
   * Frames go out in the order they were pushed. A failure ends the facade: `'error'` (to a listener; printed
   * without one), then `'close'`.
   *
   * @returns Resolves once the frame has been handed on or the failure it met has ended the facade. It never
   *   rejects, since the session contract lets a caller ignore it.
   */
  pushAudio(frame: AudioFrame): Promise<void> {
    const sent = this.tail.then(() => this.send(frame));
    this.tail = sent.then(undefined, (error: unknown) => {
      try {
        this.fail(error instanceof Error ? error : new Error('STT continuation failed'));
      } catch {
        // A listener's throw leaves the facade closed by fail(); the next frame still runs in order.
      }
    });
    return this.tail;
  }

  private fail(error: Error): void {
    if (this.closed) return;
    try {
      if (this.listenerCount('error')) this.emit('error', error);
      else console.warn('[rolling-stt] session error (no listener attached):', error.message);
    } finally {
      this.close();
    }
  }

  /** Waits for the frames pushed so far, then flushes the socket in use. */
  async flush(): Promise<void> {
    await this.tail;
    await this.active?.flush();
  }

  /**
   * Closes the socket in use, which reports its final usage and delivers the transcripts it emits as it closes, then
   * emits `'close'` once.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const current = this.active;
    this.active = undefined;
    this.retire(current);
    this.emit('close');
  }

  /**
   * Closes a socket the facade lets go of. The transcripts it emits as it closes, such as the empty final that takes
   * back a line it held open, go out first; its speech events do not.
   */
  private retire(socket: FundedSocketSession | undefined): void {
    if (socket === undefined) return;
    this.retiring = socket;
    try {
      socket.close();
    } finally {
      this.retiring = undefined;
    }
  }
}
