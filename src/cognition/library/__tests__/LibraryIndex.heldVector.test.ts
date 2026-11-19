/**
 * @fileoverview A search given the vector of its text, which the caller made already (for example to hold a cost
 * reservation for it): what reaches the embedder, what the search answers, and the vectors it refuses.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { InMemoryVectorStore } from '../../rag/vector_stores/InMemoryVectorStore.js';
import { LibraryIndex, type LibrarySource } from '../LibraryIndex.js';

/** A vector of a text: the same text, the same vector. */
function vectorOf(text: string): number[] {
  let hash = 7;
  for (const char of text) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return [1, (hash % 97) / 97, (hash % 89) / 89, (hash % 83) / 83];
}

const SCOPE = { tenantId: 'org1', aclGroups: ['acct:ann'] };

const source = (sourceId: string, kind: string, texts: string[]): LibrarySource => ({
  sourceId,
  kind,
  tenantId: 'org1',
  aclGroups: ['acct:ann'],
  passages: texts.map((text) => ({ text })),
});

describe('LibraryIndex search with a vector the caller holds', () => {
  let sent: string[];
  let library: LibraryIndex;

  beforeEach(async () => {
    const store = new InMemoryVectorStore();
    await store.initialize({ id: 'mem', type: 'in_memory' });
    await store.createCollection('library', 4);
    sent = [];
    library = new LibraryIndex({
      store,
      collection: 'library',
      dimensions: 4,
      embed: async (texts: string[]) => {
        sent.push(...texts);
        return texts.map(vectorOf);
      },
    });
    await library.indexSource(source('document:d1', 'document', ['The budget doubled in March.', 'The plan moved to June.']));
    await library.indexSource(source('note:n1', 'note', ['Ask about the budget again.']));
    sent.length = 0;
  });

  it('sends the embedder nothing for a dense or hybrid search given its vector, and answers what the embedded search answers', async () => {
    const text = 'budget';
    for (const mode of ['dense', 'hybrid'] as const) {
      const embedded = await library.search({ text, scope: SCOPE, mode, topK: 3 });
      expect(sent).toEqual([text]);
      sent.length = 0;
      const held = await library.search({ text, scope: SCOPE, mode, topK: 3, vector: vectorOf(text) });
      expect(sent).toEqual([]);
      expect(held).toEqual(embedded);
    }
    // With several narrowings the one vector serves every branch.
    const anyOf = [{ kinds: ['document'] }, { kinds: ['note'] }];
    const embedded = await library.search({ text, scope: SCOPE, mode: 'dense', topK: 3, anyOf });
    expect(sent).toEqual([text]);
    sent.length = 0;
    const held = await library.search({ text, scope: SCOPE, mode: 'dense', topK: 3, anyOf, vector: vectorOf(text) });
    expect(sent).toEqual([]);
    expect(held).toEqual(embedded);
  });

  it('refuses, before any call, a vector of another size than the index, an empty one, or one holding a value that is not a finite number', async () => {
    // A sparse array of the right length: its missing places read as undefined.
    const sparse: number[] = new Array(4);
    sparse[0] = 1;
    for (const vector of [[1, 0, 0], [], [1, Number.NaN, 0, 0], [1, Number.POSITIVE_INFINITY, 0, 0], sparse]) {
      await expect(library.search({ text: 'budget', scope: SCOPE, mode: 'dense', vector })).rejects.toThrow('vector');
    }
    expect(sent).toEqual([]);
  });
});
