/**
 * @file windowBoundary.ts
 * Helpers for walker tests whose verdict turns on what a context-window check
 * counts. Each test finds a prompt length that fits magnum's window under one
 * reading of the request and not under another, using {@link checkContextFit}
 * itself, so the test does not restate the estimate's arithmetic.
 */
import { checkContextFit, type ContextFitRequest } from '../contextWindowFit.js';

const MAGNUM = 'anthracite-org/magnum-v4-72b';

/** One user turn of `chars` characters: what a walker sends for `prompt`. */
export function userTurn(chars: number): Array<{ role: 'user'; content: string }> {
  return [{ role: 'user', content: 'x'.repeat(chars) }];
}

/** Whether a request fits magnum's 32,768-token window on OpenRouter. */
export function fitsMagnum(request: Omit<ContextFitRequest, 'provider' | 'model'>): boolean {
  return checkContextFit({ provider: 'openrouter', model: MAGNUM, ...request }).fits;
}

/**
 * The largest prompt length, in characters, for which `fits` holds. `fits`
 * must hold at 0 and turn false before 400,000 characters.
 */
export function largestFitting(fits: (chars: number) => boolean): number {
  let lo = 0;
  let hi = 400_000;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * A prompt length halfway between two boundaries: over the window under the
 * larger reading of the request, within it under the smaller one.
 */
export function between(
  largerReadingFits: (chars: number) => boolean,
  smallerReadingFits: (chars: number) => boolean,
): number {
  return Math.floor((largestFitting(largerReadingFits) + largestFitting(smallerReadingFits)) / 2);
}
