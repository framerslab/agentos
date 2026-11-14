/**
 * @fileoverview The exact-words and recency recall legs over a real MemoryStore: on a Brain (SQLite on every run,
 * Postgres where the `test` job's service is set) the legs read `memory_traces` and its full-text index through the
 * adapter, with the turn's scopes, types and time written into the query before its limit; without a Brain the
 * exact-words leg reads the in-process index, which follows the store's writes and deletes. Every candidate passes
 * one eligibility gate, and the legs count what it drops, never naming it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Brain } from '../../src/cognition/memory/retrieval/store/Brain';
import type { MemoryStore } from '../../src/cognition/memory/retrieval/store/MemoryStore';
import {
  exactWordsLeg,
  isEligibleForRecall,
  lexicalBackendOf,
  recencyLeg,
  ScopedLexicalIndex,
} from '../../src/cognition/memory/retrieval/recall';
import { ENGINES, FlatEmbedder, U1, storeOver, trace, type OpenedBrain } from './helpers/recallFixtures';

const NOW = Date.UTC(2026, 10, 10);
const ask = (query: string, over: Record<string, unknown> = {}) => ({ query, scopes: U1, limit: 60, now: NOW, ...over });
/** A policy that allows everything but authorization. */
const NO_AUTHORIZATION = { usableForAuthorization: false, usableForPersonalization: true, usableForFactClaim: true };

describe.each(ENGINES)('the durable legs on %s', (engine, open) => {
  let db: OpenedBrain;
  let store: MemoryStore;
  beforeEach(async () => {
    db = await open();
    store = await storeOver(db.brain, new FlatEmbedder());
  });
  afterEach(async () => {
    store.dispose();
    await db.close();
  });

  it("exact words finds a trace by its words, in the turn's scopes only, with the scope applied before the limit", async () => {
    await store.store(trace('mine', 'The locker code is 4471 for the east gym.'));
    for (let i = 0; i < 5; i++) {
      await store.store(trace(`theirs-${i}`, `Locker code ${i}: the east gym locker code is 9${i}02.`, { scopeId: 'u2' }));
    }
    await store.store(trace('org-b', 'Locker code for the org is 5555.', { scope: 'organization', scopeId: 'B' }));
    const leg = await exactWordsLeg({ store, lexical: null }, ask('What is my locker code?', { limit: 1 }));
    expect(leg).toMatchObject({ leg: 'exact_words', ran: true, ineligible: 0 });
    // Five better-or-equal matches in u2 never took the one slot.
    expect(leg.traces.map((t) => t.id)).toEqual(['mine']);
    if (engine === 'postgres') expect(lexicalBackendOf(store, null)).toBe('postgres_tsvector');
    else expect(['fts5', 'fts4']).toContain(lexicalBackendOf(store, null));
  });

  it('recency returns the newest traces of the scopes, newest first, under its limit', async () => {
    for (let i = 0; i < 12; i++) await store.store(trace(`t${i}`, `Note ${i} about the garden.`));
    await store.store(trace('other', 'A newer note in another scope.', { scopeId: 'u2' }));
    const leg = await recencyLeg({ store }, ask('', { limit: 10 }));
    expect(leg).toMatchObject({ leg: 'recency', ran: true, ineligible: 0 });
    expect(leg.traces.map((t) => t.id)).toEqual(['t11', 't10', 't9', 't8', 't7', 't6', 't5', 't4', 't3', 't2']);
  });

  it('types and timeRange.after are written into the query; confidence and usableFor are checked after the load and counted', async () => {
    await store.store(trace('old', 'The harbor pass renews in March.', { createdAt: Date.UTC(2026, 0, 1) }));
    await store.store(trace('episodic', 'We talked about the harbor pass.', { type: 'episodic' }));
    await store.store(
      trace('unsure', 'The harbor pass may cost forty.', {
        provenance: { sourceType: 'agent_inference', sourceTimestamp: NOW, confidence: 0.2, verificationCount: 0 },
      }),
    );
    await store.store(trace('no-auth', 'The harbor pass number is 7781.', { policy: NO_AUTHORIZATION }));
    await store.store(trace('good', 'The harbor pass is in the blue folder.'));
    const filters = { types: ['semantic'], after: Date.UTC(2026, 5, 1), minConfidence: 0.5, usableFor: ['authorization'] };
    for (const leg of [exactWordsLeg({ store, lexical: null }, ask('harbor pass', filters)), recencyLeg({ store }, ask('', filters))]) {
      const r = await leg;
      expect(r.traces.map((t) => t.id)).toEqual(['good']);
      // `unsure` and `no-auth`; `old` and `episodic` never left the database.
      expect(r.ineligible).toBe(2);
    }
  });

  it('rows the gate drops give way to the rows after them, so an eligible trace past them still fills the limit', async () => {
    const unsure = { provenance: { sourceType: 'agent_inference' as const, sourceTimestamp: NOW, confidence: 0.2, verificationCount: 0 } };
    await store.store(trace('sure', 'The locker code 4471 was set in March for the east gym and the pool.'));
    await store.store(trace('unsure-1', 'Locker code, locker code, locker code.', unsure));
    await store.store(trace('unsure-2', 'Locker code, locker code, locker code.', unsure));
    const filters = { limit: 1, minConfidence: 0.5 };
    // The two unsure traces are the better matches and the newer traces: each leg's first rows are theirs.
    for (const leg of [exactWordsLeg({ store, lexical: null }, ask('locker code', filters)), recencyLeg({ store }, ask('', filters))]) {
      const r = await leg;
      expect(r.traces.map((t) => t.id)).toEqual(['sure']);
      expect(r.ineligible).toBe(2);
    }
  });

  it('a turn with no scopes reads nothing', async () => {
    await store.store(trace('a', 'Anything at all.'));
    expect(await exactWordsLeg({ store, lexical: null }, ask('anything', { scopes: [] }))).toMatchObject({ ran: false, reason: 'no_scopes', traces: [] });
    expect(await recencyLeg({ store }, ask('', { scopes: [] }))).toMatchObject({ ran: false, reason: 'no_scopes', traces: [] });
  });
});

/** `brain` with its full-text statements failing with `error()` while `state.down` holds. */
function failingFullText(brain: Brain, error: () => Error, state = { down: true }): Brain {
  return new Proxy(brain, {
    get: (target, property) =>
      property === 'all'
        ? async (sql: string, params?: unknown[]) => {
            if (state.down && (sql.includes('memory_traces_fts') || sql.includes('_tsv'))) throw error();
            return target.all(sql, params as never);
          }
        : Reflect.get(target, property, target),
  });
}

describe('the index check', () => {
  it.each([
    ['no such module: fts5', undefined],
    ['no such table: memory_traces_fts', undefined],
    ['column mt._tsv does not exist', '42703'],
  ])('"%s" marks the leg absent with no_index for that Brain, and the probe does not run again', async (message, code) => {
    const db = await ENGINES[0][1]();
    let probes = 0;
    const store = await storeOver(null);
    const broken = failingFullText(db.brain, () => {
      probes += 1;
      return Object.assign(new Error(message), code ? { code } : {});
    });
    (store as unknown as { brain: Brain }).brain = broken;
    for (let i = 0; i < 3; i++) {
      expect(await exactWordsLeg({ store, lexical: null }, ask('locker'))).toMatchObject({ ran: false, reason: 'no_index', traces: [] });
    }
    expect(probes).toBe(1);
    expect(lexicalBackendOf(store, null)).toBe('none');
    store.dispose();
    await db.close();
  });

  it('any other probe error is query_error for that turn only, and the probe runs again on the next', async () => {
    const db = await ENGINES[0][1]();
    const store = await storeOver(db.brain, new FlatEmbedder());
    await store.store(trace('mine', 'The locker code is 4471.'));
    const state = { down: true };
    (store as unknown as { brain: Brain }).brain = failingFullText(db.brain, () => new Error('connection reset'), state);
    expect(await exactWordsLeg({ store, lexical: null }, ask('locker'))).toMatchObject({ ran: false, reason: 'query_error', traces: [] });
    state.down = false;
    expect((await exactWordsLeg({ store, lexical: null }, ask('locker'))).traces.map((t) => t.id)).toEqual(['mine']);
    store.dispose();
    await db.close();
  });

  (process.env.AGENTOS_TEST_POSTGRES_URL ? it : it.skip)('Postgres reports an undefined column with code 42703 through the adapter', async () => {
    const db = await ENGINES[1][1]();
    await expect(db.brain.all('SELECT mt._tsv_absent FROM memory_traces mt LIMIT 1')).rejects.toMatchObject({ code: '42703' });
    await db.close();
  });
});

describe('in process (no Brain)', () => {
  it('the index follows store, softDelete and deleteTraces, and searches only the scopes asked', async () => {
    const store = await storeOver(null, new FlatEmbedder());
    await store.store(trace('before', 'The locker code is 4471.'));
    // Seeded from what the store already holds.
    const lexical = new ScopedLexicalIndex(store);
    await store.store(trace('after', 'My locker is on the east side.'));
    await store.store(trace('theirs', 'Their locker code is 9902.', { scopeId: 'u2' }));
    const ids = async () => (await exactWordsLeg({ store, lexical }, ask('locker code'))).traces.map((t) => t.id);
    expect(await ids()).toEqual(['before', 'after']);
    expect(lexicalBackendOf(store, lexical)).toBe('in_process');
    await store.softDelete('before');
    expect(await ids()).toEqual(['after']);
    await store.deleteTraces(['after']);
    expect(await ids()).toEqual([]);
    expect(await exactWordsLeg({ store, lexical: null }, ask('locker code'))).toMatchObject({ ran: false, reason: 'no_store' });
    expect(lexicalBackendOf(store, null)).toBe('none');
    lexical.dispose();
    store.dispose();
  });

  it('a trace stored again after its delete is found again, and recency reads the cache', async () => {
    const store = await storeOver(null, new FlatEmbedder());
    const lexical = new ScopedLexicalIndex(store);
    await store.store(trace('back', 'The ferry leaves from pier 3.'));
    await store.softDelete('back');
    expect((await exactWordsLeg({ store, lexical }, ask('ferry pier'))).traces).toEqual([]);
    await store.store(trace('back', 'The ferry leaves from pier 3.'));
    expect((await exactWordsLeg({ store, lexical }, ask('ferry pier'))).traces.map((t) => t.id)).toEqual(['back']);
    await store.store(trace('newer', 'The bus leaves from stop 9.'));
    expect((await recencyLeg({ store }, ask('', { limit: 5 }))).traces.map((t) => t.id)).toEqual(['newer', 'back']);
    lexical.dispose();
    store.dispose();
  });

  it('the index follows a trace refileScope moves to another scope', async () => {
    const store = await storeOver(null, new FlatEmbedder());
    await store.store(trace('mover', 'The locker code is 4471.'));
    const lexical = new ScopedLexicalIndex(store);
    expect(await store.refileScope('user', 'u1', 'u2')).toBe(1);
    const leg = (scopeId: string) => exactWordsLeg({ store, lexical }, ask('locker code', { scopes: [{ scope: 'user', scopeId }] }));
    expect((await leg('u2')).traces.map((t) => t.id)).toEqual(['mover']);
    // The old scope's index no longer holds it: no match, so nothing for the gate to drop.
    expect(await leg('u1')).toMatchObject({ traces: [], ineligible: 0 });
    lexical.dispose();
    store.dispose();
  });

  it("the index follows a trace whose tags change and are persisted", async () => {
    const store = await storeOver(null, new FlatEmbedder());
    await store.store(trace('tagged', 'The ferry leaves from pier 3.'));
    const lexical = new ScopedLexicalIndex(store);
    expect((await exactWordsLeg({ store, lexical }, ask('harbor'))).traces).toEqual([]);
    store.getTrace('tagged')!.tags.push('harbor');
    await store.persistTraceMetadata('tagged');
    expect((await exactWordsLeg({ store, lexical }, ask('harbor'))).traces.map((t) => t.id)).toEqual(['tagged']);
    lexical.dispose();
    store.dispose();
  });

  it('in process the gate runs on every match before the limit, so a better match the gate drops takes no slot', async () => {
    const store = await storeOver(null, new FlatEmbedder());
    await store.store(trace('episode', 'Locker code, locker code, locker code.', { type: 'episodic' }));
    await store.store(trace('fact', 'The locker code is 4471.'));
    const lexical = new ScopedLexicalIndex(store);
    const leg = await exactWordsLeg({ store, lexical }, ask('locker code', { limit: 1, types: ['semantic'] }));
    expect(leg.traces.map((t) => t.id)).toEqual(['fact']);
    expect(leg.ineligible).toBe(1);
    lexical.dispose();
    store.dispose();
  });
});

describe('isEligibleForRecall', () => {
  const q = { scopes: U1, now: NOW };
  it.each([
    ['inactive', trace('a', 'x', { isActive: false }), q, false],
    ['another scope', trace('a', 'x', { scopeId: 'u2' }), q, false],
    ['an unrequested type', trace('a', 'x', { type: 'episodic' }), { ...q, types: ['semantic'] }, false],
    [
      'under minConfidence',
      trace('a', 'x', { provenance: { sourceType: 'agent_inference', sourceTimestamp: NOW, confidence: 0.2, verificationCount: 0 } }),
      { ...q, minConfidence: 0.5 },
      false,
    ],
    ['before timeRange.after', trace('a', 'x', { createdAt: 5 }), { ...q, after: 10 }, false],
    ['a policy that forbids a requested capability', trace('a', 'x', { policy: NO_AUTHORIZATION }), { ...q, usableFor: ['authorization'] }, false],
    ['eligible', trace('a', 'x', { policy: NO_AUTHORIZATION }), { ...q, types: ['semantic'], minConfidence: 0.5, after: 10, usableFor: ['personalization'] }, true],
  ])('%s', (_name, t, query, expected) => expect(isEligibleForRecall(t as never, query as never)).toBe(expected));
});
