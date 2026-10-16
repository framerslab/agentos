import { describe, expect, it } from 'vitest';
import { reciprocalRankFusion } from '../../../memory/retrieval/hybrid/reciprocalRankFusion.js';
import { fuseRanked } from '../fuseRanked.js';

interface Doc { id: string; group: string }
const doc = (id: string, group = id): Doc => ({ id, group });
const ids = (fused: { id: string }[]): string[] => fused.map((item) => item.id);

describe('fuseRanked', () => {
  it('fuses two lists as reciprocalRankFusion fuses them', () => {
    const dense = [doc('a'), doc('b'), doc('c')];
    const sparse = [doc('c'), doc('d'), doc('a')];
    const fused = fuseRanked([dense, sparse], { idOf: (item) => item.id, weights: [0.7, 0.3], k: 60 });
    const expected = reciprocalRankFusion(
      dense.map((item, at) => ({ id: item.id, rank: at + 1 })),
      sparse.map((item, at) => ({ id: item.id, rank: at + 1 })),
      { denseWeight: 0.7, sparseWeight: 0.3, k: 60 },
    );
    expect(ids(fused)).toEqual(expected.map((item) => item.id));
    fused.forEach((item, at) => expect(item.score).toBeCloseTo(expected[at]!.score, 12));
  });

  it('fuses five lists by their weights', () => {
    const lists = [[doc('a')], [doc('b')], [doc('c')], [doc('d')], [doc('e')]];
    const fused = fuseRanked(lists, { idOf: (item) => item.id, weights: [1, 1, 0.8, 0.8, 0.6] });
    expect(ids(fused)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(fused[0]!.score).toBeCloseTo(1 / 61, 12);
    expect(fused[4]!.score).toBeCloseTo(0.6 / 61, 12);
  });

  it('adds the ranks of an item that stands in several lists and keeps the item of its first list', () => {
    const fused = fuseRanked([[doc('x', 'one')], [doc('y'), doc('x', 'two')]], { idOf: (item) => item.id });
    expect(fused[0]).toMatchObject({ id: 'x', list: 0, item: { group: 'one' } });
    expect(fused[0]!.score).toBeCloseTo(1 / 61 + 1 / 62, 12);
    expect([...fused[0]!.ranks.entries()]).toEqual([[0, 1], [1, 2]]);
  });

  it('keeps at most perList items of one first list and perGroup items of one group', () => {
    const notes = [doc('n1', 'note-a'), doc('n2', 'note-a'), doc('n3', 'note-a'), doc('n4', 'note-b'), doc('n5', 'note-c'), doc('n6', 'note-d')];
    const call = [doc('c1', 'call'), doc('c2', 'call')];
    const fused = fuseRanked([notes, call], { idOf: (item) => item.id, groupOf: (item) => item.group, perList: 4, perGroup: 2 });
    expect(ids(fused)).toEqual(['n1', 'c1', 'n2', 'c2', 'n4', 'n5']);
  });

  it('takes perList by list when given one number a list, and stops at limit', () => {
    const fused = fuseRanked([[doc('a'), doc('b'), doc('c')], [doc('d'), doc('e')]], { idOf: (item) => item.id, perList: [1, 2], limit: 2 });
    expect(ids(fused)).toEqual(['a', 'd']);
  });

  it('breaks a tie by the first list, then by the rank there, then by the id, the same on every call', () => {
    const lists = [[doc('m'), doc('z')], [doc('b'), doc('a')]];
    const once = ids(fuseRanked(lists, { idOf: (item) => item.id }));
    expect(once).toEqual(['m', 'b', 'z', 'a']);
    expect(ids(fuseRanked(lists, { idOf: (item) => item.id }))).toEqual(once);
  });

  it('counts an item twice in one list at its better rank', () => {
    const fused = fuseRanked([[doc('a'), doc('b'), doc('a')]], { idOf: (item) => item.id });
    expect(ids(fused)).toEqual(['a', 'b']);
    expect(fused[0]!.score).toBeCloseTo(1 / 61, 12);
  });

  it('answers nothing for no list or empty lists, and refuses a weight or a k that is not a finite number, zero or more', () => {
    expect(fuseRanked<Doc>([], { idOf: (item) => item.id })).toEqual([]);
    expect(fuseRanked<Doc>([[], []], { idOf: (item) => item.id })).toEqual([]);
    expect(() => fuseRanked([[doc('a')]], { idOf: (item) => item.id, weights: [-1] })).toThrow(RangeError);
    expect(() => fuseRanked([[doc('a')]], { idOf: (item) => item.id, weights: [1, Number.NaN] })).toThrow(RangeError);
    expect(() => fuseRanked([[doc('a')]], { idOf: (item) => item.id, k: Number.NaN })).toThrow(RangeError);
  });

  it('departs from reciprocalRankFusion where its own rules say: a tie goes to the first list, not the lower id, and an item twice in one list counts once', () => {
    const tie = fuseRanked([[doc('z')], [doc('a')]], { idOf: (item) => item.id, weights: [1, 1] });
    expect(ids(tie)).toEqual(['z', 'a']);
    const byId = reciprocalRankFusion([{ id: 'z', rank: 1 }], [{ id: 'a', rank: 1 }], { denseWeight: 1, sparseWeight: 1 });
    expect(byId.map((item) => item.id)).toEqual(['a', 'z']);
    const once = fuseRanked([[doc('a'), doc('b'), doc('a')]], { idOf: (item) => item.id, weights: [1] });
    expect(once[0]!.score).toBeCloseTo(1 / 61, 12);
    const again = reciprocalRankFusion([{ id: 'a', rank: 1 }, { id: 'b', rank: 2 }, { id: 'a', rank: 3 }], [], { denseWeight: 1 });
    expect(again[0]!.score).toBeCloseTo(1 / 61 + 1 / 63, 12);
  });

  it('refuses a cap that is not a whole number, zero or more, or positive infinity, and perGroup without groupOf', () => {
    const idOf = (item: Doc): string => item.id;
    expect(() => fuseRanked([[doc('a')]], { idOf, perList: 1.5 })).toThrow(RangeError);
    expect(() => fuseRanked([[doc('a')]], { idOf, perList: [1, Number.NaN] })).toThrow(RangeError);
    expect(() => fuseRanked([[doc('a')]], { idOf, groupOf: (item) => item.group, perGroup: -1 })).toThrow(RangeError);
    expect(() => fuseRanked([[doc('a')]], { idOf, limit: Number.NaN })).toThrow(RangeError);
    expect(() => fuseRanked([[doc('a')]], { idOf, perGroup: 1 })).toThrow(TypeError);
    expect(ids(fuseRanked([[doc('a'), doc('b')], [doc('c'), doc('d')]], { idOf, perList: [1, Number.POSITIVE_INFINITY] }))).toEqual(['a', 'c', 'd']);
  });
});
