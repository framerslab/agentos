/**
 * Unit tests for DeepgramStreamingSTT provider.
 *
 * Uses a mock WebSocket to simulate Deepgram's streaming API responses
 * without hitting the real service.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Must use factory that doesn't reference outer scope
vi.mock('ws', () => {
  const { EventEmitter: EE } = require('node:events');
  class MockWebSocket extends EE {
    static OPEN = 1;
    static CLOSED = 3;
    /** Per-test connect behavior; reset to 'open' after use. */
    static nextBehavior: 'open' | 'reject-400' = 'open';
    readyState = 1;
    send = vi.fn();
    close = vi.fn();
    terminate = vi.fn(() => { this.readyState = 3; });
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
              if (event === 'data') cb(Buffer.from('{"err_code":"BAD_REQUEST"}'));
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

import { DeepgramStreamingSTT } from '../providers/DeepgramStreamingSTT.js';
// Default import: the 'ws' types only expose WebSocket as the default export
// under this tsconfig (TS2595 on a named import). vi.mock supplies the same
// mock class for both the default and named bindings.
import MockedWs from 'ws';

const MockCtl = MockedWs as unknown as { nextBehavior: 'open' | 'reject-400' };

describe('DeepgramStreamingSTT', () => {
  let stt: DeepgramStreamingSTT;

  beforeEach(() => {
    stt = new DeepgramStreamingSTT({
      apiKey: 'test-key-123',
      model: 'nova-2',
    });
  });

  it('should have correct provider metadata', () => {
    expect(stt.providerId).toBe('deepgram-streaming');
    expect(stt.isStreaming).toBe(true);
  });

  it('should create a session that resolves on open', async () => {
    const session = await stt.startSession({ language: 'en-US' });
    expect(session).toBeDefined();
    expect(typeof session.pushAudio).toBe('function');
    expect(typeof session.flush).toBe('function');
    expect(typeof session.close).toBe('function');
  });

  it('should emit transcript events when receiving Results messages', async () => {
    const session = await stt.startSession();
    const transcriptListener = vi.fn();
    session.on('transcript', transcriptListener);

    // Simulate a Deepgram Results message via the mock WebSocket
    const ws = (session as any).ws;
    const resultsMsg = JSON.stringify({
      type: 'Results',
      channel_index: [0],
      duration: 1.5,
      start: 0,
      is_final: true,
      speech_final: false,
      channel: {
        alternatives: [
          {
            transcript: 'Hello world',
            confidence: 0.95,
            words: [
              { word: 'Hello', start: 0, end: 0.5, confidence: 0.97 },
              { word: 'world', start: 0.5, end: 1.0, confidence: 0.93 },
            ],
          },
        ],
      },
    });

    ws.emit('message', resultsMsg);

    expect(transcriptListener).toHaveBeenCalledOnce();
    const event = transcriptListener.mock.calls[0][0];
    expect(event.text).toBe('Hello world');
    expect(event.confidence).toBe(0.95);
    expect(event.isFinal).toBe(true);
    expect(event.words).toHaveLength(2);
    expect(event.words[0].word).toBe('Hello');
    expect(event.words[0].start).toBe(0); // 0 * 1000 = 0 ms
    expect(event.words[0].end).toBe(500); // 0.5 * 1000 = 500 ms
  });

  it('should emit speech_start on SpeechStarted event', async () => {
    const session = await stt.startSession();
    const speechStartListener = vi.fn();
    session.on('speech_start', speechStartListener);

    const ws = (session as any).ws;
    ws.emit('message', JSON.stringify({ type: 'SpeechStarted' }));

    expect(speechStartListener).toHaveBeenCalledOnce();
  });

  it('should emit speech_end when speech_final is true', async () => {
    const session = await stt.startSession();
    const speechEndListener = vi.fn();
    session.on('speech_end', speechEndListener);

    // First trigger speech_start
    const ws = (session as any).ws;
    ws.emit('message', JSON.stringify({ type: 'SpeechStarted' }));

    // Then a speech_final result
    ws.emit(
      'message',
      JSON.stringify({
        type: 'Results',
        channel_index: [0],
        duration: 1.0,
        start: 0,
        is_final: true,
        speech_final: true,
        channel: {
          alternatives: [{ transcript: 'Test.', confidence: 0.9, words: [] }],
        },
      })
    );

    expect(speechEndListener).toHaveBeenCalledOnce();
  });

  it('should convert Float32 PCM to Int16 and send via WebSocket', async () => {
    const session = await stt.startSession();
    const ws = (session as any).ws;

    session.pushAudio({
      samples: new Float32Array([0.5, -0.5, 1.0, -1.0]),
      sampleRate: 16000,
      timestamp: Date.now(),
    });

    expect(ws.send).toHaveBeenCalledOnce();
    const sentBuffer = ws.send.mock.calls[0][0];
    expect(Buffer.isBuffer(sentBuffer)).toBe(true);
    // 4 samples * 2 bytes each = 8 bytes
    expect(sentBuffer.byteLength).toBe(8);
  });

  it('REJECTS startSession (never hangs) when the server refuses the upgrade, carrying the HTTP body', async () => {
    // Regression: the old connect() ran emit('error') BEFORE reject() — with
    // no 'error' listener attached yet the emit threw, reject never ran, and
    // the promise never settled, hanging the orchestrator's startSession
    // await forever (the silent zombie voice sessions observed in prod).
    MockCtl.nextBehavior = 'reject-400';
    try {
      await expect(stt.startSession()).rejects.toThrow(/HTTP 400.*BAD_REQUEST/s);
    } finally {
      MockCtl.nextBehavior = 'open';
    }
  });

  it('defaults to nova-3 and leaves the training opt-out off', async () => {
    const defaults = new DeepgramStreamingSTT({ apiKey: 'test-key-123' });
    const session = await defaults.startSession({ language: 'en-US' });
    const params = new URL((session as any).ws.url).searchParams;
    expect(params.get('model')).toBe('nova-3');
    expect(params.has('mip_opt_out')).toBe(false);
  });

  it('sends mip_opt_out when the provider or a single session opts out', async () => {
    const optedOut = new DeepgramStreamingSTT({ apiKey: 'test-key-123', mipOptOut: true });
    const providerSession = await optedOut.startSession();
    expect(new URL((providerSession as any).ws.url).searchParams.get('mip_opt_out')).toBe('true');

    const sessionOnly = await stt.startSession({ providerOptions: { mip_opt_out: true } });
    expect(new URL((sessionOnly as any).ws.url).searchParams.get('mip_opt_out')).toBe('true');
  });

  it('sends keywords as plain keyterm values on nova-3 and as keywords on nova-2', async () => {
    const keywords = ['snuffleupagus:5', 'AC-42', 'customer service:1.5'];

    const nova3 = new DeepgramStreamingSTT({ apiKey: 'test-key-123' });
    const nova3Session = await nova3.startSession({ providerOptions: { keywords } });
    const nova3Params = new URL((nova3Session as any).ws.url).searchParams;
    expect(nova3Params.getAll('keyterm')).toEqual(['snuffleupagus', 'AC-42', 'customer service']);
    expect(nova3Params.has('keywords')).toBe(false);

    // The shared `stt` instance is configured with nova-2, which keeps `keywords`.
    const nova2Session = await stt.startSession({ providerOptions: { keywords } });
    const nova2Params = new URL((nova2Session as any).ws.url).searchParams;
    expect(nova2Params.getAll('keywords')).toEqual(keywords);
    expect(nova2Params.has('keyterm')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// KeepAlive while audio pauses (#585)
//
// Deepgram closes a streaming socket that receives neither audio nor a
// KeepAlive text frame within 10 s (NET-0001) and asks for one every 3–5 s
// while audio pauses. These tests pin the idle-reset schedule: every sent
// frame restarts the 3 s clock, a pause sends KeepAlive frames until frames
// return, and an ended session — closed, server-cut, or draining after
// CloseStream — arms nothing.
// ---------------------------------------------------------------------------

describe('DeepgramStreamingSTT – KeepAlive while audio pauses', () => {
  /** Text frames sent on the mock socket; audio frames are Buffers. */
  const textFrames = (ws: any): string[] =>
    ws.send.mock.calls.filter((call: unknown[]) => typeof call[0] === 'string').map((call: unknown[]) => call[0] as string);

  const KEEPALIVE = JSON.stringify({ type: 'KeepAlive' });

  /** Starts a session with the timers already faked, so every keepalive timer is fake. */
  const startSession = async () => {
    const session = await keepAliveStt.startSession({ language: 'en-US' });
    return { session, ws: (session as any).ws };
  };

  const frame = { samples: new Float32Array(160), sampleRate: 16000, timestamp: 0 };

  let keepAliveStt: DeepgramStreamingSTT;

  beforeEach(() => {
    keepAliveStt = new DeepgramStreamingSTT({ apiKey: 'test-key-123', model: 'nova-2' });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends a KeepAlive text frame once audio has paused for 3 seconds, and none before', async () => {
    const { session, ws } = await startSession();
    try {
      session.pushAudio(frame);
      vi.advanceTimersByTime(2_999);
      expect(textFrames(ws)).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(textFrames(ws)).toEqual([KEEPALIVE]);
    } finally {
      session.close();
    }
  });

  it('keeps sending a KeepAlive every 3 seconds through a continued pause', async () => {
    const { session, ws } = await startSession();
    try {
      session.pushAudio(frame);
      vi.advanceTimersByTime(3_000);
      expect(textFrames(ws)).toEqual([KEEPALIVE]);
      // The next one 3 seconds after the first, not sooner or later.
      vi.advanceTimersByTime(2_999);
      expect(textFrames(ws)).toEqual([KEEPALIVE]);
      vi.advanceTimersByTime(1);
      expect(textFrames(ws)).toEqual([KEEPALIVE, KEEPALIVE]);
      vi.advanceTimersByTime(3_000);
      expect(textFrames(ws)).toEqual([KEEPALIVE, KEEPALIVE, KEEPALIVE]);
    } finally {
      session.close();
    }
  });

  it('sends no KeepAlive while frames keep flowing', async () => {
    const { session, ws } = await startSession();
    try {
      for (let i = 0; i < 4; i++) {
        session.pushAudio(frame);
        vi.advanceTimersByTime(2_500);
      }
      expect(textFrames(ws)).toEqual([]);
      expect(ws.send).toHaveBeenCalledTimes(4); // only the audio frames
    } finally {
      session.close();
    }
  });

  it('restarts the idle clock when audio resumes, so the next KeepAlive waits for the new pause', async () => {
    const { session, ws } = await startSession();
    try {
      vi.advanceTimersByTime(2_500);
      session.pushAudio(frame); // restarts the 3 s clock
      vi.advanceTimersByTime(2_999); // 5.499 s in all, but 2.999 s since the frame
      expect(textFrames(ws)).toEqual([]);
      vi.advanceTimersByTime(1); // 3 s since the frame
      expect(textFrames(ws)).toEqual([KEEPALIVE]);
    } finally {
      session.close();
    }
  });

  it('sends 20 ms of silence, not a KeepAlive, when no audio has gone out 3 seconds after the socket opened', async () => {
    // Deepgram closes a socket that receives no audio within 10 seconds of opening, KeepAlive frames or not (NET-0001).
    const { session, ws } = await startSession();
    try {
      vi.advanceTimersByTime(2_999);
      expect(ws.send).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(textFrames(ws)).toEqual([]);
      expect(ws.send).toHaveBeenCalledTimes(1);
      const silence = ws.send.mock.calls[0][0] as Buffer;
      expect(Buffer.isBuffer(silence)).toBe(true);
      expect(silence.length).toBe(640); // 320 samples of PCM16 at 16 kHz
      expect(silence.every((byte) => byte === 0)).toBe(true);
      expect((session as any).audioSeconds).toBeCloseTo(0.02);
      // Audio has gone out now, so the pause goes on with KeepAlive frames.
      vi.advanceTimersByTime(3_000);
      expect(textFrames(ws)).toEqual([KEEPALIVE]);
      expect(ws.send).toHaveBeenCalledTimes(2);
    } finally {
      session.close();
    }
  });

  it('sends nothing after close(), however long the pause', async () => {
    const { session, ws } = await startSession();
    session.close();
    vi.advanceTimersByTime(30_000);
    expect(textFrames(ws)).toEqual([]);
  });

  it('sends nothing once the server has closed the socket', async () => {
    const { session, ws } = await startSession();
    try {
      vi.advanceTimersByTime(1_000);
      ws.emit('close');
      vi.advanceTimersByTime(30_000);
      expect(textFrames(ws)).toEqual([]);
    } finally {
      session.close();
    }
  });

  it('stops the idle timer when flush() sends CloseStream, so the drain sends no KeepAlive', async () => {
    const { session, ws } = await startSession();
    try {
      const flushing = session.flush();
      await vi.advanceTimersByTimeAsync(200);
      await flushing;
      vi.advanceTimersByTime(30_000);
      expect(textFrames(ws)).toEqual([JSON.stringify({ type: 'CloseStream' })]);
    } finally {
      session.close();
    }
  });

  it('sends no KeepAlive after flush() sent CloseStream, even when audio arrives during the drain and the socket stays open', async () => {
    const { session, ws } = await startSession();
    try {
      const flushing = session.flush();
      session.pushAudio(frame); // a wrapper forwarding audio after the flush
      await vi.advanceTimersByTimeAsync(200);
      await flushing;
      vi.advanceTimersByTime(30_000);
      expect(textFrames(ws)).toEqual([JSON.stringify({ type: 'CloseStream' })]);
    } finally {
      session.close();
    }
  });
});
