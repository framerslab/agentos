/**
 * @fileoverview Supplied candidates under `retrieval: 'hybrid'` on a real memory: a fact the caller adds is shown as a
 * memory line and recorded with leg `supplied`, written nowhere; one outside the turn's scopes, every one on a turn with
 * no scopes, and every one on a turn that asks for a type, a confidence or a trust capability is dropped before the
 * pool and counted with no id; under `'dense'` they are not read and are counted.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import type { PADState } from '../../src/cognition/memory/core/config';
import type { MemoryScope } from '../../src/cognition/memory/core/types';
import { resetLoggerFactory, setLogger } from '../../src/core/logging/loggerFactory';
import { WordHashEmbedder } from './helpers/recallFixtures';
import { memoryWith, plant } from './helpers/recallMemory';

const NEUTRAL: PADState = { valence: 0, arousal: 0, dominance: 0 };
const ORG_A = [
  { scope: 'user' as const, scopeId: 'u1' },
  { scope: 'organization' as const, scopeId: 'A' },
];
type Fact = { id: string; text: string; scope: { scope: MemoryScope; scopeId: string }; score?: number; createdAt?: number };
const fact = (id: string, text: string, over: Partial<Fact> = {}): Fact => ({ id, text, scope: { scope: 'user', scopeId: 'u1' }, ...over });

type Capture = {
  legs: Array<{ leg: string; ran: boolean; candidates: number; ineligible: number }>;
  suppliedRejected?: { outOfScope: number; ineligible: number };
  candidates: Array<{ id: string; ranks: Record<string, number>; fusedScore: number; outcome: string; section?: string }>;
};
const captureOf = (context: { capture?: unknown }) => context.capture as Capture;

const logged: Array<Record<string, unknown>> = [];
const events = (name: string) => logged.filter((line) => line.event === name);
beforeEach(() => {
  logged.length = 0;
  setLogger(pino({ level: 'debug', base: undefined }, { write(line: string) { logged.push(JSON.parse(line)); } }));
});
afterEach(() => resetLoggerFactory());

describe('supplied candidates', () => {
  it('a supplied candidate in scope is shown as a memory line, captured with leg supplied, and written nowhere', async () => {
    const mem = await memoryWith({ retrieval: 'hybrid' }, new WordHashEmbedder());
    await plant(mem, 'stored', 'The ferry leaves from pier 3.');
    const store = mem.manager.getStore();
    const before = store.getTraceCount();
    const context = await mem.manager.assembleForPrompt('Which plan am I on?', 1600, NEUTRAL, {
      scopes: ORG_A,
      supplied: [fact('acct-plan', 'The account is on the Team plan, renewed 2026-10-01.', { score: 0.5, createdAt: Date.UTC(2026, 9, 1) })],
    } as never);
    expect(context.contextText).toContain('The account is on the Team plan');
    expect(context.contextText).toContain('2026-10-01');
    // Its line reads the relevance of a fact the caller vouches for, never the caller's ranking score.
    expect(context.contextText).toMatch(/Team plan[^\n]*relevance: 1\.00/);
    const c = captureOf(context);
    expect(c.candidates[0]).toMatchObject({ id: 'acct-plan', ranks: { supplied: 1 }, fusedScore: 0.5, outcome: 'included', section: 'recall' });
    expect(c.legs.find((l) => l.leg === 'supplied')).toMatchObject({ ran: true, candidates: 1, ineligible: 0 });
    expect(c.suppliedRejected).toBeUndefined();
    expect(events('memory.recall.supplied_rejected')).toEqual([]);
    // Written nowhere: not stored, not focused in working memory, not recorded as accessed.
    expect(store.getTraceCount()).toBe(before);
    expect(store.getTrace('acct-plan')).toBeUndefined();
    expect(mem.manager.getWorkingMemory().getSlots().map((slot) => JSON.stringify(slot)).join('\n')).not.toContain('acct-plan');
    await mem.close();
  });

  it('without a score a supplied candidate takes the lowest fused score of the pool', async () => {
    const mem = await memoryWith({ retrieval: 'hybrid' }, new WordHashEmbedder());
    await plant(mem, 'ferry', 'The ferry leaves from pier 3.');
    await plant(mem, 'bus', 'The bus leaves from stop 9.');
    const context = await mem.manager.assembleForPrompt('Which ferry leaves?', 1600, NEUTRAL, {
      scopes: ORG_A,
      supplied: [fact('tram', 'The tram goes from the square.')],
    } as never);
    const c = captureOf(context);
    const tram = c.candidates.find((x) => x.id === 'tram')!;
    const others = c.candidates.filter((x) => x.ranks.supplied === undefined);
    expect(others.length).toBeGreaterThan(0);
    expect(tram).toMatchObject({ ranks: { supplied: 1 }, outcome: 'included' });
    expect(tram.fusedScore).toBe(Math.min(...others.map((x) => x.fusedScore)));
    expect(context.contextText).toContain('The tram goes from the square.');
    await mem.close();
  });

  it("a supplied candidate outside the turn's scopes, and every one on a turn with no scopes, is dropped before the pool: counted, never named", async () => {
    const mem = await memoryWith({ retrieval: 'hybrid' }, new WordHashEmbedder());
    const secret = { id: 'secret', text: 'Org B pays 90 a seat.', scope: { scope: 'organization' as const, scopeId: 'B' } };
    const context = await mem.manager.assembleForPrompt('What does a seat cost?', 1600, NEUTRAL, {
      scopes: ORG_A,
      supplied: [secret, fact('ok', 'Org A pays 70 a seat.', { scope: { scope: 'organization', scopeId: 'A' } })],
    } as never);
    expect(context.contextText).toContain('Org A pays 70');
    expect(context.contextText).not.toContain('Org B');
    expect(JSON.stringify(context.capture)).not.toContain('secret');
    expect(captureOf(context).suppliedRejected).toEqual({ outOfScope: 1, ineligible: 0 });
    expect(events('memory.recall.supplied_rejected')).toEqual([expect.objectContaining({ out_of_scope: 1, ineligible: 0 })]);
    expect(JSON.stringify(events('memory.recall.supplied_rejected'))).not.toContain('secret');
    // A scope id written another way is another scope: the comparison is of the two fields as passed.
    const respelled = await mem.manager.assembleForPrompt('What does a seat cost?', 1600, NEUTRAL, {
      scopes: ORG_A,
      supplied: [fact('ok', 'Org A pays 70 a seat.', { scope: { scope: 'organization', scopeId: 'a' } })],
    } as never);
    expect(respelled.contextText).not.toContain('Org A pays 70');
    expect(captureOf(respelled).suppliedRejected).toEqual({ outOfScope: 1, ineligible: 0 });

    const unscoped = await mem.manager.retrieve('seat', NEUTRAL, { supplied: [secret] } as never);
    expect((unscoped.diagnostics.recall as unknown as Capture).suppliedRejected).toEqual({ outOfScope: 1, ineligible: 0 });
    expect(unscoped.retrieved.map((t) => t.id)).not.toContain('secret');
    await mem.close();
  });

  it.each([[{ types: ['semantic'] }], [{ minConfidence: 0.1 }], [{ usableFor: 'personalization' }]])(
    'on a turn that sets %j every supplied candidate is ineligible: it cannot show what the turn asks for',
    async (options) => {
      const mem = await memoryWith({ retrieval: 'hybrid' }, new WordHashEmbedder());
      const context = await mem.manager.assembleForPrompt('plan', 1600, NEUTRAL, {
        scopes: ORG_A,
        ...options,
        supplied: [fact('a', 'x y z'), fact('b', 'p q r')],
      } as never);
      const c = captureOf(context);
      expect(c.suppliedRejected).toEqual({ outOfScope: 0, ineligible: 2 });
      expect(c.candidates.map((x) => x.id)).not.toContain('a');
      expect(c.candidates.map((x) => x.id)).not.toContain('b');
      await mem.close();
    },
  );

  it('timeRange.after drops a supplied candidate dated before it; a blank id or text, or an id given twice, is ineligible; an id the pool holds is not added twice', async () => {
    const mem = await memoryWith({ retrieval: 'hybrid' }, new WordHashEmbedder());
    await plant(mem, 'stored', 'The ferry leaves from pier 3.');
    const early = await mem.manager.assembleForPrompt('ferry', 1600, NEUTRAL, {
      scopes: ORG_A,
      timeRange: { after: 10 },
      supplied: [fact('early', 'An early note on the ferry.', { createdAt: 5 })],
    } as never);
    expect(captureOf(early).suppliedRejected).toEqual({ outOfScope: 0, ineligible: 1 });
    expect(early.contextText).not.toContain('An early note');

    const blank = await mem.manager.assembleForPrompt('ferry', 1600, NEUTRAL, {
      scopes: ORG_A,
      supplied: [fact('', 'x'), fact('k', '   '), fact('twice', 'The first text.'), fact('twice', 'The second text.')],
    } as never);
    expect(captureOf(blank).suppliedRejected).toEqual({ outOfScope: 0, ineligible: 3 });
    expect(blank.contextText).toContain('The first text.');
    expect(blank.contextText).not.toContain('The second text.');

    const held = await mem.manager.assembleForPrompt('ferry', 1600, NEUTRAL, {
      scopes: ORG_A,
      supplied: [fact('stored', 'The ferry leaves from pier 3 at nine.')],
    } as never);
    const c = captureOf(held);
    expect(c.candidates.filter((x) => x.id === 'stored')).toHaveLength(1);
    expect(c.candidates.find((x) => x.id === 'stored')!.ranks.supplied).toBeUndefined();
    expect(c.legs.find((l) => l.leg === 'supplied')).toMatchObject({ ran: true, candidates: 0, ineligible: 0 });
    expect(held.contextText).not.toContain('at nine');
    await mem.close();
  });

  it('a retrieval policy reads recalled memories only: a supplied score neither lifts weak hits nor is suppressed with them', async () => {
    const empty = await memoryWith({ retrieval: 'hybrid' }, new WordHashEmbedder());
    const shown = await empty.manager.assembleForPrompt('Which plan am I on?', 1600, NEUTRAL, {
      scopes: ORG_A,
      policy: { minScore: 0.99 },
      supplied: [fact('acct-plan', 'The account is on the Team plan.', { score: 0.02 })],
    } as never);
    expect(shown.contextText).toContain('The account is on the Team plan.');
    expect(captureOf(shown).candidates).toEqual([expect.objectContaining({ id: 'acct-plan', outcome: 'included' })]);
    await empty.close();

    const mem = await memoryWith({ retrieval: 'hybrid' }, new WordHashEmbedder());
    await plant(mem, 'ferry', 'The ferry leaves from pier 3.');
    const result = await mem.manager.retrieve('Which ferry leaves?', NEUTRAL, {
      scopes: ORG_A,
      policy: { minScore: 0.99 },
      supplied: [fact('acct-plan', 'The account is on the Team plan.', { score: 1 })],
    } as never);
    // The weak recalled hit is suppressed as without the supplied fact; the fact stays.
    expect(result.diagnostics.suppressed).toBe('weak_hits');
    expect(result.retrieved.map((t) => t.id)).toEqual(['acct-plan']);
    await mem.close();
  });

  it('a call admits at most topK × overFetch supplied candidates, the best-scored first; the rest are counted as ineligible', async () => {
    const mem = await memoryWith({ retrieval: 'hybrid' }, new WordHashEmbedder());
    const many = Array.from({ length: 70 }, (_, i) => fact(`s${i}`, `Supplied fact number ${i} about the plan.`, { score: i }));
    const result = await mem.manager.retrieve('plan', NEUTRAL, { scopes: ORG_A, supplied: many } as never);
    const recall = result.diagnostics.recall as unknown as Capture;
    expect(recall.legs.find((l) => l.leg === 'supplied')).toMatchObject({ ran: true, candidates: 60, ineligible: 10 });
    expect(recall.suppliedRejected).toEqual({ outOfScope: 0, ineligible: 10 });
    const ids = new Set((result.diagnostics.recall as unknown as { ranked: Array<{ id: string }> }).ranked.map((r) => r.id));
    expect(ids.has('s69')).toBe(true);
    expect(ids.has('s9')).toBe(false);
    await mem.close();
  });

  it("under retrieval 'dense' supplied candidates are not read and are counted, with the line", async () => {
    const mem = await memoryWith(undefined, new WordHashEmbedder());
    const context = await mem.manager.assembleForPrompt('plan', 1600, NEUTRAL, {
      scopes: ORG_A,
      supplied: [fact('a', 'The account is on the Team plan.')],
    } as never);
    expect(context.contextText).not.toContain('Team plan');
    expect(captureOf(context).suppliedRejected).toEqual({ outOfScope: 0, ineligible: 1 });
    expect(events('memory.recall.supplied_rejected')).toHaveLength(1);
    await mem.close();
  });
});
