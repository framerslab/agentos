/**
 * Unit tests for DeepgramAuraStreamingTTS.
 *
 * Uses a mock WebSocket to simulate Deepgram Aura's streaming /v1/speak API.
 * Deepgram returns audio as BINARY frames and sends control as text JSON
 * ({ type: 'Flushed' | 'Cleared' | 'Metadata' | ... }).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
// Default import: the 'ws' types only expose WebSocket as the default export
// under this tsconfig (TS2595 on a named import). vi.mock supplies the same
// mock class for both the default and named bindings.
import MockedWs from 'ws';

const MockCtl = MockedWs as unknown as { nextBehavior: 'open' | 'reject-400' };

describe('DeepgramAuraStreamingTTS', () => {
  let tts: DeepgramAuraStreamingTTS;

  beforeEach(() => {
    tts = new DeepgramAuraStreamingTTS({ apiKey: 'dg-key', voice: 'aura-2-thalia-en' });
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

  it('sends a Speak control message on pushTokens', async () => {
    const session = await tts.startSession();
    const ws = (session as any).ws;
    ws.send.mockClear();
    session.pushTokens('Hello there');
    expect(ws.send).toHaveBeenCalledOnce();
    expect(JSON.parse(ws.send.mock.calls[0][0])).toEqual({ type: 'Speak', text: 'Hello there' });
  });

  it('always dials the streaming WS with encoding=linear16 (mp3 is REST-only and 400s)', async () => {
    // Default session format is 'mp3' — the WIRE must still be linear16:
    // Deepgram rejects `encoding=mp3` on /v1/speak streaming upgrades with
    // HTTP 400 UNSUPPORTED_AUDIO_FORMAT (expected one of linear16|mulaw|alaw).
    const session = await tts.startSession();
    const url: string = (session as any).ws.url;
    expect(url).toContain('encoding=linear16');
    expect(url).toContain('sample_rate=24000');
    expect(url).not.toContain('encoding=mp3');
  });

  it('WAV-wraps binary chunks for compressed-format callers so per-chunk decodeAudioData works', async () => {
    const session = await tts.startSession(); // default format 'mp3' → wav container
    const listener = vi.fn();
    session.on('audio', listener);
    session.pushTokens('hi');

    const ws = (session as any).ws;
    ws.emit('message', Buffer.from([1, 2, 3, 4]), true); // binary linear16 frame

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
    expect(chunk.text).toBe('hi');
  });

  it('passes raw PCM through untouched when the caller explicitly asked for pcm', async () => {
    const session = await tts.startSession({ format: 'pcm' });
    const listener = vi.fn();
    session.on('audio', listener);

    const ws = (session as any).ws;
    ws.emit('message', Buffer.from([1, 2, 3, 4]), true);

    expect(listener).toHaveBeenCalledOnce();
    const chunk = listener.mock.calls[0][0];
    expect(chunk.audio.byteLength).toBe(4);
    expect(chunk.audio.subarray(0, 4).toString('ascii')).not.toBe('RIFF');
    expect(chunk.format).toBe('pcm');
  });

  it('REJECTS startSession (never hangs) when the server refuses the upgrade, carrying the HTTP body', async () => {
    // Regression: the old connect() ran emit('error') BEFORE reject() — with
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
    const ws = (session as any).ws;
    ws.emit('message', JSON.stringify({ type: 'Metadata', request_id: 'x' }), false);
    expect(listener).not.toHaveBeenCalled();
  });

  it('sends Flush and resolves flush on a Flushed control message', async () => {
    const session = await tts.startSession();
    const flushDone = vi.fn();
    session.on('flush_complete', flushDone);
    const ws = (session as any).ws;
    ws.send.mockClear();

    const p = session.flush();
    expect(JSON.parse(ws.send.mock.calls[0][0])).toEqual({ type: 'Flush' });

    ws.emit('message', JSON.stringify({ type: 'Flushed' }), false);
    await p;
    expect(flushDone).toHaveBeenCalledOnce();
  });

  it('sends Clear on cancel', async () => {
    const session = await tts.startSession();
    const ws = (session as any).ws;
    ws.send.mockClear();
    session.cancel();
    expect(JSON.parse(ws.send.mock.calls[0][0])).toEqual({ type: 'Clear' });
  });
});
