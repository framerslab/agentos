import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresAdapter, resolveStorageAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { PostgresVectorStore } from '../PostgresVectorStore.js';

const url = process.env.AGENTOS_TEST_POSTGRES_URL;
const prefix = `va_${randomUUID().replaceAll('-', '').slice(0, 12)}_`;
const config = {
  id: 'adapter-vectors', type: 'postgres' as const, manageSchema: false,
  tablePrefix: prefix, defaultDimension: 3, textSearchConfig: 'simple',
};
const doc = (id: string, tenantId = 'tenant-a') => ({
  id, embedding: [1, 0, 0], textContent: 'budget chapters',
  metadata: { tenantId, sourceId: id, aclGroups: [`account:${tenantId}`], ranks: [1, 2] },
});

describe.skipIf(!url)('adapter-backed Postgres vectors', () => {
  let db: StorageAdapter;
  let observer: StorageAdapter;
  let store: PostgresVectorStore;
  beforeAll(async () => {
    db = createPostgresAdapter({ connectionString: url!, max: 6 });
    observer = createPostgresAdapter({ connectionString: url!, max: 2 });
    await db.open();
    await observer.open();
    await db.exec('CREATE EXTENSION IF NOT EXISTS vector');
    for (const sql of PostgresVectorStore.schemaSql('chunks', 3, {
      tablePrefix: prefix, textSearchConfig: 'simple',
    })) await db.exec(sql);
    // A table of the caller's own, written in the same transactions as the vectors.
    await db.exec(`CREATE TABLE IF NOT EXISTS "${prefix}sources" (id TEXT PRIMARY KEY, version INTEGER NOT NULL)`);
    store = new PostgresVectorStore({ ...config, adapter: db });
    await store.initialize();
  });
  afterAll(async () => {
    await store?.close();
    if (db) {
      await db.exec(`DROP TABLE IF EXISTS "${prefix}chunks"`);
      await db.exec(`DROP TABLE IF EXISTS "${prefix}sources"`);
      await db.close();
    }
    await observer?.close();
  });

  it('uses the migration schema and keeps lexical, JSON and dense filters', async () => {
    await store.upsert('chunks', [doc('a'), doc('b', 'tenant-b')]);
    const filter = { tenantId: 'tenant-a', aclGroups: { $in: ['account:tenant-a'] } };
    const lexical = await store.lexicalSearch('chunks', 'budg', {
      prefix: true, filter, includeTextContent: true,
    });
    expect(lexical.documents.map((row) => row.id)).toEqual(['a']);
    expect(lexical.documents[0]?.textContent).toBe('budget chapters');
    expect((await store.query('chunks', [1, 0, 0], { filter })).documents.map((row) => row.id)).toEqual(['a']);
    const hybrid = await store.hybridSearch('chunks', [1, 0, 0], 'budget', { filter });
    expect(hybrid.documents.map((row) => row.id)).toEqual(['a']);
    expect(typeof hybrid.documents[0]?.similarityScore).toBe('number');
    expect((await store.lexicalSearch('chunks', 'budget', {
      filter: { tenantId: 'tenant-a', ranks: { $in: [2] }, sourceId: { $exists: true } },
    })).documents.map((row) => row.id)).toEqual(['a']);
    expect((await store.lexicalSearch('chunks', 'budget', {
      filter: { ranks: { $in: ['2'] } },
    })).documents).toEqual([]);
    expect((await store.lexicalSearch('chunks', 'budget', {
      filter: { absent: { $exists: false }, tenantId: 'tenant-a' },
    })).documents.map((row) => row.id)).toEqual(['a']);
    expect(await store.updateMetadata('chunks', { sourceId: 'a' }, { label: 'kept' }))
      .toEqual({ updatedCount: 1 });
    expect(await store.delete('chunks', ['a', 'b'])).toEqual({ deletedCount: 2 });
  });

  it('rolls back vector and host writes together without exposing uncommitted rows', async () => {
    await expect(db.transaction(async (tx) => {
      await tx.run(`INSERT INTO "${prefix}sources" (id, version) VALUES ($1, $2)`, ['rollback', 1]);
      await store.withStorageTransaction(tx, async (vectors) => {
        await vectors.upsert('chunks', [doc('rollback')]);
        expect(await observer.get(`SELECT id FROM "${prefix}chunks" WHERE id = $1`, ['rollback']))
          .toBeNull();
        expect((await vectors.fetchByIds('chunks', ['rollback'])).length).toBe(1);
      });
      expect(await tx.get(`SELECT id FROM "${prefix}sources" WHERE id = $1`, ['rollback']))
        .toEqual({ id: 'rollback' });
      throw new Error('fixture_rollback');
    })).rejects.toThrow('fixture_rollback');
    expect(await db.get(`SELECT id FROM "${prefix}chunks" WHERE id = $1`, ['rollback'])).toBeNull();
    expect(await db.get(`SELECT id FROM "${prefix}sources" WHERE id = $1`, ['rollback'])).toBeNull();
  });

  it('commits an outer transaction only after its callback and expires the borrowed view', async () => {
    let borrowed: PostgresVectorStore | undefined;
    await db.transaction(async (tx) => {
      await store.withStorageTransaction(tx, async (vectors) => {
        borrowed = vectors;
        await vectors.upsert('chunks', [doc('commit')]);
      });
      expect(await observer.get(`SELECT id FROM "${prefix}chunks" WHERE id = $1`, ['commit']))
        .toBeNull();
    });
    expect(await observer.get(`SELECT id FROM "${prefix}chunks" WHERE id = $1`, ['commit']))
      .toEqual({ id: 'commit' });
    await expect(borrowed!.fetchByIds('chunks', ['commit']))
      .rejects.toThrow('vector_transaction_closed');
    await expect(borrowed!.initialize()).rejects.toThrow('vector_transaction_closed');
    // A call that would run no statement is refused too.
    await expect(borrowed!.delete('chunks')).rejects.toThrow('vector_transaction_closed');
    // The calls that answer without a database: the health checks say no, an empty fetch finds nothing, and a
    // close does nothing and opens nothing.
    expect(await borrowed!.healthCheck()).toBe(false);
    expect(await borrowed!.checkHealth()).toEqual({ isHealthy: false });
    expect(await borrowed!.fetchByIds('chunks', [])).toEqual([]);
    await borrowed!.close();
    await borrowed!.shutdown();
    await expect(borrowed!.upsert('chunks', [doc('late')])).rejects.toThrow('vector_transaction_closed');
    await store.delete('chunks', ['commit']);
  });

  it('uses separate client-bound views for simultaneous transactions', async () => {
    const outcomes = await Promise.allSettled([
      db.transaction((tx) => store.withStorageTransaction(tx, async (vectors) => {
        await vectors.upsert('chunks', [doc('parallel-keep')]);
      })),
      db.transaction((tx) => store.withStorageTransaction(tx, async (vectors) => {
        await vectors.upsert('chunks', [doc('parallel-drop')]);
        throw new Error('fixture_rollback');
      })),
    ]);
    expect(outcomes.map((value) => value.status)).toEqual(['fulfilled', 'rejected']);
    expect((await store.fetchByIds('chunks', ['parallel-keep', 'parallel-drop'])).map((row) => row.id))
      .toEqual(['parallel-keep']);
    await store.delete('chunks', ['parallel-keep']);
  });

  it('keeps transaction search settings local and leaves the supplied adapter open', async () => {
    const search = new PostgresVectorStore({ ...config, adapter: db, efSearch: 80 });
    await search.upsert('chunks', [doc('setting')]);
    await db.transaction(async (tx) => {
      await tx.run('SET LOCAL hnsw.ef_search = 41');
      await search.withStorageTransaction(tx, async (vectors) => {
        expect((await vectors.query('chunks', [1, 0, 0])).documents.length).toBeGreaterThan(0);
      });
      const value = await tx.get<{ value: string }>("SELECT current_setting('hnsw.ef_search') AS value");
      expect(value?.value).toBe('41');
    });
    await search.close();
    expect(await db.get('SELECT 1 AS n')).toEqual({ n: 1 });
    await store.delete('chunks', ['setting']);
  });

  it('rejects ambiguous connection configuration without contacting a database', async () => {
    const ambiguous = new PostgresVectorStore({ ...config, adapter: db, connectionString: 'unused' });
    await expect(ambiguous.initialize()).rejects.toThrow('vector_connection_ambiguous');
  });

  it('refuses its own adapter in place of a transaction, on the store and on a view of it', async () => {
    // On the adapter itself every statement would commit on its own, outside the caller's transaction.
    let ran = false;
    await expect(store.withStorageTransaction(db, async () => { ran = true; }))
      .rejects.toThrow('vector_transaction_required');
    await db.transaction((tx) => store.withStorageTransaction(tx, async (vectors) => {
      await expect(vectors.withStorageTransaction(db, async () => { ran = true; }))
        .rejects.toThrow('vector_transaction_required');
      // A view may lend the transaction it holds.
      expect(await vectors.withStorageTransaction(tx, (inner) => inner.healthCheck())).toBe(true);
    }));
    expect(ran).toBe(false);
  });

  it('deletes by filter in the caller\'s transaction, and every row only when asked', async () => {
    const ids = async (): Promise<string[]> =>
      (await store.fetchByIds('chunks', ['swap-keep', 'swap-1', 'swap-2', 'swap-3'])).map((row) => row.id).sort();
    await store.upsert('chunks', [doc('swap-keep'), doc('swap-1', 'tenant-b'), doc('swap-2', 'tenant-b')]);
    await expect(db.transaction((tx) => store.withStorageTransaction(tx, async (vectors) => {
      expect(await vectors.delete('chunks', undefined, { filter: { tenantId: 'tenant-b' } }))
        .toEqual({ deletedCount: 2 });
      throw new Error('fixture_rollback');
    }))).rejects.toThrow('fixture_rollback');
    expect(await ids()).toEqual(['swap-1', 'swap-2', 'swap-keep']);
    await db.transaction((tx) => store.withStorageTransaction(tx, async (vectors) => {
      expect(await vectors.delete('chunks', undefined, { filter: { tenantId: 'tenant-b' } }))
        .toEqual({ deletedCount: 2 });
      await vectors.upsert('chunks', [doc('swap-3', 'tenant-b')]);
    }));
    expect(await ids()).toEqual(['swap-3', 'swap-keep']);
    // An empty filter is no filter, and deletes nothing without deleteAll.
    expect(await store.delete('chunks', undefined, { filter: {} })).toEqual({ deletedCount: 0 });
    const before = await observer.get<{ n: number }>(`SELECT count(*)::int AS n FROM "${prefix}chunks"`);
    expect(before?.n).toBeGreaterThanOrEqual(2);
    expect(await store.delete('chunks', undefined, { deleteAll: true })).toEqual({ deletedCount: before?.n });
    expect(await observer.get(`SELECT count(*)::int AS n FROM "${prefix}chunks"`)).toEqual({ n: 0 });
  });

  it('runs the schema statements on the adapter when it manages the schema', async () => {
    const managedPrefix = `${prefix}m_`;
    const table = `${managedPrefix}docs`;
    const managed = new PostgresVectorStore({
      id: 'adapter-managed', type: 'postgres', adapter: db, tablePrefix: managedPrefix, textSearchConfig: 'simple',
    });
    try {
      await managed.createCollection('docs', 3, { similarityMetric: 'euclidean' });
      const indexes = await observer.all<{ indexdef: string }>(
        'SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = $1', [table],
      );
      expect(indexes.map((row) => row.indexdef.slice(row.indexdef.indexOf('USING '))).sort()).toEqual([
        'USING btree (id)', 'USING gin (metadata_json)', 'USING gin (tsv)', 'USING hnsw (embedding vector_l2_ops)',
      ]);
      expect(await observer.get(`SELECT dimension, metric FROM "${managedPrefix}_collections" WHERE name = $1`, ['docs']))
        .toEqual({ dimension: 3, metric: 'euclidean' });
      // The search reads the metric back from the collections table: under L2 a score is the negated distance,
      // where under cosine the farther document here would score 0.
      await managed.upsert('docs', [{ id: 'near', embedding: [1, 0, 0] }, { id: 'far', embedding: [0, 3, 0] }]);
      const found = await managed.query('docs', [1, 0, 0], { topK: 2 });
      expect(found.documents.map((row) => row.id)).toEqual(['near', 'far']);
      expect(found.documents[1]?.similarityScore).toBeCloseTo(-Math.sqrt(10), 5);
      await managed.dropCollection('docs');
      expect(await observer.get(
        'SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = current_schema() AND tablename = $1', [table],
      )).toEqual({ n: 0 });
      expect(await observer.get(`SELECT name FROM "${managedPrefix}_collections" WHERE name = $1`, ['docs']))
        .toBeNull();
    } finally {
      await managed.close();
      await db.exec(`DROP TABLE IF EXISTS "${table}" CASCADE`);
      await db.exec(`DROP TABLE IF EXISTS "${managedPrefix}_collections"`);
    }
  });

  it('keeps a store\'s search settings inside a transaction of its own on the adapter', async () => {
    // One connection, so the setting read after the search is the one of the connection the search ran on.
    const single = createPostgresAdapter({ connectionString: url!, max: 1 });
    await single.open();
    const search = new PostgresVectorStore({ ...config, adapter: single, efSearch: 80 });
    try {
      await search.upsert('chunks', [doc('root-setting')]);
      const read = "SELECT pg_backend_pid() AS pid, current_setting('hnsw.ef_search') AS value";
      const before = await single.get<{ pid: number; value: string }>(read);
      expect(before?.value).not.toBe('80');
      expect((await search.query('chunks', [1, 0, 0])).documents.map((row) => row.id)).toContain('root-setting');
      expect((await search.hybridSearch('chunks', [1, 0, 0], 'budget')).documents.map((row) => row.id))
        .toContain('root-setting');
      expect(await single.get(read)).toEqual(before);
      await search.delete('chunks', ['root-setting']);
    } finally {
      await search.close();
      await single.close();
    }
  });

  it('lends a transaction only to a store made with an adapter, and runs only on PostgreSQL', async () => {
    let ran = false;
    const pooled = new PostgresVectorStore({ ...config, connectionString: url! });
    await db.transaction(async (tx) => {
      await expect(pooled.withStorageTransaction(tx, async () => { ran = true; }))
        .rejects.toThrow('vector_adapter_required');
    });
    const sqlite = await resolveStorageAdapter({ filePath: ':memory:', priority: ['better-sqlite3', 'sqljs'], quiet: true });
    try {
      await expect(new PostgresVectorStore({ ...config, adapter: sqlite }).initialize())
        .rejects.toThrow('vector_adapter_requires_postgres_transactions');
      await sqlite.transaction(async (tx) => {
        await expect(store.withStorageTransaction(tx, async () => { ran = true; }))
          .rejects.toThrow('vector_adapter_requires_postgres_transactions');
      });
    } finally {
      await sqlite.close();
    }
    expect(ran).toBe(false);
  });
});
