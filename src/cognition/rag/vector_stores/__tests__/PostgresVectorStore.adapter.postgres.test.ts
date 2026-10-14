import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
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
    store = new PostgresVectorStore({ ...config, adapter: db });
    await store.initialize();
  });
  afterAll(async () => {
    await store?.close();
    if (db) {
      await db.exec(`DROP TABLE IF EXISTS "${prefix}chunks"`);
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
      await store.withStorageTransaction(tx, async (vectors) => {
        await vectors.upsert('chunks', [doc('rollback')]);
        expect(await observer.get(`SELECT id FROM "${prefix}chunks" WHERE id = $1`, ['rollback']))
          .toBeNull();
        expect((await vectors.fetchByIds('chunks', ['rollback'])).length).toBe(1);
      });
      throw new Error('fixture_rollback');
    })).rejects.toThrow('fixture_rollback');
    expect(await db.get(`SELECT id FROM "${prefix}chunks" WHERE id = $1`, ['rollback'])).toBeNull();
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
});
