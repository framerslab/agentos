import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { ReconnectingSTT } from '../ReconnectingSTT.js';
import type { AudioFrame, IStreamingSTT, StreamingSTTSession, TranscriptEvent } from '../types.js';

/** A provider whose sessions the test drives: it records pushed frames and emits what the test says. */
function scripted() {
  const sessions: Array<StreamingSTTSession & EventEmitter & { frames: AudioFrame[] }> = [];
  const stt: IStreamingSTT = {
    providerId: 'scripted',
    isStreaming: true,
    async startSession() {
      const s = new EventEmitter() as StreamingSTTSession & EventEmitter & { frames: AudioFrame[] };
      s.frames = [];
      s.pushAudio = (f) => { s.frames.push(f); };
      s.flush = vi.fn().mockResolvedValue(undefined);
      s.close = vi.fn();
      sessions.push(s);
      return s;
    },
  };
  return { stt, sessions };
}
const frame = (t: number): AudioFrame => ({ samples: new Float32Array(320), sampleRate: 16_000, timestamp: t });
const final = (text: string, startMs: number, endMs: number): TranscriptEvent => ({ text, confidence: 1, words: [], isFinal: true, startMs, endMs });

describe('ReconnectingSTT', () => {
  it('reconnects the same provider on error, replays the buffer first, then the frames that arrived meanwhile, and reports the gap', async () => {
    const { stt, sessions } = scripted();
    let now = 0;
    const r = new ReconnectingSTT(stt, { ringBufferCapacityMs: 3_000, minReplayMs: 0, clock: () => now }); // two frames are 40 ms: below the default replay threshold
    const session = await r.startSession({ language: 'en' });
    const events: Array<[string, unknown]> = [];
    for (const name of ['transcript', 'stt:reconnected', 'stt:gap', 'error', 'close'] as const) session.on(name, (e: unknown) => events.push([name, e]));
    session.pushAudio(frame(0));
    session.pushAudio(frame(20));
    expect(sessions[0].frames.length).toBe(2);
    now = 1_000;
    sessions[0].emit('error', new Error('socket closed'));
    session.pushAudio(frame(40)); // arrives during the reconnect: queued
    await vi.waitFor(() => expect(sessions.length).toBe(2));
    await vi.waitFor(() => expect(sessions[1].frames.map((f) => f.timestamp)).toEqual([0, 20, 40]));
    expect(events.map(([n]) => n)).toEqual(['stt:reconnected', 'stt:gap']);
    expect(events[1][1]).toMatchObject({ lostMs: expect.any(Number), attempt: 1 });
  });
  it('drops a replayed duplicate and keeps the first copy, with the new session\'s clock moved onto the session timeline', async () => {
    const { stt, sessions } = scripted();
    const r = new ReconnectingSTT(stt, { minReplayMs: 0, clock: () => 0 });
    const session = await r.startSession();
    const got: Array<[string, number | undefined]> = [];
    session.on('transcript', (e: TranscriptEvent) => got.push([e.text, e.startMs]));
    for (let t = 0; t < 2_000; t += 20) session.pushAudio(frame(t)); // two seconds pushed: the session timeline is at 2000 ms
    sessions[0].emit('transcript', final('we start at nine', 500, 1_500));
    sessions[0].emit('close');
    await vi.waitFor(() => expect(sessions.length).toBe(2));
    // the new session got the replay (the whole two seconds, within the 3 s buffer), so its clock 0 is the timeline's 0
    sessions[1].emit('transcript', final('we start at nine.', 500, 1_500));
    sessions[1].emit('transcript', final('and finish at ten', 1_600, 2_800));
    expect(got).toEqual([['we start at nine', 500], ['and finish at ten', 1_600]]);
  });
  it('moves a new session\'s clock by what was pushed before it and not replayed', async () => {
    const { stt, sessions } = scripted();
    const r = new ReconnectingSTT(stt, { ringBufferCapacityMs: 1_000, minReplayMs: 0, clock: () => 0 });
    const session = await r.startSession();
    const got: Array<[string, number | undefined, number | undefined]> = [];
    session.on('transcript', (e: TranscriptEvent) => got.push([e.text, e.startMs, e.endMs]));
    for (let t = 0; t < 5_000; t += 20) session.pushAudio(frame(t)); // five seconds pushed; the buffer keeps the last second
    sessions[0].emit('error', new Error('drop'));
    await vi.waitFor(() => expect(sessions.length).toBe(2));
    sessions[1].emit('transcript', final('after the drop', 1_200, 1_900)); // 1200 ms into the new session's audio, which began 1000 ms before the 5000 ms mark
    expect(got).toEqual([['after the drop', 5_200, 5_900]]);
  });
  it('places the frames queued during a reconnect after the replay on the new session\'s clock', async () => {
    const { stt, sessions } = scripted();
    const r = new ReconnectingSTT(stt, { minReplayMs: 0, clock: () => 0 });
    const session = await r.startSession();
    const got: Array<[number | undefined, number | undefined]> = [];
    session.on('transcript', (e: TranscriptEvent) => got.push([e.startMs, e.endMs]));
    for (let t = 0; t < 1_000; t += 20) session.pushAudio(frame(t)); // one second pushed, all of it in the buffer
    sessions[0].emit('error', new Error('drop'));
    for (let t = 1_000; t < 1_200; t += 20) session.pushAudio(frame(t)); // 200 ms arrive while the reconnect runs: queued
    await vi.waitFor(() => expect(sessions[1].frames.length).toBe(60)); // the replayed second, then the queue
    sessions[1].emit('transcript', final('across the drop', 900, 1_150)); // the new session's clock starts where the replay does, at the timeline's 0
    expect(got).toEqual([[900, 1_150]]);
  });
  it('gives up after three attempts in a minute and emits error then close', async () => {
    const { stt, sessions } = scripted();
    let now = 0;
    const r = new ReconnectingSTT(stt, { clock: () => now, maxAttemptsPerMinute: 3 });
    const session = await r.startSession();
    const events: string[] = [];
    session.on('error', () => events.push('error'));
    session.on('close', () => events.push('close'));
    for (let i = 0; i < 3; i++) {
      sessions[i].emit('error', new Error(`drop ${i}`));
      await vi.waitFor(() => expect(sessions.length).toBe(i + 2));
      now += 1_000;
    }
    sessions[3].emit('error', new Error('drop 3'));
    await vi.waitFor(() => expect(events).toEqual(['error', 'close']));
    expect(sessions.length).toBe(4);
  });
  it('flush drains the live session; the caller\'s close emits close once, whatever the provider does after', async () => {
    const { stt, sessions } = scripted();
    const r = new ReconnectingSTT(stt, { clock: () => 0 });
    const session = await r.startSession();
    await session.flush();
    expect(sessions[0].flush).toHaveBeenCalledTimes(1);
    const closed = vi.fn();
    session.on('close', closed);
    session.close();
    expect(sessions[0].close).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1); // from the facade itself, not from the provider
    sessions[0].emit('close');
    sessions[0].emit('error', new Error('late'));
    await new Promise((r) => setTimeout(r, 10));
    expect(closed).toHaveBeenCalledTimes(1);
    expect(sessions.length).toBe(1); // no reconnect after the caller's close
  });
  it('ends without a reconnect when the provider closes its stream after a flush, and reconnects when audio followed the flush', async () => {
    const a = scripted();
    const ending = await new ReconnectingSTT(a.stt, { clock: () => 0 }).startSession();
    const closed = vi.fn();
    ending.on('close', closed);
    ending.pushAudio(frame(0));
    await ending.flush();
    a.sessions[0].emit('close'); // the provider sends its last final and closes, as the session contract has it
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(a.sessions.length).toBe(1);
    expect(closed).toHaveBeenCalledTimes(1);

    const b = scripted();
    const going = await new ReconnectingSTT(b.stt, { clock: () => 0 }).startSession();
    await going.flush();
    going.pushAudio(frame(0)); // the caller goes on after the flush, so a close from here is a drop
    b.sessions[0].emit('close');
    await vi.waitFor(() => expect(b.sessions.length).toBe(2));
  });
});
