import { describe, expect, it } from 'vitest';

import { withinOneEdit } from '../FuzzyIndex.js';

/**
 * The edit distance of two words over their code points, read from a full table: letters added, dropped or changed,
 * and two letters side by side swapped, each one edit (the optimal string alignment distance, which is the
 * Damerau-Levenshtein distance wherever either is 1 or less).
 */
function editDistance(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  const table = Array.from({ length: x.length + 1 }, (_, i) => Array.from({ length: y.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= x.length; i += 1) {
    for (let j = 1; j <= y.length; j += 1) {
      table[i][j] = Math.min(table[i - 1][j] + 1, table[i][j - 1] + 1, table[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) table[i][j] = Math.min(table[i][j], table[i - 2][j - 2] + 1);
    }
  }
  return table[x.length][y.length];
}

describe('withinOneEdit', () => {
  it('holds for the same word, and for a letter added, dropped or changed or two letters side by side swapped, anywhere in it', () => {
    expect(withinOneEdit('board', 'board')).toBe(true);
    const oneApart = [
      ['plan', 'pplan'],
      ['plan', 'plaan'],
      ['plan', 'plans'],
      ['plans', 'plan'],
      ['plan', 'clan'],
      ['plan', 'plen'],
      ['plan', 'plat'],
      ['board', 'obard'],
      ['board', 'baord'],
      ['board', 'boadr'],
      ['', 'a'],
    ];
    for (const [a, b] of oneApart) expect(withinOneEdit(a, b), `${a} ${b}`).toBe(true);
  });

  it('fails for two edits or more', () => {
    const twoApart = [
      ['board', 'bored'],
      ['plan', 'planet'],
      ['abc', 'cba'],
      ['abcd', 'badc'],
      ['friday', 'frdy'],
      ['', 'ab'],
    ];
    for (const [a, b] of twoApart) expect(withinOneEdit(a, b), `${a} ${b}`).toBe(false);
  });

  it('counts a letter outside the Basic Multilingual Plane, two UTF-16 units, as one letter', () => {
    expect(withinOneEdit('a\u{1D49C}b', 'axb')).toBe(true);
    expect(withinOneEdit('a\u{1D49C}b', 'ab')).toBe(true);
    expect(withinOneEdit('a\u{1D49C}\u{1D49E}b', 'a\u{1D49E}\u{1D49C}b')).toBe(true);
    expect(withinOneEdit('a\u{1D49C}b', 'a\u{1D49C}\u{1D49C}\u{1D49C}b')).toBe(false);
  });

  it('agrees with the edit distance from a full table on every pair of words of up to four letters of three', () => {
    const all = [''];
    let last = [''];
    for (let length = 1; length <= 4; length += 1) {
      last = last.flatMap((word) => ['a', 'b', 'c'].map((letter) => `${word}${letter}`));
      all.push(...last);
    }
    const wrong: string[] = [];
    for (const a of all) {
      for (const b of all) {
        if (withinOneEdit(a, b) !== editDistance(a, b) <= 1) wrong.push(`${a}|${b}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
