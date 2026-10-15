/**
 * @module voice-pipeline/SoftFadeBargeinHandler
 *
 * Implements a three-tier soft-fade barge-in policy that maps detected speech
 * duration to one of three actions: ignore, pause (with fade-out), or cancel.
 *
 * ## Three-tier logic
 *
 * The handler divides the speech duration axis into three regions:
 *
 * ```
 *   0 ms                ignoreMs              cancelMs
 *   |-------- ignore --------|-------- pause --------|-------- cancel -------->
 *          (noise)              (fade-out)              (hard stop)
 * ```
 *
 * | Region                          | Action   | Rationale                                     |
 * |---------------------------------|----------|-----------------------------------------------|
 * | `speechDurationMs < ignoreMs`   | `ignore` | Too short to be intentional (noise, breath).  |
 * | `ignoreMs <= speech < cancelMs` | `pause`  | Probably intentional; fade out gracefully.     |
 * | `speechDurationMs >= cancelMs`  | `cancel` | Definitely intentional; stop immediately.      |
 *
 * ## Configurable thresholds
 *
 * - **`ignoreMs`** (default 100 ms): The noise floor. Anything shorter than
 *   this is dismissed. Set lower in quiet environments, higher in noisy ones.
 *
 * - **`cancelMs`** (default 2,000 ms): The hard-stop ceiling. By this point,
 *   the user has clearly been speaking for a while and wants to take over.
 *   The pipeline should stop TTS immediately rather than fading.
 *
 * - **`fadeMs`** (default 200 ms): The duration of the audio fade-out applied
 *   during a `'pause'` action. Shorter fades (100 ms) feel snappier; longer
 *   fades (300+ ms) feel smoother but delay the user's ability to be heard.
 *
 * ## When to use soft-fade vs hard-cut
 *
 * Soft-fade is preferred when:
 * - The environment is noisy and false barge-in detections are common.
 * - The conversation is measured/educational and abrupt cuts feel jarring.
 * - The TTS voice has long trailing prosody that benefits from a fade.
 *
 * Use {@link HardCutBargeinHandler} when:
 * - The conversation is fast-paced (customer support, command interfaces).
 * - Audio quality is high and false positives are rare.
 * - Minimal interruption latency is critical.
 *
 * @see {@link HardCutBargeinHandler} for the binary hard-cut alternative.
 * @see {@link IBargeinHandler} for the interface contract.
 */

import type { BargeinAction, BargeinContext, IBargeinHandler } from './types.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Construction options for {@link SoftFadeBargeinHandler}.
 *
 * @example
 * ```typescript
 * const handler = new SoftFadeBargeinHandler({
 *   ignoreMs: 80,
 *   cancelMs: 1500,
 *   fadeMs: 150,
 * });
 * ```
 */
export interface SoftFadeBargeinHandlerOptions {
  /**
   * Speech duration threshold in milliseconds below which the barge-in is
   * treated as accidental noise and ignored. This is the lower boundary
   * of the "pause" region.
   *
   * @defaultValue 100
   */
  ignoreMs?: number;

  /**
   * Speech duration threshold in milliseconds at or above which the barge-in
   * triggers an immediate cancel rather than a fade-out pause. This is the
   * upper boundary of the "pause" region. Must be greater than `ignoreMs`
   * for the pause (fade) region to exist.
   *
   * @defaultValue 2000
   */
  cancelMs?: number;

  /**
   * Duration of the TTS fade-out in milliseconds applied when the speech
   * duration falls in the "pause" range `[ignoreMs, cancelMs)`.
   *
   * The fade-out is applied client-side; the server sends a `{ type: 'pause', fadeMs }`
   * control message and the client's audio player reduces volume linearly
   * over this duration.
   *
   * @defaultValue 200
   */
  fadeMs?: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Barge-in handler that applies a three-tier soft-fade strategy.
 *
 * The handler is stateless -- each `handleBargein` call is evaluated
 * independently with no memory of previous barge-in events.
 *
 * @see {@link IBargeinHandler} for the interface contract.
 * @see {@link HardCutBargeinHandler} for the binary hard-cut alternative.
 *
 * @example
 * ```typescript
 * const handler = new SoftFadeBargeinHandler({ ignoreMs: 80, cancelMs: 1500, fadeMs: 150 });
 *
 * handler.handleBargein({ speechDurationMs: 30, ... });   // -> { type: 'ignore' }
 * handler.handleBargein({ speechDurationMs: 500, ... });  // -> { type: 'pause', fadeMs: 150 }
 * handler.handleBargein({ speechDurationMs: 1600, ... }); // -> { type: 'cancel', injectMarker: '[interrupted]' }
 * ```
 */
export class SoftFadeBargeinHandler implements IBargeinHandler {
  /**
   * The interruption strategy implemented by this handler.
   * Always `'soft-fade'` -- TTS audio is faded out over a configurable window.
   */
  readonly mode = 'soft-fade' as const;

  /**
   * Speech duration below which the barge-in is dismissed as noise.
   * See `SoftFadeBargeinHandlerOptions.ignoreMs`.
   */
  private readonly ignoreMs: number;

  /**
   * Speech duration at or above which the barge-in escalates to a full cancel.
   * See `SoftFadeBargeinHandlerOptions.cancelMs`.
   */
  private readonly cancelMs: number;

  /**
   * Duration of the TTS audio fade-out applied during a `'pause'` action.
   * See `SoftFadeBargeinHandlerOptions.fadeMs`.
   */
  private readonly fadeMs: number;

  /**
   * Constructs a new {@link SoftFadeBargeinHandler}.
   *
   * @param options - Optional configuration. Defaults to
   *   `{ ignoreMs: 100, cancelMs: 2000, fadeMs: 200 }`.
   */
  constructor(options: SoftFadeBargeinHandlerOptions = {}) {
    this.ignoreMs = options.ignoreMs ?? 100;
    this.cancelMs = options.cancelMs ?? 2000;
    this.fadeMs = options.fadeMs ?? 200;
  }

  /**
   * Evaluate the barge-in context and return the pipeline action.
   *
   * Decision tree (evaluated in order):
   *
   * 1. `speechDurationMs < ignoreMs` -> `{ type: 'ignore' }`
   *    Too short to be intentional. Likely a lip smack, breath, or noise burst.
   *
   * 2. `speechDurationMs >= cancelMs` -> `{ type: 'cancel', injectMarker: '[interrupted]' }`
   *    The user has been speaking long enough that they clearly want to take over.
   *    Stop TTS immediately and mark the conversation as interrupted.
   *
   * 3. Otherwise (ignoreMs <= speech < cancelMs) -> `{ type: 'pause', fadeMs }`
   *    Probably intentional but not yet certain. Fade out TTS gracefully so the
   *    user can be heard. `VoicePipelineOrchestrator` holds the reply's audio
   *    meanwhile; when the speech ends, a final with words cancels the reply,
   *    and an empty final, a backchannel or none resumes it.
   *
   * @param context - Snapshot of the barge-in state at the moment of detection.
   * @returns The pipeline action to execute. Always synchronous (no Promise).
   */
  handleBargein(context: BargeinContext): BargeinAction {
    const { speechDurationMs } = context;

    // Tier 1: Noise floor -- dismiss as accidental
    if (speechDurationMs < this.ignoreMs) {
      return { type: 'ignore' };
    }

    // Tier 3: Hard stop -- user has been speaking long enough to be certain.
    // (Evaluated before Tier 2 to avoid the pause action for long speech.)
    if (speechDurationMs >= this.cancelMs) {
      return { type: 'cancel', injectMarker: '[interrupted]' };
    }

    // Tier 2: Fade region -- probably intentional, fade out gracefully.
    return { type: 'pause', fadeMs: this.fadeMs };
  }
}
