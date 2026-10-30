import { describe, expect, it, vi } from 'vitest';

import type { IVectorStore } from '../../../core/vector-store/IVectorStore.js';
import { InMemoryVectorStore } from '../../rag/vector_stores/InMemoryVectorStore.js';
import { LibraryIndex } from '../LibraryIndex.js';

/** Who asks: the tenant and the group of the one source `makeStore` indexes. */
const SCOPE = { tenantId: 'org1', aclGroups: ['acct:ann'] };

/** An in-memory store whose collection `c`, its vectors three wide, holds one kept session's passage. */
async function makeStore(): Promise<InMemoryVectorStore> {
  const store = new InMemoryVectorStore();
  await store.initialize({ id: 'mem', type: 'in_memory' });
  await store.createCollection('c', 3);
  const writer = new LibraryIndex({ store, collection: 'c', embed: async (texts) => texts.map(() => [1, 0, 0]) });
  await writer.indexSource({
    sourceId: 'session:s1',
    kind: 'session',
    tenantId: SCOPE.tenantId,
    aclGroups: SCOPE.aclGroups,
    tags: ['q3'],
    passages: [{ text: 'The budget grows by ten percent.' }],
  });
  return store;
}

/** An embedding function that records the texts and the options it is handed. */
const recordingEmbed = () => vi.fn(async (texts: string[], _options?: { signal?: AbortSignal }) => texts.map(() => [1, 0, 0]));

describe('LibraryIndex.search with a signal', () => {
  it('sends no embedding when the signal aborted before the search, and rejects with its reason', async () => {
    const store = await makeStore();
    const query = vi.spyOn(store, 'query');
    const embed = recordingEmbed();
    const index = new LibraryIndex({ store, collection: 'c', embed });
    const controller = new AbortController();
    controller.abort(new Error('closed'));
    await expect(index.search({ text: 'budget', scope: SCOPE, mode: 'dense', signal: controller.signal })).rejects.toThrow('closed');
    expect(embed).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('hands the signal to the embedding function, so a request in flight is cancelled with the search', async () => {
    const embed = recordingEmbed();
    const index = new LibraryIndex({ store: await makeStore(), collection: 'c', embed });
    const controller = new AbortController();
    const found = await index.search({ text: 'budget', scope: SCOPE, mode: 'dense', signal: controller.signal });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed).toHaveBeenCalledWith(['budget'], { signal: controller.signal });
    expect(found.map((passage) => passage.id)).toEqual(['session:s1#0']);
  });

  it('hands the signal to the one embedding of a search of several narrowings, and sends none once it aborted', async () => {
    const embed = recordingEmbed();
    const index = new LibraryIndex({ store: await makeStore(), collection: 'c', embed });
    const anyOf = [{ kinds: ['session'] }, { tags: ['q3'] }];
    const open = new AbortController();
    const found = await index.search({ text: 'budget', scope: SCOPE, mode: 'dense', anyOf, signal: open.signal });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed).toHaveBeenCalledWith(['budget'], { signal: open.signal });
    expect(found.map((passage) => passage.id)).toEqual(['session:s1#0']);

    embed.mockClear();
    const closed = new AbortController();
    closed.abort(new Error('a newer question'));
    await expect(index.search({ text: 'budget', scope: SCOPE, mode: 'dense', anyOf, signal: closed.signal })).rejects.toThrow('a newer question');
    expect(embed).not.toHaveBeenCalled();
  });

  it('asks the store nothing for a lexical search whose signal aborted before it started', async () => {
    const lexicalSearch = vi.fn(async () => ({ documents: [] }));
    const store = { lexicalSearch, query: vi.fn(async () => ({ documents: [] })) } as unknown as IVectorStore;
    const embed = recordingEmbed();
    const index = new LibraryIndex({ store, collection: 'c', embed });
    const controller = new AbortController();
    controller.abort(new Error('closed'));
    await expect(index.search({ text: 'budget', scope: SCOPE, mode: 'lexical', signal: controller.signal })).rejects.toThrow('closed');
    expect(lexicalSearch).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
  });
});
