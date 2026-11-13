/**
 * The hard-limits block as the last part of an agent's system prompt, and the split generateText makes when it sends
 * something else before that block.
 */
import { describe, expect, it } from 'vitest';
import { splitHardLimits, withHardLimitsLast } from '../hardLimitsSystem.js';
import { hardLimitsBlock } from '../../../cognition/substrate/personas/hardLimits.js';

const LIMITS = ['Never name a diagnosis.'];
const BLOCK = hardLimitsBlock(LIMITS)!;

describe('withHardLimitsLast', () => {
  it('leaves the prompt as it is when there are no limits', () => {
    const blocks = [{ text: 'A', cacheBreakpoint: true }];
    expect(withHardLimitsLast('Prose.', undefined)).toBe('Prose.');
    expect(withHardLimitsLast('Prose.', ['', '  '])).toBe('Prose.');
    expect(withHardLimitsLast(blocks, [])).toBe(blocks);
    expect(withHardLimitsLast(undefined, undefined)).toBeUndefined();
  });
  it('appends the block to a string after a blank line, and is the block alone with no prompt', () => {
    expect(withHardLimitsLast('Prose.', LIMITS)).toBe(`Prose.\n\n${BLOCK}`);
    expect(withHardLimitsLast(undefined, LIMITS)).toBe(BLOCK);
    expect(withHardLimitsLast('', LIMITS)).toBe(BLOCK);
  });
  it("adds one marked block after the host's blocks, with no cache breakpoint, and leaves theirs as they are", () => {
    const blocks = [{ text: 'A', cacheBreakpoint: true, cacheTtl: '1h' as const }, { text: 'B' }];
    expect(withHardLimitsLast(blocks, LIMITS)).toEqual([...blocks, { text: BLOCK, _hardLimits: true }]);
    expect(blocks).toHaveLength(2);
  });
});

describe('splitHardLimits', () => {
  it('splits a string that ends with the block it is told of', () => {
    expect(splitHardLimits(`Prose.\n\n${BLOCK}`, BLOCK)).toEqual({ head: 'Prose.', limits: BLOCK });
    expect(splitHardLimits(BLOCK, BLOCK)).toEqual({ head: undefined, limits: BLOCK });
  });
  it('does not split a string it was told nothing of, or one that does not end with the block', () => {
    expect(splitHardLimits(`Prose.\n\n${BLOCK}`, undefined)).toEqual({ head: `Prose.\n\n${BLOCK}`, limits: undefined });
    expect(splitHardLimits(`${BLOCK}\n\nMore.`, BLOCK)).toEqual({ head: `${BLOCK}\n\nMore.`, limits: undefined });
  });
  it('splits blocks at a marked last block only', () => {
    const host = [{ text: 'A', cacheBreakpoint: true }];
    expect(splitHardLimits([...host, { text: BLOCK, _hardLimits: true }], undefined)).toEqual({ head: host, limits: BLOCK });
    expect(splitHardLimits([{ text: BLOCK, _hardLimits: true }], undefined)).toEqual({ head: undefined, limits: BLOCK });
    expect(splitHardLimits([...host, { text: BLOCK }], BLOCK)).toEqual({ head: [...host, { text: BLOCK }], limits: undefined });
  });
});
