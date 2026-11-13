import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Rtc from '@livekit/rtc-node';
import { LIVEKIT_SPEECH_MARK_ATTRIBUTES, LiveKitAudioPublisher, type SpeechMark } from '../../voice-pipeline/LiveKitAudioPublisher.js';
import {
  LiveKitRoomAudioOutput,
  ROOM_AUDIO_NO_SUBSCRIBER,
  pcmChunks,
  type LiveKitRoomAudioOutputOptions,
  type LiveKitRoomAudioOutputRoomLike,
} from '../LiveKitRoomAudioOutput.js';
import {
  FakeAudioSource,
  FakeAudioStream,
  FakePublication,
  FakeRoom,
  FakeTrack,
  capturedSamples,
  fakePublishingRtc,
  settle,
} from './livekit-fakes.js';

// A real @livekit/rtc-node Room, its local participant publishing and marking, fits the room the output takes, so a
// host passes it as it is.
type Expect<T extends true> = T;
type RoomFits = Expect<Rtc.Room extends LiveKitRoomAudioOutputRoomLike ? true : false>;
const conformance: [RoomFits] = [true];

/** The clip's rate and the track's: 24,000 samples a second, so no chunk is resampled. */
const RATE = 24_000;

/**
 * A PCM16 mono clip of `ms` milliseconds at `rate`, each sample holding the number of the two-second block it falls in
 * (1, 2, 3, ...), so a captured frame tells which part of the clip it came from.
 */
function clip(ms: number, rate = RATE): Buffer {
  const samples = (rate * ms) / 1000;
  const audio = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) audio.writeInt16LE(1 + Math.floor(i / (rate * 2)), i * 2);
  return audio;
}

/** An output on `room`, publishing at 24,000 Hz, chunks of at most 2,000 ms, on the structural rtc. */
function outputOn(room: FakeRoom, publisher: Partial<LiveKitRoomAudioOutputOptions['publisher']> = {}): LiveKitRoomAudioOutput {
  return new LiveKitRoomAudioOutput({
    room,
    publisher: { sampleRate: RATE, maxBytes: 256_000, maxDurationMs: 2_000, receiptTimeoutMs: 1_000, ...publisher },
    rtc: fakePublishingRtc(),
  });
}

/** The one native source the output's track was built on. */
const source = (): FakeAudioSource => FakeAudioSource.created[0]!;

/** Each frame the track took: its samples and the block of the clip its first sample came from. */
const frames = (): Array<[number, number]> => source().captured.map((frame) => [frame.samplesPerChannel, frame.data[0]!]);

/** Lets the output's work run until `done()` holds, or gives up after `rounds` turns of the event loop. */
async function until(done: () => boolean, rounds = 200): Promise<void> {
  for (let i = 0; i < rounds && !done(); i++) await settle(1);
}

/** How many waits the output holds in its lists, read from every set among its own fields, whatever their names. */
const heldWaits = (output: LiveKitRoomAudioOutput): number =>
  Object.values(output).reduce((sum: number, value: unknown) => sum + (value instanceof Set ? value.size : 0), 0);

/** A subscription a test grants when it chooses, as rtc-node resolves `waitForSubscription()` at the first subscriber. */
function heldSubscription(room: FakeRoom): () => void {
  let subscribe!: () => void;
  room.subscription = new Promise<void>((resolve) => {
    subscribe = resolve;
  });
  return subscribe;
}

const mark: SpeechMark = { provider: 'voice-maker', model: 'voice-model-a', madeAt: '2026-11-13T10:00:00.000Z', clipId: 'clip-a' };

describe('LiveKitRoomAudioOutput', () => {
  beforeEach(() => {
    FakeAudioSource.created.length = 0;
    FakeAudioStream.opened.length = 0;
  });

  it('sends a 5,000 ms clip as chunks of 2,000, 2,000 and 1,000 ms, in order, and resolves once the last has played out', async () => {
    const room = new FakeRoom();
    const output = outputOn(room);
    let played = false;
    const playing = output.play({ audio: clip(5_000), sampleRate: RATE }).then((result) => {
      played = true;
      return result;
    });
    await until(() => FakeAudioSource.created.length > 0 && source().captured.length === 3);
    expect(frames()).toEqual([
      [48_000, 1],
      [48_000, 2],
      [24_000, 3],
    ]);
    await settle();
    expect(played).toBe(false);
    source().playOut();
    await expect(playing).resolves.toEqual({ playedMs: 5_000 });
    await output.close();
  });

  it("cuts a clip short enough that a chunk's bytes and the bytes it is resampled to fit maxBytes", async () => {
    const room = new FakeRoom();
    // 2,000 ms at 48,000 Hz is 192,000 bytes, and 96,000 more resampled to the track's 24,000 Hz: one chunk of it
    // passes maxBytes 144,000. Two chunks of 1,000 ms, 96,000 and 48,000 bytes each, fit it exactly.
    const output = outputOn(room, { maxBytes: 144_000 });
    const playing = output.play({ audio: clip(2_000, 48_000), sampleRate: 48_000 });
    playing.catch(() => {});
    await until(() => FakeAudioSource.created.length > 0 && source().captured.length === 2);
    expect(source().captured.map((frame) => frame.samplesPerChannel)).toEqual([24_000, 24_000]);
    source().playOut();
    await expect(playing).resolves.toEqual({ playedMs: 2_000 });
    await output.close();
  });

  it('empties the queue when cleared during a play, and rejects that play', async () => {
    const room = new FakeRoom();
    const output = outputOn(room);
    await output.open();
    let release!: () => void;
    source().gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const playing = output.play({ audio: clip(5_000), sampleRate: RATE });
    playing.catch(() => {});
    await settle();
    const clearsBefore = source().clears;
    const cleared = output.clear();
    release();
    source().gate = undefined;
    await cleared;
    await expect(playing).rejects.toThrow('room audio cleared');
    await settle();
    // The first chunk was on its way to the track and is cleared as it lands; the second and third are never sent.
    expect(source().clears - clearsBefore).toBeGreaterThanOrEqual(2);
    expect(source().captured.length).toBeLessThanOrEqual(1);
    await output.close();
  });

  it(`rejects a play with ${ROOM_AUDIO_NO_SUBSCRIBER} when nobody subscribed within receiptTimeoutMs, and captures no frame`, async () => {
    const room = new FakeRoom();
    room.subscription = new Promise<void>(() => {});
    const output = outputOn(room, { receiptTimeoutMs: 50 });
    const refused = output.play({ audio: clip(1_000), sampleRate: RATE });
    await expect(refused).rejects.toMatchObject({ code: ROOM_AUDIO_NO_SUBSCRIBER });
    expect(capturedSamples()).toBe(0);
    await output.close();
  });

  it('clears and rejects when the play is aborted, and publishes nothing for a signal aborted before the play', async () => {
    const before = new AbortController();
    before.abort();
    const quiet = new FakeRoom();
    const unopened = outputOn(quiet);
    await expect(unopened.play({ audio: clip(1_000), sampleRate: RATE }, before.signal)).rejects.toThrow('room audio aborted');
    expect(quiet.localParticipant.publishTrack).not.toHaveBeenCalled();

    const room = new FakeRoom();
    const output = outputOn(room);
    const controller = new AbortController();
    const playing = output.play({ audio: clip(5_000), sampleRate: RATE }, controller.signal);
    playing.catch(() => {});
    await until(() => FakeAudioSource.created.length > 0 && source().captured.length === 3);
    const clearsBefore = source().clears;
    controller.abort();
    await expect(playing).rejects.toThrow('room audio aborted');
    expect(source().clears).toBeGreaterThan(clearsBefore);
    await output.close();
  });

  it("sets a clip's mark before its first frame and once for all its chunks; a clip without one sets nothing", async () => {
    const room = new FakeRoom();
    const order: string[] = [];
    const setAttributes = vi.fn(async (_attributes: Record<string, string>) => {
      order.push(`mark after ${capturedSamples()} samples`);
    });
    Object.assign(room.localParticipant, { setAttributes });
    const output = outputOn(room);
    const playing = output.play({ audio: clip(5_000), sampleRate: RATE, mark });
    await until(() => FakeAudioSource.created.length > 0 && source().captured.length === 3);
    source().playOut();
    await expect(playing).resolves.toEqual({ playedMs: 5_000 });
    expect(order).toEqual(['mark after 0 samples']);
    expect(setAttributes).toHaveBeenCalledTimes(1);
    expect(setAttributes).toHaveBeenCalledWith({
      [LIVEKIT_SPEECH_MARK_ATTRIBUTES.aiGenerated]: 'true',
      [LIVEKIT_SPEECH_MARK_ATTRIBUTES.provider]: 'voice-maker',
      [LIVEKIT_SPEECH_MARK_ATTRIBUTES.model]: 'voice-model-a',
      [LIVEKIT_SPEECH_MARK_ATTRIBUTES.madeAt]: '2026-11-13T10:00:00.000Z',
      [LIVEKIT_SPEECH_MARK_ATTRIBUTES.clipId]: 'clip-a',
      [LIVEKIT_SPEECH_MARK_ATTRIBUTES.trackSid]: 'TR_AGENT',
    });

    const unmarked = output.play({ audio: clip(1_000), sampleRate: RATE });
    await until(() => source().captured.length === 4);
    source().playOut();
    await expect(unmarked).resolves.toEqual({ playedMs: 1_000 });
    expect(setAttributes).toHaveBeenCalledTimes(1);
    await output.close();
  });

  it('subscribes to nothing in the room, registers no text stream handler and reads no remote track', async () => {
    const room = new FakeRoom();
    room.addParticipant('person-1', new FakePublication(new FakeTrack('TR_PERSON_MIC')));
    const output = outputOn(room);
    await output.open();
    const playing = output.play({ audio: clip(1_000), sampleRate: RATE });
    await until(() => source().captured.length === 1);
    source().playOut();
    await playing;
    await output.close();
    expect(room.eventNames()).toEqual([]);
    expect(room.textHandlers.size).toBe(0);
    expect(FakeAudioStream.opened).toHaveLength(0);
    expect(room.localParticipant.sendText).not.toHaveBeenCalled();
  });

  it('unpublishes the track on close, rejects the play under way, and refuses a play after it', async () => {
    const room = new FakeRoom();
    const output = outputOn(room);
    await output.open();
    const playing = output.play({ audio: clip(1_000), sampleRate: RATE });
    playing.catch(() => {});
    await until(() => source().captured.length === 1);
    await output.close();
    await expect(playing).rejects.toThrow('room audio output closed');
    expect(room.localParticipant.unpublishTrack).toHaveBeenCalledWith('TR_AGENT', false);
    expect(source().closed).toBe(true);
    await expect(output.play({ audio: clip(1_000), sampleRate: RATE })).rejects.toThrow('room audio output closed');
    await expect(output.open()).rejects.toThrow('room audio output closed');
  });

  it('reads no track SID before the track is published, and the published SID after', async () => {
    const room = new FakeRoom();
    const output = outputOn(room);
    expect(output.trackSid).toBeUndefined();
    await output.open();
    expect(output.trackSid).toBe('TR_AGENT');
    await output.close();
  });

  it('publishes the track at open and resolves once a participant subscribed; a play after it publishes nothing again', async () => {
    const room = new FakeRoom();
    const subscribe = heldSubscription(room);
    const output = outputOn(room);
    let opened = false;
    const opening = output.open().then(() => {
      opened = true;
    });
    await settle();
    expect(room.localParticipant.publishTrack).toHaveBeenCalledTimes(1);
    expect(output.trackSid).toBe('TR_AGENT');
    expect(capturedSamples()).toBe(0);
    expect(opened).toBe(false);
    subscribe();
    await opening;
    const playing = output.play({ audio: clip(1_000), sampleRate: RATE });
    await until(() => source().captured.length === 1);
    source().playOut();
    await expect(playing).resolves.toEqual({ playedMs: 1_000 });
    expect(room.localParticipant.publishTrack).toHaveBeenCalledTimes(1);
    await output.close();
  });

  it(`rejects open with ${ROOM_AUDIO_NO_SUBSCRIBER} when nobody subscribed in time, and opens on a later call once someone has`, async () => {
    const room = new FakeRoom();
    const subscribe = heldSubscription(room);
    const output = outputOn(room, { receiptTimeoutMs: 50 });
    await expect(output.open()).rejects.toMatchObject({ code: ROOM_AUDIO_NO_SUBSCRIBER });
    // The track stays published, so a page can still subscribe to it.
    expect(output.trackSid).toBe('TR_AGENT');
    expect(room.localParticipant.unpublishTrack).not.toHaveBeenCalled();
    subscribe();
    await expect(output.open()).resolves.toBeUndefined();
    expect(room.localParticipant.publishTrack).toHaveBeenCalledTimes(1);
    await output.close();
  });

  it('rejects an open still waiting for a subscriber at close, while the track is published and after', async () => {
    // While the track is published: the publisher's own wait for a first subscriber is under way.
    const publishing = new FakeRoom();
    heldSubscription(publishing);
    const first = outputOn(publishing, { receiptTimeoutMs: 10_000 });
    const opening = first.open();
    opening.catch(() => {});
    await settle();
    await first.close();
    await expect(opening).rejects.toThrow('room audio output closed');
    // After it: the track is published and an earlier open gave up; a later open waits receiptTimeoutMs of its own.
    const published = new FakeRoom();
    heldSubscription(published);
    const second = outputOn(published, { receiptTimeoutMs: 200 });
    await expect(second.open()).rejects.toMatchObject({ code: ROOM_AUDIO_NO_SUBSCRIBER });
    const reopening = second.open();
    reopening.catch(() => {});
    await settle();
    await second.close();
    await expect(reopening).rejects.toThrow('room audio output closed');
  });

  it('keeps no wait of a play stopped while the track is still being published, and asks the publisher once', async () => {
    const room = new FakeRoom();
    let publish!: () => void;
    const held = new Promise<void>((resolve) => {
      publish = resolve;
    });
    room.localParticipant.publishTrack.mockImplementationOnce(async () => {
      await held;
      return { sid: 'TR_AGENT', waitForSubscription: () => room.subscription };
    });
    const ready = vi.spyOn(LiveKitAudioPublisher.prototype, 'ready');
    try {
      const output = outputOn(room);
      // Twenty plays asked and stopped while the publication hangs, by a clear and by an abort in turn.
      for (let i = 0; i < 20; i++) {
        const controller = new AbortController();
        const playing = output.play({ audio: clip(1_000), sampleRate: RATE }, controller.signal);
        playing.catch(() => {});
        await settle(1);
        if (i % 2 === 0) void output.clear();
        else controller.abort();
        await expect(playing).rejects.toThrow(i % 2 === 0 ? 'room audio cleared' : 'room audio aborted');
      }
      // No stopped play waits on: the output's lists of waits are empty, and the publisher's readiness was asked
      // once, so no stopped play left a reaction on it.
      expect(heldWaits(output)).toBe(0);
      expect(ready).toHaveBeenCalledTimes(1);
      expect(room.localParticipant.publishTrack).toHaveBeenCalledTimes(1);
      expect(capturedSamples()).toBe(0);

      publish();
      await expect(output.open()).resolves.toBeUndefined();
      const playing = output.play({ audio: clip(1_000), sampleRate: RATE });
      await until(() => source().captured.length === 1);
      source().playOut();
      await expect(playing).resolves.toEqual({ playedMs: 1_000 });
      expect(room.localParticipant.publishTrack).toHaveBeenCalledTimes(1);
      expect(heldWaits(output)).toBe(0);
      await output.close();
    } finally {
      ready.mockRestore();
    }
  });

  it('plays one clip at a time: a second play while one runs rejects, and the first plays on', async () => {
    const room = new FakeRoom();
    const output = outputOn(room);
    await output.open();
    const first = output.play({ audio: clip(1_000), sampleRate: RATE });
    await until(() => source().captured.length === 1);
    await expect(output.play({ audio: clip(1_000), sampleRate: RATE })).rejects.toThrow('room audio busy');
    source().playOut();
    await expect(first).resolves.toEqual({ playedMs: 1_000 });
    expect(source().captured).toHaveLength(1);
    await output.close();
  });

  it('plays a clip whole when a chunk of it starts with the bytes of a container header', async () => {
    const room = new FakeRoom();
    const output = outputOn(room);
    const audio = clip(4_000);
    // The second chunk starts at byte 96,000: its first four bytes read "OggS", which a raw PCM chunk may not start with.
    audio.write('OggS', 96_000, 'ascii');
    const playing = output.play({ audio, sampleRate: RATE });
    await until(() => FakeAudioSource.created.length > 0 && source().captured.length === 2);
    expect(source().captured.map((frame) => frame.samplesPerChannel)).toEqual([48_000, 48_000]);
    source().playOut();
    await expect(playing).resolves.toEqual({ playedMs: 4_000 });
    await output.close();
  });

  it('clears what the track holds of a clip whose later chunk is refused', async () => {
    const room = new FakeRoom();
    const attributes: Record<string, string> = {};
    let refuse = false;
    const setAttributes = vi.fn(async (values: Record<string, string>) => {
      if (refuse) throw new Error('update refused');
      Object.assign(attributes, values);
    });
    Object.assign(room.localParticipant, { setAttributes, attributes });
    const output = outputOn(room);
    await output.open();
    let release!: () => void;
    source().gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const playing = output.play({ audio: clip(4_000), sampleRate: RATE, mark });
    playing.catch(() => {});
    await until(() => setAttributes.mock.calls.length === 1);
    // While the first chunk waits for the track, the room loses the mark and refuses the next update.
    delete attributes[LIVEKIT_SPEECH_MARK_ATTRIBUTES.clipId];
    refuse = true;
    const clearsBefore = source().clears;
    release();
    source().gate = undefined;
    await expect(playing).rejects.toThrow('publisher mark refused');
    await settle();
    expect(source().captured).toHaveLength(1);
    expect(source().clears).toBeGreaterThan(clearsBefore);
    await output.close();
  });

  it('refuses a clip that is not whole PCM16 at a supported rate before anything is published', async () => {
    const room = new FakeRoom();
    const output = outputOn(room);
    await expect(output.play({ audio: Buffer.alloc(3), sampleRate: RATE })).rejects.toThrow(RangeError);
    await expect(output.play({ audio: Buffer.alloc(0), sampleRate: RATE })).rejects.toThrow(RangeError);
    await expect(output.play({ audio: Buffer.alloc(4), sampleRate: 1_000 })).rejects.toThrow(RangeError);
    await expect(output.play({ audio: Buffer.alloc(4), sampleRate: 24_000.5 })).rejects.toThrow(RangeError);
    expect(room.localParticipant.publishTrack).not.toHaveBeenCalled();
    await output.close();
  });

  it('plays nothing of a second clip stopped while the clear of the first is still under way', async () => {
    const room = new FakeRoom();
    const output = outputOn(room);
    await output.open();
    let release!: () => void;
    source().gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = output.play({ audio: clip(1_000), sampleRate: RATE });
    first.catch(() => {});
    await settle();
    // The first clip's chunk is on its way to the track, so its clear waits for that capture.
    const firstCleared = output.clear();
    await expect(first).rejects.toThrow('room audio cleared');
    // A second clip, every sample 0x0707 (1799), is asked for and stopped before that clear has finished.
    const second = output.play({ audio: Buffer.alloc(48_000, 7), sampleRate: RATE });
    second.catch(() => {});
    await settle();
    const secondCleared = output.clear();
    await expect(second).rejects.toThrow('room audio cleared');
    release();
    source().gate = undefined;
    await Promise.all([firstCleared, secondCleared]);
    await settle();
    // The first clip's frame landed and was cleared; nothing of the second reached the track.
    expect(source().captured.map((frame) => frame.data[0])).toEqual([1]);

    const third = output.play({ audio: clip(1_000), sampleRate: RATE });
    await until(() => source().captured.length === 2);
    source().playOut();
    await expect(third).resolves.toEqual({ playedMs: 1_000 });
    await output.close();
  });

  it('hands the track no further chunk once a stop came, whichever turn of the microtask queue it came in', async () => {
    /** Runs `then` after `hops` more turns of the microtask queue. */
    const later = (hops: number, then: () => void): void => {
      if (hops === 0) then();
      else void Promise.resolve().then(() => later(hops - 1, then));
    };
    const original = LiveKitAudioPublisher.prototype.sendAudio;
    let stopAfterFirstSend: (() => void) | undefined;
    const send = vi.spyOn(LiveKitAudioPublisher.prototype, 'sendAudio').mockImplementation(function (this: LiveKitAudioPublisher, chunk) {
      const sent = original.call(this, chunk);
      const stop = stopAfterFirstSend;
      stopAfterFirstSend = undefined;
      if (stop) void sent.then(stop);
      return sent;
    });
    try {
      // The stop comes 0 to 8 turns after the first chunk's send settled: one of them falls between the play's check of
      // that send and its call for the second chunk.
      for (let hops = 0; hops <= 8; hops++) {
        const room = new FakeRoom();
        const output = outputOn(room);
        await output.open();
        const track = FakeAudioSource.created[FakeAudioSource.created.length - 1]!;
        // What reaches the track, in order: each frame by the two-second block it came from, and each clear.
        const events: string[] = [];
        const capture = track.captureFrame.bind(track);
        const clearQueue = track.clearQueue.bind(track);
        track.captureFrame = async (frame) => {
          await capture(frame);
          events.push(`frame ${frame.data[0]}`);
        };
        track.clearQueue = () => {
          events.push('clear');
          clearQueue();
        };
        let cleared: Promise<void> | undefined;
        stopAfterFirstSend = () => later(hops, () => {
          cleared = output.clear();
        });
        const playing = output.play({ audio: clip(4_000), sampleRate: RATE });
        await expect(playing).rejects.toThrow('room audio cleared');
        await cleared;
        await settle();
        // The second chunk's frame, when it reached the track at all, was cleared after it: none follows the last clear.
        expect({ hops, after: events.slice(events.lastIndexOf('clear') + 1) }).toEqual({ hops, after: [] });
        await output.close();
      }
    } finally {
      send.mockRestore();
    }
  });

  it('closes once a capture stalls, so no later clip goes to the retired track', async () => {
    const room = new FakeRoom();
    const output = outputOn(room, { maxDurationMs: 100, receiptTimeoutMs: 30 });
    await output.open();
    let release!: () => void;
    source().gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The capture never returns: past receiptTimeoutMs plus maxDurationMs the publisher gives the track up.
    await expect(output.play({ audio: clip(100), sampleRate: RATE })).rejects.toThrow('room audio output stalled');
    await expect(output.play({ audio: clip(100), sampleRate: RATE })).rejects.toThrow('room audio output stalled');
    await expect(output.open()).rejects.toThrow('room audio output stalled');
    await until(() => room.localParticipant.unpublishTrack.mock.calls.length > 0);
    expect(room.localParticipant.unpublishTrack).toHaveBeenCalledWith('TR_AGENT', false);
    // The given-up capture returns late, on a closed source: nothing lands.
    release();
    await settle();
    expect(source().captured).toHaveLength(0);
  });

  it('tells a host that awaits close() when the track could not be unpublished after a stalled capture', async () => {
    const room = new FakeRoom();
    room.localParticipant.unpublishTrack.mockRejectedValueOnce(new Error('unpublish refused'));
    const output = outputOn(room, { maxDurationMs: 100, receiptTimeoutMs: 30 });
    await output.open();
    source().gate = new Promise<void>(() => {});
    await expect(output.play({ audio: clip(100), sampleRate: RATE })).rejects.toThrow('room audio output stalled');
    // The output closed itself on the stall; the host's own close() shares that cleanup and reports its failure.
    await expect(output.close()).rejects.toThrow('publisher cleanup incomplete');
    expect(room.localParticipant.unpublishTrack).toHaveBeenCalledTimes(1);
  });

  it('takes a real rtc-node Room as it is', () => {
    expect(conformance).toEqual([true]);
  });

  it('is exported from the LiveKit entry beside the room audio source', async () => {
    const livekit = await import('../livekit.js');
    expect(livekit.LiveKitRoomAudioOutput).toBe(LiveKitRoomAudioOutput);
    expect(livekit.ROOM_AUDIO_NO_SUBSCRIBER).toBe(ROOM_AUDIO_NO_SUBSCRIBER);
    expect(livekit.pcmChunks).toBe(pcmChunks);
  });
});

describe('pcmChunks', () => {
  it('cuts a PCM16 mono clip into chunks of at most maxMs, on whole samples', () => {
    expect(pcmChunks(Buffer.alloc(240_000), 24_000, 2_000).map((chunk) => chunk.length)).toEqual([96_000, 96_000, 48_000]);
    // 44,100 Hz holds 44.1 samples a millisecond: a 1 ms chunk takes 44 whole samples.
    expect(pcmChunks(Buffer.alloc(200), 44_100, 1).map((chunk) => chunk.length)).toEqual([88, 88, 24]);
  });

  it('refuses a chunk length that holds no whole sample', () => {
    expect(() => pcmChunks(Buffer.alloc(10), 8_000, 0)).toThrow(RangeError);
    expect(() => pcmChunks(Buffer.alloc(10), 100, 5)).toThrow(RangeError);
    expect(() => pcmChunks(Buffer.alloc(10), Number.NaN, 5)).toThrow(RangeError);
  });
});
