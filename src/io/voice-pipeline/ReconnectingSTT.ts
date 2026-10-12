/**
 * @module voice-pipeline/ReconnectingSTT
 *
 * One streaming transcriber, reconnected when its session errors or closes:
 * the last seconds of audio are replayed into the new session before the
 * frames that arrived meanwhile, a replayed duplicate is dropped, each new
 * session's clock is moved onto the one session timeline, and the caller
 * hears `stt:reconnected` and `stt:gap`. After the cap, `error` then `close`.
 * A chain of several providers fails over instead ({@link StreamingSTTChain});
 * this wraps a chain of one.
 */
import { EventEmitter } from 'node:events';
import { AudioRingBuffer } from './AudioRingBuffer.js';
import { TranscriptDedupe } from './TranscriptDedupe.js';
import type { AudioFrame, IStreamingSTT, StreamingSTTConfig, StreamingSTTSession, TranscriptEvent } from './types.js';

/** Options of {@link ReconnectingSTT}. */
export interface ReconnectingSTTOptions {
  /** How much audio is kept for replay. Default 3000. */
  ringBufferCapacityMs?: number;
  /** Replays below this are skipped. Default 400. */
  minReplayMs?: number;
  /** Attempts allowed in any sixty seconds before the session gives up. Default 3. */
  maxAttemptsPerMinute?: number;
  /** Frames queued while a reconnect runs; beyond it the oldest are dropped and counted. Default 2000 ms. */
  queueCapacityMs?: number;
  /** Milliseconds now, for the attempt window and the gap's length. Default `Date.now`. */
  clock?: () => number;
}

/** Payload of a session's `stt:reconnected`: a new session of the provider took over. */
export interface SttReconnectedEvent {
  /** The attempt's number among the attempts of the last sixty seconds, from 1. */
  attempt: number;
  /** Milliseconds of buffered audio replayed into the new session; 0 when there was less than `minReplayMs`. */
  replayedMs: number;
}

/** Payload of a session's `stt:gap`, emitted right after `stt:reconnected`. */
export interface SttGapEvent {
  /** The attempt's number, as in {@link SttReconnectedEvent}. */
  attempt: number;
  /**
   * Milliseconds the reconnect took, by the options' clock. The audio pushed in that time was queued for the new
   * session, less the oldest frames a full queue dropped (the session's `droppedFrames`).
   */
  lostMs: number;
}

const frameMs = (f: AudioFrame): number => (f.samples.length / f.sampleRate) * 1000;

/**
 * An {@link IStreamingSTT} over one provider whose session is reconnected.
 *
 * An `error` or `close` of the provider's session that the caller did not ask
 * for opens a new session of the same provider, at most
 * `maxAttemptsPerMinute` times in any sixty seconds. The new session hears the
 * buffered audio first (the last `ringBufferCapacityMs`, when there is at least
 * `minReplayMs` of it), then the frames pushed while it opened, then live
 * audio. Its `startMs` and `endMs` are moved onto one timeline, the audio
 * pushed since the session began, and a final that repeats one already
 * emitted over the same audio is dropped. Each reconnect emits
 * `stt:reconnected` ({@link SttReconnectedEvent}) and `stt:gap`
 * ({@link SttGapEvent}). Past the cap the session emits `error`, then `close`.
 *
 * The session forwards `transcript`, `vad`, `speech_start`, `speech_end`,
 * `usage` and `warning` from the provider's sessions; `usage` comes from every
 * one of them, a replaced one too, since a session reports its audio as it
 * closes. A close that follows the caller's `flush()`, with no audio pushed
 * since, is the provider ending its stream as the session contract has it (a
 * final, then `close`): the session emits `close` and does not reconnect.
 *
 * @example
 * ```typescript
 * const stt = new ReconnectingSTT(new DeepgramStreamingSTT({ apiKey: process.env.DEEPGRAM_API_KEY! }));
 * const session = await stt.startSession({ language: 'en-US' });
 * session.on('stt:gap', ({ lostMs }: SttGapEvent) => console.log(`the transcriber was away for ${lostMs} ms`));
 * ```
 */
export class ReconnectingSTT implements IStreamingSTT {
  /** `reconnecting:` followed by the inner provider's id. */
  readonly providerId: string;
  private readonly capacityMs: number;
  private readonly minReplayMs: number;
  private readonly maxAttempts: number;
  private readonly queueCapacityMs: number;
  private readonly clock: () => number;

  /**
   * @param inner - The provider each session opens, again on every reconnect.
   * @param options - The replay buffer, the attempt cap, the queue and the clock.
   */
  constructor(private readonly inner: IStreamingSTT, options: ReconnectingSTTOptions = {}) {
    this.providerId = `reconnecting:${inner.providerId}`;
    this.capacityMs = options.ringBufferCapacityMs ?? 3_000;
    this.minReplayMs = options.minReplayMs ?? 400;
    this.maxAttempts = options.maxAttemptsPerMinute ?? 3;
    this.queueCapacityMs = options.queueCapacityMs ?? 2_000;
    this.clock = options.clock ?? Date.now;
  }

  /** Whether the inner provider has a session open. */
  get isStreaming(): boolean {
    return this.inner.isStreaming;
  }

  /**
   * Opens a session of the inner provider behind a session that reconnects it.
   *
   * @param config - Passed to the inner provider for the first session and for every reconnect.
   * @returns The session, with a read-only `droppedFrames`: the queued frames dropped during reconnects so far.
   * @throws {Error} When the first session fails to open; a session that fails to open on a reconnect is retried
   *   within the cap.
   */
  async startSession(config?: StreamingSTTConfig): Promise<StreamingSTTSession> {
    const facade = new EventEmitter();
    const ring = new AudioRingBuffer({ capacityMs: this.capacityMs, sampleRate: 16_000 });
    const dedupe = new TranscriptDedupe();
    const attempts: number[] = [];
    const queue: AudioFrame[] = [];
    let queuedMs = 0;
    let dropped = 0;
    let current = await this.inner.startSession(config);
    // the connection generation: the dedupe skips observations of one provider id, so each session gets an id of its own
    let generation = 0;
    // where each session's clock 0 sits on the session timeline (the audio pushed by the caller since the start)
    let pushedMs = 0;
    let offsetMs = 0;
    let reconnecting = false;
    let closedByCaller = false;
    let ended = false;
    // set by the caller's flush() and cleared by the next frame: a close then is the provider ending its stream
    let flushed = false;

    /** Ends the session once: `close`, after which nothing but `usage` is forwarded. */
    const finish = (): void => {
      if (ended) return;
      ended = true;
      facade.emit('close');
    };

    const attach = (session: StreamingSTTSession, sessionGeneration: number, sessionOffsetMs: number): void => {
      const providerId = `${this.inner.providerId}#${sessionGeneration}`;
      session.on('transcript', (raw: TranscriptEvent) => {
        if (ended) return;
        const evt: TranscriptEvent = {
          ...raw,
          ...(raw.startMs !== undefined ? { startMs: raw.startMs + sessionOffsetMs } : {}),
          ...(raw.endMs !== undefined ? { endMs: raw.endMs + sessionOffsetMs } : {}),
        };
        if (evt.isFinal) {
          const r = dedupe.evaluate({ provider: providerId, text: evt.text, audioStartMs: evt.startMs ?? 0, audioEndMs: evt.endMs ?? 0, isFinal: true });
          if (r.isDuplicate) return;
        }
        facade.emit('transcript', evt);
      });
      for (const name of ['vad', 'speech_start', 'speech_end'] as const) {
        session.on(name, (...args: unknown[]) => {
          if (ended) return;
          facade.emit(name, ...args);
        });
      }
      // from every session, a replaced or ended one too: a session reports the audio of its connections as it closes
      session.on('usage', (usage: unknown) => {
        facade.emit('usage', usage);
      });
      session.on('warning', (warning: Error) => {
        if (ended) return;
        // Listening here must not silence a warning: a provider session prints one nobody listens for, so the
        // session prints it when its own caller does not listen either.
        if (facade.listenerCount('warning') > 0) facade.emit('warning', warning);
        else console.warn(`[${this.inner.providerId}] ${warning.message}`);
      });
      session.on('error', (err: Error) => {
        if (closedByCaller || session !== current) return;
        void reconnect(err);
      });
      session.on('close', () => {
        if (closedByCaller || session !== current || reconnecting) return;
        if (flushed) {
          // the provider sent its last final and ended its stream, as the caller's flush asked
          finish();
          return;
        }
        void reconnect(undefined);
      });
    };

    const giveUp = (err: Error): void => {
      if (ended) return;
      ended = true;
      // the provider's session does not stay open behind a session that reports itself closed
      try {
        current.close();
      } catch {
        // already gone
      }
      facade.emit('error', err);
      facade.emit('close');
    };

    const reconnect = async (err: Error | undefined): Promise<void> => {
      if (reconnecting || closedByCaller || ended) return;
      reconnecting = true;
      const startedAt = this.clock();
      const minuteAgo = startedAt - 60_000;
      while (attempts.length && attempts[0] < minuteAgo) attempts.shift();
      if (attempts.length >= this.maxAttempts) {
        reconnecting = false;
        giveUp(err ?? new Error(`${this.inner.providerId}: session ended after ${this.maxAttempts} reconnects in a minute`));
        return;
      }
      attempts.push(startedAt);
      const attempt = attempts.length;
      try {
        current.close();
      } catch {
        // already gone
      }
      let next: StreamingSTTSession;
      try {
        next = await this.inner.startSession(config);
      } catch (startErr) {
        reconnecting = false;
        await reconnect(startErr instanceof Error ? startErr : new Error(String(startErr)));
        return;
      }
      if (closedByCaller) {
        next.close();
        reconnecting = false;
        return;
      }
      const replay = ring.snapshot();
      const bufferedMs = ring.durationMs();
      const replayedMs = bufferedMs >= this.minReplayMs ? bufferedMs : 0;
      // The new session hears the replay, then the queued frames, then live audio, so its clock 0 sits where the
      // replay starts: what was pushed before the queue, less the replay. Frames a full queue dropped count as pushed,
      // so the queued and live audio keep their place on the timeline.
      generation += 1;
      offsetMs = pushedMs - queuedMs - replayedMs;
      current = next;
      attach(next, generation, offsetMs);
      if (replayedMs > 0) for (const f of replay) next.pushAudio(f);
      for (const f of queue.splice(0)) {
        ring.push(f);
        next.pushAudio(f);
      }
      queuedMs = 0;
      reconnecting = false;
      facade.emit('stt:reconnected', { attempt, replayedMs } satisfies SttReconnectedEvent);
      facade.emit('stt:gap', { attempt, lostMs: this.clock() - startedAt } satisfies SttGapEvent);
    };

    attach(current, generation, offsetMs);

    const session = Object.assign(facade, {
      pushAudio: (frame: AudioFrame): void => {
        if (ended || closedByCaller) return;
        flushed = false;
        pushedMs += frameMs(frame);
        if (reconnecting) {
          queue.push(frame);
          queuedMs += frameMs(frame);
          while (queuedMs > this.queueCapacityMs && queue.length) {
            const old = queue.shift()!;
            queuedMs -= frameMs(old);
            dropped += 1;
          }
          return;
        }
        ring.push(frame);
        try {
          current.pushAudio(frame);
        } catch (err) {
          void reconnect(err instanceof Error ? err : new Error(String(err)));
        }
      },
      /** Drains the live session. A close the provider makes before the next frame ends the session, without a reconnect. */
      flush: async (): Promise<void> => {
        if (ended || closedByCaller) return;
        flushed = true;
        await current.flush();
      },
      /** Closes the live session and emits `close` once, from the facade itself: what the provider does after is ignored. */
      close: (): void => {
        if (closedByCaller) return;
        closedByCaller = true;
        try {
          current.close();
        } catch {
          // already gone
        }
        finish();
      },
    }) as StreamingSTTSession;
    Object.defineProperty(session, 'droppedFrames', { get: () => dropped, enumerable: true });
    return session;
  }
}
