/**
 * Unit tests for ElevenLabsStreamingTTS provider.
 *
 * Uses a mock WebSocket to simulate ElevenLabs' streaming API responses. The
 * session sends one sentence segment at a time, each followed by the
 * end-of-stream message, and the `isFinal` that answers it completes the
 * segment: the last frame before it carries the segment's text boundary. A
 * spent socket is not reused; the next segment opens a new one.
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
/** The messages after the socket's initial one. */
const texts = (ws: MockSocket): Array<Record<string, unknown>> => sent(ws).slice(1);
/** One audio message from the server: one byte of audio, recognizable by `n`. */
const audio = (ws: MockSocket, n: number): void => {
  ws.emit('message', JSON.stringify({ audio: Buffer.from([n]).toString('base64') }));
};
/** The server's final message. */
const final = (ws: MockSocket): void => {
  ws.emit('message', JSON.stringify({ isFinal: true }));
};
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

  it('should send BOS message on connection', async () => {
    const session = await tts.startSession();
    const ws = (session as any).ws;

    // First call is the BOS (beginning of stream) message
    expect(ws.send).toHaveBeenCalledOnce();
    const bosMsg = JSON.parse(ws.send.mock.calls[0][0]);
    expect(bosMsg).toHaveProperty('text', ' ');
    expect(bosMsg).toHaveProperty('voice_settings');
    expect(bosMsg).toHaveProperty('generation_config');
  });

  it('sends a completed sentence as one text message followed by the end-of-stream message', async () => {
    const session = await tts.startSession();
    const [ws] = sockets();

    session.pushTokens('Hello ');
    expect(texts(ws)).toEqual([]);
    // The sentence is complete once whitespace has followed its mark.
    session.pushTokens('world! ');
    expect(texts(ws)).toEqual([{ text: 'Hello world!' }, { text: '' }]);
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
    expect(texts(ws)).toEqual([]);
    const flushPromise = session.flush();
    // The text, then the end-of-stream message.
    expect(texts(ws)).toEqual([{ text: 'Hello' }, { text: '' }]);

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
    expect(texts(first)).toEqual([]);
    session.pushTokens('ere. How are you');
    expect(texts(first)).toEqual([{ text: 'Hello there.' }, { text: '' }]);
    const flushed = session.flush();
    // The final segment waits for the one in flight: no second socket yet.
    expect(sockets()).toHaveLength(1);

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

    // The spent socket is closed, and the second segment goes out on a new one, after its initial message.
    await opened();
    expect(first.close).toHaveBeenCalledWith(1000, expect.any(String));
    const [, second] = sockets();
    expect(sent(second)[0]).toMatchObject({ text: ' ' });
    expect(texts(second)).toEqual([{ text: ' How are you' }, { text: '' }]);
    audio(second, 4);
    audio(second, 5);
    expect(chunks).toHaveLength(4);
    expect(chunks[3].textBoundary).toBeUndefined();
    expect(chunks[3].text).toBe(' How are you');
    final(second);
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
    expect(texts(first)).toEqual([{ text: 'One.' }, { text: '' }]);
    audio(first, 1);
    await opened();
    expect(sockets()).toHaveLength(1);
    final(first);
    await opened();
    expect(sockets()).toHaveLength(2);
    const [, second] = sockets();
    expect(texts(second)).toEqual([{ text: ' Two.' }, { text: '' }]);
    const flushed = session.flush();
    await opened();
    expect(sockets()).toHaveLength(2);
    final(second);
    await opened();
    expect(sockets()).toHaveLength(3);
    const [, , third] = sockets();
    expect(texts(third)).toEqual([{ text: ' Three' }, { text: '' }]);
    final(third);
    await flushed;
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
    expect(texts(first)).toEqual([{ text: 'First one.' }, { text: '' }]);
    audio(first, 1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(chunks).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    // A timeout is not completion: the held frame goes out with no boundary, and the segment counts as done.
    expect(chunks).toHaveLength(1);
    expect(chunks[0].audio[0]).toBe(1);
    expect(chunks[0].textBoundary).toBeUndefined();
    expect(flushes).not.toHaveBeenCalled();
    // The next segment opens a new socket at once; whatever the first socket still sends is dropped.
    await opened();
    expect(sockets()).toHaveLength(2);
    const [, second] = sockets();
    expect(texts(second)).toEqual([{ text: ' Second' }, { text: '' }]);
    audio(first, 9);
    final(first);
    expect(chunks).toHaveLength(1);
    expect(flushes).not.toHaveBeenCalled();
    audio(second, 2);
    final(second);
    expect(chunks).toHaveLength(2);
    expect(chunks[1].audio[0]).toBe(2);
    expect(chunks[1].textBoundary).toEqual({ segmentId: expect.any(String), start: 10, end: 17, text: ' Second', final: true });
    expect(flushes).toHaveBeenCalledOnce();
    await flushed;
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
    expect(texts(first)).toEqual([{ text: 'One.' }, { text: '' }]);
    final(first);
    expect(flushes).not.toHaveBeenCalled();
    await opened();
    const [, second] = sockets();
    expect(texts(second)).toEqual([{ text: ' Two.' }, { text: '' }]);
    final(second);
    expect(flushes).toHaveBeenCalledOnce();
    await flushed;
    expect(flushes).toHaveBeenCalledOnce();
  });

  it('reopens the socket for the next segment after the server closes it on isFinal', async () => {
    const session = await tts.startSession();
    const [first] = sockets();
    const closes = vi.fn();
    session.on('close', closes);

    session.pushTokens('One. Two');
    expect(texts(first)).toEqual([{ text: 'One.' }, { text: '' }]);
    final(first);
    // The server ends the stream: the session stays open and says nothing.
    first.emit('close');
    expect(closes).not.toHaveBeenCalled();
    await opened();
    expect(sockets()).toHaveLength(1);

    // The final segment opens a new socket, with its initial message first.
    const flushed = session.flush();
    await opened();
    expect(sockets()).toHaveLength(2);
    const [, second] = sockets();
    expect(sent(second)[0]).toMatchObject({ text: ' ', voice_settings: expect.any(Object), generation_config: expect.any(Object) });
    expect(texts(second)).toEqual([{ text: ' Two' }, { text: '' }]);
    final(second);
    await flushed;
    expect(closes).not.toHaveBeenCalled();
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
    expect(sent(second)[0]).toMatchObject({ text: ' ' });
    expect(texts(second)).toEqual([{ text: 'Next one.' }, { text: '' }]);
    expect(closes).not.toHaveBeenCalled();
  });

  it('ends the segment in flight without a boundary when its socket closes before isFinal, and goes on', async () => {
    const session = await tts.startSession();
    const [first] = sockets();
    const chunks = recorded(session);
    const closes = vi.fn();
    session.on('close', closes);

    session.pushTokens('One. Two. ');
    audio(first, 1);
    expect(chunks).toHaveLength(0);
    first.emit('close');
    // The held frame goes out without a boundary; the session is not closed; the next segment opens a new socket.
    expect(chunks).toHaveLength(1);
    expect(chunks[0].textBoundary).toBeUndefined();
    expect(closes).not.toHaveBeenCalled();
    await opened();
    expect(sockets()).toHaveLength(2);
    const [, second] = sockets();
    expect(texts(second)).toEqual([{ text: ' Two.' }, { text: '' }]);
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

  it("ends a segment whose new socket does not open within eight seconds without a boundary, reports the error, and goes on", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const session = await tts.startSession();
    const [first] = sockets();
    const chunks = recorded(session);
    const errors = vi.fn();
    session.on('error', errors);
    const closes = vi.fn();
    session.on('close', closes);

    session.pushTokens('One. Two. ');
    audio(first, 1);
    // The second segment's socket never opens; its five-second wait for isFinal has not begun, since no end-of-stream
    // message was sent.
    mock().behavior = 'hang';
    final(first);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].textBoundary).toEqual({ segmentId: expect.any(String), start: 0, end: 4, text: 'One.', final: true });
    expect(sockets()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(7_999);
    expect(errors).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    // The open is given up: the segment ends without a boundary, the error reaches the listener, the session stays open.
    expect(errors).toHaveBeenCalledOnce();
    expect((errors.mock.calls[0][0] as Error).message).toBe('elevenlabs ws connect timed out after 8000ms');
    expect(sockets()[1].close).toHaveBeenCalledOnce();
    expect(chunks).toHaveLength(1);
    expect(closes).not.toHaveBeenCalled();
    // The next segment opens a socket of its own.
    mock().behavior = 'open';
    session.pushTokens('Three. ');
    await opened();
    expect(sockets()).toHaveLength(3);
    expect(texts(sockets()[2])).toEqual([{ text: 'Three.' }, { text: '' }]);
  });
});
