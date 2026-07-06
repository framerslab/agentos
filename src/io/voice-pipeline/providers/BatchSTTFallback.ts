/**
 * @module voice-pipeline/providers/BatchSTTFallback
 *
 * Wraps multiple {@link IBatchSTT} providers in priority order. Tries each in
 * sequence; returns the first successful transcription. Throws an aggregate
 * error if every provider fails.
 *
 * A provider MAY signal "the clip contained no speech" by throwing
 * {@link EmptyTranscriptError}. That is a REAL result (silence), not a provider
 * failure, so the fallback rethrows it immediately instead of burning the next
 * provider on the same silent audio.
 */

import type { IBatchSTT, BatchSTTConfig, BatchSTTResult } from '../types.js';

/**
 * Thrown by a batch STT provider when the audio yielded no transcript. Callers
 * distinguish it from transport/HTTP failures: it is a determinate result (the
 * speaker was silent) and must NOT trigger a fallback to another provider.
 */
export class EmptyTranscriptError extends Error {
  readonly provider: string;
  constructor(provider: string) {
    super('empty_transcript');
    this.name = 'EmptyTranscriptError';
    this.provider = provider;
  }
}

export class BatchSTTFallback implements IBatchSTT {
  readonly providerId = 'fallback';
  private readonly providers: IBatchSTT[];

  constructor(providers: IBatchSTT[]) {
    this.providers = providers;
  }

  async transcribe(audio: Buffer, config?: BatchSTTConfig): Promise<BatchSTTResult> {
    if (this.providers.length === 0) {
      throw new Error('No STT providers configured');
    }

    const errors: Array<{ provider: string; error: Error }> = [];

    for (const provider of this.providers) {
      try {
        return await provider.transcribe(audio, config);
      } catch (err) {
        // A silent clip is a determinate result — surface it immediately
        // rather than retrying the same audio against the next provider.
        if (err instanceof EmptyTranscriptError) throw err;
        errors.push({
          provider: provider.providerId,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }

    const summary = errors.map((e) => `${e.provider}: ${e.error.message}`).join('; ');
    throw new Error(`All STT providers failed: ${summary}`);
  }
}
