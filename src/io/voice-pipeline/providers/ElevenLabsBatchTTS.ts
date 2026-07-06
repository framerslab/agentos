/**
 * @module voice-pipeline/providers/ElevenLabsBatchTTS
 *
 * Batch text-to-speech via ElevenLabs' REST API. Implements {@link IBatchTTS}
 * for one-shot narration synthesis with voice settings control.
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

async function defaultElevenLabsBatchProbe(apiKey: string) {
  const start = Date.now();
  const res = await fetch('https://api.elevenlabs.io/v1/user', {
    headers: { 'xi-api-key': apiKey },
    signal: AbortSignal.timeout(1000),
  });
  return { ok: res.ok, status: res.status, latencyMs: Date.now() - start };
}

/** Configuration for the ElevenLabs batch TTS provider. */
export interface ElevenLabsBatchTTSConfig {
  /** ElevenLabs API key. */
  apiKey: string;
  /** Default voice ID. Falls back to 'EXAVITQu4vr4xnSDxMaL' (Rachel). */
  voiceId?: string;
  /** Model identifier. Defaults to 'eleven_multilingual_v2'. */
  model?: string;
  /** Base URL for the ElevenLabs API. Defaults to 'https://api.elevenlabs.io/v1'. */
  baseUrl?: string;
  /** Chain priority. Lower values are tried first. @default 80 */
  priority?: number;
  /** Optional capability overrides. */
  capabilities?: Partial<ProviderCapabilities>;
  /** Injectable health probe for tests. */
  healthProbe?: (apiKey: string) => Promise<{ ok: boolean; status: number; latencyMs: number }>;
}

/** Approximate bytes per second for 128kbps MP3 audio. */
const BYTES_PER_SEC_MP3 = 16_000;

/**
 * Per-request synthesize timeout. Caps how long a single ElevenLabs call
 * can hang before the fallback chain takes over. Without it a slow /
 * unhealthy ElevenLabs response wedges the surrounding TTS manager
 * (and any caller awaiting `flush()`) for the full TCP socket idle
 * timeout — observed at ~5 minutes in production 2026-05-18.
 */
const SYNTHESIZE_TIMEOUT_MS = 60_000;

/**
 * Batch (one-shot) TTS provider using ElevenLabs' REST text-to-speech endpoint.
 *
 * Accepts complete text and returns finished MP3 audio with voice settings
 * control via `providerOptions` (stability, similarityBoost, style, useSpeakerBoost).
 */
export class ElevenLabsBatchTTS implements IBatchTTS, HealthyProvider {
  readonly providerId = 'elevenlabs-batch';
  readonly priority: number;
  readonly capabilities: ProviderCapabilities;

  /** API key pool for round-robin rotation and quota failover. */
  private readonly keyPool: ApiKeyPool;

  /** Default voice ID when none is provided in the synthesis config. */
  private readonly defaultVoiceId: string;

  /** Model identifier sent with each request. */
  private readonly model: string;

  /** Base URL for all API requests. */
  private readonly baseUrl: string;

  /** Injectable health probe for tests. */
  private readonly healthProbe: NonNullable<ElevenLabsBatchTTSConfig['healthProbe']>;

  constructor(config: ElevenLabsBatchTTSConfig) {
    this.keyPool = new ApiKeyPool(config.apiKey);
    this.defaultVoiceId = config.voiceId ?? 'EXAVITQu4vr4xnSDxMaL';
    this.model = config.model ?? 'eleven_multilingual_v2';
    this.baseUrl = config.baseUrl ?? 'https://api.elevenlabs.io/v1';
    this.priority = config.priority ?? 80;
    this.capabilities = defaultCapabilities({
      languages: ['*'],
      streaming: false,
      costTier: 'standard',
      latencyClass: 'batch',
      ...(config.capabilities ?? {}),
    });
    this.healthProbe = config.healthProbe ?? defaultElevenLabsBatchProbe;
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
   * Synthesize complete text into MP3 audio via ElevenLabs REST API.
   *
   * @param text - The text to synthesize.
   * @param config - Optional synthesis configuration (voice, model, providerOptions).
   * @returns Resolved {@link BatchTTSResult} containing the MP3 audio buffer.
   * @throws Error if the API returns a non-OK status.
   */
  async synthesize(text: string, config?: BatchTTSConfig): Promise<BatchTTSResult> {
    const voiceId = config?.voice ?? this.defaultVoiceId;
    // First-class expressiveness wins over legacy providerOptions per knob;
    // both use the same camelCase names so the merge is a plain spread.
    const opts: Record<string, unknown> = {
      ...(config?.providerOptions ?? {}),
      ...(config?.expressiveness ?? {}),
    };
    // Top-level `speed` stays authoritative (pre-existing API), then the
    // expressiveness/providerOptions merge. ElevenLabs accepts 0.7-1.2.
    const rawSpeed = config?.speed ?? (opts.speed as number | undefined);
    const speed =
      typeof rawSpeed === 'number' && Number.isFinite(rawSpeed)
        ? Math.min(1.2, Math.max(0.7, rawSpeed))
        : undefined;
    const applied: string[] = [];
    for (const knob of ['stability', 'similarityBoost', 'style', 'useSpeakerBoost'] as const) {
      if (opts[knob] != null) applied.push(knob);
    }
    if (speed != null) applied.push('speed');

    const doFetch = (key: string) =>
      fetch(`${this.baseUrl}/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: {
          'xi-api-key': key,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: config?.model ?? this.model,
          voice_settings: {
            stability: (opts.stability as number) ?? 0.5,
            similarity_boost: (opts.similarityBoost as number) ?? 0.75,
            style: (opts.style as number) ?? 0.0,
            use_speaker_boost: (opts.useSpeakerBoost as boolean) ?? true,
            ...(speed != null ? { speed } : {}),
          },
        }),
        signal: AbortSignal.timeout(SYNTHESIZE_TIMEOUT_MS),
      });

    const key = this.keyPool.next();
    let res = await doFetch(key);

    if (!res.ok && this.keyPool.size > 1) {
      const body = await res.text().catch(() => '');
      if (isQuotaError(res.status, body)) {
        this.keyPool.markExhausted(key);
        res = await doFetch(this.keyPool.next());
      } else {
        throw new Error(`ElevenLabs TTS failed: ${res.status} ${body.slice(0, 200)}`);
      }
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`ElevenLabs TTS failed: ${res.status} ${detail.slice(0, 200)}`);
    }

    const audio = Buffer.from(await res.arrayBuffer());
    const durationMs = Math.round((audio.byteLength / BYTES_PER_SEC_MP3) * 1000);

    return {
      audio,
      format: 'mp3',
      durationMs,
      provider: this.providerId,
      ...(applied.length > 0 ? { appliedExpressiveness: applied } : {}),
    };
  }
}
