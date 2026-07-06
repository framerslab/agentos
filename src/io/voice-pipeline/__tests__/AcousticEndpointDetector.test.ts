/**
 * @module voice-pipeline/__tests__/AcousticEndpointDetector.spec
 *
 * Unit tests for the AcousticEndpointDetector voice-pipeline component.
 *
 * ## What is tested
 *
 * - Mode property returns 'acoustic'
 * - turn_complete fires with reason 'silence_timeout' after utteranceEndThresholdMs
 * - turn_complete does NOT fire before the threshold elapses
 * - speech_start cancels a pending turn_complete timer
 * - speech_start is re-emitted on the detector for pipeline consumers
 * - reset() prevents pending turn_complete from firing
 * - pushTranscript() is a no-op (acoustic mode ignores transcript content)
 * - Custom utteranceEndThresholdMs is honoured
 * - durationMs is correctly computed from speech_start to speech_end timestamps
 *
 * All timer-based behaviour is validated with vitest fake timers to avoid
 * real-time delays in CI.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AcousticEndpointDetector } from '../AcousticEndpointDetector.js';
import type { TurnCompleteEvent, VadEvent, TranscriptEvent } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal VadEvent at the given timestamp (defaults to Date.now()). */
function makeVad(type: VadEvent['type'], timestamp = Date.now()): VadEvent {
  return { type, timestamp };
}

/** Convenience: advance fake timers AND flush the microtask queue. */
async function advance(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms);
  // Let any queued promise callbacks settle
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('AcousticEndpointDetector', () => {
  let detector: AcousticEndpointDetector;

  beforeEach(() => {
    vi.useFakeTimers();
    detector = new AcousticEndpointDetector({
      significantPauseThresholdMs: 500,
      utteranceEndThresholdMs: 1000,
    });
  });

  afterEach(() => {
    detector.reset();
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Basic properties
  // -------------------------------------------------------------------------

  it('should expose mode === "acoustic"', () => {
    expect(detector.mode).toBe('acoustic');
  });

  // -------------------------------------------------------------------------
  // turn_complete after silence
  // -------------------------------------------------------------------------

  /**
   * After speech_end, the SilenceDetector should fire utterance_end_detected
   * once silence exceeds utteranceEndThresholdMs (1000 ms), which the
   * AcousticEndpointDetector translates into a turn_complete event.
   */
  it('should emit turn_complete with reason "silence_timeout" after utteranceEndThresholdMs of silence', async () => {
    const handler = vi.fn<(event: TurnCompleteEvent) => void>();
    detector.on('turn_complete', handler);

    const now = 1_000_000;
    vi.setSystemTime(now);

    detector.pushVadEvent(makeVad('speech_start', now));
    detector.pushVadEvent(makeVad('speech_end', now + 200));

    // Advance past the utteranceEndThresholdMs (1000 ms) + polling interval headroom
    await advance(1500);

    expect(handler).toHaveBeenCalledOnce();
    const event: TurnCompleteEvent = handler.mock.calls[0][0];
    expect(event.reason).toBe('silence_timeout');
  });

  /** Verifies that the timer hasn't fired prematurely before the threshold. */
  it('should NOT emit turn_complete before utteranceEndThresholdMs elapses', async () => {
    const handler = vi.fn();
    detector.on('turn_complete', handler);

    const now = 2_000_000;
    vi.setSystemTime(now);

    detector.pushVadEvent(makeVad('speech_start', now));
    detector.pushVadEvent(makeVad('speech_end', now + 100));

    // Advance to just before the threshold (800 ms < 1000 ms)
    await advance(800);

    expect(handler).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // speech_start cancels pending timer
  // -------------------------------------------------------------------------

  /**
   * If the user resumes speaking before the silence threshold elapses,
   * the pending turn_complete should be cancelled. This prevents false
   * turn-completion during natural mid-sentence pauses.
   */
  it('should cancel pending turn_complete when speech_start arrives before threshold', async () => {
    const handler = vi.fn();
    detector.on('turn_complete', handler);

    const now = 3_000_000;
    vi.setSystemTime(now);

    detector.pushVadEvent(makeVad('speech_start', now));
    detector.pushVadEvent(makeVad('speech_end', now + 200));

    // Advance partway through silence window
    await advance(600);

    // Speech resumes, which should cancel the pending completion
    detector.pushVadEvent(makeVad('speech_start', now + 800));

    // Advance well past threshold -- still no event expected
    await advance(2000);

    expect(handler).not.toHaveBeenCalled();
  });

  /** speech_start events should be re-emitted for barge-in detection. */
  it('should re-emit "speech_start" when a speech_start VAD event is received', () => {
    const handler = vi.fn();
    detector.on('speech_start', handler);

    detector.pushVadEvent(makeVad('speech_start', Date.now()));

    expect(handler).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // reset()
  // -------------------------------------------------------------------------

  it('should prevent a pending turn_complete from firing after reset()', async () => {
    const handler = vi.fn();
    detector.on('turn_complete', handler);

    const now = 4_000_000;
    vi.setSystemTime(now);

    detector.pushVadEvent(makeVad('speech_start', now));
    detector.pushVadEvent(makeVad('speech_end', now + 100));

    // Reset before threshold elapses
    await advance(400);
    detector.reset();

    // Advance well past threshold after reset
    await advance(2000);

    expect(handler).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // pushTranscript is a no-op
  // -------------------------------------------------------------------------

  /** Acoustic mode ignores all transcript content; pushTranscript must not throw. */
  it('should accept pushTranscript() calls without throwing or emitting events', () => {
    const handler = vi.fn();
    detector.on('turn_complete', handler);

    const transcriptEvent: TranscriptEvent = {
      text: 'hello world',
      confidence: 0.95,
      words: [],
      isFinal: true,
    };

    expect(() => detector.pushTranscript(transcriptEvent)).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Configurable thresholds
  // -------------------------------------------------------------------------

  /** A shorter utteranceEndThresholdMs should fire turn_complete sooner. */
  it('should honour a custom utteranceEndThresholdMs', async () => {
    const fastDetector = new AcousticEndpointDetector({
      significantPauseThresholdMs: 100,
      utteranceEndThresholdMs: 300,
    });
    const handler = vi.fn();
    fastDetector.on('turn_complete', handler);

    const now = 5_000_000;
    vi.setSystemTime(now);

    fastDetector.pushVadEvent(makeVad('speech_start', now));
    fastDetector.pushVadEvent(makeVad('speech_end', now + 50));

    // Should NOT fire before 300 ms
    await advance(200);
    expect(handler).not.toHaveBeenCalled();

    // Advance well past threshold + polling interval to ensure timer fires
    await advance(500);
    expect(handler).toHaveBeenCalledOnce();

    fastDetector.reset();
  });

  /**
   * durationMs should be computed as (speechEndTimeMs - speechStartTimeMs),
   * representing the actual speech duration excluding trailing silence.
   */
  it('should include correct durationMs computed from speech_start to speech_end timestamps', async () => {
    const handler = vi.fn<(event: TurnCompleteEvent) => void>();
    detector.on('turn_complete', handler);

    const now = 6_000_000;
    vi.setSystemTime(now);

    detector.pushVadEvent(makeVad('speech_start', now));
    detector.pushVadEvent(makeVad('speech_end', now + 400));

    await advance(1500);

    expect(handler).toHaveBeenCalledOnce();
    const event = handler.mock.calls[0][0];
    // durationMs = speechEndTimeMs - speechStartTimeMs = 400
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
    expect(event.durationMs).toBe(400);
  });
});
