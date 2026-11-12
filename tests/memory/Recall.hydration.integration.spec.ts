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
import { ENGINES, FlatEmbedder, NOOP_GRAPH, U1, storeOver, trace } from './helpers/recallFixtures';
import { MemoryStore } from '../../src/cognition/memory/retrieval/store/MemoryStore';
import { InMemoryVectorStore } from '../../src/cognition/rag/vector_stores/InMemoryVectorStore';
import { MemoryUpdateTool } from '../../src/cognition/memory/io/tools/MemoryUpdateTool';
import type { ToolExecutionContext } from '../../src/core/tools/ITool';

const NOW = Date.UTC(2026, 10, 10);
const NEUTRAL = { valence: 0, arousal: 0, dominance: 0 };
const TOOL_CONTEXT = { gmiId: 'recall-test', personaId: 'recall-test', userContext: { userId: 'u1' } } as unknown as ToolExecutionContext;

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

  it("a store() of a cached trace that lands while its row is read keeps its own policy: the older row read before it is not applied", async () => {
    const db = await open();
    const store = await storeOver(db.brain, new FlatEmbedder());
    const everything = { usableForAuthorization: true, usableForPersonalization: true, usableForFactClaim: true };
    const narrow = { usableForAuthorization: false, usableForPersonalization: true, usableForFactClaim: true };
    await store.store(trace('pass', 'The harbor pass number is 7781.', { policy: everything }));
    // The by-id load reads the rows; before they come back, this process stores the trace again under a narrower policy.
    let armed = true;
    (store as unknown as { brain: Brain }).brain = new Proxy(db.brain, {
      get: (b, p) =>
        p === 'all'
          ? async (sql: string, params?: unknown[]) => {
              const rows = await b.all(sql, params as never);
              if (armed && sql.includes('id IN')) {
                armed = false;
                await store.store(trace('pass', 'The harbor pass number is 7781.', { policy: narrow }));
              }
              return rows;
            }
          : Reflect.get(b, p, b),
    });

    const { traces } = await store.loadTracesForRecall(['pass']);
    expect(armed).toBe(false);
    expect(traces.get('pass')!.policy).toEqual(narrow);
    expect(store.getTrace('pass')!.policy).toEqual(narrow);
    expect(isEligibleForRecall(traces.get('pass')!, { scopes: U1, now: NOW, usableFor: ['authorization'] })).toBe(false);
    store.dispose();
    await db.close();
  });

  it("a cached trace stored again elsewhere with other words is returned as the row holds it, words and trust together; the cached copy keeps its own", async () => {
    const db = await open();
    const store = await storeOver(db.brain, new FlatEmbedder());
    const narrow = { usableForAuthorization: false, usableForPersonalization: true, usableForFactClaim: true };
    const everything = { usableForAuthorization: true, usableForPersonalization: true, usableForFactClaim: true };
    const said = { sourceType: 'user_statement' as const, sourceTimestamp: NOW - 120_000, confidence: 1, verificationCount: 0 };
    await store.store(trace('pass', 'The harbor pass number is 7781.', { policy: narrow, provenance: said }));
    // Another process stores a tool's result under the same id: other words, another source, a policy that allows authorization.
    const row = await db.brain.get<{ metadata: string }>('SELECT metadata FROM memory_traces WHERE brain_id = ? AND id = ?', [db.brain.brainId, 'pass']);
    const looked = { sourceType: 'tool_result', sourceTimestamp: NOW - 60_000, confidence: 1, verificationCount: 1, lastVerifiedAt: NOW - 60_000 };
    await db.brain.run('UPDATE memory_traces SET content = ?, metadata = ? WHERE brain_id = ? AND id = ?', [
      'The harbor pass on file is 9900.',
      JSON.stringify({ ...JSON.parse(row!.metadata), provenance: looked, policy: everything }),
      db.brain.brainId,
      'pass',
    ]);

    const { traces } = await store.loadTracesForRecall(['pass']);
    expect(traces.get('pass')).toMatchObject({ content: 'The harbor pass on file is 9900.', policy: everything, provenance: looked });
    // The cached copy and its vector are of the words this process stored: its trust is not replaced by another text's.
    expect(store.getTrace('pass')).toMatchObject({ content: 'The harbor pass number is 7781.', policy: narrow, provenance: said });
    store.dispose();
    await db.close();
  });

  it('a cached trace whose words memory_update changed is returned with the words its row holds, so exact words return the text they matched', async () => {
    const db = await open();
    const store = await storeOver(db.brain, new FlatEmbedder());
    await store.store(trace('pass', 'The harbor pass number is 7781.'));
    const result = await new MemoryUpdateTool(db.brain).execute({ traceId: 'pass', content: 'The ferry ticket number is 5520.' }, TOOL_CONTEXT);
    expect(result).toMatchObject({ success: true, output: { updated: true } });

    const leg = await exactWordsLeg({ store, lexical: null }, { query: 'ferry ticket', scopes: U1, limit: 5, now: NOW });
    expect(leg.traces.map((t) => [t.id, t.content])).toEqual([['pass', 'The ferry ticket number is 5520.']]);
    store.dispose();
    await db.close();
  });

  it('a cached trace whose row was written since with another type and creation time is returned as the row holds them, so the gate reads what the query selected', async () => {
    const db = await open();
    const store = await storeOver(db.brain, new FlatEmbedder());
    await store.store(trace('pass', 'The harbor pass number is 7781.', { type: 'semantic', createdAt: NOW - 86_400_000 }));
    // Another process stores the same words under the same id as an episode, created later.
    await db.brain.run('UPDATE memory_traces SET type = ?, created_at = ? WHERE brain_id = ? AND id = ?', ['episodic', NOW - 60_000, db.brain.brainId, 'pass']);

    const leg = await exactWordsLeg({ store, lexical: null }, { query: 'harbor pass', scopes: U1, limit: 5, now: NOW, types: ['episodic'], after: NOW - 120_000 });
    expect(leg).toMatchObject({ ran: true, ineligible: 0 });
    expect(leg.traces.map((t) => [t.id, t.type, t.createdAt])).toEqual([['pass', 'episodic', NOW - 60_000]]);
    expect(store.getTrace('pass')).toMatchObject({ type: 'semantic', createdAt: NOW - 86_400_000 });
    store.dispose();
    await db.close();
  });

  it('a cached trace whose row was stored again without a policy loses the one it held, as a store that loads the row would read it', async () => {
    const db = await open();
    const store = await storeOver(db.brain, new FlatEmbedder());
    const noAuthorization = { usableForAuthorization: false, usableForPersonalization: true, usableForFactClaim: true };
    await store.store(trace('pass', 'The harbor pass number is 7781.', { policy: noAuthorization }));
    // Another writer stores the trace again with the same words and no policy.
    const row = await db.brain.get<{ metadata: string }>('SELECT metadata FROM memory_traces WHERE brain_id = ? AND id = ?', [db.brain.brainId, 'pass']);
    const { policy: _dropped, ...withoutPolicy } = JSON.parse(row!.metadata) as Record<string, unknown>;
    await db.brain.run('UPDATE memory_traces SET metadata = ? WHERE brain_id = ? AND id = ?', [JSON.stringify(withoutPolicy), db.brain.brainId, 'pass']);

    const { traces } = await store.loadTracesForRecall(['pass']);
    expect(traces.get('pass')!.policy).toBeUndefined();
    expect(isEligibleForRecall(traces.get('pass')!, { scopes: U1, now: NOW, usableFor: ['authorization'] })).toBe(true);
    expect((await store.loadTracesForRecall(['pass'])).traces.get('pass')!.policy).toBeUndefined();
    store.dispose();
    await db.close();
  });

  it('a trace a sibling store revived, whose row was stored again without a policy, loses the one it held there too', async () => {
    const db = await open();
    // Two stores on one vector index and one Brain: a revival in one is filed in the other, which never read the row.
    const vectorStore = new InMemoryVectorStore();
    await vectorStore.initialize({ id: `recall-${Math.random().toString(36).slice(2)}`, type: 'in_memory', defaultEmbeddingDimension: 32, similarityMetric: 'cosine' } as never);
    const make = () => {
      const made = new MemoryStore({ vectorStore, embeddingManager: new FlatEmbedder() as never, knowledgeGraph: NOOP_GRAPH as never, collectionPrefix: 'cogmem' });
      made.setBrain(db.brain);
      return made;
    };
    const writer = make();
    const sibling = make();
    const noAuthorization = { usableForAuthorization: false, usableForPersonalization: true, usableForFactClaim: true };
    await writer.store(trace('pass', 'The harbor pass number is 7781.', { policy: noAuthorization }));
    await writer.softDelete('pass');
    await writer.store(trace('pass', 'The harbor pass number is 7781.', { policy: noAuthorization }));
    expect(sibling.getTrace('pass')?.policy).toEqual(noAuthorization);
    const row = await db.brain.get<{ metadata: string }>('SELECT metadata FROM memory_traces WHERE brain_id = ? AND id = ?', [db.brain.brainId, 'pass']);
    const { policy: _dropped, ...withoutPolicy } = JSON.parse(row!.metadata) as Record<string, unknown>;
    await db.brain.run('UPDATE memory_traces SET metadata = ? WHERE brain_id = ? AND id = ?', [JSON.stringify(withoutPolicy), db.brain.brainId, 'pass']);

    const { traces } = await sibling.loadTracesForRecall(['pass']);
    expect(traces.get('pass')!.policy).toBeUndefined();
    expect(isEligibleForRecall(traces.get('pass')!, { scopes: U1, now: NOW, usableFor: ['authorization'] })).toBe(true);
    writer.dispose();
    sibling.dispose();
    await db.close();
  });

  it("this process's own changes to a cached trace stay while its row is as this store wrote it: a verification count it persisted, a gist of its words", async () => {
    const db = await open();
    const store = await storeOver(db.brain, new FlatEmbedder());
    const hourly = { usableForAuthorization: true, usableForPersonalization: true, usableForFactClaim: true, requiresReverificationAfterMs: 3_600_000 };
    const stated = { sourceType: 'user_statement' as const, sourceTimestamp: NOW - 172_800_000, confidence: 1, verificationCount: 0 };
    await store.store(trace('pass', 'The harbor pass number is 7781, renewed at the east office.', { policy: hourly, provenance: stated }));
    const cached = store.getTrace('pass')!;
    cached.provenance.verificationCount = 1;
    cached.provenance.lastVerifiedAt = NOW - 60_000;
    await store.persistTraceMetadata('pass');
    cached.content = 'Harbor pass 7781.';

    const { traces } = await store.loadTracesForRecall(['pass']);
    expect(traces.get('pass')).toBe(cached);
    expect(traces.get('pass')).toMatchObject({ content: 'Harbor pass 7781.', provenance: { verificationCount: 1, lastVerifiedAt: NOW - 60_000 } });
    expect(isEligibleForRecall(traces.get('pass')!, { scopes: U1, now: NOW, usableFor: ['authorization'] })).toBe(true);
    store.dispose();
    await db.close();
  });

  it('a trace deleted while the load waits on a later id is not returned', async () => {
    const db = await open();
    let release: () => void = () => undefined;
    let gate: Promise<void> | null = null;
    class HeldEmbedder extends FlatEmbedder {
      override async generateEmbeddings(input: { texts: string | string[] }) {
        if (gate) await gate;
        return super.generateEmbeddings(input);
      }
    }
    const store = await storeOver(db.brain, new HeldEmbedder());
    await insertVectorlessRow(db.brain, 'first', 'The harbor pass number is 7781.', NOW - 120_000);
    await insertVectorlessRow(db.brain, 'second', 'The ferry ticket number is 5520.', NOW - 60_000);
    let armed = true;
    let stored: Promise<void> | undefined;
    let deleted: Promise<unknown> | undefined;
    (store as unknown as { brain: Brain }).brain = new Proxy(db.brain, {
      get: (b, p) =>
        p === 'all'
          ? async (sql: string, params?: unknown[]) => {
              const rows = await b.all(sql, params as never);
              if (armed && sql.includes('id IN')) {
                armed = false;
                // A store() of `second` holds its turn; while the load waits on it, `first` (already read) is deleted,
                // and the store() is let go only once the delete has finished.
                gate = new Promise<void>((resolve) => { release = resolve; });
                stored = store.store(trace('second', 'The ferry ticket number is 5520.'));
                setTimeout(() => { deleted = store.deleteTraces(['first']).finally(() => release()); }, 50);
              }
              return rows;
            }
          : Reflect.get(b, p, b),
    });

    const { traces } = await store.loadTracesForRecall(['first', 'second']);
    await stored;
    await deleted;
    expect(armed).toBe(false);
    expect([...traces.keys()]).toEqual(['second']);
    store.dispose();
    await db.close();
  });

  it('a row with no vector that a store() of the same id replaces before its load is returned as that store() wrote it', async () => {
    const db = await open();
    let release: () => void = () => undefined;
    let gate: Promise<void> | null = null;
    // An embedder the test holds: the store() below waits on it while it holds the trace's turn.
    class HeldEmbedder extends FlatEmbedder {
      override async generateEmbeddings(input: { texts: string | string[] }) {
        if (gate) await gate;
        return super.generateEmbeddings(input);
      }
    }
    const store = await storeOver(db.brain, new HeldEmbedder());
    const everything = { usableForAuthorization: true, usableForPersonalization: true, usableForFactClaim: true };
    const narrow = { usableForAuthorization: false, usableForPersonalization: true, usableForFactClaim: true };
    const stated = { sourceType: 'user_statement', sourceTimestamp: NOW - 60_000, confidence: 1, verificationCount: 0 };
    await insertVectorlessRow(db.brain, 'vl', 'The harbor pass number is 7781.', NOW - 60_000, JSON.stringify({ scopeId: 'u1', policy: everything, provenance: stated }));
    let armed = true;
    let stored: Promise<void> | undefined;
    (store as unknown as { brain: Brain }).brain = new Proxy(db.brain, {
      get: (b, p) =>
        p === 'all'
          ? async (sql: string, params?: unknown[]) => {
              const rows = await b.all(sql, params as never);
              if (armed && sql.includes('id IN')) {
                armed = false;
                // A store() of the same id takes the trace's turn now and finishes after the load asks for it.
                gate = new Promise<void>((resolve) => { release = resolve; });
                stored = store.store(trace('vl', 'The harbor pass number is 7781.', { policy: narrow }));
                setTimeout(() => release(), 100);
              }
              return rows;
            }
          : Reflect.get(b, p, b),
    });

    const { traces } = await store.loadTracesForRecall(['vl']);
    await stored;
    expect(armed).toBe(false);
    expect(traces.get('vl')!.policy).toEqual(narrow);
    expect(isEligibleForRecall(traces.get('vl')!, { scopes: U1, now: NOW, usableFor: ['authorization'] })).toBe(false);
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
