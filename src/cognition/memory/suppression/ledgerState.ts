/**
 * @module memory/suppression/ledgerState
 *
 * The forgotten-user ledger's identity and state mark, as values. Nothing here reads a database, logs or loads a
 * Node.js module, so a browser loads it as it is.
 *
 * - The identity is 16 random bytes as 32 lowercase hex characters, made once when a ledger is created. It holds no
 *   hash, id, key, time or path.
 * - The state mark is one unsigned 256-bit number as 64 lowercase hex characters. Every advance sets it to the higher
 *   of the mark it had and the current Unix millisecond shifted left by 192 bits, plus a random number from 1 to
 *   2^192. So it rises on every advance, also when the clock stalls or goes back, and its first 16 hex characters are
 *   the millisecond of the newest advance whenever the clock was ahead of the mark.
 *
 * Both draw from `globalThis.crypto.getRandomValues`, on every runtime. When it is missing or throws, the call throws.
 */

/** The `hash` of the row that holds a ledger's identity. */
export const IDENTITY_MARKER = 'i1:identity';
/** The `hash` of the row that holds a ledger's state mark. */
export const STATE_MARKER = 's1:state';

const IDENTITY_FORM = /^[0-9a-f]{32}$/;
const MARK_FORM = /^[0-9a-f]{64}$/;
/** A key under `i` or `s` and a version: reserved for the identity and the state. */
const RESERVED_KEY = /^[is][0-9]+:/;
/** A mark's first 64 bits stay below 2^53, above any millisecond a clock returns. */
const TIME_LIMIT = BigInt(2) ** BigInt(53);
const GAP_BITS = BigInt(192);

/** `count` bytes from the runtime's secure random source. */
function randomBytes(count: number): Uint8Array {
  const bytes = new Uint8Array(count);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

const hexOf = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/**
 * A new ledger identity: 16 bytes from the secure random source, as 32 lowercase hex characters.
 *
 * @throws When the runtime has no secure random source.
 */
export function newLedgerIdentity(): string {
  return hexOf(randomBytes(16));
}

/** Whether a value has the identity's form: 32 lowercase hex characters. */
export function isLedgerIdentity(value: unknown): value is string {
  return typeof value === 'string' && IDENTITY_FORM.test(value);
}

/** Whether a value has the state mark's form: 64 lowercase hex characters whose first 16 are a number below 2^53. */
export function isStateMark(value: unknown): value is string {
  return typeof value === 'string' && MARK_FORM.test(value) && BigInt(`0x${value.slice(0, 16)}`) < TIME_LIMIT;
}

/**
 * The mark after `previous`: the higher of `previous` (zero when there is none) and `nowMs` shifted left by 192 bits,
 * plus 24 fresh random bytes read as a number, plus one.
 *
 * @param previous - The mark held, or undefined for a new ledger.
 * @param nowMs - The current Unix time in milliseconds.
 * @returns The new mark, as 64 lowercase hex characters.
 * @throws {RangeError} For a `previous` that is not a valid mark, a `nowMs` that is not a nonnegative safe integer, or
 *   a result whose first 64 bits would reach 2^53.
 * @throws When the runtime has no secure random source.
 *
 * @example
 * const first = advanceStateMark(undefined, Date.now());
 * const next = advanceStateMark(first, Date.now()); // compareStateMarks(next, first) === 1
 */
export function advanceStateMark(previous: string | undefined, nowMs: number): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new RangeError('ledgerState: the clock must be a nonnegative safe integer of milliseconds');
  if (previous !== undefined && !isStateMark(previous)) throw new RangeError('ledgerState: the previous mark is not a valid state mark');
  const floor = BigInt(nowMs) << GAP_BITS;
  const held = previous === undefined ? BigInt(0) : BigInt(`0x${previous}`);
  const gap = BigInt(`0x${hexOf(randomBytes(24))}`) + BigInt(1);
  const next = (held > floor ? held : floor) + gap;
  if (next >> GAP_BITS >= TIME_LIMIT) throw new RangeError('ledgerState: the mark would leave its range');
  return next.toString(16).padStart(64, '0');
}

/**
 * Orders two valid marks of one ledger as the numbers they are. Compare marks only when their identities are equal.
 *
 * @throws {RangeError} When either is not a valid mark.
 */
export function compareStateMarks(a: string, b: string): -1 | 0 | 1 {
  if (!isStateMark(a) || !isStateMark(b)) throw new RangeError('ledgerState: only valid state marks are compared');
  // Equal-length lowercase hex orders as the numbers it spells.
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Whether a row's `hash` is a key reserved for the identity and the state: `i` or `s`, digits, then `:`. */
export function isReservedLedgerKey(hash: string): boolean {
  return RESERVED_KEY.test(hash);
}
