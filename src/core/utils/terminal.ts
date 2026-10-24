/**
 * @fileoverview The one module allowed to write the standard streams directly.
 *
 * AgentOS's lines go through the logging hand-over; text meant for a person at a terminal, such
 * as an interactive prompt or the frames-only stack the allow-list kit's console capture
 * prints, goes through {@link terminal}.
 *
 * @module agentos/core/utils/terminal
 */

/**
 * Writes text to standard output or standard error. A failing stream never reaches the caller.
 *
 * @param text - The text to write, as it should appear, with its own line ending.
 * @param stream - The stream to write to, `stdout` unless given.
 *
 * @example
 * ```ts
 * terminal('Continue? [y/N] ');
 * ```
 */
export function terminal(text: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
  try { process[stream].write(text); } catch { /* Terminal output cannot fail the caller's operation. */ }
}
