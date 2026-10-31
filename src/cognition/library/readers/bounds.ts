/**
 * @fileoverview The bounds a reader takes, refused when they are no count, as the library's other bounds are.
 * @module agentos/cognition/library/readers/bounds
 */

/**
 * Whether a bound is a number of 0 or more, `Infinity` among them. `NaN` is none, and neither is anything that is no
 * number, though JavaScript compares `null` as 0, a numeric text as its number and `true` as 1.
 */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && value >= 0;
}

/**
 * A bound as an error names it, with none of its own code run: a text quoted, so `'5'` reads apart from 5; a bigint
 * with its `n`; an object or a function by its kind alone.
 */
function shown(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'function') return 'a function';
  if (typeof value === 'object' && value !== null) return 'an object';
  return String(value);
}

/**
 * A reader's bound: the one given, or the fallback when it is left out. A whole count is taken by its whole part, so
 * a bound of 2.5 rows keeps 2.
 *
 * @param reader - The reader's name, which opens the error's message.
 * @param name - The option's name.
 * @param given - What the caller gave, `undefined` when it gave nothing.
 * @param fallback - The bound when none is given.
 * @param whole - Whether the bound counts whole things (rows, columns) rather than characters.
 * @throws RangeError when the bound given is below 0, `NaN` or no number at all (`null`, a numeric text, `true`).
 */
export function boundOf(reader: string, name: string, given: unknown, fallback: number, whole = false): number {
  const value: unknown = given === undefined ? fallback : given;
  if (!isCount(value)) throw new RangeError(`${reader}: ${name} must be a number of 0 or more, not ${shown(value)}`);
  return whole ? Math.floor(value) : value;
}
