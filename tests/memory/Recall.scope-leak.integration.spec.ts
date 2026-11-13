/**
 * @fileoverview Under `retrieval: 'hybrid'` a turn reads only its own scopes: an exact-word match filed for another
 * user or another organization, and another user's newest rows, never reach the pool, the record or the block, and the
 * two SQL legs load no row of another scope (the scope is in their queries). SQLite on every run, Postgres where the
 * `test` job's service is set.
 */

import { describe, expect, it } from 'vitest';
import type { PADState } from '../../src/cognition/memory/core/config';
import { ENGINES, FlatEmbedder } from './helpers/recallFixtures';
import { memoryWith, plant } from './helpers/recallMemory';

const NEUTRAL: PADState = { valence: 0, arousal: 0, dominance: 0 };
const TURN_SCOPES = [
  { scope: 'user' as const, scopeId: 'u1' },
  { scope: 'organization' as const, scopeId: 'A' },
];

describe.each(ENGINES)('hybrid recall keeps to the turn scopes on %s', (_engine, open) => {
  it("no id of another user's or another organization's memory is in the record, the ranking or the block", async () => {
    const db = await open();
    const mem = await memoryWith({ retrieval: 'hybrid' }, new FlatEmbedder(), db.brain);
    await plant(mem, 'mine', 'The bike shed code is XQ7Z.');
    await plant(mem, 'org-a', 'The office bike rack is behind the shed.', { scope: 'organization', scopeId: 'A' });
    await plant(mem, 'other-user', 'The bike shed code is OTHER1.', { scopeId: 'u2' });
    await plant(mem, 'other-org', 'The bike shed code is OTHER2.', { scope: 'organization', scopeId: 'B' });
    for (let i = 0; i < 31; i++) await plant(mem, `u2-${i}`, `Another user's note ${i} about the bike shed.`, { scopeId: 'u2' });
    const foreign = (id: string) => id === 'other-user' || id === 'other-org' || id.startsWith('u2-');

    const out = await mem.manager.assembleForPrompt('What is the bike shed code?', 1600, NEUTRAL, { scopes: TURN_SCOPES });
    const capture = out.capture as unknown as { candidates: Array<{ id: string }>; legs: Array<{ leg: string; ran: boolean; ineligible: number }> };
    expect(capture.candidates.map((c) => c.id).filter(foreign)).toEqual([]);
    expect(capture.candidates.map((c) => c.id).sort()).toEqual(['mine', 'org-a']);
    for (const leg of capture.legs.filter((l) => l.leg !== 'dense')) expect(leg).toMatchObject({ ran: true, ineligible: 0 });
    expect(out.contextText).toContain('XQ7Z');
    expect(out.contextText).not.toContain('OTHER');
    expect(out.contextText).not.toContain("Another user's note");

    const result = await mem.manager.retrieve('What is the bike shed code?', NEUTRAL, { scopes: TURN_SCOPES });
    const ranked = (result.diagnostics.recall as unknown as { ranked: Array<{ id: string }> }).ranked;
    expect(ranked.map((r) => r.id).filter(foreign)).toEqual([]);
    expect(result.retrieved.map((t) => t.id).filter(foreign)).toEqual([]);
    await mem.close();
    await db.close();
  });

  it("a supplied candidate of another organization is dropped before the pool: not in the block or the record, counted with no id", async () => {
    const db = await open();
    const mem = await memoryWith({ retrieval: 'hybrid' }, new FlatEmbedder(), db.brain);
    await plant(mem, 'mine', 'The bike shed code is XQ7Z.');
    const out = await mem.manager.assembleForPrompt('What does a seat cost?', 1600, NEUTRAL, {
      scopes: TURN_SCOPES,
      supplied: [{ id: 'secret', text: 'Org B pays 90 a seat.', scope: { scope: 'organization', scopeId: 'B' } }],
    } as never);
    expect(out.contextText).not.toContain('Org B');
    expect(JSON.stringify(out.capture)).not.toContain('secret');
    expect((out.capture as unknown as { suppliedRejected: unknown }).suppliedRejected).toEqual({ outOfScope: 1, ineligible: 0 });
    await mem.close();
    await db.close();
  });
});
