/**
 * @fileoverview `MemoryStore.loadTracesForRecall`, the by-id load a recall leg reads its candidates through: a trace
 * another store wrote after this one hydrated is found, a row with no vector is returned for the call without being
 * cached, a deleted trace comes back from nothing, a failed read is counted and never thrown, and a trace's trust
 * policy survives the Brain, so the eligibility gate reads it on a trace loaded from a row. SQLite on every run,
 * Postgres where the `test` job's service is set.
 */

import { describe, expect, it } from 'vitest';
import type { Brain } from '../../src/cognition/memory/retrieval/store/Brain';
import { exactWordsLeg, isEligibleForRecall } from '../../src/cognition/memory/retrieval/recall';
import { ENGINES, FlatEmbedder, U1, storeOver, trace } from './helpers/recallFixtures';

const NOW = Date.UTC(2026, 10, 10);
const NEUTRAL = { valence: 0, arousal: 0, dominance: 0 };

/** Writes a row with no embedding, as an older release or another writer may hold one, and indexes its words. */
async function insertVectorlessRow(brain: Brain, id: string, content: string, at: number): Promise<void> {
  await brain.run(
    `INSERT INTO memory_traces (brain_id, id, type, scope, content, embedding, strength, created_at, last_accessed, retrieval_count, tags, emotions, metadata, deleted, scope_id)
     VALUES (?, ?, 'semantic', 'user', ?, NULL, 0.5, ?, ?, 0, '[]', '{}', '{"scopeId":"u1"}', 0, 'u1')`,
    [brain.brainId, id, content, at, at],
  );
  const rebuild = brain.fullTextRebuild();
  await brain.run(rebuild.sql, rebuild.params as never);
}

describe.each(ENGINES)('loadTracesForRecall on %s', (_engine, open) => {
  it('a store finds a trace another store wrote after it hydrated, and returns a row with no vector for the call without caching it', async () => {
    const db = await open();
    const first = await storeOver(db.brain, new FlatEmbedder());
    await first.store(trace('a', 'The ferry leaves from pier 3.'));
    // The one whole-store hydration runs here.
    await first.query('ferry', NEUTRAL, { scopes: U1 });
    const second = await storeOver(await db.reopen(), new FlatEmbedder());
    await second.store(trace('x', 'The locker code is 4471.'));
    await insertVectorlessRow(db.brain, 'vectorless', 'The locker key is under the mat.', Date.UTC(2026, 10, 2));
    expect(first.getTrace('x')).toBeUndefined();

    const { traces, unread } = await first.loadTracesForRecall(['a', 'x', 'vectorless', 'never-existed']);
    expect(unread).toBe(0);
    expect([...traces.keys()].sort()).toEqual(['a', 'vectorless', 'x']);
    expect(traces.get('x')!.content).toBe('The locker code is 4471.');
    // Filed in the cache and the vector index, as hydration files a row.
    expect(first.getTrace('x')).toBeDefined();
    // Returned for this call only.
    expect(first.getTrace('vectorless')).toBeUndefined();
    expect(traces.get('vectorless')).toMatchObject({ scope: 'user', scopeId: 'u1', isActive: true });

    const leg = await exactWordsLeg({ store: first, lexical: null }, { query: 'locker', scopes: U1, limit: 60, now: NOW });
    expect(leg.traces.map((t) => t.id).sort()).toEqual(['vectorless', 'x']);
    first.dispose();
    second.dispose();
    await db.close();
  });

  it('a trace deleted before its load is returned by nothing, and a failed read is counted, never thrown', async () => {
    const db = await open();
    const store = await storeOver(db.brain, new FlatEmbedder());
    const other = await storeOver(await db.reopen(), new FlatEmbedder());
    await other.store(trace('gone', 'The locker code is 4471.'));
    await other.deleteTraces(['gone']);
    expect((await store.loadTracesForRecall(['gone'])).traces.size).toBe(0);
    const broken = new Proxy(db.brain, {
      get: (target, property) =>
        property === 'all'
          ? async () => {
              throw new Error('connection reset');
            }
          : Reflect.get(target, property, target),
    });
    (store as unknown as { brain: Brain }).brain = broken;
    await expect(store.loadTracesForRecall(['q1', 'q2'])).resolves.toEqual({ traces: new Map(), unread: 2 });
    store.dispose();
    other.dispose();
    await db.close();
  });

  it("a trace's trust policy is kept in its row, so a store that loads the row reads it", async () => {
    const db = await open();
    const writer = await storeOver(db.brain, new FlatEmbedder());
    const policy = { usableForAuthorization: false, usableForPersonalization: true, usableForFactClaim: true };
    await writer.store(trace('pass', 'The harbor pass number is 7781.', { policy }));
    const reader = await storeOver(await db.reopen(), new FlatEmbedder());
    const { traces } = await reader.loadTracesForRecall(['pass']);
    expect(traces.get('pass')!.policy).toEqual(policy);
    expect(isEligibleForRecall(traces.get('pass')!, { scopes: U1, now: NOW, usableFor: ['authorization'] })).toBe(false);
    expect(isEligibleForRecall(traces.get('pass')!, { scopes: U1, now: NOW, usableFor: ['personalization'] })).toBe(true);
    // The dense path's hydration keeps it too: the trace a fresh store recalls is refused for authorization.
    const fresh = await storeOver(await db.reopen(), new FlatEmbedder());
    const { scored } = await fresh.query('harbor pass', NEUTRAL, { scopes: U1 });
    expect(scored.find((t) => t.id === 'pass')?.policy).toEqual(policy);
    writer.dispose();
    reader.dispose();
    fresh.dispose();
    await db.close();
  });
});
