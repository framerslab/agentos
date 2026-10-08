/**
 * @module voice-pipeline/inputLevel
 * An input's level, and a watch that says when no sound reaches a page from
 * the input in use: the level never above `heardAboveDb` for `afterMs` since
 * the input was chosen, or a dead signal (at or below `deadAtOrBelowDb`, which
 * digital zeros reach) for `afterMs` at any time. A quiet room after the input
 * was heard is not silence: a capture with noise suppression reads low in a
 * pause. No run-time import, so the browser entry carries it.
 */

/** The level of a block of samples in decibels of full scale (its root mean square); `-Infinity` for none or for zeros. */
export function inputLevelDb(samples: Float32Array): number {
  if (samples.length === 0) return -Infinity;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  const rms = Math.sqrt(sum / samples.length);
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

/** Options of {@link InputSilenceWatch}. */
export interface InputSilenceWatchOptions {
  /** A level above this counts as the input heard. @defaultValue -60 */
  heardAboveDb?: number;
  /** A level at or below this carries no signal at all. @defaultValue -150 */
  deadAtOrBelowDb?: number;
  /** How long either condition lasts before the input is called silent. @defaultValue 5000 */
  afterMs?: number;
}

/** Says whether no sound reaches the page from the input in use. */
export class InputSilenceWatch {
  private readonly heardAboveDb: number;
  private readonly deadAtOrBelowDb: number;
  private readonly afterMs: number;
  private heard = false;
  private since = 0;
  private deadSince = 0;

  constructor(options: InputSilenceWatchOptions = {}) {
    this.heardAboveDb = options.heardAboveDb ?? -60;
    this.deadAtOrBelowDb = options.deadAtOrBelowDb ?? -150;
    this.afterMs = options.afterMs ?? 5_000;
  }

  /** A new input, not heard yet. */
  reset(atMs: number): void {
    this.heard = false;
    this.restart(atMs);
  }

  /** Listening starts again on the same input: the time counts afresh and whether it was heard is kept. */
  restart(atMs: number): void {
    this.since = atMs;
    this.deadSince = atMs;
  }

  /** Takes one block's level at its time; answers whether the input is silent now. */
  push(levelDb: number, atMs: number): boolean {
    if (levelDb > this.heardAboveDb) {
      this.heard = true;
      this.since = atMs;
    }
    if (levelDb > this.deadAtOrBelowDb) this.deadSince = atMs;
    return (!this.heard && atMs - this.since >= this.afterMs) || atMs - this.deadSince >= this.afterMs;
  }
}
