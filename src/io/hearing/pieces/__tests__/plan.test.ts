import { describe, expect, it } from 'vitest';
import { planPieces } from '../plan.js';

const options = { pieceSeconds: 300, overlapSeconds: 3 };

describe('planPieces', () => {
  it('marks pieces with three seconds of overlap', () => {
    expect(planPieces(1_000, options)).toEqual([
      { index: 0, start: 0, end: 300 },
      { index: 1, start: 297, end: 597 },
      { index: 2, start: 594, end: 894 },
      { index: 3, start: 891, end: 1_000 },
    ]);
  });

  it('keeps a recording of at most one piece whole', () => {
    for (const seconds of [0.5, 10, 299, 300]) {
      expect(planPieces(seconds, options)).toEqual([{ index: 0, start: 0, end: seconds }]);
    }
  });

  it('joins a remainder no longer than the overlap and one second to the previous piece', () => {
    expect(planPieces(300.5, options)).toEqual([{ index: 0, start: 0, end: 300.5 }]);
    expect(planPieces(301, options)).toEqual([{ index: 0, start: 0, end: 301 }]);
    expect(planPieces(301.5, options)).toEqual([
      { index: 0, start: 0, end: 300 },
      { index: 1, start: 297, end: 301.5 },
    ]);
  });

  it('refuses invalid lengths, overlaps and pieces shorter than ten seconds', () => {
    for (const seconds of [0, -1, NaN, Infinity, -Infinity]) {
      expect(() => planPieces(seconds, options)).toThrow(RangeError);
    }
    for (const overlapSeconds of [-1, 300, 301, NaN, Infinity, -Infinity]) {
      expect(() => planPieces(1_000, { ...options, overlapSeconds })).toThrow(RangeError);
    }
    for (const pieceSeconds of [9, NaN, Infinity, -Infinity]) {
      expect(() => planPieces(100, { ...options, pieceSeconds })).toThrow(RangeError);
    }
  });
});
