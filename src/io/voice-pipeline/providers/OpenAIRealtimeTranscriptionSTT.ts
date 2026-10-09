/**
 * @module voice-pipeline/providers/OpenAIRealtimeTranscriptionSTT
 *
 * Streaming speech-to-text adapter for OpenAI's Realtime API in its
 * transcription mode. Implements the {@link IStreamingSTT} /
 * {@link StreamingSTTSession} interfaces required by
 * {@link VoicePipelineOrchestrator}, and {@link HealthyProvider} for
 * {@link StreamingSTTChain}.
 *
 * ## OpenAI Realtime transcription protocol
 *
 * - **Endpoint:** `wss://api.openai.com/v1/realtime?intent=transcription`; the
 *   model is named in the session update, not in the URL
 * - **Authentication:** `Authorization: Bearer <apiKey>` on the upgrade, and
 *   optionally `OpenAI-Safety-Identifier: <stable end-user id>`
 * - **Configuration:** one `session.update` with `session.type: 'transcription'`,
 *   `audio/pcm` at 24 kHz, the model and the turn detection; the server
 *   confirms it with `session.updated`
 * - **Inbound (client → OpenAI):** `input_audio_buffer.append` with base64
 *   PCM16; `input_audio_buffer.commit` ends a turn when turn detection is off
 * - **Outbound (OpenAI → client):** `input_audio_buffer.speech_started`,
 *   `speech_stopped` and `committed`, then
 *   `conversation.item.input_audio_transcription.delta` and `.completed` (or
 *   `.failed`) for each item, keyed by `item_id`
 *
 * ## Event mapping
 *
 * - `...transcription.delta` → `'transcript'` with `isFinal: false`, carrying
 *   the item's text so far and its `itemId`
 * - `...transcription.completed` → `'transcript'` with `isFinal: true`
 * - `speech_started` / `speech_stopped` → `'speech_start'` / `'speech_end'`
 * - a server `error` the session survives, or a failed item → `'warning'`
 *   (a {@link VoicePipelineError})
 * - a failure the session cannot recover from → `'error'`, then `'close'`
 * - the audio of each connection → `'usage'` ({@link StreamingSTTUsageEvent})
 *
 * ## Long sessions
 *
 * OpenAI ends a Realtime session after 60 minutes. A session moves to a new
 * connection before that, with an overlap, and emits an utterance both
 * connections transcribed once: see {@link OpenAIRealtimeTranscriptionRollover}.
 *
 * @see https://developers.openai.com/api/docs/guides/realtime-transcription
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

// ---------------------------------------------------------------------------
// Protocol constants and defaults
// ---------------------------------------------------------------------------

/** OpenAI's Realtime WebSocket endpoint, without query parameters. */
const DEFAULT_BASE_URL = 'wss://api.openai.com/v1/realtime';

/** Sample rate of the `audio/pcm` input format the session update declares. */
const REALTIME_SAMPLE_RATE = 24_000;

/** Transcription model used when the config names none. */
const DEFAULT_MODEL = 'gpt-4o-mini-transcribe';

/** Models that take no server turn detection: the client commits each turn. */
const CLIENT_COMMIT_MODELS = ['gpt-live-transcribe', 'gpt-realtime-whisper'];

/** Models that take a `languages` list instead of a single `language`. */
const LANGUAGE_LIST_MODELS = ['gpt-live-transcribe', 'gpt-transcribe'];

const MINUTE_MS = 60_000;

/** Wait before the first reconnect after a drop; later ones wait `retryIntervalMs`. */
const FIRST_RETRY_DELAY_MS = 100;

async function defaultOpenAIProbe(apiKey: string) {
  const start = Date.now();
  const res = await fetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(1000),
  });
  return { ok: res.ok, status: res.status, latencyMs: Date.now() - start };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Server turn detection for a transcription session: OpenAI's voice activity
 * detector decides where each utterance ends and commits it.
 */
export interface OpenAIRealtimeTurnDetection {
  /** Activation threshold in [0, 1]; a higher value needs louder speech. @defaultValue 0.5 */
  threshold?: number;
  /** Audio kept before detected speech, in milliseconds. @defaultValue 600 */
  prefixPaddingMs?: number;
  /** Silence that ends an utterance, in milliseconds. @defaultValue 350 */
  silenceDurationMs?: number;
}

/** What {@link OpenAIRealtimeTranscriptionRollover.approve} is asked about. */
export interface OpenAIRealtimeRolloverRequest {
  /** Index the new connection gets when it opens (see `StreamingSTTUsageEvent.connectionIndex`). */
  connectionIndex: number;
  /**
   * What started the rollover: an end of speech after `afterMs`, the first
   * `flush()` after `afterMs` (client commits), or the deadline.
   */
  reason: 'speech_stopped' | 'flush' | 'deadline';
}

/**
 * When and how a session moves to a new connection before OpenAI's session
 * limit (60 minutes for a Realtime session). Ages are counted from the moment
 * a connection's session update was confirmed.
 *
 * With server turn detection, a connection older than `afterMs` opens the
 * next one at its first end of speech, or at `deadlineMs` whatever is being
 * said. Both connections receive the same audio for at least `overlapMs`; the
 * old one keeps receiving audio until it is between utterances (or until
 * `hardStopMs`, when its buffer is committed), finishes the items it holds and
 * closes. An utterance both connections transcribed is emitted once: from the
 * old connection, or from the new one when the old connection's transcription
 * of it fails, comes back empty or never arrives. The new connection's interim
 * text for utterances that began while the old one was open is not emitted.
 * With client commits (`turnDetection: null`) the switch happens at the first
 * `flush()` after `afterMs`, or with a commit at `deadlineMs`, and the
 * connections do not overlap.
 */
export interface OpenAIRealtimeTranscriptionRollover {
  /** Connection age after which the first end of speech opens the next connection. @defaultValue 3_300_000 (55 minutes) */
  afterMs?: number;
  /** Connection age at which the next connection opens whatever is being said. @defaultValue 3_480_000 (58 minutes) */
  deadlineMs?: number;
  /** Least time both connections receive the same audio. @defaultValue 3_000 */
  overlapMs?: number;
  /**
   * Connection age at which an old connection still in speech is committed
   * and drained, and at which a connection whose rollover was refused, or
   * has not opened its next connection yet, ends the session. Keep it under
   * the provider's 60-minute limit.
   * @defaultValue 3_570_000 (59.5 minutes)
   */
  hardStopMs?: number;
  /** Slack, in milliseconds, when matching an utterance of the new connection to one of the old. @defaultValue 500 */
  matchToleranceMs?: number;
  /**
   * Called before a rollover opens the next connection. Resolve `false`, or
   * throw, to refuse it: the session keeps its current connection until
   * `hardStopMs`, finishes the items it holds, and closes. An answer that has
   * not come by `hardStopMs` counts as a refusal, and a later one opens
   * nothing. A host that pays for audio per connection reserves the next
   * connection here.
   */
  approve?: (request: OpenAIRealtimeRolloverRequest) => boolean | Promise<boolean>;
}

/**
 * Configuration for the {@link OpenAIRealtimeTranscriptionSTT} provider.
 *
 * Per-session overrides go in `StreamingSTTConfig.providerOptions`:
 * `safetyIdentifier` (string) and `prompt` (string).
 */
export interface OpenAIRealtimeTranscriptionSTTConfig {
  /** OpenAI API key, or comma-separated keys rotated per session. Sent as a Bearer token on the upgrade. */
  apiKey: string;

  /**
   * Realtime API WebSocket URL, without query parameters. A host other than
   * `api.openai.com` (an OpenAI-compatible gateway) also gets the model as a
   * `model` query parameter.
   * @defaultValue 'wss://api.openai.com/v1/realtime'
   */
  baseUrl?: string;

  /** Transcription model. @defaultValue 'gpt-4o-mini-transcribe' */
  model?: string;

  /**
   * Server turn detection, or `null` for none: the caller then ends each turn
   * with `flush()`, which commits the buffer. Defaults to server turn
   * detection with 600 ms of padding and 350 ms of silence (the LiveKit plugin's
   * values; OpenAI's own defaults are 300 ms and 500 ms), and to `null` for `gpt-live-transcribe`
   * and `gpt-realtime-whisper`, which accept no server turn detection.
   */
  turnDetection?: OpenAIRealtimeTurnDetection | null;

  /** Context for the transcription model, such as vocabulary or the setting. */
  prompt?: string;

  /**
   * Stable, privacy-preserving identifier of the end user (for example a hash
   * of an account id), sent as the `OpenAI-Safety-Identifier` header.
   */
  safetyIdentifier?: string;

  /** Time a connection has to open and confirm its session update. @defaultValue 10_000 */
  connectTimeoutMs?: number;

  /**
   * Reconnects allowed after consecutive failures before the session ends
   * with an `'error'`. The count resets after every final transcript and when
   * a dropped connection had stayed open longer than `connectTimeoutMs`.
   * @defaultValue 3
   */
  maxRetries?: number;

  /** Wait before each reconnect after the first, which waits 100 ms. @defaultValue 2_000 */
  retryIntervalMs?: number;

  /** Audio held while no connection can take it (a reconnect), in milliseconds; older audio is dropped first. @defaultValue 10_000 */
  maxBufferedMs?: number;

  /** Longest wait for the finals of committed items in `flush()` and when a connection closes. @defaultValue 5_000 */
  finalTimeoutMs?: number;

  /** Interval of `'usage'` reports for open connections; `0` reports each connection once, when it closes. @defaultValue 0 */
  usageIntervalMs?: number;

  /** Rollover settings, or `false` to keep a single connection. */
  rollover?: OpenAIRealtimeTranscriptionRollover | false;

  /** Chain priority. Lower values are tried first. @default 15 */
  priority?: number;

  /** Optional capability overrides. Merged into defaultCapabilities(). */
  capabilities?: Partial<ProviderCapabilities>;

  /** Injectable health probe for tests. Defaults to OpenAI's /v1/models. */
  healthProbe?: (apiKey: string) => Promise<{ ok: boolean; status: number; latencyMs: number }>;
}

/** Settings of one session, resolved from the provider config and the session config. */
interface SessionSettings {
  providerId: string;
  model: string;
  url: string;
  headers: Record<string, string>;
  sessionUpdate: Record<string, unknown>;
  clientCommits: boolean;
  /** Audio OpenAI keeps before detected speech; a speech start lies this much before the onset. */
  prefixPaddingMs: number;
  language: string | undefined;
  interimResults: boolean;
  connectTimeoutMs: number;
  maxRetries: number;
  retryIntervalMs: number;
  maxBufferedMs: number;
  finalTimeoutMs: number;
  usageIntervalMs: number;
  rollover: ResolvedRollover | null;
}

interface ResolvedRollover {
  afterMs: number;
  deadlineMs: number;
  overlapMs: number;
  hardStopMs: number;
  matchToleranceMs: number;
  approve?: OpenAIRealtimeTranscriptionRollover['approve'];
}

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

function takesClientCommits(model: string): boolean {
  return CLIENT_COMMIT_MODELS.some((name) => model.startsWith(name));
}

function takesLanguageList(model: string): boolean {
  return LANGUAGE_LIST_MODELS.some((name) => model.startsWith(name));
}

/**
 * Maps a BCP-47 tag to the ISO 639-1 code OpenAI takes (`'en-US'` → `'en'`),
 * keeping the regional Chinese codes OpenAI accepts (`'zh-tw'`).
 */
function toTranscriptionLanguage(language: string | undefined): string | undefined {
  const tag = language?.trim().toLowerCase();
  if (!tag) return undefined;
  if (tag.startsWith('zh-')) return tag;
  return tag.split('-')[0];
}

/** The transcription-intent URL: `?intent=transcription`, plus `model` for a host other than OpenAI's. */
function buildTranscriptionUrl(baseUrl: string | undefined, model: string): string {
  const url = new URL(baseUrl ?? DEFAULT_BASE_URL);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol === 'http:') url.protocol = 'ws:';
  url.searchParams.set('intent', 'transcription');
  if (url.hostname !== 'api.openai.com') url.searchParams.set('model', model);
  return url.toString();
}

/** The `session.update` that makes a connection a transcription session. */
function buildSessionUpdate(options: {
  model: string;
  language: string | undefined;
  prompt: string | undefined;
  turnDetection: OpenAIRealtimeTurnDetection | null;
}): Record<string, unknown> {
  const transcription: Record<string, unknown> = { model: options.model };
  if (options.prompt !== undefined) transcription.prompt = options.prompt;
  if (options.language) {
    if (takesLanguageList(options.model)) transcription.languages = [options.language];
    else transcription.language = options.language;
  }
  const turnDetection =
    options.turnDetection === null
      ? null
      : {
          type: 'server_vad',
          threshold: options.turnDetection.threshold ?? 0.5,
          prefix_padding_ms: options.turnDetection.prefixPaddingMs ?? 600,
          silence_duration_ms: options.turnDetection.silenceDurationMs ?? 350,
        };
  return {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: REALTIME_SAMPLE_RATE },
          transcription,
          turn_detection: turnDetection,
        },
      },
    },
  };
}

/**
 * Linear-interpolation resampler for a stream of mono Float32 frames. It keeps
 * its place across frames: output sample `k` lies at input position
 * `k * fromRate / toRate`, counted from the first frame at the current rate,
 * and is produced once the input reaches that position. So the audio it
 * produces stays as long as the audio it was given, at most one input sample
 * behind, however the frames are cut. Rounding each frame's length on its own
 * drifts instead: 128 samples at 44.1 kHz would become 70 at 24 kHz every
 * time where 69.66 are due, 0.49 percent more audio than was pushed.
 */
class StreamResampler {
  /** Rate of the frames so far; a frame at another rate starts the count again. */
  private fromRate = 0;
  /** Input samples taken at the current rate. */
  private consumed = 0;
  /** Output samples produced at the current rate. */
  private produced = 0;
  /** The last sample of the previous frame, for an output that falls between two frames. */
  private previous = 0;

  constructor(private readonly toRate: number) {}

  /**
   * Resamples one frame. Its output's length follows the audio given so far,
   * not the frame alone, so it varies by a sample from frame to frame.
   */
  process(input: Float32Array, fromRate: number): Float32Array {
    if (input.length === 0) return input;
    if (fromRate !== this.fromRate) {
      this.fromRate = fromRate;
      this.consumed = 0;
      this.produced = 0;
    }
    if (fromRate === this.toRate) return input;
    const first = this.consumed;
    const last = first + input.length - 1;
    // Output sample k is due once the input reaches k * fromRate / toRate (whole numbers, so exact).
    const due = Math.floor((last * this.toRate) / fromRate) + 1;
    const output = new Float32Array(Math.max(0, due - this.produced));
    for (let i = 0; i < output.length; i++) {
      const scaled = (this.produced + i) * fromRate;
      const left = Math.floor(scaled / this.toRate);
      const fraction = (scaled - left * this.toRate) / this.toRate;
      const a = left < first ? this.previous : input[left - first];
      const b = fraction === 0 ? a : input[left + 1 - first];
      output[i] = a + (b - a) * fraction;
    }
    this.produced += output.length;
    this.consumed = last + 1;
    this.previous = input[input.length - 1];
    return output;
  }
}

/** Mono Float32 samples at 24 kHz → base64 PCM16 (little-endian). */
function encodePcm16(samples: Float32Array): { base64: string; samples: number } {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return {
    base64: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64'),
    samples: pcm.length,
  };
}

/** A parsed server event; its fields are read through the accessors below. */
interface ServerEvent {
  type: string;
  [field: string]: unknown;
}

function parseServerEvent(data: Buffer | ArrayBuffer | Buffer[] | string): ServerEvent | null {
  let text: string;
  if (typeof data === 'string') text = data;
  else if (Array.isArray(data)) text = Buffer.concat(data).toString('utf-8');
  else if (Buffer.isBuffer(data)) text = data.toString('utf-8');
  else text = Buffer.from(data).toString('utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null; // Malformed JSON: skip it, as the other providers do
  }
  if (!parsed || typeof parsed !== 'object') return null;
  return typeof (parsed as { type?: unknown }).type === 'string' ? (parsed as ServerEvent) : null;
}

function stringField(event: ServerEvent, name: string): string | undefined {
  const value = event[name];
  return typeof value === 'string' ? value : undefined;
}

function numberField(event: ServerEvent, name: string): number | undefined {
  const value = event[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** `type (code): message` of a server `error` event or of a failed item's `error`. */
function describeServerError(event: ServerEvent): string {
  const detail =
    event.error && typeof event.error === 'object' ? (event.error as Record<string, unknown>) : {};
  const kind = typeof detail.type === 'string' ? detail.type : 'error';
  const code = typeof detail.code === 'string' ? ` (${detail.code})` : '';
  const message = typeof detail.message === 'string' ? detail.message : 'no message';
  return `${kind}${code}: ${message}`;
}

/** The first detected language code of a `completed` event, when the model reports one. */
function detectedLanguage(event: ServerEvent): string | undefined {
  const languages = event.languages;
  if (!Array.isArray(languages) || languages.length === 0) return undefined;
  const first = languages[0] as { code?: unknown } | null;
  return first && typeof first.code === 'string' ? first.code : undefined;
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

// ---------------------------------------------------------------------------
// One connection
// ---------------------------------------------------------------------------

/** A frame converted for the wire, placed on the session's audio clock. */
interface EncodedFrame {
  base64: string;
  /** 24 kHz samples in `base64`. */
  samples: number;
  /** Session audio offset where the frame starts, in milliseconds. */
  startMs: number;
  durationMs: number;
}

/** One utterance as one connection reports it, keyed by OpenAI's `item_id`. */
interface ItemState {
  itemId: string;
  /** Interim text so far: the item's deltas, in order. */
  text: string;
  startMs?: number;
  endMs?: number;
  interimSent: boolean;
  finished: boolean;
  /**
   * An older connection received the audio where it begins (decided on the
   * session's audio clock: its onset lies before that connection's audio
   * end): its interims are withheld and its final is checked against the
   * older connection's utterances.
   */
  overlapping: boolean;
  /**
   * Not emitted: began after its connection started draining, repeats an older
   * connection's utterance, or is a speech start whose utterance a commit
   * moved to another item.
   */
  dropped: boolean;
}

/** Where a connection stopped receiving audio, and its utterances: what a newer connection's items are checked against. */
interface ConnectionAudio {
  /** The connection's 1-based index in the session. */
  index: number;
  /** Session audio offset where it stopped receiving audio; `Infinity` while it still receives. */
  feedEndMs: number;
  /** Session audio intervals of the utterances it emits. */
  intervals: Array<{ startMs: number; endMs?: number }>;
}

/** Connecting, open (receiving audio), draining (finishing its items, no audio), closed. */
type ConnectionState = 'connecting' | 'open' | 'draining' | 'closed';

/** One WebSocket to the Realtime API: its lifecycle, the audio sent on it and its items. */
class TranscriptionConnection {
  /** 1-based index in the session, given when the session adopts the connection. */
  index = 0;
  ws: WebSocket | null = null;
  state: ConnectionState = 'connecting';
  /** `Date.now()` when the server confirmed the session update. */
  readyAt = 0;
  /** Where this connection's rollover age counts from: its own `readyAt`, or that of the dropped connection it replaces. */
  ageStartAt = 0;
  /** Session audio offset of the first frame sent on this connection. */
  baseMs: number | undefined;
  /** 24 kHz samples sent on this connection. */
  samplesSent = 0;
  /** Samples sent since the last commit. */
  samplesSinceCommit = 0;
  /** Session audio offset of the first frame sent after the last commit. */
  uncommittedFromMs: number | undefined;
  /** Commits this side sent whose `committed` has not arrived, oldest first. */
  readonly commits: Array<{ eventId: string; startMs: number; endMs: number }> = [];
  /** The server reported speech that has not stopped. */
  speaking = false;
  /**
   * The item the speech in progress will become (its `speech_started` named
   * it), until the speech stops or a commit of this side moves the utterance
   * to the committed item.
   */
  vadItemId: string | undefined;
  readonly items = new Map<string, ItemState>();
  /** Items started or committed whose transcription has not completed or failed. */
  readonly pending = new Set<string>();
  /** Session audio intervals of the utterances this connection emits, for the rollover's duplicate check. */
  readonly intervals = new Map<string, { startMs: number; endMs?: number }>();
  /** Drain once the overlap has passed and no speech is in progress. */
  drainWhenQuiet = false;
  /** The rollover from this connection was refused or failed: the session ends at its hard stop. */
  rolloverRefused = false;
  /** Why the next connection could not open; the session ends with it at the hard stop. */
  rolloverFailure: Error | undefined;
  /** Session audio offset where this connection stopped receiving audio. */
  feedEndMs: number | undefined;
  readonly timers: Array<ReturnType<typeof setTimeout>> = [];
  private lastError: Error | undefined;
  private commitCount = 0;
  private readonly idleWaiters = new Set<() => void>();
  /** Fails the connect in progress; set from the connect timer's start until the connect resolves or fails. */
  private abortConnect: ((err: Error) => void) | undefined;

  constructor(
    private readonly settings: SessionSettings,
    private readonly handlers: {
      onEvent: (connection: TranscriptionConnection, event: ServerEvent) => void;
      onDrop: (connection: TranscriptionConnection, reason: Error) => void;
    }
  ) {}

  /**
   * Opens the socket, sends the session update and resolves once the server
   * confirms it. Rejects on a refused upgrade (with the HTTP status and body),
   * on a server `error` before the confirmation, on an early close, after
   * `connectTimeoutMs`, and when {@link close} abandons it.
   */
  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let ready = false;
      let settled = false;
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        this.abortConnect = undefined;
        clearTimeout(timer);
        this.state = 'closed';
        const ws = this.ws;
        this.ws = null;
        try {
          ws?.terminate();
        } catch {
          // The upgrade never completed; there is nothing to release.
        }
        reject(err);
      };
      const timer = setTimeout(() => {
        fail(
          new Error(`openai realtime transcription connect timed out after ${this.settings.connectTimeoutMs}ms`)
        );
      }, this.settings.connectTimeoutMs);
      this.abortConnect = fail;

      let ws: WebSocket;
      try {
        ws = new WebSocket(this.settings.url, { headers: this.settings.headers });
      } catch (err) {
        fail(toError(err));
        return;
      }
      this.ws = ws;

      ws.on('unexpected-response', (_req, res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf-8');
        });
        res.on('end', () => {
          fail(
            new Error(
              `openai realtime transcription ws rejected: HTTP ${res.statusCode}${body ? ` - ${body.slice(0, 300)}` : ''}`
            )
          );
        });
      });

      ws.on('open', () => {
        ws.send(JSON.stringify(this.settings.sessionUpdate));
      });

      ws.on('message', (data: Buffer | ArrayBuffer | Buffer[] | string) => {
        const event = parseServerEvent(data);
        if (!event) return;
        if (!ready) {
          if (event.type === 'session.updated') {
            ready = true;
            settled = true;
            this.abortConnect = undefined;
            clearTimeout(timer);
            this.state = 'open';
            this.readyAt = Date.now();
            if (this.ageStartAt === 0) this.ageStartAt = this.readyAt;
            resolve();
          } else if (event.type === 'error') {
            fail(
              new Error(`openai realtime transcription session update refused: ${describeServerError(event)}`)
            );
          }
          return;
        }
        this.handlers.onEvent(this, event);
      });

      ws.on('error', (err: Error) => {
        if (!ready) fail(err);
        else this.lastError = err;
      });

      ws.on('close', (code: number) => {
        if (!ready) {
          fail(new Error(`openai realtime transcription ws closed before the session was ready (${code})`));
          return;
        }
        if (this.state === 'closed') return; // closed by this side
        this.release();
        this.handlers.onDrop(
          this,
          this.lastError ?? new Error(`openai realtime transcription ws closed unexpectedly (${code})`)
        );
      });
    });
  }

  /** Sends a client event when the socket is open. */
  send(event: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  }

  /** Appends one encoded frame to this connection's input buffer. */
  sendAudio(frame: EncodedFrame): void {
    if (this.baseMs === undefined) this.baseMs = frame.startMs;
    if (this.uncommittedFromMs === undefined) this.uncommittedFromMs = frame.startMs;
    this.send({ type: 'input_audio_buffer.append', audio: frame.base64 });
    this.samplesSent += frame.samples;
    this.samplesSinceCommit += frame.samples;
  }

  /**
   * Commits the input buffer when audio was appended since the last commit
   * (OpenAI refuses to commit an empty buffer). `endMs` is the session audio
   * offset the buffer reaches.
   */
  commit(endMs: number): boolean {
    if (this.samplesSinceCommit === 0) return false;
    this.commitCount += 1;
    const eventId = `commit_${this.index}_${this.commitCount}`;
    this.commits.push({ eventId, startMs: this.uncommittedFromMs ?? endMs, endMs });
    this.send({ type: 'input_audio_buffer.commit', event_id: eventId });
    this.samplesSinceCommit = 0;
    this.uncommittedFromMs = undefined;
    return true;
  }

  /** No item is waiting for its transcription and no commit is waiting for `committed`. */
  get idle(): boolean {
    return this.pending.size === 0 && this.commits.length === 0;
  }

  /** Resolves when the connection is idle or closed, or after `timeoutMs`. */
  waitIdle(timeoutMs: number): Promise<void> {
    if (this.idle || this.state === 'closed') return Promise.resolve();
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.idleWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.idleWaiters.add(finish);
    });
  }

  /** Wakes the waiters of {@link waitIdle} once the connection is idle or closed. */
  settleIdle(): void {
    if (!this.idle && this.state !== 'closed') return;
    for (const finish of [...this.idleWaiters]) finish();
  }

  /** Closes the socket from this side, or abandons a connect still in progress. Idempotent. */
  close(): void {
    if (this.abortConnect) {
      this.abortConnect(new Error('openai realtime transcription connect abandoned: the session closed'));
      return;
    }
    if (this.state === 'closed') return;
    const ws = this.ws;
    this.release();
    if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000, 'session closed');
  }

  /** Marks the connection closed, stops its timers and wakes its waiters. */
  private release(): void {
    this.state = 'closed';
    this.ws = null;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.length = 0;
    this.settleIdle();
  }
}

/**
 * What a connection opened to replace a dropped one takes over from it: the
 * age its rollover counts from, and the outcome of that rollover, so a refused
 * or failed rollover still ends the session at the hard stop and the host is
 * not asked again.
 */
interface RolloverClocks {
  /** Where the dropped connection's age counted from. */
  ageStartAt: number;
  /** Its rollover was refused or failed: no new approval, and the session ends at the hard stop. */
  rolloverRefused: boolean;
  /** Why its next connection could not open; the session ends with it at the hard stop. */
  rolloverFailure: Error | undefined;
}

/** A connection's rollover clocks, for the connection that replaces it. */
function rolloverClocks(connection: TranscriptionConnection): RolloverClocks {
  return {
    ageStartAt: connection.ageStartAt,
    rolloverRefused: connection.rolloverRefused,
    rolloverFailure: connection.rolloverFailure,
  };
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/**
 * A live transcription session. Emits `transcript`, `speech_start`,
 * `speech_end`, `usage`, `warning`, `error` and `close`.
 */
class OpenAIRealtimeTranscriptionSession extends EventEmitter implements StreamingSTTSession {
  /** Connections still open or draining, oldest first. */
  private connections: TranscriptionConnection[] = [];
  private openedConnections = 0;
  private closed = false;
  /** Milliseconds of audio pushed into the session so far. */
  private sessionAudioMs = 0;
  /** Brings every frame to 24 kHz; one for the session, so its place carries from frame to frame. */
  private readonly resampler = new StreamResampler(REALTIME_SAMPLE_RATE);
  /** Frames held while no connection receives audio. */
  private backlog: EncodedFrame[] = [];
  private backlogMs = 0;
  /** Consecutive connection failures since the last final or long-lived connection. */
  private failures = 0;
  private reconnecting = false;
  private rolloverInProgress = false;
  /** The last connection is draining and the session closes after it: a drop starts no reconnect. */
  private ending = false;
  /** A client commit asked for while no connection was open; sent once one opens. */
  private commitOnAdopt = false;
  /** Waiters of {@link waitAdopted}: a flush that found no connection taking audio. */
  private adoptWaiters = new Set<() => void>();
  /** Connections still connecting (a reconnect's, or a rollover's next one): `close()` abandons them. */
  private readonly connecting = new Set<TranscriptionConnection>();
  /** Ends of the waits before a retry: `close()` calls them. */
  private readonly retryWaits = new Set<() => void>();
  private speaking = false;
  /** The connection that closed last: where its audio ended and its utterances, for the duplicate check. */
  private retired: ConnectionAudio | undefined;
  private usageTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly settings: SessionSettings) {
    super();
  }

  /** Opens the first connection. Rejects when it cannot open; there is no retry here, so a chain can fall back. */
  async start(): Promise<void> {
    const connection = this.createConnection();
    await connection.connect();
    this.adopt(connection);
  }

  /**
   * Converts the frame to base64 PCM16 at 24 kHz and appends it to every open
   * connection (two during a rollover's overlap), or holds it while none is open.
   */
  pushAudio(frame: AudioFrame): void {
    if (this.closed || frame.samples.length === 0 || !(frame.sampleRate > 0)) return;
    const startMs = this.sessionAudioMs;
    const durationMs = (frame.samples.length / frame.sampleRate) * 1000;
    this.sessionAudioMs += durationMs;
    const resampled = this.resampler.process(frame.samples, frame.sampleRate);
    // A very short frame may complete no 24 kHz sample yet; the next frame carries its audio.
    if (resampled.length === 0) return;
    const encoded: EncodedFrame = { ...encodePcm16(resampled), startMs, durationMs };
    const receivers = this.connections.filter((connection) => connection.state === 'open');
    if (receivers.length === 0) {
      this.hold(encoded);
      return;
    }
    for (const connection of receivers) connection.sendAudio(encoded);
  }

  /**
   * Ends the current turn: commits the buffer when turn detection is off (or
   * when speech is in progress under server turn detection), then resolves
   * once every committed item's final has arrived, or after `finalTimeoutMs`.
   * During a reconnect it first waits for the connection that takes over.
   * The session stays open: at its end, flush before `close()` so the last
   * turn gets its final. Under server turn detection, speech is in progress
   * once the server has reported its start, so an utterance that began within
   * the voice detector's reporting latency before the call is not committed,
   * and a `close()` right after discards it.
   */
  async flush(): Promise<void> {
    if (this.closed) return;
    const lead = this.lead();
    if (!lead) {
      // No connection takes audio now (a reconnect): commit once one opens, and wait for it.
      if (this.settings.clientCommits) this.commitOnAdopt = true;
      await this.waitAdopted(this.settings.finalTimeoutMs);
      if (this.closed) return;
    } else if (this.settings.clientCommits || lead.speaking) {
      lead.commit(this.sessionAudioMs);
    }
    await Promise.all(
      this.connections.map((connection) => connection.waitIdle(this.settings.finalTimeoutMs))
    );
  }

  /** Resolves when a connection is adopted or the session closes, or after `timeoutMs`. */
  private waitAdopted(timeoutMs: number): Promise<void> {
    if (this.lead() || this.closed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.adoptWaiters.delete(finish);
        this.off('close', finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.adoptWaiters.add(finish);
      this.once('close', finish);
    });
  }

  /**
   * Closes every connection at once, abandons one still connecting, ends a
   * wait before a retry, and emits `'close'`. Idempotent.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.usageTimer) clearInterval(this.usageTimer);
    this.usageTimer = undefined;
    const open = this.connections;
    this.connections = [];
    for (const connection of open) connection.close();
    // Closing a connection still connecting abandons its connect: its socket is terminated, its timer cleared.
    for (const connection of [...this.connecting]) connection.close();
    this.connecting.clear();
    for (const finish of [...this.retryWaits]) finish();
    this.backlog = [];
    this.backlogMs = 0;
    this.emit('close');
  }

  // -------------------------------------------------------------------------
  // Connections
  // -------------------------------------------------------------------------

  private createConnection(): TranscriptionConnection {
    return new TranscriptionConnection(this.settings, {
      onEvent: (connection, event) => this.handleServerEvent(connection, event),
      onDrop: (connection, reason) => this.handleDrop(connection, reason),
    });
  }

  /**
   * Makes an opened connection part of the session; it receives audio from now on. A replacement for a dropped
   * connection takes over its rollover clocks.
   */
  private adopt(connection: TranscriptionConnection, clocks?: RolloverClocks): void {
    this.openedConnections += 1;
    connection.index = this.openedConnections;
    if (clocks) {
      connection.ageStartAt = clocks.ageStartAt;
      connection.rolloverRefused = clocks.rolloverRefused;
      connection.rolloverFailure = clocks.rolloverFailure;
    }
    this.connections.push(connection);
    this.releaseBacklog(connection);
    for (const finish of [...this.adoptWaiters]) finish();
  }

  /** Sends the held frames to a connection that takes audio, then the commit a flush asked for meanwhile. */
  private releaseBacklog(connection: TranscriptionConnection): void {
    const held = this.backlog;
    this.backlog = [];
    this.backlogMs = 0;
    for (const frame of held) connection.sendAudio(frame);
    if (this.commitOnAdopt) {
      this.commitOnAdopt = false;
      connection.commit(this.sessionAudioMs);
    }
  }

  /** The oldest connection still receiving audio: its speech events drive `speech_start` and `speech_end`. */
  private lead(): TranscriptionConnection | undefined {
    return this.connections.find((connection) => connection.state === 'open');
  }

  private hold(frame: EncodedFrame): void {
    this.backlog.push(frame);
    this.backlogMs += frame.durationMs;
    while (this.backlogMs > this.settings.maxBufferedMs && this.backlog.length > 1) {
      const dropped = this.backlog.shift();
      if (!dropped) break;
      this.backlogMs -= dropped.durationMs;
    }
  }

  /** A connection dropped: retire it, and reconnect when no other connection receives audio. */
  private handleDrop(connection: TranscriptionConnection, reason: Error): void {
    if (this.closed) return;
    if (Date.now() - connection.readyAt > this.settings.connectTimeoutMs) this.failures = 0;
    this.retire(connection, true);
    if (this.lead() || this.reconnecting || this.ending || this.rolloverInProgress) return;
    this.reconnect(reason, rolloverClocks(connection));
  }

  /**
   * Opens a replacement connection by the retry rules and adopts it with the dropped connection's rollover clocks,
   * so the rollover (and the host's approval) comes at the same time as without the drop, and a refused or failed
   * rollover stays refused or failed; a failure beyond the retries ends the session.
   */
  private reconnect(reason: Error, clocks: RolloverClocks): void {
    this.reconnecting = true;
    this.openConnection(reason)
      .then((next) => {
        this.reconnecting = false;
        if (next) this.adopt(next, clocks);
      })
      .catch((err: unknown) => {
        this.reconnecting = false;
        this.fail(toError(err));
      });
  }

  /** Ends the session after a failure it cannot recover from: `'error'`, then `'close'`. */
  private fail(err: Error): void {
    if (this.closed) return;
    this.emitErrorSafe(err);
    this.close();
  }

  /**
   * Opens a connection, retrying by the retry rules. With `firstError` (a
   * drop), the first attempt waits too. A connection still connecting is in
   * {@link connecting}, and a wait before a retry in {@link retryWaits}, so
   * `close()` ends both at once. Resolves `undefined` when the session closed
   * meanwhile; rejects with the error that ended the retries.
   */
  private async openConnection(firstError?: Error): Promise<TranscriptionConnection | undefined> {
    let lastError = firstError;
    for (;;) {
      if (this.closed) return undefined;
      if (lastError) {
        const classified = VoicePipelineError.classifyError(lastError, {
          kind: 'stt',
          provider: this.settings.providerId,
        });
        if (!classified.retryable || this.failures >= this.settings.maxRetries) {
          throw new VoicePipelineError({
            kind: 'stt',
            provider: this.settings.providerId,
            errorClass: classified.errorClass,
            message: `openai realtime transcription gave up after ${this.failures} ${this.failures === 1 ? 'retry' : 'retries'}: ${classified.message}`,
            cause: lastError,
            retryable: false,
          });
        }
        const delay = this.failures === 0 ? FIRST_RETRY_DELAY_MS : this.settings.retryIntervalMs;
        this.failures += 1;
        await this.waitRetry(delay);
        if (this.closed) return undefined;
      }
      const connection = this.createConnection();
      this.connecting.add(connection);
      try {
        await connection.connect();
      } catch (err) {
        lastError = toError(err);
        continue;
      } finally {
        this.connecting.delete(connection);
      }
      if (this.closed) {
        connection.close();
        return undefined;
      }
      return connection;
    }
  }

  /** Waits `ms` before a retry; `close()` ends the wait at once and clears its timer. */
  private waitRetry(ms: number): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.retryWaits.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.retryWaits.add(finish);
    });
  }

  /**
   * Takes a connection out of the session and closes it. With `retract`, an
   * item that sent interim text but will get no final gets an empty final, so
   * a consumer keyed by `itemId` drops the interim.
   */
  private retire(connection: TranscriptionConnection, retract: boolean): void {
    if (!this.connections.includes(connection)) return;
    this.connections = this.connections.filter((other) => other !== connection);
    if (connection.feedEndMs === undefined) connection.feedEndMs = this.sessionAudioMs;
    connection.close();
    for (const item of connection.items.values()) {
      if (item.finished || item.dropped) continue;
      connection.intervals.delete(item.itemId);
      if (retract && item.interimSent) this.emit('transcript', this.transcriptEvent(item, '', true));
    }
    this.setSpeaking(this.lead()?.speaking ?? false);
  }

  // -------------------------------------------------------------------------
  // Server events
  // -------------------------------------------------------------------------

  private handleServerEvent(connection: TranscriptionConnection, event: ServerEvent): void {
    if (this.closed || connection.state === 'closed') return;
    switch (event.type) {
      case 'input_audio_buffer.speech_started':
        this.onSpeechStarted(connection, event);
        break;
      case 'input_audio_buffer.speech_stopped':
        this.onSpeechStopped(connection, event);
        break;
      case 'input_audio_buffer.committed':
        this.onCommitted(connection, event);
        break;
      case 'conversation.item.input_audio_transcription.delta':
        this.onDelta(connection, event);
        break;
      case 'conversation.item.input_audio_transcription.completed':
        this.onCompleted(connection, event);
        break;
      case 'conversation.item.input_audio_transcription.failed':
        this.onFailed(connection, event);
        break;
      case 'error':
        this.onServerError(connection, event);
        break;
      default:
        // session.updated, conversation.item.* and the like carry nothing this session maps.
        break;
    }
  }

  /** A server `error`: the session stays open (most Realtime errors are recoverable). */
  private onServerError(connection: TranscriptionConnection, event: ServerEvent): void {
    const detail =
      event.error && typeof event.error === 'object' ? (event.error as Record<string, unknown>) : {};
    const at = connection.commits.findIndex((commit) => commit.eventId === detail.event_id);
    if (at >= 0) {
      // A commit this side sent was refused (for example an empty buffer): no item follows it.
      connection.commits.splice(at, 1);
      connection.settleIdle();
    }
    this.emitWarning(new Error(`openai realtime transcription server error: ${describeServerError(event)}`));
  }

  /** The item an event names, created on first sight. */
  private item(connection: TranscriptionConnection, itemId: string): ItemState {
    let item = connection.items.get(itemId);
    if (!item) {
      item = {
        itemId,
        text: '',
        interimSent: false,
        finished: false,
        // Decided again on the audio clock once the item's start is known.
        overlapping: this.heardByOlder(connection, undefined),
        dropped: false,
      };
      connection.items.set(itemId, item);
    }
    return item;
  }

  /**
   * Whether a connection older than this one (a lower index) received the
   * audio where an item of this one begins, so both may transcribe it.
   * Decided on the session's audio clock, not by which connections are open
   * when the item's first event arrives: the onset (the start plus the prefix
   * padding) lies before the older connection's audio end, for those still
   * open or draining and for the one retired last. With no start yet, an
   * older connection still in the session counts. Only server turn detection
   * overlaps connections; client commits hand over at a turn boundary.
   */
  private heardByOlder(connection: TranscriptionConnection, startMs: number | undefined): boolean {
    if (this.settings.clientCommits) return false;
    if (startMs === undefined) return this.connections.some((other) => other.index < connection.index);
    const onsetMs = startMs + this.settings.prefixPaddingMs;
    return this.olderConnections(connection).some((older) => onsetMs < older.feedEndMs);
  }

  /**
   * The connections older than this one (a lower index): those still open or
   * draining, with `Infinity` as the audio end of one still receiving audio,
   * and the one retired last.
   */
  private olderConnections(connection: TranscriptionConnection): ConnectionAudio[] {
    const olders: ConnectionAudio[] = [];
    if (this.retired && this.retired.index < connection.index) olders.push(this.retired);
    for (const other of this.connections) {
      if (other.index < connection.index) {
        olders.push({
          index: other.index,
          feedEndMs: other.feedEndMs ?? Infinity,
          intervals: [...other.intervals.values()],
        });
      }
    }
    return olders;
  }

  /** Session audio offset of a connection-relative offset from the server. */
  private toSessionMs(connection: TranscriptionConnection, offsetMs: number | undefined): number | undefined {
    if (offsetMs === undefined) return undefined;
    return (connection.baseMs ?? this.sessionAudioMs) + offsetMs;
  }

  private onSpeechStarted(connection: TranscriptionConnection, event: ServerEvent): void {
    const itemId = stringField(event, 'item_id');
    if (itemId) {
      const item = this.item(connection, itemId);
      connection.vadItemId = itemId;
      // Speech heard after a connection began draining belongs to the next connection.
      if (connection.state === 'draining') item.dropped = true;
      item.startMs = this.toSessionMs(connection, numberField(event, 'audio_start_ms'));
      item.overlapping = this.heardByOlder(connection, item.startMs);
      if (!item.dropped) {
        connection.pending.add(itemId);
        if (item.startMs !== undefined) connection.intervals.set(itemId, { startMs: item.startMs });
      }
    }
    if (connection.state !== 'open') return;
    connection.speaking = true;
    if (this.lead() === connection) this.setSpeaking(true);
  }

  private onSpeechStopped(connection: TranscriptionConnection, event: ServerEvent): void {
    const itemId = stringField(event, 'item_id');
    // The speech has stopped: a later commit of this side moves no utterance.
    connection.vadItemId = undefined;
    if (itemId) {
      const item = this.item(connection, itemId);
      item.endMs = this.toSessionMs(connection, numberField(event, 'audio_end_ms'));
      const interval = connection.intervals.get(itemId);
      if (interval) interval.endMs = item.endMs;
    }
    if (connection.state !== 'open') return;
    connection.speaking = false;
    if (this.lead() === connection) this.setSpeaking(false);
  }

  private onCommitted(connection: TranscriptionConnection, event: ServerEvent): void {
    const itemId = stringField(event, 'item_id');
    const known = itemId ? connection.items.get(itemId) : undefined;
    // Server turn detection commits on its own after speech_stopped; any other
    // `committed` answers this side's oldest commit.
    const ours = known?.endMs === undefined ? connection.commits.shift() : undefined;
    if (itemId) {
      const item = this.item(connection, itemId);
      if (ours) {
        // A commit during speech can name another item than speech_started did: the utterance moves here.
        this.moveSpeechItem(connection, item);
        if (item.startMs === undefined) {
          item.startMs = ours.startMs;
          item.overlapping = this.heardByOlder(connection, item.startMs);
        }
        if (item.endMs === undefined) item.endMs = ours.endMs;
        if (connection.speaking) {
          connection.speaking = false;
          if (this.lead() === connection) this.setSpeaking(false);
        }
      }
      if (!item.dropped && !item.finished) {
        connection.pending.add(itemId);
        if (item.startMs !== undefined) {
          connection.intervals.set(itemId, { startMs: item.startMs, endMs: item.endMs });
        }
      }
    }
    connection.settleIdle();
  }

  /**
   * A commit of this side during speech can give the utterance another id
   * than its `speech_started` named ("unless the client manually commits the
   * audio buffer during VAD activation"). The utterance moves to the
   * committed item, which keeps the start the speech began at; the item
   * `speech_started` named is finished and dropped, so no flush or drain
   * waits for its final and its open interval leaves the duplicate check.
   */
  private moveSpeechItem(connection: TranscriptionConnection, committed: ItemState): void {
    const startedId = connection.vadItemId;
    connection.vadItemId = undefined;
    if (startedId === undefined || startedId === committed.itemId) return;
    const started = connection.items.get(startedId);
    if (!started || started.finished) return;
    if (committed.startMs === undefined && started.startMs !== undefined) {
      committed.startMs = started.startMs;
      committed.overlapping = started.overlapping;
    }
    started.finished = true;
    started.dropped = true;
    connection.pending.delete(startedId);
    connection.intervals.delete(startedId);
  }

  private onDelta(connection: TranscriptionConnection, event: ServerEvent): void {
    const itemId = stringField(event, 'item_id');
    const delta = stringField(event, 'delta');
    if (!itemId || !delta) return;
    const item = this.item(connection, itemId);
    if (item.dropped || item.finished) return;
    item.text += delta;
    if (item.overlapping || !this.settings.interimResults) return;
    item.interimSent = true;
    this.emit('transcript', this.transcriptEvent(item, item.text, false));
  }

  private onCompleted(connection: TranscriptionConnection, event: ServerEvent): void {
    const itemId = stringField(event, 'item_id');
    if (!itemId) return;
    const item = this.item(connection, itemId);
    // A recognised utterance resets the consecutive failure count.
    this.failures = 0;
    this.finishItem(connection, item);
    if (item.dropped) return;
    const transcript = stringField(event, 'transcript') ?? '';
    if (!transcript && !item.interimSent) return;
    this.emit('transcript', this.transcriptEvent(item, transcript, true, detectedLanguage(event)));
  }

  private onFailed(connection: TranscriptionConnection, event: ServerEvent): void {
    const itemId = stringField(event, 'item_id');
    if (!itemId) return;
    const item = this.item(connection, itemId);
    this.finishItem(connection, item);
    connection.intervals.delete(itemId);
    if (item.dropped) return;
    this.emitWarning(
      new Error(`openai realtime transcription failed for item ${itemId}: ${describeServerError(event)}`)
    );
    if (item.interimSent) this.emit('transcript', this.transcriptEvent(item, '', true));
  }

  private finishItem(connection: TranscriptionConnection, item: ItemState): void {
    item.finished = true;
    connection.pending.delete(item.itemId);
    connection.settleIdle();
  }

  private transcriptEvent(
    item: ItemState,
    text: string,
    isFinal: boolean,
    detected?: string
  ): TranscriptEvent {
    const event: TranscriptEvent = { text, confidence: 1, words: [], isFinal, itemId: item.itemId };
    if (item.startMs !== undefined) event.startMs = Math.round(item.startMs);
    if (item.endMs !== undefined) event.endMs = Math.round(item.endMs);
    if (isFinal && item.startMs !== undefined && item.endMs !== undefined) {
      event.durationMs = Math.max(0, Math.round(item.endMs - item.startMs));
    }
    const language = detected ?? this.settings.language;
    if (language) event.language = language;
    return event;
  }

  private setSpeaking(speaking: boolean): void {
    if (this.speaking === speaking) return;
    this.speaking = speaking;
    this.emit(speaking ? 'speech_start' : 'speech_end');
  }

  // -------------------------------------------------------------------------
  // Errors
  // -------------------------------------------------------------------------

  /**
   * Emit `'error'` only when a listener exists: an unlistened EventEmitter
   * `'error'` throws and takes the whole process down.
   */
  private emitErrorSafe(err: Error): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', err);
    } else {
      console.warn(`[${this.settings.providerId}] session error (no listener attached):`, err.message);
    }
  }

  private emitWarning(err: Error): void {
    const warning = VoicePipelineError.classifyError(err, {
      kind: 'stt',
      provider: this.settings.providerId,
    });
    if (this.listenerCount('warning') > 0) {
      this.emit('warning', warning);
    } else {
      console.warn(`[${this.settings.providerId}] ${warning.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Provider (Factory)
// ---------------------------------------------------------------------------

function resolveSettings(
  providerId: string,
  config: OpenAIRealtimeTranscriptionSTTConfig,
  sessionConfig: StreamingSTTConfig
): SessionSettings {
  const model = config.model ?? DEFAULT_MODEL;
  const options = sessionConfig.providerOptions ?? {};
  const prompt = typeof options.prompt === 'string' ? options.prompt : config.prompt;
  const safetyIdentifier =
    typeof options.safetyIdentifier === 'string' ? options.safetyIdentifier : config.safetyIdentifier;
  const language = toTranscriptionLanguage(sessionConfig.language);
  const turnDetection =
    config.turnDetection !== undefined ? config.turnDetection : takesClientCommits(model) ? null : {};
  const headers: Record<string, string> = { Authorization: `Bearer ${config.apiKey}` };
  if (safetyIdentifier) headers['OpenAI-Safety-Identifier'] = safetyIdentifier;
  const rollover = config.rollover === false ? undefined : (config.rollover ?? {});
  return {
    providerId,
    model,
    url: buildTranscriptionUrl(config.baseUrl, model),
    headers,
    sessionUpdate: buildSessionUpdate({ model, language, prompt, turnDetection }),
    clientCommits: turnDetection === null,
    prefixPaddingMs: turnDetection?.prefixPaddingMs ?? 600,
    language,
    interimResults: sessionConfig.interimResults !== false,
    connectTimeoutMs: config.connectTimeoutMs ?? 10_000,
    maxRetries: config.maxRetries ?? 3,
    retryIntervalMs: config.retryIntervalMs ?? 2_000,
    maxBufferedMs: config.maxBufferedMs ?? 10_000,
    finalTimeoutMs: config.finalTimeoutMs ?? 5_000,
    usageIntervalMs: config.usageIntervalMs ?? 0,
    rollover: rollover
      ? {
          afterMs: rollover.afterMs ?? 55 * MINUTE_MS,
          deadlineMs: rollover.deadlineMs ?? 58 * MINUTE_MS,
          overlapMs: rollover.overlapMs ?? 3_000,
          hardStopMs: rollover.hardStopMs ?? 59.5 * MINUTE_MS,
          matchToleranceMs: rollover.matchToleranceMs ?? 500,
          approve: rollover.approve,
        }
      : null,
  };
}

/**
 * Streaming STT provider for OpenAI's Realtime transcription sessions.
 * Implements {@link IStreamingSTT} for use with {@link VoicePipelineOrchestrator}
 * and {@link StreamingSTTChain}.
 *
 * @example
 * ```typescript
 * const stt = new OpenAIRealtimeTranscriptionSTT({
 *   apiKey: process.env.OPENAI_API_KEY!,
 *   model: 'gpt-4o-mini-transcribe',
 *   usageIntervalMs: 15_000,
 * });
 * const session = await stt.startSession({ language: 'en-US' });
 * session.on('transcript', (event) => console.log(event.itemId, event.isFinal, event.text));
 * session.on('usage', (usage) => console.log(usage.connectionIndex, usage.audioSeconds));
 * ```
 */
export class OpenAIRealtimeTranscriptionSTT implements IStreamingSTT, HealthyProvider {
  readonly providerId = 'openai-realtime-transcription';
  readonly isStreaming = true;
  readonly priority: number;
  readonly capabilities: ProviderCapabilities;
  private readonly keyPool: ApiKeyPool;
  private readonly healthProbe: NonNullable<OpenAIRealtimeTranscriptionSTTConfig['healthProbe']>;

  constructor(private readonly config: OpenAIRealtimeTranscriptionSTTConfig) {
    this.keyPool = new ApiKeyPool(config.apiKey);
    this.priority = config.priority ?? 15;
    this.capabilities = defaultCapabilities({
      languages: ['*'],
      streaming: true,
      costTier: 'standard',
      latencyClass: 'realtime',
      ...(config.capabilities ?? {}),
    });
    this.healthProbe = config.healthProbe ?? defaultOpenAIProbe;
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
        kind: 'stt',
        provider: this.providerId,
      });
      return {
        ok: false,
        latencyMs: res.latencyMs,
        error: { class: classified.errorClass, message: `HTTP ${res.status}` },
      };
    } catch (err) {
      const classified = VoicePipelineError.classifyError(err, { kind: 'stt', provider: this.providerId });
      return { ok: false, error: { class: classified.errorClass, message: classified.message } };
    }
  }

  /**
   * Opens a transcription session on a fresh key from the pool. Resolves once
   * OpenAI has confirmed the session update; rejects (with no retry) when the
   * first connection cannot open, so a {@link StreamingSTTChain} falls back.
   */
  async startSession(config?: StreamingSTTConfig): Promise<StreamingSTTSession> {
    const settings = resolveSettings(
      this.providerId,
      { ...this.config, apiKey: this.keyPool.next() },
      config ?? {}
    );
    const session = new OpenAIRealtimeTranscriptionSession(settings);
    await session.start();
    return session;
  }
}
