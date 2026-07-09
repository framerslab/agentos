/**
 * @module voice-pipeline/providers/CartesiaBatchTTS
 *
 * Batch text-to-speech via Cartesia's REST API (`POST /tts/bytes`).
 * Implements {@link IBatchTTS} for one-shot narration synthesis.
 *
 * Contract notes (verified 2026-07-08): Bearer auth with the pinned
 * `Cartesia-Version: 2026-03-01` header (the only valid value today); models
 * sonic-3.5 (default) / sonic-3 / sonic-latest; prosody rides
 * `generation_config` (the vendor's top-level `speed` is deprecated — the
 * AgentOS `speed` knob maps into generation_config, clamped to Cartesia's
 * documented 0.6–1.5 range). `opus` output has no Cartesia container and
 * falls back to mp3, with the produced format reported on the result.
 * Cartesia has no natural-language instruction surface, so
 * `expressiveness.instructions` is ignored and never reported.
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

/** The only Cartesia-Version value the API accepts today. Pinned, not a knob. */
export const CARTESIA_VERSION = '2026-03-01';

/** Approximate bytes per second for 128kbps MP3 audio (duration estimate). */
const BYTES_PER_SEC_MP3 = 16_000;

/**
 * Per-request synthesize timeout. Caps how long a single Cartesia call can
 * hang before the batch fallback chain takes over (same rationale as the
 * ElevenLabs provider's cap — a wedged socket must not stall callers).
 */
const SYNTHESIZE_TIMEOUT_MS = 60_000;

async function defaultCartesiaProbe(apiKey: string) {
  const start = Date.now();
  const res = await fetch('https://api.cartesia.ai/voices?limit=1', {
    headers: { Authorization: `Bearer ${apiKey}`, 'Cartesia-Version': CARTESIA_VERSION },
    signal: AbortSignal.timeout(1000),
  });
  return { ok: res.ok, status: res.status, latencyMs: Date.now() - start };
}

/** Configuration for the Cartesia batch TTS provider. */
export interface CartesiaBatchTTSConfig {
  /** Cartesia API key (`sk_car_…`). */
  apiKey: string;
  /** Default voice id. Cartesia voices are ids; there is no vendor default. */
  voiceId: string;
  /** Model identifier. @default 'sonic-3.5' */
  model?: string;
  /** Sample rate (Hz) used when `format: 'pcm'` is requested. @default 16000 */
  pcmSampleRate?: number;
  /** Base URL for the Cartesia API. @default 'https://api.cartesia.ai' */
  baseUrl?: string;
  /** Chain priority. Lower values are tried first. @default 85 */
  priority?: number;
  /** Optional capability overrides. */
  capabilities?: Partial<ProviderCapabilities>;
  /** Injectable health probe for tests. */
  healthProbe?: (apiKey: string) => Promise<{ ok: boolean; status: number; latencyMs: number }>;
}

/**
 * Batch (one-shot) TTS provider using Cartesia's `/tts/bytes` endpoint.
 *
 * Returns mp3 by default; `format: 'pcm'` requests raw `pcm_s16le` at the
 * configured sample rate — the shape realtime avatar consumers (Simli) feed
 * on directly.
 */
export class CartesiaBatchTTS implements IBatchTTS, HealthyProvider {
  readonly providerId = 'cartesia-sonic';
  readonly priority: number;
  readonly capabilities: ProviderCapabilities;

  /** API key pool for round-robin rotation and quota failover. */
  private readonly keyPool: ApiKeyPool;

  /** Default voice id when none is provided in the synthesis config. */
  private readonly voiceId: string;

  /** Model identifier sent with each request. */
  private readonly model: string;

  /** Sample rate for raw pcm output. */
  private readonly pcmSampleRate: number;

  /** Base URL for all API requests. */
  private readonly baseUrl: string;

  /** Injectable health probe for tests. */
  private readonly healthProbe: NonNullable<CartesiaBatchTTSConfig['healthProbe']>;

  constructor(config: CartesiaBatchTTSConfig) {
    this.keyPool = new ApiKeyPool(config.apiKey);
    this.voiceId = config.voiceId;
    this.model = config.model ?? 'sonic-3.5';
    this.pcmSampleRate = config.pcmSampleRate ?? 16000;
    this.baseUrl = config.baseUrl ?? 'https://api.cartesia.ai';
    this.priority = config.priority ?? 85;
    this.capabilities = defaultCapabilities({
      languages: ['*'],
      streaming: false,
      costTier: 'standard',
      latencyClass: 'batch',
      ...(config.capabilities ?? {}),
    });
    this.healthProbe = config.healthProbe ?? defaultCartesiaProbe;
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
   * Synthesize complete text into audio via Cartesia's REST API.
   *
   * @param text - The text to synthesize.
   * @param config - Optional synthesis configuration (voice, model, format, speed).
   * @returns Resolved {@link BatchTTSResult} with the audio buffer.
   * @throws Error if the API returns a non-OK status.
   */
  async synthesize(text: string, config?: BatchTTSConfig): Promise<BatchTTSResult> {
    // opus has no Cartesia container — fall back to mp3 and report what was
    // actually produced on the result.
    const requested = config?.format ?? 'mp3';
    const format: 'mp3' | 'pcm' = requested === 'pcm' ? 'pcm' : 'mp3';
    const outputFormat =
      format === 'pcm'
        ? { container: 'raw', encoding: 'pcm_s16le', sample_rate: this.pcmSampleRate }
        : { container: 'mp3', bit_rate: 128_000, sample_rate: 44_100 };

    // Caller speed (top-level wins over expressiveness, per BatchTTSConfig
    // docs) → generation_config, clamped to the documented 0.6–1.5 range.
    const rawSpeed = config?.speed ?? config?.expressiveness?.speed;
    const speed =
      typeof rawSpeed === 'number' && Number.isFinite(rawSpeed)
        ? Math.min(1.5, Math.max(0.6, rawSpeed))
        : undefined;
    const applied: string[] = [];
    if (speed != null) applied.push('speed');

    const body = {
      model_id: config?.model ?? this.model,
      transcript: text,
      voice: { mode: 'id', id: config?.voice ?? this.voiceId },
      output_format: outputFormat,
      ...(speed != null ? { generation_config: { speed } } : {}),
      ...(config?.providerOptions ?? {}),
    };

    const doFetch = (key: string) =>
      fetch(`${this.baseUrl}/tts/bytes`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Cartesia-Version': CARTESIA_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
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
        throw new Error(`Cartesia TTS failed: ${res.status} ${errBody.slice(0, 200)}`);
      }
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Cartesia TTS failed: ${res.status} ${detail.slice(0, 200)}`);
    }

    const audio = Buffer.from(await res.arrayBuffer());
    const durationMs =
      format === 'pcm'
        ? Math.round((audio.byteLength / (this.pcmSampleRate * 2)) * 1000)
        : Math.round((audio.byteLength / BYTES_PER_SEC_MP3) * 1000);

    return {
      audio,
      format,
      durationMs,
      provider: this.providerId,
      ...(applied.length > 0 ? { appliedExpressiveness: applied } : {}),
    };
  }
}
