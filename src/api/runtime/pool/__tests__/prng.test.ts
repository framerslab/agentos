import { describe, expect, it } from 'vitest';
import { seedToUint32, mulberry32, callRng, drawSeed } from '../prng.js';

describe('seeded draws', () => {
  it('a number is used as it is; a string is hashed; the two differ', () => {
    expect(seedToUint32(7)).toBe(7);
    expect(seedToUint32('7')).not.toBe(7);
    expect(seedToUint32('7')).toBe(seedToUint32('7'));
  });
  it('mulberry32 is deterministic and in [0, 1)', () => {
    const a = mulberry32(42), b = mulberry32(42);
    const xs = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs);
    for (const x of xs) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(1); }
  });
  it('successive calls on one seed differ while two instances agree', () => {
    expect(callRng(7, 0)()).toBe(callRng(7, 0)());
    expect(callRng(7, 0)()).not.toBe(callRng(7, 1)());
  });
  it('a drawn seed is a whole number in range', () => {
    const s = drawSeed();
    expect(Number.isInteger(s) && s >= 0 && s <= 0xffffffff).toBe(true);
  });
});
