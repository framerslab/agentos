/**
 * @module voice-pipeline/__tests__/HeuristicEndpointDetector.spec
 *
 * Unit tests for HeuristicEndpointDetector.
 *
 * ## What is tested
 *
 * - Mode property returns 'heuristic'
 * - The constructor refuses a silence timeout that is negative, NaN or Infinity, and takes zero
 * - Terminal punctuation (., ?, !) triggers immediate turn_complete with reason 'punctuation'
 * - Correct transcript text and confidence are carried in the turn_complete event
 * - Backchannel phrases are detected, suppressed from accumulation, and emitted separately
 * - Backchannel matching is case-insensitive and whitespace-tolerant
 * - Once an agent context is set, a backchannel said while the agent holds the floor is recognized whatever its
 *   trailing punctuation (. , ! and the ellipsis), and a final that ends with a question mark, after any spaces or
 *   other punctuation, is never one
 * - Silence timeout fallback fires turn_complete with reason 'silence_timeout'
 * - No turn_complete fires without accumulated text
 * - No turn_complete fires for interim (non-final) transcripts
 * - speech_start cancels a pending silence timer
 * - reset() clears accumulated text and cancels pending timers
 * - Finals keyed by item, as OpenAI Realtime sends them after each end of speech
 * - An item final that comes before its end of speech, and one left over from a completed turn, reported as late_final,
 *   also when it arrives while the transcriber reports the next utterance; a standalone VAD's start of speech ends
 *   that window
 * - Each late_final listener gets the final when one before it throws; the throw is written as a console warning
 * - By the agent's context (setAgentContext()): a backchannel is dropped only while the agent holds the floor, and
 *   while the agent listens a lone one is the user's turn whatever its last reply asked, keyed by an item or not;
 *   isBackchannel() answers by the same rule; a turn's end keeps the context
 * - Until a context is set, and again after a reset for a new session, a backchannel is its exact phrase, trimmed
 *   and lowercased, dropped whatever the agent is doing, keyed by an item or not, as before the context existed
 *
 * The silence_timeout cases use a 100 ms detector instance and a short
 * setTimeout await -- fast enough for CI while remaining deterministic. The
 * item-keyed cases run on a fake clock; the rest use real timers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HeuristicEndpointDetector } from '../HeuristicEndpointDetector.js';
import type { TranscriptEvent, TurnCompleteEvent, VadEvent } from '../types.js';

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

/** Build a final from a provider that keys its results by item, as OpenAI Realtime does; `startMs` when it knows the start. */
function itemFinal(text: string, itemId: string, startMs?: number): TranscriptEvent {
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

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])('refuses a silenceTimeoutMs of %s', (silenceTimeoutMs) => {
    expect(() => new HeuristicEndpointDetector({ silenceTimeoutMs })).toThrow(RangeError);
  });

  it('accepts a silenceTimeoutMs of zero, which waits for no late final', () => {
    expect(new HeuristicEndpointDetector({ silenceTimeoutMs: 0 }).turnCompletionTimeoutMs).toBe(0);
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

  /**
   * Providers punctuate a backchannel differently: once a caller sets the agent's context, as the orchestrator does
   * at a session's start, the phrase is read trimmed, lowercased and without trailing punctuation (. , ! and the
   * ellipsis), so each of these, said while the agent holds the floor, is one, as "yeah" is.
   */
  it.each(['Sure.', 'Yeah!', 'Uh huh,', 'Right...', 'Mm hmm\u2026', 'Yep !'])(
    'should detect %j as a backchannel phrase, whatever its trailing punctuation, once the agent context is set',
    (text) => {
      const backchannel = vi.fn();
      const turn = vi.fn();
      detector.on('backchannel_detected', backchannel);
      detector.on('turn_complete', turn);
      detector.setAgentContext({ speaking: true, askedQuestion: false });

      detector.pushTranscript(transcript(text));
      detector.pushVadEvent(speechEnd());

      expect(backchannel).toHaveBeenCalledWith({ text });
      expect(turn).not.toHaveBeenCalled();
    },
  );

  /**
   * A question mark is never stripped: a final that ends with one, after any spaces or other trailing punctuation,
   * asks something, so it is the user's turn and not an acknowledgement, even said while the agent holds the floor.
   */
  it.each(['Okay?', 'Right?!', 'Yeah ?'])(
    'should not take %j, which ends with a question mark, for a backchannel phrase',
    (text) => {
      const backchannel = vi.fn();
      const turn = vi.fn();
      detector.on('backchannel_detected', backchannel);
      detector.on('turn_complete', turn);
      detector.setAgentContext({ speaking: true, askedQuestion: false });

      detector.pushTranscript(transcript(text));
      detector.pushVadEvent(speechEnd());

      expect(backchannel).not.toHaveBeenCalled();
      expect(turn).toHaveBeenCalledWith(expect.objectContaining({ transcript: text, reason: 'punctuation' }));
    },
  );

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

  it('orders clauses by their start when a final with no words has no start', () => {
    const handler = vi.fn();
    detector.on('turn_complete', handler);

    for (let utterance = 0; utterance < 3; utterance++) {
      detector.pushVadEvent(transcriberSpeech('speech_start'));
      detector.pushVadEvent(transcriberSpeech('speech_end'));
    }
    detector.pushTranscript(itemFinal('At seven tonight.', 'item_B', 1_300));
    detector.pushTranscript(itemFinal('', 'item_X')); // interim text taken back, for an item with no known start
    detector.pushTranscript(itemFinal('Book a table for two.', 'item_A', 0));

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].transcript).toBe('Book a table for two. At seven tonight.');
  });

  it('keeps clauses in the order they began around a final with words and no start', () => {
    const handler = vi.fn();
    detector.on('turn_complete', handler);

    for (let utterance = 0; utterance < 3; utterance++) {
      detector.pushVadEvent(transcriberSpeech('speech_start'));
      detector.pushVadEvent(transcriberSpeech('speech_end'));
    }
    detector.pushTranscript(itemFinal('at seven tonight.', 'item_C', 2_600));
    detector.pushTranscript(itemFinal('on Friday', 'item_X')); // an item with no known start keeps its place
    detector.pushTranscript(itemFinal('Book a table for two', 'item_A', 0));

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toMatchObject({
      transcript: 'Book a table for two on Friday at seven tonight.',
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

  it('ends the turn at once at the end of speech when its final came before it', () => {
    const handler = vi.fn();
    detector.on('turn_complete', handler);

    detector.pushVadEvent(transcriberSpeech('speech_start'));
    detector.pushTranscript(itemFinal('We start at nine.', 'item_A', 0)); // the final comes while the speech goes on
    detector.pushVadEvent(transcriberSpeech('speech_end'));

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toMatchObject({ transcript: 'We start at nine.', reason: 'punctuation' });
  });

  it('keeps waiting for the next utterance when an earlier final comes later than the silence timeout during it', () => {
    const handler = vi.fn();
    detector.on('turn_complete', handler);

    detector.pushVadEvent(transcriberSpeech('speech_start'));
    detector.pushVadEvent(transcriberSpeech('speech_end'));
    detector.pushVadEvent(transcriberSpeech('speech_start'));
    vi.advanceTimersByTime(1_500); // the first end of speech stops waiting while the second utterance goes on
    detector.pushTranscript(itemFinal('Book a table for two.', 'item_A', 0));
    detector.pushVadEvent(transcriberSpeech('speech_end'));
    // The late final answered its own end of speech, so the second one still waits for its final.
    expect(handler).not.toHaveBeenCalled();

    detector.pushTranscript(itemFinal('At seven tonight.', 'item_B', 1_300));
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].transcript).toBe('Book a table for two. At seven tonight.');
  });

  it('drops a final that arrives after its turn has completed and reports it as late_final, so the next turn holds only its own words', () => {
    const handler = vi.fn();
    const late = vi.fn();
    detector.on('turn_complete', handler);
    detector.on('late_final', late);

    detector.pushVadEvent(transcriberSpeech('speech_start'));
    detector.pushVadEvent(transcriberSpeech('speech_end'));
    detector.pushVadEvent(transcriberSpeech('speech_start'));
    detector.pushTranscript(itemFinal('Book a table for two.', 'item_A', 0));
    detector.pushVadEvent(transcriberSpeech('speech_end')); // the second utterance's final is slow
    vi.advanceTimersByTime(1_000); // so the turn stops waiting for it and ends on the first clause
    expect(handler).toHaveBeenCalledOnce();
    detector.reset(); // as the orchestrator does once the reply has played

    const slow = itemFinal('At seven tonight', 'item_B', 1_300);
    detector.pushTranscript(slow); // the slow final, after its turn
    expect(late).toHaveBeenCalledOnce();
    expect(late.mock.calls[0][0]).toBe(slow); // the final as it arrived, for a listener that keeps every final
    detector.pushVadEvent(transcriberSpeech('speech_start'));
    detector.pushVadEvent(transcriberSpeech('speech_end'));
    detector.pushTranscript(itemFinal('what about Friday', 'item_C', 6_000));
    vi.advanceTimersByTime(1_000);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1][0]).toMatchObject({ transcript: 'what about Friday', reason: 'silence_timeout' });
    expect(late).toHaveBeenCalledOnce(); // the next turn's own final is no late final
  });

  it("drops a completed turn's final that arrives while the next utterance is spoken, and waits for that utterance's own final", () => {
    const handler = vi.fn();
    const late = vi.fn();
    detector.on('turn_complete', handler);
    detector.on('late_final', late);

    detector.pushVadEvent(transcriberSpeech('speech_start'));
    detector.pushVadEvent(transcriberSpeech('speech_end'));
    detector.pushVadEvent(transcriberSpeech('speech_start'));
    detector.pushTranscript(itemFinal('Book a table for two.', 'item_A', 0));
    detector.pushVadEvent(transcriberSpeech('speech_end')); // the second utterance's final is slow
    vi.advanceTimersByTime(1_000); // so the turn stops waiting for it and ends on the first clause
    expect(handler).toHaveBeenCalledOnce();
    detector.reset(); // as the orchestrator does once the reply has played

    detector.pushVadEvent(transcriberSpeech('speech_start')); // the user speaks again
    const slow = itemFinal('At seven tonight.', 'item_B', 1_300);
    detector.pushTranscript(slow); // the first turn's slow final, while the next utterance is spoken
    expect(late).toHaveBeenCalledOnce();
    expect(late.mock.calls[0][0]).toBe(slow);
    detector.pushVadEvent(transcriberSpeech('speech_end'));
    // The slow final paid no end of speech: the turn waits for its own utterance's final.
    expect(handler).toHaveBeenCalledOnce();

    detector.pushTranscript(itemFinal('What about Friday?', 'item_C', 6_000));
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1][0]).toMatchObject({ transcript: 'What about Friday?', reason: 'punctuation' });
    expect(late).toHaveBeenCalledOnce();
  });

  it('keeps a final that comes before its end of speech after a turn in which no speech started, and decides at that end', () => {
    const handler = vi.fn();
    const late = vi.fn();
    detector.on('turn_complete', handler);
    detector.on('late_final', late);

    // A transcriber with client commits reports no speech; a listen session's stop supplies the end of speech.
    detector.pushTranscript(itemFinal('We start at nine.', 'item_A', 0));
    detector.pushVadEvent(transcriberSpeech('speech_end'));
    expect(handler).toHaveBeenCalledOnce();

    detector.pushTranscript(itemFinal('Then lunch.', 'item_B', 4_000)); // after that turn's reset
    detector.pushVadEvent(transcriberSpeech('speech_end'));
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1][0]).toMatchObject({ transcript: 'Then lunch.', reason: 'punctuation' });
    expect(late).not.toHaveBeenCalled();
  });

  it("keeps an utterance's final that comes before a standalone VAD reports the end of speech, after a completed turn", () => {
    const handler = vi.fn();
    const late = vi.fn();
    detector.on('turn_complete', handler);
    detector.on('late_final', late);

    // The host drives the detector with its own VAD (source 'vad'), whose speech events pair with no final.
    detector.pushVadEvent(speechStart());
    detector.pushTranscript(itemFinal('Book a table for two.', 'item_A', 0));
    detector.pushVadEvent(speechEnd());
    expect(handler).toHaveBeenCalledOnce();

    detector.pushVadEvent(speechStart());
    detector.pushTranscript(itemFinal('What about Friday?', 'item_B', 6_000)); // before the VAD reports the end
    detector.pushVadEvent(speechEnd());
    expect(late).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1][0]).toMatchObject({ transcript: 'What about Friday?', reason: 'punctuation' });
  });

  it("keeps an utterance's slow final when a reset came while the utterance was spoken", () => {
    const handler = vi.fn();
    detector.on('turn_complete', handler);

    detector.pushVadEvent(transcriberSpeech('speech_start'));
    detector.reset(); // as the orchestrator does when the user barges in on the reply
    detector.pushVadEvent(transcriberSpeech('speech_end'));
    vi.advanceTimersByTime(1_500); // the transcript comes later than the silence timeout
    detector.pushTranscript(itemFinal('Stop, I meant Friday.', 'item_A', 0));

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].transcript).toBe('Stop, I meant Friday.');
  });

  it('hands a late final to every late_final listener when one throws, and throws nothing into the code that pushed it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const kept = vi.fn();
      detector.on('late_final', () => {
        throw new Error('a listener failed');
      });
      detector.on('late_final', kept);

      detector.pushVadEvent(transcriberSpeech('speech_start'));
      detector.pushVadEvent(transcriberSpeech('speech_end'));
      detector.pushTranscript(itemFinal('Book a table for two.', 'item_A', 0)); // ends the turn, and the reset with it

      const slow = itemFinal('At seven tonight.', 'item_B', 1_300);
      expect(() => detector.pushTranscript(slow)).not.toThrow();
      expect(kept).toHaveBeenCalledOnce();
      expect(kept.mock.calls[0][0]).toBe(slow);
      expect(warn.mock.calls.map((args) => args.join(' '))).toEqual([expect.stringContaining('a listener failed')]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("HeuristicEndpointDetector: backchannels by the agent's context", () => {
  let detector: HeuristicEndpointDetector;
  let turns: string[];
  let backchannels: string[];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    detector = new HeuristicEndpointDetector({ silenceTimeoutMs: 1_000 });
    turns = [];
    backchannels = [];
    detector.on('turn_complete', (event: TurnCompleteEvent) => turns.push(event.transcript));
    detector.on('backchannel_detected', (event: { text: string }) => backchannels.push(event.text));
  });

  afterEach(() => {
    detector.reset();
    vi.useRealTimers();
  });

  it('keeps a lone backchannel that answers a question, keyed by an item or not, as a turn that completes at its end of speech', () => {
    detector.setAgentContext({ speaking: false, askedQuestion: true });

    detector.pushVadEvent(transcriberSpeech('speech_start'));
    detector.pushTranscript(transcript('yeah'));
    detector.pushVadEvent(transcriberSpeech('speech_end'));
    vi.advanceTimersByTime(1_000); // no terminal punctuation: the silence timeout ends the turn

    detector.pushVadEvent(transcriberSpeech('speech_start'));
    detector.pushVadEvent(transcriberSpeech('speech_end'));
    detector.pushTranscript(itemFinal('Sure.', 'item_A', 0));

    expect(turns).toEqual(['yeah', 'Sure.']);
    expect(backchannels).toEqual([]);
  });

  it('drops a backchannel while the agent speaks, keyed by an item or not, whatever its last reply asked', () => {
    detector.setAgentContext({ speaking: true, askedQuestion: true });

    detector.pushVadEvent(transcriberSpeech('speech_start'));
    detector.pushTranscript(transcript('Okay!'));
    detector.pushVadEvent(transcriberSpeech('speech_end'));
    detector.pushVadEvent(transcriberSpeech('speech_start'));
    detector.pushVadEvent(transcriberSpeech('speech_end'));
    detector.pushTranscript(itemFinal('uh huh', 'item_A', 0));
    vi.advanceTimersByTime(1_000);

    expect(backchannels).toEqual(['Okay!', 'uh huh']);
    expect(turns).toEqual([]);
  });

  it("answers isBackchannel() by the same rule: the exact phrase until a context is set, then the reading while the agent holds the floor and nothing while it listens, by a context a turn's end keeps and a session's start unsets", () => {
    // Before any report: the whole text, trimmed and lowercased, is a phrase, whatever the agent is doing.
    expect(detector.isBackchannel(' Sure ')).toBe(true);
    expect(detector.isBackchannel('Sure.')).toBe(false);
    expect(detector.isBackchannel('Sure thing.')).toBe(false);

    // The agent holds the floor: the phrase without its trailing punctuation, whatever the agent's last reply asked.
    detector.setAgentContext({ speaking: true, askedQuestion: true });
    expect(detector.isBackchannel('Sure.')).toBe(true);
    expect(detector.isBackchannel('Mm-hmm...')).toBe(true);
    // A question mark is never stripped, after spaces or other punctuation either.
    expect(detector.isBackchannel('Sure?')).toBe(false);
    expect(detector.isBackchannel('Sure? ')).toBe(false);
    expect(detector.isBackchannel('Sure?!')).toBe(false);
    expect(detector.isBackchannel('Mm-hmm?')).toBe(false);
    detector.reset();
    expect(detector.isBackchannel('Sure.')).toBe(true);

    // The agent listens: the user holds the floor, so no final is a backchannel, after a statement or a question.
    detector.setAgentContext({ speaking: false, askedQuestion: false });
    expect(detector.isBackchannel('sure')).toBe(false);
    expect(detector.isBackchannel('Uh huh.')).toBe(false);
    detector.setAgentContext({ speaking: false, askedQuestion: true });
    expect(detector.isBackchannel('sure')).toBe(false);
    detector.reset();
    expect(detector.isBackchannel('sure')).toBe(false);

    detector.reset('session');
    expect(detector.isBackchannel('Sure.')).toBe(false);
    expect(detector.isBackchannel('sure')).toBe(true);
  });

  it('drops only the exact phrase until a context is set, drops "Sure." once one is, and only the exact phrase again after a reset for a new session', () => {
    // No context set, as before the context existed: "sure" is a backchannel, and "Sure." is the user's turn.
    detector.pushVadEvent(transcriberSpeech('speech_start'));
    detector.pushTranscript(transcript('sure'));
    detector.pushVadEvent(transcriberSpeech('speech_end'));
    detector.pushVadEvent(transcriberSpeech('speech_start'));
    detector.pushTranscript(transcript('Sure.'));
    detector.pushVadEvent(transcriberSpeech('speech_end'));
    expect(backchannels).toEqual(['sure']);
    expect(turns).toEqual(['Sure.']);

    // Once a context is set, "Sure." is a backchannel too.
    detector.setAgentContext({ speaking: true, askedQuestion: false });
    detector.pushVadEvent(transcriberSpeech('speech_start'));
    detector.pushTranscript(transcript('Sure.'));
    detector.pushVadEvent(transcriberSpeech('speech_end'));
    vi.advanceTimersByTime(1_000);
    expect(backchannels).toEqual(['sure', 'Sure.']);
    expect(turns).toEqual(['Sure.']);

    // A reset for a new session unsets the context: "Sure." is the user's turn again.
    detector.reset('session');
    detector.pushVadEvent(transcriberSpeech('speech_start'));
    detector.pushTranscript(transcript('Sure.'));
    detector.pushVadEvent(transcriberSpeech('speech_end'));
    expect(backchannels).toEqual(['sure', 'Sure.']);
    expect(turns).toEqual(['Sure.', 'Sure.']);
  });

  it('drops an item-keyed final by its exact phrase while no context is set, and keeps "Uh huh." as the turn, as before', () => {
    detector.pushVadEvent(transcriberSpeech('speech_start'));
    detector.pushVadEvent(transcriberSpeech('speech_end'));
    detector.pushTranscript(itemFinal('uh huh', 'item_A', 0));
    detector.pushVadEvent(transcriberSpeech('speech_start'));
    detector.pushVadEvent(transcriberSpeech('speech_end'));
    detector.pushTranscript(itemFinal('Uh huh.', 'item_B', 1_000));

    expect(backchannels).toEqual(['uh huh']);
    expect(turns).toEqual(['Uh huh.']);
  });
});
