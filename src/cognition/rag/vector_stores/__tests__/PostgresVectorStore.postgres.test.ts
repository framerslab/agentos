/**
 * @fileoverview PostgresVectorStore against a real Postgres with pgvector: the array-aware filter, deletion and
 * metadata changes by filter, the lexical leg, and an iterative scan that fills a filtered top-K, for query() and
 * for the hybrid search's dense leg. Gated on AGENTOS_TEST_POSTGRES_URL, as Brain.postgres.test.ts is.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { MetadataFilter, VectorDocument } from '../../IVectorStore.js';
import { PostgresVectorStore } from '../PostgresVectorStore.js';

const URL = process.env.AGENTOS_TEST_POSTGRES_URL;
const PREFIX = `t${Date.now().toString(36)}_`;
const DIM = 8;
const COUNT = 2000;

/**
 * The point at `position` on a half circle in the plane of the first two axes. The documents lie along it in the
 * order they are written, so the HNSW graph links each one to its neighbours and a scan that goes on reaches every
 * one; the nearest documents to `arc(0)` are the first ones written.
 */
function arc(position: number): number[] {
  const angle = (position / COUNT) * Math.PI;
  const vector = new Array<number>(DIM).fill(0);
  vector[0] = Math.cos(angle);
  vector[1] = Math.sin(angle);
  return vector;
}

describe.skipIf(!URL)('PostgresVectorStore on Postgres', () => {
  let pool: pg.Pool;
  let store: PostgresVectorStore;
  let iterative: PostgresVectorStore;

  beforeAll(async () => {
    // The planner is told not to read the table in order, so a filtered search goes through the HNSW index, as it does on a large table.
    pool = new pg.Pool({ connectionString: URL, max: 4, options: '-c enable_seqscan=off' });
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    for (const statement of PostgresVectorStore.schemaSql('chunks', DIM, { tablePrefix: PREFIX, textSearchConfig: 'simple' })) {
      await pool.query(statement);
    }
    const config = { id: 'pg', type: 'postgres' as const, pool, manageSchema: false, tablePrefix: PREFIX, textSearchConfig: 'simple', similarityMetric: 'cosine' as const };
    store = new PostgresVectorStore(config);
    iterative = new PostgresVectorStore({ ...config, iterativeScan: 'strict_order', maxScanTuples: 20000 });
    // Tenant a's documents are every fiftieth along the arc: 40 of 2,000, one among the 40 nearest to arc(0).
    const documents: VectorDocument[] = [];
    for (let n = 0; n < COUNT; n += 1) {
      const mine = n % 50 === 0;
      documents.push({
        id: `d${n}`,
        embedding: arc(n),
        textContent: mine ? `chapters of the budget review number ${n}` : `weather and travel notes number ${n}`,
        metadata: { tenantId: mine ? 'a' : 'b', aclGroups: mine ? ['acct:1', 'folder:f1'] : ['acct:2'], status: 'active', sourceId: `s${n % 10}`, tags: mine ? ['q3', 'budget'] : ['misc'], ranks: mine ? [1, 2] : [3] },
      });
    }
    for (let from = 0; from < documents.length; from += 200) {
      await store.upsert('chunks', documents.slice(from, from + 200));
    }
  }, 120_000);

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS "${PREFIX}chunks" CASCADE`);
    await pool.end();
  });

  it('filters by an array field', async () => {
    const result = await store.query('chunks', arc(0), { topK: 100, filter: { aclGroups: { $in: ['folder:f1', 'acct:9'] } }, includeMetadata: true });
    expect(result.documents.length).toBeGreaterThan(0);
    expect(result.documents.every((doc) => doc.metadata?.tenantId === 'a')).toBe(true);
    const all = await store.lexicalSearch('chunks', 'budget', { topK: 100, filter: { tags: { $all: ['q3', 'budget'] } } });
    expect(all.documents).toHaveLength(40);
  });

  it('matches $textSearch on a string value, in any case', async () => {
    const found = await store.lexicalSearch('chunks', 'budget', { topK: 100, filter: { sourceId: { $textSearch: 'S0' } } });
    expect(found.documents).toHaveLength(40);
    const none = await store.lexicalSearch('chunks', 'budget', { topK: 100, filter: { sourceId: { $textSearch: 'S1' } } });
    expect(none.documents).toHaveLength(0);
  });

  it('compares the values in an array field as JSON, so a number matches a number and not its text', async () => {
    const budget = async (filter: MetadataFilter) => (await store.lexicalSearch('chunks', 'budget', { topK: 100, filter })).documents.length;
    expect(await budget({ ranks: { $in: [2, 9] } })).toBe(40);
    expect(await budget({ ranks: { $in: ['2'] } })).toBe(0);
    expect(await budget({ ranks: { $nin: [2] } })).toBe(0);
    expect(await budget({ ranks: { $nin: [9] } })).toBe(40);
    expect(await budget({ ranks: { $contains: 1 } })).toBe(40);
    expect(await budget({ aclGroups: { $nin: ['folder:f1'] } })).toBe(0);
  });

  it('fills a filtered top-K only with an iterative scan', async () => {
    const version = await pool.query<{ extversion: string }>("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
    const [major, minor] = version.rows[0].extversion.split('.').map(Number);
    if (major === 0 && minor < 8) return; // iterative scans arrived in pgvector 0.8.0
    const filter = { tenantId: 'a' };
    const plain = await store.query('chunks', arc(0), { topK: 10, filter });
    const filled = await iterative.query('chunks', arc(0), { topK: 10, filter });
    expect(filled.documents).toHaveLength(10);
    expect(plain.documents.length).toBeLessThan(10);
    const hybrid = await iterative.hybridSearch('chunks', arc(0), 'budget review', { topK: 10, filter });
    expect(hybrid.documents).toHaveLength(10);
    // Every one of the tenant's 40 passages holds 'budget review', so that search's lexical leg fills ten whatever
    // the dense leg returns. A text no passage holds leaves the dense leg alone, which only the iterative scan fills.
    const denseLeg = await iterative.hybridSearch('chunks', arc(0), 'zebra', { topK: 10, filter });
    expect(denseLeg.documents).toHaveLength(10);
    expect(denseLeg.documents.every((doc) => doc.metadata?.tenantId === 'a')).toBe(true);
    const plainDenseLeg = await store.hybridSearch('chunks', arc(0), 'zebra', { topK: 10, filter });
    expect(plainDenseLeg.documents.length).toBeLessThan(10);
  });

  it('finds words by prefix, every word or any word', async () => {
    const every = await store.lexicalSearch('chunks', 'chapter budg', { topK: 5, match: 'all', prefix: true, includeTextContent: true });
    expect(every.documents).toHaveLength(5);
    expect(every.documents[0].textContent).toContain('chapters of the budget');
    expect((await store.lexicalSearch('chunks', 'chapter', { topK: 5 })).documents).toHaveLength(0);
    expect((await store.lexicalSearch('chunks', 'chapter weather', { topK: 5, match: 'all', prefix: true })).documents).toHaveLength(0);
    expect((await store.lexicalSearch('chunks', 'chapter weather', { topK: 5, match: 'any', prefix: true })).documents).toHaveLength(5);
    // A question's own words on the hybrid search's lexical leg: any word finds the budget passages, though most of its words are in none.
    const asked = await store.hybridSearch('chunks', arc(0), 'what did we decide about the budget', { topK: 5, match: 'any', filter: { tenantId: 'a' } });
    expect(asked.documents).toHaveLength(5);
    expect(asked.documents.every((doc) => doc.metadata?.tenantId === 'a')).toBe(true);
  });

  it('changes and deletes by filter', async () => {
    const changed = await store.updateMetadata('chunks', { sourceId: 's0', tenantId: 'a' }, { aclGroups: ['org:a'], tags: null });
    expect(changed.updatedCount).toBeGreaterThan(0);
    const seen = await store.lexicalSearch('chunks', 'budget', { topK: 100, filter: { aclGroups: { $in: ['org:a'] } }, includeMetadata: true });
    expect(seen.documents).toHaveLength(changed.updatedCount);
    expect(seen.documents[0].metadata?.tags).toBeUndefined();
    const gone = await store.delete('chunks', undefined, { filter: { tenantId: 'a' } });
    expect(gone.deletedCount).toBe(40);
    expect((await store.lexicalSearch('chunks', 'budget', { topK: 5 })).documents).toHaveLength(0);
    expect((await store.lexicalSearch('chunks', 'weather', { topK: 5 })).documents).toHaveLength(5);
  });
});
