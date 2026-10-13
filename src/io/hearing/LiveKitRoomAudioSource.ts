/**
 * @module hearing/LiveKitRoomAudioSource
 *
 * Reads one participant's microphone in a LiveKit room as the voice
 * pipeline's {@link AudioFrame}s, for a streaming STT session or any other
 * consumer of PCM. Node only: it runs on `@livekit/rtc-node`, an optional
 * peer dependency loaded on first use, or passed in by the host.
 *
 * - Opens rtc-node's `AudioStream` on the participant's microphone (the audio
 *   publication whose source is the microphone; a screen share's audio is
 *   passed over) at the requested sample rate and one channel, so LiveKit
 *   resamples and mixes down.
 * - Converts each frame's Int16 samples to Float32 in [-1, 1].
 * - Follows the participant: when the track is unpublished and a new one is
 *   published (a reconnect), reading moves to the new track.
 * - Ends when {@link LiveKitRoomAudioSource.close} is called or the room
 *   disconnects, a room already disconnected at the first read included.
 * - Closes itself when a read fails (the peer missing, a stream that does not
 *   open), before that read rejects.
 *
 * The rtc-node objects are described by the structural types below, so this
 * module and its typings carry no dependency on `@livekit/rtc-node` itself.
 *
 * @example
 * ```typescript
 * const source = new LiveKitRoomAudioSource({
 *   room,
 *   participantIdentity: 'user-1',
 *   sampleRate: 24_000,
 * });
 * for await (const frame of source) sttSession.pushAudio(frame);
 * ```
 */

import type { AudioFrame } from '../voice-pipeline/types.js';

/** The optional peer this module runs on. */
const RTC_NODE = '@livekit/rtc-node';

/** The largest sample rate: rtc-node passes the rate to its native stream as a 32-bit unsigned integer. */
const MAX_SAMPLE_RATE = 2 ** 32 - 1;

// ---------------------------------------------------------------------------
// The parts of @livekit/rtc-node this module uses
// ---------------------------------------------------------------------------

/** An audio frame as rtc-node's `AudioFrame` carries it: interleaved Int16 samples. */
export interface LiveKitAudioFrameLike {
  data: Int16Array;
  sampleRate: number;
  channels: number;
  samplesPerChannel: number;
}

/** The reader of an rtc-node `AudioStream` (a web `ReadableStreamDefaultReader`). */
export interface LiveKitAudioStreamReaderLike {
  read(): Promise<{ done: boolean; value?: LiveKitAudioFrameLike }>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
}

/** An rtc-node `AudioStream` (a web `ReadableStream` of frames). */
export interface LiveKitAudioStreamLike {
  getReader(): LiveKitAudioStreamReaderLike;
}

/** A remote track (rtc-node `RemoteAudioTrack`). */
export interface LiveKitTrackLike {
  readonly sid?: string;
}

/** A track publication (rtc-node `RemoteTrackPublication`). */
export interface LiveKitTrackPublicationLike {
  readonly kind?: number;
  readonly source?: number;
  readonly track?: LiveKitTrackLike;
}

/** A remote participant (rtc-node `RemoteParticipant`). */
export interface LiveKitParticipantLike {
  readonly identity: string;
  readonly trackPublications: ReadonlyMap<string, LiveKitTrackPublicationLike>;
}

/** A text stream reader (rtc-node `TextStreamReader`). */
export interface LiveKitTextStreamReaderLike {
  readAll(): Promise<string>;
  /**
   * Stops the stream and releases what the reader holds (rtc-node's
   * `close()`); a `readAll()` in progress then ends.
   */
  close?(): Promise<void>;
  /** Native rtc-node text chunks; strict call transports require this bounded-read path. */
  [Symbol.asyncIterator]?(): AsyncIterator<string>;
}

/** A text stream handler as rtc-node's `Room.registerTextStreamHandler` takes it. */
export type LiveKitTextStreamHandler = (
  reader: LiveKitTextStreamReaderLike,
  participant: { identity: string }
) => void;

/** Options of rtc-node's `LocalParticipant.sendText` that this library sets. */
export interface LiveKitSendTextOptions {
  topic?: string;
  attributes?: Record<string, string>;
  destinationIdentities?: string[];
}

/** The local participant (rtc-node `LocalParticipant`). */
export interface LiveKitLocalParticipantLike {
  readonly identity: string;
  sendText(text: string, options?: LiveKitSendTextOptions): Promise<unknown>;
}

/** A connected room (rtc-node `Room`). */
export interface LiveKitRoomLike {
  /** `false` before the room connects and once it disconnected (rtc-node `Room.isConnected`). */
  readonly isConnected: boolean;
  readonly remoteParticipants: ReadonlyMap<string, LiveKitParticipantLike>;
  readonly localParticipant?: LiveKitLocalParticipantLike;
  on(event: any, listener: any): unknown;
  off(event: any, listener: any): unknown;
  registerTextStreamHandler(topic: string, handler: LiveKitTextStreamHandler): void;
  unregisterTextStreamHandler(topic: string): void;
}

/** The parts of the `@livekit/rtc-node` module this library uses. */
export interface LiveKitRtcModule {
  AudioStream: new (
    track: any,
    options: { sampleRate?: number; numChannels?: number; frameSizeMs?: number }
  ) => LiveKitAudioStreamLike;
  RoomEvent: { readonly TrackSubscribed: string; readonly Disconnected: string };
  TrackKind: { readonly KIND_AUDIO: number };
  TrackSource: { readonly SOURCE_MICROPHONE: number };
}

/**
 * Loads `@livekit/rtc-node`, the optional peer the LiveKit room audio source
 * and transport run on.
 *
 * @param importer - How to import a module; the default is a dynamic `import()`.
 * @returns The module.
 * @throws {Error} Naming the package and how to install it when the import
 *   fails; the import's own error is its `cause`.
 */
export async function loadLiveKitRtc(
  importer: (specifier: string) => Promise<unknown> = (specifier) => import(/* @vite-ignore */ specifier)
): Promise<LiveKitRtcModule> {
  try {
    return (await importer(RTC_NODE)) as LiveKitRtcModule;
  } catch (err) {
    throw Object.assign(
      new Error(
        `${RTC_NODE} is required for the LiveKit room audio source and transport. Install it: npm install ${RTC_NODE}`
      ),
      { cause: err }
    );
  }
}

// ---------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------

/** Options of {@link LiveKitRoomAudioSource}. */
export interface LiveKitRoomAudioSourceOptions {
  /**
   * A connected room (rtc-node `Room`). A room that is not connected when the
   * source is first read ends the source at once.
   */
  room: LiveKitRoomLike;
  /** Identity of the participant whose audio is read. */
  participantIdentity: string;
  /**
   * Sample rate of the frames yielded, a whole number of samples per second;
   * LiveKit resamples to it. Match the consumer: 24000 for OpenAI Realtime
   * transcription, 16000 for Deepgram.
   */
  sampleRate: number;
  /**
   * Length of each frame in milliseconds, a whole number that holds at least
   * one sample at `sampleRate`; rtc-node's default when omitted.
   */
  frameSizeMs?: number;
  /**
   * The `@livekit/rtc-node` module the host imports, so one copy of it serves
   * both; this module imports it on first use when omitted.
   */
  rtc?: LiveKitRtcModule;
  /** Call-profile boundary: the native stream must return the requested mono rate without another conversion stage. */
  strictMono?: boolean;
}

/** Whether a publication is the participant's microphone: audio, published with the microphone source. */
function isMicrophone(publication: LiveKitTrackPublicationLike, rtc: LiveKitRtcModule): boolean {
  return (
    publication.kind === rtc.TrackKind.KIND_AUDIO && publication.source === rtc.TrackSource.SOURCE_MICROPHONE
  );
}

/**
 * One participant's microphone in a LiveKit room as an async iterable of
 * {@link AudioFrame}s (mono Float32 at the requested sample rate), following
 * the participant across re-published tracks. A source has one reader.
 */
export class LiveKitRoomAudioSource implements AsyncIterable<AudioFrame> {
  private rtc: LiveKitRtcModule | undefined;
  private reader: LiveKitAudioStreamReaderLike | undefined;
  private readingTrack: LiveKitTrackLike | undefined;
  /** The track whose stream ended last; it is not reopened unless subscribed again. */
  private endedTrack: LiveKitTrackLike | undefined;
  private nextTimestamp = 0;
  private isClosed = false;
  private started = false;
  private listening = false;
  private closing: Promise<void> | undefined;
  /** The reads waiting for a track; a subscription or the end wakes every one of them. */
  private readonly waiters = new Set<() => void>();

  /**
   * @throws {RangeError} When `sampleRate` is not a whole number of samples
   *   per second from 1 to 4294967295 (rtc-node passes the rate to its native
   *   stream as a 32-bit unsigned integer), or when `frameSizeMs` is not a
   *   whole number of milliseconds that holds at least one sample at
   *   `sampleRate`.
   */
  constructor(private readonly options: LiveKitRoomAudioSourceOptions) {
    const { sampleRate, frameSizeMs } = options;
    if (!(Number.isInteger(sampleRate) && sampleRate > 0 && sampleRate <= MAX_SAMPLE_RATE)) {
      throw new RangeError(
        'LiveKitRoomAudioSource: sampleRate must be a whole number of samples per second, from 1 to 4294967295'
      );
    }
    // rtc-node's native stream cuts frames of sampleRate * frameSizeMs / 1000
    // samples, rounded down, and a frame of no samples never ends that loop.
    if (
      frameSizeMs !== undefined &&
      !(Number.isInteger(frameSizeMs) && frameSizeMs > 0 && sampleRate * frameSizeMs >= 1000)
    ) {
      throw new RangeError(
        'LiveKitRoomAudioSource: frameSizeMs must be a whole number of milliseconds that holds at least one sample at sampleRate'
      );
    }
    this.rtc = options.rtc;
  }

  /** SID of the track being read, or `undefined` between tracks. */
  get trackSid(): string | undefined {
    return this.readingTrack?.sid;
  }

  /** `true` once {@link close} was called or the room disconnected. */
  get closed(): boolean {
    return this.isClosed;
  }

  /**
   * The source's frames, for its one reader. Leaving a `for await` loop early
   * (the iterator's `return()`) closes the source. Calls of `next()` that
   * overlap each settle, with a frame of their own or, once it ends, done.
   * A `next()` that rejects closes the source first, since a `for await` loop
   * calls no `return()` when `next()` rejects.
   *
   * @throws {Error} When called a second time: two readers would split one
   *   stream's frames between them.
   */
  [Symbol.asyncIterator](): AsyncIterator<AudioFrame> {
    if (this.started) {
      throw new Error('LiveKitRoomAudioSource: a source has one reader; iterate it once');
    }
    this.started = true;
    return {
      next: () => this.next(),
      return: async () => {
        this.close();
        return { done: true, value: undefined };
      },
    };
  }

  /** Stops accepting frames synchronously; cancellation acknowledgement remains observable. */
  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    if (this.rtc && this.listening) {
      this.options.room.off(this.rtc.RoomEvent.TrackSubscribed, this.onTrackSubscribed);
      this.options.room.off(this.rtc.RoomEvent.Disconnected, this.onDisconnected);
    }
    const reader = this.reader; this.reader = undefined; this.readingTrack = undefined;
    this.closing = Promise.resolve().then(() => reader?.cancel()).then(() => {});
    void this.closing.catch(() => {});
    this.wakeUp();
  }
  /** Resolves only when the native input reader acknowledges cancellation. */
  whenClosed(): Promise<void> { return this.closing ?? Promise.reject(new Error('audio source still open')); }

  /** The next frame; a read that fails closes the source, then rejects. */
  private async next(): Promise<IteratorResult<AudioFrame>> {
    try {
      return await this.readFrame();
    } catch (err) {
      // A for-await loop calls no return() after a rejection, so the room's listeners go here.
      this.close();
      throw err;
    }
  }

  private async readFrame(): Promise<IteratorResult<AudioFrame>> {
    const rtc = await this.ready();
    for (;;) {
      if (this.isClosed || !rtc) return { done: true, value: undefined };
      const reader = this.reader ?? this.openSubscribedTrack(rtc);
      if (!reader) {
        await this.waitForTrack();
        continue;
      }
      const result = await reader.read();
      if (this.isClosed) return { done: true, value: undefined };
      if (result.done || !result.value) {
        // The track went away (unpublished, unsubscribed or ended): wait for its successor.
        this.detach(reader);
        continue;
      }
      return { done: false, value: this.toFrame(result.value) };
    }
  }

  /** Loads rtc-node when needed and starts listening to the room, once. */
  private async ready(): Promise<LiveKitRtcModule | undefined> {
    if (this.isClosed) return undefined;
    if (!this.rtc) this.rtc = await loadLiveKitRtc();
    if (!this.listening && !this.isClosed) {
      this.listening = true;
      this.options.room.on(this.rtc.RoomEvent.TrackSubscribed, this.onTrackSubscribed);
      this.options.room.on(this.rtc.RoomEvent.Disconnected, this.onDisconnected);
      // The room emits 'disconnected' once: a disconnect before these listeners
      // existed (before the first read, or during the import) is read here.
      if (!this.options.room.isConnected) this.close();
    }
    return this.rtc;
  }

  /** Opens an `AudioStream` on the participant's subscribed microphone track, when there is one. */
  private openSubscribedTrack(rtc: LiveKitRtcModule): LiveKitAudioStreamReaderLike | undefined {
    const participant = this.options.room.remoteParticipants.get(this.options.participantIdentity);
    if (!participant) return undefined;
    for (const publication of participant.trackPublications.values()) {
      const track = publication.track;
      if (!isMicrophone(publication, rtc) || !track || track === this.endedTrack) continue;
      const stream = new rtc.AudioStream(track, {
        sampleRate: this.options.sampleRate,
        numChannels: 1,
        ...(this.options.frameSizeMs !== undefined ? { frameSizeMs: this.options.frameSizeMs } : {}),
      });
      this.reader = stream.getReader();
      this.readingTrack = track;
      return this.reader;
    }
    return undefined;
  }

  private detach(reader: LiveKitAudioStreamReaderLike): void {
    if (this.reader !== reader) return;
    this.endedTrack = this.readingTrack;
    this.reader = undefined;
    this.readingTrack = undefined;
    try {
      reader.releaseLock();
    } catch {
      // A reader of a finished stream may refuse to release; nothing is held.
    }
  }

  private waitForTrack(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waiters.add(resolve);
    });
  }

  /** Wakes every read waiting for a track: each looks for one again, or ends once the source is closed. */
  private wakeUp(): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const wake of waiters) wake();
  }

  private readonly onTrackSubscribed = (
    track: LiveKitTrackLike,
    publication: LiveKitTrackPublicationLike,
    participant: LiveKitParticipantLike
  ): void => {
    if (participant.identity !== this.options.participantIdentity) return;
    if (!this.rtc || !isMicrophone(publication, this.rtc)) return;
    if (track === this.endedTrack) this.endedTrack = undefined;
    this.wakeUp();
  };

  private readonly onDisconnected = (): void => {
    this.close();
  };

  /** Int16 to Float32 in [-1, 1], mixed down to one channel, on a clock that only moves forward. */
  private toFrame(frame: LiveKitAudioFrameLike): AudioFrame {
    if (this.options.strictMono && (frame.channels !== 1 || frame.sampleRate !== this.options.sampleRate || !Number.isSafeInteger(frame.samplesPerChannel) || frame.samplesPerChannel < 1 || frame.data.length !== frame.samplesPerChannel)) throw new Error('livekit input format refused');
    const channels = Math.max(1, frame.channels);
    const count = frame.samplesPerChannel;
    const samples = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) sum += frame.data[i * channels + c];
      samples[i] = sum / channels / 32768;
    }
    const timestamp = Math.max(Date.now(), this.nextTimestamp);
    this.nextTimestamp = timestamp + (count / frame.sampleRate) * 1000;
    return {
      samples,
      sampleRate: frame.sampleRate,
      timestamp,
      speakerHint: this.options.participantIdentity,
    };
  }
}
