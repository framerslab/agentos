/**
 * @module voice-pipeline/providers/CartesiaStreamingTTS
 *
 * Streaming text-to-speech via Cartesia's WebSocket API. Implements
 * {@link IStreamingTTS} for realtime token-in / audio-out synthesis.
 *
 * Contract notes (verified 2026-07-08): connect to
 * `wss://api.cartesia.ai/tts/websocket?cartesia_version=…&api_key=…`;
 * incremental transcript messages share a `context_id` and carry
 * `continue: true`; a context is finished with `continue: false` and the
 * server acknowledges completion with a `done` message.
 *
 * ⚠️ Vendor `cancel` is SOFT — it only halts requests that have not begun
 * generating. AgentOS `cancel()` demands immediate stop/discard, so this
 * session implements HARD cancel locally: the cancelled context id joins a
 * dead-set whose inbound chunks are dropped, a best-effort vendor cancel is
 * sent, and the next synthesis rotates to a fresh context id.
 */

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import type {
  EncodedAudioChunk,
  IStreamingTTS,
  StreamingTTSConfig,
  StreamingTTSSession,
} from '../types.js';
import { ApiKeyPool } from '../../../core/providers/ApiKeyPool.js';
import {
  defaultCapabilities,
  type HealthyProvider,
  type HealthCheckResult,
  type ProviderCapabilities,
} from '../HealthyProvider.js';
import { VoicePipelineError } from '../VoicePipelineError.js';
import { CARTESIA_VERSION } from './CartesiaBatchTTS.js';

/** Configuration for the Cartesia streaming TTS provider. */
export interface CartesiaStreamingTTSConfig {
  /** Cartesia API key (`sk_car_…`). */
  apiKey: string;
  /** Default voice id. Cartesia voices are ids; there is no vendor default. */
  voiceId: string;
  /** Model identifier. @default 'sonic-3.5' */
  model?: string;
  /** Output sample rate (Hz) for raw pcm chunks. @default 16000 */
  sampleRate?: number;
  /** WebSocket endpoint. @default 'wss://api.cartesia.ai/tts/websocket' */
  wsUrl?: string;
  /** Chain priority. Lower values are tried first. @default 12 */
  priority?: number;
  /** Optional capability overrides. */
  capabilities?: Partial<ProviderCapabilities>;
}

/**
 * One live Cartesia synthesis session over a shared WebSocket. Contexts are
 * rotated on cancel so late chunks from a killed utterance can never leak
 * into the next one.
 */
class CartesiaStreamingTTSSession extends EventEmitter implements StreamingTTSSession {
  /** Exposed for tests (mirrors the ElevenLabs session's introspection seam). */
  private ws: WebSocket | null = null;

  /** Context id for the CURRENT utterance; rotated on cancel. */
  private contextId = randomUUID();

  /** Context ids hard-cancelled locally — inbound chunks for these drop. */
  private readonly deadContexts = new Set<string>();

  /** Resolvers waiting on the current context's `done`. */
  private flushResolvers: Array<() => void> = [];

  private closed = false;

  /** Tokens pushed since the last done/cancel — stamped on each chunk so
   *  barge-in handlers can report the interrupted remainder. */
  private accumulatedText = '';

  constructor(
    private readonly opts: {
      url: string;
      voiceId: string;
      model: string;
      sampleRate: number;
      format: 'pcm' | 'mp3';
    }
  ) {
    super();
  }

  /** Open the socket; resolves once the connection is live. */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.opts.url);
      this.ws = ws;
      ws.on('open', () => resolve());
      ws.on('error', (err: Error) => {
        if (this.closed) return;
        this.emit('error', err);
        reject(err);
      });
      ws.on('close', () => {
        if (!this.closed) this.emit('close');
      });
      ws.on('message', (raw: unknown) => this.onMessage(raw));
    });
  }

  private onMessage(raw: unknown): void {
    let msg: {
      type?: string;
      context_id?: string;
      data?: string;
      error?: string;
    };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return; // Non-JSON frames are not part of the documented surface.
    }
    // HARD-cancel enforcement: anything addressed to a dead context drops.
    if (msg.context_id && this.deadContexts.has(msg.context_id)) return;

    if (msg.type === 'chunk' && typeof msg.data === 'string') {
      const audio = Buffer.from(msg.data, 'base64');
      const chunk: EncodedAudioChunk = {
        audio,
        format: this.opts.format,
        sampleRate: this.opts.sampleRate,
        durationMs:
          this.opts.format === 'pcm'
            ? Math.max(1, Math.round((audio.byteLength / (this.opts.sampleRate * 2)) * 1000))
            : Math.max(1, Math.round((audio.byteLength / 16_000) * 1000)),
        text: this.accumulatedText,
      };
      this.emit('audio', chunk);
      return;
    }
    if (msg.type === 'done') {
      this.accumulatedText = '';
      const resolvers = this.flushResolvers;
      this.flushResolvers = [];
      this.emit('flush_complete');
      for (const r of resolvers) r();
      return;
    }
    if (msg.type === 'error') {
      this.emit('error', new Error(`Cartesia stream error: ${msg.error ?? 'unknown'}`));
    }
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  /** Shared request envelope for the current context. */
  private envelope(): Record<string, unknown> {
    return {
      context_id: this.contextId,
      model_id: this.opts.model,
      voice: { mode: 'id', id: this.opts.voiceId },
      output_format:
        this.opts.format === 'pcm'
          ? { container: 'raw', encoding: 'pcm_s16le', sample_rate: this.opts.sampleRate }
          : { container: 'mp3', bit_rate: 128_000, sample_rate: 44_100 },
    };
  }

  pushTokens(tokens: string): void {
    if (this.closed || tokens.length === 0) return;
    this.accumulatedText += tokens;
    this.send({ ...this.envelope(), transcript: tokens, continue: true });
  }

  async flush(): Promise<void> {
    if (this.closed) return;
    const done = new Promise<void>((resolve) => this.flushResolvers.push(resolve));
    // continue:false finishes the context; the server answers with `done`.
    this.send({ ...this.envelope(), transcript: '', continue: false });
    await done;
  }

  cancel(): void {
    if (this.closed) return;
    const dead = this.contextId;
    this.deadContexts.add(dead);
    // Best-effort vendor cancel (only stops not-yet-generating requests);
    // correctness comes from the local dead-context drop + rotation.
    this.send({ context_id: dead, cancel: true });
    this.contextId = randomUUID();
    this.flushResolvers = [];
    this.accumulatedText = '';
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* already gone */
    }
    this.emit('close');
  }
}

/**
 * Streaming TTS provider for Cartesia sonic models.
 *
 * Sessions default to raw pcm_s16le chunks at 16 kHz — directly feedable to
 * realtime avatar consumers — and honor `format: 'mp3'` when asked.
 */
export class CartesiaStreamingTTS implements IStreamingTTS, HealthyProvider {
  readonly providerId = 'cartesia-sonic-stream';
  readonly priority: number;
  readonly capabilities: ProviderCapabilities;

  private readonly keyPool: ApiKeyPool;
  private readonly voiceId: string;
  private readonly model: string;
  private readonly sampleRate: number;
  private readonly wsUrl: string;

  constructor(config: CartesiaStreamingTTSConfig) {
    this.keyPool = new ApiKeyPool(config.apiKey);
    this.voiceId = config.voiceId;
    this.model = config.model ?? 'sonic-3.5';
    this.sampleRate = config.sampleRate ?? 16000;
    this.wsUrl = config.wsUrl ?? 'wss://api.cartesia.ai/tts/websocket';
    this.priority = config.priority ?? 12;
    this.capabilities = defaultCapabilities({
      languages: ['*'],
      streaming: true,
      costTier: 'standard',
      latencyClass: 'realtime',
      ...(config.capabilities ?? {}),
    });
  }

  async healthCheck(): Promise<HealthCheckResult> {
    if (!this.keyPool.hasKeys) {
      return { ok: false, error: { class: 'auth', message: 'no api key available' } };
    }
    const start = Date.now();
    try {
      const res = await fetch('https://api.cartesia.ai/voices?limit=1', {
        headers: {
          Authorization: `Bearer ${this.keyPool.next()}`,
          'Cartesia-Version': CARTESIA_VERSION,
        },
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return { ok: true, latencyMs: Date.now() - start };
      const classified = VoicePipelineError.classifyError(
        new Error(`HTTP ${res.status}`),
        { kind: 'tts', provider: this.providerId }
      );
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: { class: classified.errorClass, message: `HTTP ${res.status}` },
      };
    } catch (err) {
      const classified = VoicePipelineError.classifyError(err, {
        kind: 'tts',
        provider: this.providerId,
      });
      return {
        ok: false,
        error: { class: classified.errorClass, message: classified.message },
      };
    }
  }

  async startSession(config?: StreamingTTSConfig): Promise<StreamingTTSSession> {
    const key = this.keyPool.next();
    // Browser-style query auth keeps the handshake header-free (the ws
    // package would support headers, but query auth matches the documented
    // access_token/api_key surface and simplifies test doubles).
    const url =
      `${this.wsUrl}?cartesia_version=${encodeURIComponent(CARTESIA_VERSION)}` +
      `&api_key=${encodeURIComponent(key)}`;
    const format: 'pcm' | 'mp3' = config?.format === 'mp3' ? 'mp3' : 'pcm';
    const session = new CartesiaStreamingTTSSession({
      url,
      voiceId: config?.voice ?? this.voiceId,
      model: this.model,
      sampleRate: config?.sampleRate ?? this.sampleRate,
      format,
    });
    await session.connect();
    return session;
  }
}
