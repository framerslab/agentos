/**
 * @module voice-pipeline/providers/HumeStreamingTTS
 *
 * Streaming text-to-speech via Hume's Octave WSS input-streaming API.
 * Implements {@link IStreamingTTS} for realtime token-in / audio-out
 * synthesis.
 *
 * Contract notes (pinned from the vendor reference 2026-07-08):
 * - Endpoint: `wss://api.hume.ai/v0/tts/stream/input?api_key=…`. This is the
 *   TRUE incremental-input surface — `POST /v0/tts/stream/json` only streams
 *   OUTPUT for a complete request and is deliberately not used here.
 * - `no_binary=true` keeps every server frame a JSON `TtsOutput` message
 *   (base64 `audio`, `audio_format`, `chunk_index`, …) — no binary frames to
 *   special-case.
 * - `instant_mode` requires an explicit voice; it is enabled exactly when a
 *   voice is configured and disabled otherwise (voice-less sessions
 *   auto-generate a voice from the description, which instant mode forbids).
 * - Client publishes `InputMessage` JSON: `{ text }` per token batch,
 *   `{ flush: true }` to force generation of buffered text, `{ close: true }`
 *   to finish and close. Acting directions (`description`) and the voice ride
 *   the FIRST publish; Hume persists them for subsequent utterances until
 *   overridden.
 * - There is no vendor cancel: `cancel()` is a local hard-stop — drop all
 *   further inbound chunks and close the socket.
 */

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
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
import type { HumeVoiceRef } from './HumeBatchTTS.js';

/** Configuration for the Hume streaming TTS provider. */
export interface HumeStreamingTTSConfig {
  /** Hume API key. */
  apiKey: string;
  /** Default voice. Optional — voice-less sessions run without instant mode
   *  and let Octave derive a voice from the acting description. */
  voice?: HumeVoiceRef;
  /** WebSocket endpoint. @default 'wss://api.hume.ai/v0/tts/stream/input' */
  wsUrl?: string;
  /** Chain priority. Lower values are tried first. @default 14 */
  priority?: number;
  /** Optional capability overrides. */
  capabilities?: Partial<ProviderCapabilities>;
}

/** Normalize a voice reference into Hume's `{id|name, provider}` shape. */
function toHumeVoice(
  voice: string | HumeVoiceRef | undefined
): Record<string, unknown> | undefined {
  if (voice == null) return undefined;
  if (typeof voice === 'string') return { name: voice, provider: 'HUME_AI' };
  const out: Record<string, unknown> = { provider: voice.provider ?? 'HUME_AI' };
  if (voice.id) out.id = voice.id;
  else if (voice.name) out.name = voice.name;
  else return undefined;
  return out;
}

/**
 * One live Hume input-streaming session. First publish carries the sticky
 * session attributes (voice, description); later publishes are bare text.
 */
class HumeStreamingTTSSession extends EventEmitter implements StreamingTTSSession {
  /** Exposed for tests (mirrors the sibling sessions' introspection seam). */
  private ws: WebSocket | null = null;

  /** Attributes that ride the first publish only. */
  private firstPublishDone = false;

  /** Local hard-cancel latch: drop every inbound frame once set. */
  private cancelled = false;

  private closed = false;

  private flushResolvers: Array<() => void> = [];

  /** Tokens pushed since the last flush boundary — stamped on each chunk so
   *  barge-in handlers can report the interrupted remainder. */
  private accumulatedText = '';

  constructor(
    private readonly opts: {
      url: string;
      voice?: Record<string, unknown>;
      description?: string;
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
        if (this.closed || this.cancelled) return;
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
    if (this.cancelled) return; // hard-cancel: late frames drop silently
    let msg: { audio?: string; audio_format?: string; type?: string };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return; // binary frames are disabled via no_binary=true
    }
    if (typeof msg.audio === 'string' && msg.audio.length > 0) {
      const audio = Buffer.from(msg.audio, 'base64');
      const format: EncodedAudioChunk['format'] =
        msg.audio_format === 'pcm' ? 'pcm' : 'mp3';
      const chunk: EncodedAudioChunk = {
        audio,
        format,
        sampleRate: format === 'pcm' ? 48000 : 44100,
        durationMs: Math.max(1, Math.round((audio.byteLength / 16_000) * 1000)),
        text: this.accumulatedText,
      };
      this.emit('audio', chunk);
      return;
    }
    // Any explicit flush/finish boundary resolves pending flush() callers.
    if (msg.type === 'flushed' || msg.type === 'done') {
      this.accumulatedText = '';
      const resolvers = this.flushResolvers;
      this.flushResolvers = [];
      this.emit('flush_complete');
      for (const r of resolvers) r();
    }
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  pushTokens(tokens: string): void {
    if (this.closed || this.cancelled || tokens.length === 0) return;
    this.accumulatedText += tokens;
    if (!this.firstPublishDone) {
      this.firstPublishDone = true;
      this.send({
        text: tokens,
        ...(this.opts.description ? { description: this.opts.description } : {}),
        ...(this.opts.voice ? { voice: this.opts.voice } : {}),
      });
      return;
    }
    this.send({ text: tokens });
  }

  async flush(): Promise<void> {
    if (this.closed || this.cancelled) return;
    const done = new Promise<void>((resolve) => this.flushResolvers.push(resolve));
    this.send({ flush: true });
    await done;
  }

  cancel(): void {
    if (this.closed || this.cancelled) return;
    // No vendor cancel exists: latch locally so late chunks drop, then tear
    // down the socket. Callers stop playback separately per the contract.
    this.cancelled = true;
    this.flushResolvers = [];
    this.accumulatedText = '';
    try {
      this.ws?.close();
    } catch {
      /* already gone */
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.send({ close: true });
    try {
      this.ws?.close();
    } catch {
      /* already gone */
    }
    this.emit('close');
  }
}

/**
 * Streaming TTS provider for Hume Octave voices — the expressive leg of the
 * chain (acting directions via `expressiveness.instructions`).
 */
export class HumeStreamingTTS implements IStreamingTTS, HealthyProvider {
  readonly providerId = 'hume-octave-stream';
  readonly priority: number;
  readonly capabilities: ProviderCapabilities;

  private readonly keyPool: ApiKeyPool;
  private readonly voice: HumeVoiceRef | undefined;
  private readonly wsUrl: string;

  constructor(config: HumeStreamingTTSConfig) {
    this.keyPool = new ApiKeyPool(config.apiKey);
    this.voice = config.voice;
    this.wsUrl = config.wsUrl ?? 'wss://api.hume.ai/v0/tts/stream/input';
    this.priority = config.priority ?? 14;
    this.capabilities = defaultCapabilities({
      languages: ['*'],
      streaming: true,
      costTier: 'premium',
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
      const res = await fetch(
        'https://api.hume.ai/v0/tts/voices?provider=HUME_AI&page_size=1',
        {
          headers: { 'X-Hume-Api-Key': this.keyPool.next() },
          signal: AbortSignal.timeout(1000),
        }
      );
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
    const voice = toHumeVoice(config?.voice ?? this.voice);
    // instant_mode demands an explicit voice — enable it exactly when we
    // have one; voice-less sessions trade first-chunk latency for Octave's
    // description-derived voice generation.
    const url =
      `${this.wsUrl}?api_key=${encodeURIComponent(key)}` +
      `&no_binary=true&instant_mode=${voice ? 'true' : 'false'}`;
    const session = new HumeStreamingTTSSession({
      url,
      voice,
      description: config?.expressiveness?.instructions,
    });
    await session.connect();
    return session;
  }
}
