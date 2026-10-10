import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IVectorStore } from '../../../core/vector-store/IVectorStore.js';
import { InMemoryVectorStore } from '../../rag/vector_stores/InMemoryVectorStore.js';
import { LibraryIndex, type LibrarySource } from '../LibraryIndex.js';

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
    expect((await ask({ kinds: ['document'] })).every((passage) => passage.kind === 'document')).toBe(true);
    expect((await ask({ folderId: 'f1' })).every((passage) => passage.sourceId === 'session:s1')).toBe(true);
    expect((await ask({ tags: ['q3', 'plan'] })).every((passage) => passage.sourceId === 'document:d1')).toBe(true);
    expect(await ask({ sourceIds: ['session:none'] })).toEqual([]);
  });
});

describe('LibraryIndex and the store\'s optional legs', () => {
  const answer = { documents: [{ id: 'session:s1#0', similarityScore: 0.5, embedding: [], textContent: 'chapters', metadata: { sourceId: 'session:s1', kind: 'session', index: 0, tags: [] } }] };
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

  it('changes who may see a source, its folder and its tags in the store', async () => {
    expect(await index.setSourceScope('session:s1', { aclGroups: ['acct:ann'], folderId: null, tags: ['done'] })).toBe(3);
    expect(recording.updateMetadata).toHaveBeenCalledWith('library', { sourceId: 'session:s1' }, { aclGroups: ['acct:ann'], folderId: null, tags: ['done'] });
  });

  it('says so when the store has no lexical leg', async () => {
    const bare = new LibraryIndex({ store: { query: recording.query } as unknown as IVectorStore, collection: 'library', embed });
    await expect(bare.search({ text: 'x', scope, mode: 'lexical' })).rejects.toThrow('no lexicalSearch');
  });
});
