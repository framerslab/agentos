/**
 * Unit tests for LiveKitRoomAudioSource.
 *
 * A fake rtc-node module, room, participants and tracks (livekit-fakes.ts)
 * stand in for a LiveKit server; the test drives frames, re-publications and
 * disconnects. The type checks below pin the structural types to the real
 * @livekit/rtc-node classes, which this repository installs as an optional
 * peer.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type * as Rtc from '@livekit/rtc-node';
import {
  LiveKitRoomAudioSource,
  loadLiveKitRtc,
  type LiveKitRoomLike,
  type LiveKitRtcModule,
} from '../LiveKitRoomAudioSource.js';
import {
  FakeAudioStream,
  FakePublication,
  FakeRoom,
  FakeTrack,
  KIND_AUDIO,
  KIND_VIDEO,
  SOURCE_SCREENSHARE_AUDIO,
  fakeRtc,
  rtcFrame,
  settle,
} from './livekit-fakes.js';

// Checked by the type check: the real rtc-node room and module satisfy the
// structural types the library accepts, so a host passes them as they are.
type Expect<T extends true> = T;
type RoomFits = Expect<Rtc.Room extends LiveKitRoomLike ? true : false>;
type ModuleFits = Expect<typeof Rtc extends LiveKitRtcModule ? true : false>;
const conformance: [RoomFits, ModuleFits] = [true, true];

beforeEach(() => {
  FakeAudioStream.opened.length = 0;
});

describe('LiveKitRoomAudioSource: the stream and the frames', () => {
  it("opens the participant's audio track at the requested rate and one channel, and converts Int16 to Float32", async () => {
    expect(conformance).toEqual([true, true]);
    const room = new FakeRoom();
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    const source = new LiveKitRoomAudioSource({
      room,
      participantIdentity: 'user-1',
      sampleRate: 24_000,
      rtc: fakeRtc(),
    });
    const frames = source[Symbol.asyncIterator]();
    const first = frames.next();
    await settle();
    expect(FakeAudioStream.opened.map((stream) => [stream.track.sid, stream.options])).toEqual([
      ['TR_1', { sampleRate: 24_000, numChannels: 1 }],
    ]);
    FakeAudioStream.opened[0].push(rtcFrame([16384, -16384, 32767, -32768]));
    const { value } = await first;
    expect(Array.from(value.samples)).toEqual([0.5, -0.5, 32767 / 32768, -1]);
    expect(value.sampleRate).toBe(24_000);
    expect(value.speakerHint).toBe('user-1');
    expect(source.trackSid).toBe('TR_1');
    source.close();
  });

  it('passes the frame size when one is given', async () => {
    const room = new FakeRoom();
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    const source = new LiveKitRoomAudioSource({
      room,
      participantIdentity: 'user-1',
      sampleRate: 16_000,
      frameSizeMs: 20,
      rtc: fakeRtc(),
    });
    void source[Symbol.asyncIterator]().next();
    await settle();
    expect(FakeAudioStream.opened[0].options).toEqual({ sampleRate: 16_000, numChannels: 1, frameSizeMs: 20 });
    source.close();
  });

  it('mixes a two-channel frame down to one channel', async () => {
    const room = new FakeRoom();
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    const source = new LiveKitRoomAudioSource({ room, participantIdentity: 'user-1', sampleRate: 24_000, rtc: fakeRtc() });
    const first = source[Symbol.asyncIterator]().next();
    await settle();
    FakeAudioStream.opened[0].push(rtcFrame([1000, 3000, -2000, -4000], 24_000, 2));
    const { value } = await first;
    expect(Array.from(value.samples)).toEqual([2000 / 32768, -3000 / 32768].map((x) => Math.fround(x)));
    source.close();
  });

  it('stamps frames on a clock that only moves forward', async () => {
    const room = new FakeRoom();
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    const source = new LiveKitRoomAudioSource({ room, participantIdentity: 'user-1', sampleRate: 24_000, rtc: fakeRtc() });
    const frames = source[Symbol.asyncIterator]();
    const first = frames.next();
    await settle();
    FakeAudioStream.opened[0].push(rtcFrame(new Array(240).fill(0))); // 10 ms
    FakeAudioStream.opened[0].push(rtcFrame(new Array(240).fill(0)));
    const a = (await first).value;
    const b = (await frames.next()).value;
    expect(b.timestamp - a.timestamp).toBeGreaterThanOrEqual(10);
    source.close();
  });

  it("reads the named participant's audio, not another participant's and not video", async () => {
    const room = new FakeRoom();
    room.addParticipant('other', new FakePublication(new FakeTrack('TR_OTHER')));
    room.addParticipant(
      'user-1',
      new FakePublication(new FakeTrack('TR_VIDEO'), KIND_VIDEO),
      new FakePublication(new FakeTrack('TR_AUDIO'))
    );
    const source = new LiveKitRoomAudioSource({ room, participantIdentity: 'user-1', sampleRate: 24_000, rtc: fakeRtc() });
    void source[Symbol.asyncIterator]().next();
    await settle();
    expect(FakeAudioStream.opened.map((stream) => stream.track.sid)).toEqual(['TR_AUDIO']);
    source.close();
  });

  it("reads the participant's microphone, not the audio of a screen share", async () => {
    const room = new FakeRoom();
    room.addParticipant(
      'user-1',
      new FakePublication(new FakeTrack('TR_SCREEN'), KIND_AUDIO, SOURCE_SCREENSHARE_AUDIO),
      new FakePublication(new FakeTrack('TR_MIC'))
    );
    const source = new LiveKitRoomAudioSource({ room, participantIdentity: 'user-1', sampleRate: 24_000, rtc: fakeRtc() });
    void source[Symbol.asyncIterator]().next();
    await settle();
    expect(FakeAudioStream.opened.map((stream) => stream.track.sid)).toEqual(['TR_MIC']);
    source.close();
  });

  it('waits for the participant to publish when no audio track is subscribed yet', async () => {
    const room = new FakeRoom();
    const source = new LiveKitRoomAudioSource({ room, participantIdentity: 'user-1', sampleRate: 24_000, rtc: fakeRtc() });
    const first = source[Symbol.asyncIterator]().next();
    await settle();
    expect(FakeAudioStream.opened).toHaveLength(0);
    const participant = room.addParticipant('user-1');
    const publication = new FakePublication(undefined);
    participant.trackPublications.set('PUB_LATE', publication);
    room.subscribe(participant, publication, new FakeTrack('TR_LATE'));
    await settle();
    expect(FakeAudioStream.opened.map((stream) => stream.track.sid)).toEqual(['TR_LATE']);
    FakeAudioStream.opened[0].push(rtcFrame([16384]));
    expect(Array.from((await first).value.samples)).toEqual([0.5]);
    source.close();
  });

  it('ends at once when the room disconnected before the source was first read', async () => {
    const room = new FakeRoom();
    room.addParticipant('user-1', new FakePublication(new FakeTrack('TR_1')));
    const source = new LiveKitRoomAudioSource({ room, participantIdentity: 'user-1', sampleRate: 24_000, rtc: fakeRtc() });
    room.isConnected = false; // the room's one 'disconnected' event came before the source listened
    room.emit('disconnected', 'CLIENT_INITIATED');
    const first = source[Symbol.asyncIterator]().next();
    await settle();
    expect(source.closed).toBe(true);
    expect(await first).toEqual({ done: true, value: undefined });
    expect(FakeAudioStream.opened).toHaveLength(0);
    expect(room.listenerCount('trackSubscribed')).toBe(0);
    expect(room.listenerCount('disconnected')).toBe(0);
  });

  it('refuses a sample rate that is not positive', () => {
    const room = new FakeRoom();
    expect(
      () => new LiveKitRoomAudioSource({ room, participantIdentity: 'user-1', sampleRate: 0, rtc: fakeRtc() })
    ).toThrow(RangeError);
  });

  it('names the missing peer and how to install it, keeping the import error as the cause', async () => {
    const missing = Object.assign(new Error("Cannot find package '@livekit/rtc-node'"), { code: 'ERR_MODULE_NOT_FOUND' });
    let failed: (Error & { cause?: unknown }) | undefined;
    try {
      await loadLiveKitRtc(async () => {
        throw missing;
      });
    } catch (err) {
      failed = err as Error & { cause?: unknown };
    }
    expect(failed?.message).toBe(
      '@livekit/rtc-node is required for the LiveKit room audio source and transport. Install it: npm install @livekit/rtc-node'
    );
    expect(failed?.cause).toBe(missing);
  });

  it('imports @livekit/rtc-node through the importer it is given', async () => {
    const rtc = fakeRtc();
    const asked: string[] = [];
    const loaded = await loadLiveKitRtc(async (specifier) => {
      asked.push(specifier);
      return rtc;
    });
    expect(asked).toEqual(['@livekit/rtc-node']);
    expect(loaded).toBe(rtc);
  });
});
