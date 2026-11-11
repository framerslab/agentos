/**
 * @fileoverview `MemoryStore.loadTracesForRecall`, the by-id load a recall leg reads its candidates through: a trace
 * another store wrote after this one hydrated is found, a row with no vector is returned for the call without being
 * cached, a deleted trace comes back from nothing, a cached trace is checked against its row as a vector query checks
 * its hits, a failed read returns nothing and is counted, never thrown, and a trace's trust policy survives the Brain,
 * so the eligibility gate reads it on a trace loaded from a row. SQLite on every run, Postgres where the `test` job's
 * service is set.
 */

import { describe, expect, it } from 'vitest';
import type { Brain } from '../../src/cognition/memory/retrieval/store/Brain';
import { exactWordsLeg, isEligibleForRecall } from '../../src/cognition/memory/retrieval/recall';
import { ENGINES, FlatEmbedder, U1, storeOver, trace } from './helpers/recallFixtures';

const NOW = Date.UTC(2026, 10, 10);
const NEUTRAL = { valence: 0, arousal: 0, dominance: 0 };

/** Writes a row with no embedding, as an older release or another writer may hold one, and indexes its words. */
async function insertVectorlessRow(brain: Brain, id: string, content: string, at: number, metadata = '{"scopeId":"u1"}'): Promise<void> {
  await brain.run(
    `INSERT INTO memory_traces (brain_id, id, type, scope, content, embedding, strength, created_at, last_accessed, retrieval_count, tags, emotions, metadata, deleted, scope_id)
     VALUES (?, ?, 'semantic', 'user', ?, NULL, 0.5, ?, ?, 0, '[]', '{}', ?, 0, 'u1')`,
    [brain.brainId, id, content, at, at, metadata],
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

  it('a trace deleted before its load is returned by nothing, and a failed read returns nothing and is counted, never thrown', async () => {
    const db = await open();
    const store = await storeOver(db.brain, new FlatEmbedder());
    const other = await storeOver(await db.reopen(), new FlatEmbedder());
    await other.store(trace('gone', 'The locker code is 4471.'));
    await other.deleteTraces(['gone']);
    expect((await store.loadTracesForRecall(['gone'])).traces.size).toBe(0);
    await store.store(trace('cached', 'The ferry leaves from pier 3.'));
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
    // A cached trace is not returned unchecked: with its row unread, it is counted with the rest.
    await expect(store.loadTracesForRecall(['cached', 'q1', 'cached'])).resolves.toEqual({ traces: new Map(), unread: 2 });
    store.dispose();
    other.dispose();
    await db.close();
  });

  it('a cached trace whose row another process deleted or moved since is left out', async () => {
    const db = await open();
    const store = await storeOver(db.brain, new FlatEmbedder());
    await store.store(trace('gone', 'The locker code is 4471.'));
    await store.store(trace('moved', 'The locker key is under the mat.'));
    await store.store(trace('kept', 'The locker is on the east side.'));
    // Another process writes the rows: nothing reaches this store's cache or its namespace.
    await db.brain.run('UPDATE memory_traces SET deleted = 1 WHERE brain_id = ? AND id = ?', [db.brain.brainId, 'gone']);
    const row = await db.brain.get<{ metadata: string }>('SELECT metadata FROM memory_traces WHERE brain_id = ? AND id = ?', [db.brain.brainId, 'moved']);
    await db.brain.run('UPDATE memory_traces SET scope_id = ?, metadata = ? WHERE brain_id = ? AND id = ?', [
      'u2',
      JSON.stringify({ ...JSON.parse(row!.metadata), scopeId: 'u2' }),
      db.brain.brainId,
      'moved',
    ]);
    expect(store.getTrace('gone')).toBeDefined();
    expect(store.getTrace('moved')).toMatchObject({ scopeId: 'u1' });

    const { traces, unread } = await store.loadTracesForRecall(['gone', 'moved', 'kept']);
    expect(unread).toBe(0);
    expect([...traces.keys()]).toEqual(['kept']);
    const leg = await exactWordsLeg({ store, lexical: null }, { query: 'locker', scopes: U1, limit: 60, now: NOW });
    expect(leg.traces.map((t) => t.id)).toEqual(['kept']);
    store.dispose();
    await db.close();
  });

  it('a cached trace takes the trust policy its row holds now, as another process stored it again', async () => {
    const db = await open();
    const store = await storeOver(db.brain, new FlatEmbedder());
    const everything = { usableForAuthorization: true, usableForPersonalization: true, usableForFactClaim: true };
    const narrower = { usableForAuthorization: false, usableForPersonalization: true, usableForFactClaim: true };
    await store.store(trace('pass', 'The harbor pass number is 7781.', { policy: everything }));
    const row = await db.brain.get<{ metadata: string }>('SELECT metadata FROM memory_traces WHERE brain_id = ? AND id = ?', [db.brain.brainId, 'pass']);
    await db.brain.run('UPDATE memory_traces SET metadata = ? WHERE brain_id = ? AND id = ?', [
      JSON.stringify({ ...JSON.parse(row!.metadata), policy: narrower }),
      db.brain.brainId,
      'pass',
    ]);
    expect(store.getTrace('pass')!.policy).toEqual(everything);

    const { traces } = await store.loadTracesForRecall(['pass']);
    expect(traces.get('pass')!.policy).toEqual(narrower);
    expect(isEligibleForRecall(traces.get('pass')!, { scopes: U1, now: NOW, usableFor: ['authorization'] })).toBe(false);
    store.dispose();
    await db.close();
  });

  it("a cached trace stored again elsewhere takes the row's provenance with its policy, so a verification the row does not hold cannot extend it", async () => {
    const db = await open();
    const store = await storeOver(db.brain, new FlatEmbedder());
    const everything = { usableForAuthorization: true, usableForPersonalization: true, usableForFactClaim: true };
    const hourly = { ...everything, requiresReverificationAfterMs: 3_600_000 };
    const fresh = { sourceType: 'user_statement' as const, sourceTimestamp: NOW - 172_800_000, confidence: 1, verificationCount: 1, lastVerifiedAt: NOW };
    await store.store(trace('pass', 'The harbor pass number is 7781.', { policy: everything, provenance: fresh }));
    const row = await db.brain.get<{ metadata: string }>('SELECT metadata FROM memory_traces WHERE brain_id = ? AND id = ?', [db.brain.brainId, 'pass']);
    // Another process stores the trace again: a policy that asks for verification within the hour, last verified two days ago.
    await db.brain.run('UPDATE memory_traces SET metadata = ? WHERE brain_id = ? AND id = ?', [
      JSON.stringify({ ...JSON.parse(row!.metadata), policy: hourly, provenance: { ...fresh, lastVerifiedAt: NOW - 172_800_000 } }),
      db.brain.brainId,
      'pass',
    ]);

    const { traces } = await store.loadTracesForRecall(['pass']);
    expect(traces.get('pass')!.policy).toEqual(hourly);
    expect(traces.get('pass')!.provenance.lastVerifiedAt).toBe(NOW - 172_800_000);
    expect(isEligibleForRecall(traces.get('pass')!, { scopes: U1, now: NOW, usableFor: ['authorization'] })).toBe(false);
    store.dispose();
    await db.close();
  });

  it("a cached trace stored again elsewhere under the same policy takes the row's provenance, so the row's confidence is the one checked", async () => {
    const db = await open();
    const store = await storeOver(db.brain, new FlatEmbedder());
    const everything = { usableForAuthorization: true, usableForPersonalization: true, usableForFactClaim: true };
    const sure = { sourceType: 'user_statement' as const, sourceTimestamp: NOW - 60_000, confidence: 1, verificationCount: 0 };
    await store.store(trace('pass', 'The harbor pass number is 7781.', { policy: everything, provenance: sure }));
    const row = await db.brain.get<{ metadata: string }>('SELECT metadata FROM memory_traces WHERE brain_id = ? AND id = ?', [db.brain.brainId, 'pass']);
    // Another process stores the trace again under the same policy, at a confidence of 0.2.
    await db.brain.run('UPDATE memory_traces SET metadata = ? WHERE brain_id = ? AND id = ?', [
      JSON.stringify({ ...JSON.parse(row!.metadata), provenance: { ...sure, confidence: 0.2 } }),
      db.brain.brainId,
      'pass',
    ]);
    expect(store.getTrace('pass')!.provenance.confidence).toBe(1);

    const leg = await exactWordsLeg({ store, lexical: null }, { query: 'harbor pass', scopes: U1, limit: 5, now: NOW, minConfidence: 0.5 });
    expect(leg).toMatchObject({ ran: true, traces: [], ineligible: 1 });
    expect(store.getTrace('pass')!.provenance).toEqual({ ...sure, confidence: 0.2 });
    store.dispose();
    await db.close();
  });

  it("a verification this process recorded stays when the row holds the same statement, as persistTraceMetadata writes it beside the row", async () => {
    const db = await open();
    const store = await storeOver(db.brain, new FlatEmbedder());
    const hourly = { usableForAuthorization: true, usableForPersonalization: true, usableForFactClaim: true, requiresReverificationAfterMs: 3_600_000 };
    const stated = { sourceType: 'user_statement' as const, sourceTimestamp: NOW - 172_800_000, confidence: 1, verificationCount: 1 };
    await store.store(trace('pass', 'The harbor pass number is 7781.', { policy: hourly, provenance: stated }));
    // The consolidation pass verifies the trace in this process: the cached trace and the vector store hold the time, the row does not.
    store.getTrace('pass')!.provenance.lastVerifiedAt = NOW - 60_000;
    await store.persistTraceMetadata('pass');

    const { traces } = await store.loadTracesForRecall(['pass']);
    expect(traces.get('pass')!.provenance.lastVerifiedAt).toBe(NOW - 60_000);
    expect(isEligibleForRecall(traces.get('pass')!, { scopes: U1, now: NOW, usableFor: ['authorization'] })).toBe(true);
    store.dispose();
    await db.close();
  });

  it('a row with no vector that a move refiles between its read and its load is returned as the Brain holds it after the move', async () => {
    const db = await open();
    const store = await storeOver(db.brain, new FlatEmbedder());
    await insertVectorlessRow(db.brain, 'moving', 'The locker key is under the mat.', Date.UTC(2026, 10, 2));
    let moving = false;
    let movedCount: number | undefined;
    (store as unknown as { brain: Brain }).brain = new Proxy(db.brain, {
      get: (target, property) =>
        property === 'all'
          ? async (sql: string, params?: unknown[]) => {
              const rows = await target.all(sql, params as never);
              // The move runs once the load has read the rows, before it files them.
              if (!moving && sql.includes('id IN')) {
                moving = true;
                movedCount = await store.refileScope('user', 'u1', 'u2');
              }
              return rows;
            }
          : Reflect.get(target, property, target),
    });

    const { traces, unread } = await store.loadTracesForRecall(['moving']);
    expect(movedCount).toBe(1);
    expect(unread).toBe(0);
    expect(traces.get('moving')).toMatchObject({ scope: 'user', scopeId: 'u2' });
    expect(isEligibleForRecall(traces.get('moving')!, { scopes: U1, now: NOW })).toBe(false);
    store.dispose();
    await db.close();
  });

  it('a row that names its scope id in the scope_id column alone is read under that scope id', async () => {
    const db = await open();
    const store = await storeOver(db.brain, new FlatEmbedder());
    await insertVectorlessRow(db.brain, 'column-only', 'The locker key is under the mat.', Date.UTC(2026, 10, 2), '{}');
    const { traces } = await store.loadTracesForRecall(['column-only']);
    expect(traces.get('column-only')).toMatchObject({ scope: 'user', scopeId: 'u1' });
    const leg = await exactWordsLeg({ store, lexical: null }, { query: 'locker', scopes: U1, limit: 60, now: NOW });
    expect(leg).toMatchObject({ ran: true, ineligible: 0 });
    expect(leg.traces.map((t) => t.id)).toEqual(['column-only']);
    store.dispose();
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
