/**
 * Unit tests for ElevenLabsStreamingTTS provider.
 *
 * Uses a mock WebSocket to simulate ElevenLabs' multi-context streaming API.
 * The session sends one sentence segment at a time, each as a context of its
 * own on the session's socket: the context's initial message with the
 * settings, its text with the flush flag, and its close. The context's
 * `isFinal` completes the segment, and the last frame before it carries the
 * segment's text boundary. A reply's sentences open no socket of their own; a
 * socket that fails a segment is reported as a warning, and the segment gets a
 * fresh one, once.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EncodedAudioChunk, StreamingTTSSession } from '../types.js';

vi.mock('ws', () => {
  const { EventEmitter: EE } = require('node:events');
  class MockWebSocket extends EE {
    static OPEN = 1;
    static CLOSED = 3;
    /** Every socket constructed, in order, so a test can read the one a later segment opened. */
    static instances: MockWebSocket[] = [];
    /** How the next sockets behave: 'open' opens on the next tick; 'hang' never opens, errors or closes. */
    static behavior: 'open' | 'hang' = 'open';
    readyState = 1;
    send = vi.fn();
    close = vi.fn();

    constructor() {
      super();
      MockWebSocket.instances.push(this);
      if (MockWebSocket.behavior === 'open') process.nextTick(() => this.emit('open'));
    }
  }
  return { default: MockWebSocket, WebSocket: MockWebSocket };
});

import { ElevenLabsStreamingTTS } from '../providers/ElevenLabsStreamingTTS.js';
import { PlayedTextTracker } from '../ttsTextBoundaries.js';
// Default import: the 'ws' types only expose WebSocket as the default export under this tsconfig.
import MockedWs from 'ws';

/** A mock socket the session opened. */
interface MockSocket {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  emit(event: string, ...args: unknown[]): boolean;
}

/** The mock's class-level controls: the sockets opened so far, in order, and how the next ones behave. */
const mock = (): { instances: MockSocket[]; behavior: 'open' | 'hang' } => MockedWs as unknown as { instances: MockSocket[]; behavior: 'open' | 'hang' };
/** The sockets the session has opened so far, in order. */
const sockets = (): MockSocket[] => mock().instances;
/** The JSON messages the session sent on the socket, in order. */
const sent = (ws: MockSocket): Array<Record<string, unknown>> => ws.send.mock.calls.map((call) => JSON.parse(call[0] as string));
/** One audio message from the server, of no context: one byte of audio, recognizable by `n`. */
const audio = (ws: MockSocket, n: number): void => {
  ws.emit('message', JSON.stringify({ audio: Buffer.from([n]).toString('base64') }));
};
/** The server's final message, of no context. */
const final = (ws: MockSocket): void => {
  ws.emit('message', JSON.stringify({ isFinal: true }));
};
/** One audio message of a context: one byte of audio, recognizable by `n`. */
const audioIn = (ws: MockSocket, contextId: string, n: number): void => {
  ws.emit('message', JSON.stringify({ audio: Buffer.from([n]).toString('base64'), contextId }));
};
/** The server's final message for a context, in the API reference's spelling or the guide's (`is_final`). */
const finalIn = (ws: MockSocket, contextId: string, key: 'isFinal' | 'is_final' = 'isFinal'): void => {
  ws.emit('message', JSON.stringify({ [key]: true, contextId }));
};
/** A context's three messages: its initial message with the settings, its text with the flush flag, and its close. */
const context = (text: string): Array<Record<string, unknown>> => [
  { text: ' ', voice_settings: expect.any(Object), generation_config: expect.any(Object), context_id: expect.any(String) },
  { text, context_id: expect.any(String), flush: true },
  { context_id: expect.any(String), close_context: true },
];
/** Lets a socket the session opened finish opening and take its first messages: the mock opens on the next tick. */
const opened = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));
/** The chunks the session emits from now on. */
const recorded = (session: StreamingTTSSession): EncodedAudioChunk[] => {
  const chunks: EncodedAudioChunk[] = [];
  session.on('audio', (chunk: EncodedAudioChunk) => chunks.push(chunk));
  return chunks;
};

describe('ElevenLabsStreamingTTS', () => {
  let tts: ElevenLabsStreamingTTS;

  beforeEach(() => {
    sockets().length = 0;
    mock().behavior = 'open';
    tts = new ElevenLabsStreamingTTS({
      apiKey: 'test-key-123',
      voiceId: 'test-voice-id',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should have correct provider metadata', () => {
    expect(tts.providerId).toBe('elevenlabs-streaming');
  });

  it('should create a session that resolves on open', async () => {
    const session = await tts.startSession({ voice: 'test-voice-id' });
    expect(session).toBeDefined();
    expect(typeof session.pushTokens).toBe('function');
    expect(typeof session.flush).toBe('function');
    expect(typeof session.cancel).toBe('function');
    expect(typeof session.close).toBe('function');
  });

  it("sends nothing at the open, and the voice and generation settings in the first message of each segment's context", async () => {
    const session = await tts.startSession();
    const [ws] = sockets();
    expect(ws.send).not.toHaveBeenCalled();

    session.pushTokens('Hello world! ');
    const [initial] = sent(ws);
    expect(initial).toMatchObject({ text: ' ', context_id: expect.any(String) });
    expect(initial.voice_settings).toEqual({ stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true });
    expect(initial.generation_config).toEqual({ chunk_length_schedule: [120, 160, 250, 290] });
  });

  it('sends a completed sentence as a context: its initial message, its text with the flush flag ending in a space, and its close', async () => {
    const session = await tts.startSession();
    const [ws] = sockets();

    session.pushTokens('Hello ');
    expect(sent(ws)).toEqual([]);
    // The sentence is complete once whitespace has followed its mark.
    session.pushTokens('world! ');
    expect(sent(ws)).toEqual(context('Hello world! '));
  });

  it('should emit audio events when receiving audio chunks', async () => {
    const session = await tts.startSession();
    const audioListener = vi.fn();
    session.on('audio', audioListener);

    const ws = (session as any).ws;
    // Simulate an audio response with base64-encoded data
    const fakeAudio = Buffer.from('fake-mp3-data').toString('base64');
    ws.emit(
      'message',
      JSON.stringify({
        audio: fakeAudio,
      })
    );

    // No segment is in flight: the frame goes out at once, without a boundary.
    expect(audioListener).toHaveBeenCalledOnce();
    const chunk = audioListener.mock.calls[0][0];
    expect(chunk.format).toBe('mp3');
    expect(chunk.sampleRate).toBe(44100);
    expect(Buffer.isBuffer(chunk.audio)).toBe(true);
    expect(chunk.durationMs).toBeGreaterThan(0);
    expect(chunk.textBoundary).toBeUndefined();
  });

  it('sends the final unterminated segment at flush, and emits flush_complete on its isFinal', async () => {
    const session = await tts.startSession();
    const flushListener = vi.fn();
    session.on('flush_complete', flushListener);
    const [ws] = sockets();

    session.pushTokens('Hello');
    expect(sent(ws)).toEqual([]);
    const flushPromise = session.flush();
    // The segment's context: its initial message, its text with the flush flag, its close.
    expect(sent(ws)).toEqual(context('Hello '));

    final(ws);
    await flushPromise;
    expect(flushListener).toHaveBeenCalledOnce();
  });

  it('should close the WebSocket on cancel', async () => {
    const session = await tts.startSession();
    const ws = (session as any).ws;

    session.cancel();

    expect(ws.close).toHaveBeenCalledOnce();
  });

  it("attaches the segment's boundary to the last frame its terminal response proves complete, and to no earlier frame", async () => {
    const session = await tts.startSession();
    const [first] = sockets();
    const chunks = recorded(session);
    const flushes = vi.fn();
    session.on('flush_complete', flushes);

    // The first sentence goes out whole, as soon as it is complete, before any text of the second.
    session.pushTokens('Hello th');
    expect(sent(first)).toEqual([]);
    session.pushTokens('ere. How are you');
    expect(sent(first)).toEqual(context('Hello there. '));
    const flushed = session.flush();
    // The final segment waits for the one in flight: its context is not sent yet.
    expect(sent(first)).toHaveLength(3);

    audio(first, 1);
    audio(first, 2);
    audio(first, 3);
    // The newest frame is held: isFinal decides whether it is the segment's last.
    expect(chunks.map((chunk) => chunk.audio[0])).toEqual([1, 2]);
    expect(chunks.map((chunk) => chunk.textBoundary)).toEqual([undefined, undefined]);
    // The legacy text field is the text of the segment in flight.
    expect(chunks.map((chunk) => chunk.text)).toEqual(['Hello there.', 'Hello there.']);
    final(first);
    expect(chunks).toHaveLength(3);
    expect(chunks[2].audio[0]).toBe(3);
    expect(chunks[2].textBoundary).toEqual({ segmentId: expect.any(String), start: 0, end: 12, text: 'Hello there.', final: true });
    expect(flushes).not.toHaveBeenCalled();

    // The second segment follows as the next context on the same socket, which stays open.
    expect(first.close).not.toHaveBeenCalled();
    expect(sockets()).toHaveLength(1);
    expect(sent(first).slice(3)).toEqual(context(' How are you '));
    audio(first, 4);
    audio(first, 5);
    expect(chunks).toHaveLength(4);
    expect(chunks[3].textBoundary).toBeUndefined();
    expect(chunks[3].text).toBe(' How are you');
    final(first);
    expect(chunks).toHaveLength(5);
    expect(chunks[4].audio[0]).toBe(5);
    expect(chunks[4].textBoundary).toEqual({ segmentId: expect.any(String), start: 12, end: 24, text: ' How are you', final: true });
    // One flush, one flush_complete, after the last segment's terminal response; the promise resolves then.
    expect(flushes).toHaveBeenCalledOnce();
    await flushed;
  });

  it('sends the next segment only after the terminal response of the one before it', async () => {
    const session = await tts.startSession();
    const [first] = sockets();

    session.pushTokens('One. Two. Three');
    expect(sent(first)).toEqual(context('One. '));
    audio(first, 1);
    await opened();
    expect(sent(first)).toHaveLength(3);
    final(first);
    expect(sent(first).slice(3)).toEqual(context(' Two. '));
    const flushed = session.flush();
    await opened();
    expect(sent(first)).toHaveLength(6);
    final(first);
    expect(sent(first).slice(6)).toEqual(context(' Three '));
    final(first);
    await flushed;
    expect(sockets()).toHaveLength(1);
  });

  it('emits the held frame without a boundary when the terminal response does not come within five seconds, and goes on', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const session = await tts.startSession();
    const [first] = sockets();
    const chunks = recorded(session);
    const flushes = vi.fn();
    session.on('flush_complete', flushes);

    session.pushTokens('First one. Second');
    const flushed = session.flush();
    expect(sent(first)).toEqual(context('First one. '));
    const c1 = sent(first)[1].context_id as string;
    audioIn(first, c1, 1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(chunks).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    // A timeout is not completion: the held frame goes out with no boundary, and the segment counts as done.
    expect(chunks).toHaveLength(1);
    expect(chunks[0].audio[0]).toBe(1);
    expect(chunks[0].textBoundary).toBeUndefined();
    expect(flushes).not.toHaveBeenCalled();
    // The next segment's context is not sent yet: the sentence's isFinal, and the rest of its audio, may still come,
    // and the next segment waits for them so the audio arrives whole and in order.
    await opened();
    expect(sent(first)).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent(first)).toHaveLength(3);
    // The late frames of that context go out at once, in order, without a boundary.
    audioIn(first, c1, 9);
    audioIn(first, c1, 10);
    expect(chunks.map((chunk) => [chunk.audio[0], chunk.textBoundary])).toEqual([
      [1, undefined],
      [9, undefined],
      [10, undefined],
    ]);
    // Its late isFinal completes nothing, and lets the next segment's context go out, on the same socket.
    finalIn(first, c1);
    expect(chunks).toHaveLength(3);
    expect(flushes).not.toHaveBeenCalled();
    expect(sent(first).slice(3)).toEqual(context(' Second '));
    const c2 = sent(first)[4].context_id as string;
    audioIn(first, c2, 2);
    finalIn(first, c2);
    expect(chunks).toHaveLength(4);
    expect(chunks[3].audio[0]).toBe(2);
    expect(chunks[3].textBoundary).toEqual({ segmentId: expect.any(String), start: 10, end: 17, text: ' Second', final: true });
    expect(flushes).toHaveBeenCalledOnce();
    await flushed;
    expect(sockets()).toHaveLength(1);
  });

  it('starts the next segment once the bounded wait for the late isFinal of a timed-out segment ends', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const session = await tts.startSession();
    const [first] = sockets();
    const chunks = recorded(session);

    session.pushTokens('First one. Second');
    const flushed = session.flush();
    const c1 = sent(first)[1].context_id as string;
    audioIn(first, c1, 1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(chunks).toHaveLength(1);
    // No isFinal comes for five more seconds: the next segment's context goes out anyway, on the same socket.
    await vi.advanceTimersByTimeAsync(4_999);
    expect(sent(first)).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent(first).slice(3)).toEqual(context(' Second '));
    const c2 = sent(first)[4].context_id as string;
    // What the timed-out context still sends is nobody's: dropped.
    audioIn(first, c1, 9);
    finalIn(first, c1);
    expect(chunks).toHaveLength(1);
    audioIn(first, c2, 2);
    finalIn(first, c2);
    expect(chunks).toHaveLength(2);
    expect(chunks[1].textBoundary).toEqual({ segmentId: expect.any(String), start: 10, end: 17, text: ' Second', final: true });
    await flushed;
    expect(sockets()).toHaveLength(1);
  });

  it("starts the next reply at once, and drops what a timed-out context of the reply before still sends, once the next reply's text arrives", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const session = await tts.startSession();
    const [first] = sockets();
    const chunks = recorded(session);

    // The reply's one sentence times out: its held frame goes out without a boundary, and its flush completes.
    session.pushTokens('Hello there.');
    const flushed = session.flush();
    const c1 = sent(first)[1].context_id as string;
    audioIn(first, c1, 1);
    await vi.advanceTimersByTimeAsync(5_000);
    await flushed;
    expect(chunks.map((chunk) => [chunk.audio[0], chunk.textBoundary])).toEqual([[1, undefined]]);
    // While the reply is still the session's, the context's late audio goes out, so the listener hears it whole.
    audioIn(first, c1, 2);
    expect(chunks).toHaveLength(2);
    // The next reply's text: its context goes out at once, and what the timed-out context still sends belongs to the
    // reply before, so it never goes out as this reply's audio.
    session.pushTokens('Next one. ');
    expect(sent(first).slice(3)).toEqual(context('Next one. '));
    const c2 = sent(first)[4].context_id as string;
    audioIn(first, c1, 3);
    finalIn(first, c1);
    expect(chunks).toHaveLength(2);
    audioIn(first, c2, 4);
    finalIn(first, c2);
    expect(chunks.map((chunk) => [chunk.audio[0], chunk.textBoundary?.text])).toEqual([
      [1, undefined],
      [2, undefined],
      [4, 'Next one.'],
    ]);
    expect(sockets()).toHaveLength(1);
  });

  it('attaches nothing to a frame after a cancel, and a late terminal response emits nothing', async () => {
    const session = await tts.startSession();
    const [first] = sockets();
    const chunks = recorded(session);
    const flushes = vi.fn();
    session.on('flush_complete', flushes);
    const closes = vi.fn();
    session.on('close', closes);

    session.pushTokens('Hello there. ');
    audio(first, 1);
    const flushed = session.flush();
    session.cancel();
    // The held frame is dropped with the socket; the frames and the final message that still arrive on it are not
    // the session's any more.
    expect(first.close).toHaveBeenCalledOnce();
    expect(chunks).toHaveLength(0);
    audio(first, 2);
    final(first);
    expect(chunks).toHaveLength(0);
    expect(flushes).not.toHaveBeenCalled();
    // The flush that the cancel cut resolves without flush_complete, and the session is not closed.
    await flushed;
    expect(flushes).not.toHaveBeenCalled();
    expect(closes).not.toHaveBeenCalled();
  });

  it('emits flush_complete once per flush, not once per segment', async () => {
    const session = await tts.startSession();
    const [first] = sockets();
    const flushes = vi.fn();
    session.on('flush_complete', flushes);

    session.pushTokens('One. Two. ');
    const flushed = session.flush();
    expect(sent(first)).toEqual(context('One. '));
    final(first);
    expect(flushes).not.toHaveBeenCalled();
    expect(sent(first).slice(3)).toEqual(context(' Two. '));
    final(first);
    expect(flushes).toHaveBeenCalledOnce();
    await flushed;
    expect(flushes).toHaveBeenCalledOnce();
  });

  it('proves a sentence played only with its isFinal and the acknowledgement of its last frame, never with an earlier one', async () => {
    const session = await tts.startSession();
    const [first] = sockets();
    // A consumer that records each chunk under its place in the stream, as a transport's playback sequence names it.
    const played = new PlayedTextTracker();
    const chunks: EncodedAudioChunk[] = [];
    session.on('audio', (chunk: EncodedAudioChunk) => {
      chunks.push(chunk);
      played.sent(chunks.length, chunk.textBoundary);
    });

    session.pushTokens('Your order shipped.');
    const flushed = session.flush();
    expect(sent(first)).toEqual(context('Your order shipped. '));
    audio(first, 1);
    audio(first, 2);
    audio(first, 3);
    // Two frames are out, each with the whole sentence as its legacy text, and the first is acknowledged as played:
    // no sentence is proven, so the whole sentence stays unheard.
    expect(chunks.map((chunk) => chunk.text)).toEqual(['Your order shipped.', 'Your order shipped.']);
    played.acknowledged(1);
    expect(played.playedText).toBe('');
    // The isFinal puts the boundary on the last frame alone; acknowledging the frames before it still proves nothing.
    final(first);
    await flushed;
    expect(chunks.map((chunk) => chunk.textBoundary?.text)).toEqual([undefined, undefined, 'Your order shipped.']);
    played.acknowledged(2);
    expect(played.playedText).toBe('');
    played.acknowledged(3);
    expect(played.playedText).toBe('Your order shipped.');
  });

  it('opens a new socket for the next segment after the server closes the idle one between segments, with no warning', async () => {
    const session = await tts.startSession();
    const [first] = sockets();
    const closes = vi.fn();
    session.on('close', closes);
    const warnings = vi.fn();
    session.on('warning', warnings);

    session.pushTokens('One. Two');
    expect(sent(first)).toEqual(context('One. '));
    final(first);
    // The server ends the idle socket: the session stays open and says nothing.
    first.emit('close', 1000, Buffer.from(''));
    expect(closes).not.toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();
    await opened();
    expect(sockets()).toHaveLength(1);

    // The final segment opens a new socket, and goes out on it as a context of its own.
    const flushed = session.flush();
    await opened();
    expect(sockets()).toHaveLength(2);
    const [, second] = sockets();
    expect(sent(second)).toEqual(context(' Two '));
    final(second);
    await flushed;
    expect(closes).not.toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();
  });

  it('stays usable after a cancel: the next segment opens a new socket', async () => {
    const session = await tts.startSession();
    const [first] = sockets();
    const closes = vi.fn();
    session.on('close', closes);

    session.pushTokens('Hello there. ');
    session.cancel();
    expect(first.close).toHaveBeenCalledOnce();

    session.pushTokens('Next one. ');
    await opened();
    expect(sockets()).toHaveLength(2);
    const [, second] = sockets();
    expect(sent(second)).toEqual(context('Next one. '));
    expect(closes).not.toHaveBeenCalled();
  });

  it("writes one console warning line for a segment's failure when nothing listens for warning, and speaks the segment again all the same", async () => {
    const session = await tts.startSession();
    const [first] = sockets();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      session.pushTokens('One. Two. ');
      first.emit('close', 1011, Buffer.from(''));
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][0]).toContain("[elevenlabs-streaming] elevenlabs ws closed before the segment's isFinal (code 1011)");
      await opened();
      expect(sockets()).toHaveLength(2);
      expect(sent(sockets()[1])).toEqual(context('One. '));
    } finally {
      warn.mockRestore();
    }
  });

  it('emits close once, from close() alone', async () => {
    const session = await tts.startSession();
    const [first] = sockets();
    const closes = vi.fn();
    session.on('close', closes);

    session.close();
    expect(first.close).toHaveBeenCalledOnce();
    expect(closes).toHaveBeenCalledOnce();
    first.emit('close');
    expect(closes).toHaveBeenCalledOnce();
  });

  it('rejects startSession when the socket does not open within eight seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mock().behavior = 'hang';
    const starting = tts.startSession();
    const rejected = expect(starting).rejects.toThrow('elevenlabs ws connect timed out after 8000ms');
    await vi.advanceTimersByTimeAsync(7_999);
    expect(sockets()[0].close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    // The socket that never opened is closed, so it does not linger.
    expect(sockets()[0].close).toHaveBeenCalledOnce();
  });

  it("gives a segment whose socket does not open within eight seconds a fresh socket, with a warning naming the timeout, and ends the reply when that one does not open either", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const session = await tts.startSession();
    const [first] = sockets();
    const chunks = recorded(session);
    const warnings = vi.fn();
    session.on('warning', warnings);
    const errors = vi.fn();
    session.on('error', errors);
    const closes = vi.fn();
    session.on('close', closes);
    const flushes = vi.fn();
    session.on('flush_complete', flushes);

    // The server closed the idle socket between replies; the next reply's socket never opens.
    first.emit('close', 1000, Buffer.from(''));
    mock().behavior = 'hang';
    session.pushTokens('One. Two. ');
    const flushed = session.flush();
    expect(sockets()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(7_999);
    expect(warnings).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    // The open is given up and the socket closed, as a warning and never the session's error; the segment gets a
    // fresh socket.
    expect(errors).not.toHaveBeenCalled();
    expect(warnings).toHaveBeenCalledOnce();
    expect((warnings.mock.calls[0][0] as Error).message).toContain('elevenlabs ws connect timed out after 8000ms');
    expect(sockets()[1].close).toHaveBeenCalledOnce();
    expect(sockets()).toHaveLength(3);
    // That one does not open either: the reply ends with a second warning, its flush completes, the session stays.
    await vi.advanceTimersByTimeAsync(8_000);
    expect(warnings).toHaveBeenCalledTimes(2);
    expect(sockets()[2].close).toHaveBeenCalledOnce();
    expect(sockets()).toHaveLength(3);
    await flushed;
    expect(flushes).toHaveBeenCalledOnce();
    expect(chunks).toHaveLength(0);
    expect(errors).not.toHaveBeenCalled();
    expect(closes).not.toHaveBeenCalled();
  });

  it('reports a socket that closes before it opens, with no error event, as a warning naming the close code, and gives the segment a fresh socket', async () => {
    const session = await tts.startSession();
    const [first] = sockets();
    const warnings = vi.fn();
    session.on('warning', warnings);
    const errors = vi.fn();
    session.on('error', errors);

    first.emit('close', 1000, Buffer.from(''));
    mock().behavior = 'hang';
    session.pushTokens('One. ');
    expect(sockets()).toHaveLength(2);
    sockets()[1].emit('close', 1006, Buffer.from(''));
    await opened();
    expect(errors).not.toHaveBeenCalled();
    expect(warnings).toHaveBeenCalledOnce();
    expect((warnings.mock.calls[0][0] as Error).message).toContain('elevenlabs ws closed before it opened (code 1006)');
    expect(sockets()).toHaveLength(3);
    sockets()[2].emit('open');
    await opened();
    expect(sent(sockets()[2])).toEqual(context('One. '));
  });

  it('speaks the segments of a reply on one socket, each as a flushed context of its own, and opens no socket per sentence', async () => {
    const session = await tts.startSession();
    const [first] = sockets();
    const chunks = recorded(session);
    const flushes = vi.fn();
    session.on('flush_complete', flushes);

    session.pushTokens('Hello there. How are you');
    // The first sentence is a context of its own on the session's socket: its initial message with the settings, its
    // text with the flush flag, ending with a space as ElevenLabs asks, and its close.
    expect(sent(first)).toEqual(context('Hello there. '));
    const c1 = sent(first)[1].context_id as string;
    expect(sent(first)[0].context_id).toBe(c1);
    expect(sent(first)[2].context_id).toBe(c1);
    const flushed = session.flush();
    // The context's audio, then its final message, which proves the segment's last frame.
    audioIn(first, c1, 1);
    audioIn(first, c1, 2);
    expect(chunks.map((chunk) => chunk.audio[0])).toEqual([1]);
    finalIn(first, c1);
    expect(chunks).toHaveLength(2);
    expect(chunks[1].textBoundary).toEqual({ segmentId: expect.any(String), start: 0, end: 12, text: 'Hello there.', final: true });
    // The second segment follows on the same socket as the next context: no socket is opened, none closed.
    await opened();
    expect(sockets()).toHaveLength(1);
    expect(first.close).not.toHaveBeenCalled();
    expect(sent(first).slice(3)).toEqual(context(' How are you '));
    const c2 = sent(first)[4].context_id as string;
    expect(c2).not.toBe(c1);
    audioIn(first, c2, 3);
    // The guide spells the final message is_final; the reference isFinal. Both complete the context.
    finalIn(first, c2, 'is_final');
    expect(chunks).toHaveLength(3);
    expect(chunks[2].textBoundary).toEqual({ segmentId: expect.any(String), start: 12, end: 24, text: ' How are you', final: true });
    expect(flushes).toHaveBeenCalledOnce();
    await flushed;
  });

  it('retries a segment whose socket fails to open once, on a fresh socket, with a warning and no error', async () => {
    const session = await tts.startSession();
    const [first] = sockets();
    const chunks = recorded(session);
    const warnings = vi.fn();
    session.on('warning', warnings);
    const errors = vi.fn();
    session.on('error', errors);
    const closes = vi.fn();
    session.on('close', closes);

    // The server closed the idle socket between replies, which is no failure; the next reply opens one, which
    // ElevenLabs refuses (its concurrency limit, reached by other sessions).
    first.emit('close', 1000, Buffer.from(''));
    expect(warnings).not.toHaveBeenCalled();
    mock().behavior = 'hang';
    session.pushTokens('One. Two. ');
    expect(sockets()).toHaveLength(2);
    sockets()[1].emit('error', new Error('Unexpected server response: 429'));
    sockets()[1].emit('close', 1006, Buffer.from(''));
    await opened();
    // The failed open is a warning naming the cause, never the session's error, and the segment gets a fresh socket.
    expect(errors).not.toHaveBeenCalled();
    expect(warnings).toHaveBeenCalledOnce();
    expect((warnings.mock.calls[0][0] as Error).message).toContain('Unexpected server response: 429');
    expect(closes).not.toHaveBeenCalled();
    expect(sockets()).toHaveLength(3);
    const third = sockets()[2];
    third.emit('open');
    await opened();
    expect(sent(third)).toEqual(context('One. '));
    const c1 = sent(third)[1].context_id as string;
    audioIn(third, c1, 1);
    finalIn(third, c1);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].textBoundary).toEqual({ segmentId: expect.any(String), start: 0, end: 4, text: 'One.', final: true });
    // The next segment follows on that socket.
    expect(sent(third).slice(3)).toEqual(context(' Two. '));
    expect(warnings).toHaveBeenCalledOnce();
  });

  it("ends the reply, never the session, when a segment's socket fails to open twice: a second warning, the rest of the reply dropped, its flush complete", async () => {
    const session = await tts.startSession();
    const [first] = sockets();
    const chunks = recorded(session);
    const warnings = vi.fn();
    session.on('warning', warnings);
    const errors = vi.fn();
    session.on('error', errors);
    const closes = vi.fn();
    session.on('close', closes);
    const flushes = vi.fn();
    session.on('flush_complete', flushes);

    first.emit('close', 1000, Buffer.from(''));
    mock().behavior = 'hang';
    session.pushTokens('One. Two. ');
    expect(sockets()).toHaveLength(2);
    sockets()[1].emit('error', new Error('Unexpected server response: 429'));
    sockets()[1].emit('close', 1006, Buffer.from(''));
    await opened();
    expect(sockets()).toHaveLength(3);
    sockets()[2].emit('error', new Error('Unexpected server response: 429'));
    sockets()[2].emit('close', 1006, Buffer.from(''));
    await opened();
    // The second failure ends the reply: a second warning, no error, no close, no further socket for its segments.
    expect(errors).not.toHaveBeenCalled();
    expect(warnings).toHaveBeenCalledTimes(2);
    expect(closes).not.toHaveBeenCalled();
    expect(sockets()).toHaveLength(3);
    // The rest of the reply's text is dropped, and its flush completes, so the session goes on to the next turn.
    session.pushTokens('Three. ');
    await opened();
    expect(sockets()).toHaveLength(3);
    const flushed = session.flush();
    await flushed;
    expect(flushes).toHaveBeenCalledOnce();
    expect(chunks).toHaveLength(0);
    // The next reply is spoken: its first segment opens a socket of its own.
    mock().behavior = 'open';
    session.pushTokens('Four. ');
    await opened();
    expect(sockets()).toHaveLength(4);
    expect(sent(sockets()[3])).toEqual(context('Four. '));
    expect(warnings).toHaveBeenCalledTimes(2);
  });

  it("reports the socket closing before a segment's isFinal as a warning naming the close code, and speaks the segment again on a fresh socket", async () => {
    const session = await tts.startSession();
    const [first] = sockets();
    const chunks = recorded(session);
    const warnings = vi.fn();
    session.on('warning', warnings);
    const errors = vi.fn();
    session.on('error', errors);
    const closes = vi.fn();
    session.on('close', closes);

    session.pushTokens('Your order shipped. It arrives Monday. ');
    const c1 = sent(first)[1].context_id as string;
    audioIn(first, c1, 1);
    audioIn(first, c1, 2);
    // The server closes the socket mid-sentence: the frame the segment held goes out without a boundary, and the close is
    // reported with its code, as a warning and never the session's error.
    first.emit('close', 1011, Buffer.from('internal error'));
    expect(errors).not.toHaveBeenCalled();
    expect(warnings).toHaveBeenCalledOnce();
    expect((warnings.mock.calls[0][0] as Error).message).toBe(
      "elevenlabs ws closed before the segment's isFinal (code 1011: internal error); the segment is spoken again on a fresh socket"
    );
    expect(closes).not.toHaveBeenCalled();
    expect(chunks.map((chunk) => [chunk.audio[0], chunk.textBoundary])).toEqual([[1, undefined], [2, undefined]]);
    // The sentence is spoken again, whole, on a fresh socket, as a context of its own, and proven by its own isFinal.
    await opened();
    expect(sockets()).toHaveLength(2);
    const [, second] = sockets();
    expect(sent(second)).toEqual(context('Your order shipped. '));
    const c2 = sent(second)[1].context_id as string;
    audioIn(second, c2, 3);
    finalIn(second, c2);
    expect(chunks).toHaveLength(3);
    expect(chunks[2].textBoundary).toEqual({ segmentId: expect.any(String), start: 0, end: 19, text: 'Your order shipped.', final: true });
    // The next segment follows on that socket.
    expect(sent(second).slice(3)).toEqual(context(' It arrives Monday. '));
    expect(warnings).toHaveBeenCalledOnce();
  });

  it('ends the reply when the segment spoken again after a close fails a second time, on the open of its fresh socket', async () => {
    const session = await tts.startSession();
    const [first] = sockets();
    const chunks = recorded(session);
    const warnings = vi.fn();
    session.on('warning', warnings);
    const errors = vi.fn();
    session.on('error', errors);
    const closes = vi.fn();
    session.on('close', closes);
    const flushes = vi.fn();
    session.on('flush_complete', flushes);

    session.pushTokens('One. Two. ');
    const flushed = session.flush();
    const c1 = sent(first)[1].context_id as string;
    audioIn(first, c1, 1);
    // The first failure: the socket closes before the sentence's isFinal. The second: its fresh socket is refused.
    mock().behavior = 'hang';
    first.emit('close', 1011, Buffer.from('internal error'));
    expect(warnings).toHaveBeenCalledOnce();
    expect(sockets()).toHaveLength(2);
    sockets()[1].emit('error', new Error('connect ECONNREFUSED'));
    sockets()[1].emit('close', 1006, Buffer.from(''));
    await opened();
    // The reply ends with a second warning: the segments still queued are dropped, the flush completes, the session stays.
    expect(errors).not.toHaveBeenCalled();
    expect(warnings).toHaveBeenCalledTimes(2);
    expect((warnings.mock.calls[1][0] as Error).message).toContain('connect ECONNREFUSED');
    expect(closes).not.toHaveBeenCalled();
    expect(sockets()).toHaveLength(2);
    await flushed;
    expect(flushes).toHaveBeenCalledOnce();
    expect(chunks.map((chunk) => [chunk.audio[0], chunk.textBoundary])).toEqual([[1, undefined]]);
  });
});
