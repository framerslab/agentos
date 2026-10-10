/**
 * @fileoverview The seeded generator behind the `weighted` and `random`
 * seating policies: xmur3 hashes a string seed to 32 bits, mulberry32 draws
 * from a 32-bit seed. Call number `k` draws from a mix of the seed and `k`,
 * so two instances with the same seed produce the same seatings in the same
 * order and successive calls differ.
 */

/** Hashes a string to a 32-bit unsigned integer (xmur3). */
export function xmur3(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/** A generator of numbers in [0, 1) from a 32-bit seed (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The 32-bit value a configured seed stands for: a number as it is, a string hashed. */
export function seedToUint32(seed: number | string): number {
  return typeof seed === 'number' ? seed >>> 0 : xmur3(seed);
}

/** The generator for call number `call` (from 0) on an instance whose seed is `seedUsed`. */
export function callRng(seedUsed: number, call: number): () => number {
  const mixed = (seedUsed ^ Math.imul((call + 1) >>> 0, 0x9e3779b1)) >>> 0;
  return mulberry32(xmur3(String(mixed)));
}

/** A seed drawn at construction when none is configured. */
export function drawSeed(): number {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0];
}
