/**
 * Unit tests for DeepgramAuraStreamingTTS.
 *
 * Uses a mock WebSocket to simulate Deepgram Aura's streaming /v1/speak API.
 * Deepgram returns audio as BINARY frames and sends control as text JSON
 * ({ type: 'Flushed' | 'Cleared' | 'Metadata' | ... }). The session sends one
 * sentence segment at a time, as a Speak and a Flush, and the Flushed that
 * answers the Flush completes the segment: the last frame before it carries
 * the segment's text boundary, and no earlier frame does.
 */

import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  EncodedAudioChunk,
  IEndpointDetector,
  IStreamTransport,
  StreamingSTTSession,
  StreamingTTSConfig,
  StreamingTTSSession,
} from '../types.js';

vi.mock('ws', () => {
  const { EventEmitter: EE } = require('node:events');
  class MockWebSocket extends EE {
    static OPEN = 1;
    static CLOSED = 3;
    /**
     * Per-test connect behavior: 'open' (default) resolves the handshake;
     * 'reject-400' simulates the server refusing the upgrade the way `ws`
     * surfaces it (an `unexpected-response` carrying the HTTP body).
     * Reset to 'open' in afterEach.
     */
    static nextBehavior: 'open' | 'reject-400' = 'open';
    readyState = 1;
    send = vi.fn();
    close = vi.fn();
    url: string;
    constructor(url?: string) {
      super();
      this.url = String(url ?? '');
      const behavior = MockWebSocket.nextBehavior;
      process.nextTick(() => {
        if (behavior === 'reject-400') {
          const res = {
            statusCode: 400,
            on(event: string, cb: (arg?: unknown) => void) {
              if (event === 'data') cb(Buffer.from('{"err_code":"UNSUPPORTED_AUDIO_FORMAT"}'));
              if (event === 'end') cb();
            },
          };
          this.emit('unexpected-response', {}, res);
          return;
        }
        this.emit('open');
      });
    }
  }
  return { default: MockWebSocket, WebSocket: MockWebSocket };
});

import { DeepgramAuraStreamingTTS } from '../providers/DeepgramAuraStreamingTTS.js';
import { VoicePipelineOrchestrator } from '../VoicePipelineOrchestrator.js';
import { PlayedTextTracker } from '../ttsTextBoundaries.js';
// Default import: the 'ws' types only expose WebSocket as the default export
// under this tsconfig (TS2595 on a named import). vi.mock supplies the same
// mock class for both the default and named bindings.
import MockedWs from 'ws';

const MockCtl = MockedWs as unknown as { nextBehavior: 'open' | 'reject-400' };

/** The mock socket a session holds. */
interface MockSocket {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  url: string;
  emit(event: string, ...args: unknown[]): boolean;
}

const socketOf = (session: StreamingTTSSession): MockSocket => (session as any).ws;
/** The JSON control messages the session sent on the socket, in order. */
const sent = (ws: MockSocket): unknown[] => ws.send.mock.calls.map((call) => JSON.parse(call[0] as string));
/** One binary audio frame from the server: two bytes, one 16-bit sample, recognizable by `n`. */
const frame = (ws: MockSocket, n: number): void => {
  ws.emit('message', Buffer.from([n, n]), true);
};
/** One JSON control message from the server. */
const control = (ws: MockSocket, message: Record<string, unknown>): void => {
  ws.emit('message', JSON.stringify(message), false);
};
/** The chunks the session emits from now on. */
const recorded = (session: StreamingTTSSession): EncodedAudioChunk[] => {
  const chunks: EncodedAudioChunk[] = [];
  session.on('audio', (chunk: EncodedAudioChunk) => chunks.push(chunk));
  return chunks;
};

describe('DeepgramAuraStreamingTTS', () => {
  let tts: DeepgramAuraStreamingTTS;

  beforeEach(() => {
    tts = new DeepgramAuraStreamingTTS({ apiKey: 'dg-key', voice: 'aura-2-thalia-en' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('has providerId deepgram-aura', () => {
    expect(tts.providerId).toBe('deepgram-aura');
  });

  it('creates a session with the streaming methods', async () => {
    const session = await tts.startSession();
    expect(typeof session.pushTokens).toBe('function');
    expect(typeof session.flush).toBe('function');
    expect(typeof session.cancel).toBe('function');
    expect(typeof session.close).toBe('function');
  });

  it('sends a completed sentence as one Speak and one Flush, and nothing before the sentence is complete', async () => {
    const session = await tts.startSession();
    const ws = socketOf(session);
    ws.send.mockClear();
    session.pushTokens('Hello there');
    expect(ws.send).not.toHaveBeenCalled();
    // The sentence is complete once whitespace has followed its mark; the whitespace opens the next segment.
    session.pushTokens('. How');
    expect(sent(ws)).toEqual([{ type: 'Speak', text: 'Hello there.' }, { type: 'Flush' }]);
  });

  it('always dials the streaming WS with encoding=linear16 (mp3 is REST-only and 400s)', async () => {
    // Default session format is 'mp3'; the WIRE must still be linear16:
    // Deepgram rejects `encoding=mp3` on /v1/speak streaming upgrades with
    // HTTP 400 UNSUPPORTED_AUDIO_FORMAT (expected one of linear16|mulaw|alaw).
    const session = await tts.startSession();
    const url: string = socketOf(session).url;
    expect(url).toContain('encoding=linear16');
    expect(url).toContain('sample_rate=24000');
    expect(url).not.toContain('encoding=mp3');
  });

  it('WAV-wraps binary chunks for compressed-format callers so per-chunk decodeAudioData works', async () => {
    const session = await tts.startSession(); // default format 'mp3' → wav container
    const listener = vi.fn();
    session.on('audio', listener);
    session.pushTokens('hi');
    // 'hi' is the final segment: its frame is held until Flushed proves it the segment's last.
    const flushed = session.flush();

    const ws = socketOf(session);
    ws.emit('message', Buffer.from([1, 2, 3, 4]), true); // binary linear16 frame
    expect(listener).not.toHaveBeenCalled();
    control(ws, { type: 'Flushed', sequence_id: 0 });
    await flushed;

    expect(listener).toHaveBeenCalledOnce();
    const chunk = listener.mock.calls[0][0];
    expect(Buffer.isBuffer(chunk.audio)).toBe(true);
    // 44-byte standalone RIFF/WAVE header + the 4 raw PCM bytes
    expect(chunk.audio.byteLength).toBe(48);
    expect(chunk.audio.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(chunk.audio.subarray(8, 12).toString('ascii')).toBe('WAVE');
    // header declares mono 16-bit at the session sample rate
    expect(chunk.audio.readUInt32LE(24)).toBe(24_000);
    expect(chunk.audio.readUInt32LE(40)).toBe(4); // data-chunk size = raw pcm bytes
    expect(chunk.format).toBe('pcm');
    expect(chunk.container).toBe('wav');
    expect(chunk.text).toBe('hi');
    expect(chunk.textBoundary).toEqual({ segmentId: expect.any(String), start: 0, end: 2, text: 'hi', final: true });
  });

  it('passes raw PCM through untouched when the caller explicitly asked for pcm', async () => {
    const session = await tts.startSession({ format: 'pcm' });
    const listener = vi.fn();
    session.on('audio', listener);

    const ws = socketOf(session);
    // No segment is in flight: the frame goes out at once, without a boundary.
    ws.emit('message', Buffer.from([1, 2, 3, 4]), true);

    expect(listener).toHaveBeenCalledOnce();
    const chunk = listener.mock.calls[0][0];
    expect(chunk.audio.byteLength).toBe(4);
    expect(chunk.audio.subarray(0, 4).toString('ascii')).not.toBe('RIFF');
    expect(chunk.format).toBe('pcm');
    expect(chunk.container).toBe('raw');
    expect(chunk.textBoundary).toBeUndefined();
  });

  it('REJECTS startSession (never hangs) when the server refuses the upgrade, carrying the HTTP body', async () => {
    // Regression: the old connect() ran emit('error') BEFORE reject(); with
    // no 'error' listener attached yet the emit threw, reject never ran, and
    // the promise never settled (silent zombie voice sessions in prod).
    MockCtl.nextBehavior = 'reject-400';
    try {
      await expect(tts.startSession()).rejects.toThrow(/HTTP 400.*UNSUPPORTED_AUDIO_FORMAT/s);
    } finally {
      MockCtl.nextBehavior = 'open';
    }
  });

  it('ignores non-audio JSON control frames (no audio emit)', async () => {
    const session = await tts.startSession();
    const listener = vi.fn();
    session.on('audio', listener);
    const ws = socketOf(session);
    ws.emit('message', JSON.stringify({ type: 'Metadata', request_id: 'x' }), false);
    expect(listener).not.toHaveBeenCalled();
  });

  it('sends the final unterminated segment at flush, and resolves on its Flushed', async () => {
    const session = await tts.startSession();
    const flushDone = vi.fn();
    session.on('flush_complete', flushDone);
    const ws = socketOf(session);
    ws.send.mockClear();

    session.pushTokens('Hello');
    expect(ws.send).not.toHaveBeenCalled();
    const p = session.flush();
    expect(sent(ws)).toEqual([{ type: 'Speak', text: 'Hello' }, { type: 'Flush' }]);

    control(ws, { type: 'Flushed', sequence_id: 0 });
    await p;
    expect(flushDone).toHaveBeenCalledOnce();
  });

  it('sends Clear on cancel', async () => {
    const session = await tts.startSession();
    const ws = socketOf(session);
    ws.send.mockClear();
    session.cancel();
    expect(JSON.parse(ws.send.mock.calls[0][0])).toEqual({ type: 'Clear' });
  });

  it("attaches the segment's boundary to the last frame its terminal response proves complete, and to no earlier frame", async () => {
    const session = await tts.startSession({ format: 'pcm' });
    const ws = socketOf(session);
    const chunks = recorded(session);
    const flushes = vi.fn();
    session.on('flush_complete', flushes);
    ws.send.mockClear();

    // The first sentence goes out whole, as soon as it is complete, before any text of the second.
    session.pushTokens('Hello th');
    expect(ws.send).not.toHaveBeenCalled();
    session.pushTokens('ere. How are you');
    expect(sent(ws)).toEqual([{ type: 'Speak', text: 'Hello there.' }, { type: 'Flush' }]);
    const flushed = session.flush();
    // The final segment waits for the one in flight.
    expect(sent(ws)).toHaveLength(2);

    frame(ws, 1);
    frame(ws, 2);
    frame(ws, 3);
    // The newest frame is held: Flushed decides whether it is the segment's last.
    expect(chunks.map((chunk) => chunk.audio[0])).toEqual([1, 2]);
    expect(chunks.map((chunk) => chunk.textBoundary)).toEqual([undefined, undefined]);
    // The legacy text field is the text of the segment in flight.
    expect(chunks.map((chunk) => chunk.text)).toEqual(['Hello there.', 'Hello there.']);
    control(ws, { type: 'Flushed', sequence_id: 0 });
    expect(chunks).toHaveLength(3);
    expect(chunks[2].audio[0]).toBe(3);
    expect(chunks[2].textBoundary).toEqual({ segmentId: expect.any(String), start: 0, end: 12, text: 'Hello there.', final: true });
    expect(flushes).not.toHaveBeenCalled();

    // The second segment starts only now, with its exact text.
    expect(sent(ws).slice(2)).toEqual([{ type: 'Speak', text: ' How are you' }, { type: 'Flush' }]);
    frame(ws, 4);
    frame(ws, 5);
    expect(chunks).toHaveLength(4);
    expect(chunks[3].textBoundary).toBeUndefined();
    expect(chunks[3].text).toBe(' How are you');
    control(ws, { type: 'Flushed', sequence_id: 1 });
    expect(chunks).toHaveLength(5);
    expect(chunks[4].audio[0]).toBe(5);
    expect(chunks[4].textBoundary).toEqual({ segmentId: expect.any(String), start: 12, end: 24, text: ' How are you', final: true });
    expect(chunks[4].textBoundary!.segmentId).not.toBe(chunks[2].textBoundary!.segmentId);
    // One flush, one flush_complete, after the last segment's terminal response; the promise resolves then.
    expect(flushes).toHaveBeenCalledOnce();
    await flushed;
  });

  it('sends the next segment only after the terminal response of the one before it', async () => {
    const session = await tts.startSession({ format: 'pcm' });
    const ws = socketOf(session);
    ws.send.mockClear();

    session.pushTokens('One. Two. Three');
    expect(sent(ws)).toEqual([{ type: 'Speak', text: 'One.' }, { type: 'Flush' }]);
    frame(ws, 1);
    expect(sent(ws)).toHaveLength(2);
    control(ws, { type: 'Flushed', sequence_id: 0 });
    expect(sent(ws).slice(2)).toEqual([{ type: 'Speak', text: ' Two.' }, { type: 'Flush' }]);
    const flushed = session.flush();
    expect(sent(ws)).toHaveLength(4);
    control(ws, { type: 'Flushed', sequence_id: 1 });
    expect(sent(ws).slice(4)).toEqual([{ type: 'Speak', text: ' Three' }, { type: 'Flush' }]);
    control(ws, { type: 'Flushed', sequence_id: 2 });
    await flushed;
  });

  it('emits the held frame without a boundary when the terminal response does not come within five seconds, and goes on', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const session = await tts.startSession({ format: 'pcm' });
    const ws = socketOf(session);
    const chunks = recorded(session);
    const flushes = vi.fn();
    session.on('flush_complete', flushes);
    ws.send.mockClear();

    session.pushTokens('First one. Second');
    const flushed = session.flush();
    expect(sent(ws)).toEqual([{ type: 'Speak', text: 'First one.' }, { type: 'Flush' }]);
    frame(ws, 1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(chunks).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    // A timeout is not completion: the held frame goes out with no boundary, and the segment counts as done.
    expect(chunks).toHaveLength(1);
    expect(chunks[0].audio[0]).toBe(1);
    expect(chunks[0].textBoundary).toBeUndefined();
    expect(flushes).not.toHaveBeenCalled();
    // Deepgram answers in order and a Flushed names no Flush, so the next segment waits for the late one: it must
    // not complete the wrong segment.
    expect(sent(ws)).toHaveLength(2);
    control(ws, { type: 'Flushed', sequence_id: 0 });
    expect(chunks).toHaveLength(1);
    expect(sent(ws).slice(2)).toEqual([{ type: 'Speak', text: ' Second' }, { type: 'Flush' }]);
    frame(ws, 2);
    control(ws, { type: 'Flushed', sequence_id: 1 });
    expect(chunks).toHaveLength(2);
    expect(chunks[1].textBoundary).toEqual({ segmentId: expect.any(String), start: 10, end: 17, text: ' Second', final: true });
    expect(flushes).toHaveBeenCalledOnce();
    await flushed;
  });

  it('starts the next segment once the bounded wait for the late Flushed of a timed-out segment ends', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const session = await tts.startSession({ format: 'pcm' });
    const ws = socketOf(session);
    const chunks = recorded(session);
    ws.send.mockClear();

    session.pushTokens('First one. Second');
    const flushed = session.flush();
    frame(ws, 1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(chunks).toHaveLength(1);
    expect(sent(ws)).toHaveLength(2);
    // No Flushed comes for five more seconds: the next segment goes out anyway.
    await vi.advanceTimersByTimeAsync(4_999);
    expect(sent(ws)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent(ws).slice(2)).toEqual([{ type: 'Speak', text: ' Second' }, { type: 'Flush' }]);
    frame(ws, 2);
    control(ws, { type: 'Flushed', sequence_id: 0 });
    expect(chunks[1].textBoundary).toEqual({ segmentId: expect.any(String), start: 10, end: 17, text: ' Second', final: true });
    await flushed;
  });

  it('attaches nothing to a frame after a cancel, and a late terminal response emits nothing', async () => {
    const session = await tts.startSession({ format: 'pcm' });
    const ws = socketOf(session);
    const chunks = recorded(session);
    const flushes = vi.fn();
    session.on('flush_complete', flushes);
    ws.send.mockClear();

    session.pushTokens('Hello there. ');
    frame(ws, 1);
    const flushed = session.flush();
    session.cancel();
    // The held frame is dropped, and Clear discards what the server still holds.
    expect(chunks).toHaveLength(0);
    expect(sent(ws)).toEqual([{ type: 'Speak', text: 'Hello there.' }, { type: 'Flush' }, { type: 'Clear' }]);
    // A frame that still arrives before the Cleared is audio of the cleared text: it is dropped.
    frame(ws, 2);
    expect(chunks).toHaveLength(0);
    // The next segment waits until the server has answered the Clear.
    session.pushTokens('Next one. ');
    expect(sent(ws)).toHaveLength(3);
    // The cancelled segment's Flushed, which comes before the Cleared, completes nothing and ends no wait.
    control(ws, { type: 'Flushed', sequence_id: 0 });
    expect(chunks).toHaveLength(0);
    expect(flushes).not.toHaveBeenCalled();
    expect(sent(ws)).toHaveLength(3);
    // The Cleared ends the wait: the next segment goes out, and the audio that follows is the session's again.
    control(ws, { type: 'Cleared', sequence_id: 0 });
    expect(sent(ws).slice(3)).toEqual([{ type: 'Speak', text: 'Next one.' }, { type: 'Flush' }]);
    frame(ws, 3);
    frame(ws, 4);
    expect(chunks.map((chunk) => [chunk.audio[0], chunk.textBoundary, chunk.text])).toEqual([[3, undefined, 'Next one.']]);
    // The flush that the cancel cut resolved without flush_complete.
    await flushed;
    expect(flushes).not.toHaveBeenCalled();

    // A cancel with a segment in flight, then Cleared alone: it ends the wait too, and the frames before it are dropped.
    session.cancel();
    expect(sent(ws).slice(5)).toEqual([{ type: 'Clear' }]);
    frame(ws, 5);
    session.pushTokens('Again. ');
    expect(sent(ws)).toHaveLength(6);
    control(ws, { type: 'Cleared', sequence_id: 2 });
    expect(sent(ws).slice(6)).toEqual([{ type: 'Speak', text: 'Again.' }, { type: 'Flush' }]);
    expect(chunks).toHaveLength(1);
  });

  it('emits flush_complete once per flush, not once per segment', async () => {
    const session = await tts.startSession({ format: 'pcm' });
    const ws = socketOf(session);
    const flushes = vi.fn();
    session.on('flush_complete', flushes);
    ws.send.mockClear();

    session.pushTokens('One. Two. ');
    const flushed = session.flush();
    expect(sent(ws)).toEqual([{ type: 'Speak', text: 'One.' }, { type: 'Flush' }]);
    control(ws, { type: 'Flushed', sequence_id: 0 });
    expect(flushes).not.toHaveBeenCalled();
    expect(sent(ws).slice(2)).toEqual([{ type: 'Speak', text: ' Two.' }, { type: 'Flush' }]);
    control(ws, { type: 'Flushed', sequence_id: 1 });
    expect(flushes).toHaveBeenCalledOnce();
    await flushed;
    expect(flushes).toHaveBeenCalledOnce();
  });

  it('proves a sentence played only with its Flushed and the acknowledgement of its last frame, never with an earlier one', async () => {
    const session = await tts.startSession({ format: 'pcm' });
    const ws = socketOf(session);
    // A consumer that records each chunk under its place in the stream, as a transport's playback sequence names it.
    const played = new PlayedTextTracker();
    const chunks: EncodedAudioChunk[] = [];
    session.on('audio', (chunk: EncodedAudioChunk) => {
      chunks.push(chunk);
      played.sent(chunks.length, chunk.textBoundary);
    });

    session.pushTokens('Your order shipped.');
    const flushed = session.flush();
    frame(ws, 1);
    frame(ws, 2);
    frame(ws, 3);
    // Two frames are out, each with the whole sentence as its legacy text, and the first is acknowledged as played:
    // no sentence is proven, so the whole sentence stays unheard.
    expect(chunks.map((chunk) => chunk.text)).toEqual(['Your order shipped.', 'Your order shipped.']);
    played.acknowledged(1);
    expect(played.playedText).toBe('');
    // The Flushed puts the boundary on the last frame alone; acknowledging the frames before it still proves nothing.
    control(ws, { type: 'Flushed', sequence_id: 0 });
    await flushed;
    expect(chunks.map((chunk) => chunk.textBoundary?.text)).toEqual([undefined, undefined, 'Your order shipped.']);
    played.acknowledged(2);
    expect(played.playedText).toBe('');
    played.acknowledged(3);
    expect(played.playedText).toBe('Your order shipped.');
  });

  /** How many Flush messages the session has sent on the socket. */
  const flushCount = (ws: MockSocket): number => sent(ws).filter((message) => (message as { type: string }).type === 'Flush').length;

  /** Twenty short sentences within a second, each flushed and answered: Deepgram's Flush budget for the minute is spent. */
  async function spendFlushBudget(session: StreamingTTSSession, ws: MockSocket): Promise<void> {
    for (let i = 0; i < 20; i++) {
      session.pushTokens('Go. ');
      expect(flushCount(ws)).toBe(i + 1);
      control(ws, { type: 'Flushed', sequence_id: i });
      await vi.advanceTimersByTimeAsync(50);
    }
  }

  it("sends at most twenty Flush messages a minute: a segment past the limit is spoken without one, the segments after it join it, and one Flush at the window's end proves them together", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const session = await tts.startSession({ format: 'pcm' });
    const ws = socketOf(session);
    const chunks = recorded(session);
    const flushes = vi.fn();
    session.on('flush_complete', flushes);
    ws.send.mockClear();

    const first = Date.now();
    await spendFlushBudget(session, ws);
    const before = sent(ws).length;
    // The twenty-first sentence is spoken without a Flush, and the twenty-second, the final segment, joins it.
    session.pushTokens('Twenty one. ');
    session.pushTokens('Twenty two');
    const flushed = session.flush();
    expect(sent(ws).slice(before)).toEqual([{ type: 'Speak', text: ' Twenty one.' }, { type: 'Speak', text: ' Twenty two' }]);
    frame(ws, 1);
    frame(ws, 2);
    // The joined segment holds its newest frame; the one before goes out without a boundary, the joined text its legacy text.
    expect(chunks.map((chunk) => chunk.audio[0])).toEqual([1]);
    expect(chunks[0].textBoundary).toBeUndefined();
    expect(chunks[0].text).toBe(' Twenty one. Twenty two');
    // No Flush was asked for, so nothing times out while the window runs.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(chunks).toHaveLength(1);
    expect(flushCount(ws)).toBe(20);
    expect(flushes).not.toHaveBeenCalled();
    // Sixty-one seconds after the first Flush the window has passed: the Flush goes out, and its Flushed proves the
    // joined segment, whose boundary covers both sentences exactly.
    await vi.advanceTimersByTimeAsync(first + 61_000 - Date.now() - 1);
    expect(flushCount(ws)).toBe(20);
    await vi.advanceTimersByTimeAsync(1);
    expect(flushCount(ws)).toBe(21);
    expect(sent(ws)[sent(ws).length - 1]).toEqual({ type: 'Flush' });
    control(ws, { type: 'Flushed', sequence_id: 20 });
    expect(chunks).toHaveLength(2);
    expect(chunks[1].audio[0]).toBe(2);
    expect(chunks[1].textBoundary).toEqual({ segmentId: expect.any(String), start: 79, end: 102, text: ' Twenty one. Twenty two', final: true });
    expect(flushes).toHaveBeenCalledOnce();
    await flushed;
  });

  it("a cancel while a segment waits for its Flush slot sends Clear, and no Flush follows at the window's end", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const session = await tts.startSession({ format: 'pcm' });
    const ws = socketOf(session);
    const chunks = recorded(session);
    const flushes = vi.fn();
    session.on('flush_complete', flushes);
    ws.send.mockClear();

    await spendFlushBudget(session, ws);
    session.pushTokens('Twenty one. ');
    frame(ws, 1);
    const flushed = session.flush();
    session.cancel();
    // The held frame is dropped, Clear goes out, and the flush resolves without flush_complete.
    expect(chunks).toHaveLength(0);
    expect(sent(ws)[sent(ws).length - 1]).toEqual({ type: 'Clear' });
    await flushed;
    expect(flushes).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(flushCount(ws)).toBe(20);
    // The window has passed: the next sentence is flushed as before.
    session.pushTokens('Next one. ');
    expect(sent(ws).slice(-2)).toEqual([{ type: 'Speak', text: 'Next one.' }, { type: 'Flush' }]);
    expect(flushCount(ws)).toBe(21);
  });

  it("reports the socket closing at the server's hand while a segment is in flight, ends it without a boundary, completes the flush, and closes once", async () => {
    const session = await tts.startSession({ format: 'pcm' });
    const ws = socketOf(session);
    const chunks = recorded(session);
    const flushes = vi.fn();
    const errors = vi.fn();
    const closes = vi.fn();
    session.on('flush_complete', flushes);
    session.on('error', errors);
    session.on('close', closes);
    ws.send.mockClear();

    session.pushTokens('Hello there. How are');
    const flushed = session.flush();
    frame(ws, 1);
    expect(sent(ws)).toEqual([{ type: 'Speak', text: 'Hello there.' }, { type: 'Flush' }]);
    ws.emit('close');
    // The loss is reported, the held frame goes out without a boundary, the queued segment is dropped, and the flush
    // completes without a Flushed, so the reply ends.
    expect(errors).toHaveBeenCalledOnce();
    expect((errors.mock.calls[0][0] as Error).message).toBe('deepgram aura ws closed');
    expect(chunks.map((chunk) => [chunk.audio[0], chunk.textBoundary])).toEqual([[1, undefined]]);
    expect(flushes).toHaveBeenCalledOnce();
    await flushed;
    expect(closes).toHaveBeenCalledOnce();
    // The session is closed: nothing more is sent, and a flush resolves at once without flush_complete.
    session.pushTokens('Again. ');
    await session.flush();
    expect(sent(ws)).toHaveLength(2);
    expect(flushes).toHaveBeenCalledOnce();
    expect(closes).toHaveBeenCalledOnce();
  });

  it("emits close once when the session is closed, though the socket's closing handshake follows", async () => {
    const session = await tts.startSession({ format: 'pcm' });
    const ws = socketOf(session);
    const errors = vi.fn();
    const closes = vi.fn();
    session.on('error', errors);
    session.on('close', closes);

    session.close();
    expect(ws.close).toHaveBeenCalledWith(1000, 'session closed');
    expect(closes).toHaveBeenCalledOnce();
    // The closing handshake completes: the socket's own close event follows the session's.
    ws.emit('close', 1000, Buffer.from('session closed'));
    expect(closes).toHaveBeenCalledOnce();
    expect(errors).not.toHaveBeenCalled();
  });

  it('stays open when Deepgram closes the socket between replies, and speaks the next reply on a fresh socket', async () => {
    const session = await tts.startSession({ format: 'pcm' });
    const ws = socketOf(session);
    const errors = vi.fn();
    const warnings = vi.fn();
    const closes = vi.fn();
    const flushes = vi.fn();
    session.on('error', errors);
    session.on('warning', warnings);
    session.on('close', closes);
    session.on('flush_complete', flushes);

    session.pushTokens('Done.');
    const first = session.flush();
    control(ws, { type: 'Flushed', sequence_id: 0 });
    await first;
    // Deepgram closes the idle socket: nothing is reported, and the session stays open.
    (ws as unknown as { readyState: number }).readyState = 3;
    ws.emit('close', 1011, Buffer.from(''));
    expect(errors).not.toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();
    expect(closes).not.toHaveBeenCalled();

    // The next reply opens a fresh socket, and its sentence goes out there once it is open.
    const chunks = recorded(session);
    session.pushTokens('Again. ');
    const second = session.flush();
    let fresh!: MockSocket;
    await vi.waitFor(() => {
      fresh = socketOf(session);
      expect(fresh).toBeTruthy();
      expect(fresh).not.toBe(ws);
      expect(sent(fresh)).toEqual([{ type: 'Speak', text: 'Again.' }, { type: 'Flush' }]);
    });
    frame(fresh, 7);
    control(fresh, { type: 'Flushed', sequence_id: 0 });
    await second;
    expect(chunks.map((chunk) => [chunk.audio[0], chunk.textBoundary?.text])).toEqual([[7, 'Again.']]);
    expect(flushes).toHaveBeenCalledTimes(2);
    // Nothing of the next reply went to the closed socket.
    expect(sent(ws)).toEqual([{ type: 'Speak', text: 'Done.' }, { type: 'Flush' }]);
    expect(errors).not.toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();
    expect(closes).not.toHaveBeenCalled();
    session.close();
    expect(closes).toHaveBeenCalledOnce();
  });

  it('reports a socket that fails to reopen for the next reply as a warning, ends that reply unplayed with its flush_complete, and opens one again for the reply after it', async () => {
    const session = await tts.startSession({ format: 'pcm' });
    const ws = socketOf(session);
    const errors = vi.fn();
    const warnings = vi.fn();
    const closes = vi.fn();
    const flushes = vi.fn();
    session.on('error', errors);
    session.on('warning', warnings);
    session.on('close', closes);
    session.on('flush_complete', flushes);
    const chunks = recorded(session);

    (ws as unknown as { readyState: number }).readyState = 3;
    ws.emit('close', 1011, Buffer.from(''));
    // The one try to open a socket for the next reply is refused.
    MockCtl.nextBehavior = 'reject-400';
    try {
      session.pushTokens('Again. ');
      await session.flush();
    } finally {
      MockCtl.nextBehavior = 'open';
    }
    expect(warnings).toHaveBeenCalledOnce();
    expect(warnings.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(errors).not.toHaveBeenCalled();
    expect(closes).not.toHaveBeenCalled();
    // The reply ends unplayed: its flush completes, and no audio went out.
    expect(flushes).toHaveBeenCalledOnce();
    expect(chunks).toHaveLength(0);

    // The reply after it opens a socket again.
    session.pushTokens('Third. ');
    const third = session.flush();
    let fresh!: MockSocket;
    await vi.waitFor(() => {
      fresh = socketOf(session);
      expect(fresh).toBeTruthy();
      expect(fresh).not.toBe(ws);
      expect(sent(fresh)).toEqual([{ type: 'Speak', text: 'Third.' }, { type: 'Flush' }]);
    });
    control(fresh, { type: 'Flushed', sequence_id: 0 });
    await third;
    expect(flushes).toHaveBeenCalledTimes(2);
    expect(warnings).toHaveBeenCalledOnce();
    expect(errors).not.toHaveBeenCalled();
    expect(closes).not.toHaveBeenCalled();
  });

  it("sends the transport none of what Deepgram still delivers for a reply typed text cut, as the typed text's reply", async () => {
    // A transport that reports no playout, and an STT session and an endpoint detector the test drives.
    const transport = Object.assign(new EventEmitter(), {
      id: 'transport-1',
      state: 'open' as const,
      sendAudio: vi.fn(async (_chunk: EncodedAudioChunk) => undefined),
      sendControl: vi.fn(async (_message: unknown) => undefined),
      close: vi.fn(),
    });
    const stt = Object.assign(new EventEmitter(), { pushAudio: vi.fn(), flush: vi.fn(async () => undefined), close: vi.fn() });
    const endpoint = Object.assign(new EventEmitter(), { mode: 'heuristic' as const, pushVadEvent: vi.fn(), pushTranscript: vi.fn(), reset: vi.fn() });
    // The agent's answer to the spoken question streams until its request is aborted; its answer to the text is one
    // sentence.
    let unwind: (() => void) | undefined;
    const agent = {
      sendText: vi.fn((text: string) =>
        (async function* () {
          if (text !== 'Where is my order?') {
            yield 'Cancelled.';
            return;
          }
          yield 'Your order shipped. ';
          yield 'It arrives';
          await new Promise<void>((resolve) => {
            unwind = resolve;
          });
        })()
      ),
      abort: vi.fn(() => unwind?.()),
    };
    let session!: StreamingTTSSession;
    const orchestrator = new VoicePipelineOrchestrator({ stt: 'fake-stt', tts: tts.providerId, format: 'pcm' });
    await orchestrator.startSession(transport as unknown as IStreamTransport, agent, {
      streamingSTT: { providerId: 'fake-stt', isStreaming: true, startSession: async () => stt as unknown as StreamingSTTSession },
      streamingTTS: {
        providerId: tts.providerId,
        startSession: async (config?: StreamingTTSConfig) => (session = await tts.startSession(config)),
      },
      endpointDetector: endpoint as unknown as IEndpointDetector,
      bargeinHandler: { mode: 'hard-cut', handleBargein: () => ({ type: 'cancel' }) },
    });
    const ws = socketOf(session);
    ws.send.mockClear();
    /** The frames the transport was sent, by the value the server gave each. */
    const heard = (): number[] => transport.sendAudio.mock.calls.map(([chunk]) => chunk.audio[0]!);

    try {
      endpoint.emit('turn_complete', { transcript: 'Where is my order?', confidence: 0.9, durationMs: 800, reason: 'silence_timeout' });
      await vi.waitFor(() => expect(sent(ws)).toEqual([{ type: 'Speak', text: 'Your order shipped.' }, { type: 'Flush' }]));
      frame(ws, 1);
      frame(ws, 2);
      // The first frame goes to the transport; the second is held for the sentence's boundary.
      expect(heard()).toEqual([1]);

      // The user types while the sentence plays: the reply is cut, Clear goes out, and the agent answers the text.
      transport.emit('message', { type: 'text_input', text: 'Cancel it.' });
      await vi.waitFor(() => expect(agent.sendText).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(orchestrator.state).toBe('speaking'));
      expect(sent(ws).slice(2)).toEqual([{ type: 'Clear' }]);

      // Deepgram sent more of the cut sentence before it read the Clear, and answers that sentence's Flush: none of it
      // reaches the transport as the new reply, whose sentence waits for the Cleared.
      frame(ws, 3);
      control(ws, { type: 'Flushed', sequence_id: 0 });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(heard()).toEqual([1]);
      expect(sent(ws)).toHaveLength(3);

      control(ws, { type: 'Cleared', sequence_id: 0 });
      expect(sent(ws).slice(3)).toEqual([{ type: 'Speak', text: 'Cancelled.' }, { type: 'Flush' }]);
      frame(ws, 4);
      control(ws, { type: 'Flushed', sequence_id: 1 });
      await vi.waitFor(() => expect(heard()).toEqual([1, 4]));
    } finally {
      await orchestrator.stopSession('done');
    }
  });

  it('speaks the next reply on a fresh socket when Deepgram closed the idle one between replies, so the session listens again', async () => {
    const transport = Object.assign(new EventEmitter(), {
      id: 'transport-1',
      state: 'open' as const,
      sendAudio: vi.fn(async (_chunk: EncodedAudioChunk) => undefined),
      sendControl: vi.fn(async (_message: unknown) => undefined),
      close: vi.fn(),
    });
    const stt = Object.assign(new EventEmitter(), { pushAudio: vi.fn(), flush: vi.fn(async () => undefined), close: vi.fn() });
    const endpoint = Object.assign(new EventEmitter(), { mode: 'heuristic' as const, pushVadEvent: vi.fn(), pushTranscript: vi.fn(), reset: vi.fn() });
    const agent = {
      sendText: vi.fn((text: string) =>
        (async function* () {
          yield text === 'First?' ? 'One.' : 'Two.';
        })()
      ),
      abort: vi.fn(),
    };
    let session!: StreamingTTSSession;
    const orchestrator = new VoicePipelineOrchestrator({ stt: 'fake-stt', tts: tts.providerId, format: 'pcm' });
    await orchestrator.startSession(transport as unknown as IStreamTransport, agent, {
      streamingSTT: { providerId: 'fake-stt', isStreaming: true, startSession: async () => stt as unknown as StreamingSTTSession },
      streamingTTS: {
        providerId: tts.providerId,
        startSession: async (config?: StreamingTTSConfig) => (session = await tts.startSession(config)),
      },
      endpointDetector: endpoint as unknown as IEndpointDetector,
      bargeinHandler: { mode: 'hard-cut', handleBargein: () => ({ type: 'cancel' }) },
    });
    const ws = socketOf(session);
    /** The frames the transport was sent, by the value the server gave each. */
    const heard = (): number[] => transport.sendAudio.mock.calls.map(([chunk]) => chunk.audio[0]!);
    const ask = (transcript: string): void => {
      endpoint.emit('turn_complete', { transcript, confidence: 0.9, durationMs: 800, reason: 'silence_timeout' });
    };

    try {
      ask('First?');
      await vi.waitFor(() => expect(sent(ws)).toEqual([{ type: 'Speak', text: 'One.' }, { type: 'Flush' }]));
      frame(ws, 1);
      control(ws, { type: 'Flushed', sequence_id: 0 });
      await vi.waitFor(() => expect(orchestrator.state).toBe('listening'));
      expect(heard()).toEqual([1]);

      // Deepgram closes the idle socket between the replies; the next reply goes out on a fresh one.
      (ws as unknown as { readyState: number }).readyState = 3;
      ws.emit('close', 1011, Buffer.from(''));
      ask('Second?');
      let fresh!: MockSocket;
      await vi.waitFor(() => {
        fresh = socketOf(session);
        expect(fresh).toBeTruthy();
        expect(fresh).not.toBe(ws);
        expect(sent(fresh)).toEqual([{ type: 'Speak', text: 'Two.' }, { type: 'Flush' }]);
      });
      frame(fresh, 2);
      control(fresh, { type: 'Flushed', sequence_id: 0 });
      await vi.waitFor(() => expect(heard()).toEqual([1, 2]));
      // The reply ends, and the session listens again.
      await vi.waitFor(() => expect(orchestrator.state).toBe('listening'));
    } finally {
      await orchestrator.stopSession('done');
    }
  });
});
