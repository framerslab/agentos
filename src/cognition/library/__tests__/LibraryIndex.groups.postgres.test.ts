/**
 * @fileoverview LibraryIndex.searchGroups over PostgresVectorStore on a real Postgres with pgvector: one search over
 * the caller's own item lists, in named groups. Each group answers the count of its distinct items that match every
 * word, an item matched across its passages, a page by a stable cursor bound to the caller's fingerprint, the caller's
 * dates as an order, the part kinds as a narrowing, a one-edit match drawn from the stored words of the handed items
 * alone, and a listing with no word. Gated on AGENTOS_TEST_POSTGRES_URL, as LibraryIndex.postgres.test.ts is.
 */
import { createPostgresAdapter } from '@framers/sql-storage-adapter';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { InMemoryVectorStore } from '../../rag/vector_stores/InMemoryVectorStore.js';
import { PostgresVectorStore, type PgPoolLike } from '../../rag/vector_stores/PostgresVectorStore.js';
import {
  LibraryIndex,
  type LibraryGroup,
  type LibraryGroupItem,
  type LibraryGroupResult,
  type LibraryGroupSearch,
  type LibraryPartKind,
  type LibraryRankProfile,
  type LibraryScope,
  type LibrarySource,
} from '../LibraryIndex.js';

const URL = process.env.AGENTOS_TEST_POSTGRES_URL;
const PREFIX = `lg${Date.now().toString(36)}_`;
const TABLE = `${PREFIX}library`;

/** Three topic words and a constant, as the index's other suites embed. */
async function embed(texts: string[]): Promise<number[][]> {
  return texts.map((text) => {
    const lower = text.toLowerCase();
    return [/budget/.test(lower) ? 1 : 0, /weather/.test(lower) ? 1 : 0, /hiring/.test(lower) ? 1 : 0, 0.1];
  });
}

const ORG = 'org1';
const TEAM = 'org:org1';
/** What ann may see in org1: her own items and those filed to the whole workspace. */
const ANN: LibraryScope = { tenantId: ORG, aclGroups: ['acct:ann', TEAM] };

/** A session as its passages are indexed: its title, each part of its pack, then its turns. */
function session(
  id: string,
  title: string,
  parts: Partial<Record<Exclude<LibraryPartKind, 'transcript'>, string>>,
  turns: string[],
  more: Partial<LibrarySource> = {},
): LibrarySource {
  const passages: LibrarySource['passages'] = [{ text: title, metadata: { field: 'title' } }];
  for (const kind of ['summary', 'decisions', 'action_items', 'next_steps'] as const) {
    const text = parts[kind];
    if (text !== undefined) passages.push({ text, metadata: { field: kind, partKind: kind } });
  }
  for (const text of turns) passages.push({ text, metadata: { field: 'turn', partKind: 'transcript' } });
  return { sourceId: `session:${id}`, kind: 'session', tenantId: ORG, aclGroups: [TEAM], title, passages, ...more };
}

/** A document as its passages are indexed: its title, then its text. */
function document(id: string, title: string, texts: string[], more: Partial<LibrarySource> = {}): LibrarySource {
  return {
    sourceId: `document:${id}`,
    kind: 'document',
    tenantId: ORG,
    aclGroups: [TEAM],
    title,
    passages: [{ text: title, metadata: { field: 'title' } }, ...texts.map((text) => ({ text, metadata: { field: 'text' } }))],
    ...more,
  };
}

/** A mail thread as a connector indexes it: its subject as the source's title, its messages as passages with no field. */
function thread(id: string, title: string, texts: string[]): LibrarySource {
  return { sourceId: `thread:${id}`, kind: 'mail', tenantId: ORG, aclGroups: [TEAM], title, passages: texts.map((text) => ({ text })) };
}

/** Ten sessions. "budget" is in s00's title, a turn of s01, s02's summary and one of its turns, and a turn of s09. */
const SESSIONS: LibrarySource[] = [
  // Its passages carry a date of their own, later than any the caller hands.
  session('s00', 'Budget review', { summary: 'Costs were approved for the quarter.' }, ['We opened with the agenda.', 'Then we closed the meeting.'], {
    metadata: { date: '2031-12-31T00:00:00.000Z' },
  }),
  session('s01', 'Weekly sync', { summary: 'Routine updates only.' }, ['The budget was mentioned once.', 'Nothing else came up.']),
  session('s02', 'Finance planning', { summary: 'The budget moves to finance.', decisions: 'Finance owns the forecast.' }, [
    'Ann walked through the budget line by line.',
    'Ben asked about timing.',
  ]),
  session('s03', 'Press', { summary: 'Outreach was planned.' }, ['The list is ready for review.', 'We will send it on Monday.']),
  session('s04', 'Guest names', {}, ['The list is long this year.']),
  session('s05', 'Press', { summary: 'Coverage was discussed.' }, ['The press list is long.', 'It needs a trim.']),
  session('s06', 'Offsite', { summary: 'Travel was arranged.' }, ['A zebra crossed the road near the venue.', 'We rented a kayak for the afternoon.']),
  session('s07', 'Vendor call', { summary: 'The kayke order is pending.' }, ['We spoke about delivery.']),
  session('s08', 'Dock day', {}, ['The kayak is back.', 'A glacira was mentioned by mistake.']),
  session('s09', 'Retro', {}, ['The budget came up again.', 'We agreed to stop.']),
];

/** The dates the caller holds for the sessions; s00 and s02 have none. */
const SESSION_DATES: Record<string, string | null> = {
  'session:s00': null,
  'session:s01': '2026-01-05T10:00:00.000Z',
  'session:s02': null,
  'session:s03': '2026-02-10T08:00:00.000Z',
  'session:s04': '2026-02-11T08:00:00.000Z',
  'session:s05': '2026-02-12T08:00:00.000Z',
  'session:s06': '2026-04-01T08:00:00.000Z',
  'session:s07': '2026-04-02T08:00:00.000Z',
  // The same instant as s01's, written in another zone.
  'session:s08': '2026-01-05T11:00:00.000+01:00',
  'session:s09': '2026-03-01T09:30:00.000Z',
};

const QUARTERLY = 'The quarterly figures are attached.';
/** Ten documents, each holding "quarterly" in its text. "budget" is in d00's title and d01's text. */
const DOCUMENTS: LibrarySource[] = [
  document('d00', 'Budget memo', ['The memo lists three options.', QUARTERLY]),
  document('d01', 'Travel notes', ['Flights fit the budget this time.', QUARTERLY]),
  document('d02', 'Report two', ['Nothing unusual happened.', QUARTERLY]),
  document('d03', 'Report three', ['Nothing unusual happened.', QUARTERLY]),
  document('d04', 'Media plan', ['The press office signed off.', QUARTERLY]),
  document('d05', 'Report five', ['Nothing unusual happened.', QUARTERLY]),
  document('d06', 'Report six', ['Nothing unusual happened.', QUARTERLY]),
  document('d07', 'Field study', ['The glacier retreats every summer.', QUARTERLY, 'The glacier feeds the river.', 'A glacier moves slowly.']),
  document('d08', 'Report eight', ['Nothing unusual happened.', QUARTERLY]),
  document('d09', 'Report nine', ['Nothing unusual happened.', QUARTERLY]),
];

/** Ten documents for the forms a stored word is found by: "harbor", "harbors", the three letters of "cat", "dock". */
const FORMS: LibrarySource[] = [
  document('f00', 'Port notes', ['The harbor opens at dawn.']),
  document('f01', 'Coast notes', ['Two harbors share the coast.']),
  document('f02', 'House notes', ['The cat sat by the door.']),
  document('f03', 'Yard notes', ['The dock is closed today.']),
  ...['f04', 'f05', 'f06', 'f07', 'f08', 'f09'].map((id) => document(id, `Form ${id}`, ['An empty placeholder page.'])),
];

/** Ten sessions for the rank: "compass" and "ridge" in titles, summaries and turns, the same, begun and one edit away. */
const RANKS: LibrarySource[] = [
  session('r00', 'Compass', {}, ['We walked north.']),
  session('r01', 'Trail notes', { summary: 'The compass was lost on day two.' }, ['We walked south.']),
  session('r02', 'Camp log', {}, ['Someone found a compass by the fire.']),
  session('r03', 'Compasses', {}, ['We compared models.']),
  session('r04', 'Compas', {}, ['A typo in the heading.']),
  session('r05', 'Gear notes', { summary: 'A compasses order was placed.' }, ['We packed light.']),
  session('r06', 'Compass', {}, ['The ridge was steep.']),
  session('r07', 'Summit day', { summary: 'The compass pointed at the ridge.' }, ['We rested.']),
  session('r08', 'Ridge compass', {}, ['The compass and the ridge again.']),
  session('r09', 'Compasses', {}, ['A ridgeline view.']),
];

/** Ten mail threads: no title passage, the subject on every passage's metadata. */
const THREADS: LibrarySource[] = [
  thread('t00', 'Invoice overdue', ['Please pay by Friday.', 'Thank you for your patience.']),
  thread('t01', 'Lunch on Thursday', ['The invoice is attached below.']),
  thread('t02', 'Sabbatical dates', ['See you in May.']),
  ...['t03', 't04', 't05', 't06', 't07', 't08', 't09'].map((id) => thread(id, `Notice ${id}`, ['Nothing to report here.'])),
];

/** Another workspace's session, filed to a group of the same name and to ann. */
const ELSEWHERE: LibrarySource = {
  ...session('x00', 'Budget press list', { summary: 'The budget and the glacier.' }, [
    'The budget of another workspace has a press list.',
    'The glacier here is said often.',
    'A glacier again, and a kayak.',
    'The quarterly glacier figures.',
  ]),
  tenantId: 'org2',
  aclGroups: [TEAM, 'acct:ann'],
};
/** A third workspace's document. */
const THIRD: LibrarySource = { ...document('y00', 'Glacier', ['The glacier of a third workspace.', 'budget quarterly press list']), tenantId: 'org3' };
/** A session of org1 that only bob may see. */
const PRIVATE: LibrarySource = session('p00', 'Budget private', {}, ['A private budget and a press list.', 'The glacier note.', 'Another glacier line.'], {
  aclGroups: ['acct:bob'],
});

/** Every field a passage of this suite carries, strongest first; a passage with no field ranks as text. */
const PROFILE: LibraryRankProfile = {
  fields: { title: 100, summary: 10, decisions: 10, action_items: 10, next_steps: 10, turn: 1, text: 1 },
  fallback: 'text',
};
/** A thread's profile: the subject, read from the passages' metadata, above the messages. */
const THREADS_PROFILE: LibraryRankProfile = { fields: { title: 100, text: 1 }, fallback: 'text', title: 'metadata' };

/** A group of the caller's: the sources' ids, each with the date the caller holds for it. */
function groupOf(id: string, sources: LibrarySource[], dates: Record<string, string | null> = {}, more: Partial<LibraryGroup> = {}): LibraryGroup {
  return { id, fingerprint: `fp:${id}`, items: sources.map((source) => ({ sourceId: source.sourceId, date: dates[source.sourceId] ?? null })), ...more };
}

/** The ids of a group's hits, in order. */
const ids = (result: LibraryGroupResult): string[] => result.hits.map((hit) => hit.sourceId);

/** What a cursor carries. The index makes it opaque to a caller; these cases read it to see what a page was made with. */
const decode = (cursor: string): Record<string, unknown> => JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
/** A cursor made by hand, as a caller that edited one would send it. */
const encode = (payload: unknown): string => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

/** One statement the store ran: its text, how long it took and how many rows it answered. */
interface Statement {
  sql: string;
  ms: number;
  rows: number;
}

/** A pool that keeps every statement the store runs on it, and calls `hook.after` when one has answered. */
function recording(pool: pg.Pool, seen: Statement[], hook: { after?: (sql: string) => void }): PgPoolLike {
  const timed = async <T extends { rows: unknown[] }>(sql: string, run: () => Promise<T>): Promise<T> => {
    const from = performance.now();
    const result = await run();
    seen.push({ sql, ms: performance.now() - from, rows: result.rows.length });
    hook.after?.(sql);
    return result;
  };
  return {
    query: (sql, params) => timed(sql, () => pool.query(sql, params)),
    connect: async () => {
      const client = await pool.connect();
      return {
        query: (sql, params) => timed(sql, () => client.query(sql, params)),
        release: () => client.release(),
      };
    },
  };
}

describe.skipIf(!URL)('LibraryIndex.searchGroups over PostgresVectorStore on Postgres', () => {
  let pool: pg.Pool;
  let index: LibraryIndex;
  const seen: Statement[] = [];
  const hook: { after?: (sql: string) => void } = {};

  /** One grouped search as ann, on the suite's profile, ten items a page, unless the query says otherwise. */
  async function run(
    query: Partial<LibraryGroupSearch> & Pick<LibraryGroupSearch, 'text' | 'groups'>,
    on: LibraryIndex = index,
  ): Promise<LibraryGroupResult[]> {
    return (await on.searchGroups({ scope: ANN, profile: PROFILE, pageSize: 10, ...query })).groups;
  }

  /** Every page of one group's search, as the ids of each page's hits, following the cursor to its end. */
  async function allPages(query: Parameters<typeof run>[0]): Promise<string[][]> {
    const pages: string[][] = [];
    let cursor = query.cursor;
    for (let turn = 0; turn < 50; turn += 1) {
      const [page] = await run({ ...query, cursor });
      pages.push(ids(page));
      if (page.cursor === null) return pages;
      cursor = page.cursor;
    }
    throw new Error('the cursor never ended');
  }

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
    const store = new PostgresVectorStore({
      id: 'pg-library-groups',
      type: 'postgres',
      pool: recording(pool, seen, hook),
      manageSchema: false,
      tablePrefix: PREFIX,
      textSearchConfig: 'simple',
      similarityMetric: 'cosine',
    });
    index = new LibraryIndex({ store, collection: 'library', embed });
    // Three tenants; fifty sources of org1 across five groups, and three more that no search of ann's in org1 may read.
    for (const source of [...SESSIONS, ...DOCUMENTS, ...FORMS, ...RANKS, ...THREADS, ELSEWHERE, THIRD, PRIVATE]) {
      await index.indexSource(source);
    }
  }, 120_000);

  beforeEach(() => {
    seen.length = 0;
    hook.after = undefined;
  });

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS "${TABLE}" CASCADE`);
    await pool.end();
  });

  it('counts, per group, the distinct items that match every word, and never an item outside the handed lists', async () => {
    const [sessions, documents] = await run({ text: 'budget', groups: [groupOf('sessions', SESSIONS), groupOf('documents', DOCUMENTS)] });
    // s02 holds the word in two passages and counts once.
    expect(sessions).toMatchObject({ id: 'sessions', state: 'ok', total: 4, incomplete: false, cursor: null, anyWord: [] });
    expect(ids(sessions)).toEqual(['session:s00', 'session:s02', 'session:s01', 'session:s09']);
    expect(documents).toMatchObject({ id: 'documents', state: 'ok', total: 2, incomplete: false, cursor: null, anyWord: [] });
    expect(ids(documents)).toEqual(['document:d00', 'document:d01']);
    // A list without s02, and with three items the caller should never have handed: another tenant's session, one
    // that only bob may see, and an id the collection does not hold. The documents' list holds d01 alone.
    const narrowed = groupOf('sessions', [...SESSIONS.filter((source) => source.sourceId !== 'session:s02'), ELSEWHERE, PRIVATE]);
    narrowed.items.push({ sourceId: 'session:nowhere', date: null });
    const [fewer, one] = await run({ text: 'budget', groups: [narrowed, groupOf('documents', [DOCUMENTS[1]])] });
    expect(fewer.total).toBe(3);
    expect(ids(fewer)).toEqual(['session:s00', 'session:s01', 'session:s09']);
    expect(one.total).toBe(1);
    expect(ids(one)).toEqual(['document:d01']);
  });

  it('matches an item by words in different passages (a title passage holding one word, a turn the other) and never by a passage outside its items', async () => {
    const [sessions, documents] = await run({ text: 'press list', groups: [groupOf('sessions', SESSIONS), groupOf('documents', DOCUMENTS)] });
    expect(sessions.total).toBe(2);
    expect(ids(sessions)).toEqual(['session:s03', 'session:s05']);
    const [across, within] = sessions.hits;
    // s03: "Press" is its title and "list" is in a turn. Each passage holds one word, and the title is the stronger.
    expect(across).toMatchObject({ sourceId: 'session:s03', field: 'title', matchKind: 'same', marks: [{ start: 0, end: 5 }], at: 0, partKind: null, anyWord: false });
    expect(across.passage).toMatchObject({ id: 'session:s03#0', sourceId: 'session:s03', kind: 'session', index: 0, text: 'Press', score: 101 });
    // s05: one turn holds both words, so that turn is the hit, whatever the title weighs.
    expect(within).toMatchObject({
      sourceId: 'session:s05',
      field: 'turn',
      matchKind: 'same',
      marks: [
        { start: 4, end: 9 },
        { start: 10, end: 14 },
      ],
      at: 4,
      partKind: 'transcript',
    });
    expect(within.passage).toMatchObject({ id: 'session:s05#2', text: 'The press list is long.', score: 101 });
    // d04 holds "press" and no "list": no document matches, and the words of two items never add up.
    expect(documents.total).toBe(0);
    expect(documents.hits).toEqual([]);
    const [listOnly, pressOnly] = await run({ text: 'press list', groups: [groupOf('sessions', [SESSIONS[4]]), groupOf('documents', [DOCUMENTS[4]])] });
    expect([listOnly.total, pressOnly.total]).toEqual([0, 0]);
    expect([listOnly.hits, pressOnly.hits]).toEqual([[], []]);
  });

  it('answers the any-word items apart from the count when a search of two or more words has no every-word item', async () => {
    const [sessions, documents] = await run({ text: 'zebra budget', groups: [groupOf('sessions', SESSIONS), groupOf('documents', DOCUMENTS)] });
    expect(sessions).toMatchObject({ total: 0, hits: [], cursor: null, incomplete: false });
    expect(sessions.anyWord.map((hit) => [hit.sourceId, hit.passage.score, hit.anyWord])).toEqual([
      ['session:s00', 100, true],
      ['session:s02', 10, true],
      ['session:s01', 1, true],
      ['session:s06', 1, true],
      ['session:s09', 1, true],
    ]);
    expect(documents.total).toBe(0);
    expect(documents.anyWord.map((hit) => hit.sourceId)).toEqual(['document:d00', 'document:d01']);
    // At most a page of them, and never a cursor.
    const [page] = await run({ text: 'zebra budget', groups: [groupOf('sessions', SESSIONS)], pageSize: 2 });
    expect(page.anyWord.map((hit) => hit.sourceId)).toEqual(['session:s00', 'session:s02']);
    expect(page).toMatchObject({ total: 0, hits: [], cursor: null });
    // With an every-word item there are none, though s04 holds one of the two words.
    const [found] = await run({ text: 'press list', groups: [groupOf('sessions', SESSIONS)] });
    expect(found.total).toBe(2);
    expect(found.anyWord).toEqual([]);
    // One word that matches nothing has no "some of the words".
    const [single] = await run({ text: 'zeppelin', groups: [groupOf('sessions', SESSIONS)] });
    expect(single).toMatchObject({ total: 0, hits: [], anyWord: [] });
  });

  it('lists, counts and pages every item with no word, with and without partKinds, in date order under either sort', async () => {
    const newest = ['session:s07', 'session:s06', 'session:s09', 'session:s05', 'session:s04', 'session:s03', 'session:s01', 'session:s08', 'session:s00', 'session:s02'];
    for (const order of ['rank', 'date'] as const) {
      const [all] = await run({ text: '', groups: [groupOf('sessions', SESSIONS, SESSION_DATES)], order });
      expect(all).toMatchObject({ state: 'ok', total: 10, incomplete: false, cursor: null, anyWord: [] });
      expect(ids(all), order).toEqual(newest);
      // Each item's hit is its first passage, with nothing marked, and its date is the caller's.
      expect(all.hits.map((hit) => [hit.passage.index, hit.field, hit.partKind, hit.matchKind, hit.marks.length, hit.at, hit.anyWord])).toEqual(
        newest.map(() => [0, 'title', null, 'none', 0, -1, false]),
      );
      expect(all.hits.map((hit) => hit.date)).toEqual(newest.map((id) => SESSION_DATES[id]));
    }
    // Paged: every item once, the count on every page, the undated items on the last.
    expect(await allPages({ text: '', groups: [groupOf('sessions', SESSIONS, SESSION_DATES)], pageSize: 4 })).toEqual([newest.slice(0, 4), newest.slice(4, 8), newest.slice(8)]);
    const [second] = await run({
      text: '',
      groups: [groupOf('sessions', SESSIONS, SESSION_DATES)],
      pageSize: 4,
      cursor: (await run({ text: '', groups: [groupOf('sessions', SESSIONS, SESSION_DATES)], pageSize: 4 }))[0].cursor as string,
    });
    expect(second.total).toBe(10);
    // With a part kind: the sessions that hold a summary, each by its summary.
    const summarized = ['session:s07', 'session:s06', 'session:s05', 'session:s03', 'session:s01', 'session:s00', 'session:s02'];
    const narrowed = groupOf('sessions', SESSIONS, SESSION_DATES, { partKinds: ['summary'] });
    const [summaries] = await run({ text: '', groups: [narrowed] });
    expect(summaries.total).toBe(7);
    expect(ids(summaries)).toEqual(summarized);
    expect(summaries.hits.map((hit) => [hit.passage.index, hit.field, hit.partKind, hit.marks.length])).toEqual(summarized.map(() => [1, 'summary', 'summary', 0]));
    expect(await allPages({ text: '', groups: [narrowed], pageSize: 3, order: 'date' })).toEqual([summarized.slice(0, 3), summarized.slice(3, 6), summarized.slice(6)]);
  });

  it('pages by a stable cursor: every item once across pages, the tie-breaker the item id, the expansion carried and held again, a cursor carrying a word no query word reaches refused', async () => {
    const documents = groupOf('documents', DOCUMENTS);
    const every = DOCUMENTS.map((source) => source.sourceId);
    // Ten documents hold the word in their text, level in rank, so the id decides.
    expect(await allPages({ text: 'quarterly', groups: [documents], pageSize: 3 })).toEqual([every.slice(0, 3), every.slice(3, 6), every.slice(6, 9), every.slice(9)]);
    // The same through a typo: the first page reads the stored words, and its cursor carries what it found.
    seen.length = 0;
    const [first] = await run({ text: 'quartrely', typo: 'one-edit', groups: [documents], pageSize: 3 });
    expect(first.total).toBe(10);
    expect(ids(first)).toEqual(every.slice(0, 3));
    expect(first.hits.map((hit) => [hit.matchKind, hit.passage.score])).toEqual([
      ['edit', 0.5],
      ['edit', 0.5],
      ['edit', 0.5],
    ]);
    expect(seen.some((statement) => statement.sql.includes('ts_stat'))).toBe(true);
    const carried = decode(first.cursor as string);
    expect(carried).toMatchObject({ v: 1, groupId: 'documents', fingerprint: 'fp:documents', words: ['quartrely'], expansion: [['quarterly']] });
    // The later pages read them from the cursor, and no stored word again.
    seen.length = 0;
    expect(await allPages({ text: 'quartrely', typo: 'one-edit', groups: [documents], pageSize: 3, cursor: first.cursor as string })).toEqual([
      every.slice(3, 6),
      every.slice(6, 9),
      every.slice(9),
    ]);
    expect(seen.some((statement) => statement.sql.includes('ts_stat'))).toBe(false);
    // The carried words are held again on every read: one that no query word reaches is refused.
    const forged = encode({ ...carried, expansion: [['quarterly', 'secrets']] });
    await expect(run({ text: 'quartrely', typo: 'one-edit', groups: [documents], pageSize: 3, cursor: forged })).rejects.toMatchObject({ name: 'LibraryCursorError' });
  });

  it('answers restart when a later page carries another fingerprint than the one handed', async () => {
    const documents = groupOf('documents', DOCUMENTS);
    const [first] = await run({ text: 'quarterly', groups: [documents], pageSize: 3 });
    expect(first.cursor).not.toBeNull();
    // The caller's list changed between the pages (a renamed title, a moved item, a permission), and its fingerprint with it.
    const [changed] = await run({ text: 'quarterly', groups: [{ ...documents, fingerprint: 'fp:documents:2' }], pageSize: 3, cursor: first.cursor as string });
    expect(changed).toEqual({ id: 'documents', state: 'restart', total: 0, incomplete: false, cursor: null, hits: [], anyWord: [] });
    // Under the fingerprint the cursor was made with, the next page follows.
    const [next] = await run({ text: 'quarterly', groups: [documents], pageSize: 3, cursor: first.cursor as string });
    expect(next.state).toBe('ok');
    expect(ids(next)).toEqual(['document:d03', 'document:d04', 'document:d05']);
  });

  it("orders by the caller's dates under order date, undated items last in rank order, and reads no date from a passage", async () => {
    const sessions = groupOf('sessions', SESSIONS, SESSION_DATES);
    const [ranked] = await run({ text: 'budget', groups: [sessions] });
    expect(ranked.hits.map((hit) => [hit.sourceId, hit.passage.score])).toEqual([
      ['session:s00', 100],
      ['session:s02', 10],
      ['session:s01', 1],
      ['session:s09', 1],
    ]);
    const [dated] = await run({ text: 'budget', groups: [sessions], order: 'date' });
    expect(dated.total).toBe(4);
    // s09 and s01 by their dates, the newer first; then the two undated ones, the title match before the summary match.
    expect(dated.hits.map((hit) => [hit.sourceId, hit.date])).toEqual([
      ['session:s09', '2026-03-01T09:30:00.000Z'],
      ['session:s01', '2026-01-05T10:00:00.000Z'],
      ['session:s00', null],
      ['session:s02', null],
    ]);
    // s00's passages carry a date of their own, later than any the caller handed: no search reads it.
    expect(dated.hits[2].passage.metadata.date).toBe('2031-12-31T00:00:00.000Z');
    // Paged one at a time across the dated and the undated: each once.
    expect(await allPages({ text: 'budget', groups: [sessions], order: 'date', pageSize: 1 })).toEqual([['session:s09'], ['session:s01'], ['session:s00'], ['session:s02']]);
    // The dates decide: with those of s01 and s09 exchanged, so are the two hits.
    const exchanged = { ...SESSION_DATES, 'session:s01': SESSION_DATES['session:s09'], 'session:s09': SESSION_DATES['session:s01'] };
    const [other] = await run({ text: 'budget', groups: [groupOf('sessions', SESSIONS, exchanged)], order: 'date' });
    expect(ids(other)).toEqual(['session:s01', 'session:s09', 'session:s00', 'session:s02']);
  });

  it('narrows by partKinds and leaves kinds as the source kind it is', async () => {
    const of = (partKinds: LibraryPartKind[]): LibraryGroup => groupOf('sessions', SESSIONS, {}, { partKinds });
    const [summary] = await run({ text: 'budget', groups: [of(['summary'])] });
    expect(summary.total).toBe(1);
    expect(summary.hits.map((hit) => [hit.sourceId, hit.partKind, hit.passage.kind])).toEqual([['session:s02', 'summary', 'session']]);
    const [transcript] = await run({ text: 'budget', groups: [of(['transcript'])] });
    expect(transcript.total).toBe(3);
    expect(transcript.hits.map((hit) => [hit.sourceId, hit.partKind])).toEqual([
      ['session:s01', 'transcript'],
      ['session:s02', 'transcript'],
      ['session:s09', 'transcript'],
    ]);
    const [either] = await run({ text: 'budget', groups: [of(['summary', 'transcript'])] });
    expect(ids(either)).toEqual(['session:s02', 'session:s01', 'session:s09']);
    // An empty list narrows nothing, as an empty `kinds` does.
    const [all] = await run({ text: 'budget', groups: [of([])] });
    expect(all.total).toBe(4);
    // `kinds` still names the kind of source, on the search it has always narrowed.
    const found = await index.search({ text: 'budget', scope: ANN, mode: 'lexical', kinds: ['document'], topK: 20 });
    expect(found.map((passage) => passage.id).sort()).toEqual(['document:d00#0', 'document:d01#1']);
    expect(found.map((passage) => passage.kind)).toEqual(['document', 'document']);
  });

  it('applies partKinds before the expansion, the match, the count, the rank and the best passage: under partKinds [summary] a word held only in a transcript passage matches nothing and never enters the expansion', async () => {
    const of = (partKinds?: LibraryPartKind[]): LibraryGroup => groupOf('sessions', SESSIONS, {}, partKinds ? { partKinds } : {});
    // "kayak" is said in two turns and written in no summary.
    const [said] = await run({ text: 'kayak', groups: [of()] });
    expect(ids(said)).toEqual(['session:s06', 'session:s08']);
    const [unwritten] = await run({ text: 'kayak', groups: [of(['summary'])] });
    expect(unwritten).toMatchObject({ total: 0, hits: [], anyWord: [] });
    // "kayka" is one edit from "kayak", in two turns, and from "kayke", in one summary. With room for one stored word,
    // the turns' more frequent word takes it across the whole sessions, and the answer says a word was left out.
    const [whole] = await run({ text: 'kayka', typo: 'one-edit', expansionMax: 1, groups: [of()] });
    expect(whole).toMatchObject({ total: 2, incomplete: true });
    expect(ids(whole)).toEqual(['session:s06', 'session:s08']);
    // Under the summaries the turns' word is no candidate at all: the summary's word is found, and nothing was left out.
    const [narrowed] = await run({ text: 'kayka', typo: 'one-edit', expansionMax: 1, groups: [of(['summary'])] });
    expect(narrowed).toMatchObject({ total: 1, incomplete: false });
    expect(narrowed.hits.map((hit) => [hit.sourceId, hit.matchKind, hit.partKind])).toEqual([['session:s07', 'edit', 'summary']]);
    // The rank and the hit follow the narrowing: s02 holds "budget" in its summary and in a turn, s00 in its title alone.
    const shown = (result: LibraryGroupResult) => result.hits.map((hit) => [hit.sourceId, hit.passage.score, hit.field, hit.passage.index]);
    const [bySummary] = await run({ text: 'budget', groups: [of(['summary'])] });
    expect(shown(bySummary)).toEqual([['session:s02', 10, 'summary', 1]]);
    const [byTurn] = await run({ text: 'budget', groups: [of(['transcript'])] });
    expect(shown(byTurn)).toEqual([
      ['session:s01', 1, 'turn', 2],
      ['session:s02', 1, 'turn', 3],
      ['session:s09', 1, 'turn', 1],
    ]);
  });

  it('caps the expansion after the edit check: sixty-five frequent stored words of the right length that are not one edit away never crowd out the one rare word that is', async () => {
    // Sixty-five words of six letters, each in three passages, none within one edit of "marble"; and "marbel", once.
    const frequent = Array.from({ length: 65 }, (_, n) => `qz${String.fromCharCode(97 + Math.floor(n / 26))}${String.fromCharCode(97 + (n % 26))}vv`);
    const crowd: LibrarySource[] = ['a', 'b', 'c'].map((id) => ({ sourceId: `cap:${id}`, kind: 'document', tenantId: 'org-cap', aclGroups: [TEAM], passages: [{ text: frequent.join(' ') }] }));
    const rare: LibrarySource = { sourceId: 'cap:d', kind: 'document', tenantId: 'org-cap', aclGroups: [TEAM], passages: [{ text: 'The marbel floor was polished.' }] };
    for (const source of [...crowd, rare]) await index.indexSource(source);
    const [found] = await run({ text: 'marble', typo: 'one-edit', scope: { tenantId: 'org-cap', aclGroups: [TEAM] }, groups: [groupOf('cap', [...crowd, rare])] });
    expect(found).toMatchObject({ total: 1, incomplete: false });
    expect(found.hits.map((hit) => [hit.sourceId, hit.matchKind])).toEqual([['cap:d', 'edit']]);
  });

  it('refuses a cursor whose signature differs from the request: another order, profile, partKinds, typo, expansionMax or group; and a cursor whose words differ', async () => {
    const documents = groupOf('documents', DOCUMENTS);
    const base = { text: 'quarterly', groups: [documents], pageSize: 3 };
    const [first] = await run(base);
    const cursor = first.cursor as string;
    expect(typeof cursor).toBe('string');
    const refused = (query: Parameters<typeof run>[0]): Promise<void> => expect(run(query)).rejects.toMatchObject({ name: 'LibraryCursorError' });
    await refused({ ...base, cursor, order: 'date' });
    await refused({ ...base, cursor, profile: { ...PROFILE, fields: { ...PROFILE.fields, text: 2 } } });
    await refused({ ...base, cursor, profile: { ...PROFILE, title: 'metadata' } });
    await refused({ ...base, cursor, groups: [{ ...documents, partKinds: ['summary'] }] });
    await refused({ ...base, cursor, typo: 'one-edit' });
    await refused({ ...base, cursor, expansionMax: 5 });
    // Another group: one the search does not hand, and one it hands that the cursor was not made for.
    await refused({ ...base, cursor, groups: [groupOf('sessions', SESSIONS)] });
    await refused({ ...base, cursor: encode({ ...decode(cursor), groupId: 'sessions' }), groups: [documents, groupOf('sessions', SESSIONS)] });
    // Other words.
    await refused({ ...base, cursor, text: 'quarterly figures' });
    await refused({ ...base, cursor, text: 'figures' });
    // Not a cursor of this search at all.
    const broken = ['', 'not a cursor', encode('text'), encode({ v: 2 }), encode({ ...decode(cursor), key: [1, 2, 3, 4] }), encode({ ...decode(cursor), expansion: 'quarterly' })];
    for (const not of broken) await refused({ ...base, cursor: not });
    // The same request with its own cursor: the next page.
    const [next] = await run({ ...base, cursor });
    expect(ids(next)).toEqual(['document:d03', 'document:d04', 'document:d05']);
  });

  it("ranks an item's title read from its passages' metadata where the profile takes the title from there, the title above the text, and widens a word of the title too", async () => {
    const threads = groupOf('threads', THREADS);
    const shown = (result: LibraryGroupResult) => result.hits.map((hit) => [hit.sourceId, hit.passage.score, hit.field, hit.matchKind]);
    const [found] = await run({ text: 'invoice', groups: [threads], profile: THREADS_PROFILE });
    expect(found.total).toBe(2);
    expect(shown(found)).toEqual([
      ['thread:t00', 100, 'title', 'same'],
      ['thread:t01', 1, 'text', 'same'],
    ]);
    // The subject matched and no message holds the word: the hit is the thread's first message, with nothing marked.
    expect(found.hits[0]).toMatchObject({ marks: [], at: -1, partKind: null });
    expect(found.hits[0].passage).toMatchObject({ id: 'thread:t00#0', title: 'Invoice overdue', text: 'Please pay by Friday.' });
    expect(found.hits[1]).toMatchObject({ marks: [{ start: 4, end: 11 }], at: 4 });
    // A profile that reads titles from passages finds no title passage in a thread: the message alone matches.
    const plain: LibraryRankProfile = { fields: { title: 100, text: 1 }, fallback: 'text' };
    const [messages] = await run({ text: 'invoice', groups: [threads], profile: plain });
    expect(shown(messages)).toEqual([['thread:t01', 1, 'text', 'same']]);
    // A typo of a word that only a subject holds is widened to it.
    const [typo] = await run({ text: 'sabbaticla', typo: 'one-edit', groups: [threads], profile: THREADS_PROFILE });
    expect(shown(typo)).toEqual([['thread:t02', 50, 'title', 'edit']]);
    const [none] = await run({ text: 'sabbaticla', typo: 'one-edit', groups: [threads], profile: plain });
    expect(none).toMatchObject({ total: 0, hits: [] });
  });

  it('widens a word of four letters or more to stored words the same, begun by it or one edit away (a swap, a letter added, dropped, changed); never a word under four letters', async () => {
    const forms = groupOf('forms', FORMS);
    const found = async (text: string, typo: 'one-edit' | 'none' = 'one-edit'): Promise<Array<Array<string | number>>> => {
      const [result] = await run({ text, typo, groups: [forms] });
      expect(result.total).toBe(result.hits.length);
      return result.hits.map((hit) => [hit.sourceId, hit.matchKind, hit.passage.score]);
    };
    expect(await found('harbor')).toEqual([
      ['document:f00', 'same', 1],
      ['document:f01', 'start', 0.75],
    ]);
    expect(await found('harb')).toEqual([
      ['document:f00', 'start', 0.75],
      ['document:f01', 'start', 0.75],
    ]);
    // One edit from the stored "harbor": two letters swapped, a letter added, a letter dropped, a letter changed.
    for (const typed of ['harbro', 'harbour', 'harbr', 'harbox']) {
      expect(await found(typed), typed).toEqual([['document:f00', 'edit', 0.5]]);
    }
    // The mark is the stored word.
    const [marked] = await run({ text: 'harbro', typo: 'one-edit', groups: [forms] });
    expect(marked.hits[0]).toMatchObject({ marks: [{ start: 4, end: 10 }], at: 4 });
    expect(marked.hits[0].passage.text).toBe('The harbor opens at dawn.');
    // Without the rule a typo finds nothing.
    expect(await found('harbro', 'none')).toEqual([]);
    // Four letters each: "dokc" finds "dock"; "cta" is too short to widen, and "cart" never reaches the three letters of
    // "cat", which the word itself finds.
    expect(await found('dokc')).toEqual([['document:f03', 'edit', 0.5]]);
    expect(await found('cta')).toEqual([]);
    expect(await found('cart')).toEqual([]);
    expect(await found('cat')).toEqual([['document:f02', 'same', 1]]);
  });

  it("draws expansion candidates from the handed items alone: a word held only by another tenant's or another group's passage never enters the expansion nor uses its limit", async () => {
    // "glacire" is one edit from "glacier", which three passages of a document hold, as do another tenant's session and
    // a session only bob may see; and from "glacira", which one turn of s08 holds. With room for one stored word, the
    // sessions' own rare word is found and nothing is left out.
    const sessions = groupOf('sessions', SESSIONS);
    const [own] = await run({ text: 'glacire', typo: 'one-edit', expansionMax: 1, groups: [sessions] });
    expect(own).toMatchObject({ total: 1, incomplete: false });
    expect(own.hits.map((hit) => [hit.sourceId, hit.matchKind])).toEqual([['session:s08', 'edit']]);
    // Handing the other tenant's session and bob's changes nothing: the index reads neither.
    const [still] = await run({ text: 'glacire', typo: 'one-edit', expansionMax: 1, groups: [groupOf('sessions', [...SESSIONS, ELSEWHERE, PRIVATE])] });
    expect(still).toMatchObject({ total: 1, incomplete: false });
    expect(ids(still)).toEqual(['session:s08']);
    // Each group is widened from its own items: the documents' "glacier" is theirs alone.
    const [first, second] = await run({ text: 'glacire', typo: 'one-edit', expansionMax: 1, groups: [sessions, groupOf('documents', DOCUMENTS)] });
    expect(ids(first)).toEqual(['session:s08']);
    expect(second).toMatchObject({ total: 1, incomplete: false });
    expect(second.hits.map((hit) => [hit.sourceId, hit.matchKind])).toEqual([['document:d07', 'edit']]);
  });

  it('marks incomplete when more than expansionMax stored words one edit away exist, and when the signal aborts between statements', async () => {
    // Five stored words one edit from "planet", in five, four, three, two and one passages.
    const near = ['planex', 'planey', 'planez', 'planeq', 'planew'];
    const sources: LibrarySource[] = near.map((word, at) => ({
      sourceId: `inc:${at}`,
      kind: 'document',
      tenantId: 'org-inc',
      aclGroups: [TEAM],
      passages: Array.from({ length: 5 - at }, (_, n) => ({ text: `${word} ${n}` })),
    }));
    for (const source of sources) await index.indexSource(source);
    const scope: LibraryScope = { tenantId: 'org-inc', aclGroups: [TEAM] };
    const group = groupOf('inc', sources);
    // Room for three: the three most frequent are kept, and the answer says more were left out.
    const [cut] = await run({ text: 'planet', typo: 'one-edit', expansionMax: 3, scope, groups: [group], pageSize: 2 });
    expect(cut).toMatchObject({ total: 3, incomplete: true });
    expect(ids(cut)).toEqual(['inc:0', 'inc:1']);
    expect(decode(cut.cursor as string).expansion).toEqual([['planex', 'planey', 'planez']]);
    const [four] = await run({ text: 'planet', typo: 'one-edit', expansionMax: 4, scope, groups: [group] });
    expect(four).toMatchObject({ total: 4, incomplete: true });
    // Room for all five: nothing was left out.
    const [whole] = await run({ text: 'planet', typo: 'one-edit', expansionMax: 5, scope, groups: [group] });
    expect(whole).toMatchObject({ total: 5, incomplete: false });
    // A signal that aborts once the store has begun to read the stored words: the group is marked with nothing
    // answered, and so is the group after it.
    const controller = new AbortController();
    hook.after = (sql) => {
      if (sql.includes('ts_stat')) controller.abort();
    };
    const stopped = await run({ text: 'planet', typo: 'one-edit', scope, groups: [group, { ...group, id: 'inc-again' }], signal: controller.signal });
    hook.after = undefined;
    expect(stopped).toEqual([
      { id: 'inc', state: 'ok', total: 0, incomplete: true, cursor: null, hits: [], anyWord: [] },
      { id: 'inc-again', state: 'ok', total: 0, incomplete: true, cursor: null, hits: [], anyWord: [] },
    ]);
    // A signal that had aborted before the search asks the store nothing.
    seen.length = 0;
    const [never] = await run({ text: 'planet', scope, groups: [group], signal: controller.signal });
    expect(never).toEqual({ id: 'inc', state: 'ok', total: 0, incomplete: true, cursor: null, hits: [], anyWord: [] });
    expect(seen).toEqual([]);
  });

  it('ranks by the explicit rule: field weight times match kind summed over the words; same above start above edit within a field; the fields in the profile order', async () => {
    const ranks = groupOf('ranks', RANKS);
    const scored = (result: LibraryGroupResult) => result.hits.map((hit) => [hit.sourceId, hit.passage.score, hit.field, hit.matchKind]);
    // One word: the title (100) above a summary (10) above a turn (1); in a field, the same word (1) above a word it
    // begins (0.75) above a word one edit away (0.5); a level rank in the order of the ids.
    const [one] = await run({ text: 'compass', typo: 'one-edit', groups: [ranks] });
    expect(one.total).toBe(10);
    expect(scored(one)).toEqual([
      ['session:r00', 100, 'title', 'same'],
      ['session:r06', 100, 'title', 'same'],
      ['session:r08', 100, 'title', 'same'],
      ['session:r03', 75, 'title', 'start'],
      ['session:r09', 75, 'title', 'start'],
      ['session:r04', 50, 'title', 'edit'],
      ['session:r01', 10, 'summary', 'same'],
      ['session:r07', 10, 'summary', 'same'],
      ['session:r05', 7.5, 'summary', 'start'],
      ['session:r02', 1, 'turn', 'same'],
    ]);
    // Two words: each word's best match over the item's passages, summed. r08 holds both in its title and in a turn,
    // and counts the title twice, never the turn on top.
    const [two] = await run({ text: 'compass ridge', groups: [ranks] });
    expect(scored(two)).toEqual([
      ['session:r08', 200, 'title', 'same'],
      ['session:r06', 101, 'title', 'same'],
      ['session:r09', 75.75, 'title', 'start'],
      ['session:r07', 20, 'summary', 'same'],
    ]);
  });

  it('measures one thousand and five thousand items a group over ten thousand passages across fifty groups and records the milliseconds', async () => {
    // 9,880 items of one tenant: 5,000 in one group, 1,000 in another, 47 groups of 80, and one of 120 whose items hold
    // two passages each: 10,000 passages. A passage is twelve words of a vocabulary of 2,000, lex0000 to lex1999.
    await pool.query(
      `INSERT INTO "${TABLE}" (id, embedding, metadata_json, text_content)
       SELECT 'big:' || g.n || '#' || k.i, '[0,0,0,0.1]'::vector,
              jsonb_build_object('tenantId', 'org-big', 'aclGroups', jsonb_build_array('${TEAM}'), 'status', 'active',
                                 'sourceId', 'big:' || g.n, 'kind', 'document', 'tags', '[]'::jsonb, 'index', k.i, 'field', 'text'),
              (SELECT string_agg('lex' || lpad((((g.n + k.i) * 31 + j * 17) % 2000)::text, 4, '0'), ' ') FROM generate_series(1, 12) AS j)
       FROM generate_series(0, 9879) AS g(n)
       CROSS JOIN LATERAL generate_series(0, CASE WHEN g.n >= 9760 THEN 1 ELSE 0 END) AS k(i)`,
    );
    // One passage of the largest group holds a word no other passage holds, one edit from the query's.
    await pool.query(`UPDATE "${TABLE}" SET text_content = text_content || ' lex2041' WHERE id = 'big:4999#0'`);
    const counted = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${TABLE}" WHERE metadata_json->>'tenantId' = 'org-big'`);
    expect(counted.rows[0].n).toBe(10000);

    const item = (n: number): LibraryGroupItem => ({ sourceId: `big:${n}`, date: new Date(Date.UTC(2026, 0, 1) + n * 60000).toISOString() });
    const range = (id: string, from: number, to: number): LibraryGroup => ({ id, fingerprint: `fp:${id}`, items: Array.from({ length: to - from }, (_, at) => item(from + at)) });
    const five = range('five-thousand', 0, 5000);
    const one = range('one-thousand', 5000, 6000);
    const fifty = [five, one, ...Array.from({ length: 47 }, (_, at) => range(`eighty-${at}`, 6000 + at * 80, 6080 + at * 80)), range('pairs', 9760, 9880)];
    expect(fifty.length).toBe(50);
    expect(fifty.reduce((sum, group) => sum + group.items.length, 0)).toBe(9880);

    // What the corpus holds, counted here by the rule that wrote it. "lex2014" is no word of the vocabulary; the
    // vocabulary's words one edit from it are lex0014, lex1014 (a letter changed) and lex0214 (two swapped).
    const wordsOf = (n: number): number[] => Array.from({ length: 12 }, (_, at) => (n * 31 + (at + 1) * 17) % 2000);
    const passagesOf = (n: number): number[][] => (n >= 9760 ? [wordsOf(n), wordsOf(n + 1)] : [wordsOf(n)]);
    const near = [14, 214, 1014];
    const holders = (group: LibraryGroup): string[] =>
      group.items
        .map((entry) => Number(entry.sourceId.slice(4)))
        .filter((n) => n === 4999 || passagesOf(n).some((words) => words.some((word) => near.includes(word))))
        .map((n) => `big:${n}`)
        .sort();
    const storedNear = (group: LibraryGroup): string[] => {
      const inPassages = new Map<number, number>(near.map((word) => [word, 0]));
      for (const entry of group.items) {
        for (const words of passagesOf(Number(entry.sourceId.slice(4)))) {
          for (const word of near) if (words.includes(word)) inPassages.set(word, (inPassages.get(word) ?? 0) + 1);
        }
      }
      const named = (word: number): string => `lex${String(word).padStart(4, '0')}`;
      return [...inPassages].filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1] || (named(a[0]) < named(b[0]) ? -1 : 1)).map(([word]) => named(word));
    };

    const scope: LibraryScope = { tenantId: 'org-big', aclGroups: [TEAM] };
    const profile: LibraryRankProfile = { fields: { text: 1 }, fallback: 'text' };
    const figures: string[] = [];
    const measured = async (label: string, query: Parameters<typeof run>[0]): Promise<{ groups: LibraryGroupResult[]; read: Statement[] }> => {
      seen.length = 0;
      const from = performance.now();
      const groups = await run({ scope, profile, pageSize: 20, ...query });
      const ms = performance.now() - from;
      // The statements that read the stored words: the one that names ts_stat, and each batch fetched from it.
      const read = seen.filter((statement) => /ts_stat|^\s*FETCH\b/.test(statement.sql));
      const readMs = read.reduce((sum, statement) => sum + statement.ms, 0);
      const readRows = read.reduce((sum, statement) => sum + statement.rows, 0);
      figures.push(`${label}: ${ms.toFixed(1)} ms; ${seen.length} statements; stored words read in ${readMs.toFixed(1)} ms, ${readRows} of them`);
      expect(ms).toBeGreaterThan(0);
      return { groups, read: [...read] };
    };

    for (const group of [one, five]) {
      const size = group.items.length;
      // Ten a page: the smaller group holds seventeen items one edit from the word, the larger ninety-two.
      const typed = await measured(`${size} items, "lex2014" with one edit, first page`, { text: 'lex2014', typo: 'one-edit', groups: [group], pageSize: 10 });
      const [found] = typed.groups;
      const expected = holders(group);
      expect(expected.length).toBe(group === five ? 92 : 17);
      expect(found).toMatchObject({ total: expected.length, incomplete: false });
      // Level in rank, half a point each, so the ids decide, compared unit by unit.
      expect(ids(found)).toEqual(expected.slice(0, 10));
      expect(found.hits.every((hit) => hit.matchKind === 'edit' && hit.passage.score === 0.5)).toBe(true);
      // The largest group's rare word stands after two thousand more frequent ones: every batch of them was read.
      const stored = group === five ? [...storedNear(group), 'lex2041'] : storedNear(group);
      expect(decode(found.cursor as string).expansion).toEqual([stored]);
      expect(typed.read.reduce((sum, statement) => sum + statement.rows, 0)).toBe(group === five ? 2001 : 2000);
      const next = await measured(`${size} items, "lex2014" with one edit, second page`, { text: 'lex2014', typo: 'one-edit', groups: [group], pageSize: 10, cursor: found.cursor as string });
      expect(ids(next.groups[0])).toEqual(expected.slice(10, 20));
      expect(next.read).toEqual([]);
      const listed = await measured(`${size} items, no word, first page`, { text: '', groups: [group] });
      expect(listed.groups[0].total).toBe(size);
      // Newest first: the items' dates rise with their numbers.
      const last = Number(group.items[size - 1].sourceId.slice(4));
      expect(ids(listed.groups[0]).slice(0, 3)).toEqual([`big:${last}`, `big:${last - 1}`, `big:${last - 2}`]);
    }
    const all = await measured('fifty groups of 9,880 items in one search, "lex2014" with one edit, five a page', { text: 'lex2014', typo: 'one-edit', groups: fifty, pageSize: 5 });
    expect(all.groups.map((result) => result.id)).toEqual(fifty.map((group) => group.id));
    expect(all.groups.map((result) => result.total)).toEqual(fifty.map((group) => holders(group).length));
    console.log(`[library-groups] 10,000 passages, 50 groups\n${figures.map((line) => `[library-groups] ${line}`).join('\n')}`);
  });

  it('answers the same through a storage adapter, and inside a transaction of the caller', async () => {
    const query = { text: 'quartrely figures', typo: 'one-edit' as const, groups: [groupOf('documents', DOCUMENTS), groupOf('sessions', SESSIONS, SESSION_DATES)], pageSize: 4 };
    const expected = await run(query);
    expect(expected.map((result) => [result.id, result.total, result.hits.length, result.cursor === null])).toEqual([
      ['documents', 10, 4, false],
      ['sessions', 0, 0, true],
    ]);
    const db = createPostgresAdapter({ connectionString: URL as string, max: 2 });
    await db.open();
    try {
      const adapted = new PostgresVectorStore({
        id: 'pg-library-groups-adapter',
        type: 'postgres',
        adapter: db,
        manageSchema: false,
        tablePrefix: PREFIX,
        textSearchConfig: 'simple',
        similarityMetric: 'cosine',
      });
      await adapted.initialize();
      expect(await run(query, new LibraryIndex({ store: adapted, collection: 'library', embed }))).toEqual(expected);
      const inside = await db.transaction((tx) => adapted.withStorageTransaction(tx, (view) => run(query, new LibraryIndex({ store: view, collection: 'library', embed }))));
      expect(inside).toEqual(expected);
    } finally {
      await db.close();
    }
  });

  it('leaves a word the text search configuration reads as no lexeme out of the every-word rule', async () => {
    for (const statement of PostgresVectorStore.schemaSql('stemmed', 4, { tablePrefix: PREFIX, textSearchConfig: 'english' })) {
      await pool.query(statement);
    }
    try {
      const store = new PostgresVectorStore({ id: 'pg-library-groups-english', type: 'postgres', pool, manageSchema: false, tablePrefix: PREFIX, textSearchConfig: 'english', similarityMetric: 'cosine' });
      const stemmed = new LibraryIndex({ store, collection: 'stemmed', embed });
      await stemmed.indexSource({ sourceId: 'note:1', kind: 'note', tenantId: ORG, aclGroups: [TEAM], passages: [{ text: 'The budget grows every year.' }] });
      await stemmed.indexSource({ sourceId: 'note:2', kind: 'note', tenantId: ORG, aclGroups: [TEAM], passages: [{ text: 'Nothing of note.' }] });
      const notes: LibraryGroup = { id: 'notes', fingerprint: 'fp:notes', items: [{ sourceId: 'note:1', date: null }, { sourceId: 'note:2', date: null }] };
      // "the" is a stop word of the english configuration: no passage's lexemes hold it, and the search asks for
      // "budget" alone.
      const [found] = await run({ text: 'the budget', groups: [notes] }, stemmed);
      expect(found.total).toBe(1);
      expect(found.hits.map((hit) => [hit.sourceId, hit.matchKind, hit.marks])).toEqual([['note:1', 'same', [{ start: 4, end: 10 }]]]);
      const [nothing] = await run({ text: 'the', groups: [notes] }, stemmed);
      expect(nothing).toMatchObject({ total: 0, hits: [], anyWord: [] });
    } finally {
      await pool.query(`DROP TABLE IF EXISTS "${PREFIX}stemmed" CASCADE`);
    }
  });

  it('refuses a search it cannot scope or read: no tenant, no group of the principal, no group of items, a list handed twice, a store without the member', async () => {
    const documents = groupOf('documents', DOCUMENTS);
    const base = { text: 'budget', groups: [documents] };
    const unscoped = 'LibraryIndex.searchGroups needs a tenant and at least one access group.';
    await expect(run({ ...base, scope: { tenantId: '', aclGroups: [TEAM] } })).rejects.toThrow(unscoped);
    await expect(run({ ...base, scope: { tenantId: ORG, aclGroups: [] } })).rejects.toThrow(unscoped);
    await expect(run({ ...base, groups: [] })).rejects.toThrow('LibraryIndex.searchGroups needs at least one group.');
    await expect(run({ ...base, groups: [documents, documents] })).rejects.toThrow(/group/);
    await expect(run({ ...base, groups: [{ ...documents, items: [...documents.items, documents.items[0]] }] })).rejects.toThrow(/twice/);
    await expect(run({ ...base, groups: [{ ...documents, items: [{ sourceId: 'document:d00', date: 'yesterday' }] }] })).rejects.toThrow(/date/);
    await expect(run({ ...base, pageSize: 0 })).rejects.toThrow(/pageSize/);
    await expect(run({ ...base, expansionMax: 0 })).rejects.toThrow(/expansionMax/);
    await expect(run({ ...base, profile: { fields: { title: 100 }, fallback: 'text' } })).rejects.toThrow(/fallback/);
    await expect(run({ ...base, profile: { fields: { text: 0 }, fallback: 'text' } })).rejects.toThrow(/weight/);
    const bare = new LibraryIndex({ store: new InMemoryVectorStore(), collection: 'library', embed });
    await expect(run(base, bare)).rejects.toThrow('LibraryIndex: the store has no lexicalGroupSearch.');
    // An empty list is empty, never unrestricted: nothing is asked of the store.
    seen.length = 0;
    const [empty] = await run({ ...base, groups: [{ ...documents, items: [] }] });
    expect(empty).toEqual({ id: 'documents', state: 'ok', total: 0, incomplete: false, cursor: null, hits: [], anyWord: [] });
    expect(seen).toEqual([]);
  });
});
