/**
 * @module voice-pipeline/TtsUsageMeter
 *
 * Supplier synthesis quantities for one call, from the producer's scoped
 * {@link StreamingTTSUsageEvent} reports: accepted characters, generated
 * samples, the request identity and its final status. Reports are cumulative
 * per request, so a repeated report counts once; a request's turn, fences and
 * sample rate never change, its counts never decrease, and a final report is
 * immutable. Cancelled and abandoned synthesis keeps the work it reported,
 * and a request without its final report stays pending rather than being
 * estimated from playback.
 */

import { copyAudioIdentity, sameVoiceGeneration, type StreamingTTSUsageEvent } from './types.js';

/** Cumulative, idempotent supplier quantities. Missing final usage stays pending, never inferred from playback. */
export class TtsUsageMeter {
  private readonly rows = new Map<string, StreamingTTSUsageEvent>();

  /**
   * Binds the meter to one call of one scope.
   *
   * @param scopeId - The scope every report must carry.
   * @param callId - The call every report must carry.
   * @param maxRequests - Most distinct synthesis requests the meter holds.
   * @throws {Error} When an id is empty or `maxRequests` is not a positive safe integer.
   */
  constructor(private readonly scopeId: string, private readonly callId: string, private readonly maxRequests: number) {
    if (!scopeId || !callId || !Number.isSafeInteger(maxRequests) || maxRequests <= 0) throw new Error('invalid usage bound');
  }

  /** Accepts a scoped producer report, including final work from a cancelled inference generation. */
  record(event: StreamingTTSUsageEvent): void {
    if (event.scopeId !== this.scopeId || event.callId !== this.callId) throw new Error('foreign usage');
    const identity = copyAudioIdentity(event);
    if (!event.providerId || !event.requestId || event.providerId.length > 128 || event.requestId.length > 128 || ![event.acceptedCharacters, event.generatedSamples, event.sampleRate].every(Number.isSafeInteger) || event.acceptedCharacters < 0 || event.generatedSamples < 0 || event.sampleRate <= 0 || !['running', 'completed', 'cancelled', 'failed'].includes(event.status) || event.final !== (event.status !== 'running')) throw new Error('invalid synthesis usage');
    const key = JSON.stringify([event.providerId, event.requestId]);
    const previous = this.rows.get(key);
    if (!previous && this.rows.size >= this.maxRequests) throw new Error('usage request bound');
    if (previous && (previous.turnId !== event.turnId || !sameVoiceGeneration(previous.generation, event.generation) || previous.sampleRate !== event.sampleRate || event.acceptedCharacters < previous.acceptedCharacters || event.generatedSamples < previous.generatedSamples || (previous.final && (event.status !== previous.status || event.acceptedCharacters !== previous.acceptedCharacters || event.generatedSamples !== previous.generatedSamples)))) throw new Error('conflicting synthesis usage');
    this.rows.set(key, { ...event, ...identity });
  }

  /** A private copy for a durable usage sink. */
  snapshot(): StreamingTTSUsageEvent[] {
    return [...this.rows.values()].map((row) => ({ ...row, generation: { ...row.generation } }));
  }

  /** Counts supplier work separately from customer connected minutes and acknowledged playback. */
  totals(): { acceptedCharacters: number; generatedSeconds: number; requests: number; pending: number } {
    let acceptedCharacters = 0;
    let generatedSeconds = 0;
    let pending = 0;
    for (const row of this.rows.values()) {
      acceptedCharacters += row.acceptedCharacters;
      generatedSeconds += row.generatedSamples / row.sampleRate;
      if (!row.final) pending++;
    }
    return { acceptedCharacters, generatedSeconds, requests: this.rows.size, pending };
  }
}
