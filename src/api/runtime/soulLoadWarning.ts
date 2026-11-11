/**
 * @file soulLoadWarning.ts
 * The `soul.load_failed` line for a soul given `optional: true` that fails to load, written once per agent build.
 *
 * A soul that is not optional throws when it fails to load. One build can load an optional soul more than once; a
 * build runs those loads inside {@link withOneSoulWarning}, and the same failure is logged once there. Outside such a
 * scope every failure is logged, so two builds each log.
 *
 * @module api/runtime/soulLoadWarning
 */
import { soulLog } from '../../cognition/substrate/personas/soulLog.js';
import { listedErrorFields } from '../../core/logging/events.js';

/** The failures logged in the running scope, as `source + NUL + message`; null outside a scope. */
let warnedInScope: Set<string> | null = null;

/**
 * Run `build` with soul-load lines deduplicated: a failure logged once inside
 * it is not logged again until it returns. `build` must be synchronous; a
 * scope already running is joined.
 *
 * @param build - The synchronous work that may load the soul several times.
 * @returns What `build` returns.
 */
export function withOneSoulWarning<T>(build: () => T): T {
  if (warnedInScope) return build();
  warnedInScope = new Set();
  try {
    return build();
  } finally {
    warnedInScope = null;
  }
}

/**
 * Logs that a soul given `optional: true` failed to load and the agent runs without it: one `soul.load_failed` line,
 * with the error's type and code and no path or message, once per {@link withOneSoulWarning} scope.
 *
 * @param source - What names the soul: its path, or `inline soul` for `{ content }`. Used only to log a failure once.
 * @param error - Why it failed.
 */
export function warnSoulLoadFailed(source: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const key = `${source}\u0000${message}`;
  if (warnedInScope) {
    if (warnedInScope.has(key)) return;
    warnedInScope.add(key);
  }
  soulLog.warn('soul.load_failed', { optional: 'yes', ...listedErrorFields(error) });
}

/**
 * Warn, once per agent build, that a soul given beside `systemBlocks` is not automatically added to the prompt: the
 * blocks replace the prompt the agent assembles, the soul's prose, style and memory index included. It warns whatever
 * the blocks hold, so a build that copies the soul's text into them still gets the line, which is why it says what is
 * not done for the build rather than what the prompt lacks. Does nothing unless both are set.
 *
 * @param opts - The agent's `soul` and `systemBlocks`.
 */
export function warnSoulBesideSystemBlocks(opts: { soul?: unknown; systemBlocks?: unknown }): void {
  if (!opts.soul || !opts.systemBlocks) return;
  console.warn(
    '[@framers/agentos] The agent has a soul and systemBlocks: the soul\'s prose, style and memory index are not ' +
      'automatically added to the prompt, because systemBlocks replace the prompt the agent assembles. Put what the ' +
      'agent needs of the soul in the blocks yourself, or drop systemBlocks.',
  );
}
