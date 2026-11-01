/**
 * @file traitState.test.ts
 * A learner's trait state: a learnable trait's lifetime band; a load's persona rules (a moved baseline clamps the kept
 * values, and the honesty-humility floor rises with the persona and falls only by the operator's hand); an operator's
 * set and reset; the fields the digest covers; a stored row that does not parse. Beside them, the key a freeze is
 * stored under and the turns it covers, and the order the write chains keep.
 */
import { describe, expect, it } from 'vitest';
import { freezeCovers, freezeScopeKey } from '../hostCalls';
import { canonicalJson, sha256Hex } from '../ledger/canonical';
import {
  clampLearnable,
  newTraitState,
  parseTraitState,
  renderedTraits,
  traitDigest,
  withOperatorSet,
  withPersona,
} from '../traitState';
import { WriteChains } from '../writeChains';

const NOW = Date.UTC(2026, 9, 12, 12);
const PERSONA = { honesty: 0.9, emotionality: 0.4, extraversion: 0.8, agreeableness: 0.5, conscientiousness: 0.6, openness: 0.3 };

describe('a learnable trait', () => {
  it('stays within 0.2 of its baseline and inside [0.05, 0.95]', () => {
    expect(clampLearnable(0.9, 0.5)).toBe(0.7);
    expect(clampLearnable(0.1, 0.5)).toBeCloseTo(0.3, 10);
    expect(clampLearnable(0.99, 0.9)).toBe(0.95);
    expect(clampLearnable(0, 0.1)).toBe(0.05);
    expect(clampLearnable(Number.NaN, 0.6)).toBe(0.6);
  });
});

describe('a new state', () => {
  it("keeps the persona's values, their bands and the honesty floor", () => {
    const state = newTraitState(PERSONA, NOW);
    expect(state.baseline).toEqual(PERSONA);
    expect(state.current).toEqual({ extraversion: 0.8, agreeableness: 0.5, conscientiousness: 0.6, openness: 0.3 });
    expect(state.bands).toMatchObject({ honesty: 'high', extraversion: 'high', openness: 'low', agreeableness: 'moderate' });
    expect(state.honestyAtLastLoad).toBe(0.9);
    expect(state.day).toBe('2026-10-12');
    expect(renderedTraits(state, PERSONA, {})).toEqual(PERSONA);
  });
});

describe('a load', () => {
  it('moves the baseline to a changed persona and clamps the kept values into the new band', () => {
    const state = newTraitState(PERSONA, NOW);
    const moved = withPersona(state, { ...PERSONA, extraversion: 0.3 }, {})!;
    expect(moved.baseline.extraversion).toBe(0.3);
    expect(moved.current.extraversion).toBe(0.5);
    expect(moved.bands.extraversion).toBe('moderate');
    expect(withPersona(moved, { ...PERSONA, extraversion: 0.3 }, {})).toBeUndefined();
  });

  it('keeps rendering honesty-humility at its floor when the persona lowers it, until the operator sets it', () => {
    const state = newTraitState(PERSONA, NOW);
    const lowered = withPersona(state, { ...PERSONA, honesty: 0.2 }, {})!;
    expect(lowered.baseline.honesty).toBe(0.2);
    expect(lowered.honestyAtLastLoad).toBe(0.9);
    expect(renderedTraits(lowered, { ...PERSONA, honesty: 0.2 }, {}).honesty).toBe(0.9);
    const confirmed = withOperatorSet(lowered, { honesty: 0.2 }, {});
    expect(confirmed.operator).toEqual({ honesty: 0.2 });
    expect(confirmed.state.honestyAtLastLoad).toBe(0.2);
    expect(renderedTraits(confirmed.state, { ...PERSONA, honesty: 0.2 }, confirmed.operator).honesty).toBe(0.2);
    expect(withPersona(state, { ...PERSONA, honesty: 0.95 }, {})!.honestyAtLastLoad).toBe(0.95);
  });
});

describe("an operator's change", () => {
  it('sets each learnable trait inside its band and each operator trait in the map', () => {
    const { state, operator } = withOperatorSet(newTraitState(PERSONA, NOW), { extraversion: 0.2, emotionality: 0.9 }, { honesty: 0.7 });
    expect(state.current.extraversion).toBeCloseTo(0.6, 10);
    expect(state.bands.extraversion).toBe('moderate');
    expect(operator).toEqual({ honesty: 0.7, emotionality: 0.9 });
    expect(renderedTraits(state, PERSONA, operator)).toMatchObject({ honesty: 0.7, emotionality: 0.9 });
  });

  it('resets the learner to the persona and clears the map', () => {
    const fresh = newTraitState(PERSONA, NOW);
    const set = withOperatorSet(fresh, { extraversion: 0.65, honesty: 0.5 }, {});
    const reset = withOperatorSet(set.state, 'baseline', set.operator);
    expect(reset.operator).toEqual({});
    expect(reset.state.current).toEqual(fresh.current);
    expect(reset.state.honestyAtLastLoad).toBe(0.9);
  });
});

describe('the digest', () => {
  it('covers the baseline, the kept values, the bands and the honesty floor, and nothing a turn counts', async () => {
    const state = newTraitState(PERSONA, NOW);
    const expected = await sha256Hex(
      canonicalJson({ baseline: state.baseline, current: state.current, bands: state.bands, honestyAtLastLoad: 0.9 }),
    );
    expect(await traitDigest(state)).toBe(expected);
    expect(await traitDigest({ ...state, sentimentWindow: [0.5], day: '2026-10-13' } as typeof state)).toBe(expected);
    expect(await traitDigest({ ...state, honestyAtLastLoad: 0.5 })).not.toBe(expected);
  });

  it('reads a stored row that does not parse as defaults, which match no digest of a real state', async () => {
    const state = parseTraitState('{not json');
    expect(state.baseline.honesty).toBe(0.5);
    expect(await traitDigest(state)).not.toBe(await traitDigest(newTraitState(PERSONA, NOW)));
    const stored = newTraitState(PERSONA, NOW);
    expect(await traitDigest(parseTraitState(JSON.stringify(stored)))).toBe(await traitDigest(stored));
  });
});

describe('a freeze and a suspension', () => {
  it('are stored under everything, an agent, or one learner, and cover only those turns', () => {
    const learner = { namespace: 'A', agentKey: 'tutor', userId: '42' };
    expect(freezeScopeKey({ scope: 'all' })).toBe('all');
    expect(freezeScopeKey({ agentKey: 'tutor' })).toBe('agent|tutor');
    expect(freezeScopeKey({ learner })).toBe('learner|A|tutor|42');
    expect(freezeScopeKey({ learner: { ...learner, userId: 'a|b' } })).toBe('learner|A|tutor|a%7Cb');
    expect(freezeCovers({ scopeKey: 'all' }, { agentKey: 'coach' })).toBe(true);
    expect(freezeCovers({ scopeKey: 'agent|tutor' }, { agentKey: 'tutor' })).toBe(true);
    expect(freezeCovers({ scopeKey: 'agent|tutor' }, { agentKey: 'coach' })).toBe(false);
    expect(freezeCovers({ scopeKey: 'learner|A|tutor|42' }, { agentKey: 'tutor', learner })).toBe(true);
    expect(freezeCovers({ scopeKey: 'learner|A|tutor|42' }, { agentKey: 'tutor' })).toBe(false);
    expect(freezeCovers({ scopeKey: 'learner|A|tutor|42' }, { agentKey: 'tutor', learner: { ...learner, namespace: 'B' } })).toBe(false);
  });
});

describe('the write chains', () => {
  it("run one key's calls in order, a failed call included, and keep other keys apart", async () => {
    const chains = new WriteChains();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = chains.run('u', async () => {
      await gate;
      order.push('first');
    });
    const failed = chains.run('u', async () => {
      order.push('failed');
      throw new Error('write failed');
    });
    const third = chains.run('u', async () => {
      order.push('third');
      return 3;
    });
    await chains.run('v', async () => {
      order.push('other');
    });
    expect(order).toEqual(['other']);
    expect(chains.busy('u')).toBe(true);
    release();
    await first;
    await expect(failed).rejects.toThrow('write failed');
    await expect(third).resolves.toBe(3);
    expect(order).toEqual(['other', 'first', 'failed', 'third']);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chains.busy('u')).toBe(false);
  });
});
