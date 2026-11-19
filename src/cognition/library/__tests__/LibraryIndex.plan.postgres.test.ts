/**
 * @fileoverview Indexing a source by content on PostgresVectorStore over a real Postgres with pgvector: what reaches
 * the embedder after an edit, rows left untouched when nothing changed, the lexical column after a text is
 * rewritten, the scope in the statement that reads stored vectors, the source lock, a stale plan, and a plan applied
 * in the caller's own transaction. Gated on AGENTOS_TEST_POSTGRES_URL, as LibraryIndex.postgres.test.ts is.
 */
import { createPostgresAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PostgresVectorStore } from '../../rag/vector_stores/PostgresVectorStore.js';
import type { PgPoolLike } from '../../rag/vector_stores/PostgresVectorStore.js';
import { LibraryIndex, LibraryPlanStale, type LibraryEmbedding, type LibrarySource } from '../LibraryIndex.js';

const URL = process.env.AGENTOS_TEST_POSTGRES_URL;
const PREFIX = `plan${Date.now().toString(36)}_`;
const TABLE = `${PREFIX}library`;
const MODEL: LibraryEmbedding = { model: 'test-embed', dimensions: 4 };
const ANN = { tenantId: 'org1', aclGroups: ['acct:ann'] };

/** A vector of a text: the same text, the same vector. */
function vectorOf(text: string): number[] {
  let hash = 7;
  for (const char of text) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return [1, (hash % 97) / 97, (hash % 89) / 89, (hash % 83) / 83];
}

const passages = (count: number, change: (n: number) => string | undefined = () => undefined) =>
  Array.from({ length: count }, (_, n) => ({ text: change(n) ?? `Passage ${n} is about the budget and the plan.` }));

const documentSource = (over: Partial<LibrarySource> = {}): LibrarySource => ({
  sourceId: 'document:d1',
  kind: 'document',
  tenantId: 'org1',
  aclGroups: ['acct:ann'],
  title: 'Plan',
  passages: passages(40),
  ...over,
});

const texts = (source: LibrarySource): string[] => source.passages.map((passage) => passage.text);

describe.skipIf(!URL)('LibraryIndex by content over PostgresVectorStore on Postgres', () => {
  let pool: pg.Pool;
  let statements: string[];
  let store: PostgresVectorStore;
  let sent: string[];
  let library: LibraryIndex;
  const embed = async (batch: string[]): Promise<number[][]> => {
    sent.push(...batch);
    return batch.map(vectorOf);
  };
  const config = { id: 'pg-plan', type: 'postgres' as const, manageSchema: false, tablePrefix: PREFIX, textSearchConfig: 'simple', similarityMetric: 'cosine' as const };

  /** Plans a source, embeds what the plan asks for, and applies it. */
  const index = async (source: LibrarySource, inputs = texts(source), on = library) => {
    const plan = await on.planSource(source, { embedding: MODEL, inputs });
    await on.applySourcePlan(plan, plan.toEmbed.length === 0 ? [] : await embed([...plan.toEmbed]));
    return plan;
  };
  const rows = async (sourceId = 'document:d1') =>
    (await pool.query<{ id: string; updated_at: string; text_content: string }>(
      `SELECT id, updated_at, text_content FROM "${TABLE}" WHERE metadata_json->>'sourceId' = $1 ORDER BY id`,
      [sourceId],
    )).rows;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: URL, max: 4 });
    try {
      await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    } catch (error) {
      // Another suite made the extension at the same moment (unique_violation); it exists now.
      if ((error as { code?: unknown } | null)?.code !== '23505') throw error;
    }
    for (const statement of PostgresVectorStore.schemaSql('library', 4, { tablePrefix: PREFIX, textSearchConfig: 'simple' })) {
      await pool.query(statement);
    }
    // The store's statements, recorded on their way to the real pool.
    const recording: PgPoolLike = {
      query: (sql, params) => {
        statements.push(sql);
        return pool.query(sql, params);
      },
      connect: async () => {
        const client = await pool.connect();
        return {
          query: (sql: string, params?: unknown[]) => {
            statements.push(sql);
            return client.query(sql, params);
          },
          release: () => client.release(),
        };
      },
    };
    store = new PostgresVectorStore({ ...config, pool: recording });
  });

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS "${TABLE}" CASCADE`);
    await pool.end();
  });

  beforeEach(async () => {
    statements = [];
    sent = [];
    await pool.query(`DELETE FROM "${TABLE}"`);
    library = new LibraryIndex({ store, collection: 'library', embed, dimensions: 4 });
  });

  it('embeds one input of a 40-passage source after an edit, and moves no row when nothing changed', async () => {
    await index(documentSource());
    expect(sent).toHaveLength(40);
    sent.length = 0;
    const edited = documentSource({ passages: passages(40, (n) => (n === 7 ? 'Passage 7 now says the budget doubled.' : undefined)) });
    const plan = await index(edited);
    expect(sent).toEqual(['Passage 7 now says the budget doubled.']);
    expect(plan.counts).toEqual({ embed: 1, reuse: 39, rewrite: 0, remove: 1 });
    const before = await rows();
    expect(before.map((row) => row.text_content).sort()).toEqual([...texts(edited)].sort());

    sent.length = 0;
    const again = await index(edited);
    expect(sent).toEqual([]);
    expect(again.counts).toEqual({ embed: 0, reuse: 40, rewrite: 0, remove: 0 });
    expect(await rows()).toEqual(before);
  });

  it('rewrites the text of two texts that redact to one input, so a lexical search finds the new words alone', async () => {
    const input = ['Call Ann on [number] about the budget.'];
    await index(documentSource({ passages: [{ text: 'Call Ann about zebra budget.' }] }), input);
    sent.length = 0;
    const plan = await index(documentSource({ passages: [{ text: 'Call Ann about walrus budget.' }] }), input);
    expect(sent).toEqual([]);
    expect(plan.counts).toEqual({ embed: 0, reuse: 0, rewrite: 1, remove: 0 });
    expect((await library.search({ text: 'walrus', mode: 'lexical', scope: ANN })).map((found) => found.text)).toEqual(['Call Ann about walrus budget.']);
    expect(await library.search({ text: 'zebra', mode: 'lexical', scope: ANN })).toEqual([]);
  });

  it('embeds nothing for a change of access, and reads stored vectors with the scope and the model in the statement', async () => {
    await index(documentSource());
    await index(documentSource({ sourceId: 'document:other', tenantId: 'org2' }));
    sent.length = 0;
    const shared = await index(documentSource({ aclGroups: ['acct:ann', 'org:org1'] }));
    expect(sent).toEqual([]);
    expect(shared.counts).toEqual({ embed: 0, reuse: 40, rewrite: 0, remove: 0 });

    const ours = (await rows()).map((row) => row.id);
    const theirs = (await rows('document:other')).map((row) => row.id);
    statements.length = 0;
    const found = await library.passageVectors([...ours, ...theirs], { tenantId: 'org1', aclGroups: ['org:org1'] }, MODEL);
    expect([...found.keys()].sort()).toEqual([...ours].sort());
    for (const vector of found.values()) expect(vector).toHaveLength(4);
    const read = statements.find((sql) => sql.includes('embedding::text'));
    expect(read).toBeDefined();
    expect(read).toContain("metadata_json->>'tenantId' = $");
    expect(read).toContain("metadata_json->>'embedModel' = $");
    expect(read).toContain('aclGroups');
    // Asked for another tenant's passages alone, the statement answers no row.
    expect((await library.passageVectors(theirs, ANN, MODEL)).size).toBe(0);
  });

  it('throws LibraryPlanStale and writes nothing when another plan changed only the access groups', async () => {
    await index(documentSource());
    const retitled = documentSource({ title: 'Plan, second draft' });
    const first = await library.planSource(retitled, { embedding: MODEL, inputs: texts(retitled) });
    await index(documentSource({ aclGroups: ['acct:ann', 'org:org1'] }));
    const before = await rows();
    await expect(library.applySourcePlan(first, [])).rejects.toBeInstanceOf(LibraryPlanStale);
    expect(await rows()).toEqual(before);
  });

  it('holds a source lock until the transaction that took it ends', async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = store.withSourceLock('library', 'document:d1', async () => {
      order.push('first holds');
      await held;
      order.push('first ends');
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = store.withSourceLock('library', 'document:d1', async () => {
      order.push('second holds');
    });
    const other = store.withSourceLock('library', 'document:d2', async () => {
      order.push('another source');
    });
    await other;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(order).toEqual(['first holds', 'another source']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first holds', 'another source', 'first ends', 'second holds']);
  });

  it("applies a plan in the caller's transaction, so a rollback leaves the source as it was", async () => {
    const db: StorageAdapter = createPostgresAdapter({ connectionString: URL!, max: 2 });
    await db.open();
    try {
      const vectors = new PostgresVectorStore({ ...config, adapter: db });
      await vectors.initialize();
      const outer = new LibraryIndex({ store: vectors, collection: 'library', embed, dimensions: 4 });
      await index(documentSource(), texts(documentSource()), outer);
      const before = await rows();
      const edited = documentSource({ passages: passages(40, (n) => (n === 2 ? 'Passage 2 changed.' : undefined)) });
      const plan = await outer.planSource(edited, { embedding: MODEL, inputs: texts(edited) });
      const made = await embed([...plan.toEmbed]);
      await expect(db.transaction((tx) => vectors.withStorageTransaction(tx, async (view) => {
        await new LibraryIndex({ store: view, collection: 'library', embed, dimensions: 4 }).applySourcePlan(plan, made);
        expect((await view.listSourcePassages('library', 'document:d1')).length).toBe(40);
        throw new Error('roll back');
      }))).rejects.toThrow('roll back');
      expect(await rows()).toEqual(before);

      await db.transaction((tx) => vectors.withStorageTransaction(tx, async (view) => {
        await new LibraryIndex({ store: view, collection: 'library', embed, dimensions: 4 }).applySourcePlan(plan, made);
      }));
      expect((await rows()).map((row) => row.text_content).sort()).toEqual([...texts(edited)].sort());
    } finally {
      await db.close();
    }
  });
});
