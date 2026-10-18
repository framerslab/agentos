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
 * - **Authentication:** `xi-api-key` header
 * - **Inbound (client → ElevenLabs):** JSON text chunks `{ text: "...", ... }`
 * - **Outbound (ElevenLabs → client):** JSON with base64-encoded audio `{ audio: "...", ... }`
 * - **End of stream:** `{ text: "" }`, the `CloseConnection` message, ends the
 *   stream: ElevenLabs returns the remaining audio and answers
 *   `{ isFinal: true }`.
 *
 * ## Audio Output
 *
 * ElevenLabs returns audio as base64-encoded MP3 chunks. Each chunk is decoded
 * and wrapped in an {@link EncodedAudioChunk} with format `'mp3'` before being
 * emitted as an `'audio'` event.
 *
 * ## Sentence segments
 *
 * The session synthesizes one sentence segment at a time
 * ({@link SegmentSynthesisQueue}). Each segment goes out on a socket of its
 * own: the first message of a socket is the initial `{ text: " " }` with the
 * voice and generation settings, then the segment's text, then the
 * end-of-stream message; `isFinal` completes the segment. The end-of-stream
 * message spends the socket, so the next segment opens a new one and closes
 * the spent one when the server has not. The segment's boundary
 * ({@link TtsTextBoundary}) rides on the last frame `isFinal` proves
 * complete; every earlier frame carries none. A segment with no `isFinal`
 * within five seconds, or whose socket closes first, ends without a boundary.
 * A socket's close while the session is open closes nothing else (the server
 * closes an idle socket after `inactivity_timeout`, 20 seconds by default):
 * only `close()` ends the session. Messages of a socket that is no longer the
 * session's current one are dropped.
 *
 * @see https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input
 */

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type {
  IStreamingTTS,
  StreamingTTSSession,
  StreamingTTSConfig,
  EncodedAudioChunk,
} from '../types.js';
import { SegmentSynthesisQueue } from './SegmentSynthesisQueue.js';
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
  /** The current socket; `null` between segments once the server, a cancel or a close has closed it. */
  private ws: WebSocket | null = null;
  /** Whether the current socket has been sent the end-of-stream message: a spent socket takes no further text. */
  private spent = false;
  private closed = false;
  private readonly segments: SegmentSynthesisQueue;

  /** Estimated bytes per second for duration calculation. MP3 at 128kbps = ~16000 bytes/sec. */
  private static readonly BYTES_PER_SEC_MP3 = 16_000;

  constructor(
    private readonly config: ElevenLabsStreamingTTSConfig,
    private readonly sessionConfig: StreamingTTSConfig
  ) {
    super();
    this.segments = new SegmentSynthesisQueue({
      start: (segment, signal) => this.synthesize(segment.text, signal),
      emit: (chunk) => this.emit('audio', chunk),
      flushed: () => this.emit('flush_complete'),
    });
  }

  /**
   * Open the first WebSocket connection to the ElevenLabs streaming endpoint
   * and send its initial message with the generation settings.
   */
  async connect(): Promise<void> {
    await this.open();
  }

  /**
   * Opens a socket and sends its initial `{ text: " " }` message with the voice
   * and generation settings; resolves once that message is sent. Rejects when
   * the socket errors or closes before it opens. The socket becomes the
   * session's current one as it is created.
   */
  private open(): Promise<WebSocket> {
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

    return new Promise<WebSocket>((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(url, {
        headers: {
          'xi-api-key': this.config.apiKey,
        },
      });
      this.ws = ws;
      this.spent = false;

      ws.on('open', () => {
        if (settled) return;
        settled = true;
        // A cancel or a close while the socket opened made it no one's: it closes unused.
        if (this.ws !== ws) {
          ws.close(1000, 'superseded');
          reject(new Error('elevenlabs socket superseded'));
          return;
        }
        // The initial message carries the generation settings. First-class
        // expressiveness wins over legacy providerOptions per knob: the same
        // camelCase names, a plain spread merge.
        const opts: Record<string, unknown> = {
          ...(this.sessionConfig?.providerOptions ?? {}),
          ...(this.sessionConfig?.expressiveness ?? {}),
        };
        ws.send(
          JSON.stringify({
            text: ' ', // The initial text must be a blank space.
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
        resolve(ws);
      });

      // Before the socket opens the error rejects the open; after it, the error reaches the session's listener.
      ws.on('error', (err: Error) => {
        if (!settled) {
          settled = true;
          reject(err);
          return;
        }
        if (this.ws === ws) this._emitErrorSafe(err);
      });

      ws.on('message', (data: Buffer | string) => {
        if (this.ws !== ws) return;
        this._handleMessage(typeof data === 'string' ? data : data.toString('utf-8'));
      });

      // A socket closes at the server's hand too (an idle one after inactivity_timeout, 20 seconds by default, or on
      // an error). Only close() closes the session: a segment still in flight on this socket ends without a boundary.
      ws.on('close', () => {
        if (!settled) {
          settled = true;
          reject(new Error('elevenlabs ws closed before it opened'));
        }
        if (this.ws !== ws) return;
        this.ws = null;
        if (!this.closed) this.segments.abandon();
      });
    });
  }

  /** Emits `'error'` only to a listener: an unlistened EventEmitter `'error'` throws. */
  private _emitErrorSafe(err: Error): void {
    if (this.listenerCount('error') > 0) this.emit('error', err);
  }

  /**
   * The socket for the next segment: the current one while it is open and has
   * not been sent the end-of-stream message, else a new one. A spent socket the
   * server has not closed yet is closed here.
   */
  private async socket(): Promise<WebSocket> {
    if (this.ws && !this.spent && this.ws.readyState === WebSocket.OPEN) return this.ws;
    const old = this.ws;
    this.ws = null;
    if (old && old.readyState === WebSocket.OPEN) old.close(1000, 'segment complete');
    const ws = await this.open();
    if (this.closed) {
      ws.close(1000, 'session closed');
      throw new Error('elevenlabs session closed');
    }
    return ws;
  }

  /**
   * Sends one segment: its text, then the end-of-stream message, on a socket of
   * its own. On the current socket, open and not yet sent an end-of-stream
   * message, both go out within the call, so the text a caller pushes reaches
   * the provider in the same turn; otherwise a new socket is opened first. A
   * cancel or a close while that socket opens sends nothing; a socket that
   * fails to open reaches the session's `'error'` listener and ends the segment
   * without a boundary.
   */
  private async synthesize(text: string, signal: AbortSignal): Promise<void> {
    let ws = this.ws;
    if (!ws || this.spent || ws.readyState !== WebSocket.OPEN) {
      try {
        ws = await this.socket();
      } catch (err) {
        // A cancel or a close while the socket opened is no failure.
        if (signal.aborted || this.closed) return;
        this._emitErrorSafe(err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
      if (signal.aborted || this.ws !== ws) return;
    }
    ws.send(JSON.stringify({ text }));
    ws.send(JSON.stringify({ text: '' }));
    this.spent = true;
  }

  /** Feeds the text to the segmenter; each sentence it completes is queued and synthesized in turn. */
  pushTokens(tokens: string): void {
    if (this.closed) return;
    this.segments.push(tokens);
  }

  /**
   * Queues the final, unterminated segment and resolves once every queued
   * segment has completed or timed out; `flush_complete` goes out once, then.
   * A cancel or a close ends the wait without `flush_complete`.
   */
  async flush(): Promise<void> {
    if (this.closed) return;
    await this.segments.flush();
  }

  /**
   * Drops the queued segments, the held frame and the segment in flight, and
   * closes the current socket. The session stays open: the next segment opens
   * a new socket.
   */
  cancel(): void {
    this.segments.cancel();
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000, 'cancelled');
  }

  /**
   * Close the WebSocket connection and clean up.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.segments.cancel();

    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000, 'session closed');

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
      return; // Malformed JSON: skipped.
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
        // Legacy: the text of the segment in flight, never read as the text this frame plays.
        text: this.segments.inFlightText,
      };

      this.segments.frame(chunk);
    }

    // The generation is complete: the held frame goes out with the segment's boundary.
    if (msg.isFinal) this.segments.completed();
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
