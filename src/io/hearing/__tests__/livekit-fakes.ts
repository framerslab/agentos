/**
 * Fakes of the @livekit/rtc-node surface that the LiveKit modules of the
 * hearing layer use: a room whose local participant records the text streams
 * it sends, participants, publications, tracks, and an AudioStream backed by a
 * real web ReadableStream. Tests drive frames, re-publications and disconnects
 * with them; no LiveKit server is involved.
 */

import { EventEmitter } from 'node:events';
import { ReadableStream, type ReadableStreamDefaultController } from 'node:stream/web';
import { vi } from 'vitest';
import type {
  LiveKitAudioFrameLike,
  LiveKitRtcModule,
  LiveKitTextStreamHandler,
} from '../LiveKitRoomAudioSource.js';

/** rtc-node's `TrackKind.KIND_AUDIO`. */
export const KIND_AUDIO = 1;
/** rtc-node's `TrackKind.KIND_VIDEO`. */
export const KIND_VIDEO = 2;

/** rtc-node's `TrackSource.SOURCE_CAMERA`. */
export const SOURCE_CAMERA = 1;
/** rtc-node's `TrackSource.SOURCE_MICROPHONE`. */
export const SOURCE_MICROPHONE = 2;
/** rtc-node's `TrackSource.SOURCE_SCREENSHARE_AUDIO`. */
export const SOURCE_SCREENSHARE_AUDIO = 4;

/** A remote track, known by its SID. */
export class FakeTrack {
  constructor(readonly sid: string) {}
}

/** A publication: a microphone unless a kind or source says otherwise (a video one is a camera). */
export class FakePublication {
  constructor(
    public track: FakeTrack | undefined,
    readonly kind: number = KIND_AUDIO,
    readonly source: number = kind === KIND_AUDIO ? SOURCE_MICROPHONE : SOURCE_CAMERA
  ) {}
}

/** A remote participant: its identity and its track publications. */
export class FakeParticipant {
  readonly trackPublications = new Map<string, FakePublication>();

  constructor(readonly identity: string) {}
}

/** rtc-node's `AudioStream`: a stream of frames the test pushes and ends. */
export class FakeAudioStream {
  /** Every stream opened, in order. */
  static opened: FakeAudioStream[] = [];
  cancelled = false;
  private controller!: ReadableStreamDefaultController<LiveKitAudioFrameLike>;
  private readonly stream: ReadableStream<LiveKitAudioFrameLike>;

  constructor(
    readonly track: FakeTrack,
    readonly options: { sampleRate?: number; numChannels?: number; frameSizeMs?: number }
  ) {
    this.stream = new ReadableStream<LiveKitAudioFrameLike>({
      start: (controller) => {
        this.controller = controller;
      },
      cancel: () => {
        this.cancelled = true;
      },
    });
    FakeAudioStream.opened.push(this);
  }

  getReader() {
    return this.stream.getReader();
  }

  push(frame: LiveKitAudioFrameLike): void {
    this.controller.enqueue(frame);
  }

  /** The stream ends, as rtc-node's does when its track goes away. */
  end(): void {
    try {
      this.controller.close();
    } catch {
      // Already closed or cancelled.
    }
  }
}

/**
 * An rtc-node room: its remote participants and their publications, the text
 * stream handlers by topic, and a local participant whose `sendText` is a mock.
 */
export class FakeRoom extends EventEmitter {
  /**
   * As rtc-node's `Room.isConnected`; a test sets it to `false` for a room that
   * disconnected before the source listened.
   */
  isConnected = true;
  readonly remoteParticipants = new Map<string, FakeParticipant>();
  readonly textHandlers = new Map<string, LiveKitTextStreamHandler>();
  readonly localParticipant = {
    identity: 'agent',
    sendText: vi.fn(async (_text: string, _options?: unknown) => ({})),
  };

  /** As rtc-node's room does, one handler per topic. */
  registerTextStreamHandler(topic: string, handler: LiveKitTextStreamHandler): void {
    if (this.textHandlers.has(topic)) {
      throw new Error(`A text stream handler for topic "${topic}" has already been set.`);
    }
    this.textHandlers.set(topic, handler);
  }

  unregisterTextStreamHandler(topic: string): void {
    this.textHandlers.delete(topic);
  }

  /** A participant with one publication per given publication. */
  addParticipant(identity: string, ...publications: FakePublication[]): FakeParticipant {
    const participant = new FakeParticipant(identity);
    publications.forEach((publication, i) => participant.trackPublications.set(`PUB_${i}`, publication));
    this.remoteParticipants.set(identity, participant);
    return participant;
  }

  /** What rtc-node does on a subscription: the publication holds the track, then `trackSubscribed`. */
  subscribe(participant: FakeParticipant, publication: FakePublication, track: FakeTrack): void {
    publication.track = track;
    this.emit('trackSubscribed', track, publication, participant);
  }

  /** What rtc-node does on an unsubscription: the publication lets go and the track's streams end. */
  unsubscribe(participant: FakeParticipant, publication: FakePublication): void {
    const track = publication.track;
    publication.track = undefined;
    this.emit('trackUnsubscribed', track, publication, participant);
    for (const stream of FakeAudioStream.opened) {
      if (stream.track === track) stream.end();
    }
  }
}

/** A fake of the parts of the `@livekit/rtc-node` module the library uses. */
export function fakeRtc(): LiveKitRtcModule {
  return {
    AudioStream: FakeAudioStream,
    RoomEvent: { TrackSubscribed: 'trackSubscribed', Disconnected: 'disconnected' },
    TrackKind: { KIND_AUDIO },
    TrackSource: { SOURCE_MICROPHONE },
  };
}

/** An rtc-node audio frame of interleaved Int16 samples. */
export function rtcFrame(values: number[], sampleRate = 24_000, channels = 1): LiveKitAudioFrameLike {
  return {
    data: Int16Array.from(values),
    sampleRate,
    channels,
    samplesPerChannel: values.length / channels,
  };
}

/** Lets pending promise continuations run. */
export async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}
