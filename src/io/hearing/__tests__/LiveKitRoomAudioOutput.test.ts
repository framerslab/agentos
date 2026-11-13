import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LIVEKIT_SPEECH_MARK_ATTRIBUTES, type SpeechMark } from '../../voice-pipeline/LiveKitAudioPublisher.js';
import {
  LiveKitRoomAudioOutput,
  ROOM_AUDIO_NO_SUBSCRIBER,
  pcmChunks,
  type LiveKitRoomAudioOutputOptions,
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
    expect(ROOM_AUDIO_NO_SUBSCRIBER).toBe('ROOM_AUDIO_NO_SUBSCRIBER');
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
