/**
 * @module voice-pipeline/providers/ElevenLabsStreamingTTS
 *
 * Streaming text-to-speech adapter that connects to ElevenLabs' multi-context
 * WebSocket API and implements the {@link IStreamingTTS} / {@link StreamingTTSSession}
 * interfaces required by {@link VoicePipelineOrchestrator}.
 *
 * ## ElevenLabs WebSocket Protocol
 *
 * - **Endpoint:** `wss://api.elevenlabs.io/v1/text-to-speech/{voiceId}/multi-stream-input`
 * - **Authentication:** `xi-api-key` header
 * - **Inbound (client to ElevenLabs):** JSON messages addressed to a context by
 *   `context_id`: the context's initial `{ text: " " }` with the voice and
 *   generation settings, its text with `flush: true`, and
 *   `{ close_context: true }`.
 * - **Outbound (ElevenLabs to client):** JSON with base64-encoded audio
 *   `{ audio: "...", contextId }`, and `{ isFinal: true, contextId }`, the final
 *   message for the context (the guide spells it `is_final`; both are read).
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
 * ({@link SegmentSynthesisQueue}), every segment as a context of its own on the
 * session's one socket: the context's initial message with the voice and
 * generation settings, the segment's text with the `flush` flag, which makes
 * ElevenLabs generate the text's audio now rather than wait for its buffer to
 * fill, and the context's close; the context's `isFinal` completes the segment.
 * A reply's sentences open no socket of their own: the socket `startSession()`
 * opened carries every segment while the server keeps it, and a new one is
 * opened only once the server has closed it (an idle socket after
 * `inactivity_timeout`, 20 seconds by default). The segment's boundary
 * ({@link TtsTextBoundary}) rides on the last frame its `isFinal` proves
 * complete; every earlier frame carries none. A segment with no `isFinal`
 * within five seconds of its close message ends without a boundary. After such
 * a timeout the next segment waits, at most five seconds more, for that late
 * `isFinal`, and the audio the context still delivers goes out as it comes,
 * without a boundary, so a slow sentence arrives whole and in order; only then
 * does the next segment start. A `cancel()` ends that wait and closes the
 * socket, so nothing of the cut text is heard; the next segment opens a new one.
 *
 * ## Failures
 *
 * A socket that does not open within eight seconds, or that errors or closes
 * before it opens, is given up. The first, opened by `startSession()`, rejects
 * it. For a segment, that failure, and a socket the server closes before the
 * segment's `isFinal`, is reported as a `'warning'` naming the cause and the
 * close code, never as `'error'`, on which the orchestrator ends the session:
 * the segment ends without a boundary, its held frame going out, and is spoken
 * again, whole, once, on a fresh socket. A second failure of the same segment
 * ends the reply with a warning: the segments still queued are dropped, the
 * rest of the reply's text is not spoken, and its `flush()` completes with
 * `flush_complete`, so the session goes on to the next turn. With no
 * `'warning'` listener a warning is one console line. A socket's close while
 * the session is open closes nothing else: only `close()` ends the session.
 * Messages of a socket that is no longer the session's, and of a context that
 * is neither in flight nor waited for, are dropped.
 *
 * @see https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-multi-stream-input
 * @see https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/multi-context-web-socket
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
import type { TextSegment } from '../ttsTextBoundaries.js';
import { ApiKeyPool } from '../../../core/providers/ApiKeyPool.js';
import {
  defaultCapabilities,
  type HealthyProvider,
  type HealthCheckResult,
  type ProviderCapabilities,
} from '../HealthyProvider.js';
import { VoicePipelineError } from '../VoicePipelineError.js';

/** How long a socket has to open before the open is given up. */
const CONNECT_TIMEOUT_MS = 8_000;
/** How long the next segment waits for the late `isFinal` of a segment that timed out, and for the audio before it. */
const STALE_FINAL_MS = 5_000;

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
   * Base URL for the ElevenLabs API (HTTP, not WS; the WS URL is derived from it).
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

/**
 * A message from ElevenLabs: an audio chunk of a context, or a context's final
 * message. The API reference spells the final message `isFinal` and the context
 * `contextId`; the multi-context guide reads `is_final`, so both are read.
 */
interface ELMessage {
  audio?: string; // base64-encoded audio
  isFinal?: boolean;
  is_final?: boolean;
  contextId?: string;
  context_id?: string;
  normalizedAlignment?: {
    char_start_times_ms: number[];
    chars_durations_ms: number[];
    chars: string[];
  };
}

/**
 * The close code of a socket and what is known of the reason, for a message:
 * ` (code 1011: internal error)`, ` (code 1011)`, ` (internal error)`, or
 * nothing when the close carried neither.
 */
function closeCode(code: unknown, detail = ''): string {
  const parts = [typeof code === 'number' ? `code ${code}` : '', detail].filter((part) => part.length > 0);
  return parts.length > 0 ? ` (${parts.join(': ')})` : '';
}

// ---------------------------------------------------------------------------
// Session Implementation
// ---------------------------------------------------------------------------

/**
 * A live streaming TTS session connected to ElevenLabs via WebSocket.
 * Emits `audio`, `flush_complete`, `warning`, and `close` events as required
 * by the voice pipeline orchestrator; `'error'` never, since the orchestrator
 * ends the session on it and every failure here is one the session goes on
 * after.
 */
class ElevenLabsStreamingTTSSession extends EventEmitter implements StreamingTTSSession {
  /** The current socket; `null` once the server, a cancel or a close has closed it. */
  private ws: WebSocket | null = null;
  /** The segment in flight and its context, from its messages going out until its `isFinal`, its timeout, its failure or a cancel. */
  private flight?: { segmentId: string; contextId: string };
  /**
   * The context of a segment that timed out, while the next segment waits for its late `isFinal`: the audio it still
   * delivers goes out as it comes, so a slow sentence arrives whole and in order before the next context starts. The
   * timer bounds the wait.
   */
  private staleContext?: string;
  private stale?: ReturnType<typeof setTimeout>;
  /** The segment that has had its one retry: a second failure of it ends the reply. */
  private retried?: string;
  /** Set when a second failure ended the reply before its `flush()` came: the rest of the reply's text is dropped until then. */
  private failed = false;
  /** How many `flush()` calls wait for the queue. */
  private flushes = 0;
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
      start: (segment, signal) => this.synthesize(segment, signal),
      emit: (chunk) => this.emit('audio', chunk),
      flushed: () => this.emit('flush_complete'),
      // The context's close message is still outstanding: its isFinal, and the rest of its audio, may yet come.
      timedOut: () => {
        this.staleContext = this.flight?.contextId;
        this.flight = undefined;
        this.holdFor(STALE_FINAL_MS);
      },
    });
  }

  /**
   * Open the WebSocket connection to the ElevenLabs multi-context streaming
   * endpoint; the segments of every reply go out on it while the server keeps it.
   */
  async connect(): Promise<void> {
    await this.open();
  }

  /**
   * Opens a socket; resolves once it is open. Nothing is sent at the open: a
   * segment's context carries the voice and generation settings in its first
   * message. Rejects when the socket errors or closes before it opens, or does
   * not open within eight seconds. The socket becomes the session's current one
   * as it is created.
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

    const url = `${wsBase}/text-to-speech/${voiceId}/multi-stream-input?${params.toString()}`;

    return new Promise<WebSocket>((resolve, reject) => {
      let settled = false;
      /** The error the socket reported after it opened; the close that follows it names it. */
      let failure: Error | undefined;
      const ws = new WebSocket(url, {
        headers: {
          'xi-api-key': this.config.apiKey,
        },
      });
      this.ws = ws;
      // A socket that does not open in time is given up: closed, and no longer the session's, so what it reports
      // later is ignored.
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (this.ws === ws) this.ws = null;
        ws.close(1000, 'connect timeout');
        reject(new Error(`elevenlabs ws connect timed out after ${CONNECT_TIMEOUT_MS}ms`));
      }, CONNECT_TIMEOUT_MS);
      // The socket failed before it opened: it is no longer the session's, and the open's rejection reaches the
      // segment it was for through synthesize(). The close that follows a failed connect, and whatever else the
      // socket reports, then changes nothing.
      const giveUp = (error: Error): void => {
        settled = true;
        clearTimeout(timer);
        if (this.ws === ws) this.ws = null;
        reject(error);
      };

      ws.on('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // A cancel or a close while the socket opened made it no one's: it closes unused.
        if (this.ws !== ws) {
          ws.close(1000, 'superseded');
          reject(new Error('elevenlabs socket superseded'));
          return;
        }
        resolve(ws);
      });

      // Before the socket opens the error rejects the open. After it, ws closes the socket next, and that close is
      // handled as the close of a socket, naming this error.
      ws.on('error', (err: Error) => {
        if (!settled) {
          giveUp(err);
          return;
        }
        failure = err;
      });

      ws.on('message', (data: Buffer | string) => {
        if (this.ws !== ws) return;
        this._handleMessage(typeof data === 'string' ? data : data.toString('utf-8'));
      });

      // A socket closes at the server's hand too: an idle one after inactivity_timeout, 20 seconds by default, which is
      // no failure, or one with a segment in flight, which is the segment's failure. Only close() closes the session.
      ws.on('close', (code: number, reason?: Buffer) => {
        if (!settled) {
          giveUp(new Error(`elevenlabs ws closed before it opened${closeCode(code)}`));
          return;
        }
        if (this.ws !== ws) return;
        this.ws = null;
        if (this.closed) return;
        const flight = this.flight;
        if (flight) {
          this.flight = undefined;
          const detail = failure ? failure.message : reason && reason.length > 0 ? reason.toString('utf-8') : '';
          this.segmentFailed(flight.segmentId, `elevenlabs ws closed before the segment's isFinal${closeCode(code, detail)}`, () =>
            this.segments.retry()
          );
          return;
        }
        // The context the next segment waited on is gone with its socket: nothing more of its audio can come.
        if (this.staleContext !== undefined) this.release();
      });
    });
  }

  /**
   * Reports a failure the session goes on after. `'error'` must not carry it:
   * the orchestrator ends the session on a TTS session's `'error'`. A
   * `'warning'` listener gets it; with none, it is one console warning line.
   */
  private warnOf(warning: Error): void {
    if (this.listenerCount('warning') > 0) this.emit('warning', warning);
    else console.warn(`[elevenlabs-streaming] ${warning.message}`);
  }

  /**
   * A failure of the segment in flight: its socket failed to open, or closed
   * before its `isFinal`. It is reported as a warning naming the cause. The
   * first failure of a segment has it spoken again, whole, on a fresh socket
   * (`again`); the second ends the reply, never the session.
   */
  private segmentFailed(segmentId: string, cause: string, again: () => void): void {
    if (this.retried !== segmentId) {
      this.retried = segmentId;
      this.warnOf(new Error(`${cause}; the segment is spoken again on a fresh socket`));
      again();
      return;
    }
    this.warnOf(new Error(`${cause}; the reply ends`));
    this.endReply();
  }

  /**
   * The reply ends short: the segment in flight ends without a boundary, the
   * segments still queued are dropped, a `flush()` already waiting completes
   * with `flush_complete`, and until the reply's `flush()` comes the rest of its
   * text is dropped. The session stays open for the next reply.
   */
  private endReply(): void {
    if (this.flushes === 0) this.failed = true;
    this.flight = undefined;
    this.retried = undefined;
    this.segments.lost();
  }

  /** Opens the session's socket anew; the one before is gone. */
  private async socket(): Promise<WebSocket> {
    const ws = await this.open();
    if (this.closed) {
      ws.close(1000, 'session closed');
      throw new Error('elevenlabs session closed');
    }
    return ws;
  }

  /**
   * Sends one segment as a context of its own on the session's socket: the
   * context's initial message with the settings, the segment's text with the
   * `flush` flag, ending in a space as ElevenLabs asks, and the context's
   * close, whose `isFinal` completes the segment. On an open socket all three go
   * out within the call, so the text a caller pushes reaches the provider in the
   * same turn; otherwise a socket is opened first. A cancel or a close while
   * that socket opens sends nothing. A socket that fails to open is a failure
   * of the segment (`segmentFailed`): a warning, and a fresh socket once.
   */
  private async synthesize(segment: TextSegment, signal: AbortSignal): Promise<void> {
    let ws: WebSocket | null = this.ws && this.ws.readyState === WebSocket.OPEN ? this.ws : null;
    while (!ws) {
      try {
        ws = await this.socket();
      } catch (err) {
        // A cancel or a close while the socket opened is no failure.
        if (signal.aborted || this.closed) return;
        let again = false;
        this.segmentFailed(
          segment.segmentId,
          `elevenlabs ws failed to open for a segment (${err instanceof Error ? err.message : String(err)})`,
          () => {
            again = true;
          }
        );
        // The reply has ended: the segment is no longer in flight.
        if (!again) return;
      }
    }
    if (signal.aborted || this.ws !== ws) return;
    const contextId = segment.segmentId;
    this.flight = { segmentId: segment.segmentId, contextId };
    // The context's first message carries the generation settings. First-class expressiveness wins over legacy
    // providerOptions per knob: the same camelCase names, a plain spread merge.
    const opts: Record<string, unknown> = {
      ...(this.sessionConfig?.providerOptions ?? {}),
      ...(this.sessionConfig?.expressiveness ?? {}),
    };
    ws.send(
      JSON.stringify({
        text: ' ', // The initial text of a context must be a blank space.
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
        context_id: contextId,
      })
    );
    ws.send(JSON.stringify({ text: /\s$/.test(segment.text) ? segment.text : `${segment.text} `, context_id: contextId, flush: true }));
    ws.send(JSON.stringify({ context_id: contextId, close_context: true }));
  }

  /**
   * Feeds the text to the segmenter; each sentence it completes is queued and
   * synthesized in turn. The rest of a reply a failure ended is dropped.
   */
  pushTokens(tokens: string): void {
    if (this.closed || this.failed) return;
    this.segments.push(tokens);
  }

  /**
   * Queues the final, unterminated segment and resolves once every queued
   * segment has completed or timed out; `flush_complete` goes out once, then.
   * A cancel or a close ends the wait without `flush_complete`. The flush of a
   * reply a failure ended completes at once, and the next reply is spoken.
   */
  async flush(): Promise<void> {
    if (this.closed) return;
    this.failed = false;
    this.flushes++;
    try {
      await this.segments.flush();
    } finally {
      this.flushes--;
    }
  }

  /**
   * Drops the queued segments, the held frame and the segment in flight, and
   * closes the socket, so nothing of the cut text is heard. The session stays
   * open: the next segment opens a new socket.
   */
  cancel(): void {
    this.segments.cancel();
    this.flight = undefined;
    this.retried = undefined;
    this.failed = false;
    // The socket closes with the cancel, a timed-out context the next segment waited on with it: nothing late is
    // waited for.
    this.release();
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
    this.flight = undefined;
    this.release();

    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000, 'session closed');

    this.emit('close');
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /** Keeps the next segment from starting until the timed-out context's late `isFinal` arrives, its socket closes, or `ms` have passed. */
  private holdFor(ms: number): void {
    if (this.stale !== undefined) clearTimeout(this.stale);
    this.segments.hold();
    this.stale = setTimeout(() => this.release(), ms);
  }

  /** The late response arrived, or its wait ran out: the next segment may start. */
  private release(): void {
    this.staleContext = undefined;
    if (this.stale === undefined) return;
    clearTimeout(this.stale);
    this.stale = undefined;
    this.segments.release();
  }

  /**
   * Whose a message is: the segment in flight's, the timed-out context's the
   * next segment waits for, or nobody's. A message without a context id, which
   * the reference does not describe, is read as the segment in flight's, or as
   * the waited-for context's when none is in flight.
   */
  private ownerOf(contextId: string | undefined): 'flight' | 'stale' | undefined {
    if (this.flight && (contextId === undefined || contextId === this.flight.contextId)) return 'flight';
    if (this.staleContext !== undefined && (contextId === undefined || contextId === this.staleContext)) return 'stale';
    return contextId === undefined ? 'flight' : undefined;
  }

  /**
   * Parse and dispatch an ElevenLabs WebSocket message.
   * Audio chunks arrive as base64-encoded MP3 data that we decode and emit.
   */
  private _handleMessage(raw: string): void {
    let msg: ELMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // Malformed JSON: skipped.
    }
    const contextId = msg.contextId ?? msg.context_id;

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

      // The segment in flight's audio is held for its boundary; the late audio of a timed-out context goes out as it
      // comes, without a boundary; that of a cancelled context, or of one whose wait has ended, is dropped.
      const owner = this.ownerOf(contextId);
      if (owner === 'flight') this.segments.frame(chunk);
      else if (owner === 'stale') this.emit('audio', chunk);
    }

    // The context is complete: the held frame goes out with the segment's boundary. The late isFinal of a segment that
    // timed out completes nothing: it ends the wait of the next segment.
    if (msg.isFinal === true || msg.is_final === true) {
      const owner = this.ownerOf(contextId);
      if (owner === 'flight') {
        this.flight = undefined;
        this.retried = undefined;
        this.segments.completed();
      } else if (owner === 'stale') {
        this.release();
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
