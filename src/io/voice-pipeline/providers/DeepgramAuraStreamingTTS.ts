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
 * - **Inbound (client to Deepgram):** JSON control frames:
 *   `{ "type": "Speak", "text": "..." }`, `{ "type": "Flush" }`, `{ "type": "Clear" }`.
 * - **Outbound (Deepgram to client):** BINARY audio frames, plus text JSON
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
 * `Flushed` proves complete; every earlier frame carries none. A `Flushed` is
 * matched to the `Flush` it answers by its `sequence_id`, which Deepgram's
 * reference gives as "The sequence ID of the response": the session numbers
 * the `Flush` messages it sends on a socket from 0, the id Deepgram's `Flush`
 * example is answered with, and a `Flushed` completes only the segment whose
 * `Flush` has its number. A segment with no `Flushed`
 * within five seconds ends without a boundary, and the next segment waits for
 * that late `Flushed`, at most five seconds more, before it starts. A
 * `Flushed` whose number names no `Flush` the session waits for (one later
 * than that wait, one of a `Flush` a cancel settled, one that answers no
 * `Flush` of the socket) completes nothing and is written as one console
 * warning line; one without a `sequence_id`, which the reference marks
 * required, answers the `Flush` of the segment in flight. After a `cancel()`
 * that cut a segment, Deepgram stops sending audio "as soon as possible" and
 * answers the `Clear` with `Cleared`: what arrives before the `Cleared` is the
 * cleared text's, so its audio is dropped and its `Flushed` completes nothing,
 * and the next segment starts at the `Cleared`, or one second after the cancel
 * without it. Deepgram takes at most 20 `Flush` messages in 60
 * seconds and answers the rest with a `Warning`: a segment that would pass that
 * limit is spoken without a `Flush`, the segments after it join it, each as its
 * own `Speak`, and one `Flush` once the window has passed completes them
 * together, so the boundary of that frame covers their joined text. A segment's
 * five seconds run from its `Flush`.
 *
 * ## Sockets
 *
 * `startSession()` opens the session's first socket; a socket that fails to
 * open rejects it. Deepgram closes a socket on its side too: one that has had
 * no message from the client in time (`1011`, `NET-0001`), and one past its
 * 60-minute limit. A socket closed between replies closes nothing and reports
 * nothing: the next reply's first segment opens a fresh socket, the reply's one
 * try, and a reply that follows a cut one takes the socket still opening. A
 * socket that fails to open for a reply (refused, closed or failed before it
 * opens, or not open within eight seconds) is a `'warning'` naming the cause,
 * one console warning line when nothing listens for it, never `'error'`, and
 * the reply ends unplayed: its segments are dropped, the rest of its text is
 * not spoken, and its `flush()` completes with `flush_complete`; the reply after
 * it tries again. A socket Deepgram closes while a segment is in flight or a
 * flush waits is the reply's failure: `'error'` (`deepgram aura ws closed`,
 * with the close code and the cause when known), the segments end without a
 * boundary, a flush under way completes with `flush_complete`, and the session
 * closes. An error the socket reports once open is the cause of the close that
 * follows it, never an `'error'` of its own. `close()` emits `close` once.
 *
 * @see https://developers.deepgram.com/docs/tts-websocket
 * @see https://developers.deepgram.com/reference/text-to-speech/speak-streaming
 * @see https://developers.deepgram.com/docs/tts-ws-flush
 * @see https://developers.deepgram.com/docs/tts-ws-clear
 * @see https://developers.deepgram.com/docs/streaming-text-to-speech
 * @see https://developers.deepgram.com/docs/tts-troubleshooting-websocket-net-and-data-errors
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
/** How long a Deepgram socket has to open before it is given up. */
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
 * The close code of a socket and what is known of its cause, for a message:
 * ` (code 1011: NET-0001)`, ` (code 1011)`, ` (NET-0001)`, or nothing when the
 * close carried neither.
 */
function closeCode(code: unknown, detail = ''): string {
  const parts = [typeof code === 'number' ? `code ${code}` : '', detail].filter((part) => part.length > 0);
  return parts.length > 0 ? ` (${parts.join(': ')})` : '';
}

/** What a failure says, for a warning that names its cause. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A live streaming TTS session connected to Deepgram Aura via WebSocket.
 * Emits `audio`, `flush_complete`, `warning`, `error`, and `close`.
 */
class DeepgramAuraStreamingTTSSession extends EventEmitter implements StreamingTTSSession {
  /**
   * The current socket: the open one, or the one opening for a reply; `null` once Deepgram has closed it between
   * replies, a socket has failed to open, or the session has closed.
   */
  private ws: WebSocket | null = null;
  /** Whether the current socket has opened. */
  private ready = false;
  /** The open of a socket for a reply, while it is under way: a segment that starts meanwhile waits for the same socket. */
  private opening?: Promise<WebSocket>;
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
  /** When each `Flush` of the last {@link FLUSH_WINDOW_MS} was sent, oldest first, on every socket the session opened. */
  private readonly flushes: number[] = [];
  /** Whether the segment in flight waits for a `Flush` slot: a new segment then joins it. */
  private waitingForSlot = false;
  /** The `sequence_id` Deepgram answers the next `Flush` on the current socket with: a socket's first is answered with 0. */
  private nextFlushId = 0;
  /** The number of the `Flush` the segment in flight sent, whose `Flushed` completes it; unset until that `Flush` goes out. */
  private flightFlushId?: number;
  /** The number of the `Flush` of a segment that timed out, while the next segment waits for its late `Flushed`. */
  private staleFlushId?: number;
  /** Set when a reply's socket failed to open before the reply's `flush()` came: the rest of its text is dropped until then. */
  private failed = false;
  /** How many `flush()` calls wait for the queue. */
  private flushCalls = 0;
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
      start: (segment, signal) => this.speak(segment, signal),
      // A segment arriving while the one in flight waits for a Flush slot is spoken now and completed with it.
      extend: (segment) => this.speakMore(segment),
      emit: (chunk) => this.emit('audio', chunk),
      flushed: () => this.emit('flush_complete'),
      // The segment's Flush is still outstanding: its Flushed may yet come, and must not complete the next segment.
      timedOut: () => {
        this.staleFlushId = this.flightFlushId;
        this.flightFlushId = undefined;
        this.holdFor(STALE_FLUSHED_MS);
      },
    });
  }

  /** Opens the session's first socket; a socket that fails to open rejects (see {@link open}). */
  async connect(): Promise<void> {
    await this.open();
  }

  /**
   * Opens a socket, which becomes the session's current one as it is created,
   * and resolves once it is open. Deepgram needs no beginning-of-stream
   * handshake. The `Flush` numbering starts again at 0 on it.
   *
   * The open settles exactly once, and every failure rejects it, never an
   * `'error'`, which at `startSession()` would find no listener: an unlistened
   * emit throws, and the open would never settle. A refused upgrade rejects
   * with Deepgram's response body (`unexpected-response`), which names the
   * offending parameter, such as UNSUPPORTED_AUDIO_FORMAT; so does a socket
   * that fails or closes before it opens, or that has not opened within eight
   * seconds. A socket given up is closed and no longer the session's, so
   * nothing it reports later changes anything.
   */
  private open(): Promise<WebSocket> {
    const wsBase = this.config.baseUrl ?? 'wss://api.deepgram.com/v1/speak';
    const params = new URLSearchParams({ model: this.voice, encoding: this.encoding });
    // linear16 (raw PCM) requires an explicit sample_rate; container formats infer it.
    if (this.encoding === 'linear16') params.set('sample_rate', String(this.sampleRate));
    const url = `${wsBase}?${params.toString()}`;

    return new Promise<WebSocket>((resolve, reject) => {
      let settled = false;
      /** The error the socket reported once open; the close that follows names it. */
      let failure: Error | undefined;
      const ws = new WebSocket(url, {
        headers: { Authorization: `Token ${this.config.apiKey}` },
      });
      this.ws = ws;
      this.ready = false;
      this.nextFlushId = 0;
      const timer = setTimeout(() => {
        giveUp(new Error(`deepgram aura ws connect timed out after ${CONNECT_TIMEOUT_MS}ms`));
      }, CONNECT_TIMEOUT_MS);
      const giveUp = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.ws === ws) this.ws = null;
        ws.close();
        reject(err);
      };

      // The server refused the upgrade (4xx/5xx). Read the response body: Deepgram names the offending parameter in it.
      ws.on('unexpected-response', (_req, res) => {
        let body = '';
        res.on('data', (d: Buffer) => {
          body += d.toString('utf-8');
        });
        res.on('end', () => {
          giveUp(new Error(`deepgram aura ws rejected: HTTP ${res.statusCode}${body ? `: ${body.slice(0, 300)}` : ''}`));
        });
      });

      ws.on('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // A close() while the socket opened made it no one's: it closes unused.
        if (this.ws !== ws) {
          ws.close(1000, 'session closed');
          reject(new Error('deepgram aura session closed'));
          return;
        }
        this.ready = true;
        resolve(ws);
      });
      // Before the socket opens the error fails the open. Once it is open, ws closes the socket next, and that close
      // names this error as its cause.
      ws.on('error', (err: Error) => {
        if (!settled) giveUp(err);
        else failure = err;
      });
      ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (this.ws === ws) this._handleMessage(data, isBinary);
      });
      ws.on('close', (code: number, reason?: Buffer) => {
        if (!settled) {
          giveUp(new Error(`deepgram aura ws closed before the upgrade completed${closeCode(code)}`));
          return;
        }
        // The session's own close() has emitted close, and a socket the session no longer holds reports nothing.
        if (this.ws !== ws || this.closed) return;
        this.ws = null;
        this.ready = false;
        const detail = failure ? failure.message : reason && reason.length > 0 ? reason.toString('utf-8') : '';
        this.socketClosed(`deepgram aura ws closed${closeCode(code, detail)}`);
      });
    });
  }

  /**
   * The current socket closed at Deepgram's hand. With a segment in flight or
   * a flush waiting, the reply has lost its audio: `'error'` names the close,
   * the segments end without a boundary, a flush under way completes with
   * `flush_complete`, and the session closes. Between replies it closes
   * nothing: the next reply opens a fresh socket, and a late response the
   * next segment waited for cannot come any more.
   *
   * @param message - The loss, with the close code and the cause when known.
   */
  private socketClosed(message: string): void {
    this.flightFlushId = undefined;
    this.staleFlushId = undefined;
    if (!this.segments.busy) {
      this.release();
      return;
    }
    this.closed = true;
    this._emitErrorSafe(new Error(message));
    // The segments in flight and queued end without a boundary, and a flush under way completes, so the reply ends.
    this.segments.lost();
    this.release();
    this.emit('close');
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

  /**
   * Reports a failure the session goes on after. `'error'` must not carry it:
   * the orchestrator ends the session on a TTS session's `'error'`. A
   * `'warning'` listener gets it; with none, it is one console warning line.
   */
  private warnOf(warning: Error): void {
    if (this.listenerCount('warning') > 0) this.emit('warning', warning);
    else console.warn(`[deepgram-aura] ${warning.message}`);
  }

  /**
   * Feeds the text to the segmenter; each sentence it completes is queued and
   * synthesized in turn. The rest of a reply whose socket failed to open is
   * dropped.
   */
  pushTokens(tokens: string): void {
    if (this.closed || this.failed) return;
    this.segments.push(tokens);
  }

  /**
   * Queues the final, unterminated segment and resolves once every queued
   * segment has completed or timed out; `flush_complete` goes out once, then.
   * A cancel or `close()` ends the wait without `flush_complete`; a socket
   * Deepgram closes mid-reply ends it with `flush_complete`, after the
   * `'error'` that reports the lost reply, and so does a socket that fails to
   * open for the reply, after its warning. The flush of a reply whose socket
   * failed to open completes at once, and the next reply opens one again.
   */
  async flush(): Promise<void> {
    if (this.closed) return;
    this.failed = false;
    this.flushCalls++;
    try {
      await this.segments.flush();
    } finally {
      this.flushCalls--;
    }
  }

  /**
   * Drops the queued segments, the held frame and the segment in flight, and
   * sends `Clear` on an open socket, which discards the server's buffered text
   * and audio without tearing down the socket. The session stays usable: when
   * a segment was outstanding, what Deepgram sends before the `Cleared` that
   * answers the `Clear` belongs to the cleared text, so its audio is dropped
   * and its `Flushed` completes nothing, and the next segment starts at the
   * `Cleared`, or after one second without it. A socket still opening is sent
   * nothing: the next reply takes it.
   */
  cancel(): void {
    const outstanding = this.segments.hasInFlight || this.stale !== undefined;
    this.segments.cancel();
    this.failed = false;
    // The Clear settles every Flush sent so far: a Flushed that answers one completes nothing.
    this.flightFlushId = undefined;
    this.staleFlushId = undefined;
    if (!this.isOpen()) {
      this.release();
      return;
    }
    this.send({ type: 'Clear' });
    if (outstanding) {
      this.clearing = true;
      this.holdFor(CLEARED_MS);
    }
  }

  /**
   * Ends the session: the segments are dropped, the socket is closed, and `close` is emitted, once. The socket's
   * closing handshake, when it completes, emits nothing more, and a socket still opening is closed as it opens.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.segments.cancel();
    this.release();
    const ws = this.ws;
    this.ws = null;
    this.ready = false;
    if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000, 'session closed');
    this.emit('close');
  }

  /** Whether the current socket is open: it has opened, and is not closing. */
  private isOpen(): boolean {
    return this.ws !== null && this.ready && this.ws.readyState === WebSocket.OPEN;
  }

  /** Sends one control message; a socket that is not open ends the segment being started without a boundary. */
  private send(message: { type: string; text?: string }): void {
    if (!this.isOpen()) throw new Error('deepgram aura ws is not open');
    this.ws!.send(JSON.stringify(message));
  }

  /**
   * Starts one segment: its `Speak`, then its `Flush` now or once a slot frees
   * ({@link speakOn}). On an open socket the `Speak` goes out within the call,
   * so the text a caller pushes reaches Deepgram in the same turn. With none,
   * Deepgram having closed the last one between replies, the segment waits for
   * a fresh socket first ({@link reopenThenSpeak}).
   */
  private speak(segment: TextSegment, signal: AbortSignal): void | Promise<void> {
    if (this.isOpen()) return this.speakOn(segment, signal);
    return this.reopenThenSpeak(segment, signal);
  }

  /** Sends the segment's `Speak` on the open socket, and its `Flush` now, or once a slot frees ({@link flushWhenSlotFrees}). */
  private speakOn(segment: TextSegment, signal: AbortSignal): void | Promise<void> {
    this.send({ type: 'Speak', text: segment.text });
    if (this.flushSlotFree()) {
      this.sendFlush();
      return undefined;
    }
    return this.flushWhenSlotFrees(signal);
  }

  /**
   * Opens a fresh socket for the segment, or waits for the one opening, then
   * sends the segment. A cancel or a close meanwhile sends nothing. A socket
   * that fails to open ends the reply with a warning ({@link endReply}), never
   * the session.
   */
  private async reopenThenSpeak(segment: TextSegment, signal: AbortSignal): Promise<void> {
    try {
      await this.socket();
    } catch (err) {
      // A cancel or a close while the socket opened is no failure of the reply.
      if (signal.aborted || this.closed) return;
      this.warnOf(new Error(`deepgram aura ws failed to open for a reply (${messageOf(err)}); the reply ends unplayed`));
      this.endReply();
      return;
    }
    if (signal.aborted || this.closed) return;
    await this.speakOn(segment, signal);
  }

  /** The open socket: the current one, the one opening, or a fresh one. */
  private socket(): Promise<WebSocket> {
    if (this.isOpen()) return Promise.resolve(this.ws!);
    this.opening ??= this.open().finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  /**
   * The reply ends unplayed: the segment in flight and the queued ones are
   * dropped, a `flush()` already waiting completes with `flush_complete`, and
   * until the reply's `flush()` comes the rest of its text is dropped. The
   * session stays open: the next reply opens a socket again.
   */
  private endReply(): void {
    if (this.flushCalls === 0) this.failed = true;
    this.segments.lost();
  }

  /** Whether another `Flush` may go out now: fewer than {@link FLUSH_LIMIT} went out in the last {@link FLUSH_WINDOW_MS}. */
  private flushSlotFree(): boolean {
    const since = Date.now() - FLUSH_WINDOW_MS;
    while (this.flushes.length > 0 && this.flushes[0]! <= since) this.flushes.shift();
    return this.flushes.length < FLUSH_LIMIT;
  }

  /** Sends `Flush`, counts it against the window, and numbers it: the `Flushed` with its number completes the segment in flight. */
  private sendFlush(): void {
    this.send({ type: 'Flush' });
    this.flushes.push(Date.now());
    this.flightFlushId = this.nextFlushId++;
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

  /**
   * The stale response arrived, or its wait ran out: the next segment may start, Deepgram's audio is the session's
   * again, and a `Flushed` of the timed-out segment is waited for no more.
   */
  private release(): void {
    this.clearing = false;
    this.staleFlushId = undefined;
    if (this.stale === undefined) return;
    clearTimeout(this.stale);
    this.stale = undefined;
    this.segments.release();
  }

  /**
   * A `Flushed`: Deepgram has sent the final audio of the text before the
   * `Flush` its `sequence_id` names. It completes the segment in flight when it
   * answers that segment's `Flush`, and ends the next segment's wait when it
   * answers the `Flush` of the segment that timed out. Any other completes
   * nothing and is written as one console warning line. Before the `Cleared`
   * that answers a `Clear`, a `Flushed` is the cleared text's and is dropped.
   * One without a `sequence_id` answers the `Flush` of the segment in flight,
   * or of the one that timed out.
   *
   * @param sequenceId - The message's `sequence_id`.
   */
  private flushed(sequenceId: unknown): void {
    // A Flushed before the Cleared answers a Flush of the cleared text: it completes nothing and ends no wait.
    if (this.clearing) return;
    const id = typeof sequenceId === 'number' && Number.isInteger(sequenceId) ? sequenceId : undefined;
    // The late Flushed the next segment waits for: it completes nothing.
    if (this.stale !== undefined && (id === undefined || id === this.staleFlushId)) {
      this.release();
      return;
    }
    if (this.flightFlushId !== undefined && (id === undefined || id === this.flightFlushId)) {
      this.flightFlushId = undefined;
      this.segments.completed();
      return;
    }
    console.warn(`[deepgram-aura] a Flushed with sequence_id ${id ?? 'none'} answers no Flush the session waits for; it completes nothing`);
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
    let msg: { type?: string; sequence_id?: unknown };
    try {
      msg = JSON.parse(data.toString('utf-8'));
    } catch {
      return;
    }
    if (msg.type === 'Flushed') {
      this.flushed(msg.sequence_id);
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
