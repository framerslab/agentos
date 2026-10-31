/**
 * @module learning/ledger/ids
 *
 * ULIDs for ledger rows: 48 bits of milliseconds and 80 random bits in Crockford's base 32, 26 characters, so ids
 * sort by time (https://github.com/ulid/spec). Ids made in one process stay in order: within one millisecond, or
 * when the clock steps back, the random part of the last id is incremented. A time a ULID cannot hold (not a finite
 * number, or past 2^48 - 1 milliseconds) is refused, and leaves the order of the next ids as it was.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** The latest time a ULID holds: 48 bits of milliseconds since the epoch. */
const MAX_TIME = 2 ** 48 - 1;

let lastTime = -1;
let lastRandom: number[] = [];

function randomDigits(): number[] {
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === 'function') globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (byte) => byte & 31);
}

/** Adds one to the random part; false when it was all 31s. */
function increment(digits: number[]): boolean {
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    if (digits[i]! < 31) {
      digits[i] = digits[i]! + 1;
      return true;
    }
    digits[i] = 0;
  }
  return false;
}

/**
 * A ULID for the time `now` (milliseconds since the epoch; a time before the epoch is written as the epoch).
 * @throws {RangeError} When `now` is not a finite number or is past 2^48 - 1, before any state changes.
 */
export function ulid(now: number = Date.now()): string {
  if (!Number.isFinite(now) || now > MAX_TIME) {
    throw new RangeError(`A ULID holds a time of at most ${MAX_TIME} milliseconds since the epoch; got ${String(now)}.`);
  }
  let time = Math.max(0, Math.floor(now));
  if (time <= lastTime) {
    time = lastTime;
    if (!increment(lastRandom)) {
      time = lastTime + 1;
      lastRandom = randomDigits();
    }
  } else {
    lastRandom = randomDigits();
  }
  lastTime = time;
  let timePart = '';
  for (let i = 0; i < 10; i += 1) {
    timePart = ALPHABET[time % 32] + timePart;
    time = Math.floor(time / 32);
  }
  return timePart + lastRandom.map((digit) => ALPHABET[digit]).join('');
}
