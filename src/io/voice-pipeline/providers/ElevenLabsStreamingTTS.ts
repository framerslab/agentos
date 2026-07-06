/**
 * @module voice-pipeline/providers/ElevenLabsStreamingTTS
 *
 * Streaming text-to-speech adapter that connects to ElevenLabs' WebSocket API
 * and implements the {@link IStreamingTTS} / {@link StreamingTTSSession} interfaces
 * required by {@link VoicePipelineOrchestrator}.
 *
 * ## ElevenLabs WebSocket Protocol
 *
 * - **Endpoint:** `wss://api.elevenlabs.io/v1/text-to-speech/{voiceId}/stream-input`
 * - **Authentication:** `xi-api-key` query parameter
 * - **Inbound (client → ElevenLabs):** JSON text chunks `{ text: "...", ... }`
 * - **Outbound (ElevenLabs → client):** JSON with base64-encoded audio `{ audio: "...", ... }`
 * - **Flush:** Send `{ text: "" }` to signal end-of-input and flush remaining audio
 *
 * ## Audio Output
 *
 * ElevenLabs returns audio as base64-encoded MP3 chunks. Each chunk is decoded
 * and wrapped in an {@link EncodedAudioChunk} with format `'mp3'` before being
 * emitted as an `'audio'` event.
 *
 * @see https://elevenlabs.io/docs/api-reference/websockets
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

async function defaultElevenLabsTtsProbe(apiKey: string) {
  const start = Date.now();
  const res = await fetch('https://api.elevenlabs.io/v1/user', {
    headers: { 'xi-api-key': apiKey },
    signal: AbortSignal.timeout(1000),
  });
  return { ok: res.ok, status: res.status, latencyMs: Date.now() - start };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the {@link ElevenLabsStreamingTTS} provider.
 */
export interface ElevenLabsStreamingTTSConfig {
  /** ElevenLabs API key. */
  apiKey: string;

  /**
   * Base URL for the ElevenLabs API (HTTP, not WS — the WS URL is derived).
   * @default 'https://api.elevenlabs.io/v1'
   */
  baseUrl?: string;

  /**
   * Default voice ID for synthesis.
   * @default 'EXAVITQu4vr4xnSDxMaL' (Sarah)
   */
  voiceId?: string;

  /**
   * ElevenLabs model ID.
   * @default 'eleven_multilingual_v2'
   */
  model?: string;

  /** Chain priority. Lower values are tried first. @default 10 */
  priority?: number;

  /** Optional capability overrides. */
  capabilities?: Partial<ProviderCapabilities>;

  /** Injectable health probe for tests. */
  healthProbe?: (apiKey: string) => Promise<{ ok: boolean; status: number; latencyMs: number }>;
}

// ---------------------------------------------------------------------------
// ElevenLabs response types
// ---------------------------------------------------------------------------

/** Audio chunk response from ElevenLabs WebSocket. */
interface ELAudioMessage {
  audio?: string; // base64-encoded audio
  isFinal?: boolean;
  normalizedAlignment?: {
    char_start_times_ms: number[];
    chars_durations_ms: number[];
    chars: string[];
  };
}

// ---------------------------------------------------------------------------
// Session Implementation
// ---------------------------------------------------------------------------

/**
 * A live streaming TTS session connected to ElevenLabs via WebSocket.
 * Emits `audio`, `flush_complete`, `error`, and `close` events as required
 * by the voice pipeline orchestrator.
 */
class ElevenLabsStreamingTTSSession extends EventEmitter implements StreamingTTSSession {
  private ws: WebSocket | null = null;
  private closed = false;
  private pendingFlush = false;
  private accumulatedText = '';

  /** Estimated bytes per second for duration calculation. MP3 at 128kbps = ~16000 bytes/sec. */
  private static readonly BYTES_PER_SEC_MP3 = 16_000;

  constructor(
    private readonly config: ElevenLabsStreamingTTSConfig,
    private readonly sessionConfig: StreamingTTSConfig
  ) {
    super();
  }

  /**
   * Open the WebSocket connection to ElevenLabs streaming endpoint.
   * Sends the initial BOS (beginning of stream) message with generation config.
   */
  async connect(): Promise<void> {
    const voiceId = this.sessionConfig.voice ?? this.config.voiceId ?? 'EXAVITQu4vr4xnSDxMaL';
    const model = this.config.model ?? 'eleven_multilingual_v2';

    // Convert HTTPS base URL to WSS
    const httpBase = this.config.baseUrl ?? 'https://api.elevenlabs.io/v1';
    const wsBase = httpBase.replace(/^https?:\/\//, 'wss://');

    const params = new URLSearchParams({
      model_id: model,
      output_format: 'mp3_44100_128',
    });

    const url = `${wsBase}/text-to-speech/${voiceId}/stream-input?${params.toString()}`;

    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(url, {
        headers: {
          'xi-api-key': this.config.apiKey,
        },
      });

      this.ws.on('open', () => {
        // Send BOS (beginning of stream) message with generation settings
        // First-class expressiveness wins over legacy providerOptions per
        // knob — same camelCase names, plain spread merge.
        const opts: Record<string, unknown> = {
          ...(this.sessionConfig?.providerOptions ?? {}),
          ...(this.sessionConfig?.expressiveness ?? {}),
        };
        this.ws!.send(
          JSON.stringify({
            text: ' ', // Initial space triggers the stream
            voice_settings: {
              stability: (opts.stability as number) ?? 0.5,
              similarity_boost: (opts.similarityBoost as number) ?? 0.75,
              style: (opts.style as number) ?? 0.0,
              use_speaker_boost: (opts.useSpeakerBoost as boolean) ?? true,
            },
            generation_config: {
              chunk_length_schedule: [120, 160, 250, 290],
              ...(opts.speed != null ? { speed: opts.speed } : {}),
            },
          })
        );
        resolve();
      });

      this.ws.on('error', (err) => {
        this.emit('error', err);
        reject(err);
      });

      this.ws.on('message', (data: Buffer | string) => {
        this._handleMessage(typeof data === 'string' ? data : data.toString('utf-8'));
      });

      this.ws.on('close', () => {
        this.closed = true;
        this.emit('close');
      });
    });
  }

  /**
   * Push text tokens into the TTS stream.
   * ElevenLabs expects text to be sent as JSON messages. Text is accumulated
   * and sent in chunks to allow the synthesis engine to produce natural-sounding
   * speech with proper prosody across sentence boundaries.
   */
  pushTokens(tokens: string): void {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.accumulatedText += tokens;

    // Send text to ElevenLabs as it arrives — the server handles buffering
    // and chunking for optimal synthesis quality
    this.ws.send(JSON.stringify({ text: tokens }));
  }

  /**
   * Signal end-of-text and flush remaining audio from the synthesis buffer.
   * ElevenLabs requires an empty text message to signal EOS (end of stream).
   * Resolves when all audio has been received (the server sends an isFinal message).
   */
  async flush(): Promise<void> {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.pendingFlush = true;

    // Send EOS (end of stream) — empty string signals the end of input
    this.ws.send(JSON.stringify({ text: '' }));

    // Wait for the final audio chunk or timeout
    return new Promise<void>((resolve) => {
      const onFlush = () => {
        this.removeListener('_internal_flush', onFlush);
        clearTimeout(timeout);
        resolve();
      };

      // Safety timeout: resolve after 5s even if no final message arrives
      const timeout = setTimeout(() => {
        this.removeListener('_internal_flush', onFlush);
        this.pendingFlush = false;
        this.emit('flush_complete');
        resolve();
      }, 5_000);

      this.on('_internal_flush', onFlush);
    });
  }

  /**
   * Cancel the current synthesis and discard any pending audio.
   * Closes the WebSocket — a new session must be created for more synthesis.
   */
  cancel(): void {
    this.pendingFlush = false;
    this.accumulatedText = '';

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Send a close signal
      this.ws.close(1000, 'cancelled');
    }
  }

  /**
   * Close the WebSocket connection and clean up.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close(1000, 'session closed');
      }
      this.ws = null;
    }

    this.emit('close');
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /**
   * Parse and dispatch an ElevenLabs WebSocket message.
   * Audio chunks arrive as base64-encoded MP3 data that we decode and emit.
   */
  private _handleMessage(raw: string): void {
    let msg: ELAudioMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // Malformed JSON — skip
    }

    // Audio chunk received
    if (msg.audio) {
      const audioBuffer = Buffer.from(msg.audio, 'base64');

      // Estimate duration from MP3 byte count (128kbps MP3)
      const durationMs = Math.round(
        (audioBuffer.byteLength / ElevenLabsStreamingTTSSession.BYTES_PER_SEC_MP3) * 1000
      );

      const chunk: EncodedAudioChunk = {
        audio: audioBuffer,
        format: 'mp3',
        sampleRate: 44100,
        durationMs,
        text: this.accumulatedText,
      };

      this.emit('audio', chunk);
    }

    // Final message — all audio has been sent
    if (msg.isFinal) {
      this.accumulatedText = '';

      if (this.pendingFlush) {
        this.pendingFlush = false;
        this.emit('_internal_flush');
        this.emit('flush_complete');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Provider (Factory)
// ---------------------------------------------------------------------------

/**
 * Streaming TTS provider that creates ElevenLabs WebSocket sessions.
 * Implements {@link IStreamingTTS} for use with {@link VoicePipelineOrchestrator}.
 *
 * @example
 * ```typescript
 * const tts = new ElevenLabsStreamingTTS({
 *   apiKey: process.env.ELEVENLABS_API_KEY!,
 *   voiceId: 'EXAVITQu4vr4xnSDxMaL',
 * });
 * const session = await tts.startSession({ voice: 'pNInz6obpgDQGcFmaJgB' });
 * session.on('audio', (chunk) => transport.sendAudio(chunk));
 * session.pushTokens('Hello there!');
 * await session.flush();
 * ```
 */
export class ElevenLabsStreamingTTS implements IStreamingTTS, HealthyProvider {
  readonly providerId = 'elevenlabs-streaming';
  readonly priority: number;
  readonly capabilities: ProviderCapabilities;
  private readonly keyPool: ApiKeyPool;
  private readonly healthProbe: NonNullable<
    ElevenLabsStreamingTTSConfig['healthProbe']
  >;

  constructor(private readonly config: ElevenLabsStreamingTTSConfig) {
    this.keyPool = new ApiKeyPool(config.apiKey);
    this.priority = config.priority ?? 10;
    this.capabilities = defaultCapabilities({
      languages: ['*'],
      streaming: true,
      costTier: 'standard',
      latencyClass: 'realtime',
      ...(config.capabilities ?? {}),
    });
    this.healthProbe = config.healthProbe ?? defaultElevenLabsTtsProbe;
  }

  async healthCheck(): Promise<HealthCheckResult> {
    if (!this.keyPool.hasKeys) {
      return { ok: false, error: { class: 'auth', message: 'no api key available' } };
    }
    const key = this.keyPool.next();
    try {
      const res = await this.healthProbe(key);
      if (res.ok) return { ok: true, latencyMs: res.latencyMs };
      const classified = VoicePipelineError.classifyError(
        new Error(`HTTP ${res.status}`),
        { kind: 'tts', provider: this.providerId }
      );
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
      return {
        ok: false,
        error: { class: classified.errorClass, message: classified.message },
      };
    }
  }

  /**
   * Create a new streaming TTS session connected to ElevenLabs.
   * The session opens a WebSocket and is ready to receive text tokens.
   * Each session gets a fresh key from the round-robin pool.
   */
  async startSession(config?: StreamingTTSConfig): Promise<StreamingTTSSession> {
    const resolvedConfig = { ...this.config, apiKey: this.keyPool.next() };
    const session = new ElevenLabsStreamingTTSSession(resolvedConfig, config ?? {});
    await session.connect();
    return session;
  }
}
