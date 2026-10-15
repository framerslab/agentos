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
 * - **Authentication:** `Authorization: Token <apiKey>` on the upgrade
 * - **Inbound (client → Deepgram):** 16 kHz mono PCM16 frames, converted from each frame's own rate
 * - **Outbound (Deepgram → client):** JSON messages with transcript results
 * - **Close:** Send `CloseStream`, then close the socket after draining
 *
 * ## Event Mapping
 *
 * Deepgram's `Results` messages are mapped to the pipeline's event model:
 * - `is_final: true` → emits `'transcript'` with `isFinal: true`
 * - `is_final: false` → emits `'transcript'` with `isFinal: false` (interim)
 * - every interim and the final of one segment share an `itemId`, and carry
 *   `startMs` and `endMs` on the socket's audio clock
 * - `speech_final: true` or `UtteranceEnd` → emits `'speech_end'` VAD event
 * - `SpeechStarted` or a segment's first words → emits `'speech_start'`
 * - the audio sent on the socket → `'usage'` (an `SttMeasuredUsageEvent`)
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
} from '../types.js';
import {
  defaultCapabilities,
  type HealthyProvider,
  type HealthCheckResult,
  type ProviderCapabilities,
} from '../HealthyProvider.js';
import { VoicePipelineError } from '../VoicePipelineError.js';
import { StreamResampler } from './StreamResampler.js';
import { sttLanguageOptions } from '../LowestCostStt.js';
import { SttConnectionMeter } from './SttConnectionMeter.js';
import { SttConnectionAuthorizationError } from '../SttConnectionAuthorizationError.js';
import { RollingSTTSession } from './RollingSTTSession.js';

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
  /** Deepgram API key, sent only in the upgrade Authorization header. */
  apiKey: string;

  /**
   * Base WebSocket URL for Deepgram's streaming API.
   * @default 'wss://api.deepgram.com/v1/listen'
   */
  baseUrl?: string;

  /**
   * Deepgram model to use. `nova-3` is Deepgram's general-purpose model.
   * @default 'nova-3'
   */
  model?: string;

  /**
   * Opt every session out of Deepgram's Model Improvement Program by sending
   * `mip_opt_out=true`: Deepgram keeps an opted-out request's data only for
   * the duration necessary to process the request. Off by default: Deepgram's
   * API reference asks callers to refer to its docs for pricing impacts before
   * setting it. A single session can opt out with
   * `providerOptions.mip_opt_out: true`; a session's `false` does not undo
   * this option.
   * @default false
   */
  mipOptOut?: boolean;

  /**
   * Expected input frame rate. When supplied, a mismatch throws before any
   * audio is sent. Frames are converted to the declared 16000 Hz wire rate.
   * When absent, each frame's sampleRate supplies the input rate.
   */
  inputSampleRate?: number;

  /** Cumulative usage interval in milliseconds; zero reports only on close. Default zero. */
  usageIntervalMs?: number;

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

/** Deepgram's general-purpose speech-to-text model. */
const DEFAULT_MODEL = 'nova-3';

/** Nova-3 models take `keyterm` in place of the `keywords` parameter. */
function isNova3Model(model: string): boolean {
  return model === 'nova-3' || model.startsWith('nova-3-');
}

/** Drops a trailing `:intensifier` from a `keywords` entry, since `keyterm` takes plain terms. */
function stripKeywordIntensifier(keyword: string): string {
  return keyword.replace(/:-?\d+(?:\.\d+)?$/, '');
}

// ---------------------------------------------------------------------------
// Session Implementation
// ---------------------------------------------------------------------------

/** How long to wait for the Deepgram WS upgrade before failing the connect. */
const CONNECT_TIMEOUT_MS = 8_000;

/** Deepgram's declared wire rate: every frame is converted to it before it is sent. */
const WIRE_SAMPLE_RATE = 16_000;

/**
 * A live streaming STT session connected to Deepgram over one WebSocket.
 * Emits `transcript`, `speech_start`, `speech_end`, `usage`, `error`, and
 * `close` events as required by the voice pipeline orchestrator.
 */
class DeepgramStreamingSTTSession extends EventEmitter implements StreamingSTTSession {
  private ws: WebSocket | null = null;
  private speechActive = false;
  private closed = false;
  private readonly resampler = new StreamResampler(WIRE_SAMPLE_RATE);
  private readonly meter: SttConnectionMeter;
  private samplesSent = 0;
  private utteranceSequence = 0;
  private itemId: string | undefined;
  private usageTimer: ReturnType<typeof setInterval> | undefined;

  /** Wire seconds sent on this socket so far. */
  get audioSeconds(): number {
    return this.samplesSent / WIRE_SAMPLE_RATE;
  }

  /** The host's funded ceiling for this socket, in wire seconds; unbounded without the hook. */
  get audioCeiling(): number {
    return this.sessionConfig.connectionHooks?.audioCeiling?.(this.meter.opening) ?? Infinity;
  }

  /** The socket is open and takes audio. */
  get isOpen(): boolean {
    return !this.closed && this.ws?.readyState === WebSocket.OPEN;
  }

  constructor(
    private readonly config: DeepgramStreamingSTTConfig,
    private readonly sessionConfig: StreamingSTTConfig
  ) {
    super();
    if (config.inputSampleRate !== undefined && (!Number.isSafeInteger(config.inputSampleRate) || config.inputSampleRate <= 0)) {
      throw new RangeError('invalid input sample rate');
    }
    if (!Number.isSafeInteger(config.usageIntervalMs ?? 0) || (config.usageIntervalMs ?? 0) < 0) {
      throw new RangeError('invalid usage interval');
    }
    const model = config.model ?? DEFAULT_MODEL;
    this.meter = new SttConnectionMeter('deepgram-streaming', `deepgram:${model}`, model, sessionConfig.connectionHooks);
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

  private reportUsage(final: boolean): void {
    const event = this.meter.report(1, this.samplesSent / WIRE_SAMPLE_RATE, final);
    if (event) this.emit('usage', event);
  }

  /** Ends the session once: its timer and speech, its final usage report, then `'close'`. */
  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.usageTimer !== undefined) clearInterval(this.usageTimer);
    this.usageTimer = undefined;
    this.meter.cancelAuthorization();
    this.endSpeech();
    this.reportUsage(true);
    this.emit('close');
  }

  /**
   * Authorizes the socket with the host's hooks, then opens it. Resolves once the
   * connection is established and ready to receive audio.
   *
   * The failure paths settle the connect exactly once and reject first: an
   * `'error'` emitted before the rejection would throw with no listener attached
   * yet and leave the promise unsettled. A refused upgrade carries the HTTP body
   * (`unexpected-response`), so Deepgram's own error is visible. A failed opening
   * terminates its socket and reports a final zero.
   *
   * @throws {SttConnectionAuthorizationError} When the host refuses the socket; no socket is constructed.
   * @throws {RangeError} For a language that is not a language tag.
   */
  async connect(): Promise<void> {
    const model = this.config.model ?? DEFAULT_MODEL;
    const languageOptions = sttLanguageOptions(`deepgram:${model}`, this.sessionConfig.language);
    if (!languageOptions) throw new Error('automatic language has no verified Deepgram tariff');
    await this.meter.authorize();
    if (this.closed) throw new Error('deepgram opening closed');
    const opts = this.sessionConfig.providerOptions ?? {};
    const url = new URL(this.config.baseUrl ?? 'wss://api.deepgram.com/v1/listen');
    const params = url.searchParams;
    for (const [name, value] of Object.entries({
      model,
      language: languageOptions.language!,
      punctuate: String(this.sessionConfig.punctuate !== false),
      interim_results: String(this.sessionConfig.interimResults !== false),
      endpointing: 'true',
      vad_events: 'true',
      encoding: 'linear16',
      sample_rate: String(WIRE_SAMPLE_RATE),
      channels: '1',
    })) params.set(name, value);

    // Deepgram feature flags from providerOptions
    if (opts.sentiment) params.set('sentiment', 'true');
    if (opts.smart_format) params.set('smart_format', 'true');
    if (opts.diarize) params.set('diarize', 'true');
    if (opts.utterance_end_ms) params.set('utterance_end_ms', String(opts.utterance_end_ms));
    if (this.config.mipOptOut === true || opts.mip_opt_out === true) params.set('mip_opt_out', 'true');
    if (Array.isArray(opts.keywords)) {
      // Nova-3 does not support `keywords`; it boosts terms through `keyterm`,
      // which takes plain terms, so the `:intensifier` suffix is dropped there.
      for (const keyword of opts.keywords) {
        if (isNova3Model(model)) params.append('keyterm', stripKeywordIntensifier(String(keyword)));
        else params.append('keywords', String(keyword));
      }
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(
        () => fail(new Error(`deepgram stt ws connect timed out after ${CONNECT_TIMEOUT_MS}ms`)),
        CONNECT_TIMEOUT_MS
      );
      const fail = (error: Error): void => {
        if (settled) {
          if (!this.closed) this._emitErrorSafe(error);
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
        const socket = this.ws;
        this.ws = null;
        this.finish();
        socket?.terminate();
      };
      let socket: WebSocket;
      try {
        socket = new WebSocket(url.toString(), { headers: { Authorization: `Token ${this.config.apiKey}` } });
        this.ws = socket;
      } catch (error) {
        fail(error instanceof Error ? error : new Error('deepgram socket construction failed'));
        return;
      }
      socket.on('unexpected-response', (_request, response) => {
        let body = '';
        response.on('data', (chunk: Buffer) => {
          body = (body + chunk.toString('utf-8')).slice(0, 300);
        });
        response.on('end', () => {
          fail(new Error(`deepgram stt ws rejected: HTTP ${response.statusCode}${body ? ` - ${body}` : ''}`));
        });
      });
      socket.on('open', () => {
        if (settled || this.closed) return;
        settled = true;
        clearTimeout(timer);
        if ((this.config.usageIntervalMs ?? 0) > 0) {
          this.usageTimer = setInterval(() => this.reportUsage(false), this.config.usageIntervalMs);
        }
        resolve();
      });
      socket.on('error', (error) => fail(error as Error));
      socket.on('message', (data: Buffer | string) => {
        this._handleMessage(typeof data === 'string' ? data : data.toString('utf-8'));
      });
      socket.on('close', () => {
        if (!settled) fail(new Error('deepgram stt ws closed before the upgrade completed'));
        this.ws = null;
        this.finish();
      });
    });
    // An open followed by a close in the same turn leaves nothing to adopt.
    if (!this.isOpen) throw new Error('deepgram closed before adoption');
  }

  /**
   * Converts a live or replayed frame to 16 kHz PCM16 and sends it, counting
   * the samples sent.
   *
   * @throws {RangeError} For a frame whose rate differs from `inputSampleRate`, or that is not a positive whole
   *   number, or a sample that is not finite; nothing of the frame is sent or counted.
   */
  pushAudio(frame: AudioFrame): void {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.config.inputSampleRate !== undefined && frame.sampleRate !== this.config.inputSampleRate) {
      throw new RangeError('unexpected input sample rate');
    }
    const samples = this.resampler.process(frame.samples, frame.sampleRate);
    if (samples.length === 0) return;
    const pcm = Buffer.allocUnsafe(samples.length * 2);
    for (let i = 0; i < samples.length; i++) {
      const sample = Math.max(-1, Math.min(1, samples[i]!));
      pcm.writeInt16LE(Math.trunc(sample < 0 ? sample * 0x8000 : sample * 0x7fff), i * 2);
    }
    const next = (this.samplesSent + samples.length) / WIRE_SAMPLE_RATE;
    if (this.sessionConfig.connectionHooks?.beforeAudio?.(this.meter.opening, next) === false) {
      // The host's funded limit: nothing of this frame is sent, and the refusal ends the socket.
      this._emitErrorSafe(new SttConnectionAuthorizationError());
      this.close();
      return;
    }
    this.ws.send(pcm);
    this.samplesSent += samples.length;
  }

  /** Requests final results; the existing 200 ms drain bound is preserved. */
  async flush(): Promise<void> {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'CloseStream' }));
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }

  /** Stops the socket and reports its final measured total exactly once. */
  close(): void {
    if (this.closed) return;
    const socket = this.ws;
    this.ws = null;
    this.finish();
    if (socket?.readyState === WebSocket.OPEN) socket.close(1000, 'session closed');
    else socket?.terminate();
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private beginSpeech(): void {
    if (this.speechActive) return;
    this.speechActive = true;
    this.emit('speech_start');
  }

  private endSpeech(): void {
    // An empty terminal message ends VAD but never promotes speculative interim text.
    this.itemId = undefined;
    if (!this.speechActive) return;
    this.speechActive = false;
    this.emit('speech_end');
  }

  /**
   * Parse and dispatch a Deepgram WebSocket message. Every final segment ends
   * its transcript identity, so later interim and final segments get a new
   * `itemId`, within one VAD span too. An empty terminal discards unfinalized
   * interim text, emits one speech end and never fabricates a final.
   */
  private _handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return; // Malformed JSON — skip
    }
    if (this.closed) return;
    const metadata = msg.metadata as { request_id?: unknown } | undefined;
    const requestId = metadata?.request_id ?? (msg.type === 'Metadata' ? msg.request_id : undefined);
    if (typeof requestId === 'string') {
      try {
        this.meter.bindSupplierRequest(requestId);
      } catch {
        // The socket's first valid request id stays bound; usage keeps that identity.
      }
    }
    if (msg.type === 'SpeechStarted') {
      this.beginSpeech();
      return;
    }
    if (msg.type === 'UtteranceEnd') {
      this.endSpeech();
      return;
    }
    if (msg.type !== 'Results') return;
    const result = msg as unknown as DGResult;
    const alt = result.channel?.alternatives?.[0];
    if (alt?.transcript?.trim()) {
      const startMs = Math.round(result.start * 1000);
      const endMs = Math.round((result.start + result.duration) * 1000);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs < startMs) return;
      this.beginSpeech();
      this.itemId ??= `${this.meter.opening.connectionId}:${++this.utteranceSequence}`;
      const event: TranscriptEvent = {
        itemId: this.itemId,
        text: alt.transcript,
        confidence: alt.confidence,
        isFinal: result.is_final,
        startMs,
        endMs,
        durationMs: endMs - startMs,
        words: (alt.words ?? []).map((word) => ({
          word: word.word,
          start: Math.round(word.start * 1000), // seconds → ms
          end: Math.round(word.end * 1000),
          confidence: word.confidence,
          ...(word.speaker === undefined ? {} : { speaker: String(word.speaker) }),
        })),
      };
      // Attach sentiment when Deepgram returns it
      if (result.sentiments?.average) {
        event.sentiment = {
          label: result.sentiments.average.sentiment,
          confidence: Math.abs(result.sentiments.average.sentiment_score),
        };
      }
      this.emit('transcript', event);
      if (event.isFinal) this.itemId = undefined;
    }
    // speech_final indicates the speaker paused — emit speech_end
    if (result.speech_final) this.endSpeech();
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
 *   model: 'nova-3',
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
   * Each socket gets a fresh key from the round-robin pool. With
   * `config.connectionHooks.audioCeiling`, the session moves to a new,
   * separately authorized socket of the same vendor before a socket's funded
   * ceiling; without it the session is the single socket's own.
   *
   * @throws {SttConnectionAuthorizationError} When the host's hooks refuse the first socket.
   * @throws {RangeError} For an invalid `inputSampleRate` or `usageIntervalMs`, or a language that is not a tag.
   */
  async startSession(config?: StreamingSTTConfig): Promise<StreamingSTTSession> {
    const open = async (): Promise<DeepgramStreamingSTTSession> => {
      const session = new DeepgramStreamingSTTSession({ ...this.config, apiKey: this.keyPool.next() }, config ?? {});
      await session.connect();
      if (!session.isOpen) {
        session.close();
        throw new Error('deepgram closed before adoption');
      }
      return session;
    };
    return config?.connectionHooks?.audioCeiling ? RollingSTTSession.start(open) : open();
  }
}
