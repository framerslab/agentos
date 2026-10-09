/**
 * Unit tests for OpenAIRealtimeTranscriptionSTT.
 *
 * Uses a mock WebSocket to simulate OpenAI's Realtime transcription socket
 * (the session update and its confirmation, speech and transcription events,
 * refusals and drops) without hitting the real service. Every socket the
 * provider opens is recorded, so a test drives the first connection, a
 * reconnect or a rollover's second connection by index.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Must use factory that doesn't reference outer scope
vi.mock('ws', () => {
  const { EventEmitter: EE } = require('node:events');
  class MockWebSocket extends EE {
    static OPEN = 1;
    static CLOSED = 3;
    /** Every socket opened, in order. */
    static instances: MockWebSocket[] = [];
    /** How the next socket behaves; reset to 'ack' after use. */
    static nextBehavior: 'ack' | 'silent' | 'reject-401' | 'reject-429' | 'reject-500' | 'error-on-update' = 'ack';
    readyState = 1;
    url: string;
    headers: Record<string, string>;
    behavior: string;
    /** Client events this socket received, parsed. */
    sent: Array<Record<string, any>> = [];
    send = vi.fn((data: string) => {
      const event = JSON.parse(data);
      this.sent.push(event);
      if (event.type !== 'session.update') return;
      if (this.behavior === 'ack') {
        process.nextTick(() =>
          this.serve({ type: 'session.updated', event_id: 'event_ack', session: event.session })
        );
      } else if (this.behavior === 'error-on-update') {
        process.nextTick(() =>
          this.serve({
            type: 'error',
            event_id: 'event_err',
            error: {
              type: 'invalid_request_error',
              code: 'invalid_value',
              message: 'Invalid value for the transcription model.',
              param: 'session.audio.input.transcription.model',
              event_id: null,
            },
          })
        );
      }
    });
    close = vi.fn(() => {
      this.readyState = 3;
    });
    terminate = vi.fn(() => {
      this.readyState = 3;
    });

    constructor(url?: string, options?: { headers?: Record<string, string> }) {
      super();
      this.url = String(url ?? '');
      this.headers = options?.headers ?? {};
      this.behavior = MockWebSocket.nextBehavior;
      MockWebSocket.nextBehavior = 'ack';
      MockWebSocket.instances.push(this);
      process.nextTick(() => {
        if (this.behavior === 'reject-401' || this.behavior === 'reject-429' || this.behavior === 'reject-500') {
          const statusCode = this.behavior === 'reject-401' ? 401 : this.behavior === 'reject-429' ? 429 : 500;
          const body =
            statusCode === 401
              ? '{"error":{"message":"Incorrect API key provided."}}'
              : statusCode === 429
                ? '{"error":{"message":"Rate limit reached for requests.","type":"requests","code":"rate_limit_exceeded"}}'
                : '{"error":{"message":"The server had an error."}}';
          const res = {
            statusCode,
            on(name: string, cb: (arg?: unknown) => void) {
              if (name === 'data') cb(Buffer.from(body));
              if (name === 'end') cb();
            },
          };
          this.emit('unexpected-response', {}, res);
          return;
        }
        this.emit('open');
      });
    }

    /** One server event, as OpenAI sends it. */
    serve(event: Record<string, unknown>): void {
      this.emit('message', JSON.stringify(event));
    }

    /** The server drops the connection. */
    drop(code = 1006): void {
      this.readyState = 3;
      this.emit('close', code, Buffer.from(''));
    }
  }
  return { default: MockWebSocket, WebSocket: MockWebSocket };
});

import { OpenAIRealtimeTranscriptionSTT } from '../providers/OpenAIRealtimeTranscriptionSTT.js';
import type { StreamingSTTSession, TranscriptEvent, StreamingSTTUsageEvent } from '../types.js';
// Default import: the 'ws' types only expose WebSocket as the default export
// under this tsconfig (TS2595 on a named import). vi.mock supplies the same
// mock class for both the default and named bindings.
import MockedWs from 'ws';

interface FakeSocket extends EventEmitter {
  url: string;
  headers: Record<string, string>;
  sent: Array<Record<string, any>>;
  readyState: number;
  close: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  serve(event: Record<string, unknown>): void;
  drop(code?: number): void;
}

const Sockets = MockedWs as unknown as {
  instances: FakeSocket[];
  nextBehavior: 'ack' | 'silent' | 'reject-401' | 'reject-429' | 'reject-500' | 'error-on-update';
};

/** A key that is plainly fake. */
const KEY = 'sk-test-not-a-real-key';

/** Lets pending nextTick callbacks and promise continuations run (setImmediate stays real). */
async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Fakes the clock the provider reads (its timers and Date); nextTick and setImmediate stay real. */
function fakeClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
}

/** The client events of one type a socket received. */
function sentOfType(socket: FakeSocket, type: string): Array<Record<string, any>> {
  return socket.sent.filter((event) => event.type === type);
}

/** The PCM16 samples of each audio append a socket received, in order. */
function sentSamples(socket: FakeSocket): Int16Array[] {
  return sentOfType(socket, 'input_audio_buffer.append').map(
    (event) => new Int16Array(Uint8Array.from(Buffer.from(event.audio, 'base64')).buffer)
  );
}

/** A mono frame of `count` samples at `sampleRate`, every sample `value`. */
function frame(count: number, sampleRate = 24_000, value = 0.1) {
  return { samples: new Float32Array(count).fill(value), sampleRate, timestamp: Date.now() };
}

/** Collects what a session emits, in order. */
function record(session: StreamingSTTSession) {
  const transcripts: TranscriptEvent[] = [];
  const events: string[] = [];
  const usage: StreamingSTTUsageEvent[] = [];
  const errors: Error[] = [];
  const warnings: Error[] = [];
  session.on('transcript', (event: TranscriptEvent) => {
    transcripts.push(event);
    events.push(`transcript:${event.itemId}:${event.isFinal ? 'final' : 'interim'}`);
  });
  session.on('speech_start', () => events.push('speech_start'));
  session.on('speech_end', () => events.push('speech_end'));
  session.on('usage', (entry: StreamingSTTUsageEvent) => usage.push(entry));
  session.on('error', (err: Error) => {
    errors.push(err);
    events.push('error');
  });
  session.on('warning', (err: Error) => warnings.push(err));
  session.on('close', () => events.push('close'));
  return { transcripts, events, usage, errors, warnings };
}

beforeEach(() => {
  Sockets.instances.length = 0;
  Sockets.nextBehavior = 'ack';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('OpenAIRealtimeTranscriptionSTT: the wire', () => {
  it('reports its provider metadata', () => {
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY });
    expect(stt.providerId).toBe('openai-realtime-transcription');
    expect(stt.isStreaming).toBe(true);
    expect(stt.priority).toBe(15);
    expect(stt.capabilities.streaming).toBe(true);
    expect(stt.capabilities.latencyClass).toBe('realtime');
  });

  it('opens the transcription-intent socket with a Bearer key and no beta header', async () => {
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY });
    const session = await stt.startSession();
    const [socket] = Sockets.instances;
    expect(socket.url).toBe('wss://api.openai.com/v1/realtime?intent=transcription');
    expect(socket.headers).toEqual({ Authorization: `Bearer ${KEY}` });
    session.close();
  });

  it('names the model in the URL only for a host other than OpenAI', async () => {
    const stt = new OpenAIRealtimeTranscriptionSTT({
      apiKey: KEY,
      baseUrl: 'https://gateway.example.test/v1/realtime',
    });
    const session = await stt.startSession();
    expect(Sockets.instances[0].url).toBe(
      'wss://gateway.example.test/v1/realtime?intent=transcription&model=gpt-4o-mini-transcribe'
    );
    session.close();
  });

  it('sends the safety identifier header, from the config or per session', async () => {
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY, safetyIdentifier: 'user-hash-config' });
    const a = await stt.startSession();
    const b = await stt.startSession({ providerOptions: { safetyIdentifier: 'user-hash-session' } });
    expect(Sockets.instances[0].headers['OpenAI-Safety-Identifier']).toBe('user-hash-config');
    expect(Sockets.instances[1].headers['OpenAI-Safety-Identifier']).toBe('user-hash-session');
    a.close();
    b.close();
  });

  it('configures a transcription session with server turn detection by default', async () => {
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY });
    const session = await stt.startSession({ language: 'en-US' });
    expect(Sockets.instances[0].sent[0]).toEqual({
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: { model: 'gpt-4o-mini-transcribe', language: 'en' },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 600,
              silence_duration_ms: 350,
            },
          },
        },
      },
    });
    session.close();
  });

  it('carries the prompt and the turn detection values it is given', async () => {
    const stt = new OpenAIRealtimeTranscriptionSTT({
      apiKey: KEY,
      model: 'gpt-4o-transcribe',
      prompt: 'A product standup.',
      turnDetection: { threshold: 0.6, prefixPaddingMs: 300, silenceDurationMs: 500 },
    });
    const session = await stt.startSession({ providerOptions: { prompt: 'A design review.' } });
    const input = Sockets.instances[0].sent[0].session.audio.input;
    expect(input.transcription).toEqual({ model: 'gpt-4o-transcribe', prompt: 'A design review.' });
    expect(input.turn_detection).toEqual({
      type: 'server_vad',
      threshold: 0.6,
      prefix_padding_ms: 300,
      silence_duration_ms: 500,
    });
    session.close();
  });

  it('turns server turn detection off for a model that takes client commits, and sends it a language list', async () => {
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY, model: 'gpt-live-transcribe' });
    const session = await stt.startSession({ language: 'fr-CA' });
    const input = Sockets.instances[0].sent[0].session.audio.input;
    expect(input.turn_detection).toBeNull();
    expect(input.transcription).toEqual({ model: 'gpt-live-transcribe', languages: ['fr'] });
    session.close();
  });

  it('resolves only once the server confirms the session update', async () => {
    Sockets.nextBehavior = 'silent';
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY, connectTimeoutMs: 50 });
    await expect(stt.startSession()).rejects.toThrow(/connect timed out after 50ms/);
  });

  it('rejects with the HTTP status and body when the upgrade is refused', async () => {
    Sockets.nextBehavior = 'reject-401';
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY });
    await expect(stt.startSession()).rejects.toThrow(/HTTP 401.*Incorrect API key/s);
  });

  it('rejects when the server refuses the session update', async () => {
    Sockets.nextBehavior = 'error-on-update';
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY });
    await expect(stt.startSession()).rejects.toThrow(
      /session update refused: invalid_request_error \(invalid_value\)/
    );
  });

  it('sends 24 kHz frames as base64 PCM16, little-endian', async () => {
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY });
    const session = await stt.startSession();
    session.pushAudio({
      samples: new Float32Array([0.5, -0.5, 1, -1, 0]),
      sampleRate: 24_000,
      timestamp: Date.now(),
    });
    const [append] = sentOfType(Sockets.instances[0], 'input_audio_buffer.append');
    const expected = Buffer.from(Int16Array.from([16383, -16384, 32767, -32768, 0]).buffer).toString('base64');
    expect(append).toEqual({ type: 'input_audio_buffer.append', audio: expected });
    session.close();
  });

  it('resamples frames at other rates to 24 kHz', async () => {
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY });
    const session = await stt.startSession();
    session.pushAudio(frame(960, 48_000, 0.25)); // 20 ms
    session.pushAudio(frame(960, 48_000, 0.25)); // 20 ms
    const decoded = sentSamples(Sockets.instances[0]);
    expect(decoded.map((samples) => samples.length)).toEqual([480, 480]);
    expect(decoded.every((samples) => samples.every((value) => value === 8191))).toBe(true);
    session.close();
  });

  it('keeps the resampled audio as long as the audio pushed, however the frames are cut', async () => {
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY });
    async function samplesSent(count: number, sampleRate: number, frames: number): Promise<number> {
      const session = await stt.startSession();
      for (let i = 0; i < frames; i++) session.pushAudio(frame(count, sampleRate, 0.25));
      const sent = sentSamples(Sockets.instances[Sockets.instances.length - 1]);
      session.close();
      return sent.reduce((total, samples) => total + samples.length, 0);
    }
    // 128 samples at 44.1 kHz are 69.66 at 24 kHz. Rounded frame by frame they become 70: 0.49 percent
    // more audio than was pushed, so the server's offsets would run 16 s ahead of the session's clock by minute 55.
    expect(Math.abs((await samplesSent(128, 44_100, 1_000)) - (128_000 * 24_000) / 44_100)).toBeLessThan(2);
    // Up from 16 kHz: 100 frames of 20 ms are 48,000 samples.
    expect(Math.abs((await samplesSent(320, 16_000, 100)) - 48_000)).toBeLessThan(2);
  });

  it('closes its socket once, emits close once and ignores later frames', async () => {
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY });
    const session = await stt.startSession();
    const log = record(session);
    session.close();
    session.close();
    session.pushAudio(frame(480));
    expect(Sockets.instances[0].close).toHaveBeenCalledOnce();
    expect(log.events.filter((name) => name === 'close')).toHaveLength(1);
    expect(sentOfType(Sockets.instances[0], 'input_audio_buffer.append')).toHaveLength(0);
  });

  it('reports its health from the probe', async () => {
    const healthy = new OpenAIRealtimeTranscriptionSTT({
      apiKey: KEY,
      healthProbe: async () => ({ ok: true, status: 200, latencyMs: 12 }),
    });
    expect(await healthy.healthCheck()).toEqual({ ok: true, latencyMs: 12 });
    const refused = new OpenAIRealtimeTranscriptionSTT({
      apiKey: KEY,
      healthProbe: async () => ({ ok: false, status: 401, latencyMs: 9 }),
    });
    expect(await refused.healthCheck()).toMatchObject({ ok: false, error: { class: 'auth' } });
  });
});
