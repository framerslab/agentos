/**
 * @module voice-pipeline/providers/ElevenLabsStreamingSTT
 *
 * Streaming speech-to-text adapter for ElevenLabs' WebSocket STT API.
 * Implements {@link IStreamingSTT} / {@link StreamingSTTSession} for the
 * voice pipeline orchestrator.
 *
 * ## ElevenLabs STT WebSocket Protocol
 *
 * - **Endpoint:** `wss://api.elevenlabs.io/v1/speech-to-text/stream`
 * - **Authentication:** `xi-api-key` header on upgrade
 * - **Inbound (client → ElevenLabs):** Binary PCM frames (16-bit signed LE, 16kHz mono)
 * - **Outbound (ElevenLabs → client):** JSON transcript results
 * - **Close:** Send JSON `{ "type": "close_stream" }` to finalize
 *
 * ## Fallback: Chunked REST
 *
 * If the WebSocket endpoint is unavailable or errors, this adapter falls back
 * to a chunked REST approach: accumulates audio into ~2s chunks and POSTs each
 * to `/v1/speech-to-text` for batch transcription. This provides near-realtime
 * results (2s latency per chunk) using only the REST API.
 *
 * @see https://elevenlabs.io/docs/api-reference/speech-to-text
 */

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type {
  IStreamingSTT,
  StreamingSTTSession,
  StreamingSTTConfig,
  AudioFrame,
  TranscriptEvent,
  TranscriptWord,
} from '../types.js';
import { ApiKeyPool } from '../../../core/providers/ApiKeyPool.js';
import {
  defaultCapabilities,
  type HealthyProvider,
  type HealthCheckResult,
  type ProviderCapabilities,
} from '../HealthyProvider.js';
import { VoicePipelineError } from '../VoicePipelineError.js';

async function defaultElevenLabsProbe(apiKey: string) {
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
 * Configuration for the {@link ElevenLabsStreamingSTT} provider.
 */
export interface ElevenLabsStreamingSTTConfig {
  /** ElevenLabs API key. */
  apiKey: string;

  /**
   * Base URL for the ElevenLabs API.
   * @default 'https://api.elevenlabs.io/v1'
   */
  baseUrl?: string;

  /**
   * STT model, sent as `model_id` on every request (ElevenLabs requires it).
   * ElevenLabs lists `scribe_v1` as deprecated in favour of `scribe_v2`.
   * @default 'scribe_v2'
   */
  model?: string;

  /** Chain priority. Lower values are tried first. @default 20 */
  priority?: number;

  /** Optional capability overrides. */
  capabilities?: Partial<ProviderCapabilities>;

  /** Injectable health probe for tests. */
  healthProbe?: (apiKey: string) => Promise<{ ok: boolean; status: number; latencyMs: number }>;
}

/** ElevenLabs' current batch speech-to-text model. */
const DEFAULT_STT_MODEL = 'scribe_v2';

// ---------------------------------------------------------------------------
// ElevenLabs STT response types
// ---------------------------------------------------------------------------

interface ELTranscriptWord {
  text: string;
  start: number;
  end: number;
  confidence: number;
}

interface ELTranscriptMessage {
  type?: string;
  text?: string;
  is_final?: boolean;
  words?: ELTranscriptWord[];
  language_code?: string;
}

// ---------------------------------------------------------------------------
// Session Implementation — Chunked REST fallback
// ---------------------------------------------------------------------------

/**
 * ElevenLabs streaming STT session using chunked REST calls.
 *
 * Accumulates PCM audio into ~2-second chunks and sends each to the
 * ElevenLabs batch STT endpoint. Provides near-realtime transcription
 * with the same API key used for TTS.
 */
class ElevenLabsChunkedSTTSession extends EventEmitter implements StreamingSTTSession {
  private closed = false;
  private speechActive = false;
  private audioBuffer: Int16Array[] = [];
  private bufferSamples = 0;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  /** Samples per chunk: 2 seconds at 16kHz = 32,000 samples. */
  private static readonly CHUNK_SAMPLES = 32_000;

  constructor(
    private readonly config: ElevenLabsStreamingSTTConfig,
    private readonly sessionConfig: StreamingSTTConfig
  ) {
    super();

    // Flush accumulated audio every 2 seconds
    this.flushTimer = setInterval(() => {
      if (this.bufferSamples > 0) {
        this._transcribeBuffer();
      }
    }, 2_000);
  }

  /**
   * Push a PCM audio frame. Converts Float32 to Int16 and accumulates.
   */
  pushAudio(frame: AudioFrame): void {
    if (this.closed) return;

    // Convert Float32 [-1, 1] to Int16 PCM
    const pcm = new Int16Array(frame.samples.length);
    for (let i = 0; i < frame.samples.length; i++) {
      const s = Math.max(-1, Math.min(1, frame.samples[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    this.audioBuffer.push(pcm);
    this.bufferSamples += pcm.length;

    // Detect speech activity from energy
    let energy = 0;
    for (let i = 0; i < pcm.length; i++) {
      energy += Math.abs(pcm[i]);
    }
    energy /= pcm.length;

    if (energy > 500 && !this.speechActive) {
      this.speechActive = true;
      this.emit('speech_start');
    }
  }

  /**
   * Flush any remaining audio and transcribe.
   */
  async flush(): Promise<void> {
    if (this.bufferSamples > 0) {
      await this._transcribeBuffer();
    }
  }

  /**
   * Close the session and stop the flush timer.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    this.emit('close');
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /**
   * Concatenate accumulated PCM chunks into a WAV buffer and POST to
   * ElevenLabs batch STT endpoint.
   */
  private async _transcribeBuffer(): Promise<void> {
    // Concatenate all accumulated Int16 chunks
    const totalSamples = this.bufferSamples;
    const combined = new Int16Array(totalSamples);
    let offset = 0;
    for (const chunk of this.audioBuffer) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    // Clear the buffer
    this.audioBuffer = [];
    this.bufferSamples = 0;

    // Build a minimal WAV file
    const wavBuffer = this._buildWav(combined, 16_000);

    try {
      const baseUrl = this.config.baseUrl ?? 'https://api.elevenlabs.io/v1';

      // Create form data with the WAV audio
      const boundary = '----ElevenLabsSTTBoundary' + Date.now();
      const languageCode = this.sessionConfig.language ?? 'en';

      // Build multipart body manually (Node.js Buffer-based).
      //
      // The form field is `file` (NOT `audio`). ElevenLabs' batch STT
      // endpoint rejects `name="audio"` with HTTP 400:
      //   { detail: { code: 'invalid_parameters',
      //               message: 'Must provide either file or a URL parameter.',
      //               param: 'file' } }
      // Verified live against the prod ELEVENLABS_API_KEY 2026-05-20:
      //   `-F 'audio=@...'` → HTTP 400
      //   `-F 'file=@...'`  → HTTP 200 { text, words, ... }
      // The previous `name="audio"` here made every chunked STT chunk
      // silently 400 and the voice pipeline drained the endpoint-detector
      // timeout with zero transcripts — i.e. the "Voice ended before
      // transcribing — your mic may be muted or the voice service is
      // unreachable" symptom on every deploy where DEEPGRAM_API_KEY was
      // not set.
      const parts: Buffer[] = [];
      parts.push(Buffer.from(`--${boundary}\r\n`));
      parts.push(
        Buffer.from(
          `Content-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`
        )
      );
      parts.push(Buffer.from(wavBuffer));
      parts.push(Buffer.from(`\r\n--${boundary}\r\n`));
      parts.push(
        Buffer.from(
          `Content-Disposition: form-data; name="language_code"\r\n\r\n${languageCode}\r\n`
        )
      );
      // model_id is a required field of the endpoint, so the default applies
      // whenever no model is configured.
      const modelId = this.config.model || DEFAULT_STT_MODEL;
      parts.push(Buffer.from(`--${boundary}\r\n`));
      parts.push(
        Buffer.from(`Content-Disposition: form-data; name="model_id"\r\n\r\n${modelId}\r\n`)
      );
      parts.push(Buffer.from(`--${boundary}--\r\n`));

      const body = Buffer.concat(parts);

      const response = await fetch(`${baseUrl}/speech-to-text`, {
        method: 'POST',
        headers: {
          'xi-api-key': this.config.apiKey,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
      });

      if (!response.ok) {
        const errText = await response.text();
        this.emit('error', new Error(`ElevenLabs STT failed (${response.status}): ${errText}`));
        return;
      }

      const data = (await response.json()) as ELTranscriptMessage;

      if (data.text) {
        const words: TranscriptWord[] = (data.words ?? []).map((w) => ({
          word: w.text,
          start: Math.round(w.start * 1000),
          end: Math.round(w.end * 1000),
          confidence: w.confidence ?? 0.9,
        }));

        const event: TranscriptEvent = {
          text: data.text,
          confidence: words.length > 0 ? words.reduce((s, w) => s + w.confidence, 0) / words.length : 0.9,
          words,
          isFinal: true,
          durationMs: Math.round((totalSamples / 16_000) * 1000),
        };

        this.emit('transcript', event);

        // Emit speech_end after a final transcript
        if (this.speechActive) {
          this.speechActive = false;
          this.emit('speech_end');
        }
      }
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Build a minimal WAV file header + PCM data.
   */
  private _buildWav(pcm: Int16Array, sampleRate: number): ArrayBuffer {
    const dataSize = pcm.length * 2; // 16-bit = 2 bytes per sample
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    // RIFF header
    this._writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    this._writeString(view, 8, 'WAVE');

    // fmt chunk
    this._writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // chunk size
    view.setUint16(20, 1, true); // PCM format
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byte rate
    view.setUint16(32, 2, true); // block align
    view.setUint16(34, 16, true); // bits per sample

    // data chunk
    this._writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    // PCM data
    const output = new Int16Array(buffer, 44);
    output.set(pcm);

    return buffer;
  }

  /** Write an ASCII string into a DataView at the given offset. */
  private _writeString(view: DataView, offset: number, str: string): void {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }
}

// ---------------------------------------------------------------------------
// Provider (Factory)
// ---------------------------------------------------------------------------

/**
 * Streaming STT provider using ElevenLabs' Speech-to-Text API.
 *
 * Uses chunked REST transcription (2-second audio windows) to provide
 * near-realtime STT with the same ElevenLabs API key used for TTS.
 * No separate Deepgram key required.
 *
 * @example
 * ```typescript
 * const stt = new ElevenLabsStreamingSTT({
 *   apiKey: process.env.ELEVENLABS_API_KEY!,
 * });
 * const session = await stt.startSession({ language: 'en' });
 * session.on('transcript', (event) => console.log(event.text));
 * ```
 */
export class ElevenLabsStreamingSTT implements IStreamingSTT, HealthyProvider {
  readonly providerId = 'elevenlabs-streaming-stt';
  readonly isStreaming = true;
  readonly priority: number;
  readonly capabilities: ProviderCapabilities;
  private readonly keyPool: ApiKeyPool;
  private readonly healthProbe: NonNullable<
    ElevenLabsStreamingSTTConfig['healthProbe']
  >;

  constructor(private readonly config: ElevenLabsStreamingSTTConfig) {
    this.keyPool = new ApiKeyPool(config.apiKey);
    this.priority = config.priority ?? 20;
    this.capabilities = defaultCapabilities({
      languages: ['*'],
      streaming: true,
      costTier: 'standard',
      latencyClass: 'near-realtime',
      ...(config.capabilities ?? {}),
    });
    this.healthProbe = config.healthProbe ?? defaultElevenLabsProbe;
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
        { kind: 'stt', provider: this.providerId }
      );
      return {
        ok: false,
        latencyMs: res.latencyMs,
        error: { class: classified.errorClass, message: `HTTP ${res.status}` },
      };
    } catch (err) {
      const classified = VoicePipelineError.classifyError(err, {
        kind: 'stt',
        provider: this.providerId,
      });
      return {
        ok: false,
        error: { class: classified.errorClass, message: classified.message },
      };
    }
  }

  /**
   * Create a new STT session. Uses chunked REST calls to ElevenLabs'
   * batch STT endpoint for near-realtime transcription.
   * Each session gets a fresh key from the round-robin pool.
   */
  async startSession(config?: StreamingSTTConfig): Promise<StreamingSTTSession> {
    const resolvedConfig = { ...this.config, apiKey: this.keyPool.next() };
    return new ElevenLabsChunkedSTTSession(resolvedConfig, config ?? {});
  }
}
