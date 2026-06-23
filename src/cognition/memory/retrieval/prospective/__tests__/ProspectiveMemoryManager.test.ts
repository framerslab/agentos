/**
 * @fileoverview Unit tests for ProspectiveMemoryManager — focused on the
 * optional `tierRank` visibility gate added 2026-06-23.
 *
 * The gate lets a caller pass `maxTierRank` to `check()`; items registered with
 * a higher `tierRank` are withheld from the fired set BEFORE trigger evaluation,
 * so a withheld context/time item is never consumed and can still fire later at
 * a higher max. Items with no `tierRank` always pass (legacy/back-compat).
 */
import { describe, it, expect } from 'vitest';
import { ProspectiveMemoryManager } from '../ProspectiveMemoryManager';

async function seed(): Promise<ProspectiveMemoryManager> {
  const m = new ProspectiveMemoryManager();
  await m.register({
    content: 'safe item',
    triggerType: 'time_based',
    triggerAt: 1,
    importance: 0.5,
    recurring: false,
    tierRank: 0,
  });
  await m.register({
    content: 'mature item',
    triggerType: 'time_based',
    triggerAt: 1,
    importance: 0.5,
    recurring: false,
    tierRank: 2,
  });
  await m.register({
    content: 'legacy item',
    triggerType: 'time_based',
    triggerAt: 1,
    importance: 0.5,
    recurring: false,
  });
  return m;
}

describe('ProspectiveMemoryManager — tierRank gate', () => {
  it('withholds items whose tierRank exceeds maxTierRank; legacy items always pass', async () => {
    const m = await seed();
    const fired = await m.check({ now: 1000, maxTierRank: 1 });
    const contents = fired.map((i) => i.content);
    expect(contents).toContain('safe item'); // rank 0 <= 1
    expect(contents).toContain('legacy item'); // undefined rank always passes
    expect(contents).not.toContain('mature item'); // rank 2 > 1 withheld
  });

  it('does not consume a withheld item — it fires later at a higher max', async () => {
    const m = await seed();
    await m.check({ now: 1000, maxTierRank: 1 }); // mature withheld, must NOT be marked triggered
    const fired = await m.check({ now: 2000, maxTierRank: 3 }); // now allowed
    expect(fired.map((i) => i.content)).toContain('mature item');
  });

  it('no maxTierRank → no gating (every item fires)', async () => {
    const m = await seed();
    const fired = await m.check({ now: 1000 });
    expect(fired.map((i) => i.content)).toEqual(
      expect.arrayContaining(['safe item', 'mature item', 'legacy item']),
    );
  });
});
