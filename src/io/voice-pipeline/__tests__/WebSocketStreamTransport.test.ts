/**
 * @module voice-pipeline/__tests__/WebSocketStreamTransport.spec
 *
 * Unit tests for {@link WebSocketStreamTransport}.
 *
 * A lightweight mock WebSocket is used in place of a real network socket,
 * allowing all WS events to be triggered synchronously via `emit()`.
 *
 * ## What is tested
 *
 * - Transport ID generation and initial state detection
 * - Inbound binary messages are decoded as AudioFrame and emitted as 'audio'
 * - Inbound text messages are parsed as JSON and emitted as 'message'
 * - sendAudio correctly sends EncodedAudioChunk.audio as binary
 * - sendAudio correctly converts AudioFrame.samples Float32Array to Buffer
 * - sendControl JSON-stringifies the message and sends as text
 * - WebSocket lifecycle events ('open', 'close', 'error') propagate correctly
 * - close() sets state to 'closing' and delegates to ws.close()
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { WebSocketStreamTransport } from '../WebSocketStreamTransport.js';
import type { AudioFrame, EncodedAudioChunk } from '../types.js';

// ---------------------------------------------------------------------------
// Mock WebSocket factory
// ---------------------------------------------------------------------------

/**
 * Creates a minimal WebSocket-like object sufficient for testing the transport.
 * Extends EventEmitter so WS lifecycle events can be triggered via `.emit()`.
 */
function createMockWS() {
  const ws = new EventEmitter() as any;
  ws.readyState = 1; // OPEN
  ws.send = vi.fn((_data: unknown, cb?: (err?: Error) => void) => {
    // Simulate synchronous success -- call back immediately with no error
    if (typeof cb === 'function') cb(undefined);
  });
  ws.close = vi.fn();
  ws.OPEN = 1;
  ws.CLOSED = 3;
  return ws;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Construct a transport with default config (16 kHz) around the given mock. */
function makeTransport(ws: ReturnType<typeof createMockWS>) {
  return new WebSocketStreamTransport(ws, { sampleRate: 16_000 });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WebSocketStreamTransport', () => {
  let ws: ReturnType<typeof createMockWS>;
  let transport: WebSocketStreamTransport;

  beforeEach(() => {
    ws = createMockWS();
    transport = makeTransport(ws);
  });

  // -------------------------------------------------------------------------
  // Identity and initial state
  // -------------------------------------------------------------------------

  it('should expose a non-empty string id (UUID)', () => {
    expect(typeof transport.id).toBe('string');
    expect(transport.id.length).toBeGreaterThan(0);
  });

  it('should start as "open" when the underlying WS readyState is OPEN (1)', () => {
    expect(transport.state).toBe('open');
  });

  it('should start as "connecting" when the underlying WS readyState is not OPEN', () => {
    const pendingWs = createMockWS();
    pendingWs.readyState = 0; // CONNECTING
    const t = new WebSocketStreamTransport(pendingWs, { sampleRate: 16_000 });
    expect(t.state).toBe('connecting');
  });

  // -------------------------------------------------------------------------
  // Inbound binary -> 'audio'
  // -------------------------------------------------------------------------

  /**
   * Binary WebSocket messages should be decoded as Float32Array PCM samples,
   * wrapped in an AudioFrame with the configured sampleRate, and emitted
   * as 'audio'.
   */
  it('should emit "audio" with correct AudioFrame when a binary message arrives', () => {
    const listener = vi.fn();
    transport.on('audio', listener);

    // Build a Float32Array and wrap it in a Buffer the way the ws library delivers it
    const samples = new Float32Array([0.1, -0.2, 0.3, -0.4]);
    const buf = Buffer.from(samples.buffer);

    ws.emit('message', buf);

    expect(listener).toHaveBeenCalledOnce();
    const frame: AudioFrame = listener.mock.calls[0][0];
    expect(frame).toHaveProperty('samples');
    expect(frame.sampleRate).toBe(16_000);
    expect(typeof frame.timestamp).toBe('number');
    expect(frame.samples).toBeInstanceOf(Float32Array);
    expect(frame.samples.length).toBe(4);
    // Verify the decoded values match the original samples
    expect(frame.samples[0]).toBeCloseTo(0.1);
    expect(frame.samples[2]).toBeCloseTo(0.3);
  });

  /**
   * `ws` v8+ pools its receive buffers, so a binary frame's Buffer can sit at
   * an arbitrary byteOffset. The old zero-copy Float32Array view threw
   * "RangeError: start offset of Float32Array should be a multiple of 4" on
   * non-aligned offsets (observed crashing live voice sessions as
   * uncaughtExceptions). The decode must copy into an aligned buffer.
   */
  it('should decode a binary frame whose Buffer sits at a non-4-aligned pool offset', () => {
    const listener = vi.fn();
    transport.on('audio', listener);

    // Simulate a pooled buffer: samples start 2 bytes into the backing store.
    const samples = new Float32Array([0.25, -0.75]);
    const backing = Buffer.alloc(2 + samples.byteLength);
    Buffer.from(samples.buffer).copy(backing, 2);
    const pooledView = backing.subarray(2); // byteOffset = 2 (not % 4)

    expect(() => ws.emit('message', pooledView)).not.toThrow();
    expect(listener).toHaveBeenCalledOnce();
    const frame: AudioFrame = listener.mock.calls[0][0];
    expect(frame.samples.length).toBe(2);
    expect(frame.samples[0]).toBeCloseTo(0.25);
    expect(frame.samples[1]).toBeCloseTo(-0.75);
  });

  // -------------------------------------------------------------------------
  // Inbound binary -> 'audio' (linear16 wire)
  // -------------------------------------------------------------------------

  /**
   * Browser capture worklets send raw signed 16-bit LE PCM. With
   * `inboundEncoding: 'linear16'` the transport must convert those bytes to
   * Float32 samples in [-1, 1] — interpreting them as Float32 (the old
   * behavior for every wire) yields garbage that transcribes as silence.
   */
  it('should decode Int16 PCM into Float32 samples when inboundEncoding is linear16', () => {
    const t = new WebSocketStreamTransport(ws, {
      sampleRate: 16_000,
      inboundEncoding: 'linear16',
    });
    const listener = vi.fn();
    t.on('audio', listener);

    const pcm = new Int16Array([16384, -16384, 32767, -32768]);
    ws.emit('message', Buffer.from(pcm.buffer));

    expect(listener).toHaveBeenCalledOnce();
    const frame: AudioFrame = listener.mock.calls[0][0];
    expect(frame.samples).toBeInstanceOf(Float32Array);
    expect(frame.samples.length).toBe(4);
    expect(frame.samples[0]).toBeCloseTo(0.5);
    expect(frame.samples[1]).toBeCloseTo(-0.5);
    expect(frame.samples[2]).toBeCloseTo(1.0, 2);
    expect(frame.samples[3]).toBeCloseTo(-1.0);
  });

  it('should truncate a trailing partial sample instead of throwing (linear16)', () => {
    const t = new WebSocketStreamTransport(ws, {
      sampleRate: 16_000,
      inboundEncoding: 'linear16',
    });
    const listener = vi.fn();
    t.on('audio', listener);

    // 5 bytes = 2 full Int16 samples + 1 dangling byte
    expect(() => ws.emit('message', Buffer.from([0, 64, 0, 192, 7]))).not.toThrow();
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0].samples.length).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Inbound text -> 'message'
  // -------------------------------------------------------------------------

  it('should emit "control" with parsed JSON when a text message arrives', () => {
    const listener = vi.fn();
    transport.on('message', listener);

    const payload = { type: 'message', action: { type: 'mute' } };
    ws.emit('message', JSON.stringify(payload));

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0]).toEqual(payload);
  });

  /**
   * `ws` v8+ delivers TEXT frames as Buffers with `isBinary === false` (never
   * as strings). The old `typeof data === 'string'` check routed every JSON
   * control frame into the binary/audio path as garbage samples. The
   * transport must honor the `isBinary` flag when the socket provides it.
   */
  it('should route a Buffer text frame (ws v8 isBinary=false) to "message", not "audio"', () => {
    const msgListener = vi.fn();
    const audioListener = vi.fn();
    transport.on('message', msgListener);
    transport.on('audio', audioListener);

    const payload = { type: 'barge_in', timestamp: 123 };
    ws.emit('message', Buffer.from(JSON.stringify(payload), 'utf-8'), false);

    expect(msgListener).toHaveBeenCalledOnce();
    expect(msgListener.mock.calls[0][0]).toEqual(payload);
    expect(audioListener).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // sendAudio -- EncodedAudioChunk
  // -------------------------------------------------------------------------

  /** The audio Buffer from an EncodedAudioChunk should be sent directly as binary. */
  it('should send the audio Buffer as binary when given an EncodedAudioChunk', async () => {
    const chunk: EncodedAudioChunk = {
      audio: Buffer.from([0xde, 0xad, 0xbe, 0xef]),
      format: 'opus',
      sampleRate: 24_000,
      durationMs: 20,
      text: 'hello',
    };

    await transport.sendAudio(chunk);

    expect(ws.send).toHaveBeenCalledOnce();
    const [sentData] = ws.send.mock.calls[0];
    expect(Buffer.isBuffer(sentData)).toBe(true);
    expect(sentData).toEqual(chunk.audio);
  });

  // -------------------------------------------------------------------------
  // sendAudio -- AudioFrame
  // -------------------------------------------------------------------------

  /** Float32Array samples should be converted to a raw byte Buffer before sending. */
  it('should convert Float32Array samples to Buffer and send binary when given an AudioFrame', async () => {
    const samples = new Float32Array([0.5, -0.5, 0.25]);
    const frame: AudioFrame = {
      samples,
      sampleRate: 16_000,
      timestamp: Date.now(),
    };

    await transport.sendAudio(frame);

    expect(ws.send).toHaveBeenCalledOnce();
    const [sentData] = ws.send.mock.calls[0];
    expect(Buffer.isBuffer(sentData)).toBe(true);
    // Each float32 sample is 4 bytes
    expect(sentData.byteLength).toBe(samples.byteLength);
  });

  // -------------------------------------------------------------------------
  // sendControl
  // -------------------------------------------------------------------------

  it('should JSON-stringify the message and send as a text frame', async () => {
    const msg = { type: 'session_started' as const, sessionId: 'abc', config: {} as any };

    await transport.sendControl(msg);

    expect(ws.send).toHaveBeenCalledOnce();
    const [sentData] = ws.send.mock.calls[0];
    expect(typeof sentData).toBe('string');
    expect(JSON.parse(sentData)).toEqual(msg);
  });

  // -------------------------------------------------------------------------
  // Lifecycle -- WS 'close' event
  // -------------------------------------------------------------------------

  it('should transition to "closed" and emit "close" when the WS closes', () => {
    const closeListener = vi.fn();
    transport.on('close', closeListener);

    ws.emit('close');

    expect(transport.state).toBe('closed');
    expect(closeListener).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Lifecycle -- WS 'error' event
  // -------------------------------------------------------------------------

  it('should re-emit socket errors as "error" events', () => {
    const errorListener = vi.fn();
    transport.on('error', errorListener);

    const socketError = new Error('ECONNRESET');
    ws.emit('error', socketError);

    expect(errorListener).toHaveBeenCalledOnce();
    expect(errorListener.mock.calls[0][0]).toBe(socketError);
  });

  // -------------------------------------------------------------------------
  // close()
  // -------------------------------------------------------------------------

  it('should set state to "closing" and delegate to ws.close()', () => {
    transport.close(1000, 'normal');

    expect(transport.state).toBe('closing');
    expect(ws.close).toHaveBeenCalledOnce();
    expect(ws.close).toHaveBeenCalledWith(1000, 'normal');
  });

  // -------------------------------------------------------------------------
  // WS 'open' event (late-open path)
  // -------------------------------------------------------------------------

  /**
   * When a transport is created before the WebSocket handshake completes,
   * the 'open' event should transition state to 'open' and emit 'open'.
   */
  it('should transition to "open" and emit "open" when WS fires its open event', () => {
    const pendingWs = createMockWS();
    pendingWs.readyState = 0; // CONNECTING
    const t = new WebSocketStreamTransport(pendingWs, { sampleRate: 16_000 });
    expect(t.state).toBe('connecting');

    const openListener = vi.fn();
    t.on('open', openListener);

    pendingWs.emit('open');

    expect(t.state).toBe('open');
    expect(openListener).toHaveBeenCalledOnce();
  });
});
