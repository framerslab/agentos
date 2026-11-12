/**
 * @module guardrails/guardFailure
 *
 * The mark the library puts on the BLOCK it makes for a closed guard that threw, ran late or answered no recognised
 * action, and on the BLOCK its image guard makes for an image no check could judge. `metadata.failClosed` and
 * `metadata.cause` say the same for a reader, but a guard can write those keys into its own answer; this mark lives
 * outside the answer, so only the library can set it.
 */
import type { GuardrailEvaluationResult } from './IGuardrailService';

const madeByTheLibrary = new WeakSet<GuardrailEvaluationResult>();

/** Marks a BLOCK the library made for a closed guard's failure, and returns it. */
export function markGuardFailure(evaluation: GuardrailEvaluationResult): GuardrailEvaluationResult {
  madeByTheLibrary.add(evaluation);
  return evaluation;
}

/** Whether the library made this evaluation for a closed guard's failure. */
export function isMarkedGuardFailure(evaluation: GuardrailEvaluationResult): boolean {
  return madeByTheLibrary.has(evaluation);
}

/** The copy `to`, marked when `from` was: for the places that copy an evaluation to stamp a field on it. */
export function carryGuardFailure(from: GuardrailEvaluationResult, to: GuardrailEvaluationResult): GuardrailEvaluationResult {
  if (madeByTheLibrary.has(from)) madeByTheLibrary.add(to);
  return to;
}
