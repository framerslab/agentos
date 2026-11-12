/**
 * @fileoverview The hybrid recall's pure parts: the fused order and its tie-breaks, the starting constants'
 * arithmetic, which of two near-duplicate memories stays, the hybrid block's share, and the checks of the settings.
 */

import { describe, expect, it } from 'vitest';
import { assembleMemoryContext } from '../../src/cognition/memory/core/prompt/MemoryPromptAssembler';
import { assertRecallConfig, RecallOptionError } from '../../src/cognition/memory/retrieval/recall/budget';
import { dedupePool, dedupeTokens, nearDuplicate } from '../../src/cognition/memory/retrieval/recall/dedupe';
import { fuseLegs, RECALL_CONSTANTS } from '../../src/cognition/memory/retrieval/recall/fuse';
import { recallTokens } from '../../src/cognition/memory/retrieval/recall/lexical';
import { trace } from './helpers/recallFixtures';

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

  it('leaves no two near-duplicates kept when a newer candidate repeats two that do not repeat each other', () => {
    const common = 'w1 w2 w3 w4 w5 w6 w7 w8';
    // A and C share 8 of 12 words (0.67), so they are two memories; B shares 9 of 11 with each (0.82).
    const { kept, dropped } = dedupePool(
      [entry('A', `${common} alpha beta`, 0.01, 100), entry('C', `${common} gamma delta`, 0.01, 150), entry('B', `${common} alpha gamma`, 0.01, 200)],
      0.8,
    );
    for (const [i, a] of kept.entries()) {
      for (const b of kept.slice(i + 1)) expect(nearDuplicate(tokens(a.trace.content), tokens(b.trace.content), 0.8)).toBe(false);
    }
    expect(kept.map((e) => e.trace.id)).toEqual(['B']);
    expect(dropped.map((d) => [d.entry.trace.id, d.duplicateOf])).toEqual([['A', 'B'], ['C', 'B']]);
  });

  it('keeps two memories that differ in a one-character value, so a correction is never dropped for the value it corrects', () => {
    expect(nearDuplicate(dedupeTokens('My locker number is 7.'), dedupeTokens('My locker number is 9.'), 0.8)).toBe(false);
    expect(nearDuplicate(dedupeTokens('We meet in room B.'), dedupeTokens('We meet in room C.'), 0.8)).toBe(false);
    expect(nearDuplicate(dedupeTokens('My locker number is 7.'), dedupeTokens('my locker number is 7'), 0.8)).toBe(true);
    // The old value holds the higher fused score (recalled lately): with the value read as no word, the newer one is dropped.
    const { kept, dropped } = dedupePool([entry('old', 'My locker number is 7.', 0.02, 100), entry('new', 'My locker number is 9.', 0.015, 200)], 0.8);
    expect(kept.map((e) => e.trace.id)).toEqual(['old', 'new']);
    expect(dropped).toEqual([]);
  });

  it('keeps two memories that state different numbers or codes whatever else they share, so a correction in a long memory is never dropped for the value it corrects', () => {
    // Ten words shared and one apart: an index of 10 / 12 (0.83), over the 0.80 at which two texts are one.
    const office = 'The locker number for the downtown office beside the reception desk near the east entrance is';
    expect(nearDuplicate(dedupeTokens(`${office} 7.`), dedupeTokens(`${office} 9.`), 0.8)).toBe(false);
    expect(nearDuplicate(dedupeTokens(`${office} 4471.`), dedupeTokens(`${office} 4417.`), 0.8)).toBe(false);
    // A code with a digit in it is a value too.
    expect(nearDuplicate(dedupeTokens(`${office} B22.`), dedupeTokens(`${office} B27.`), 0.8)).toBe(false);
    // The same number in both, or a number only one of them holds, leaves the index to decide.
    expect(nearDuplicate(dedupeTokens(`${office} 7.`), dedupeTokens(`${office} 7!`), 0.8)).toBe(true);
    expect(nearDuplicate(dedupeTokens(`${office} 7.`), dedupeTokens(`${office} 7, set in 2026.`), 0.8)).toBe(true);
    // The old value holds the higher fused score (recalled lately): the newer one stays beside it.
    const { kept, dropped } = dedupePool([entry('old', `${office} 7.`, 0.02, 100), entry('new', `${office} 9.`, 0.015, 200)], 0.8);
    expect(kept.map((e) => e.trace.id)).toEqual(['old', 'new']);
    expect(dropped).toEqual([]);
  });
});

describe("the hybrid block's share", () => {
  const scored = (id: string, content: string) => ({
    ...trace(id, content),
    retrievalScore: 0.5,
    scoreBreakdown: { strengthScore: 0.5, similarityScore: 0.5, recencyScore: 0, emotionalCongruenceScore: 0, graphActivationScore: 0, importanceScore: 0.5 },
  });

  it('a share that counts as 0 adds nothing to the one it is merged with, so a valid episodic share keeps the section on', () => {
    const out = assembleMemoryContext({
      totalTokenBudget: 1600,
      allocation: { semanticRecall: -0.25, recentEpisodic: 0.25 },
      traits: {} as never,
      recallTraces: [scored('a', 'The bike shed code is XQ7Z.')] as never,
    });
    expect(out.contextText).toContain('XQ7Z');
    expect(out.allocation.recall).toBeCloseTo(0.25, 12);
    expect(out.lineOutcomes).toEqual([expect.objectContaining({ id: 'a', section: 'recall', outcome: 'included' })]);
  });
});

describe("the hybrid settings' checks", () => {
  it('refuses a constant the recall does not have, so a misspelt name never runs on the starting value', () => {
    expect(() => assertRecallConfig({ constants: { nearDup: 0.9 } } as never, 'test')).toThrow(/recall\.constants\.nearDup/);
    expect(() => assertRecallConfig({ constants: { denseweight: 0.5 } } as never, 'test')).toThrow(RecallOptionError);
  });

  it('refuses a count above 1,000, so topK × overFetch stays a finite number of rows', () => {
    expect(() => assertRecallConfig({ constants: { overFetch: 1e308 } } as never, 'test')).toThrow(/recall\.constants\.overFetch/);
    expect(() => assertRecallConfig({ constants: { topK: 1001 } } as never, 'test')).toThrow(RecallOptionError);
    expect(() => assertRecallConfig({ constants: { topK: 1000, overFetch: 1000, recentTopK: 1, nearDuplicate: 1, rrfK: 0 } } as never, 'test')).not.toThrow();
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
