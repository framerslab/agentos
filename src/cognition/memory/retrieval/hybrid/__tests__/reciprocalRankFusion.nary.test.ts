import { describe, it, expect } from 'vitest';
import { reciprocalRankFusion } from '../reciprocalRankFusion.js';

type FusedDoc = { id: string; score: number; ranks: Array<number | undefined> };
type Fuse = (lists: ReadonlyArray<{ ranked: ReadonlyArray<{ id: string; rank: number }>; weight: number }>, options?: { k?: number }) => FusedDoc[];

async function fuseRankedLists(...args: Parameters<Fuse>): Promise<FusedDoc[]> {
  const fuse = ((await import('../reciprocalRankFusion.js')) as Record<string, unknown>).fuseRankedLists as Fuse;
  return fuse(...args);
}

describe('fuseRankedLists', () => {
  const dense = [{ id: 'a', rank: 1 }, { id: 'b', rank: 2 }, { id: 'c', rank: 3 }];
  const sparse = [{ id: 'b', rank: 1 }, { id: 'd', rank: 2 }];

  it('two lists at the defaults equal reciprocalRankFusion, id for id and score for score', async () => {
    const two = reciprocalRankFusion(dense, sparse);
    const n = await fuseRankedLists([{ ranked: dense, weight: 0.7 }, { ranked: sparse, weight: 0.3 }], { k: 60 });
    expect(n.map((r) => r.id)).toEqual(two.map((r) => r.id));
    n.forEach((r, i) => expect(r.score).toBeCloseTo(two[i].score, 12));
    expect(n.find((r) => r.id === 'b')!.ranks).toEqual([2, 1]);
    expect(n.find((r) => r.id === 'd')!.ranks).toEqual([undefined, 2]);
  });

  it('a third list of weight 0 adds its ids at score 0 and moves no other score', async () => {
    const n = await fuseRankedLists(
      [{ ranked: dense, weight: 0.7 }, { ranked: sparse, weight: 0.3 }, { ranked: [{ id: 'z', rank: 1 }, { id: 'a', rank: 2 }], weight: 0 }],
      { k: 60 },
    );
    expect(n.find((r) => r.id === 'z')).toEqual({ id: 'z', score: 0, ranks: [undefined, undefined, 1] });
    expect(n.find((r) => r.id === 'a')!.score).toBeCloseTo(0.7 / 61, 12);
    expect(n.find((r) => r.id === 'a')!.ranks).toEqual([1, undefined, 2]);
  });

  it('an id a list repeats counts once, at its first rank', async () => {
    const n = await fuseRankedLists([{ ranked: [{ id: 'a', rank: 1 }, { id: 'a', rank: 4 }], weight: 1 }], { k: 60 });
    expect(n).toEqual([{ id: 'a', score: 1 / 61, ranks: [1] }]);
  });
});
