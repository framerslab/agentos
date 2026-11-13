/**
 * @module hearing/LiveKitRoomAudioOutput
 *
 * A room's audio output for a host that already reads the room through code of
 * its own: one LiveKit audio track that the room's local participant publishes,
 * on which whole PCM16 clips play one at a time, each with its speech mark. It
 * is `LiveKitStreamTransport`'s speaking half without the transport: the same
 * `LiveKitAudioPublisher`, in native playout alone, so every participant
 * subscribed to the track hears it and nothing is asked of them. It reads
 * nothing from the room: it listens to no room event, registers no text stream
 * handler and opens no remote track.
 *
 * - {@link LiveKitRoomAudioOutput.open} publishes the track at once and
 *   resolves when a participant has subscribed to it, so a host opens it before
 *   it asks anything of its listener and the listener holds the track when the
 *   first clip comes.
 * - {@link LiveKitRoomAudioOutput.play} cuts a clip into chunks of at most the
 *   publisher's `maxDurationMs` ({@link pcmChunks}), hands them to the track in
 *   order, each carrying the clip's mark, and resolves once the track has played
 *   the last one out. Nobody subscribed within `receiptTimeoutMs` rejects it
 *   with the code {@link ROOM_AUDIO_NO_SUBSCRIBER}, before any frame.
 * - {@link LiveKitRoomAudioOutput.clear}, an aborted signal and
 *   {@link LiveKitRoomAudioOutput.close} empty the track's queue and reject the
 *   play under way. The next play hands the track nothing until that clear has
 *   finished, so nothing of a clip stopped meanwhile reaches the track.
 * - A capture the publisher gives up on retires the track: the output closes,
 *   and the play under way and every later call reject with
 *   `room audio output stalled`.
 *
 * Node only: it runs on the optional peer `@livekit/rtc-node`, loaded when the
 * track is first published, or passed in by the host.
 *
 * @example
 * ```typescript
 * import * as rtc from '@livekit/rtc-node';
 * import { LiveKitRoomAudioOutput } from '@framers/agentos/io/hearing/livekit';
 *
 * const output = new LiveKitRoomAudioOutput({
 *   room, // a connected rtc-node Room; its local participant publishes the track
 *   publisher: { sampleRate: 24_000, maxBytes: 256_000, maxDurationMs: 2_000, receiptTimeoutMs: 5_000 },
 *   rtc,
 * });
 * await output.open(); // the track is published and a participant has subscribed to it
 * const { playedMs } = await output.play({ audio, sampleRate: 24_000, mark }, signal);
 * ```
 */

import {
  LiveKitAudioPublisher,
  type LiveKitAudioPublisherOptions,
  type SpeechMark,
} from '../voice-pipeline/LiveKitAudioPublisher.js';
import type { EncodedAudioChunk } from '../voice-pipeline/types.js';
import type { LiveKitLocalParticipantLike, LiveKitRoomLike } from './LiveKitRoomAudioSource.js';

/** The code of the error a play rejects with when nobody subscribed to the track in time. */
export const ROOM_AUDIO_NO_SUBSCRIBER = 'ROOM_AUDIO_NO_SUBSCRIBER';

/** The lowest and highest rates of a clip, as the publisher reads a PCM16 chunk. */
const MIN_CLIP_RATE = 8_000;
const MAX_CLIP_RATE = 192_000;

/** A track rtc-node published (`LocalTrackPublication`): its SID, and the wait for its first subscriber. */
export interface LiveKitLocalPublicationLike {
  readonly sid?: string;
  /** Resolves once a participant has subscribed to the track (rtc-node resolves it at the first subscriber). */
  waitForSubscription?(): Promise<void>;
}

/**
 * The parts of rtc-node's `LocalParticipant` the output's publisher uses beyond {@link LiveKitLocalParticipantLike}:
 * it publishes and unpublishes the track, and sets a clip's mark on the participant's attributes.
 */
export interface LiveKitPublishingParticipantLike {
  /** rtc-node's `publishTrack(track, options)`; the track and the options are rtc-node's own. */
  publishTrack(track: any, options: any): Promise<LiveKitLocalPublicationLike>;
  unpublishTrack(trackSid: string, stopOnUnpublish?: boolean): Promise<void>;
  /** Sets the keys given and leaves the participant's other attributes; a clip with a mark needs it. */
  setAttributes?(attributes: Record<string, string>): Promise<void>;
  /** The participant's own attributes, as the room last heard them; the publisher reads a mark back through them. */
  readonly attributes?: Readonly<Record<string, string>>;
}

/**
 * The room the output speaks in: `LiveKitRoomLike`, whose local participant also publishes
 * ({@link LiveKitPublishingParticipantLike}). A connected rtc-node `Room` is one as it is.
 */
export interface LiveKitRoomAudioOutputRoomLike extends LiveKitRoomLike {
  readonly localParticipant?: LiveKitLocalParticipantLike & LiveKitPublishingParticipantLike;
}

/** What the output is built on: the room it speaks in, and the publisher's own options. */
export interface LiveKitRoomAudioOutputOptions {
  /**
   * The room, as `LiveKitRoomAudioSource` takes it (`LiveKitRoomLike`), with a local participant that publishes the
   * track ({@link LiveKitRoomAudioOutputRoomLike}).
   */
  room: LiveKitRoomAudioOutputRoomLike;
  /**
   * The publisher's options: the track's rate, `maxBytes`, `maxDurationMs` (also the longest chunk a clip is cut
   * into) and `receiptTimeoutMs` (also how long a play or an open waits for a subscriber). The output plays natively
   * and sets each chunk's mark from its clip, so `playout` and `mark` are its own.
   */
  publisher: Omit<LiveKitAudioPublisherOptions, 'playout' | 'mark'>;
  /** The `@livekit/rtc-node` module, or a structural one; `publisher.rtc` comes first, and with neither it is imported. */
  rtc?: unknown;
}

/** One whole clip: PCM16 mono at its own rate, with its mark when it is synthetic speech. */
export interface RoomAudioClip {
  audio: Buffer;
  sampleRate: number;
  mark?: SpeechMark;
}

/** What a play reports once the track has played the clip out. */
export interface RoomAudioPlayed {
  /** The clip's length: its bytes over two over its rate, in whole milliseconds. */
  playedMs: number;
}

/**
 * A PCM16 mono clip cut into chunks of at most `maxMs`, on whole samples.
 *
 * @throws {RangeError} When `maxMs` at `sampleRate` holds no whole sample.
 */
export function pcmChunks(audio: Buffer, sampleRate: number, maxMs: number): Buffer[] {
  const bytes = Math.floor((sampleRate * maxMs) / 1000) * 2;
  if (!(bytes >= 2)) throw new RangeError('pcmChunks: maxMs at sampleRate must hold at least one whole sample');
  const chunks: Buffer[] = [];
  for (let at = 0; at < audio.length; at += bytes) chunks.push(audio.subarray(at, Math.min(audio.length, at + bytes)));
  return chunks;
}

/**
 * One chunk of PCM16 mono in a WAV container of its own. The publisher refuses a raw chunk that starts with the bytes
 * of a container's header (`RIFF`, `OggS`, `ID3`), which a cut through speech can do; a WAV chunk's header is read
 * once and never played.
 */
function wavChunk(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** An error with a message and, where given, a code and a cause. */
function failure(message: string, fields: { code?: string; cause?: unknown } = {}): Error {
  return Object.assign(new Error(message), fields);
}

/** The play under way: the error that stopped it, once one did, and the promise that rejects with it. */
interface Run {
  error?: Error;
  readonly stopped: Promise<never>;
  stop(error: Error): void;
}

function startRun(): Run {
  let reject!: (error: Error) => void;
  const stopped = new Promise<never>((_resolve, fail) => {
    reject = fail;
  });
  stopped.catch(() => {});
  const run: Run = {
    stopped,
    stop: (error) => {
      if (run.error) return;
      run.error = error;
      reject(error);
    },
  };
  return run;
}

/**
 * One published track in a LiveKit room on which whole clips play, one at a time, in native playout. Every
 * participant subscribed to the track hears it. The output reads nothing from the room.
 */
export class LiveKitRoomAudioOutput {
  private readonly publisher: LiveKitAudioPublisher;
  /** Each chunk's mark, read by the publisher once, as the chunk is handed to it. */
  private readonly marks = new WeakMap<EncodedAudioChunk, SpeechMark>();
  /** Settles `true` once a participant has subscribed to the published track; `false` when it cannot tell. Unset before the track is published. */
  private subscribed?: Promise<boolean>;
  private run?: Run;
  /**
   * The last clear asked of the publisher, until it settles. A play hands the track nothing before it has: the
   * publisher shares a clear under way with a clear asked meanwhile, which would not cancel a chunk admitted behind it.
   */
  private clearing?: Promise<void>;
  private closed = false;
  /** What a call on the closed output rejects with: closed by the host, or retired by a stalled capture. */
  private closedMessage = 'room audio output closed';
  /** Rejects once the output is closed, so a wait for a subscriber ends then. */
  private readonly ended: Run = startRun();

  /**
   * @throws {Error} `livekit publishing participant required` when the room's local participant cannot publish a
   *   track, and `invalid livekit publisher bound` when a publisher option is refused (`LiveKitAudioPublisher`).
   */
  constructor(private readonly options: LiveKitRoomAudioOutputOptions) {
    const local = options.room.localParticipant;
    const participant =
      local && typeof local.publishTrack === 'function'
        ? {
            // The publication is kept, so a play and an open read whether anyone subscribed to the track.
            publishTrack: async (track: unknown, publishOptions: unknown): Promise<LiveKitLocalPublicationLike> => {
              const publication = await local.publishTrack(track, publishOptions);
              this.subscribed = Promise.resolve()
                .then(() => {
                  if (typeof publication.waitForSubscription !== 'function') return false;
                  return publication.waitForSubscription().then(() => true);
                })
                .catch(() => false);
              return publication;
            },
            unpublishTrack: (trackSid: string, stopOnUnpublish?: boolean) => local.unpublishTrack(trackSid, stopOnUnpublish),
            // Read when the publisher sets a mark, so the participant's own method and attributes are the ones used.
            get setAttributes() {
              const set = local.setAttributes;
              return typeof set === 'function' ? (attributes: Record<string, string>) => set.call(local, attributes) : undefined;
            },
            get attributes() {
              return local.attributes;
            },
          }
        : local;
    this.publisher = new LiveKitAudioPublisher(
      { ...options.publisher, playout: 'native', mark: (chunk) => this.marks.get(chunk) },
      participant,
      // Native playout sends the participant nothing.
      async () => {
        throw new Error('room audio output sends no message');
      },
      {
        rtc: options.rtc,
        // A capture that never returned leaves the track unable to take audio, and its late return would clear the
        // queue under a later clip: the output closes, as a transport closes its path.
        stalled: () => {
          void this.shut('room audio output stalled').catch(() => {});
        },
      }
    );
  }

  /** SID of the published track; `undefined` before the track is published. */
  get trackSid(): string | undefined {
    return this.publisher.trackSid;
  }

  /**
   * Publishes the track at once, if it is not published, and resolves when a participant has subscribed to it. A
   * host opens it before it asks anything of its listener, so the listener holds the track when the first clip comes.
   * A later call, after one that rejected, waits for a subscriber again; the track is published once.
   *
   * @throws {Error} With the code {@link ROOM_AUDIO_NO_SUBSCRIBER} when nobody subscribed within `receiptTimeoutMs`
   *   (counted from the track's publication for the call that publishes it, which has no deadline of its own, and
   *   from the call for a later one), or with a publication the output cannot ask (one without
   *   `waitForSubscription()`, or whose wait fails); the track stays published. `room audio output closed` once
   *   closed, `room audio output stalled` once a capture stalled. The publisher's error when the track cannot be
   *   published, which every later call gives too.
   */
  async open(): Promise<void> {
    if (this.closed) throw failure(this.closedMessage);
    await this.listener(Date.now());
  }

  /**
   * Plays one whole clip: cut into chunks of at most `maxDurationMs` ({@link pcmChunks}), handed to the track in
   * order, each carrying the clip's mark when it has one (set once, before the clip's first frame), and resolved once
   * the track has played the last one out. One play runs at a time, and it hands the track nothing until a clear
   * asked before it has finished.
   *
   * @param clip - PCM16 mono at its own rate, from 8000 to 192000 Hz; another rate than the track's is resampled
   *   chunk by chunk.
   * @param signal - Aborting it clears the track's queue and rejects the play.
   * @returns The clip's length in whole milliseconds.
   * @throws {RangeError} When the clip is not whole PCM16 at a rate from 8000 to 192000 Hz, before anything is
   *   published.
   * @throws {Error} `room audio busy` while another play runs; `room audio output closed` once closed, and
   *   `room audio output stalled` once a capture stalled, the play under way included; with the code
   *   {@link ROOM_AUDIO_NO_SUBSCRIBER} when nobody subscribed within `receiptTimeoutMs`, before any frame;
   *   `room audio cleared` after {@link clear}; `room audio aborted`, with the signal's reason as its `cause`; and the
   *   publisher's own errors (`publisher drain timeout`, `publisher mark refused`, a bound), after which what the
   *   track holds of the clip is cleared.
   */
  async play(clip: RoomAudioClip, signal?: AbortSignal): Promise<RoomAudioPlayed> {
    if (this.closed) throw failure(this.closedMessage);
    if (this.run) throw failure('room audio busy');
    const { audio, sampleRate, mark } = clip;
    if (!Buffer.isBuffer(audio) || audio.length === 0 || audio.length % 2 !== 0 || !Number.isSafeInteger(sampleRate) || sampleRate < MIN_CLIP_RATE || sampleRate > MAX_CLIP_RATE) {
      throw new RangeError('LiveKitRoomAudioOutput: a clip is whole PCM16 mono at a rate from 8000 to 192000 Hz');
    }
    if (signal?.aborted) throw failure('room audio aborted', { cause: signal.reason });
    const run = startRun();
    this.run = run;
    const abort = (): void => {
      if (this.run !== run || run.error) return;
      run.stop(failure('room audio aborted', { cause: signal?.reason }));
      void this.clearTrack().catch(() => {});
    };
    signal?.addEventListener('abort', abort, { once: true });
    // Ends the publisher's playout wait once the play has settled, whichever way.
    const done = new AbortController();
    // Whether a chunk of the clip was handed to the track, so a failure has something of it to clear.
    let handed = false;
    try {
      await this.within(run, this.listener(Date.now()));
      // A clear asked before this play, of the clip before it, finishes first.
      while (this.clearing) await this.within(run, this.clearing);
      for (const pcm of pcmChunks(audio, sampleRate, this.options.publisher.maxDurationMs)) {
        const chunk: EncodedAudioChunk = {
          audio: wavChunk(pcm, sampleRate),
          format: 'pcm',
          container: 'wav',
          sampleRate,
          durationMs: (pcm.length / 2 / sampleRate) * 1000,
          text: '',
        };
        if (mark) this.marks.set(chunk, mark);
        // A stop can land in the turn between the last wait's check and this send: it is read here, synchronously
        // before the send, so the track takes no chunk after a clear, an abort or a close.
        if (run.error) throw run.error;
        handed = true;
        await this.within(run, this.publisher.sendAudio(chunk));
      }
      await this.within(run, this.publisher.waitForPlayout(done.signal));
      return { playedMs: Math.round((audio.length / 2 / sampleRate) * 1000) };
    } catch (error) {
      if (run.error) throw run.error;
      // A play that failed part way leaves nothing of its clip on the track.
      if (handed && !this.closed) void this.clearTrack().catch(() => {});
      throw error;
    } finally {
      done.abort();
      signal?.removeEventListener('abort', abort);
      if (this.run === run) this.run = undefined;
    }
  }

  /**
   * Empties the track's queue, as the publisher's `clearPlayback()` does, and rejects the play under way with
   * `room audio cleared`; no further chunk of that play reaches the track. Resolves once the queue is empty, a frame
   * whose capture was under way cleared as it landed.
   */
  clear(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.run?.stop(failure('room audio cleared'));
    return this.clearTrack();
  }

  /**
   * Rejects the play under way and every wait for a subscriber with `room audio output closed`, then unpublishes the
   * track and closes it and its native source (the publisher's `close()`). Later calls share that work, the close the
   * output made itself on a stalled capture included.
   *
   * @throws {Error} `publisher cleanup incomplete` when the track could not be unpublished or closed.
   */
  close(): Promise<void> {
    return this.shut('room audio output closed');
  }

  /**
   * Closes the output once, with `message` for the play under way, every wait for a subscriber and every later call,
   * then closes the publisher.
   */
  private shut(message: string): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.closedMessage = message;
      const closed = failure(message);
      this.run?.stop(closed);
      this.ended.stop(closed);
    }
    return this.publisher.close();
  }

  /** Asks the publisher to clear the track, and keeps the clear until it settles ({@link clearing}). */
  private clearTrack(): Promise<void> {
    const work = this.publisher.clearPlayback();
    const settled = work.then(
      () => {},
      () => {}
    );
    this.clearing = settled;
    void settled.then(() => {
      if (this.clearing === settled) this.clearing = undefined;
    });
    return work;
  }

  /** Waits for `work` while the play runs; a clear, an abort or a close rejects the wait at once. */
  private async within<T>(run: Run, work: Promise<T>): Promise<T> {
    const value = await Promise.race([work, run.stopped]);
    if (run.error) throw run.error;
    return value;
  }

  /**
   * Publishes the track, once, through the publisher's `ready()`, which waits up to `receiptTimeoutMs` for its first
   * subscriber and goes on without one, then reads whether a participant subscribed by `started` plus
   * `receiptTimeoutMs`.
   *
   * @throws {Error} With the code {@link ROOM_AUDIO_NO_SUBSCRIBER} when nobody did.
   */
  private async listener(started: number): Promise<void> {
    await Promise.race([this.publisher.ready(), this.ended.stopped]);
    const subscribed = this.subscribed ?? Promise.resolve(false);
    const left = Math.max(0, started + this.options.publisher.receiptTimeoutMs - Date.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), left);
    });
    try {
      if (!(await Promise.race([subscribed, late, this.ended.stopped]))) {
        throw failure('nobody subscribed to the room audio track in time', { code: ROOM_AUDIO_NO_SUBSCRIBER });
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
