/**
 * @module voice-pipeline/providers/HumeBatchTTS
 *
 * Batch text-to-speech via Hume's Octave API (`POST /v0/tts`). Implements
 * {@link IBatchTTS} for one-shot expressive narration synthesis.
 *
 * Contract notes (verified 2026-07-08):
 * - Auth is the `X-Hume-Api-Key` header.
 * - `version` is OMITTED by default so requests auto-route: `version: 2`
 *   REQUIRES an explicit voice, and a hard-coded default would break
 *   voice-less calls. Callers opt in via `providerOptions.version` and own
 *   that constraint.
 * - `expressiveness.instructions` renders as the utterance `description`
 *   (acting directions) — Hume is the one core provider with a
 *   natural-language instruction surface — and is reported in
 *   `appliedExpressiveness` when consumed.
 * - Response audio arrives base64-encoded in `generations[].audio` with a
 *   vendor-reported `duration` in seconds.
 * - `opus` output is unsupported by the vendor and falls back to mp3, with
 *   the produced format reported on the result.
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

/** Approximate bytes per second for 128kbps MP3 audio (duration fallback). */
const BYTES_PER_SEC_MP3 = 16_000;

/** Per-request synthesize timeout (same rationale as the sibling providers). */
const SYNTHESIZE_TIMEOUT_MS = 60_000;

/** A Hume voice reference: by id or by name, from the Hume or custom library. */
export interface HumeVoiceRef {
  id?: string;
  name?: string;
  /** @default 'HUME_AI' */
  provider?: 'HUME_AI' | 'CUSTOM_VOICE';
}

async function defaultHumeProbe(apiKey: string) {
  const start = Date.now();
  const res = await fetch('https://api.hume.ai/v0/tts/voices?provider=HUME_AI&page_size=1', {
    headers: { 'X-Hume-Api-Key': apiKey },
    signal: AbortSignal.timeout(1000),
  });
  return { ok: res.ok, status: res.status, latencyMs: Date.now() - start };
}

/** Configuration for the Hume batch TTS provider. */
export interface HumeBatchTTSConfig {
  /** Hume API key. */
  apiKey: string;
  /** Default voice. Optional — voice-less requests auto-generate a voice
   *  from the description, which is a first-class Octave behavior. */
  voice?: HumeVoiceRef;
  /** Base URL for the Hume API. @default 'https://api.hume.ai' */
  baseUrl?: string;
  /** Chain priority. Lower values are tried first. @default 86 */
  priority?: number;
  /** Optional capability overrides. */
  capabilities?: Partial<ProviderCapabilities>;
  /** Injectable health probe for tests. */
  healthProbe?: (apiKey: string) => Promise<{ ok: boolean; status: number; latencyMs: number }>;
}

/**
 * Batch (one-shot) TTS provider using Hume's Octave `/v0/tts` endpoint.
 */
export class HumeBatchTTS implements IBatchTTS, HealthyProvider {
  readonly providerId = 'hume-octave';
  readonly priority: number;
  readonly capabilities: ProviderCapabilities;

  /** API key pool for round-robin rotation and quota failover. */
  private readonly keyPool: ApiKeyPool;

  /** Default voice when none is provided in the synthesis config. */
  private readonly voice: HumeVoiceRef | undefined;

  /** Base URL for all API requests. */
  private readonly baseUrl: string;

  /** Injectable health probe for tests. */
  private readonly healthProbe: NonNullable<HumeBatchTTSConfig['healthProbe']>;

  constructor(config: HumeBatchTTSConfig) {
    this.keyPool = new ApiKeyPool(config.apiKey);
    this.voice = config.voice;
    this.baseUrl = config.baseUrl ?? 'https://api.hume.ai';
    this.priority = config.priority ?? 86;
    this.capabilities = defaultCapabilities({
      languages: ['*'],
      streaming: false,
      costTier: 'premium',
      latencyClass: 'batch',
      ...(config.capabilities ?? {}),
    });
    this.healthProbe = config.healthProbe ?? defaultHumeProbe;
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

  /** Normalize a voice reference into Hume's `{id|name, provider}` shape. */
  private static toHumeVoice(
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
   * Synthesize complete text into audio via Hume's Octave REST API.
   *
   * @param text - The text to synthesize.
   * @param config - Optional synthesis configuration (voice, format, speed,
   *   expressiveness.instructions → description).
   * @returns Resolved {@link BatchTTSResult} with the decoded audio buffer.
   * @throws Error if the API returns a non-OK status or an empty generation.
   */
  async synthesize(text: string, config?: BatchTTSConfig): Promise<BatchTTSResult> {
    const requested = config?.format ?? 'mp3';
    const format: 'mp3' | 'pcm' = requested === 'pcm' ? 'pcm' : 'mp3';

    const applied: string[] = [];
    const instructions = config?.expressiveness?.instructions;
    if (instructions) applied.push('instructions');

    const rawSpeed = config?.speed ?? config?.expressiveness?.speed;
    const speed =
      typeof rawSpeed === 'number' && Number.isFinite(rawSpeed) ? rawSpeed : undefined;
    if (speed != null) applied.push('speed');

    const voice = HumeBatchTTS.toHumeVoice(config?.voice ?? this.voice);

    // `version` is deliberately NOT defaulted (auto-routing); callers opting
    // into Octave 2 via providerOptions must also supply a voice.
    const body = {
      utterances: [
        {
          text,
          ...(instructions ? { description: instructions } : {}),
          ...(voice ? { voice } : {}),
          ...(speed != null ? { speed } : {}),
        },
      ],
      format: { type: format },
      ...(config?.providerOptions ?? {}),
    };

    const doFetch = (key: string) =>
      fetch(`${this.baseUrl}/v0/tts`, {
        method: 'POST',
        headers: {
          'X-Hume-Api-Key': key,
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
        throw new Error(`Hume TTS failed: ${res.status} ${errBody.slice(0, 200)}`);
      }
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Hume TTS failed: ${res.status} ${detail.slice(0, 200)}`);
    }

    const payload = (await res.json()) as {
      generations?: Array<{ audio?: string; duration?: number }>;
    };
    const generation = payload.generations?.[0];
    if (!generation?.audio) {
      throw new Error('Hume TTS returned no generations');
    }

    const audio = Buffer.from(generation.audio, 'base64');
    const durationMs =
      typeof generation.duration === 'number' && Number.isFinite(generation.duration)
        ? Math.round(generation.duration * 1000)
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
