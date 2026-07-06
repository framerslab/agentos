/**
 * @module voice-pipeline/providers/DeepgramAuraBatchTTS
 *
 * Batch text-to-speech via Deepgram Aura's REST API (`POST /v1/speak`).
 * Implements {@link IBatchTTS} for one-shot narration synthesis.
 *
 * Aura caps a single request at 2000 characters, so longer text is split
 * at sentence boundaries via {@link chunkForAura} and the returned audio
 * buffers are concatenated. MP3 is frame-based, so naive concatenation of
 * per-chunk MP3 byte streams plays back as one continuous clip.
 *
 * Mirrors {@link OpenAIBatchTTS}: global `fetch`, `ApiKeyPool` rotation with
 * quota failover, a bounded per-request `AbortSignal.timeout`, and an
 * injectable health probe for tests.
 */

import type { IBatchTTS, BatchTTSConfig, BatchTTSResult } from '../types.js';
import { ApiKeyPool } from '../../../core/providers/ApiKeyPool.js';
import { isQuotaError } from '../../../core/providers/quotaErrors.js';
import {
  defaultCapabilities,
  type HealthyProvider,
  type HealthCheckResult,
  type ProviderCapabilities,
} from '../HealthyProvider.js';
import { VoicePipelineError } from '../VoicePipelineError.js';

/** Deepgram REST base. */
const BASE_URL = 'https://api.deepgram.com/v1';
/** Default Aura-2 voice (clear, confident feminine American). */
const DEFAULT_VOICE = 'aura-2-thalia-en';
/** Aura hard limit: 2000 characters per `/v1/speak` request. */
const MAX_CHARS = 2000;
/** Per-request synthesize timeout; caps a hung upstream so the chain can fail over. */
const SYNTHESIZE_TIMEOUT_MS = 60_000;
/** Approx MP3 bytes/sec at Aura's default bitrate — used only for a duration estimate. */
const BYTES_PER_SEC_MP3 = 16_000;
/** Aura's default linear16 (raw PCM) sample rate; bytes/sec = rate * 2 (16-bit). */
const DEFAULT_PCM_SAMPLE_RATE = 24_000;

/** Configuration for the Deepgram Aura batch TTS provider. */
export interface DeepgramAuraBatchTTSConfig {
  /** Deepgram API key. */
  apiKey: string;
  /** Default Aura voice model. @default 'aura-2-thalia-en' */
  voice?: string;
  /** Base URL for the Deepgram API. @default 'https://api.deepgram.com/v1' */
  baseUrl?: string;
  /** Chain priority. Lower values are tried first. @default 70 */
  priority?: number;
  /** Optional capability overrides. */
  capabilities?: Partial<ProviderCapabilities>;
  /** Injectable health probe for tests. */
  healthProbe?: (apiKey: string) => Promise<{ ok: boolean; status: number; latencyMs: number }>;
}

/**
 * Split `text` into chunks no longer than `max` characters, preferring a
 * sentence boundary (`". "`) and falling back to the nearest whitespace,
 * then a hard cut. Short text returns a single-element array unchanged.
 */
export function chunkForAura(text: string, max = MAX_CHARS): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    // Search for a boundary within [0, max-1] so the chunk — including the
    // boundary character at `cut` — never exceeds `max`. Aura rejects a
    // request over 2000 characters, so an off-by-one here is a hard failure.
    let cut = rest.lastIndexOf('. ', max - 1);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max - 1);
    if (cut <= 0) {
      // No sentence/space boundary in range — hard-cut at exactly max.
      chunks.push(rest.slice(0, max).trim());
      rest = rest.slice(max).trim();
    } else {
      chunks.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function defaultDeepgramProbe(apiKey: string) {
  const start = Date.now();
  const res = await fetch('https://api.deepgram.com/v1/auth/token', {
    headers: { Authorization: `Token ${apiKey}` },
    signal: AbortSignal.timeout(1000),
  });
  return { ok: res.ok, status: res.status, latencyMs: Date.now() - start };
}

/**
 * One-shot TTS provider backed by the Deepgram Aura `/v1/speak` endpoint.
 * Accepts complete text and returns a finished audio buffer.
 */
export class DeepgramAuraBatchTTS implements IBatchTTS, HealthyProvider {
  readonly providerId = 'deepgram-aura';
  readonly priority: number;
  readonly capabilities: ProviderCapabilities;
  private readonly keyPool: ApiKeyPool;
  private readonly voice: string;
  private readonly baseUrl: string;
  private readonly healthProbe: NonNullable<DeepgramAuraBatchTTSConfig['healthProbe']>;

  constructor(config: DeepgramAuraBatchTTSConfig) {
    this.keyPool = new ApiKeyPool(config.apiKey);
    this.voice = config.voice ?? DEFAULT_VOICE;
    this.baseUrl = config.baseUrl ?? BASE_URL;
    this.priority = config.priority ?? 70;
    this.healthProbe = config.healthProbe ?? defaultDeepgramProbe;
    this.capabilities = defaultCapabilities({
      languages: ['*'],
      streaming: false,
      costTier: 'cheap',
      latencyClass: 'batch',
      ...(config.capabilities ?? {}),
    });
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

  /**
   * Synthesize complete text into audio via the Deepgram Aura speak API.
   * Splits text over 2000 chars into multiple requests and concatenates.
   *
   * @param text - The text to synthesize.
   * @param config - Optional voice and format overrides.
   * @returns The synthesized audio buffer with metadata.
   */
  async synthesize(text: string, config?: BatchTTSConfig): Promise<BatchTTSResult> {
    const voice = config?.voice ?? this.voice;
    const format = config?.format ?? 'mp3';
    // Aura encodings: mp3, opus, linear16 (raw PCM). Map our format union.
    const encoding = format === 'mp3' ? 'mp3' : format === 'opus' ? 'opus' : 'linear16';

    const chunks = chunkForAura(text);
    // Chunks synthesize concurrently: Aura latency is per-request, so a
    // multi-chunk narration otherwise pays N sequential round-trips.
    // Promise.all preserves chunk order for the frame-based MP3 concat.
    const buffers = await Promise.all(
      chunks.map((chunk) => this.synthesizeOne(chunk, voice, encoding)),
    );

    const audio = Buffer.concat(buffers);
    // Raw PCM (linear16) is uncompressed at sampleRate * 2 bytes/sec (16-bit);
    // mp3/opus are compressed, estimated at BYTES_PER_SEC_MP3.
    const bytesPerSec = format === 'pcm' ? DEFAULT_PCM_SAMPLE_RATE * 2 : BYTES_PER_SEC_MP3;
    const durationMs = Math.round((audio.byteLength / bytesPerSec) * 1000);
    return { audio, format, durationMs, provider: this.providerId };
  }

  private async synthesizeOne(text: string, voice: string, encoding: string): Promise<Buffer> {
    const url = `${this.baseUrl}/speak?model=${encodeURIComponent(voice)}&encoding=${encoding}`;
    const doFetch = (key: string) =>
      fetch(url, {
        method: 'POST',
        headers: { Authorization: `Token ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(SYNTHESIZE_TIMEOUT_MS),
      });

    const key = this.keyPool.next();
    let res = await doFetch(key);

    if (!res.ok && this.keyPool.size > 1) {
      const errBody = await res.text().catch(() => '');
      if (isQuotaError(res.status, errBody)) {
        this.keyPool.markExhausted(key);
        res = await doFetch(this.keyPool.next());
      } else {
        throw new Error(`Deepgram Aura TTS failed: ${res.status} ${errBody.slice(0, 200)}`);
      }
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Deepgram Aura TTS failed: ${res.status} ${detail.slice(0, 200)}`);
    }

    return Buffer.from(await res.arrayBuffer());
  }
}
