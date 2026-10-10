import { describe, expect, it } from 'vitest';

import { lexicalTokens } from '../../library/tokens.js';
import { BM25Index } from '../search/BM25Index.js';
import { LexicalIndex } from '../search/LexicalIndex.js';

const DOCUMENTS: Array<{ id: string; text: string; metadata?: Record<string, unknown> }> = [
  { id: 's1#0', text: 'The chapters on the budget review', metadata: { session: 's1', seq: 1 } },
  { id: 's1#1', text: 'Budget numbers for the third quarter' },
  { id: 's2#0', text: 'A walk and the weather' },
];

const filled = (): LexicalIndex => {
  const index = new LexicalIndex({ tokenize: lexicalTokens });
  index.addDocuments(DOCUMENTS);
  return index;
};

describe('LexicalIndex', () => {
  it('finds any word, ranked, as BM25Index does', () => {
    const found = filled().search('budget weather', 10);
    expect(found.map((hit) => hit.id).sort()).toEqual(['s1#0', 's1#1', 's2#0']);
    expect(found[0].score).toBeGreaterThan(0);
    const bm25 = new BM25Index({ tokenize: lexicalTokens });
    bm25.addDocuments(DOCUMENTS);
    expect(found).toEqual(bm25.search('budget weather', 10));
  });

  it('asks for every word when told to', () => {
    expect(filled().search('budget review', 10, { match: 'all' }).map((hit) => hit.id)).toEqual(['s1#0']);
    expect(filled().search('budget weather', 10, { match: 'all' })).toEqual([]);
  });

  it('matches a stored word that begins with a query word', () => {
    const index = filled();
    expect(index.search('chapter', 10)).toEqual([]);
    expect(index.search('chapter', 10, { prefix: true }).map((hit) => hit.id)).toEqual(['s1#0']);
    expect(index.search('chap budg', 10, { prefix: true, match: 'all' }).map((hit) => hit.id)).toEqual(['s1#0']);
    expect(index.search('chap', 10, { prefix: true })[0].metadata).toEqual({ session: 's1', seq: 1 });
  });

  it('is saved and restored with the same answers', () => {
    const index = filled();
    const copy = LexicalIndex.fromJSON(JSON.parse(JSON.stringify(index.toJSON())), { tokenize: lexicalTokens });
    expect(copy.search('budget', 10)).toEqual(index.search('budget', 10));
    expect(copy.getStats()).toEqual(index.getStats());
    copy.removeDocument('s1#0');
    expect(copy.search('chapters', 10)).toEqual([]);
    expect(index.search('chapters', 10)).toHaveLength(1);
  });

  it('refuses a saved index of another version', () => {
    expect(() => LexicalIndex.fromJSON({ v: 2 } as never, { tokenize: lexicalTokens })).toThrow('version');
  });

  it('refuses a saved index that toJSON could not have written, naming what is wrong', () => {
    const restore = (saved: object) => () => LexicalIndex.fromJSON(saved as never, { tokenize: lexicalTokens });
    const refused = (problem: string) => `LexicalIndex: a saved index whose ${problem}.`;
    const tuning = { v: 1, k1: 1.2, b: 0.75 };
    expect(restore({ ...tuning, terms: [] })).toThrow(refused('documents are not an array'));
    expect(restore({ ...tuning, k1: Number.NaN, documents: [], terms: [] })).toThrow(refused('k1 or b is not a finite number'));
    expect(restore({ ...tuning, documents: [['a', -1]], terms: [] })).toThrow(
      refused('documents[0] is not [id, length] or [id, length, metadata]'),
    );
    expect(restore({ ...tuning, documents: [['a', 1], ['a', 2]], terms: [] })).toThrow(
      refused('documents[1] repeats the id of an earlier document'),
    );
    const one = { ...tuning, documents: [['a', 2]] };
    const badPosting = refused('terms[0] holds a posting that is not [position of a document, count of 1 or more]');
    expect(restore({ ...one, terms: [['word', [[1, 1]]]] })).toThrow(badPosting);
    expect(restore({ ...one, terms: [['word', [[0, 0]]]] })).toThrow(badPosting);
    expect(restore({ ...one, terms: [['word', [[0, 1], [0, 1]]]] })).toThrow(refused('terms[0] holds the position 0 twice'));
    expect(restore({ ...one, terms: [['word', [[0, 1]]], ['word', [[0, 1]]]] })).toThrow(refused('terms[1] repeats an earlier term'));
  });

  it('replaces a document added again, and forgets a removed one', () => {
    const index = filled();
    index.addDocument('s2#0', 'Only hiring now');
    expect(index.search('weather', 10)).toEqual([]);
    expect(index.search('hiring', 10).map((hit) => hit.id)).toEqual(['s2#0']);
    expect(index.removeDocument('s2#0')).toBe(true);
    expect(index.getStats().documentCount).toBe(2);
  });
});

describe('BM25Index on LexicalIndex', () => {
  const ERRORS = [
    { id: 'a', text: 'TypeScript compiler error TS2304' },
    { id: 'b', text: 'Fix error TS2304 by adding type declarations' },
    { id: 'c', text: 'The x factor' },
  ];

  it('keeps its own tokenizer, its error words and its scores', () => {
    const index = new BM25Index();
    index.addDocuments(ERRORS);
    expect(index.search('the error', 5).map((hit) => hit.id).sort()).toEqual(['a', 'b']);
    // Its tokenizer drops a stop word and a word of one letter, both of which lexicalTokens keeps.
    expect(index.search('the', 5)).toEqual([]);
    expect(index.search('x', 5)).toEqual([]);
    expect(index.search('factor', 5).map((hit) => hit.id)).toEqual(['c']);
    expect(() => index.addDocument('', 'x')).toThrow('BM25Index.addDocument: id must not be empty.');
    const copy = BM25Index.fromJSON(index.toJSON());
    expect(copy).toBeInstanceOf(BM25Index);
    expect(copy.search('TS2304', 5)).toEqual(index.search('TS2304', 5));
    // A saved k1 and b come back with the index: these two score the same documents otherwise than the defaults.
    const tuned = new BM25Index({ k1: 2, b: 0.3 });
    tuned.addDocuments(ERRORS);
    expect(tuned.search('TS2304', 5)).not.toEqual(index.search('TS2304', 5));
    const restored = BM25Index.fromJSON(JSON.parse(JSON.stringify(tuned.toJSON())));
    expect(restored.search('TS2304', 5)).toEqual(tuned.search('TS2304', 5));
  });

  it('takes a tokenizer in place of its own', () => {
    const index = new BM25Index({ tokenize: lexicalTokens });
    index.addDocument('a', 'the of and');
    expect(index.search('the', 5).map((hit) => hit.id)).toEqual(['a']);
  });
});
