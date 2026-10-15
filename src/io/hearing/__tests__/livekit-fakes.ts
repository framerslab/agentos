/**
 * Fakes of the @livekit/rtc-node surface that the LiveKit modules of the
 * hearing layer and the speaking transport use: a room whose local participant
 * records the text streams it sends and the tracks it publishes, participants
 * (a phone caller among them), publications, tracks, an AudioStream backed by a
 * real web ReadableStream, and an AudioSource that records what it is given and
 * plays it out when a test says so. Tests drive frames, re-publications,
 * disconnects and playout with them; no LiveKit server is involved.
 */

import { EventEmitter } from 'node:events';
import { ReadableStream, type ReadableStreamDefaultController } from 'node:stream/web';
import { vi } from 'vitest';
import type {
  LiveKitAudioFrameLike,
  LiveKitRtcModule,
  LiveKitTextStreamHandler,
} from '../LiveKitRoomAudioSource.js';
import type { LiveKitPublishingRtc, PublishedAudioFrame } from '../../voice-pipeline/LiveKitAudioPublisher.js';

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

/** rtc-node's `ParticipantKind.STANDARD`: a person's page or app. */
export const PARTICIPANT_KIND_STANDARD = 0;
/** rtc-node's `ParticipantKind.SIP`: a phone caller LiveKit SIP brought into the room. */
export const PARTICIPANT_KIND_SIP = 3;

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

/** A remote participant: its identity, kind, attributes and track publications. */
export class FakeParticipant {
  readonly trackPublications = new Map<string, FakePublication>();
  /** As rtc-node's `Participant.kind`. */
  kind: number = PARTICIPANT_KIND_STANDARD;
  /** As rtc-node's `Participant.attributes`. */
  attributes: Record<string, string> = {};

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
 * stream handlers by topic, and a local participant whose `sendText`,
 * `publishTrack` and `unpublishTrack` are mocks.
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
    publishTrack: vi.fn(async (_track: unknown, _options: { source: number }) => ({ sid: 'TR_AGENT' })),
    unpublishTrack: vi.fn(async (_sid: string, _stopOnUnpublish?: boolean) => undefined),
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

  /**
   * A phone caller, as LiveKit SIP brings one into the room: a participant of
   * kind SIP with the `sip.` attributes every SIP participant carries.
   */
  addSipCaller(identity: string, ...publications: FakePublication[]): FakeParticipant {
    const caller = this.addParticipant(identity, ...publications);
    caller.kind = PARTICIPANT_KIND_SIP;
    caller.attributes = { 'sip.callID': 'SCL_example', 'sip.phoneNumber': '+12125550147', 'sip.callStatus': 'active' };
    return caller;
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

/**
 * rtc-node's `AudioSource`: it records the frames it is given and holds them as
 * queued until the test plays them out. As rtc-node's does, `waitForPlayout()`
 * resolves at once when nothing is queued, and `clearQueue()` drops what is
 * queued and releases the waits as well, which a caller must not count as
 * playback.
 */
export class FakeAudioSource {
  /** Every source made, in order. */
  static created: FakeAudioSource[] = [];
  /** Every frame captured, in order. */
  readonly captured: PublishedAudioFrame[] = [];
  /** How many times the queue was cleared. */
  clears = 0;
  closed = false;
  /** While set, a capture waits for it, as rtc-node's waits for room in a full queue. */
  gate?: Promise<void>;
  private playing?: { done: Promise<void>; finish: () => void };

  constructor(
    readonly sampleRate: number,
    readonly channels: number,
    readonly queueSizeMs: number
  ) {
    FakeAudioSource.created.push(this);
  }

  async captureFrame(frame: PublishedAudioFrame): Promise<void> {
    await this.gate;
    if (this.closed) throw new Error('AudioSource is closed');
    this.captured.push(frame);
    if (!this.playing) {
      let finish!: () => void;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      this.playing = { done, finish };
    }
  }

  waitForPlayout(): Promise<void> {
    return this.playing?.done ?? Promise.resolve();
  }

  /** What is queued has played out: every wait resolves. */
  playOut(): void {
    const playing = this.playing;
    this.playing = undefined;
    playing?.finish();
  }

  clearQueue(): void {
    this.clears += 1;
    this.playOut();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.playOut();
  }

  /** The samples captured, in all. */
  get capturedSamples(): number {
    return this.captured.reduce((sum, frame) => sum + frame.samplesPerChannel, 0);
  }
}

/** The samples every `FakeAudioSource` captured, in all; 0 when none was made. */
export function capturedSamples(): number {
  return FakeAudioSource.created.reduce((sum, source) => sum + source.capturedSamples, 0);
}

/**
 * A fake of the parts of `@livekit/rtc-node` the publisher uses: the
 * `FakeAudioSource`, frames, a resampler that returns one frame of the
 * converted length, a track and the publish options.
 */
export function fakePublishingRtc(): LiveKitPublishingRtc {
  class Frame implements PublishedAudioFrame {
    constructor(
      readonly data: Int16Array,
      readonly sampleRate: number,
      readonly channels: number,
      readonly samplesPerChannel: number
    ) {}
  }
  return {
    AudioSource: FakeAudioSource,
    AudioFrame: Frame,
    AudioResampler: class {
      constructor(
        private readonly input: number,
        private readonly output: number,
        _channels: number
      ) {}
      push(frame: PublishedAudioFrame): PublishedAudioFrame[] {
        const size = (frame.samplesPerChannel * this.output) / this.input;
        return [new Frame(new Int16Array(size), this.output, 1, size)];
      }
      flush(): PublishedAudioFrame[] {
        return [];
      }
      close(): void {}
    },
    LocalAudioTrack: { createAudioTrack: () => ({ close: async () => undefined }) },
    TrackPublishOptions: class {
      source = 0;
    },
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
