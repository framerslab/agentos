/**
 * @module voice-pipeline/providers/DeepgramAuraStreamingTTS
 *
 * Streaming text-to-speech adapter for Deepgram Aura over WebSocket,
 * implementing {@link IStreamingTTS} / {@link StreamingTTSSession} for
 * {@link VoicePipelineOrchestrator}.
 *
 * ## Deepgram Aura WebSocket protocol
 *
 * - **Endpoint:** `wss://api.deepgram.com/v1/speak?model={voice}&encoding={enc}`
 * - **Authentication:** `Authorization: Token {apiKey}` header (same as REST).
 * - **Inbound (client → Deepgram):** JSON control frames —
 *   `{ "type": "Speak", "text": "..." }`, `{ "type": "Flush" }`, `{ "type": "Clear" }`.
 * - **Outbound (Deepgram → client):** BINARY audio frames, plus text JSON
 *   control frames (`{ "type": "Flushed" | "Cleared" | "Metadata" | "Warning" }`).
 *
 * Audio arrives as raw binary (unlike ElevenLabs, which base64-encodes audio
 * inside JSON), so the message handler branches on the `ws` `isBinary` flag.
 *
 * @see https://developers.deepgram.com/docs/tts-websocket
 */

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type {
  IStreamingTTS,
  StreamingTTSSession,
  StreamingTTSConfig,
  EncodedAudioChunk,
} from '../types.js';
import { ApiKeyPool } from '../../../core/providers/ApiKeyPool.js';
import {
  defaultCapabilities,
  type HealthyProvider,
  type HealthCheckResult,
  type ProviderCapabilities,
} from '../HealthyProvider.js';
import { VoicePipelineError } from '../VoicePipelineError.js';

const DEFAULT_VOICE = 'aura-2-thalia-en';
const DEFAULT_SAMPLE_RATE = 24_000;
/** How long to wait for the Deepgram WS upgrade before failing the connect. */
const CONNECT_TIMEOUT_MS = 8_000;

async function defaultDeepgramTtsProbe(apiKey: string) {
  const start = Date.now();
  const res = await fetch('https://api.deepgram.com/v1/auth/token', {
    headers: { Authorization: `Token ${apiKey}` },
    signal: AbortSignal.timeout(1000),
  });
  return { ok: res.ok, status: res.status, latencyMs: Date.now() - start };
}

/** Configuration for the {@link DeepgramAuraStreamingTTS} provider. */
export interface DeepgramAuraStreamingTTSConfig {
  /** Deepgram API key. */
  apiKey: string;
  /** Base WS URL. @default 'wss://api.deepgram.com/v1/speak' */
  baseUrl?: string;
  /** Default Aura voice model. @default 'aura-2-thalia-en' */
  voice?: string;
  /** Chain priority. Lower values are tried first. @default 5 */
  priority?: number;
  /** Optional capability overrides. */
  capabilities?: Partial<ProviderCapabilities>;
  /** Injectable health probe for tests. */
  healthProbe?: (apiKey: string) => Promise<{ ok: boolean; status: number; latencyMs: number }>;
}

/**
 * Map the pipeline audio-format union to a Deepgram STREAMING `encoding` value.
 *
 * The `/v1/speak` WebSocket accepts ONLY raw encodings — Deepgram rejects the
 * upgrade with `HTTP 400 UNSUPPORTED_AUDIO_FORMAT: encoding=mp3 is not
 * supported for streaming requests, expected one of linear16, mulaw, alaw`
 * (verified live 2026-07-08; mp3/opus are REST-only). So the wire is ALWAYS
 * `linear16`; when the caller asked for a compressed container (mp3/opus) each
 * emitted chunk is wrapped as a standalone WAV so browser consumers that
 * decode chunks via `AudioContext.decodeAudioData()` keep working unchanged.
 */
function toDeepgramEncoding(format: 'pcm' | 'mp3' | 'opus'): {
  encoding: string;
  container: 'wav' | 'raw';
} {
  if (format === 'pcm') return { encoding: 'linear16', container: 'raw' };
  return { encoding: 'linear16', container: 'wav' };
}

/**
 * Wrap a raw 16-bit mono PCM buffer in a standalone RIFF/WAVE header so the
 * chunk is independently decodable (`decodeAudioData` needs a container).
 */
function wrapWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * 2; // mono, 16-bit
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits/sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * A live streaming TTS session connected to Deepgram Aura via WebSocket.
 * Emits `audio`, `flush_complete`, `error`, and `close`.
 */
class DeepgramAuraStreamingTTSSession extends EventEmitter implements StreamingTTSSession {
  private ws: WebSocket | null = null;
  private closed = false;
  private pendingFlush = false;
  private accumulatedText = '';
  private readonly voice: string;
  private readonly encoding: string;
  private readonly container: 'wav' | 'raw';
  private readonly sampleRate: number;

  constructor(
    private readonly config: DeepgramAuraStreamingTTSConfig,
    sessionConfig: StreamingTTSConfig
  ) {
    super();
    this.voice = sessionConfig.voice ?? config.voice ?? DEFAULT_VOICE;
    const mapped = toDeepgramEncoding(sessionConfig.format ?? 'mp3');
    this.encoding = mapped.encoding;
    this.container = mapped.container;
    this.sampleRate = sessionConfig.sampleRate ?? DEFAULT_SAMPLE_RATE;
  }

  /**
   * Open the WebSocket. Deepgram needs no beginning-of-stream handshake.
   *
   * Failure paths settle the returned promise EXACTLY once and reject FIRST:
   * the previous implementation ran `this.emit('error', err)` before
   * `reject(err)`, and at connect time no `'error'` listener exists yet, so
   * the emit threw synchronously (Node EventEmitter contract), `reject` never
   * executed, and the connect promise never settled — the caller (orchestrator
   * `startSession`) awaited forever and the voice session became a silent
   * zombie while the raw error surfaced only as a process-level
   * `uncaughtException`. A handshake rejection now also captures the HTTP
   * response body (`unexpected-response`), which carries Deepgram's actual
   * error (e.g. UNSUPPORTED_AUDIO_FORMAT) instead of the blind
   * "Unexpected server response: 400".
   */
  async connect(): Promise<void> {
    const wsBase = this.config.baseUrl ?? 'wss://api.deepgram.com/v1/speak';
    const params = new URLSearchParams({ model: this.voice, encoding: this.encoding });
    // linear16 (raw PCM) requires an explicit sample_rate; container formats infer it.
    if (this.encoding === 'linear16') params.set('sample_rate', String(this.sampleRate));
    const url = `${wsBase}?${params.toString()}`;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        fail(new Error(`deepgram aura ws connect timed out after ${CONNECT_TIMEOUT_MS}ms`));
      }, CONNECT_TIMEOUT_MS);
      const fail = (err: Error): void => {
        if (settled) {
          this._emitErrorSafe(err);
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(err);
      };

      this.ws = new WebSocket(url, {
        headers: { Authorization: `Token ${this.config.apiKey}` },
      });

      // The server refused the upgrade (4xx/5xx). Read the response body —
      // Deepgram names the offending parameter in it.
      this.ws.on('unexpected-response', (_req, res) => {
        let body = '';
        res.on('data', (d: Buffer) => {
          body += d.toString('utf-8');
        });
        res.on('end', () => {
          fail(
            new Error(
              `deepgram aura ws rejected: HTTP ${res.statusCode}${body ? ` — ${body.slice(0, 300)}` : ''}`
            )
          );
        });
      });

      this.ws.on('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
      this.ws.on('error', (err: Error) => fail(err));
      this.ws.on('message', (data: Buffer, isBinary: boolean) => this._handleMessage(data, isBinary));
      this.ws.on('close', () => {
        if (!settled) fail(new Error('deepgram aura ws closed before the upgrade completed'));
        this.closed = true;
        this.emit('close');
      });
    });
  }

  /**
   * Emit `'error'` only when a listener exists — an unlistened EventEmitter
   * `'error'` throws and takes the whole process down as an uncaughtException.
   */
  private _emitErrorSafe(err: Error): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', err);
    } else {
      console.warn('[deepgram-aura] session error (no listener attached):', err.message);
    }
  }

  pushTokens(tokens: string): void {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.accumulatedText += tokens;
    this.ws.send(JSON.stringify({ type: 'Speak', text: tokens }));
  }

  async flush(): Promise<void> {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.pendingFlush = true;
    this.ws.send(JSON.stringify({ type: 'Flush' }));

    return new Promise<void>((resolve) => {
      const onFlush = () => {
        this.removeListener('_internal_flush', onFlush);
        clearTimeout(timeout);
        resolve();
      };
      // Safety timeout: resolve after 5s even if no Flushed frame arrives.
      const timeout = setTimeout(() => {
        this.removeListener('_internal_flush', onFlush);
        this.pendingFlush = false;
        this.emit('flush_complete');
        resolve();
      }, 5_000);
      this.on('_internal_flush', onFlush);
    });
  }

  cancel(): void {
    this.pendingFlush = false;
    this.accumulatedText = '';
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Clear discards server-buffered audio without tearing down the socket.
      this.ws.send(JSON.stringify({ type: 'Clear' }));
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.close(1000, 'session closed');
      this.ws = null;
    }
    this.emit('close');
  }

  private _handleMessage(data: Buffer, isBinary: boolean): void {
    if (isBinary) {
      const pcmBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      // The wire is always linear16 (see toDeepgramEncoding): uncompressed
      // 16-bit mono at sampleRate * 2 bytes/sec — duration derives from the
      // RAW pcm bytes, before any container wrapping.
      const durationMs = Math.round((pcmBuffer.byteLength / (this.sampleRate * 2)) * 1000);
      // Compressed-container callers (mp3/opus) get each chunk wrapped as a
      // standalone WAV so per-chunk `decodeAudioData()` consumers work
      // unchanged; explicit 'pcm' callers get the raw samples.
      const audioBuffer =
        this.container === 'wav' ? wrapWav(pcmBuffer, this.sampleRate) : pcmBuffer;
      const chunk: EncodedAudioChunk = {
        audio: audioBuffer,
        format: 'pcm',
        sampleRate: this.sampleRate,
        durationMs,
        text: this.accumulatedText,
      };
      this.emit('audio', chunk);
      return;
    }

    // Text control frame.
    let msg: { type?: string };
    try {
      msg = JSON.parse(data.toString('utf-8'));
    } catch {
      return;
    }
    if (msg.type === 'Flushed') {
      this.accumulatedText = '';
      if (this.pendingFlush) {
        this.pendingFlush = false;
        this.emit('_internal_flush');
        this.emit('flush_complete');
      }
    }
    // Metadata / Cleared / Warning frames are ignored.
  }
}

/**
 * Streaming TTS provider that creates Deepgram Aura WebSocket sessions.
 * Implements {@link IStreamingTTS} for use with {@link VoicePipelineOrchestrator}.
 *
 * @example
 * ```typescript
 * const tts = new DeepgramAuraStreamingTTS({ apiKey: process.env.DEEPGRAM_API_KEY! });
 * const session = await tts.startSession({ voice: 'aura-2-arcas-en' });
 * session.on('audio', (chunk) => transport.sendAudio(chunk));
 * session.pushTokens('Hello there!');
 * await session.flush();
 * ```
 */
export class DeepgramAuraStreamingTTS implements IStreamingTTS, HealthyProvider {
  readonly providerId = 'deepgram-aura';
  readonly priority: number;
  readonly capabilities: ProviderCapabilities;
  private readonly keyPool: ApiKeyPool;
  private readonly healthProbe: NonNullable<DeepgramAuraStreamingTTSConfig['healthProbe']>;

  constructor(private readonly config: DeepgramAuraStreamingTTSConfig) {
    this.keyPool = new ApiKeyPool(config.apiKey);
    this.priority = config.priority ?? 5;
    this.capabilities = defaultCapabilities({
      languages: ['*'],
      streaming: true,
      costTier: 'cheap',
      latencyClass: 'realtime',
      ...(config.capabilities ?? {}),
    });
    this.healthProbe = config.healthProbe ?? defaultDeepgramTtsProbe;
  }

  async healthCheck(): Promise<HealthCheckResult> {
    if (!this.keyPool.hasKeys) {
      return { ok: false, error: { class: 'auth', message: 'no api key available' } };
    }
    const key = this.keyPool.next();
    try {
      const res = await this.healthProbe(key);
      if (res.ok) return { ok: true, latencyMs: res.latencyMs };
      const classified = VoicePipelineError.classifyError(new Error(`HTTP ${res.status}`), {
        kind: 'tts',
        provider: this.providerId,
      });
      return {
        ok: false,
        latencyMs: res.latencyMs,
        error: { class: classified.errorClass, message: `HTTP ${res.status}` },
      };
    } catch (err) {
      const classified = VoicePipelineError.classifyError(err, {
        kind: 'tts',
        provider: this.providerId,
      });
      return { ok: false, error: { class: classified.errorClass, message: classified.message } };
    }
  }

  async startSession(config?: StreamingTTSConfig): Promise<StreamingTTSSession> {
    const resolvedConfig = { ...this.config, apiKey: this.keyPool.next() };
    const session = new DeepgramAuraStreamingTTSSession(resolvedConfig, config ?? {});
    await session.connect();
    return session;
  }
}
