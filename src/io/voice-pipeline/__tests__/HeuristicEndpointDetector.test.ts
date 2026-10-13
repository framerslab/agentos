/**
 * @module voice-pipeline/__tests__/HeuristicEndpointDetector.spec
 *
 * Unit tests for HeuristicEndpointDetector.
 *
 * ## What is tested
 *
 * - Mode property returns 'heuristic'
 * - The constructor refuses a silence timeout that is not a positive, finite number
 * - Terminal punctuation (., ?, !) triggers immediate turn_complete with reason 'punctuation'
 * - Correct transcript text and confidence are carried in the turn_complete event
 * - Backchannel phrases are detected, suppressed from accumulation, and emitted separately
 * - Backchannel matching is case-insensitive and whitespace-tolerant
 * - Silence timeout fallback fires turn_complete with reason 'silence_timeout'
 * - No turn_complete fires without accumulated text
 * - No turn_complete fires for interim (non-final) transcripts
 * - speech_start cancels a pending silence timer
 * - reset() clears accumulated text and cancels pending timers
 * - Finals keyed by item, as OpenAI Realtime sends them after each end of speech
 *
 * The silence_timeout cases use a 100 ms detector instance and a short
 * setTimeout await -- fast enough for CI while remaining deterministic. The
 * item-keyed cases run on a fake clock; the rest use real timers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HeuristicEndpointDetector } from '../HeuristicEndpointDetector.js';
import type { TranscriptEvent, VadEvent } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal final TranscriptEvent with sensible defaults. */
function transcript(text: string, isFinal = true): TranscriptEvent {
  return { text, confidence: 0.9, words: [], isFinal };
}

/** Build a speech_end VadEvent at the current time. */
function speechEnd(): VadEvent {
  return { type: 'speech_end', timestamp: Date.now(), source: 'vad' };
}

/** Build a speech_start VadEvent at the current time. */
function speechStart(): VadEvent {
  return { type: 'speech_start', timestamp: Date.now(), source: 'vad' };
}

/** Build a final from a provider that keys its results by item, as OpenAI Realtime does. */
function itemFinal(text: string, itemId: string, startMs: number): TranscriptEvent {
  return { text, confidence: 0.9, words: [], isFinal: true, itemId, startMs };
}

/** Build a speech event the transcriber reported, as the orchestrator forwards it. */
function transcriberSpeech(type: 'speech_start' | 'speech_end'): VadEvent {
  return { type, timestamp: Date.now(), source: 'stt' };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('HeuristicEndpointDetector', () => {
  let detector: HeuristicEndpointDetector;

  beforeEach(() => {
    detector = new HeuristicEndpointDetector();
  });

  afterEach(() => {
    // Ensure any pending timers are cancelled and state is clean.
    detector.reset();
  });

  // -------------------------------------------------------------------------
  // Basic identity
  // -------------------------------------------------------------------------

  it('should report mode as "heuristic"', () => {
    expect(detector.mode).toBe('heuristic');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1])('refuses a silenceTimeoutMs of %s', (silenceTimeoutMs) => {
    expect(() => new HeuristicEndpointDetector({ silenceTimeoutMs })).toThrow(RangeError);
  });

  it('takes the default silence timeout when silenceTimeoutMs is undefined', () => {
    expect(new HeuristicEndpointDetector({ silenceTimeoutMs: undefined }).turnCompletionTimeoutMs).toBe(1_500);
  });

  // -------------------------------------------------------------------------
  // Punctuation-triggered completion
  // -------------------------------------------------------------------------

  it('should emit turn_complete with reason "punctuation" when transcript ends with period', () => {
    const handler = vi.fn();
    detector.on('turn_complete', handler);

    detector.pushTranscript({ text: 'Hello there.', confidence: 0.95, words: [], isFinal: true });
    detector.pushVadEvent({ type: 'speech_end', timestamp: Date.now(), source: 'vad' });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].reason).toBe('punctuation');
    expect(handler.mock.calls[0][0].transcript).toBe('Hello there.');
  });

  it('should emit turn_complete with reason "punctuation" when transcript ends with question mark', () => {
    const handler = vi.fn();
    detector.on('turn_complete', handler);

    detector.pushTranscript(transcript('Are you there?'));
    detector.pushVadEvent(speechEnd());

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].reason).toBe('punctuation');
  });

  it('should emit turn_complete with reason "punctuation" when transcript ends with exclamation mark', () => {
    const handler = vi.fn();
    detector.on('turn_complete', handler);

    detector.pushTranscript(transcript('Watch out!'));
    detector.pushVadEvent(speechEnd());

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].reason).toBe('punctuation');
  });

  it('should include the accumulated transcript text in the turn_complete event', () => {
    const handler = vi.fn();
    detector.on('turn_complete', handler);

    detector.pushTranscript(transcript('Testing one two three.'));
    detector.pushVadEvent(speechEnd());

    expect(handler.mock.calls[0][0].transcript).toBe('Testing one two three.');
  });

  it('should include the STT confidence score in the turn_complete event', () => {
    const handler = vi.fn();
    detector.on('turn_complete', handler);

    detector.pushTranscript({ text: 'Hello.', confidence: 0.77, words: [], isFinal: true });
    detector.pushVadEvent(speechEnd());

    expect(handler.mock.calls[0][0].confidence).toBe(0.77);
  });

  // -------------------------------------------------------------------------
  // Backchannel detection
  // -------------------------------------------------------------------------

  /**
   * Backchannel phrases like "uh huh" should be detected and suppressed from
   * accumulation. This prevents a subsequent speech_end from triggering
   * turn_complete for what was merely an acknowledgement.
   */
  it('should detect "uh huh" as backchannel and suppress turn_complete', () => {
    const bcHandler = vi.fn();
    const tcHandler = vi.fn();
    detector.on('backchannel_detected', bcHandler);
    detector.on('turn_complete', tcHandler);

    detector.pushTranscript({ text: 'uh huh', confidence: 0.8, words: [], isFinal: true });
    detector.pushVadEvent(speechEnd());

    expect(bcHandler).toHaveBeenCalledOnce();
    expect(bcHandler.mock.calls[0][0].text).toBe('uh huh');
    // turn_complete must NOT fire because backchannel suppresses accumulation
    expect(tcHandler).not.toHaveBeenCalled();
  });

  it('should detect "yeah" as a backchannel phrase', () => {
    const handler = vi.fn();
    detector.on('backchannel_detected', handler);

    detector.pushTranscript(transcript('yeah'));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('should detect "okay" as a backchannel phrase', () => {
    const handler = vi.fn();
    detector.on('backchannel_detected', handler);
    detector.pushTranscript(transcript('okay'));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('should detect "ok" as a backchannel phrase', () => {
    const handler = vi.fn();
    detector.on('backchannel_detected', handler);
    detector.pushTranscript(transcript('ok'));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('should detect "mm hmm" as a backchannel phrase', () => {
    const handler = vi.fn();
    detector.on('backchannel_detected', handler);
    detector.pushTranscript(transcript('mm hmm'));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('should detect "mm-hmm" as a backchannel phrase', () => {
    const handler = vi.fn();
    detector.on('backchannel_detected', handler);
    detector.pushTranscript(transcript('mm-hmm'));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('should detect "gotcha" as a backchannel phrase', () => {
    const handler = vi.fn();
    detector.on('backchannel_detected', handler);
    detector.pushTranscript(transcript('gotcha'));
    expect(handler).toHaveBeenCalledOnce();
  });

  /** Backchannel matching must be case-insensitive and trim whitespace. */
  it('should match backchannel phrases case-insensitively with trimmed whitespace', () => {
    const handler = vi.fn();
    detector.on('backchannel_detected', handler);
    detector.pushTranscript(transcript('  Uh Huh  '));
    expect(handler).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Silence timeout fallback
  // -------------------------------------------------------------------------

  /**
   * When no terminal punctuation is present, the detector should wait for
   * silenceTimeoutMs after speech_end before firing turn_complete. This is
   * the fallback path for STT providers that don't punctuate reliably.
   */
  it('should fall back to silence timeout when no terminal punctuation is detected', async () => {
    detector = new HeuristicEndpointDetector({ silenceTimeoutMs: 100 });
    const handler = vi.fn();
    detector.on('turn_complete', handler);

    detector.pushTranscript({ text: 'well I think', confidence: 0.85, words: [], isFinal: true });
    detector.pushVadEvent({ type: 'speech_end', timestamp: Date.now(), source: 'vad' });

    // Must not fire synchronously -- the silence timer has just started
    expect(handler).not.toHaveBeenCalled();

    // Wait for the silence timeout to elapse
    await new Promise<void>((r) => setTimeout(r, 150));

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].reason).toBe('silence_timeout');
  });

  it('should carry the correct transcript text in silence_timeout turn_complete', async () => {
    detector = new HeuristicEndpointDetector({ silenceTimeoutMs: 100 });
    const handler = vi.fn();
    detector.on('turn_complete', handler);

    detector.pushTranscript(transcript('no punctuation here'));
    detector.pushVadEvent(speechEnd());

    await new Promise<void>((r) => setTimeout(r, 150));

    expect(handler.mock.calls[0][0].transcript).toBe('no punctuation here');
  });

  // -------------------------------------------------------------------------
  // Guard: no emission without accumulated text
  // -------------------------------------------------------------------------

  it('should not emit turn_complete when speech_end arrives without prior transcript', () => {
    const handler = vi.fn();
    detector.on('turn_complete', handler);

    // Push speech_end with no prior transcript -- nothing to flush
    detector.pushVadEvent(speechEnd());

    expect(handler).not.toHaveBeenCalled();
  });

  /** Interim transcripts are unstable and must not trigger turn_complete. */
  it('should not emit turn_complete for interim (non-final) transcripts', () => {
    const handler = vi.fn();
    detector.on('turn_complete', handler);

    detector.pushTranscript({ text: 'hello.', confidence: 0.9, words: [], isFinal: false });
    detector.pushVadEvent(speechEnd());

    expect(handler).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // speech_start cancels pending silence timer
  // -------------------------------------------------------------------------

  /**
   * If the user resumes speaking before the silence timeout elapses,
   * the timer should be cancelled and turn_complete should NOT fire.
   * This prevents mid-sentence false positives during natural pauses.
   */
  it('should cancel pending silence timer when speech_start arrives', async () => {
    detector = new HeuristicEndpointDetector({ silenceTimeoutMs: 100 });
    const handler = vi.fn();
    detector.on('turn_complete', handler);

    detector.pushTranscript(transcript('mid sentence without punctuation'));
    detector.pushVadEvent({ type: 'speech_end', timestamp: Date.now(), source: 'vad' });

    // User resumes speaking before timeout elapses
    detector.pushVadEvent({ type: 'speech_start', timestamp: Date.now(), source: 'vad' });

    await new Promise<void>((r) => setTimeout(r, 150));

    // Timer was cancelled -- turn_complete should not have fired
    expect(handler).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // reset()
  // -------------------------------------------------------------------------

  it('should clear accumulated text on reset so speech_end no longer triggers turn_complete', () => {
    const handler = vi.fn();
    detector.on('turn_complete', handler);

    detector.pushTranscript(transcript('some text.'));
    detector.reset();

    // After reset, accumulated text is gone -- speech_end should not fire
    detector.pushVadEvent(speechEnd());
    expect(handler).not.toHaveBeenCalled();
  });

  it('should cancel a pending silence timer on reset', async () => {
    detector = new HeuristicEndpointDetector({ silenceTimeoutMs: 100 });
    const handler = vi.fn();
    detector.on('turn_complete', handler);

    detector.pushTranscript(transcript('hello there'));
    detector.pushVadEvent(speechEnd());

    // Timer is now ticking -- reset before it fires
    detector.reset();

    await new Promise<void>((r) => setTimeout(r, 150));
    expect(handler).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Finals keyed by item
// ---------------------------------------------------------------------------

/**
 * A provider that keys its finals by item (OpenAI Realtime) sends each
 * utterance's final after that utterance's end of speech, so the next
 * utterance can begin before the previous final arrives.
 */
describe('HeuristicEndpointDetector: finals keyed by item', () => {
  let detector: HeuristicEndpointDetector;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    detector = new HeuristicEndpointDetector({ silenceTimeoutMs: 1_000 });
  });

  afterEach(() => {
    detector.reset();
    vi.useRealTimers();
  });

  it('records a backchannel final and decides the turn before a backchannel listener can throw', () => {
    const handler = vi.fn();
    detector.on('turn_complete', handler);
    detector.on('backchannel_detected', () => {
      throw new Error('listener failed');
    });

    detector.pushVadEvent(transcriberSpeech('speech_start'));
    detector.pushVadEvent(transcriberSpeech('speech_end'));
    // The next utterance begins before the first one's final arrives.
    detector.pushVadEvent(transcriberSpeech('speech_start'));
    detector.pushTranscript(itemFinal('Book a table for two.', 'item_A', 0));
    detector.pushVadEvent(transcriberSpeech('speech_end'));

    expect(() => detector.pushTranscript(itemFinal('yeah', 'item_B', 1_300))).toThrow('listener failed');
    // The backchannel answered its end of speech, so the turn ended at once on the words before it.
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toMatchObject({ transcript: 'Book a table for two.', reason: 'punctuation' });
  });

  it('waits at most the silence timeout for a missing final after the clock is set back', () => {
    const handler = vi.fn();
    detector.on('turn_complete', handler);

    detector.pushVadEvent(transcriberSpeech('speech_start'));
    detector.pushVadEvent(transcriberSpeech('speech_end'));
    detector.pushVadEvent(transcriberSpeech('speech_start'));
    detector.pushVadEvent(transcriberSpeech('speech_end')); // this utterance's final never comes
    vi.setSystemTime(Date.now() - 60_000); // the clock is set back a minute
    detector.pushTranscript(itemFinal('Book a table for two.', 'item_A', 0));

    vi.advanceTimersByTime(999);
    expect(handler).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].transcript).toBe('Book a table for two.');
  });

  it("replaces an item's text with its next final without answering another end of speech", () => {
    const handler = vi.fn();
    detector.on('turn_complete', handler);

    detector.pushVadEvent(transcriberSpeech('speech_start'));
    detector.pushVadEvent(transcriberSpeech('speech_end'));
    detector.pushVadEvent(transcriberSpeech('speech_start'));
    detector.pushTranscript(itemFinal('Book a table', 'item_A', 0));
    detector.pushVadEvent(transcriberSpeech('speech_end'));
    // A second final for the first item: the second end of speech still waits for its own.
    detector.pushTranscript(itemFinal('Book a table for two.', 'item_A', 0));
    expect(handler).not.toHaveBeenCalled();

    detector.pushTranscript(itemFinal('At seven tonight.', 'item_B', 1_300));
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].transcript).toBe('Book a table for two. At seven tonight.');
  });

  it('keeps the words of a backchannel final out of the turn, and ends no turn on it alone', () => {
    const handler = vi.fn();
    const backchannel = vi.fn();
    detector.on('turn_complete', handler);
    detector.on('backchannel_detected', backchannel);

    detector.pushVadEvent(transcriberSpeech('speech_start'));
    detector.pushVadEvent(transcriberSpeech('speech_end'));
    detector.pushTranscript(itemFinal('yeah', 'item_A', 0));
    expect(backchannel).toHaveBeenCalledWith({ text: 'yeah' });
    expect(handler).not.toHaveBeenCalled();

    detector.pushVadEvent(transcriberSpeech('speech_start'));
    detector.pushVadEvent(transcriberSpeech('speech_end'));
    detector.pushTranscript(itemFinal('What time is it?', 'item_B', 1_300));
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toMatchObject({ transcript: 'What time is it?', reason: 'punctuation' });
  });

  it('joins three utterances in the order they began when their finals arrive out of order', () => {
    const handler = vi.fn();
    detector.on('turn_complete', handler);

    for (let utterance = 0; utterance < 3; utterance++) {
      detector.pushVadEvent(transcriberSpeech('speech_start'));
      detector.pushVadEvent(transcriberSpeech('speech_end'));
    }
    detector.pushTranscript(itemFinal('at seven tonight.', 'item_C', 2_600));
    detector.pushTranscript(itemFinal('Book a table', 'item_A', 0));
    expect(handler).not.toHaveBeenCalled();

    detector.pushTranscript(itemFinal('for two', 'item_B', 1_300));
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toMatchObject({
      transcript: 'Book a table for two at seven tonight.',
      reason: 'punctuation',
    });
  });

  it('lets a final without an itemId replace the turn of item-keyed finals', () => {
    const handler = vi.fn();
    detector.on('turn_complete', handler);

    detector.pushVadEvent(transcriberSpeech('speech_start'));
    detector.pushTranscript(itemFinal('Book a table for two', 'item_A', 0));
    // A provider without item keys takes over, as behind a failover chain: its final stands for the turn.
    detector.pushTranscript(transcript('What time is it?'));
    detector.pushVadEvent(transcriberSpeech('speech_end'));

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toMatchObject({ transcript: 'What time is it?', reason: 'punctuation' });
  });

  it('starts the next turn with no item-keyed finals or waiting ends left after reset()', () => {
    const handler = vi.fn();
    detector.on('turn_complete', handler);

    detector.pushVadEvent(transcriberSpeech('speech_start'));
    detector.pushVadEvent(transcriberSpeech('speech_end'));
    detector.pushVadEvent(transcriberSpeech('speech_start'));
    detector.pushTranscript(itemFinal('Book a table', 'item_A', 0));
    detector.pushVadEvent(transcriberSpeech('speech_end')); // waits for the second utterance's final
    detector.reset();

    detector.pushVadEvent(transcriberSpeech('speech_start'));
    detector.pushVadEvent(transcriberSpeech('speech_end'));
    detector.pushTranscript(itemFinal('What time is it?', 'item_C', 0));
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toMatchObject({ transcript: 'What time is it?', reason: 'punctuation' });

    vi.advanceTimersByTime(5_000);
    expect(handler).toHaveBeenCalledOnce();
  });
});
