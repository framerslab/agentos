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
 *    transcribe an utterance after its end of speech. A final with no text
 *    (a provider retracting interim text it showed) changes nothing.
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
   * but risk firing mid-sentence during natural pauses.
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
   * The latest final transcript text accumulated for the current turn.
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
   * Some providers transcribe an utterance only after its end of speech
   * (`OpenAIRealtimeTranscriptionSTT` emits `speech_end` when OpenAI reports
   * the speech stopped, and the final once the utterance is transcribed), so
   * the first final that follows, before speech resumes, is decided as that
   * `speech_end` would have been.
   */
  private speechEndWithoutText: number | null = null;

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  /**
   * Create a new {@link HeuristicEndpointDetector}.
   *
   * @param options - Optional configuration overrides.
   */
  constructor(options: HeuristicEndpointDetectorOptions = {}) {
    super();
    this.silenceTimeoutMs = options.silenceTimeoutMs ?? DEFAULT_SILENCE_TIMEOUT_MS;
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
   * @param transcript - Transcript event from the STT session.
   */
  pushTranscript(transcript: TranscriptEvent): void {
    if (!transcript.isFinal) {
      // Ignore partial/interim hypotheses -- they will be superseded by
      // a subsequent final result or revised interim.
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

    // The speech already ended without a transcript: decide the turn now.
    if (this.speechEndWithoutText !== null && !this.speechActive) {
      const speechEndTimestamp = this.speechEndWithoutText;
      this.speechEndWithoutText = null;
      this._decideTurnEnd(speechEndTimestamp);
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
   *   resumes is decided the same way when it arrives.
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

        if (!this.accumulatedText) {
          // No transcript has arrived yet -- nothing to flush now.
          // This can happen when the VAD detects a very short burst of
          // noise that doesn't produce any STT output, or when the
          // provider transcribes the utterance after its end of speech:
          // the first final before speech resumes is decided then.
          this.speechEndWithoutText = event.timestamp;
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
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Decide the turn once speech has ended and a final transcript is held:
   * terminal punctuation fires `turn_complete` at once; otherwise the
   * silence timer starts.
   *
   * @param speechEndTimestamp - Timestamp of the `speech_end`, for the turn's duration.
   */
  private _decideTurnEnd(speechEndTimestamp: number): void {
    if (TERMINAL_PUNCTUATION.test(this.accumulatedText)) {
      // Sentence-terminal punctuation detected -> fire immediately.
      // This is the fast path that eliminates the 1.5 s silence wait.
      this._emitTurnComplete('punctuation', speechEndTimestamp);
    } else {
      // No terminal punctuation -> start the silence timer.
      // If the user doesn't resume speaking within silenceTimeoutMs,
      // we'll fire turn_complete with reason 'silence_timeout'.
      this._startSilenceTimer(speechEndTimestamp);
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
   * with reason `'silence_timeout'`.
   *
   * Any previously running silence timer is cleared first to prevent
   * double-fires from rapid speech_end -> speech_start -> speech_end sequences.
   *
   * @param speechEndTimestamp - Timestamp passed through to the internal turn-complete emitter
   *   for duration calculation.
   */
  private _startSilenceTimer(speechEndTimestamp: number): void {
    this._clearSilenceTimer();
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      this._emitTurnComplete('silence_timeout', speechEndTimestamp);
    }, this.silenceTimeoutMs);
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
