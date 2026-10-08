/**
 * @module voice-pipeline/providers/OpenAIRealtimeTranscriptionSTT
 *
 * A placeholder for the streaming speech-to-text provider over OpenAI's
 * Realtime transcription sessions: the provider's identity
 * (`openai-realtime-transcription`), its chain priority and the configuration
 * it keeps, so a {@link StreamingSTTChain} can name it. The provider's own
 * module replaces this one and brings the streaming session; this one has
 * none, so {@link OpenAIRealtimeTranscriptionSTT.startSession} rejects and
 * {@link OpenAIRealtimeTranscriptionSTT.healthCheck} reports the provider
 * unavailable, and a chain moves on to its next provider.
 */

import type { IStreamingSTT, StreamingSTTSession } from '../types.js';
import {
  defaultCapabilities,
  type HealthyProvider,
  type HealthCheckResult,
  type ProviderCapabilities,
} from '../HealthyProvider.js';

/**
 * Configuration for the {@link OpenAIRealtimeTranscriptionSTT} provider: the
 * fields of the provider's configuration that a chain sets.
 */
export interface OpenAIRealtimeTranscriptionSTTConfig {
  /** OpenAI API key. */
  apiKey: string;

  /** Transcription model. @defaultValue 'gpt-4o-mini-transcribe' */
  model?: string;

  /** Chain priority. Lower values are tried first. @default 15 */
  priority?: number;

  /** Optional capability overrides. Merged into defaultCapabilities(). */
  capabilities?: Partial<ProviderCapabilities>;
}

/** Why this placeholder opens no session. */
const NO_SESSION =
  'OpenAIRealtimeTranscriptionSTT: this placeholder has no streaming session';

/**
 * Placeholder of the OpenAI Realtime transcription provider. It keeps its
 * configuration as `config`, as the provider does, and implements
 * {@link IStreamingSTT} and {@link HealthyProvider} with no session.
 */
export class OpenAIRealtimeTranscriptionSTT implements IStreamingSTT, HealthyProvider {
  readonly providerId = 'openai-realtime-transcription';
  readonly isStreaming = true;
  readonly priority: number;
  readonly capabilities: ProviderCapabilities;

  constructor(private readonly config: OpenAIRealtimeTranscriptionSTTConfig) {
    this.priority = config.priority ?? 15;
    this.capabilities = defaultCapabilities({
      languages: ['*'],
      streaming: true,
      costTier: 'standard',
      latencyClass: 'realtime',
      ...(config.capabilities ?? {}),
    });
  }

  /** Reports the provider unavailable: the placeholder has no session to open. */
  async healthCheck(): Promise<HealthCheckResult> {
    return { ok: false, error: { class: 'unknown', message: NO_SESSION } };
  }

  /**
   * Rejects: the placeholder has no session. A {@link StreamingSTTChain} then
   * tries its next provider.
   */
  async startSession(): Promise<StreamingSTTSession> {
    throw new Error(NO_SESSION);
  }
}
