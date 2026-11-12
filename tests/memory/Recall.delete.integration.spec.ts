/**
 * @fileoverview A deleted memory comes back from no recall leg, on the durable path too: after `deleteTraces`,
 * `softDelete` and `deleteScope`, neither the exact-words leg nor the recency leg returns the trace, read through the
 * store that deleted it and through a second store on a Brain opened again, which never held the traces. On SQLite the
 * full-text index no longer holds a trace `deleteTraces` removed. SQLite on every run, Postgres where the `test` job's
 * service is set.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MemoryStore } from '../../src/cognition/memory/retrieval/store/MemoryStore';
import { exactWordsLeg, recencyLeg } from '../../src/cognition/memory/retrieval/recall';
import { ENGINES, FlatEmbedder, U1, storeOver, trace, type OpenedBrain } from './helpers/recallFixtures';

const NOW = Date.UTC(2026, 10, 10);
const ask = (query: string) => ({ query, scopes: U1, limit: 60, now: NOW });

describe.each(ENGINES)('deletes and the durable legs on %s', (engine, open) => {
  let db: OpenedBrain;
  let store: MemoryStore;
  let reader: MemoryStore;
  beforeEach(async () => {
    db = await open();
    store = await storeOver(db.brain, new FlatEmbedder());
    await store.store(trace('a', 'The locker code is 4471.'));
    await store.store(trace('b', 'The locker key is under the mat.'));
    await store.store(trace('c', 'The locker room opens at six.'));
    reader = await storeOver(await db.reopen(), new FlatEmbedder());
  });
  afterEach(async () => {
    store.dispose();
    reader.dispose();
    await db.close();
  });

  /** The ids each leg returns, read through `through`. */
  async function legIds(through: MemoryStore): Promise<{ exactWords: string[]; recency: string[] }> {
    const words = await exactWordsLeg({ store: through, lexical: null }, ask('locker'));
    const recent = await recencyLeg({ store: through }, ask(''));
    expect(words.ran).toBe(true);
    expect(recent.ran).toBe(true);
    return { exactWords: words.traces.map((t) => t.id).sort(), recency: recent.traces.map((t) => t.id).sort() };
  }

  it('deleteTraces: neither leg returns the trace, and the full-text index no longer holds it', async () => {
    expect(await legIds(store)).toEqual({ exactWords: ['a', 'b', 'c'], recency: ['a', 'b', 'c'] });
    await store.deleteTraces(['a']);
    for (const through of [store, reader]) expect(await legIds(through)).toEqual({ exactWords: ['b', 'c'], recency: ['b', 'c'] });
    if (engine === 'sqlite') {
      const row = await db.brain.get<{ n: number }>("SELECT count(*) AS n FROM memory_traces_fts WHERE memory_traces_fts MATCH 'locker'");
      expect(Number(row?.n)).toBe(2);
    }
  });

  it('softDelete: neither leg returns the trace before any rebuild', async () => {
    await store.softDelete('b');
    for (const through of [store, reader]) expect(await legIds(through)).toEqual({ exactWords: ['a', 'c'], recency: ['a', 'c'] });
  });

  it('deleteScope: both legs return nothing for the scope', async () => {
    await store.deleteScope('user', 'u1');
    for (const through of [store, reader]) expect(await legIds(through)).toEqual({ exactWords: [], recency: [] });
  });
});
