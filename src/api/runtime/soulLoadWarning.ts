/**
 * @file soulLoadWarning.ts
 * The warning for a soul that fails to load, written once per agent build.
 *
 * One build can load the same soul more than once: a GMI agent builds two
 * personas from the agent's options on its first turn, and each builds the
 * system prompt, which loads the soul. A build runs those loads inside
 * {@link withOneSoulWarning}, and the same failure is warned about once there.
 * Outside such a scope every failure is warned about, so two builds each warn.
 *
 * @module api/runtime/soulLoadWarning
 */

/** The failures warned about in the running scope, as `source + NUL + message`; null outside a scope. */
let warnedInScope: Set<string> | null = null;

/**
 * Run `build` with soul-load warnings deduplicated: a failure warned about
 * once inside it is not warned about again until it returns. `build` must be
 * synchronous; a scope already running is joined.
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
 * Warn that a soul failed to load and the agent runs without it, in every
 * environment, once per {@link withOneSoulWarning} scope.
 *
 * @param source - What names the soul: its path, or `inline soul` for `{ content }`.
 * @param error - Why it failed.
 */
export function warnSoulLoadFailed(source: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const key = `${source}\u0000${message}`;
  if (warnedInScope) {
    if (warnedInScope.has(key)) return;
    warnedInScope.add(key);
  }
  console.warn(`[@framers/agentos] Failed to load soul: ${message}. Agent will boot without SOUL.md identity.`);
}

/**
 * Warn, once per agent build, that a soul given beside `systemBlocks` is not added to the prompt: the blocks replace
 * the prompt the agent assembles, the soul's prose, style and memory index included. It warns whatever the blocks
 * hold, so a build that copies the soul's text into them still gets the line. Does nothing unless both are set.
 *
 * @param opts - The agent's `soul` and `systemBlocks`.
 */
export function warnSoulBesideSystemBlocks(opts: { soul?: unknown; systemBlocks?: unknown }): void {
  if (!opts.soul || !opts.systemBlocks) return;
  console.warn(
    '[@framers/agentos] The agent has a soul and systemBlocks: the soul\'s prose, style and memory index are not ' +
      'added to the prompt, because systemBlocks replace the prompt the agent assembles. Put what the agent needs of ' +
      'the soul in the blocks yourself, or drop systemBlocks.',
  );
}
