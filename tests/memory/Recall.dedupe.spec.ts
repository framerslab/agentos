/**
 * @fileoverview The recall pool's fusion and dedupe, as pure functions: the fused order and its tie-breaks, the
 * starting constants' arithmetic, and which of two near-duplicate memories stays.
 */

import { describe, expect, it } from 'vitest';
import { dedupePool, nearDuplicate } from '../../src/cognition/memory/retrieval/recall/dedupe';
import { fuseLegs, RECALL_CONSTANTS } from '../../src/cognition/memory/retrieval/recall/fuse';
import { recallTokens } from '../../src/cognition/memory/retrieval/recall/lexical';

const entry = (id: string, content: string, fusedScore: number, createdAt = 0) => ({ id, trace: { id, content, createdAt }, fusedScore });
const tokens = (text: string) => new Set(recallTokens(text));

describe('nearDuplicate', () => {
  it('equal normalised texts are one; a Jaccard index of 0.80 is one and 0.70 is two; two empty texts are not', () => {
    expect(nearDuplicate(tokens('The Ferry leaves at NINE.'), tokens('the ferry leaves at nine'), 0.8)).toBe(true);
    const a = new Set(['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8']);
    expect(nearDuplicate(a, new Set([...a, 'x1', 'x2']), 0.8)).toBe(true); // 8 / 10
    expect(nearDuplicate(new Set([...a].slice(0, 7).concat('y1')), new Set([...a, 'x1']), 0.8)).toBe(false); // 7 / 10
    expect(nearDuplicate(new Set(), new Set(), 0.8)).toBe(false);
  });
});

describe('dedupePool', () => {
  it('keeps the higher fused score and records what it dropped and for which', () => {
    const { kept, dropped } = dedupePool(
      [
        entry('a', 'The island ferry leaves pier three at nine fifteen every weekday morning', 0.02),
        entry('b', 'A different memory about the garden', 0.015),
        entry('c', 'The island ferry leaves pier three at nine fifteen every weekday', 0.01),
      ],
      0.8,
    );
    expect(kept.map((e) => e.trace.id)).toEqual(['a', 'b']);
    expect(dropped).toEqual([{ entry: expect.objectContaining({ fusedScore: 0.01 }), duplicateOf: 'a' }]);
  });

  it('on equal fused scores keeps the newer and puts it where the older stood', () => {
    const { kept, dropped } = dedupePool(
      [entry('old', 'the locker code is 4471', 0.01, 100), entry('mid', 'unrelated words entirely here', 0.01, 150), entry('new', 'The locker code is 4471.', 0.01, 200)],
      0.8,
    );
    expect(kept.map((e) => e.trace.id)).toEqual(['new', 'mid']);
    expect(dropped.map((d) => [d.entry.trace.id, d.duplicateOf])).toEqual([['old', 'new']]);
  });

  it('a candidate a later, newer duplicate replaced is recorded against the one that holds its place at the end', () => {
    const { kept, dropped } = dedupePool(
      [entry('v1', 'the locker code is 4471', 0.01, 100), entry('v2', 'The locker code is 4471.', 0.01, 200), entry('v3', 'the locker code is 4471!', 0.01, 300)],
      0.8,
    );
    expect(kept.map((e) => e.trace.id)).toEqual(['v3']);
    expect(dropped.map((d) => [d.entry.trace.id, d.duplicateOf])).toEqual([['v1', 'v3'], ['v2', 'v3']]);
  });
});

describe('fuseLegs', () => {
  const t = (id: string, createdAt = 0) => ({ id, createdAt }) as never;

  it('orders by fused score, then exact-words rank, then recency rank, then id', () => {
    const pool = fuseLegs({ dense: [t('d1'), t('both')], exactWords: [t('both'), t('w1')], recency: [t('r2'), t('r1'), t('d1')] }, RECALL_CONSTANTS);
    expect(pool.map((p) => p.id)).toEqual(['both', 'd1', 'w1', 'r2', 'r1']);
    expect(pool[0]).toMatchObject({ ranks: { dense: 2, exact_words: 1 } });
    expect(pool[0].fusedScore).toBeCloseTo(0.7 / 62 + 0.3 / 61, 12);
    expect(pool.find((p) => p.id === 'r2')).toMatchObject({ ranks: { recency: 1 }, fusedScore: 0 });
    expect(pool.find((p) => p.id === 'd1')!.ranks).toEqual({ dense: 1, recency: 3 });
  });

  it('at the starting weights an exact-words-only first hit sorts after sixty dense candidates', () => {
    const dense = Array.from({ length: 60 }, (_, i) => t(`d${String(i).padStart(2, '0')}`));
    const pool = fuseLegs({ dense, exactWords: [t('only-words')], recency: [] }, RECALL_CONSTANTS);
    expect(pool.findIndex((p) => p.id === 'only-words')).toBe(60);
    expect(0.3 / 61).toBeLessThan(0.7 / 120);
  });

  it('the starting constants are the ones the docs list', () => {
    expect(RECALL_CONSTANTS).toEqual({ rrfK: 60, denseWeight: 0.7, sparseWeight: 0.3, recencyWeight: 0, overFetch: 3, topK: 20, nearDuplicate: 0.8, recentTopK: 10 });
  });
});
