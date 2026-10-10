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
    static nextBehavior: 'ack' | 'silent' | 'reject-401' | 'reject-429' | 'reject-500' | 'error-on-update' | 'ack-then-drop' = 'ack';
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
      } else if (this.behavior === 'ack-then-drop') {
        // The server confirms the session update and closes at once: the message and the close
        // reach the provider in one turn, before the continuation that awaits the connect runs.
        process.nextTick(() => {
          this.serve({ type: 'session.updated', event_id: 'event_ack', session: event.session });
          this.drop();
        });
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
import { createVoiceProvidersFromEnv } from '../env-constructor.js';
import { VoicePipelineOrchestrator } from '../VoicePipelineOrchestrator.js';
import { HeuristicEndpointDetector } from '../HeuristicEndpointDetector.js';
import { HardCutBargeinHandler } from '../HardCutBargeinHandler.js';
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
  nextBehavior: 'ack' | 'silent' | 'reject-401' | 'reject-429' | 'reject-500' | 'error-on-update' | 'ack-then-drop';
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

  it('probes the models endpoint of the host its sessions use, with the same key', async () => {
    const fetched = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetched);
    try {
      const baseUrls = [
        'wss://gateway.example.test/v1/realtime',
        'http://localhost:4000/realtime/',
        'wss://gateway.example.test/openai',
      ];
      for (const baseUrl of baseUrls) {
        const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY, baseUrl });
        expect(await stt.healthCheck()).toMatchObject({ ok: true });
      }
      expect(fetched.mock.calls.map((call) => call[0])).toEqual([
        'https://gateway.example.test/v1/models',
        'http://localhost:4000/models',
        'https://gateway.example.test/openai/models',
      ]);
      expect(fetched.mock.calls[0][1]).toMatchObject({ headers: { Authorization: `Bearer ${KEY}` } });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("probes OpenAI's models endpoint when no base URL is set", async () => {
    const fetched = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetched);
    try {
      const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY });
      expect(await stt.healthCheck()).toMatchObject({ ok: true });
      expect(fetched.mock.calls.map((call) => call[0])).toEqual(['https://api.openai.com/v1/models']);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('OpenAIRealtimeTranscriptionSTT: transcripts keyed by item id', () => {
  async function started(
    options: Partial<ConstructorParameters<typeof OpenAIRealtimeTranscriptionSTT>[0]> = {},
    sessionConfig: Parameters<OpenAIRealtimeTranscriptionSTT['startSession']>[0] = {}
  ) {
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY, ...options });
    const session = await stt.startSession(sessionConfig);
    return { session, socket: Sockets.instances[Sockets.instances.length - 1], log: record(session) };
  }

  it('emits interims and a final for one item, with its id, its offsets and its language', async () => {
    const { session, socket, log } = await started({}, { language: 'en-US' });
    session.pushAudio(frame(24_000)); // one second
    socket.serve({ type: 'input_audio_buffer.speech_started', item_id: 'item_A', audio_start_ms: 120 });
    socket.serve({ type: 'input_audio_buffer.speech_stopped', item_id: 'item_A', audio_end_ms: 980 });
    socket.serve({ type: 'input_audio_buffer.committed', item_id: 'item_A', previous_item_id: null });
    socket.serve({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'item_A',
      content_index: 0,
      delta: 'Hello',
    });
    socket.serve({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'item_A',
      content_index: 0,
      delta: ' there.',
    });
    socket.serve({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item_A',
      content_index: 0,
      transcript: 'Hello there.',
    });
    const shared = { confidence: 1, words: [], itemId: 'item_A', startMs: 120, endMs: 980, language: 'en' };
    expect(log.transcripts).toEqual([
      { ...shared, text: 'Hello', isFinal: false },
      { ...shared, text: 'Hello there.', isFinal: false },
      { ...shared, text: 'Hello there.', isFinal: true, durationMs: 860 },
    ]);
    expect(log.events.slice(0, 2)).toEqual(['speech_start', 'speech_end']);
    session.close();
  });

  it('keeps the deltas of two items apart when they interleave, and finals each item', async () => {
    const { session, socket, log } = await started();
    session.pushAudio(frame(48_000));
    socket.serve({ type: 'input_audio_buffer.speech_started', item_id: 'item_A', audio_start_ms: 0 });
    socket.serve({ type: 'input_audio_buffer.speech_stopped', item_id: 'item_A', audio_end_ms: 900 });
    socket.serve({ type: 'input_audio_buffer.speech_started', item_id: 'item_B', audio_start_ms: 1_000 });
    socket.serve({ type: 'input_audio_buffer.speech_stopped', item_id: 'item_B', audio_end_ms: 1_900 });
    const delta = (itemId: string, text: string) =>
      socket.serve({ type: 'conversation.item.input_audio_transcription.delta', item_id: itemId, delta: text });
    delta('item_A', 'Good');
    delta('item_B', 'See');
    delta('item_A', ' morning.');
    delta('item_B', ' you.');
    socket.serve({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item_B',
      transcript: 'See you.',
    });
    socket.serve({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item_A',
      transcript: 'Good morning.',
    });
    expect(log.transcripts.map((t) => [t.itemId, t.isFinal, t.text])).toEqual([
      ['item_A', false, 'Good'],
      ['item_B', false, 'See'],
      ['item_A', false, 'Good morning.'],
      ['item_B', false, 'See you.'],
      ['item_B', true, 'See you.'],
      ['item_A', true, 'Good morning.'],
    ]);
    session.close();
  });

  it('takes the detected language over the configured one when the model reports it', async () => {
    const { session, socket, log } = await started({}, { language: 'en' });
    socket.serve({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item_A',
      transcript: 'Bonjour.',
      languages: [{ code: 'fr' }],
    });
    expect(log.transcripts.map((t) => t.language)).toEqual(['fr']);
    session.close();
  });

  it('emits no interims when the session asks for none', async () => {
    const { session, socket, log } = await started({}, { interimResults: false });
    socket.serve({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item_A', delta: 'Hi' });
    socket.serve({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item_A',
      transcript: 'Hi.',
    });
    expect(log.transcripts.map((t) => [t.isFinal, t.text])).toEqual([[true, 'Hi.']]);
    session.close();
  });

  it('closes a failed item that showed interim text with an empty final, and warns for every failed item', async () => {
    const { session, socket, log } = await started();
    socket.serve({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item_A', delta: 'Half a' });
    socket.serve({
      type: 'conversation.item.input_audio_transcription.failed',
      item_id: 'item_A',
      content_index: 0,
      error: { type: 'transcription_error', message: 'Audio could not be transcribed.' },
    });
    socket.serve({
      type: 'conversation.item.input_audio_transcription.failed',
      item_id: 'item_B',
      content_index: 0,
      error: { type: 'transcription_error', message: 'Audio could not be transcribed.' },
    });
    expect(log.transcripts.map((t) => [t.itemId, t.isFinal, t.text])).toEqual([
      ['item_A', false, 'Half a'],
      ['item_A', true, ''],
    ]);
    expect(log.warnings.map((warning) => warning.message)).toEqual([
      expect.stringContaining('failed for item item_A'),
      expect.stringContaining('failed for item item_B'),
    ]);
    session.close();
  });

  it('emits nothing for an item that ends with no words and showed no interim text', async () => {
    const { session, socket, log } = await started();
    socket.serve({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_A', transcript: '' });
    expect(log.transcripts).toEqual([]);
    session.close();
  });

  it('ignores a frame that is not JSON or has no type, and goes on with the next', async () => {
    const { session, socket, log } = await started();
    socket.emit('message', 'not json');
    socket.emit('message', JSON.stringify({ event_id: 'event_x' }));
    socket.serve({ type: 'input_audio_buffer.speech_started', item_id: 'item_A', audio_start_ms: 0 });
    socket.serve({ type: 'input_audio_buffer.speech_stopped', item_id: 'item_A', audio_end_ms: 600 });
    socket.serve({ type: 'input_audio_buffer.committed', item_id: 'item_A', previous_item_id: null });
    socket.serve({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_A', content_index: 0, transcript: 'Still here.' });
    expect(log.transcripts.at(-1)).toMatchObject({ itemId: 'item_A', isFinal: true, text: 'Still here.' });
    expect(log.warnings).toEqual([]);
    expect(log.errors).toEqual([]);
    session.close();
  });

  it('moves an utterance committed during speech to the item the commit names, and waits for no other', async () => {
    const { session, socket, log } = await started();
    session.pushAudio(frame(24_000)); // 0 to 1000 ms
    socket.serve({ type: 'input_audio_buffer.speech_started', item_id: 'item_A', audio_start_ms: 200 });
    let flushed = false;
    void session.flush().then(() => {
      flushed = true;
    });
    expect(sentOfType(socket, 'input_audio_buffer.commit')).toHaveLength(1); // a commit during speech
    // The server may give the utterance another id than speech_started named.
    socket.serve({ type: 'input_audio_buffer.committed', item_id: 'item_B', previous_item_id: null });
    socket.serve({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item_B',
      transcript: 'Cut short.',
    });
    await settle();
    expect(flushed).toBe(true); // nothing waits for item_A, whose final never comes
    expect(log.transcripts.map((t) => [t.itemId, t.isFinal, t.text, t.startMs, t.endMs])).toEqual([
      ['item_B', true, 'Cut short.', 200, 1000],
    ]);
    session.close();
  });
});

describe('OpenAIRealtimeTranscriptionSTT: reconnects, failures, flush and close', () => {
  it('reconnects after a drop, first after 100 ms, and sends the audio pushed meanwhile', async () => {
    fakeClock();
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY });
    const session = await stt.startSession();
    const log = record(session);
    Sockets.instances[0].drop();
    session.pushAudio(frame(2_400)); // 100 ms with no connection open
    await vi.advanceTimersByTimeAsync(99);
    await settle();
    expect(Sockets.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(Sockets.instances).toHaveLength(2);
    const second = Sockets.instances[1];
    expect(second.sent[0].type).toBe('session.update');
    expect(sentOfType(second, 'input_audio_buffer.append')).toHaveLength(1);
    expect(log.errors).toEqual([]);
    session.close();
  });

  it('holds a frame a closing socket did not take for the connection that replaces it, and counts it once', async () => {
    fakeClock();
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY });
    const session = await stt.startSession();
    const log = record(session);
    const first = Sockets.instances[0];
    session.pushAudio(frame(2_400)); // 100 ms, sent
    first.readyState = 2; // CLOSING: the close handshake has begun, and the close event has not come
    session.pushAudio(frame(4_800)); // 200 ms the closing socket does not take
    expect(sentOfType(first, 'input_audio_buffer.append')).toHaveLength(1);
    first.drop();
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    const second = Sockets.instances[1];
    expect(sentSamples(second).map((samples) => samples.length)).toEqual([4_800]);
    session.close();
    expect(log.usage.map((entry) => [entry.connectionIndex, entry.audioSeconds, entry.final])).toEqual([
      [1, 0.1, true],
      [2, 0.2, true],
    ]);
  });

  it('ends with an error and then close after three failed reconnects, waiting 100 ms, 2 s and 2 s', async () => {
    fakeClock();
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY });
    const session = await stt.startSession();
    const log = record(session);
    Sockets.nextBehavior = 'reject-500';
    Sockets.instances[0].drop();
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(Sockets.instances).toHaveLength(2);
    Sockets.nextBehavior = 'reject-500';
    await vi.advanceTimersByTimeAsync(2_000);
    await settle();
    expect(Sockets.instances).toHaveLength(3);
    Sockets.nextBehavior = 'reject-500';
    await vi.advanceTimersByTimeAsync(2_000);
    await settle();
    expect(Sockets.instances).toHaveLength(4);
    expect(log.events.slice(-2)).toEqual(['error', 'close']);
    expect(log.errors[0].message).toMatch(/gave up after 3 retries: .*HTTP 500/s);
  });

  it('resets the retry count after a final, so the next drop waits 100 ms again', async () => {
    fakeClock();
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY });
    const session = await stt.startSession();
    record(session);
    Sockets.nextBehavior = 'reject-500';
    Sockets.instances[0].drop();
    await vi.advanceTimersByTimeAsync(100);
    await settle(); // the first reconnect is refused: two failures counted
    await vi.advanceTimersByTimeAsync(2_000);
    await settle(); // the second reconnect opens
    expect(Sockets.instances).toHaveLength(3);
    const third = Sockets.instances[2];
    third.serve({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item_A',
      transcript: 'Back again.',
    });
    third.drop();
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(Sockets.instances).toHaveLength(4); // 100 ms, not 2 s: the final reset the count
    session.close();
  });

  it('resets the retry count when the dropped connection had stayed open longer than the connect timeout', async () => {
    fakeClock();
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY, connectTimeoutMs: 1_000 });
    const session = await stt.startSession();
    record(session);
    Sockets.nextBehavior = 'reject-500';
    Sockets.instances[0].drop();
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    await vi.advanceTimersByTimeAsync(2_000);
    await settle();
    expect(Sockets.instances).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1_500); // longer than connectTimeoutMs
    Sockets.instances[2].drop();
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(Sockets.instances).toHaveLength(4);
    session.close();
  });

  it('ends at once with an error when a reconnect is refused as unauthorised', async () => {
    fakeClock();
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY });
    const session = await stt.startSession();
    const log = record(session);
    Sockets.nextBehavior = 'reject-401';
    Sockets.instances[0].drop();
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(Sockets.instances).toHaveLength(2);
    expect(log.events.slice(-2)).toEqual(['error', 'close']);
    expect(log.errors[0].message).toMatch(/gave up after 1 retry: .*HTTP 401/s);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(Sockets.instances).toHaveLength(2);
  });

  it('does not throw when it fails with no error listener attached', async () => {
    fakeClock();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY });
    const session = await stt.startSession();
    const closed = vi.fn();
    session.on('close', closed);
    Sockets.nextBehavior = 'reject-401';
    Sockets.instances[0].drop();
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(closed).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('session error (no listener attached)'),
      expect.stringContaining('HTTP 401')
    );
    warn.mockRestore();
  });

  it('reports a server error it survives as a warning', async () => {
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY });
    const session = await stt.startSession();
    const log = record(session);
    Sockets.instances[0].serve({
      type: 'error',
      event_id: 'event_9',
      error: { type: 'invalid_request_error', code: null, message: 'Unknown parameter.', param: null, event_id: null },
    });
    expect(log.warnings).toHaveLength(1);
    expect(log.errors).toEqual([]);
    expect(log.events).not.toContain('close');
    session.close();
  });

  it('commits the buffer on flush when turn detection is off, and resolves when that item is final', async () => {
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY, turnDetection: null });
    const session = await stt.startSession();
    const log = record(session);
    const socket = Sockets.instances[0];
    session.pushAudio(frame(12_000)); // 500 ms
    let flushed = false;
    const flushing = session.flush().then(() => {
      flushed = true;
    });
    expect(sentOfType(socket, 'input_audio_buffer.commit')).toEqual([
      { type: 'input_audio_buffer.commit', event_id: 'commit_1_1' },
    ]);
    socket.serve({ type: 'input_audio_buffer.committed', item_id: 'item_A', previous_item_id: null });
    await settle();
    expect(flushed).toBe(false);
    socket.serve({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item_A',
      transcript: 'One turn.',
    });
    await flushing;
    expect(log.transcripts).toEqual([
      { text: 'One turn.', confidence: 1, words: [], isFinal: true, itemId: 'item_A', startMs: 0, endMs: 500, durationMs: 500 },
    ]);
    session.close();
  });

  it('sends no commit when nothing was appended since the last one', async () => {
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY, turnDetection: null });
    const session = await stt.startSession();
    await session.flush();
    expect(sentOfType(Sockets.instances[0], 'input_audio_buffer.commit')).toEqual([]);
    session.close();
  });

  it('stops waiting for a commit the server refused', async () => {
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY, turnDetection: null, finalTimeoutMs: 60_000 });
    const session = await stt.startSession();
    const log = record(session);
    session.pushAudio(frame(240));
    let flushed = false;
    const flushing = session.flush().then(() => {
      flushed = true;
    });
    Sockets.instances[0].serve({
      type: 'error',
      event_id: 'event_5',
      error: { type: 'invalid_request_error', code: null, message: 'The buffer is too small to commit.', param: null, event_id: 'commit_1_1' },
    });
    await settle();
    expect(flushed).toBe(true); // at once, not after finalTimeoutMs
    await flushing;
    expect(log.warnings).toHaveLength(1);
    session.close();
  });

  it('commits on flush under server turn detection only while speech is in progress', async () => {
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY, finalTimeoutMs: 50 });
    const session = await stt.startSession();
    record(session);
    const socket = Sockets.instances[0];
    session.pushAudio(frame(4_800));
    await session.flush();
    expect(sentOfType(socket, 'input_audio_buffer.commit')).toEqual([]);
    socket.serve({ type: 'input_audio_buffer.speech_started', item_id: 'item_A', audio_start_ms: 0 });
    session.pushAudio(frame(4_800));
    await session.flush(); // waits up to 50 ms for item_A's final
    expect(sentOfType(socket, 'input_audio_buffer.commit')).toHaveLength(1);
    session.close();
  });

  it('opens no connection after close, even when a socket drops later', async () => {
    fakeClock();
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY });
    const session = await stt.startSession();
    session.close();
    Sockets.instances[0].drop();
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(Sockets.instances).toHaveLength(1);
  });

  it('retries after a rate-limited refusal, since a 429 is retryable, and connects when the limit lifts', async () => {
    fakeClock();
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY });
    const session = await stt.startSession();
    const log = record(session);
    Sockets.nextBehavior = 'reject-429';
    Sockets.instances[0].drop();
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(Sockets.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2_000);
    await settle();
    expect(Sockets.instances).toHaveLength(3);
    expect(log.events).not.toContain('error');
    expect(log.events).not.toContain('close');
    session.close();
  });

  it('flush during a reconnect waits for the connection that takes over to commit and finalise', async () => {
    fakeClock();
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY, turnDetection: null });
    const session = await stt.startSession();
    const log = record(session);
    Sockets.instances[0].drop();
    session.pushAudio(frame(2_400));
    let flushed = false;
    const flushing = session.flush().then(() => {
      flushed = true;
    });
    await settle();
    expect(flushed).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    const next = Sockets.instances[1];
    expect(next.sent.filter((event) => event.type === 'input_audio_buffer.commit')).toHaveLength(1);
    expect(flushed).toBe(false);
    next.serve({ type: 'input_audio_buffer.committed', item_id: 'item_R', previous_item_id: null });
    next.serve({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_R', content_index: 0, transcript: 'Late words.' });
    await flushing;
    expect(log.transcripts.at(-1)).toMatchObject({ itemId: 'item_R', isFinal: true, text: 'Late words.' });
    session.close();
  });

  it('abandons a reconnect still connecting when the session closes, and leaves no timer behind', async () => {
    fakeClock();
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY });
    const session = await stt.startSession();
    const log = record(session);
    Sockets.nextBehavior = 'silent'; // the replacement's session update goes unanswered
    Sockets.instances[0].drop();
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(Sockets.instances).toHaveLength(2);
    session.close();
    expect(Sockets.instances[1].terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0); // the connect timer went with it
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();
    expect(Sockets.instances).toHaveLength(2);
    expect(log.events).toEqual(['close']);
  });

  it('ends a retry wait when the session closes', async () => {
    fakeClock();
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY });
    const session = await stt.startSession();
    Sockets.instances[0].drop();
    expect(vi.getTimerCount()).toBe(1); // the wait before the first retry
    session.close();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    await settle();
    expect(Sockets.instances).toHaveLength(1);
  });

  it('opens nothing for a session whose start timed out, even when its confirmation arrives late', async () => {
    fakeClock();
    Sockets.nextBehavior = 'silent';
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY, connectTimeoutMs: 50 });
    const refused = expect(stt.startSession()).rejects.toThrow(/connect timed out after 50ms/);
    await settle();
    await vi.advanceTimersByTimeAsync(50);
    await refused;
    // ws still emits a message it was inflating or parsing when the timeout terminated the socket, then its close.
    const socket = Sockets.instances[0];
    socket.serve({ type: 'session.updated', event_id: 'event_late', session: {} });
    socket.drop();
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(Sockets.instances).toHaveLength(1); // no reconnect for a session the caller never got
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts, and reconnects, when the first connection closes as its session update is confirmed', async () => {
    fakeClock();
    Sockets.nextBehavior = 'ack-then-drop';
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY, usageIntervalMs: 5_000 });
    const session = await stt.startSession();
    const log = record(session);
    session.pushAudio(frame(2_400)); // held: no connection has joined the session
    await vi.advanceTimersByTimeAsync(100); // the first retry
    await settle();
    expect(Sockets.instances).toHaveLength(2);
    const second = Sockets.instances[1];
    expect(sentOfType(second, 'input_audio_buffer.append')).toHaveLength(1);
    // The connection that closed never joined the session, so the replacement is the session's first:
    // no older connection withholds its interim text, and usage is reported for it alone.
    second.serve({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item_A', delta: 'Hello' });
    expect(log.transcripts.map((t) => [t.itemId, t.isFinal, t.text])).toEqual([['item_A', false, 'Hello']]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(log.usage.map((entry) => [entry.connectionIndex, entry.audioSeconds])).toEqual([[1, 0.1]]);
    session.close();
    expect(vi.getTimerCount()).toBe(0); // and it left no rollover clock behind
    expect(log.errors).toEqual([]);
  });

  it('retries a reconnect whose connection closes as its session update is confirmed', async () => {
    fakeClock();
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY });
    const session = await stt.startSession();
    const log = record(session);
    Sockets.instances[0].drop();
    session.pushAudio(frame(2_400)); // held for the connection that takes over
    Sockets.nextBehavior = 'ack-then-drop';
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(Sockets.instances).toHaveLength(2); // confirmed, then closed at once: a failed attempt
    await vi.advanceTimersByTimeAsync(2_000); // so the next one comes by the retry rules
    await settle();
    expect(Sockets.instances).toHaveLength(3);
    expect(sentOfType(Sockets.instances[1], 'input_audio_buffer.append')).toEqual([]);
    expect(sentOfType(Sockets.instances[2], 'input_audio_buffer.append')).toHaveLength(1);
    session.close();
    expect(log.usage.map((entry) => [entry.connectionIndex, entry.audioSeconds])).toEqual([
      [1, 0],
      [2, 0.1],
    ]);
    expect(vi.getTimerCount()).toBe(0);
    expect(log.errors).toEqual([]);
  });
});

describe('OpenAIRealtimeTranscriptionSTT: rollover and usage', () => {
  const ROLLOVER = { afterMs: 10_000, deadlineMs: 20_000, overlapMs: 1_000, hardStopMs: 30_000 };

  it('opens the next connection at the first end of speech after 55 minutes by default', async () => {
    fakeClock();
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY });
    const session = await stt.startSession();
    record(session);
    const first = Sockets.instances[0];
    await vi.advanceTimersByTimeAsync(54 * 60_000);
    first.serve({ type: 'input_audio_buffer.speech_started', item_id: 'item_A', audio_start_ms: 0 });
    first.serve({ type: 'input_audio_buffer.speech_stopped', item_id: 'item_A', audio_end_ms: 500 });
    await settle();
    expect(Sockets.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    first.serve({ type: 'input_audio_buffer.speech_started', item_id: 'item_B', audio_start_ms: 1_000 });
    first.serve({ type: 'input_audio_buffer.speech_stopped', item_id: 'item_B', audio_end_ms: 1_500 });
    await settle();
    expect(Sockets.instances).toHaveLength(2);
    expect(Sockets.instances[1].sent[0]).toEqual(first.sent[0]);
    session.close();
  });

  it('opens the next connection at 58 minutes when no speech ends, by default', async () => {
    fakeClock();
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY });
    const session = await stt.startSession();
    record(session);
    await vi.advanceTimersByTimeAsync(58 * 60_000 - 1);
    await settle();
    expect(Sockets.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(Sockets.instances).toHaveLength(2);
    session.close();
  });

  it('sends the same audio to both connections through the overlap, then drains and closes the old one', async () => {
    fakeClock();
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY, rollover: ROLLOVER });
    const session = await stt.startSession();
    const log = record(session);
    const first = Sockets.instances[0];
    await vi.advanceTimersByTimeAsync(10_000);
    first.serve({ type: 'input_audio_buffer.speech_started', item_id: 'item_A', audio_start_ms: 0 });
    first.serve({ type: 'input_audio_buffer.speech_stopped', item_id: 'item_A', audio_end_ms: 400 });
    await settle();
    const second = Sockets.instances[1];
    session.pushAudio(frame(2_400));
    expect(sentOfType(first, 'input_audio_buffer.append')).toHaveLength(1);
    expect(sentOfType(second, 'input_audio_buffer.append')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000); // the overlap passes; the old connection is quiet
    expect(sentOfType(first, 'input_audio_buffer.clear')).toHaveLength(1);
    session.pushAudio(frame(2_400));
    expect(sentOfType(first, 'input_audio_buffer.append')).toHaveLength(1);
    expect(sentOfType(second, 'input_audio_buffer.append')).toHaveLength(2);
    first.serve({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item_A',
      transcript: 'Before the switch.',
    });
    await settle();
    expect(first.close).toHaveBeenCalledOnce();
    expect(log.transcripts.map((t) => t.text)).toEqual(['Before the switch.']);
    expect(log.usage).toEqual([
      {
        providerId: 'openai-realtime-transcription',
        model: 'gpt-4o-mini-transcribe',
        connectionIndex: 1,
        audioSeconds: 0.1,
        final: true,
      },
    ]);
    session.close();
  });

  it('emits an utterance both connections transcribed once, from the old connection, with no interims from the new one', async () => {
    fakeClock();
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY, rollover: ROLLOVER });
    const session = await stt.startSession();
    const log = record(session);
    const first = Sockets.instances[0];
    session.pushAudio(frame(24_000)); // 0 to 1000 ms on the session clock, first connection only
    await vi.advanceTimersByTimeAsync(10_000);
    first.serve({ type: 'input_audio_buffer.speech_started', item_id: 'item_A', audio_start_ms: 0 });
    first.serve({ type: 'input_audio_buffer.speech_stopped', item_id: 'item_A', audio_end_ms: 900 });
    await settle();
    const second = Sockets.instances[1];
    session.pushAudio(frame(24_000)); // 1000 to 2000 ms, to both connections
    // One utterance at 1100 to 1900 ms, heard by both: the second connection's clock starts at 1000.
    first.serve({ type: 'input_audio_buffer.speech_started', item_id: 'old_B', audio_start_ms: 1_100 });
    second.serve({ type: 'input_audio_buffer.speech_started', item_id: 'new_B', audio_start_ms: 100 });
    first.serve({ type: 'input_audio_buffer.speech_stopped', item_id: 'old_B', audio_end_ms: 1_900 });
    second.serve({ type: 'input_audio_buffer.speech_stopped', item_id: 'new_B', audio_end_ms: 900 });
    second.serve({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'new_B', delta: 'Same words' });
    first.serve({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'old_B', delta: 'Same words' });
    second.serve({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'new_B',
      transcript: 'Same words.',
    });
    first.serve({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'old_B',
      transcript: 'Same words.',
    });
    first.serve({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item_A',
      transcript: 'First.',
    });
    expect(log.transcripts.map((t) => [t.itemId, t.isFinal, t.text])).toEqual([
      ['old_B', false, 'Same words'],
      ['old_B', true, 'Same words.'],
      ['item_A', true, 'First.'],
    ]);
    session.close();
  });

  it('drops the repeat even when the old connection closed before the new one reported that audio', async () => {
    fakeClock();
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY, rollover: ROLLOVER });
    const session = await stt.startSession();
    const log = record(session);
    const first = Sockets.instances[0];
    session.pushAudio(frame(24_000)); // 0 to 1000 ms, first connection only
    await vi.advanceTimersByTimeAsync(10_000);
    first.serve({ type: 'input_audio_buffer.speech_started', item_id: 'item_A', audio_start_ms: 0 });
    first.serve({ type: 'input_audio_buffer.speech_stopped', item_id: 'item_A', audio_end_ms: 900 });
    await settle();
    const second = Sockets.instances[1];
    session.pushAudio(frame(24_000)); // 1000 to 2000 ms, to both
    first.serve({ type: 'input_audio_buffer.speech_started', item_id: 'old_B', audio_start_ms: 1_100 });
    first.serve({ type: 'input_audio_buffer.speech_stopped', item_id: 'old_B', audio_end_ms: 1_900 });
    await vi.advanceTimersByTimeAsync(1_000); // the overlap passes: the first connection stops at 2000 ms
    first.serve({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item_A',
      transcript: 'First.',
    });
    first.serve({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'old_B',
      transcript: 'Same words.',
    });
    await settle();
    expect(first.close).toHaveBeenCalledOnce(); // its items are final: it has drained and closed
    // Only now does the second connection report the same utterance, 1100 to 1900 ms on the session clock.
    second.serve({ type: 'input_audio_buffer.speech_started', item_id: 'new_B', audio_start_ms: 100 });
    second.serve({ type: 'input_audio_buffer.speech_stopped', item_id: 'new_B', audio_end_ms: 900 });
    second.serve({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'new_B', delta: 'Same words' });
    second.serve({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'new_B',
      transcript: 'Same words.',
    });
    expect(log.transcripts.map((t) => [t.itemId, t.isFinal, t.text])).toEqual([
      ['item_A', true, 'First.'],
      ['old_B', true, 'Same words.'],
    ]);
    session.close();
  });

  it('emits an utterance whose onset came after the old connection stopped receiving audio', async () => {
    fakeClock();
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY, rollover: ROLLOVER });
    const session = await stt.startSession();
    const log = record(session);
    const first = Sockets.instances[0];
    session.pushAudio(frame(24_000)); // 0 to 1000 ms, first connection only
    await vi.advanceTimersByTimeAsync(10_000);
    first.serve({ type: 'input_audio_buffer.speech_started', item_id: 'item_A', audio_start_ms: 0 });
    first.serve({ type: 'input_audio_buffer.speech_stopped', item_id: 'item_A', audio_end_ms: 900 });
    await settle();
    const second = Sockets.instances[1];
    session.pushAudio(frame(24_000)); // 1000 to 2000 ms, to both
    first.serve({ type: 'input_audio_buffer.speech_started', item_id: 'old_B', audio_start_ms: 1_100 });
    first.serve({ type: 'input_audio_buffer.speech_stopped', item_id: 'old_B', audio_end_ms: 1_900 });
    await vi.advanceTimersByTimeAsync(1_000); // the overlap passes: the first connection stops at 2000 ms
    session.pushAudio(frame(24_000)); // 2000 to 3000 ms, second connection only
    // A short reply whose start (with 600 ms of prefix padding) reaches back to 1700 ms,
    // inside old_B give or take the tolerance, but whose onset (2300 ms) the first connection never heard.
    second.serve({ type: 'input_audio_buffer.speech_started', item_id: 'new_C', audio_start_ms: 700 });
    second.serve({ type: 'input_audio_buffer.speech_stopped', item_id: 'new_C', audio_end_ms: 1_300 });
    second.serve({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'new_C',
      transcript: 'Yes.',
    });
    first.serve({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'old_B',
      transcript: 'Earlier words.',
    });
    first.serve({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item_A',
      transcript: 'First.',
    });
    expect(log.transcripts.filter((t) => t.isFinal).map((t) => [t.itemId, t.text])).toEqual([
      ['new_C', 'Yes.'],
      ['old_B', 'Earlier words.'],
      ['item_A', 'First.'],
    ]);
    session.close();
  });

  it('commits and drains an old connection still in speech at its hard stop', async () => {
    fakeClock();
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY, rollover: ROLLOVER });
    const session = await stt.startSession();
    record(session);
    const first = Sockets.instances[0];
    session.pushAudio(frame(2_400));
    await vi.advanceTimersByTimeAsync(20_000); // the deadline: the next connection opens whatever is said
    await settle();
    expect(Sockets.instances).toHaveLength(2);
    first.serve({ type: 'input_audio_buffer.speech_started', item_id: 'item_long', audio_start_ms: 50 });
    session.pushAudio(frame(2_400));
    await vi.advanceTimersByTimeAsync(1_000); // the overlap passes while the old connection is in speech
    expect(sentOfType(first, 'input_audio_buffer.clear')).toEqual([]);
    await vi.advanceTimersByTimeAsync(9_000); // 30 s: the old connection's hard stop
    expect(sentOfType(first, 'input_audio_buffer.commit')).toHaveLength(1);
    session.close();
  });

  it('keeps the connection when the rollover is refused, and closes the session at its hard stop', async () => {
    fakeClock();
    const approve = vi.fn(async (_request: unknown) => false);
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY, rollover: { ...ROLLOVER, approve } });
    const session = await stt.startSession();
    const log = record(session);
    await vi.advanceTimersByTimeAsync(20_000);
    await settle();
    expect(approve).toHaveBeenCalledWith({ connectionIndex: 2, reason: 'deadline' });
    expect(Sockets.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();
    expect(log.events).toContain('close');
    expect(log.errors).toEqual([]);
  });

  it('reports usage per connection: at every interval while open, and once more when each closes', async () => {
    fakeClock();
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY, rollover: ROLLOVER, usageIntervalMs: 5_000 });
    const session = await stt.startSession();
    const log = record(session);
    session.pushAudio(frame(12_000)); // 0.5 s
    await vi.advanceTimersByTimeAsync(5_000);
    expect(log.usage).toEqual([
      {
        providerId: 'openai-realtime-transcription',
        model: 'gpt-4o-mini-transcribe',
        connectionIndex: 1,
        audioSeconds: 0.5,
        final: false,
      },
    ]);
    await vi.advanceTimersByTimeAsync(15_000); // 20 s: the deadline opens connection 2
    await settle();
    session.pushAudio(frame(24_000)); // 1 s to both connections
    await vi.advanceTimersByTimeAsync(1_000); // the overlap passes; connection 1 is quiet and closes
    await settle();
    session.pushAudio(frame(6_000)); // 0.25 s to connection 2 only
    session.close();
    expect(log.usage.filter((entry) => entry.final).map((entry) => [entry.connectionIndex, entry.audioSeconds])).toEqual([
      [1, 1.5],
      [2, 1.25],
    ]);
  });

  it('with client commits, switches at the first flush after the rollover age, with no overlap', async () => {
    fakeClock();
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY, turnDetection: null, rollover: ROLLOVER });
    const session = await stt.startSession();
    record(session);
    const first = Sockets.instances[0];
    await vi.advanceTimersByTimeAsync(10_000);
    session.pushAudio(frame(2_400));
    const flushing = session.flush();
    expect(sentOfType(first, 'input_audio_buffer.commit')).toHaveLength(1);
    session.pushAudio(frame(2_400)); // after the turn: waits for the next connection
    expect(sentOfType(first, 'input_audio_buffer.append')).toHaveLength(1);
    first.serve({ type: 'input_audio_buffer.committed', item_id: 'item_A', previous_item_id: null });
    first.serve({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item_A',
      transcript: 'The last turn here.',
    });
    await flushing;
    await settle();
    const second = Sockets.instances[1];
    expect(sentOfType(second, 'input_audio_buffer.append')).toHaveLength(1);
    expect(sentOfType(first, 'input_audio_buffer.clear')).toEqual([]);
    expect(first.close).toHaveBeenCalledOnce();
    session.close();
  });

  it('reconnects when the connection that took over drops during the overlap, once the old one has drained, on the clocks of the one that dropped', async () => {
    fakeClock();
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY, rollover: ROLLOVER });
    const session = await stt.startSession();
    const log = record(session);
    const first = Sockets.instances[0];
    await vi.advanceTimersByTimeAsync(10_000);
    first.serve({ type: 'input_audio_buffer.speech_started', item_id: 'item_A', audio_start_ms: 0 });
    first.serve({ type: 'input_audio_buffer.speech_stopped', item_id: 'item_A', audio_end_ms: 400 });
    await settle();
    expect(Sockets.instances).toHaveLength(2);
    Sockets.instances[1].drop();
    await settle();
    expect(Sockets.instances).toHaveLength(2); // the old connection still takes audio: no reconnect yet
    await vi.advanceTimersByTimeAsync(1_000); // the overlap passes; the old connection drains
    first.serve({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_A', transcript: 'Before the switch.' });
    await settle();
    expect(first.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(Sockets.instances).toHaveLength(3);
    session.pushAudio(frame(2_400));
    expect(sentOfType(Sockets.instances[2], 'input_audio_buffer.append')).toHaveLength(1);
    // The replacement runs on the clocks of the connection that took over at 10 s, not on the old one's:
    // an end of speech 1.1 s after that is no rollover.
    Sockets.instances[2].serve({ type: 'input_audio_buffer.speech_started', item_id: 'item_C', audio_start_ms: 0 });
    Sockets.instances[2].serve({ type: 'input_audio_buffer.speech_stopped', item_id: 'item_C', audio_end_ms: 50 });
    await settle();
    expect(Sockets.instances).toHaveLength(3);
    expect(log.events).not.toContain('close');
    session.close();
  });

  it('gives a connection opened after a drop the dropped connection\'s clocks, so the deadline keeps its time', async () => {
    fakeClock();
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY, rollover: ROLLOVER });
    const session = await stt.startSession();
    record(session);
    await vi.advanceTimersByTimeAsync(15_000);
    Sockets.instances[0].drop();
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(Sockets.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(4_800);
    await settle();
    expect(Sockets.instances).toHaveLength(2); // 19.9 s after the first connection opened: no rollover yet
    await vi.advanceTimersByTimeAsync(200);
    await settle();
    expect(Sockets.instances).toHaveLength(3); // the deadline counted from the first connection, not from the second
    session.close();
  });

  it('keeps a refused rollover across a reconnect: no second approval, and the session ends at the hard stop', async () => {
    fakeClock();
    const approve = vi.fn(async (_request: unknown) => false);
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY, rollover: { ...ROLLOVER, approve } });
    const session = await stt.startSession();
    const log = record(session);
    await vi.advanceTimersByTimeAsync(20_000); // the deadline: the host refuses the next connection
    await settle();
    expect(approve).toHaveBeenCalledOnce();
    Sockets.instances[0].drop();
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    const replacement = Sockets.instances[1];
    replacement.serve({ type: 'input_audio_buffer.speech_started', item_id: 'item_A', audio_start_ms: 0 });
    replacement.serve({ type: 'input_audio_buffer.speech_stopped', item_id: 'item_A', audio_end_ms: 400 });
    replacement.serve({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item_A',
      transcript: 'Still here.',
    });
    await settle();
    expect(approve).toHaveBeenCalledOnce(); // an end of speech past the rollover age asks nothing again
    await vi.advanceTimersByTimeAsync(10_000); // 30 s after the first connection opened: its hard stop
    await settle();
    expect(log.events).toContain('close');
    expect(log.errors).toEqual([]);
    expect(Sockets.instances).toHaveLength(2);
  });

  it('holds the new connection\'s final while the old item for the same words is unfinished, and emits it when that item fails or ends empty', async () => {
    fakeClock();
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY, rollover: ROLLOVER });
    const session = await stt.startSession();
    const log = record(session);
    const first = Sockets.instances[0];
    session.pushAudio(frame(24_000)); // 0 to 1000 ms, first connection only
    await vi.advanceTimersByTimeAsync(10_000);
    first.serve({ type: 'input_audio_buffer.speech_started', item_id: 'item_A', audio_start_ms: 0 });
    first.serve({ type: 'input_audio_buffer.speech_stopped', item_id: 'item_A', audio_end_ms: 900 });
    await settle();
    const second = Sockets.instances[1];
    session.pushAudio(frame(48_000)); // 1000 to 3000 ms, to both
    // Two utterances heard by both, at 1100 to 1800 ms and 2000 to 2800 ms on the session clock.
    first.serve({ type: 'input_audio_buffer.speech_started', item_id: 'old_B', audio_start_ms: 1_100 });
    first.serve({ type: 'input_audio_buffer.speech_stopped', item_id: 'old_B', audio_end_ms: 1_800 });
    first.serve({ type: 'input_audio_buffer.speech_started', item_id: 'old_C', audio_start_ms: 2_000 });
    first.serve({ type: 'input_audio_buffer.speech_stopped', item_id: 'old_C', audio_end_ms: 2_800 });
    second.serve({ type: 'input_audio_buffer.speech_started', item_id: 'new_B', audio_start_ms: 100 });
    second.serve({ type: 'input_audio_buffer.speech_stopped', item_id: 'new_B', audio_end_ms: 800 });
    second.serve({ type: 'input_audio_buffer.speech_started', item_id: 'new_C', audio_start_ms: 1_000 });
    second.serve({ type: 'input_audio_buffer.speech_stopped', item_id: 'new_C', audio_end_ms: 1_800 });
    second.serve({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'new_B',
      transcript: 'Second words.',
    });
    second.serve({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'new_C',
      transcript: 'Third words.',
    });
    expect(log.transcripts).toEqual([]); // held: the old connection's finals for the same words are still to come
    first.serve({
      type: 'conversation.item.input_audio_transcription.failed',
      item_id: 'old_B',
      content_index: 0,
      error: { type: 'transcription_error', message: 'Audio could not be transcribed.' },
    });
    first.serve({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'old_C', transcript: '' });
    first.serve({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item_A',
      transcript: 'First.',
    });
    expect(log.transcripts.map((t) => [t.itemId, t.isFinal, t.text])).toEqual([
      ['new_B', true, 'Second words.'],
      ['new_C', true, 'Third words.'],
      ['item_A', true, 'First.'],
    ]);
    session.close();
  });

  it('emits the new connection\'s held final when the old connection drops before its own final for those words', async () => {
    fakeClock();
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY, rollover: ROLLOVER });
    const session = await stt.startSession();
    const log = record(session);
    const first = Sockets.instances[0];
    session.pushAudio(frame(24_000)); // 0 to 1000 ms, first connection only
    await vi.advanceTimersByTimeAsync(10_000);
    first.serve({ type: 'input_audio_buffer.speech_started', item_id: 'item_A', audio_start_ms: 0 });
    first.serve({ type: 'input_audio_buffer.speech_stopped', item_id: 'item_A', audio_end_ms: 900 });
    await settle();
    const second = Sockets.instances[1];
    session.pushAudio(frame(24_000)); // 1000 to 2000 ms, to both
    first.serve({ type: 'input_audio_buffer.speech_started', item_id: 'old_B', audio_start_ms: 1_100 });
    first.serve({ type: 'input_audio_buffer.speech_stopped', item_id: 'old_B', audio_end_ms: 1_900 });
    second.serve({ type: 'input_audio_buffer.speech_started', item_id: 'new_B', audio_start_ms: 100 });
    second.serve({ type: 'input_audio_buffer.speech_stopped', item_id: 'new_B', audio_end_ms: 900 });
    second.serve({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'new_B',
      transcript: 'Same words.',
    });
    first.serve({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item_A',
      transcript: 'First.',
    });
    first.drop(); // old_B never gets its final
    await settle();
    expect(log.transcripts.map((t) => [t.itemId, t.isFinal, t.text])).toEqual([
      ['item_A', true, 'First.'],
      ['new_B', true, 'Same words.'],
    ]);
    expect(Sockets.instances).toHaveLength(2); // the second connection carries on: no reconnect
    session.close();
  });

  it('ignores a late answer for a connection that dropped, and asks once for the connection that replaced it', async () => {
    fakeClock();
    const answers: Array<(approved: boolean) => void> = [];
    const approve = vi.fn((_request: unknown) => new Promise<boolean>((resolve) => answers.push(resolve)));
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY, rollover: { ...ROLLOVER, approve } });
    const session = await stt.startSession();
    record(session);
    const first = Sockets.instances[0];
    await vi.advanceTimersByTimeAsync(10_000);
    first.serve({ type: 'input_audio_buffer.speech_started', item_id: 'item_A', audio_start_ms: 0 });
    first.serve({ type: 'input_audio_buffer.speech_stopped', item_id: 'item_A', audio_end_ms: 400 });
    await settle();
    expect(approve).toHaveBeenCalledOnce(); // the first connection's rollover waits for the host
    first.drop();
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    const replacement = Sockets.instances[1];
    replacement.serve({ type: 'input_audio_buffer.speech_started', item_id: 'item_B', audio_start_ms: 0 });
    replacement.serve({ type: 'input_audio_buffer.speech_stopped', item_id: 'item_B', audio_end_ms: 400 });
    await settle();
    expect(approve).toHaveBeenCalledTimes(2); // the replacement keeps the first connection's age: it rolls over too
    answers[0](true); // the dropped connection's answer comes late
    await settle();
    replacement.serve({ type: 'input_audio_buffer.speech_started', item_id: 'item_C', audio_start_ms: 500 });
    replacement.serve({ type: 'input_audio_buffer.speech_stopped', item_id: 'item_C', audio_end_ms: 900 });
    await settle();
    expect(approve).toHaveBeenCalledTimes(2); // the replacement's rollover still waits for its own answer
    expect(Sockets.instances).toHaveLength(2); // and the late answer opened nothing
    answers[1](true);
    await settle();
    expect(Sockets.instances).toHaveLength(3);
    session.close();
  });

  it('with client commits, ends the session at the hard stop while the approval is still awaited, and a late answer opens nothing', async () => {
    fakeClock();
    const answers: Array<(approved: boolean) => void> = [];
    const approve = vi.fn((_request: unknown) => new Promise<boolean>((resolve) => answers.push(resolve)));
    const stt = new OpenAIRealtimeTranscriptionSTT({
      apiKey: KEY,
      turnDetection: null,
      rollover: { ...ROLLOVER, approve },
    });
    const session = await stt.startSession();
    const log = record(session);
    const first = Sockets.instances[0];
    await vi.advanceTimersByTimeAsync(10_000);
    session.pushAudio(frame(2_400));
    const flushing = session.flush(); // past the rollover age: the first connection stops taking audio, the host is asked
    expect(approve).toHaveBeenCalledOnce();
    first.serve({ type: 'input_audio_buffer.committed', item_id: 'item_A', previous_item_id: null });
    first.serve({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item_A',
      transcript: 'The last turn here.',
    });
    await flushing;
    await vi.advanceTimersByTimeAsync(20_000); // 30 s: the first connection's hard stop, with no answer yet
    await settle();
    expect(log.events).toContain('close');
    expect(log.errors).toEqual([]);
    expect(first.close).toHaveBeenCalledOnce();
    answers[0](true); // the answer comes after the hard stop
    await settle();
    expect(Sockets.instances).toHaveLength(1);
  });

  it('reconnects at the old connection\'s hard stop when the connection that took over dropped during the overlap', async () => {
    fakeClock();
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY, rollover: ROLLOVER });
    const session = await stt.startSession();
    const log = record(session);
    const first = Sockets.instances[0];
    session.pushAudio(frame(2_400));
    await vi.advanceTimersByTimeAsync(20_000); // the deadline: the next connection opens whatever is said
    await settle();
    first.serve({ type: 'input_audio_buffer.speech_started', item_id: 'item_long', audio_start_ms: 50 });
    Sockets.instances[1].drop(); // the connection that took over drops while the old one is in speech
    await settle();
    expect(Sockets.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000); // 30 s: the old connection's hard stop
    expect(sentOfType(first, 'input_audio_buffer.commit')).toHaveLength(1);
    first.serve({ type: 'input_audio_buffer.committed', item_id: 'item_long', previous_item_id: null });
    first.serve({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item_long',
      transcript: 'A long stretch.',
    });
    await settle();
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(Sockets.instances).toHaveLength(3); // the dropped connection counts as following: a reconnect, not the end
    expect(log.events).not.toContain('close');
    session.close();
  });

  it('with client commits, retries a rollover whose next connection closes as its session update is confirmed, and opens one connection', async () => {
    fakeClock();
    const stt = new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY, turnDetection: null, rollover: ROLLOVER });
    const session = await stt.startSession();
    const log = record(session);
    const first = Sockets.instances[0];
    await vi.advanceTimersByTimeAsync(10_000);
    session.pushAudio(frame(2_400));
    Sockets.nextBehavior = 'ack-then-drop';
    const flushing = session.flush(); // past the rollover age: the first connection stops taking audio, the next one opens
    first.serve({ type: 'input_audio_buffer.committed', item_id: 'item_A', previous_item_id: null });
    first.serve({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item_A',
      transcript: 'The last turn here.',
    });
    await flushing;
    await settle();
    expect(Sockets.instances).toHaveLength(2); // confirmed, then closed at once: a failed attempt
    await vi.advanceTimersByTimeAsync(100); // the rollover retries it, by the retry rules
    await settle();
    expect(Sockets.instances).toHaveLength(3);
    session.pushAudio(frame(2_400));
    expect(sentOfType(Sockets.instances[2], 'input_audio_buffer.append')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(Sockets.instances).toHaveLength(3); // and no reconnect opens a connection beside it
    session.close();
    expect(log.usage.map((entry) => [entry.connectionIndex, entry.audioSeconds])).toEqual([
      [1, 0.1],
      [2, 0.1],
    ]);
  });

  it('with client commits, a flush that waits through a refused rollover goes on once the old connection takes audio again', async () => {
    fakeClock();
    const answers: Array<(approved: boolean) => void> = [];
    const approve = vi.fn((_request: unknown) => new Promise<boolean>((resolve) => answers.push(resolve)));
    const stt = new OpenAIRealtimeTranscriptionSTT({
      apiKey: KEY,
      turnDetection: null,
      finalTimeoutMs: 60_000,
      rollover: { ...ROLLOVER, approve },
    });
    const session = await stt.startSession();
    const log = record(session);
    const first = Sockets.instances[0];
    await vi.advanceTimersByTimeAsync(10_000);
    session.pushAudio(frame(2_400));
    const firstFlush = session.flush(); // past the rollover age: the connection stops taking audio, the host is asked
    expect(approve).toHaveBeenCalledOnce();
    first.serve({ type: 'input_audio_buffer.committed', item_id: 'item_A', previous_item_id: null });
    first.serve({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item_A',
      transcript: 'The first turn.',
    });
    await firstFlush;
    session.pushAudio(frame(2_400)); // the next turn, held while the host decides
    let flushed = false;
    const secondFlush = session.flush().then(() => {
      flushed = true;
    });
    await settle();
    expect(flushed).toBe(false); // no connection takes audio: the flush waits for one
    answers[0](false); // refused: the first connection takes the held audio, and the commit the flush asked for
    await settle();
    expect(sentOfType(first, 'input_audio_buffer.commit')).toHaveLength(2);
    first.serve({ type: 'input_audio_buffer.committed', item_id: 'item_B', previous_item_id: 'item_A' });
    first.serve({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item_B',
      transcript: 'The second turn.',
    });
    await settle();
    expect(flushed).toBe(true); // with that turn's final, not after finalTimeoutMs
    await secondFlush;
    expect(log.transcripts.map((t) => [t.itemId, t.text])).toEqual([
      ['item_A', 'The first turn.'],
      ['item_B', 'The second turn.'],
    ]);
    session.close();
  });
});

describe('OpenAIRealtimeTranscriptionSTT: turns in VoicePipelineOrchestrator', () => {
  /**
   * The orchestrator over the real provider, the real HeuristicEndpointDetector and
   * HardCutBargeinHandler, with a mock transport, TTS session and agent.
   */
  async function pipeline() {
    const transport = new EventEmitter() as any;
    transport.id = 'pipeline-test';
    transport.state = 'open';
    transport.sendAudio = vi.fn().mockResolvedValue(undefined);
    transport.sendControl = vi.fn().mockResolvedValue(undefined);
    transport.close = vi.fn().mockResolvedValue(undefined);
    const ttsSession = new EventEmitter() as any;
    ttsSession.pushTokens = vi.fn();
    ttsSession.flush = vi.fn().mockResolvedValue(undefined);
    ttsSession.cancel = vi.fn();
    ttsSession.close = vi.fn().mockResolvedValue(undefined);
    const agentSession = {
      sendText: vi.fn((_text: string, _metadata: unknown) =>
        (async function* () {
          yield 'Sure.';
        })()
      ),
      abort: vi.fn(),
    };
    const orchestrator = new VoicePipelineOrchestrator({ stt: 'openai-realtime-transcription', tts: 'mock-tts' });
    await orchestrator.startSession(transport, agentSession, {
      streamingSTT: new OpenAIRealtimeTranscriptionSTT({ apiKey: KEY }),
      streamingTTS: { providerId: 'mock-tts', startSession: vi.fn().mockResolvedValue(ttsSession) } as any,
      endpointDetector: new HeuristicEndpointDetector(),
      bargeinHandler: new HardCutBargeinHandler(),
    });
    return { orchestrator, agentSession, socket: Sockets.instances[Sockets.instances.length - 1] };
  }

  /** One utterance as OpenAI reports it: its end of speech and its commit come before its transcript. */
  function utterance(socket: FakeSocket, itemId: string, transcript: string): void {
    socket.serve({ type: 'input_audio_buffer.speech_started', item_id: itemId, audio_start_ms: 0 });
    socket.serve({ type: 'input_audio_buffer.speech_stopped', item_id: itemId, audio_end_ms: 900 });
    socket.serve({ type: 'input_audio_buffer.committed', item_id: itemId, previous_item_id: null });
    socket.serve({ type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, transcript });
  }

  it('hands the agent a turn whose final comes after the end of speech', async () => {
    fakeClock();
    const { orchestrator, agentSession, socket } = await pipeline();
    utterance(socket, 'item_A', 'What time is it?');
    await vi.advanceTimersByTimeAsync(0);
    expect(agentSession.sendText).toHaveBeenCalledOnce();
    expect(agentSession.sendText.mock.calls[0][0]).toBe('What time is it?');
    expect(agentSession.sendText.mock.calls[0][1]).toMatchObject({ endpointReason: 'punctuation' });
    await orchestrator.stopSession();
  });

  it('ends a turn without terminal punctuation after the silence timeout, counted from its final', async () => {
    fakeClock();
    const { orchestrator, agentSession, socket } = await pipeline();
    utterance(socket, 'item_A', 'book a table for two');
    await vi.advanceTimersByTimeAsync(1_499);
    expect(agentSession.sendText).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(agentSession.sendText).toHaveBeenCalledOnce();
    expect(agentSession.sendText.mock.calls[0][0]).toBe('book a table for two');
    expect(agentSession.sendText.mock.calls[0][1]).toMatchObject({ endpointReason: 'silence_timeout' });
    await orchestrator.stopSession();
  });

  it("keeps the turn's words when a later item's interim text is retracted with an empty final", async () => {
    fakeClock();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { orchestrator, agentSession, socket } = await pipeline();
    socket.serve({ type: 'input_audio_buffer.speech_started', item_id: 'item_A', audio_start_ms: 0 });
    socket.serve({ type: 'input_audio_buffer.speech_stopped', item_id: 'item_A', audio_end_ms: 900 });
    socket.serve({ type: 'input_audio_buffer.committed', item_id: 'item_A', previous_item_id: null });
    // The next utterance begins before the first one's transcript arrives.
    socket.serve({ type: 'input_audio_buffer.speech_started', item_id: 'item_B', audio_start_ms: 1_200 });
    socket.serve({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item_A',
      transcript: 'Book a table for two',
    });
    socket.serve({ type: 'input_audio_buffer.speech_stopped', item_id: 'item_B', audio_end_ms: 1_500 });
    socket.serve({ type: 'input_audio_buffer.committed', item_id: 'item_B', previous_item_id: 'item_A' });
    socket.serve({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item_B', delta: 'Uh' });
    socket.serve({
      type: 'conversation.item.input_audio_transcription.failed',
      item_id: 'item_B',
      content_index: 0,
      error: { type: 'transcription_error', message: 'Audio could not be transcribed.' },
    });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(agentSession.sendText).toHaveBeenCalledOnce();
    expect(agentSession.sendText.mock.calls[0][0]).toBe('Book a table for two');
    warn.mockRestore();
    await orchestrator.stopSession();
  });
});

describe('OpenAIRealtimeTranscriptionSTT: behind the failover chain of createVoiceProvidersFromEnv()', () => {
  it("reports usage and warnings through the chain's session", async () => {
    fakeClock();
    const { stt } = createVoiceProvidersFromEnv({
      env: { OPENAI_API_KEY: KEY },
      openaiRealtime: { usageIntervalMs: 5_000 },
    });
    const session = await stt.startSession();
    const log = record(session);
    const [socket] = Sockets.instances;
    session.pushAudio(frame(12_000)); // 0.5 s
    await vi.advanceTimersByTimeAsync(5_000);
    expect(log.usage).toEqual([
      {
        providerId: 'openai-realtime-transcription',
        model: 'gpt-4o-mini-transcribe',
        connectionIndex: 1,
        audioSeconds: 0.5,
        final: false,
      },
    ]);
    socket.serve({
      type: 'error',
      event_id: 'event_9',
      error: { type: 'invalid_request_error', code: null, message: 'Unknown parameter.', param: null, event_id: null },
    });
    expect(log.warnings.map((warning) => warning.message)).toEqual([expect.stringContaining('Unknown parameter.')]);
    session.close();
    await settle();
    expect(log.usage.map((entry) => [entry.connectionIndex, entry.audioSeconds, entry.final])).toEqual([
      [1, 0.5, false],
      [1, 0.5, true],
    ]);
  });
});
