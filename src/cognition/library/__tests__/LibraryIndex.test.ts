import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IVectorStore, MetadataFilter, MetadataValue, QueryOptions, QueryResult } from '../../../core/vector-store/IVectorStore.js';
import { InMemoryVectorStore } from '../../rag/vector_stores/InMemoryVectorStore.js';
import { LibraryIndex, type LibrarySearch, type LibrarySource } from '../LibraryIndex.js';

/** A deterministic embedding: four counts of letter classes, so texts about the same words sit together. */
const embed = vi.fn(async (texts: string[]) =>
  texts.map((text) => {
    const lower = text.toLowerCase();
    return [/budget/.test(lower) ? 1 : 0, /weather/.test(lower) ? 1 : 0, /hiring/.test(lower) ? 1 : 0, 0.1];
  }),
);

const source = (over: Partial<LibrarySource>): LibrarySource => ({
  sourceId: 'session:s1',
  kind: 'session',
  tenantId: 'org1',
  aclGroups: ['acct:ann'],
  tags: ['q3'],
  title: 'Budget review',
  passages: [{ text: 'The budget grows by ten percent.', metadata: { firstSeq: 1 } }, { text: 'The weather was mentioned once.', metadata: { firstSeq: 9 } }],
  ...over,
});

describe('LibraryIndex over a vector store', () => {
  let store: InMemoryVectorStore;
  let index: LibraryIndex;

  beforeEach(async () => {
    embed.mockClear();
    store = new InMemoryVectorStore();
    await store.initialize({ id: 'mem', type: 'in_memory' });
    await store.createCollection('library', 4);
    index = new LibraryIndex({ store, collection: 'library', embed, batchSize: 1 });
  });

  it('indexes a source and finds its passages for a principal in its groups', async () => {
    expect(await index.indexSource(source({}))).toEqual({ passages: 2 });
    expect(embed).toHaveBeenCalledTimes(2);
    const found = await index.search({ text: 'budget', mode: 'dense', topK: 1, scope: { tenantId: 'org1', aclGroups: ['acct:ann', 'org:org1'] } });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: 'session:s1#0', sourceId: 'session:s1', kind: 'session', index: 0, text: 'The budget grows by ten percent.', title: 'Budget review', tags: ['q3'] });
    expect(found[0].metadata.firstSeq).toBe(1);
  });

  it('shows nothing to another tenant or to a principal outside the groups', async () => {
    await index.indexSource(source({}));
    expect(await index.search({ text: 'budget', mode: 'dense', scope: { tenantId: 'org2', aclGroups: ['acct:ann'] } })).toEqual([]);
    expect(await index.search({ text: 'budget', mode: 'dense', scope: { tenantId: 'org1', aclGroups: ['acct:bob', 'org:org1'] } })).toEqual([]);
  });

  it('refuses a search with no tenant or no group', async () => {
    await expect(index.search({ text: 'budget', scope: { tenantId: '', aclGroups: ['acct:ann'] } })).rejects.toThrow('a tenant and at least one access group');
    await expect(index.search({ text: 'budget', scope: { tenantId: 'org1', aclGroups: [] } })).rejects.toThrow('a tenant and at least one access group');
  });

  it('replaces a source whole when it is indexed again', async () => {
    await index.indexSource(source({}));
    await index.indexSource(source({ passages: [{ text: 'Hiring opens in May.' }] }));
    const scope = { tenantId: 'org1', aclGroups: ['acct:ann'] };
    expect((await index.search({ text: 'budget weather hiring', mode: 'dense', topK: 10, scope })).map((passage) => passage.text)).toEqual(['Hiring opens in May.']);
  });

  it('takes a passage\'s folder and title from its source alone', async () => {
    await index.indexSource(
      source({
        folderId: null,
        title: undefined,
        metadata: { folderId: 'f-old', title: 'Old title', team: 'ops' },
        passages: [{ text: 'The budget grows.', metadata: { folderId: 'f-older', firstSeq: 1 } }],
      }),
    );
    const scope = { tenantId: 'org1', aclGroups: ['acct:ann'] };
    expect(await index.search({ text: 'budget', mode: 'dense', scope, folderId: 'f-old' })).toEqual([]);
    expect(await index.search({ text: 'budget', mode: 'dense', scope, folderId: 'f-older' })).toEqual([]);
    const [passage] = await index.search({ text: 'budget', mode: 'dense', scope });
    expect(passage.id).toBe('session:s1#0');
    expect(passage.folderId).toBeUndefined();
    expect(passage.title).toBeUndefined();
    expect('folderId' in passage.metadata || 'title' in passage.metadata).toBe(false);
    expect(passage.metadata).toMatchObject({ team: 'ops', firstSeq: 1 });
  });

  it('throws when the store reports a failed write instead of throwing', async () => {
    const wrongSize = new LibraryIndex({ store, collection: 'library', embed: async (texts) => texts.map(() => [1, 0]) });
    await expect(wrongSize.indexSource(source({}))).rejects.toThrow('failed to write the passages of session:s1');
  });

  it('removes a source and a tenant', async () => {
    await index.indexSource(source({}));
    await index.indexSource(source({ sourceId: 'document:d1', kind: 'document' }));
    await index.indexSource(source({ sourceId: 'session:s9', tenantId: 'org2' }));
    expect(await index.removeSource('session:s1')).toBe(2);
    expect(await index.removeTenant('org1')).toBe(2);
    expect(await index.search({ text: 'budget', mode: 'dense', scope: { tenantId: 'org2', aclGroups: ['acct:ann'] } })).toHaveLength(2);
  });

  it('narrows by kind, folder, tags and source', async () => {
    await index.indexSource(source({ folderId: 'f1' }));
    await index.indexSource(source({ sourceId: 'document:d1', kind: 'document', tags: ['q3', 'plan'] }));
    const scope = { tenantId: 'org1', aclGroups: ['acct:ann'] };
    const ask = (extra: object) => index.search({ text: 'budget', mode: 'dense', topK: 10, scope, ...extra });
    const ids = async (extra: object) => (await ask(extra)).map((passage) => passage.id).sort();
    const sessionPassages = ['session:s1#0', 'session:s1#1'];
    const documentPassages = ['document:d1#0', 'document:d1#1'];
    expect(await ids({})).toEqual([...documentPassages, ...sessionPassages]);
    expect(await ids({ kinds: ['document'] })).toEqual(documentPassages);
    expect(await ids({ folderId: 'f1' })).toEqual(sessionPassages);
    expect(await ids({ tags: ['q3', 'plan'] })).toEqual(documentPassages);
    expect(await ids({ tags: ['q3'] })).toEqual([...documentPassages, ...sessionPassages]);
    expect(await ids({ sourceIds: ['session:s1'] })).toEqual(sessionPassages);
    expect(await ask({ sourceIds: ['session:none'] })).toEqual([]);
  });

  it('narrows to any of several folders, and finds nothing for an empty list or a folder outside the list', async () => {
    await index.indexSource(source({ sourceId: 'document:a', kind: 'document', folderId: 'a' }));
    await index.indexSource(source({ sourceId: 'document:b', kind: 'document', folderId: 'b' }));
    await index.indexSource(source({ sourceId: 'document:none', kind: 'document' }));
    const scope = { tenantId: 'org1', aclGroups: ['acct:ann'] };
    const sources = async (narrowing: Pick<LibrarySearch, 'folderId' | 'folderIds'>) =>
      [...new Set((await index.search({ text: 'budget', mode: 'dense', topK: 10, scope, ...narrowing })).map((passage) => passage.sourceId))].sort();
    expect(await sources({ folderIds: ['a', 'b'] })).toEqual(['document:a', 'document:b']);
    expect(await sources({ folderId: 'a', folderIds: ['a', 'b'] })).toEqual(['document:a']);
    embed.mockClear();
    // An empty choice is an empty answer, not every folder; with both options, both apply.
    expect(await sources({ folderIds: [] })).toEqual([]);
    expect(await sources({ folderId: 'a', folderIds: ['b'] })).toEqual([]);
    expect(embed).not.toHaveBeenCalled();
  });

  it('finds what any of several narrowings finds, and nothing for an empty list, without embedding', async () => {
    await index.indexSource(source({ sourceId: 'document:a1', kind: 'document', folderId: 'a' }));
    await index.indexSource(source({ sourceId: 'document:c', kind: 'document' }));
    await index.indexSource(source({ sourceId: 'session:s1', kind: 'session' }));
    const scope = { tenantId: 'org1', aclGroups: ['acct:ann'] };
    const sources = async (anyOf: NonNullable<LibrarySearch['anyOf']>) =>
      [...new Set((await index.search({ text: 'budget', topK: 10, scope, anyOf })).map((passage) => passage.sourceId))].sort();
    const documents = [{ kinds: ['document'], folderIds: ['a'] }, { kinds: ['document'], sourceIds: ['document:c'] }];
    expect(await sources(documents)).toEqual(['document:a1', 'document:c']);
    expect(await sources([...documents, { kinds: ['session'] }])).toEqual(['document:a1', 'document:c', 'session:s1']);
    embed.mockClear();
    expect(await sources([])).toEqual([]);
    expect(await sources([{ folderIds: [] }, { sourceIds: [] }])).toEqual([]);
    expect(embed).not.toHaveBeenCalled();
  });

  it('embeds the text once for every branch, answers a passage once, and cuts the answer to topK, best first', async () => {
    await index.indexSource(source({ sourceId: 'document:a1', kind: 'document', folderId: 'a', passages: [{ text: 'The budget grows.' }, { text: 'The weather turns.' }] }));
    await index.indexSource(source({ sourceId: 'document:c', kind: 'document', passages: [{ text: 'Hiring opens in May.' }] }));
    await index.indexSource(source({ sourceId: 'session:s1', kind: 'session', passages: [{ text: 'The budget and the weather.' }] }));
    // No branch names this session, though it is as near the text as the best passage: a search that ignored the
    // branches would answer it.
    await index.indexSource(source({ sourceId: 'session:s2', kind: 'session', passages: [{ text: 'The budget again.' }] }));
    const scope = { tenantId: 'org1', aclGroups: ['acct:ann'] };
    // The folder's first passage is found by the first two branches.
    const anyOf = [{ folderIds: ['a'] }, { kinds: ['document'] }, { sourceIds: ['session:s1'] }];
    embed.mockClear();
    const all = await index.search({ text: 'budget', mode: 'dense', topK: 10, scope, anyOf });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(all.map((passage) => passage.id)).toEqual(['document:a1#0', 'session:s1#0', 'document:a1#1', 'document:c#0']);
    const best = await index.search({ text: 'budget', mode: 'dense', topK: 2, scope, anyOf });
    expect(best.map((passage) => passage.id)).toEqual(['document:a1#0', 'session:s1#0']);
    expect(best[0].score).toBeGreaterThan(best[1].score);
    // The in-memory store has no lexicalSearch, so a hybrid choice runs the dense leg alone and keeps the store's scores.
    expect(await index.search({ text: 'budget', mode: 'hybrid', topK: 10, scope, anyOf })).toEqual(all);
  });

  it('applies the scope to every branch', async () => {
    await index.indexSource(source({ sourceId: 'document:mine', kind: 'document', folderId: 'a' }));
    await index.indexSource(source({ sourceId: 'document:theirs', kind: 'document', tenantId: 'org2', folderId: 'a' }));
    await index.indexSource(source({ sourceId: 'document:bobs', kind: 'document', aclGroups: ['acct:bob'], folderId: 'a' }));
    const scope = { tenantId: 'org1', aclGroups: ['acct:ann'] };
    const sources = async (anyOf: NonNullable<LibrarySearch['anyOf']>) =>
      [...new Set((await index.search({ text: 'budget', topK: 10, scope, anyOf })).map((passage) => passage.sourceId))].sort();
    expect(await sources([{ sourceIds: ['document:theirs'] }, { sourceIds: ['document:bobs'] }])).toEqual([]);
    expect(await sources([{ sourceIds: ['document:theirs', 'document:bobs'] }, { folderIds: ['a'] }])).toEqual(['document:mine']);
    embed.mockClear();
    await expect(index.search({ text: 'budget', scope: { tenantId: 'org1', aclGroups: [] }, anyOf: [] })).rejects.toThrow('a tenant and at least one access group');
    await expect(index.search({ text: 'budget', scope: { tenantId: '', aclGroups: ['acct:ann'] }, anyOf: [{ folderIds: ['a'] }] })).rejects.toThrow('a tenant and at least one access group');
    expect(embed).not.toHaveBeenCalled();
  });

  it('ranks several narrowings as one search: a narrow branch\'s weak passage never outranks a wide branch\'s stronger ones', async () => {
    // A store with both legs that answers each branch by the filter it is given: the folder's three passages, and one
    // document's single passage, which is first of its own branch in both legs. Fused branch by branch, the two firsts
    // would tie.
    const held: Record<string, MetadataValue> = { tenantId: 'org1', aclGroups: ['acct:ann'], status: 'active', kind: 'document', tags: [] };
    const folder = [
      { dense: 0.9, lexical: 0.5 },
      { dense: 0.8, lexical: 0.4 },
      { dense: 0.7, lexical: 0.3 },
    ];
    const asks = (condition: MetadataFilter[string] | undefined, value: string): boolean =>
      typeof condition === 'object' && (condition.$in ?? []).includes(value);
    const answer = (leg: 'dense' | 'lexical', options?: QueryOptions): QueryResult => {
      const filter: MetadataFilter = options?.filter ?? {};
      const passages: Array<{ id: string; score: number; metadata: Record<string, MetadataValue> }> = asks(filter.folderId, 'a')
        ? folder.map((scores, at) => ({ id: `document:f#${at}`, score: scores[leg], metadata: { ...held, sourceId: 'document:f', index: at, folderId: 'a' } }))
        : asks(filter.sourceId, 'document:c')
          ? [{ id: 'document:c#0', score: leg === 'dense' ? 0.1 : 0.01, metadata: { ...held, sourceId: 'document:c', index: 0 } }]
          : [];
      return {
        documents: passages
          .slice(0, options?.topK ?? 10)
          .map(({ id, score, metadata }) => ({ id, similarityScore: score, embedding: [], textContent: id, metadata })),
      };
    };
    const recording = {
      query: vi.fn(async (_collection: string, _vector: number[], options?: QueryOptions) => answer('dense', options)),
      lexicalSearch: vi.fn(async (_collection: string, _text: string, options?: QueryOptions) => answer('lexical', options)),
      hybridSearch: vi.fn(async () => answer('dense')),
    };
    const ranking = new LibraryIndex({ store: recording as unknown as IVectorStore, collection: 'library', embed });
    const scope = { tenantId: 'org1', aclGroups: ['acct:ann'] };
    const choice = [{ folderIds: ['a'] }, { sourceIds: ['document:c'] }];
    embed.mockClear();
    const found = await ranking.search({ text: 'budget', scope, mode: 'hybrid', topK: 3, anyOf: choice });
    expect(found.map((passage) => passage.id)).toEqual(['document:f#0', 'document:f#1', 'document:f#2']);
    expect(found[0].score).toBeCloseTo(2 / 61, 12);
    expect(found[0].score).toBeGreaterThan(found[1].score);
    expect(found[1].score).toBeGreaterThan(found[2].score);
    expect(recording.hybridSearch).not.toHaveBeenCalled();
    expect(recording.query.mock.calls.map(([, , options]) => options?.topK)).toEqual([9, 9]);
    expect(recording.lexicalSearch.mock.calls.map(([, , options]) => options?.topK)).toEqual([9, 9]);
    expect(embed).toHaveBeenCalledTimes(1);

    // The same choice, dense, over the in-memory store, where the document's passage is far from the text.
    await index.indexSource(
      source({
        sourceId: 'document:f',
        kind: 'document',
        folderId: 'a',
        passages: [{ text: 'The budget grows.' }, { text: 'The budget and the weather.' }, { text: 'The budget, the weather and hiring.' }],
      }),
    );
    await index.indexSource(source({ sourceId: 'document:c', kind: 'document', passages: [{ text: 'Hiring opens in May.' }] }));
    const dense = await index.search({ text: 'budget', scope, mode: 'dense', topK: 3, anyOf: choice });
    expect(dense.map((passage) => passage.id)).toEqual(['document:f#0', 'document:f#1', 'document:f#2']);
  });
});

describe('LibraryIndex and the store\'s optional legs', () => {
  const answer = {
    documents: [
      {
        id: 'session:s1#0',
        similarityScore: 0.5,
        embedding: [],
        textContent: 'chapters',
        metadata: { tenantId: 'org1', aclGroups: ['acct:ann'], status: 'active', sourceId: 'session:s1', kind: 'session', index: 0, tags: ['q3'] },
      },
    ],
  };
  const recording = {
    lexicalSearch: vi.fn(async () => answer),
    hybridSearch: vi.fn(async () => answer),
    query: vi.fn(async () => answer),
    updateMetadata: vi.fn(async () => ({ updatedCount: 3 })),
    delete: vi.fn(async () => ({ deletedCount: 0 })),
    upsert: vi.fn(async () => ({ upsertedCount: 0, upsertedIds: [], failedCount: 0 })),
  };
  const index = new LibraryIndex({ store: recording as unknown as IVectorStore, collection: 'library', embed });
  const scope = { tenantId: 'org1', aclGroups: ['acct:ann', 'folder:f1'] };

  it('searches the lexical leg with the scope as the store filter, and embeds nothing', async () => {
    embed.mockClear();
    const found = await index.search({ text: 'chapter', scope, mode: 'lexical', match: 'all', prefix: true, topK: 5, kinds: ['session'], tags: ['q3'] });
    expect(embed).not.toHaveBeenCalled();
    expect(recording.lexicalSearch).toHaveBeenCalledWith('library', 'chapter', {
      topK: 5,
      match: 'all',
      prefix: true,
      includeMetadata: true,
      includeTextContent: true,
      filter: { tenantId: { $eq: 'org1' }, aclGroups: { $in: ['acct:ann', 'folder:f1'] }, status: { $in: ['active'] }, kind: { $in: ['session'] }, tags: { $all: ['q3'] } },
    });
    expect(found[0].text).toBe('chapters');
  });

  it('fuses the two legs for a hybrid search, with one embedding', async () => {
    embed.mockClear();
    await index.search({ text: 'what did we decide', scope, mode: 'hybrid', topK: 8 });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(recording.hybridSearch).toHaveBeenCalledWith('library', expect.any(Array), 'what did we decide', expect.objectContaining({ topK: 8, match: 'any', prefix: false, filter: expect.objectContaining({ tenantId: { $eq: 'org1' } }) }));
  });

  it('finds nothing for an empty source list without asking the store', async () => {
    embed.mockClear();
    recording.hybridSearch.mockClear();
    recording.lexicalSearch.mockClear();
    expect(await index.search({ text: 'budget', scope, sourceIds: [] })).toEqual([]);
    expect(await index.search({ text: 'budget', scope, mode: 'lexical', sourceIds: [] })).toEqual([]);
    expect(embed).not.toHaveBeenCalled();
    expect(recording.hybridSearch).not.toHaveBeenCalled();
    expect(recording.lexicalSearch).not.toHaveBeenCalled();
  });

  it('changes who may see a source, its folder and its tags in the store', async () => {
    expect(await index.setSourceScope('session:s1', { aclGroups: ['acct:ann'], folderId: null, tags: ['done'] })).toBe(3);
    expect(recording.updateMetadata).toHaveBeenCalledWith('library', { sourceId: 'session:s1' }, { aclGroups: ['acct:ann'], folderId: null, tags: ['done'] });
  });

  it('throws when the store reports a failed delete, before writing a source again', async () => {
    const upsert = vi.fn(async () => ({ upsertedCount: 1 }));
    const failing = new LibraryIndex({
      store: { delete: vi.fn(async () => ({ deletedCount: 0, failedCount: 1, errors: [{ message: 'timed out' }] })), upsert } as unknown as IVectorStore,
      collection: 'library',
      embed,
    });
    await expect(failing.removeSource('session:s1')).rejects.toThrow('timed out');
    await expect(failing.removeTenant('org1')).rejects.toThrow('failed to delete the passages of tenant org1');
    await expect(failing.indexSource(source({}))).rejects.toThrow('failed to delete the passages of session:s1');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('says so when the store has no lexical leg', async () => {
    const bare = new LibraryIndex({ store: { query: recording.query } as unknown as IVectorStore, collection: 'library', embed });
    await expect(bare.search({ text: 'x', scope, mode: 'lexical' })).rejects.toThrow('no lexicalSearch');
  });
});

describe('LibraryIndex over a store whose filter falls short', () => {
  const kept: Record<string, MetadataValue> = { tenantId: 'org1', aclGroups: ['acct:ann'], status: 'active', sourceId: 'session:s1', kind: 'session', folderId: 'f1', tags: ['q3', 'plan'], index: 0 };
  const passage = (id: string, change: Record<string, MetadataValue>) => ({ id, similarityScore: 0.5, embedding: [], textContent: id, metadata: { ...kept, ...change } });
  // The same passages whatever the filter, as a store answers when its filter drops a condition, or when a leg of its
  // search applies no filter at all.
  const answer = {
    documents: [
      passage('kept', {}),
      passage('another tenant', { tenantId: 'org2' }),
      passage('another group', { aclGroups: ['acct:bob'] }),
      passage('not active', { status: 'deleted' }),
      passage('another kind', { kind: 'document' }),
      passage('another folder', { folderId: 'f2' }),
      passage('one tag short', { tags: ['q3'] }),
      passage('another source', { sourceId: 'session:s2' }),
    ],
  };
  const unfiltered = { lexicalSearch: vi.fn(async () => answer), hybridSearch: vi.fn(async () => answer), query: vi.fn(async () => answer) };
  const index = new LibraryIndex({ store: unfiltered as unknown as IVectorStore, collection: 'library', embed });
  const scope = { tenantId: 'org1', aclGroups: ['acct:ann', 'org:org1'] };

  it('answers only the passages the scope and the narrowing allow, in every mode', async () => {
    for (const mode of ['lexical', 'hybrid', 'dense'] as const) {
      const ids = async (extra: object) => (await index.search({ text: 'budget', scope, mode, ...extra })).map((found) => found.id);
      expect(await ids({})).toEqual(['kept', 'another kind', 'another folder', 'one tag short', 'another source']);
      expect(await ids({ kinds: ['session'] })).toEqual(['kept', 'another folder', 'one tag short', 'another source']);
      expect(await ids({ tags: ['q3', 'plan'] })).toEqual(['kept', 'another kind', 'another folder', 'another source']);
      expect(await ids({ kinds: ['session'], folderId: 'f1', tags: ['q3', 'plan'], sourceIds: ['session:s1'] })).toEqual(['kept']);
      expect(await ids({ folderIds: ['f1', 'f9'] })).toEqual(['kept', 'another kind', 'one tag short', 'another source']);
      expect(await ids({ anyOf: [{ folderIds: ['f2'] }, { sourceIds: ['session:s2'] }] })).toEqual(['another folder', 'another source']);
    }
  });
});
