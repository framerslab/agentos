/**
 * Unit tests for DeepgramStreamingSTT provider.
 *
 * Uses a mock WebSocket to simulate Deepgram's streaming API responses
 * without hitting the real service.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
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
import { WebSocket as MockedWs } from 'ws';

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
});
