/**
 * @module voice-pipeline/env-constructor
 *
 * Batteries-included constructor for `StreamingSTTChain` +
 * `StreamingTTSChain`. Reads provider keys from an env-like object and
 * builds priority-ordered chains with shared circuit breaker and metrics
 * reporter. Host apps can skip the manual wiring and use this factory as
 * the default integration point. {@link createSttChainFromEnv} builds the
 * STT chain alone, for a consumer with no speech output.
 */

import { DeepgramStreamingSTT } from './providers/DeepgramStreamingSTT.js';
import { ElevenLabsStreamingSTT } from './providers/ElevenLabsStreamingSTT.js';
import {
  OpenAIRealtimeTranscriptionSTT,
  type OpenAIRealtimeTranscriptionSTTConfig,
} from './providers/OpenAIRealtimeTranscriptionSTT.js';
import { ElevenLabsStreamingTTS } from './providers/ElevenLabsStreamingTTS.js';
import { DeepgramAuraStreamingTTS } from './providers/DeepgramAuraStreamingTTS.js';
import { OpenAIRealtimeTTS } from './providers/OpenAIRealtimeTTS.js';
import { ElevenLabsBatchTTS } from './providers/ElevenLabsBatchTTS.js';
import { CartesiaStreamingTTS } from './providers/CartesiaStreamingTTS.js';
import { HumeStreamingTTS } from './providers/HumeStreamingTTS.js';
import { OpenAIBatchTTS } from './providers/OpenAIBatchTTS.js';
import { StreamingSTTChain } from './providers/StreamingSTTChain.js';
import { StreamingTTSChain } from './providers/StreamingTTSChain.js';
import { CircuitBreaker } from './CircuitBreaker.js';
import { VoiceMetricsReporter } from './VoiceMetricsReporter.js';
import type { IStreamingSTT, IStreamingTTS } from './types.js';
import type { HealthyProvider } from './HealthyProvider.js';

export class NoVoiceProvidersAvailableError extends Error {
  readonly checkedEnvVars: string[];

  constructor(checked: string[]) {
    super(
      `No voice providers available. Set any of: ${checked.join(', ')} in the server env.`
    );
    this.name = 'NoVoiceProvidersAvailableError';
    this.checkedEnvVars = checked;
  }
}

export interface VoiceProviderEnvConfig {
  /** Environment source. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Prefer streaming-class providers for first-try. Default true. */
  preferStreaming?: boolean;
  /** Language hint — providers whose capabilities don't match are still
   *  included (capability filtering is host-app policy), but this value
   *  is passed through to StreamingTTSConfig / StreamingSTTConfig via
   *  startSession consumers. */
  languageHint?: string;
  /** Target cost tier. Reserved for future per-session routing; not used yet. */
  tier?: 'cheap' | 'standard' | 'premium';
  /**
   * Which TTS vendor to prefer for first-try synthesis. `'deepgram'` (default)
   * ranks Deepgram Aura ahead of ElevenLabs; `'elevenlabs'` ranks ElevenLabs
   * first (used for a paid-tier premium-voice opt-in); `'cartesia'` / `'hume'`
   * promote those vendors' streaming providers to first-try when their keys
   * are present. Either way the other vendors stay in the chain as automatic
   * fallbacks.
   */
  ttsPreference?: 'deepgram' | 'elevenlabs' | 'cartesia' | 'hume';
  /** Whether the STT chain keeps a ring buffer + re-routes mid-utterance.
   *  Default true — this is the whole point of the resilience work. */
  enableMidUtteranceFailover?: boolean;
  /** Whether the TTS chain re-sends accumulated tokens on primary
   *  failure. Default true. */
  enableMidSynthesisFailover?: boolean;
  /**
   * Options for the OpenAI Realtime transcription provider, which joins the
   * STT chain when `OPENAI_API_KEY` is set (model, turn detection, rollover,
   * usage reports and the rest; the key comes from the environment).
   */
  openaiRealtime?: Omit<OpenAIRealtimeTranscriptionSTTConfig, 'apiKey'>;
}

export interface VoiceProviderBundle {
  stt: StreamingSTTChain;
  tts: StreamingTTSChain;
  metrics: VoiceMetricsReporter;
  breaker: CircuitBreaker;
  /** Release any global resources the bundle owns. Currently a no-op
   *  because sessions clean up themselves; exposed now so host apps can
   *  depend on the shape. */
  dispose(): Promise<void>;
}

/** The STT keys the constructors read, in the order their providers are tried. */
const STT_ENV_KEYS = ['DEEPGRAM_API_KEY', 'ELEVENLABS_API_KEY', 'OPENAI_API_KEY'];

/**
 * Streaming STT providers for the keys present in `env`. OpenAI Realtime
 * transcription is tried after Deepgram and ElevenLabs (priority 30, unless
 * `openaiRealtime.priority` says otherwise), so an environment that already
 * had a first-try STT provider keeps it.
 */
function sttProvidersFromEnv(
  env: Record<string, string | undefined>,
  openaiRealtime: Omit<OpenAIRealtimeTranscriptionSTTConfig, 'apiKey'> = {}
): Array<IStreamingSTT & HealthyProvider> {
  const providers: Array<IStreamingSTT & HealthyProvider> = [];
  const deepgramKey = env['DEEPGRAM_API_KEY'];
  const elevenLabsKey = env['ELEVENLABS_API_KEY'];
  const openaiKey = env['OPENAI_API_KEY'];
  if (deepgramKey) {
    providers.push(new DeepgramStreamingSTT({ apiKey: deepgramKey, priority: 10 }));
  }
  if (elevenLabsKey) {
    providers.push(new ElevenLabsStreamingSTT({ apiKey: elevenLabsKey, priority: 20 }));
  }
  if (openaiKey) {
    providers.push(
      new OpenAIRealtimeTranscriptionSTT({ priority: 30, ...openaiRealtime, apiKey: openaiKey })
    );
  }
  return providers;
}

export function createVoiceProvidersFromEnv(
  config: VoiceProviderEnvConfig = {}
): VoiceProviderBundle {
  const env = config.env ?? (globalThis.process?.env as Record<string, string | undefined>) ?? {};
  const checkedKeys = [
    'DEEPGRAM_API_KEY',
    'ELEVENLABS_API_KEY',
    'OPENAI_API_KEY',
    'CARTESIA_API_KEY',
    'HUME_API_KEY',
  ];

  const deepgramKey = env['DEEPGRAM_API_KEY'];
  const elevenLabsKey = env['ELEVENLABS_API_KEY'];
  const openaiKey = env['OPENAI_API_KEY'];
  const cartesiaKey = env['CARTESIA_API_KEY'];
  const cartesiaVoiceId = env['CARTESIA_VOICE_ID'];
  const humeKey = env['HUME_API_KEY'];

  const metrics = new VoiceMetricsReporter();
  const breaker = new CircuitBreaker({
    failureThreshold: 3,
    windowMs: 60_000,
    cooldownMs: 60_000,
  });

  const sttProviders = sttProvidersFromEnv(env, config.openaiRealtime);

  // Deepgram Aura is the default first-try TTS (priority 5). An explicit
  // 'elevenlabs' preference drops Aura behind ElevenLabs streaming (15 > 10).
  const prefersDeepgram = (config.ttsPreference ?? 'deepgram') === 'deepgram';
  const ttsProviders: Array<IStreamingTTS & HealthyProvider> = [];
  if (deepgramKey) {
    ttsProviders.push(
      new DeepgramAuraStreamingTTS({ apiKey: deepgramKey, priority: prefersDeepgram ? 5 : 15 })
    );
  }
  if (elevenLabsKey) {
    ttsProviders.push(
      new ElevenLabsStreamingTTS({ apiKey: elevenLabsKey, priority: 10 })
    );
  }
  if (openaiKey) {
    ttsProviders.push(
      new OpenAIRealtimeTTS({ apiKey: openaiKey, priority: 20 })
    );
    ttsProviders.push(
      new OpenAIBatchTTS({ apiKey: openaiKey, priority: 90 }) as unknown as
        IStreamingTTS & HealthyProvider
    );
  }
  if (elevenLabsKey) {
    ttsProviders.push(
      new ElevenLabsBatchTTS({ apiKey: elevenLabsKey, priority: 80 }) as unknown as
        IStreamingTTS & HealthyProvider
    );
  }

  // New alternates ride the STREAMING chain only (there is no batch chain
  // here; batch consumers instantiate providers directly). A preference
  // promotes the vendor ahead of Deepgram Aura's first-try slot (5).
  if (cartesiaKey && cartesiaVoiceId) {
    // Cartesia has no vendor-default voice — without a voice id the provider
    // cannot synthesize, so it only joins the chain when one is configured.
    ttsProviders.push(
      new CartesiaStreamingTTS({
        apiKey: cartesiaKey,
        voiceId: cartesiaVoiceId,
        priority: config.ttsPreference === 'cartesia' ? 4 : 12,
      })
    );
  }
  if (humeKey) {
    ttsProviders.push(
      new HumeStreamingTTS({
        apiKey: humeKey,
        priority: config.ttsPreference === 'hume' ? 4 : 14,
      })
    );
  }

  if (sttProviders.length === 0 || ttsProviders.length === 0) {
    throw new NoVoiceProvidersAvailableError(checkedKeys);
  }

  const stt = new StreamingSTTChain(sttProviders, {
    breaker,
    metrics,
    enableMidUtteranceFailover: config.enableMidUtteranceFailover ?? true,
    ringBufferCapacityMs: 3000,
  });
  const tts = new StreamingTTSChain(ttsProviders, {
    breaker,
    metrics,
    enableMidSynthesisFailover: config.enableMidSynthesisFailover ?? true,
  });

  return {
    stt,
    tts,
    metrics,
    breaker,
    async dispose() {
      /* Sessions clean themselves up; nothing global to release today. */
    },
  };
}

/** Configuration for {@link createSttChainFromEnv}. */
export interface SttProviderEnvConfig {
  /** Environment source. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /**
   * Whether the chain keeps a ring buffer and re-routes mid-utterance.
   * Default false here: the failover facade forwards transcripts and speech
   * events only and has no `flush()`, so with failover off a session keeps
   * its provider's whole surface (`flush()`, `'usage'`, `'warning'`).
   */
  enableMidUtteranceFailover?: boolean;
  /**
   * Options for the OpenAI Realtime transcription provider when
   * `OPENAI_API_KEY` is set (the key comes from the environment).
   */
  openaiRealtime?: Omit<OpenAIRealtimeTranscriptionSTTConfig, 'apiKey'>;
}

/** What {@link createSttChainFromEnv} returns. */
export interface SttProviderBundle {
  stt: StreamingSTTChain;
  metrics: VoiceMetricsReporter;
  breaker: CircuitBreaker;
  /** Release any global resources the bundle owns. Currently a no-op
   *  because sessions clean up themselves. */
  dispose(): Promise<void>;
}

/**
 * Builds the speech-to-text chain alone, for a consumer with no speech
 * output, such as a transcriber or a note taker.
 * {@link createVoiceProvidersFromEnv} needs a TTS key as well and throws
 * without one.
 *
 * @param config - Environment source, failover switch and OpenAI Realtime options.
 * @returns The STT chain with its metrics reporter and circuit breaker.
 * @throws {NoVoiceProvidersAvailableError} When none of `DEEPGRAM_API_KEY`,
 *   `ELEVENLABS_API_KEY` and `OPENAI_API_KEY` is set.
 *
 * @example
 * ```typescript
 * const { stt } = createSttChainFromEnv({ openaiRealtime: { usageIntervalMs: 15_000 } });
 * const session = await stt.startSession({ language: 'en' });
 * session.on('transcript', (event) => console.log(event.itemId, event.text));
 * ```
 */
export function createSttChainFromEnv(config: SttProviderEnvConfig = {}): SttProviderBundle {
  const env = config.env ?? (globalThis.process?.env as Record<string, string | undefined>) ?? {};
  const sttProviders = sttProvidersFromEnv(env, config.openaiRealtime);
  if (sttProviders.length === 0) {
    throw new NoVoiceProvidersAvailableError([...STT_ENV_KEYS]);
  }

  const metrics = new VoiceMetricsReporter();
  const breaker = new CircuitBreaker({
    failureThreshold: 3,
    windowMs: 60_000,
    cooldownMs: 60_000,
  });
  const stt = new StreamingSTTChain(sttProviders, {
    breaker,
    metrics,
    enableMidUtteranceFailover: config.enableMidUtteranceFailover ?? false,
  });

  return {
    stt,
    metrics,
    breaker,
    async dispose() {
      /* Sessions clean themselves up; nothing global to release today. */
    },
  };
}
