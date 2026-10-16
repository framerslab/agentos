/**
 * @module voice-pipeline/describeReason
 *
 * Text for what a promise rejected with or what code threw, whatever value it
 * is. A rejection or a throw can carry any value, and `String()` throws for
 * some (an object without a prototype, a revoked proxy), so a report that
 * builds its text with it fails in its turn: inside a rejection handler that
 * failure is an unhandled rejection of its own.
 */

/**
 * Whether a value is an `Error`, without throwing: `instanceof` reads the
 * value's prototype, which a revoked proxy refuses to give.
 *
 * @param value - Any value.
 * @returns `true` when `value instanceof Error` holds, and `false` when it does
 *   not or cannot be checked.
 */
export function isError(value: unknown): value is Error {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

/**
 * A failure's reason as text, for any value, without throwing: an `Error`'s
 * message, or else the value as `String()` prints it. A value neither can be
 * read for (an object without a prototype, a revoked proxy, an `Error` whose
 * `message` getter throws) is named by its type, as `an unprintable object`.
 *
 * @param reason - What a promise rejected with, or what code threw.
 * @returns Text for a report or a console warning.
 */
export function describeReason(reason: unknown): string {
  try {
    return isError(reason) ? String(reason.message) : String(reason);
  } catch {
    return `an unprintable ${typeof reason}`;
  }
}
