/**
 * @fileoverview LibraryIndex over PostgresVectorStore on a real Postgres with pgvector, the store that has every
 * optional member the index calls: the lexical leg alone, the hybrid search with `match` and `prefix`,
 * `updateMetadata` and `delete` by filter, with the scope and the narrowing written into SQL. Gated on
 * AGENTOS_TEST_POSTGRES_URL, as PostgresVectorStore.postgres.test.ts is.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PostgresVectorStore } from '../../rag/vector_stores/PostgresVectorStore.js';
import { LibraryIndex, type LibraryScope, type LibrarySource } from '../LibraryIndex.js';

const URL = process.env.AGENTOS_TEST_POSTGRES_URL;
const PREFIX = `lib${Date.now().toString(36)}_`;
const TABLE = `${PREFIX}library`;

/** Three topic words and a constant, as the in-memory suite embeds, so the dense leg ranks by topic. */
async function embed(texts: string[]): Promise<number[][]> {
  return texts.map((text) => {
    const lower = text.toLowerCase();
    return [/budget/.test(lower) ? 1 : 0, /weather/.test(lower) ? 1 : 0, /hiring/.test(lower) ? 1 : 0, 0.1];
  });
}

const SESSION: LibrarySource = {
  sourceId: 'session:a',
  kind: 'session',
  tenantId: 'org1',
  aclGroups: ['acct:ann'],
  folderId: 'f1',
  tags: ['q3', 'budget'],
  title: 'Budget review',
  passages: [{ text: 'The budget grows by ten percent in chapters two and three.' }, { text: 'The weather was mentioned once.' }],
};

const DOCUMENT: LibrarySource = {
  sourceId: 'document:b',
  kind: 'document',
  tenantId: 'org1',
  aclGroups: ['org:org1'],
  tags: ['q3'],
  title: 'Hiring plan',
  passages: [{ text: 'Hiring opens in May for the budget team.' }],
};

/** The same account's session in another workspace. */
const ELSEWHERE: LibrarySource = {
  sourceId: 'session:c',
  kind: 'session',
  tenantId: 'org2',
  aclGroups: ['acct:ann'],
  passages: [{ text: 'The budget of another workspace.' }],
};

/** What ann may see in org1: her own session, and the document filed to the whole workspace. */
const ANN: LibraryScope = { tenantId: 'org1', aclGroups: ['acct:ann', 'org:org1'] };

describe.skipIf(!URL)('LibraryIndex over PostgresVectorStore on Postgres', () => {
  let pool: pg.Pool;
  let index: LibraryIndex;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: URL, max: 2 });
    try {
      await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    } catch (error) {
      // Another suite made the extension at the same moment (unique_violation); it exists now.
      if ((error as { code?: unknown } | null)?.code !== '23505') throw error;
    }
    for (const statement of PostgresVectorStore.schemaSql('library', 4, { tablePrefix: PREFIX, textSearchConfig: 'simple' })) {
      await pool.query(statement);
    }
    const store = new PostgresVectorStore({
      id: 'pg-library',
      type: 'postgres',
      pool,
      manageSchema: false,
      tablePrefix: PREFIX,
      textSearchConfig: 'simple',
      similarityMetric: 'cosine',
    });
    index = new LibraryIndex({ store, collection: 'library', embed });
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM "${TABLE}"`);
    for (const source of [SESSION, DOCUMENT, ELSEWHERE]) await index.indexSource(source);
  });

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS "${TABLE}" CASCADE`);
    await pool.end();
  });

  it('answers each passage\'s score as a number in every mode', async () => {
    for (const mode of ['lexical', 'hybrid', 'dense'] as const) {
      const found = await index.search({ text: 'budget', scope: ANN, mode });
      expect(found.length).toBeGreaterThan(0);
      expect(found.map((passage) => `${mode}: ${typeof passage.score}`)).toEqual(found.map(() => `${mode}: number`));
      expect(found.every((passage) => Number.isFinite(passage.score))).toBe(true);
    }
  });

  it('reads the lexical leg alone: a word by its beginning, every word or any word', async () => {
    const ids = async (text: string, extra: { match?: 'all' | 'any'; prefix?: boolean }) =>
      (await index.search({ text, scope: ANN, mode: 'lexical', topK: 10, ...extra })).map((passage) => passage.id).sort();
    expect(await ids('chapter', { prefix: true })).toEqual(['session:a#0']);
    expect(await ids('chapter', {})).toEqual([]);
    expect(await ids('budget hiring', { match: 'all' })).toEqual(['document:b#0']);
    expect(await ids('budget hiring', { match: 'any' })).toEqual(['document:b#0', 'session:a#0']);
  });

  it('fuses the two legs on a question\'s own words, inside the scope', async () => {
    const found = await index.search({ text: 'what did we decide about the budget', scope: ANN, mode: 'hybrid', match: 'any', topK: 10 });
    expect(found.map((passage) => passage.id).sort()).toEqual(['document:b#0', 'session:a#0', 'session:a#1']);
  });

  it('shows nothing to another tenant or to a principal outside the groups', async () => {
    const sources = async (scope: LibraryScope) =>
      (await index.search({ text: 'budget', scope, mode: 'lexical', topK: 10 })).map((passage) => passage.sourceId).sort();
    expect(await sources({ tenantId: 'org1', aclGroups: ['acct:ann'] })).toEqual(['session:a']);
    expect(await sources({ tenantId: 'org1', aclGroups: ['acct:bob'] })).toEqual([]);
    expect(await sources({ tenantId: 'org2', aclGroups: ['acct:ann'] })).toEqual(['session:c']);
    expect(await sources({ tenantId: 'org3', aclGroups: ['acct:ann', 'org:org1'] })).toEqual([]);
  });

  it('narrows by kind, folder, tags and source', async () => {
    const sources = async (extra: { kinds?: string[]; folderId?: string; tags?: string[]; sourceIds?: string[] }) =>
      (await index.search({ text: 'budget', scope: ANN, mode: 'lexical', topK: 10, ...extra })).map((passage) => passage.sourceId).sort();
    expect(await sources({})).toEqual(['document:b', 'session:a']);
    expect(await sources({ kinds: ['document'] })).toEqual(['document:b']);
    expect(await sources({ folderId: 'f1' })).toEqual(['session:a']);
    expect(await sources({ tags: ['q3', 'budget'] })).toEqual(['session:a']);
    expect(await sources({ tags: ['q3'] })).toEqual(['document:b', 'session:a']);
    expect(await sources({ sourceIds: ['document:b'] })).toEqual(['document:b']);
    expect(await sources({ sourceIds: [] })).toEqual([]);
  });

  it('changes who may see a source, takes it out of its folder and replaces its tags and title', async () => {
    expect(await index.setSourceScope('session:a', { aclGroups: ['folder:f2'], folderId: null, tags: ['done'], title: 'Budget, final' })).toBe(2);
    const moved: LibraryScope = { tenantId: 'org1', aclGroups: ['folder:f2'] };
    expect((await index.search({ text: 'budget', scope: ANN, mode: 'lexical', topK: 10 })).map((passage) => passage.sourceId)).toEqual(['document:b']);
    const [passage] = await index.search({ text: 'budget', scope: moved, mode: 'lexical', topK: 10 });
    expect(passage).toMatchObject({ id: 'session:a#0', sourceId: 'session:a', title: 'Budget, final', tags: ['done'] });
    expect(passage.folderId).toBeUndefined();
    expect('folderId' in passage.metadata).toBe(false);
    expect(await index.search({ text: 'budget', scope: moved, mode: 'lexical', folderId: 'f1' })).toEqual([]);
  });

  it('replaces a source whole and removes by source and by tenant', async () => {
    expect(await index.indexSource({ ...SESSION, passages: [{ text: 'Hiring opens in June.' }] })).toEqual({ passages: 1 });
    const found = await index.search({ text: 'budget weather hiring', scope: { tenantId: 'org1', aclGroups: ['acct:ann'] }, mode: 'lexical', topK: 10 });
    expect(found.map((passage) => [passage.id, passage.text])).toEqual([['session:a#0', 'Hiring opens in June.']]);
    expect(await index.removeSource('session:a')).toBe(1);
    expect(await index.removeTenant('org1')).toBe(1);
    expect(await index.removeTenant('org2')).toBe(1);
    const left = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${TABLE}"`);
    expect(left.rows[0].n).toBe(0);
  });
});
