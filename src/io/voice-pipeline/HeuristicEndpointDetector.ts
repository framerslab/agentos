/**
 * @module voice-pipeline/HeuristicEndpointDetector
 *
 * A lightweight, rule-based endpoint detector that combines terminal punctuation
 * analysis with a configurable silence timeout to determine when the user has
 * finished speaking. Suitable for low-latency deployments where an LLM-based
 * semantic detector would add unacceptable round-trip overhead.
 *
 * ## Detection strategy
 *
 * 1. On `speech_end`, if the accumulated final transcript ends with `.`, `?`,
 *    or `!`, fire `turn_complete` immediately with reason `'punctuation'`.
 *    This provides the lowest-latency turn handoff for well-punctuated speech.
 *
 * 2. Otherwise, start a silence timer (default 1,500 ms). If speech does not
 *    resume before the timer fires, emit `turn_complete` with reason
 *    `'silence_timeout'`. The timeout acts as a safety net for STT providers
 *    that don't produce terminal punctuation reliably.
 *
 * 3. Backchannel phrases (e.g. "uh huh", "yeah") are recognised, suppressed
 *    from accumulation, and re-emitted as `'backchannel_detected'` events so
 *    the pipeline can decide whether to suppress an agent response.
 *
 * 4. A `speech_end` that finds no final transcript leaves the decision to the
 *    first final that arrives before speech resumes, for providers that
 *    transcribe an utterance after its end of speech. The silence timeout
 *    still counts from that end of speech. A final with no text (a provider
 *    retracting interim text it showed) adds nothing to the turn's text.
 *
 * 5. Finals that carry an `itemId`, the key a provider gives each utterance
 *    (`OpenAIRealtimeTranscriptionSTT` does, and sends an utterance's final
 *    after its end of speech), are kept per item, and the turn's text joins
 *    them in the order the items began. Such a turn is decided once every
 *    `speech_end` since it began has its final, as a single final is, the
 *    silence counted from the latest `speech_end`; an utterance that starts
 *    before the previous one's final arrives stays in the same turn. An
 *    item's final with no words answers its `speech_end` and adds no text.
 *    A `speech_end` whose final has not come within the silence timeout (an
 *    utterance the provider found no words in gets none) stops holding the
 *    turn. A `speech_end` with `source: 'vad'` (a standalone VAD, or the
 *    orchestrator's turn-duration watchdog) is none of the provider's
 *    utterances, so it decides the turn on the finals held.
 *
 * ## Why heuristic over acoustic-only?
 *
 * Pure silence timeout adds up to 1.5 s of unnecessary latency on every turn
 * when the user ends a sentence cleanly. By checking for terminal punctuation,
 * this detector can fire turn_complete immediately, cutting perceived latency
 * by more than half for typical conversational speech.
 *
 * @see {@link AcousticEndpointDetector} for the purely acoustic alternative.
 * @see {@link IEndpointDetector} for the interface contract.
 */

import { EventEmitter } from 'node:events';
import type { IEndpointDetector, TranscriptEvent, VadEvent, TurnCompleteEvent } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default silence duration (ms) after speech stops before firing `turn_complete`.
 *
 * 1,500 ms was chosen as a balance between:
 * - Too short (< 800 ms): Fires mid-sentence when the user pauses to think.
 * - Too long (> 2,000 ms): Adds noticeable latency, making the agent feel slow.
 *
 * This value is consistent with research on conversational turn-taking gaps
 * (Stivers et al., 2009: modal gap ~200 ms, but STT adds 200-500 ms latency,
 * and users expect the agent to wait slightly longer than a human would).
 */
const DEFAULT_SILENCE_TIMEOUT_MS = 1_500;

/**
 * Regular expression matching terminal punctuation characters that signal
 * sentence completion. Only tested against the final character of the
 * accumulated transcript text.
 *
 * We deliberately exclude semicolons, colons, and ellipses because they
 * rarely indicate turn completion in spoken language.
 */
const TERMINAL_PUNCTUATION = /[.?!]$/;

/**
 * Normalised backchannel phrases that indicate the listener is acknowledging
 * but not taking a full conversational turn. Compared after `.trim().toLowerCase()`.
 *
 * These 13 phrases were selected because:
 * - They are the most common English-language backchannel markers in the
 *   Switchboard and Fisher telephone conversation corpora.
 * - They are short enough that STT providers reliably produce them as
 *   standalone final transcripts (longer phrases like "I see" risk being
 *   part of a larger utterance).
 * - Including both spellings of common variants (e.g. "mm hmm", "mmhmm",
 *   "mm-hmm", "mhm") ensures robust matching across STT providers that
 *   normalise differently.
 *
 * The set is intentionally conservative -- adding phrases like "I see" or
 * "go on" risks false positives when the user is genuinely taking a turn.
 */
const BACKCHANNEL_PHRASES: ReadonlySet<string> = new Set([
  'uh huh',
  'yeah',
  'okay',
  'ok',
  'mm hmm',
  'mmhmm',
  'mhm',
  'mm-hmm',
  'right',
  'sure',
  'yep',
  'yup',
  'gotcha',
]);

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Constructor options for {@link HeuristicEndpointDetector}.
 *
 * @example
 * ```typescript
 * const detector = new HeuristicEndpointDetector({ silenceTimeoutMs: 1000 });
 * ```
 */
export interface HeuristicEndpointDetectorOptions {
  /**
   * How long (ms) to wait after `speech_end` before emitting `turn_complete`
   * when no terminal punctuation is detected. Lower values reduce latency
   * but risk firing mid-sentence during natural pauses. A positive, finite
   * number: the constructor throws a `RangeError` for zero, a negative
   * number, `NaN` or `Infinity`.
   * @defaultValue 1500
   */
  silenceTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Heuristic endpoint detector that uses terminal punctuation and a silence
 * timeout to decide when the user's turn is complete.
 *
 * ## Events emitted
 *
 * | Event                    | Payload                  | Description                        |
 * |--------------------------|--------------------------|------------------------------------|
 * | `'turn_complete'`        | {@link TurnCompleteEvent}| User turn has ended.               |
 * | `'backchannel_detected'` | `{ text: string }`       | Backchannel phrase was recognised.  |
 *
 * @see {@link IEndpointDetector} for the interface contract.
 * @see {@link AcousticEndpointDetector} for the purely acoustic alternative.
 *
 * @example
 * ```typescript
 * const detector = new HeuristicEndpointDetector({ silenceTimeoutMs: 1000 });
 * detector.on('turn_complete', (event) => console.log('Turn done:', event));
 *
 * // Simulate a punctuated sentence followed by speech_end
 * detector.pushTranscript({ text: 'Hello there.', isFinal: true, confidence: 0.95, words: [] });
 * detector.pushVadEvent({ type: 'speech_end', timestamp: Date.now(), source: 'vad' });
 * // -> 'turn_complete' fires immediately with reason 'punctuation'
 * ```
 */
export class HeuristicEndpointDetector extends EventEmitter implements IEndpointDetector {
  /**
   * Active detection strategy label.
   * Always `'heuristic'` for this implementation.
   *
   * See `IEndpointDetector.mode`.
   */
  readonly mode: IEndpointDetector['mode'] = 'heuristic';

  /** Resolved silence timeout in milliseconds. */
  private readonly silenceTimeoutMs: number;

  /**
   * The current turn's text: the latest final transcript without an
   * `itemId`, or the turn's item-keyed finals joined (see {@link itemFinals}).
   * Only updated by final (non-interim) transcript events.
   * Reset to empty string after each `turn_complete` emission.
   */
  private accumulatedText = '';

  /**
   * Whether the VAD currently reports active speech. Set to `true` on
   * `speech_start` and `false` on `speech_end`. Used to prevent the
   * silence timer from starting while the user is still speaking.
   */
  private speechActive = false;

  /**
   * Handle to a pending silence timeout, or `null` if none is running.
   * Cleared when speech resumes or when the detector is reset.
   */
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Wall-clock timestamp (ms) when the current turn's speech started.
   * Used to compute `durationMs` in the emitted {@link TurnCompleteEvent}.
   * `null` when no speech has been detected in the current turn.
   */
  private turnStartMs: number | null = null;

  /**
   * Confidence of the most recent final transcript. Forwarded into the
   * emitted {@link TurnCompleteEvent}. Defaults to 1 (perfect confidence)
   * and is updated with each final transcript event.
   */
  private lastConfidence = 1;

  /**
   * Timestamp of a `speech_end` that found no final transcript, or `null`.
   * Some providers transcribe an utterance only after its end of speech, so
   * the first final without an `itemId` that follows, before speech resumes,
   * is decided as that `speech_end` would have been. Item-keyed finals are
   * decided through {@link unansweredSpeechEnds} instead.
   */
  private speechEndWithoutText: number | null = null;

  /**
   * When the `speech_end` in {@link speechEndWithoutText} arrived, on this
   * detector's own clock (`Date.now()`), so the silence that has passed can
   * be counted when its final arrives. The event's timestamp is the caller's
   * and serves the turn's duration only.
   */
  private speechEndWithoutTextAt = 0;

  /**
   * The current turn's finals that carry an `itemId`, by that id, in the
   * order each item's first final arrived: the text the item adds to the
   * turn (empty for a backchannel or a final with no words) and the item's
   * `startMs`.
   */
  private readonly itemFinals = new Map<string, { text: string; startMs?: number }>();

  /**
   * When the turn's `speech_end` events from the transcriber (any `source`
   * but `'vad'`) that no item-keyed final has answered yet arrived, on this
   * detector's own clock, oldest first. A new item's final answers the
   * oldest; one that has waited the silence timeout is dropped and stops
   * holding the turn.
   */
  private unansweredSpeechEnds: number[] = [];

  /**
   * The turn's latest `speech_end`: its timestamp, for the turn's duration,
   * and when it arrived on this detector's clock, for the silence since.
   * `null` before the turn's first `speech_end`.
   */
  private lastSpeechEnd: { timestamp: number; at: number } | null = null;

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  /**
   * Create a new {@link HeuristicEndpointDetector}.
   *
   * @param options - Optional configuration overrides.
   * @throws {RangeError} When `silenceTimeoutMs` is given and is not a positive, finite number.
   */
  constructor(options: HeuristicEndpointDetectorOptions = {}) {
    super();
    const silenceTimeoutMs = options.silenceTimeoutMs ?? DEFAULT_SILENCE_TIMEOUT_MS;
    // NaN or Infinity never lets a waiting speech end expire, and zero or less never waits for a final.
    if (!Number.isFinite(silenceTimeoutMs) || silenceTimeoutMs <= 0) {
      throw new RangeError(
        `HeuristicEndpointDetector: silenceTimeoutMs must be a positive, finite number, got ${String(silenceTimeoutMs)}`
      );
    }
    this.silenceTimeoutMs = silenceTimeoutMs;
  }

  /** Maximum wait for a pending turn after speech ends, used when draining a listen session. */
  get turnCompletionTimeoutMs(): number {
    return this.silenceTimeoutMs;
  }

  // ---------------------------------------------------------------------------
  // IEndpointDetector -- pushTranscript
  // ---------------------------------------------------------------------------

  /**
   * Ingest a transcript event from the upstream STT session.
   *
   * Only final events (`isFinal: true`) affect internal state. Interim results
   * are silently ignored because:
   * 1. They arrive very frequently (10-50 per second) and would trigger
   *    excessive punctuation checks.
   * 2. Their text is unstable -- a word ending with "." may be revised in
   *    the next interim result, causing false turn-completion signals.
   *
   * If the final text is a recognised backchannel phrase, the detector emits
   * `'backchannel_detected'` and returns WITHOUT accumulating the text. This
   * prevents a subsequent `speech_end` event from triggering `turn_complete`
   * for what was merely an acknowledgement, not a real conversational turn.
   *
   * A final with an `itemId` is kept with the turn's other item-keyed finals,
   * and the turn's text joins them; a final without one replaces the turn's
   * text.
   *
   * @param transcript - Transcript event from the STT session.
   */
  pushTranscript(transcript: TranscriptEvent): void {
    if (!transcript.isFinal) {
      // Ignore partial/interim hypotheses -- they will be superseded by
      // a subsequent final result or revised interim.
      return;
    }

    if (transcript.itemId) {
      this._pushItemFinal(transcript.itemId, transcript);
      return;
    }

    const text = transcript.text;
    const normalised = text.trim().toLowerCase();

    // A final with no words (a provider retracting interim text it showed)
    // leaves the turn's text as it is.
    if (!normalised) return;

    // Check for backchannel phrases BEFORE accumulating. This ensures that
    // "uh huh" followed by speech_end does NOT produce a turn_complete.
    if (BACKCHANNEL_PHRASES.has(normalised)) {
      this.emit('backchannel_detected', { text });
      return;
    }

    // Accumulate the final transcript and store the confidence score.
    // We overwrite (not append) because each final event from the STT
    // provider represents the complete hypothesis for the current utterance.
    this.accumulatedText = text;
    this.lastConfidence = transcript.confidence;
    // The latest final replaces the turn's item-keyed finals as well.
    this.itemFinals.clear();

    // The speech already ended without a transcript: decide the turn now. The
    // silence began at that end of speech, so what has passed since counts.
    if (this.speechEndWithoutText !== null && !this.speechActive) {
      const speechEndTimestamp = this.speechEndWithoutText;
      this.speechEndWithoutText = null;
      this._decideTurnEnd(speechEndTimestamp, Date.now() - this.speechEndWithoutTextAt);
    }
  }

  // ---------------------------------------------------------------------------
  // IEndpointDetector -- pushVadEvent
  // ---------------------------------------------------------------------------

  /**
   * Ingest a VAD (voice activity detection) event.
   *
   * Event handling by type:
   *
   * - **`speech_start`**: Marks the turn as active and cancels any pending
   *   silence timer (the user resumed speaking before the timeout elapsed).
   *   This is critical for avoiding false turn-completion when the user
   *   takes a brief pause mid-sentence.
   *
   * - **`speech_end`**: If accumulated text is available, either fires
   *   `turn_complete` immediately (when text ends with terminal punctuation)
   *   or starts the silence timer (when no punctuation is detected).
   *   Otherwise the first final transcript that arrives before speech
   *   resumes is decided the same way when it arrives, with the silence
   *   timeout still counted from this `speech_end`. A turn of item-keyed
   *   finals is decided once every `speech_end` the transcriber reported
   *   since it began has its final, or has waited the silence timeout for
   *   it. A `speech_end` with `source: 'vad'` (a standalone VAD, or the
   *   orchestrator's turn-duration watchdog) gets no final of its own: it
   *   decides the turn on the finals held, as a single final is decided.
   *
   * - **`silence`**: Periodic heartbeat events are ignored. The silence timer
   *   (started on `speech_end`) already handles delayed turn-completion
   *   independently of heartbeat cadence.
   *
   * @param event - VAD transition event.
   */
  pushVadEvent(event: VadEvent): void {
    switch (event.type) {
      case 'speech_start': {
        this.speechActive = true;
        // A final that arrives from now on belongs to speech still in progress.
        this.speechEndWithoutText = null;
        // Cancel any pending silence timer -- the user is speaking again
        this._clearSilenceTimer();
        // Record turn start only once (first speech_start in this turn)
        if (this.turnStartMs === null) {
          this.turnStartMs = event.timestamp;
        }
        break;
      }

      case 'speech_end': {
        this.speechActive = false;
        const at = Date.now();
        this.lastSpeechEnd = { timestamp: event.timestamp, at };
        // An item-keyed final for the transcriber's speech may still come. An end
        // from a standalone VAD or the orchestrator's turn-duration watchdog
        // (`source: 'vad'`) is none of the provider's utterances and gets none.
        const transcriberEnd = event.source !== 'vad';
        if (transcriberEnd) {
          this._dropExpiredSpeechEnds(at);
          this.unansweredSpeechEnds.push(at);
        }

        // A turn of item-keyed finals is decided once each of the transcriber's speech ends has its final.
        if (this.itemFinals.size > 0 && transcriberEnd) {
          this._decideItemTurn();
          break;
        }

        if (!this.accumulatedText) {
          // No transcript has arrived yet -- nothing to flush now.
          // This can happen when the VAD detects a very short burst of
          // noise that doesn't produce any STT output, or when the
          // provider transcribes the utterance after its end of speech:
          // the first final before speech resumes is decided then.
          this.speechEndWithoutText = event.timestamp;
          this.speechEndWithoutTextAt = Date.now();
          break;
        }

        this._decideTurnEnd(event.timestamp);
        break;
      }

      case 'silence': {
        // Periodic heartbeat -- no action required. The silence timer
        // (if running) handles delayed turn-completion independently.
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // IEndpointDetector -- reset
  // ---------------------------------------------------------------------------

  /**
   * Reset all internal state, cancel pending timers, and prepare the detector
   * for the next user turn.
   *
   * Called by the pipeline after each `turn_complete` event (both internally
   * and by the orchestrator's flush_complete handler) to ensure clean state
   * before audio for the next turn begins to arrive.
   */
  reset(): void {
    this._clearSilenceTimer();
    this.accumulatedText = '';
    this.speechActive = false;
    this.turnStartMs = null;
    this.lastConfidence = 1;
    this.speechEndWithoutText = null;
    this.itemFinals.clear();
    this.unansweredSpeechEnds = [];
    this.lastSpeechEnd = null;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Decide the turn once speech has ended and a final transcript is held:
   * terminal punctuation fires `turn_complete` at once; otherwise the
   * silence timer starts, for what is left of the timeout.
   *
   * @param speechEndTimestamp - Timestamp of the `speech_end`, for the turn's duration.
   * @param silenceSoFarMs - Silence that has already passed since that `speech_end`
   *   (a final that arrived after it); 0 when the decision is made at the `speech_end`.
   */
  private _decideTurnEnd(speechEndTimestamp: number, silenceSoFarMs = 0): void {
    if (TERMINAL_PUNCTUATION.test(this.accumulatedText)) {
      // Sentence-terminal punctuation detected -> fire immediately.
      // This is the fast path that eliminates the 1.5 s silence wait.
      this._emitTurnComplete('punctuation', speechEndTimestamp);
    } else {
      // No terminal punctuation -> start the silence timer.
      // If the user doesn't resume speaking within silenceTimeoutMs,
      // we'll fire turn_complete with reason 'silence_timeout'.
      this._startSilenceTimer(speechEndTimestamp, silenceSoFarMs);
    }
  }

  /**
   * Keep a final that carries an `itemId`. The turn holds one text per item,
   * from the item's latest final, and its text joins them. A new item's
   * final answers the oldest `speech_end` still waiting for one; a
   * backchannel or a final with no words answers it too and adds no text.
   * Once speech has ended in this turn, the turn is decided again. A
   * backchannel is announced last, so a `'backchannel_detected'` listener
   * that throws leaves the final recorded and the turn decided.
   *
   * @param itemId - The provider input item the final belongs to.
   * @param transcript - The final transcript event.
   */
  private _pushItemFinal(itemId: string, transcript: TranscriptEvent): void {
    const normalised = transcript.text.trim().toLowerCase();
    const backchannel = BACKCHANNEL_PHRASES.has(normalised);

    if (!this.itemFinals.has(itemId)) {
      this._dropExpiredSpeechEnds(Date.now());
      this.unansweredSpeechEnds.shift();
    }
    const text = normalised && !backchannel ? transcript.text : '';
    this.itemFinals.set(itemId, { text, startMs: transcript.startMs });
    if (text) this.lastConfidence = transcript.confidence;
    this.accumulatedText = this._joinItemFinals();

    if (!this.speechActive && this.lastSpeechEnd !== null) this._decideItemTurn();

    if (backchannel) this.emit('backchannel_detected', { text: transcript.text });
  }

  /**
   * The turn's item-keyed finals as one text: the texts of those with words,
   * each trimmed, in the order their items began (by `startMs`, or in the
   * order their first finals arrived when one of them has none), with one
   * space between them, so spaces a provider leaves around a final neither
   * pile up between two texts nor hide the turn's terminal punctuation. A
   * final with no words adds nothing, and its item's start plays no part in
   * the order.
   */
  private _joinItemFinals(): string {
    const finals = [...this.itemFinals.values()]
      .map((final) => ({ text: final.text.trim(), startMs: final.startMs }))
      .filter((final) => final.text !== '');
    if (finals.every((final) => final.startMs !== undefined)) {
      // A stable sort: items that began at the same offset keep their arrival order.
      finals.sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0));
    }
    return finals.map((final) => final.text).join(' ');
  }

  /**
   * Decide a turn of item-keyed finals after its latest `speech_end`. While
   * one of the turn's `speech_end` events still waits for its final, the
   * turn waits too, for at most the silence timeout after that `speech_end`:
   * an utterance the provider found no words in gets no final. With none
   * waiting, the joined finals are decided as a single final is, the silence
   * counted from the latest `speech_end`.
   */
  private _decideItemTurn(): void {
    this._clearSilenceTimer();
    const now = Date.now();
    this._dropExpiredSpeechEnds(now);
    if (!this.accumulatedText || this.lastSpeechEnd === null) return;

    if (this.unansweredSpeechEnds.length > 0) {
      // Decide again when the oldest waiting speech end has waited the silence timeout.
      const waitMs = this.unansweredSpeechEnds[0] + this.silenceTimeoutMs - now;
      this.silenceTimer = setTimeout(() => {
        this.silenceTimer = null;
        this._decideItemTurn();
      }, waitMs);
      return;
    }

    this._decideTurnEnd(this.lastSpeechEnd.timestamp, now - this.lastSpeechEnd.at);
  }

  /**
   * Drop the `speech_end` events that have waited the silence timeout for an
   * item-keyed final. A clock set back counts as no silence yet, as in
   * `_startSilenceTimer`: a `speech_end` recorded later than `now` waits
   * from `now`, so a step back delays the turn by at most one more silence
   * timeout, not by the size of the step.
   *
   * @param now - The current time on this detector's clock.
   */
  private _dropExpiredSpeechEnds(now: number): void {
    this.unansweredSpeechEnds = this.unansweredSpeechEnds.map((at) => Math.min(at, now));
    while (
      this.unansweredSpeechEnds.length > 0 &&
      now - this.unansweredSpeechEnds[0] >= this.silenceTimeoutMs
    ) {
      this.unansweredSpeechEnds.shift();
    }
  }

  /**
   * Emit `turn_complete` with the currently accumulated transcript and then
   * reset internal state so the detector is ready for the next turn.
   *
   * The reset happens BEFORE the emit to ensure that any re-entrant listeners
   * (e.g. an endpoint detector handler that immediately calls pushVadEvent)
   * see clean state.
   *
   * @param reason - The semantic reason driving this completion.
   * @param speechEndTimestamp - Unix epoch ms timestamp of the `speech_end` event,
   *   used to compute `durationMs` as `speechEndTimestamp - turnStartMs`.
   */
  private _emitTurnComplete(reason: TurnCompleteEvent['reason'], speechEndTimestamp: number): void {
    // Compute speech duration. Falls back to 0 if no speech_start was recorded
    // (defensive: should not happen in normal operation).
    const durationMs = this.turnStartMs !== null ? speechEndTimestamp - this.turnStartMs : 0;

    const event: TurnCompleteEvent = {
      transcript: this.accumulatedText,
      confidence: this.lastConfidence,
      durationMs,
      reason,
    };

    // Reset before emitting so that any re-entrant listeners see clean state.
    this.reset();

    this.emit('turn_complete', event);
  }

  /**
   * Start the silence-timeout timer. If the user does not resume speaking
   * within `silenceTimeoutMs` ms, the detector fires `turn_complete`
   * with reason `'silence_timeout'`. The timeout counts from the end of
   * speech: when the final arrived after it, the timer runs for what is
   * left, and a timeout that has already passed ends the turn at once.
   *
   * Any previously running silence timer is cleared first to prevent
   * double-fires from rapid speech_end -> speech_start -> speech_end sequences.
   *
   * @param speechEndTimestamp - Timestamp passed through to the internal turn-complete emitter
   *   for duration calculation.
   * @param silenceSoFarMs - Silence that has already passed since the end of speech.
   */
  private _startSilenceTimer(speechEndTimestamp: number, silenceSoFarMs = 0): void {
    this._clearSilenceTimer();
    // A negative value (the clock was set back) counts as no silence yet.
    const silenceMs = Math.max(0, silenceSoFarMs);
    if (silenceMs > 0 && silenceMs >= this.silenceTimeoutMs) {
      // The final arrived after the timeout had passed: the turn is already over.
      this._emitTurnComplete('silence_timeout', speechEndTimestamp);
      return;
    }
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      this._emitTurnComplete('silence_timeout', speechEndTimestamp);
    }, this.silenceTimeoutMs - silenceMs);
  }

  /**
   * Cancel a pending silence timer without any side effects.
   * Safe to call when no timer is active (no-op).
   */
  private _clearSilenceTimer(): void {
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }
}
