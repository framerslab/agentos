/**
 * @module voice-pipeline/providers/DeepgramStreamingSTT
 *
 * Streaming speech-to-text adapter that connects to Deepgram's WebSocket API
 * and implements the {@link IStreamingSTT} / {@link StreamingSTTSession} interfaces
 * required by {@link VoicePipelineOrchestrator}.
 *
 * ## Deepgram WebSocket Protocol
 *
 * - **Endpoint:** `wss://api.deepgram.com/v1/listen`
 * - **Authentication:** `token=<apiKey>` query parameter
 * - **Inbound (client → Deepgram):** Binary PCM frames or encoded audio
 * - **Outbound (Deepgram → client):** JSON messages with transcript results
 * - **Close:** Send zero-byte message to signal end-of-stream
 *
 * ## Event Mapping
 *
 * Deepgram's `Results` messages are mapped to the pipeline's event model:
 * - `is_final: true` → emits `'transcript'` with `isFinal: true`
 * - `is_final: false` → emits `'transcript'` with `isFinal: false` (interim)
 * - `speech_final: true` → emits `'speech_end'` VAD event
 * - Utterance start → emits `'speech_start'`
 *
 * @see https://developers.deepgram.com/docs/streaming
 */

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { ApiKeyPool } from '../../../core/providers/ApiKeyPool.js';
import type {
  IStreamingSTT,
  StreamingSTTSession,
  StreamingSTTConfig,
  AudioFrame,
  TranscriptEvent,
  TranscriptWord,
} from '../types.js';
import {
  defaultCapabilities,
  type HealthyProvider,
  type HealthCheckResult,
  type ProviderCapabilities,
} from '../HealthyProvider.js';
import { VoicePipelineError } from '../VoicePipelineError.js';

/**
 * Shape of the injected health probe used for deterministic tests.
 * Default implementation hits Deepgram's /v1/projects endpoint.
 */
export type VoiceHealthProbe = (
  apiKey: string
) => Promise<{ ok: boolean; status: number; latencyMs: number }>;

async function defaultDeepgramProbe(apiKey: string) {
  const start = Date.now();
  const res = await fetch('https://api.deepgram.com/v1/projects', {
    headers: { Authorization: `Token ${apiKey}` },
    signal: AbortSignal.timeout(1000),
  });
  return { ok: res.ok, status: res.status, latencyMs: Date.now() - start };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the {@link DeepgramStreamingSTT} provider.
 */
export interface DeepgramStreamingSTTConfig {
  /** Deepgram API key. Sent as a query parameter on the WebSocket URL. */
  apiKey: string;

  /**
   * Base WebSocket URL for Deepgram's streaming API.
   * @default 'wss://api.deepgram.com/v1/listen'
   */
  baseUrl?: string;

  /**
   * Deepgram model to use.
   * @default 'nova-2'
   */
  model?: string;

  /**
   * Chain priority. Lower values are tried first.
   * @default 10
   */
  priority?: number;

  /** Optional capability overrides. Merged into defaultCapabilities(). */
  capabilities?: Partial<ProviderCapabilities>;

  /** Injectable health probe for tests. Defaults to Deepgram /v1/projects. */
  healthProbe?: VoiceHealthProbe;
}

// ---------------------------------------------------------------------------
// Deepgram response types (subset)
// ---------------------------------------------------------------------------

/** Word-level data from Deepgram streaming response. */
interface DGWord {
  word: string;
  start: number;
  end: number;
  confidence: number;
  speaker?: number;
}

/** Channel alternative from Deepgram streaming response. */
interface DGAlternative {
  transcript: string;
  confidence: number;
  words: DGWord[];
}

/** Deepgram sentiment result for a segment. */
interface DGSentiment {
  sentiment: 'positive' | 'negative' | 'neutral';
  sentiment_score: number;
}

/** Deepgram streaming result message. */
interface DGResult {
  type: 'Results';
  channel_index: number[];
  duration: number;
  start: number;
  is_final: boolean;
  speech_final: boolean;
  channel: {
    alternatives: DGAlternative[];
  };
  /** Per-segment sentiment (when sentiment=true). */
  sentiments?: {
    segments: Array<{
      text: string;
      start_word: number;
      end_word: number;
      sentiment: 'positive' | 'negative' | 'neutral';
      sentiment_score: number;
    }>;
    average: DGSentiment;
  };
}

// ---------------------------------------------------------------------------
// Session Implementation
// ---------------------------------------------------------------------------

/**
 * A live streaming STT session connected to Deepgram via WebSocket.
 * Emits `transcript`, `speech_start`, `speech_end`, `error`, and `close` events
 * as required by the voice pipeline orchestrator.
 */
/** How long to wait for the Deepgram WS upgrade before failing the connect. */
const CONNECT_TIMEOUT_MS = 8_000;

class DeepgramStreamingSTTSession extends EventEmitter implements StreamingSTTSession {
  private ws: WebSocket | null = null;
  private speechActive = false;
  private closed = false;

  constructor(
    private readonly config: DeepgramStreamingSTTConfig,
    private readonly sessionConfig: StreamingSTTConfig
  ) {
    super();
  }

  /**
   * Emit `'error'` only when a listener exists — an unlistened EventEmitter
   * `'error'` throws and takes the whole process down as an uncaughtException.
   */
  private _emitErrorSafe(err: Error): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', err);
    } else {
      console.warn('[deepgram-streaming] session error (no listener attached):', err.message);
    }
  }

  /**
   * Open the WebSocket connection to Deepgram.
   * Resolves once the connection is established and ready to receive audio.
   */
  async connect(): Promise<void> {
    const baseUrl = this.config.baseUrl ?? 'wss://api.deepgram.com/v1/listen';
    const model = this.config.model ?? 'nova-2';
    const language = this.sessionConfig.language ?? 'en-US';
    const interim = this.sessionConfig.interimResults !== false;
    const punctuate = this.sessionConfig.punctuate !== false;

    // Provider options from pipeline config (sentiment, keywords, smart_format, etc.)
    const opts = this.sessionConfig.providerOptions ?? {};

    const params = new URLSearchParams({
      model,
      language,
      punctuate: String(punctuate),
      interim_results: String(interim),
      endpointing: 'true',
      vad_events: 'true',
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
    });

    // Deepgram feature flags from providerOptions
    if (opts.sentiment) params.set('sentiment', 'true');
    if (opts.smart_format) params.set('smart_format', 'true');
    if (opts.diarize) params.set('diarize', 'true');
    if (opts.utterance_end_ms) params.set('utterance_end_ms', String(opts.utterance_end_ms));
    if (Array.isArray(opts.keywords)) {
      for (const kw of opts.keywords) {
        params.append('keywords', String(kw));
      }
    }

    const url = `${baseUrl}?${params.toString()}`;

    // Failure paths settle the promise EXACTLY once and reject FIRST: the
    // previous implementation ran `this.emit('error', err)` before
    // `reject(err)` — with no 'error' listener attached at connect time the
    // emit threw synchronously (Node EventEmitter contract), `reject` never
    // executed, and the connect promise never settled, hanging the caller
    // forever. Handshake rejections also capture the HTTP body now
    // (`unexpected-response`) so the real Deepgram error is visible instead
    // of the blind "Unexpected server response: NNN".
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        fail(new Error(`deepgram stt ws connect timed out after ${CONNECT_TIMEOUT_MS}ms`));
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
        headers: {
          Authorization: `Token ${this.config.apiKey}`,
        },
      });

      this.ws.on('unexpected-response', (_req, res) => {
        let body = '';
        res.on('data', (d: Buffer) => {
          body += d.toString('utf-8');
        });
        res.on('end', () => {
          fail(
            new Error(
              `deepgram stt ws rejected: HTTP ${res.statusCode}${body ? ` — ${body.slice(0, 300)}` : ''}`
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
      this.ws.on('error', (err) => fail(err as Error));

      this.ws.on('message', (data: Buffer | string) => {
        this._handleMessage(typeof data === 'string' ? data : data.toString('utf-8'));
      });

      this.ws.on('close', () => {
        if (!settled) fail(new Error('deepgram stt ws closed before the upgrade completed'));
        this.closed = true;
        this.emit('close');
      });
    });
  }

  /**
   * Push a PCM audio frame to Deepgram for transcription.
   * Converts Float32Array samples to 16-bit linear PCM (what Deepgram expects).
   */
  pushAudio(frame: AudioFrame): void {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // Convert Float32Array [-1.0, 1.0] to Int16 PCM
    const pcm = new Int16Array(frame.samples.length);
    for (let i = 0; i < frame.samples.length; i++) {
      const s = Math.max(-1, Math.min(1, frame.samples[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    this.ws.send(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  }

  /**
   * Signal end-of-audio to Deepgram by sending a zero-byte message.
   * Waits for any final results before resolving.
   */
  async flush(): Promise<void> {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // Deepgram uses a close_stream message to finalize
    this.ws.send(JSON.stringify({ type: 'CloseStream' }));

    // Give Deepgram a moment to send final results
    return new Promise<void>((resolve) => {
      setTimeout(resolve, 200);
    });
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
   * Parse and dispatch a Deepgram WebSocket message.
   * Maps Deepgram's result format to the pipeline's TranscriptEvent model.
   */
  private _handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // Malformed JSON — skip
    }

    const type = msg.type as string;

    // Handle speech started event (Deepgram VAD)
    if (type === 'SpeechStarted') {
      if (!this.speechActive) {
        this.speechActive = true;
        this.emit('speech_start');
      }
      return;
    }

    // Handle results
    if (type === 'Results') {
      const result = msg as unknown as DGResult;
      const alt = result.channel?.alternatives?.[0];
      if (!alt || !alt.transcript) return;

      // Map Deepgram words to pipeline TranscriptWord format
      const words: TranscriptWord[] = (alt.words ?? []).map((w) => ({
        word: w.word,
        start: Math.round(w.start * 1000), // seconds → ms
        end: Math.round(w.end * 1000),
        confidence: w.confidence,
        speaker: w.speaker !== undefined ? String(w.speaker) : undefined,
      }));

      const event: TranscriptEvent = {
        text: alt.transcript,
        confidence: alt.confidence,
        words,
        isFinal: result.is_final,
        durationMs: Math.round(result.duration * 1000),
      };

      // Attach sentiment when Deepgram returns it
      if (result.sentiments?.average) {
        event.sentiment = {
          label: result.sentiments.average.sentiment,
          confidence: Math.abs(result.sentiments.average.sentiment_score),
        };
      }

      this.emit('transcript', event);

      // speech_final indicates the speaker paused — emit speech_end
      if (result.speech_final && this.speechActive) {
        this.speechActive = false;
        this.emit('speech_end');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Provider (Factory)
// ---------------------------------------------------------------------------

/**
 * Streaming STT provider that creates Deepgram WebSocket sessions.
 * Implements {@link IStreamingSTT} for use with {@link VoicePipelineOrchestrator}.
 *
 * @example
 * ```typescript
 * const stt = new DeepgramStreamingSTT({
 *   apiKey: process.env.DEEPGRAM_API_KEY!,
 *   model: 'nova-2',
 * });
 * const session = await stt.startSession({ language: 'en-US' });
 * session.on('transcript', (event) => console.log(event.text));
 * ```
 */
export class DeepgramStreamingSTT implements IStreamingSTT, HealthyProvider {
  readonly providerId = 'deepgram-streaming';
  readonly isStreaming = true;
  readonly priority: number;
  readonly capabilities: ProviderCapabilities;
  private readonly keyPool: ApiKeyPool;
  private readonly healthProbe: VoiceHealthProbe;

  constructor(private readonly config: DeepgramStreamingSTTConfig) {
    this.keyPool = new ApiKeyPool(config.apiKey);
    this.priority = config.priority ?? 10;
    this.capabilities = defaultCapabilities({
      languages: ['*'],
      streaming: true,
      costTier: 'standard',
      latencyClass: 'realtime',
      ...(config.capabilities ?? {}),
    });
    this.healthProbe = config.healthProbe ?? defaultDeepgramProbe;
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
   * Create a new streaming STT session connected to Deepgram.
   * Each session gets a fresh key from the round-robin pool.
   */
  async startSession(config?: StreamingSTTConfig): Promise<StreamingSTTSession> {
    const resolvedConfig = { ...this.config, apiKey: this.keyPool.next() };
    const session = new DeepgramStreamingSTTSession(resolvedConfig, config ?? {});
    await session.connect();
    return session;
  }
}
