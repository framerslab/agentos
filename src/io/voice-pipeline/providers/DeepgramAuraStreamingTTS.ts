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
 * ## Sentence segments
 *
 * The session synthesizes one sentence segment at a time
 * ({@link SegmentSynthesisQueue}): each segment goes out as one `Speak`
 * followed by one `Flush`, and `Flushed`, which Deepgram sends once it has
 * returned the final audio for the text sent so far, completes it. The
 * segment's boundary ({@link TtsTextBoundary}) rides on the last frame
 * `Flushed` proves complete; every earlier frame carries none. A segment with
 * no `Flushed` within five seconds ends without a boundary, and the next
 * segment waits for that late `Flushed`, or for the `Cleared` that answers a
 * `Clear`, before it starts: a `Flushed` of a segment that timed out or was
 * cleared must never complete the segment after it, and Deepgram's
 * `sequence_id` is documented only as "The sequence ID of the response", so the
 * session does not read it. After a `cancel()` that cut a segment, Deepgram
 * stops sending audio "as soon as possible" and answers the `Clear` with
 * `Cleared`: what arrives before the `Cleared` is the cleared text's, so its
 * audio is dropped and its `Flushed` completes nothing, and the next segment
 * starts at the `Cleared`, or one second after the cancel without it.
 * Deepgram takes at most 20 `Flush` messages in 60
 * seconds and answers the rest with a `Warning`: a segment that would pass that
 * limit is spoken without a `Flush`, the segments after it join it, each as its
 * own `Speak`, and one `Flush` once the window has passed completes them
 * together, so the boundary of that frame covers their joined text. A segment's
 * five seconds run from its `Flush`. A socket Deepgram closes while a segment
 * is in flight or a flush waits is the reply's failure: `'error'`
 * (`deepgram aura ws closed`), the segments end without a boundary, a flush
 * under way completes with `flush_complete`, and the session closes; a socket
 * closed between replies closes the session alone.
 *
 * @see https://developers.deepgram.com/docs/tts-websocket
 * @see https://developers.deepgram.com/docs/tts-ws-flush
 * @see https://developers.deepgram.com/docs/tts-ws-clear
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

const DEFAULT_VOICE = 'aura-2-thalia-en';
const DEFAULT_SAMPLE_RATE = 24_000;
/** How long to wait for the Deepgram WS upgrade before failing the connect. */
const CONNECT_TIMEOUT_MS = 8_000;
/** How long the next segment waits for the late `Flushed` of a segment that timed out. */
const STALE_FLUSHED_MS = 5_000;
/** How long the next segment waits for the `Cleared` that answers a `Clear`, one round trip. */
const CLEARED_MS = 1_000;
/** The most `Flush` messages Deepgram takes in {@link FLUSH_WINDOW_MS}. */
const FLUSH_LIMIT = 20;
/** Deepgram's window for the `Flush` limit, 60 seconds, with one second for the clocks on either side. */
const FLUSH_WINDOW_MS = 61_000;

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
  private readonly segments: SegmentSynthesisQueue;
  /**
   * Set while the next segment waits for a stale response: the late `Flushed`
   * of a segment that timed out, or the `Cleared` that answers a `Clear`. The
   * timer bounds the wait.
   */
  private stale?: ReturnType<typeof setTimeout>;
  /**
   * Whether the session waits for the `Cleared` that answers a `Clear` it sent
   * while a segment was outstanding: until then Deepgram may still send audio
   * and a `Flushed` of the cleared text, which are dropped. The wait for a
   * stale response bounds it.
   */
  private clearing = false;
  /** When each `Flush` of the last {@link FLUSH_WINDOW_MS} was sent, oldest first. */
  private readonly flushes: number[] = [];
  /** Whether the segment in flight waits for a `Flush` slot: a new segment then joins it. */
  private waitingForSlot = false;
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
    this.segments = new SegmentSynthesisQueue({
      start: (segment, signal) => {
        this.send({ type: 'Speak', text: segment.text });
        if (this.flushSlotFree()) {
          this.sendFlush();
          return undefined;
        }
        return this.flushWhenSlotFrees(signal);
      },
      // A segment arriving while the one in flight waits for a Flush slot is spoken now and completed with it.
      extend: (segment) => this.speakMore(segment),
      emit: (chunk) => this.emit('audio', chunk),
      flushed: () => this.emit('flush_complete'),
      // The segment's Flush is still outstanding: its Flushed may yet come, and must not complete the next segment.
      timedOut: () => this.holdFor(STALE_FLUSHED_MS),
    });
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
        // A socket lost while a segment is in flight or a flush waits is the reply's failure, reported before the
        // session closes; one closed between replies closes the session alone.
        const lostReply = settled && this.segments.busy;
        this.closed = true;
        if (lostReply) this._emitErrorSafe(new Error('deepgram aura ws closed'));
        // The segments in flight and queued end without a boundary, and a flush under way completes, so the reply ends.
        this.segments.lost();
        this.release();
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

  /** Feeds the text to the segmenter; each sentence it completes is queued and synthesized in turn. */
  pushTokens(tokens: string): void {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.segments.push(tokens);
  }

  /**
   * Queues the final, unterminated segment and resolves once every queued
   * segment has completed or timed out; `flush_complete` goes out once, then.
   * A cancel or `close()` ends the wait without `flush_complete`; a socket
   * Deepgram closes ends it with `flush_complete`, after the `'error'` that
   * reports the lost reply.
   */
  async flush(): Promise<void> {
    if (this.closed) return;
    await this.segments.flush();
  }

  /**
   * Drops the queued segments, the held frame and the segment in flight, and
   * sends `Clear`, which discards the server's buffered text and audio without
   * tearing down the socket. The session stays usable: when a segment was
   * outstanding, what Deepgram sends before the `Cleared` that answers the
   * `Clear` belongs to the cleared text, so its audio is dropped and its
   * `Flushed` completes nothing, and the next segment starts at the `Cleared`,
   * or after one second without it.
   */
  cancel(): void {
    const outstanding = this.segments.hasInFlight || this.stale !== undefined;
    this.segments.cancel();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'Clear' }));
      if (outstanding) this.clearing = true;
    }
    if (outstanding) this.holdFor(CLEARED_MS);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.segments.cancel();
    this.release();
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.close(1000, 'session closed');
      this.ws = null;
    }
    this.emit('close');
  }

  /** Sends one control message; a socket that is not open ends the segment being started without a boundary. */
  private send(message: { type: string; text?: string }): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('deepgram aura ws is not open');
    this.ws.send(JSON.stringify(message));
  }

  /** Whether another `Flush` may go out now: fewer than {@link FLUSH_LIMIT} went out in the last {@link FLUSH_WINDOW_MS}. */
  private flushSlotFree(): boolean {
    const since = Date.now() - FLUSH_WINDOW_MS;
    while (this.flushes.length > 0 && this.flushes[0]! <= since) this.flushes.shift();
    return this.flushes.length < FLUSH_LIMIT;
  }

  /** Sends `Flush` and counts it against the window. */
  private sendFlush(): void {
    this.send({ type: 'Flush' });
    this.flushes.push(Date.now());
  }

  /**
   * Waits for a `Flush` slot, then sends the `Flush`; a cancel or a close (`signal`) ends the wait with nothing sent.
   * The segments that arrive meanwhile join the one in flight ({@link speakMore}).
   */
  private async flushWhenSlotFrees(signal: AbortSignal): Promise<void> {
    this.waitingForSlot = true;
    try {
      while (!this.flushSlotFree()) {
        await this.slotTimer(this.flushes[0]! + FLUSH_WINDOW_MS - Date.now(), signal);
        if (signal.aborted) return;
      }
    } finally {
      this.waitingForSlot = false;
    }
    this.sendFlush();
  }

  /** Resolves after `ms`, or at once when `signal` aborts. */
  private slotTimer(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const done = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      signal.addEventListener('abort', done, { once: true });
    });
  }

  /**
   * Speaks a segment that joins the one waiting for a `Flush` slot, so one `Flush` completes them together; `false`
   * leaves it queued, when no segment waits for a slot or the socket is not open.
   */
  private speakMore(segment: TextSegment): boolean {
    if (!this.waitingForSlot) return false;
    try {
      this.send({ type: 'Speak', text: segment.text });
      return true;
    } catch {
      return false;
    }
  }

  /** Keeps the next segment from starting until a stale `Flushed` or a `Cleared` arrives, or `ms` have passed. */
  private holdFor(ms: number): void {
    if (this.stale !== undefined) clearTimeout(this.stale);
    this.segments.hold();
    this.stale = setTimeout(() => this.release(), ms);
  }

  /** The stale response arrived, or its wait ran out: the next segment may start, and Deepgram's audio is the session's again. */
  private release(): void {
    this.clearing = false;
    if (this.stale === undefined) return;
    clearTimeout(this.stale);
    this.stale = undefined;
    this.segments.release();
  }

  private _handleMessage(data: Buffer, isBinary: boolean): void {
    if (isBinary) {
      // Audio sent before Deepgram read the Clear is the cleared text's: no reply plays it.
      if (this.clearing) return;
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
        container: this.container,
        sampleRate: this.sampleRate,
        durationMs,
        // Legacy: the text of the segment in flight, never read as the text this frame plays.
        text: this.segments.inFlightText,
      };
      this.segments.frame(chunk);
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
      // A Flushed before the Cleared answers a Flush of the cleared text: it completes nothing and ends no wait.
      if (this.clearing) return;
      // A Flushed while the queue waits for a stale response is that response: it completes nothing.
      if (this.stale !== undefined) this.release();
      else this.segments.completed();
    } else if (msg.type === 'Cleared') {
      // Everything sent before the Clear is settled: no Flushed of a cleared segment can follow.
      this.release();
    }
    // Metadata / Warning frames are ignored.
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
