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
