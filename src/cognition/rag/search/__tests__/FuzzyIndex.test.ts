import { describe, expect, it } from 'vitest';

import { FuzzyIndex, type FuzzyDocument, type FuzzyIndexConfig, type FuzzyTokenizer, type Marked } from '../FuzzyIndex.js';

/** The words a marked text marks, in order. */
const words = (value: Marked): string[] => value.marks.map((mark) => value.text.slice(mark.start, mark.end));

/** The ids of some hits, in order. */
const ids = (hits: Array<{ id: string }>): string[] => hits.map((hit) => hit.id);

const WEIGHTS = { title: 100, keywords: 10, body: 1 };

const note = (id: string, title: string, keywords: string[], body: string): FuzzyDocument => ({ id, fields: { title, keywords, body } });

const NOTES: FuzzyDocument[] = [
  note('n1', 'Quarterly numbers', ['revenue', 'quarter', 'growth'], 'Q3 revenue was 1.2M, up 18 percent. Churn 2.1 percent. The board asked for a churn plan by 15 Nov.'),
  note('n2', 'Enclosure samples', ['enclosure', 'factory'], 'The samples leave the factory on Friday; the moulds are confirmed on Wednesday.'),
  note('n3', 'Project Atlas status', ['atlas', 'launch', 'deadline'], 'Beta ships 3 Oct. Two open blockers: the billing webhook and load testing.'),
];

const VISITS = note(
  'v',
  'Factory visits',
  [],
  ['Monday is quiet.', 'The factory opens at nine. Lunch is at one.', 'Bring the factory badge. The factory gate is on the left.', 'Friday the factory closes early.'].join('\n'),
);

/** An index of the three notes, or of the documents given, with the weights above and any other settings given. */
const filled = (config: Partial<FuzzyIndexConfig> = {}, documents: FuzzyDocument[] = NOTES): FuzzyIndex => {
  const index = new FuzzyIndex({ fields: WEIGHTS, ...config });
  index.addDocuments(documents);
  return index;
};

describe('FuzzyIndex', () => {
  it('finds the same word, a word it begins, and a word one edit away of each kind, and misses one two edits away', () => {
    const index = filled();
    expect(ids(index.search('factory'))).toEqual(['n2']);
    expect(ids(index.search('FACT'))).toEqual(['n2']);
    // A letter added, dropped and changed, and two letters side by side swapped.
    for (const typo of ['friiday', 'frday', 'fridey', 'firday']) expect(ids(index.search(typo)), typo).toEqual(['n2']);
    // Two letters dropped, and a swap with a change.
    for (const miss of ['frdy', 'firdey']) expect(index.search(miss), miss).toEqual([]);
  });

  it('matches a word one edit away only where both words have editMinLength letters or more, four unless given', () => {
    // "the" has three letters, so neither "teh" (swapped) nor "thee" (a letter added) finds it.
    expect(filled().search('teh')).toEqual([]);
    expect(filled().search('thee')).toEqual([]);
    const three = filled({ editMinLength: 3 });
    expect(ids(three.search('teh'))).toEqual(['n1', 'n2', 'n3']);
    expect(ids(three.search('thee'))).toEqual(['n1', 'n2', 'n3']);
  });

  it('asks every query word to match somewhere in a document, or any word when told', () => {
    const index = filled();
    expect(ids(index.search('atlas billing'))).toEqual(['n3']);
    expect(index.search('factory churn')).toEqual([]);
    expect(ids(index.search('factory churn', { match: 'any' }))).toEqual(['n2', 'n1']);
  });

  it('ranks a title match over a keyword match over a body match, a tie in the order the documents were added', () => {
    const index = filled({}, [
      note('a', 'Weekly sync', ['team'], 'We talked about the launch plan.'),
      note('b', 'Weekly review', ['launch'], 'Numbers first.'),
      note('c', 'Launch checklist', [], 'Ship it.'),
      note('d', 'Another sync', ['team'], 'The launch moved.'),
    ]);
    const hits = index.search('launch');
    expect(ids(hits)).toEqual(['c', 'b', 'a', 'd']);
    expect(hits.map((hit) => hit.score)).toEqual([100, 10, 1, 1]);
  });

  it('ranks the same word over a word it begins over a word one edit away, within a field', () => {
    const index = filled({}, [note('one', 'One', [], 'A plain answer.'), note('two', 'Two', [], 'The planning starts.'), note('three', 'Three', [], 'The plan holds.')]);
    const hits = index.search('plan');
    expect(ids(hits)).toEqual(['three', 'two', 'one']);
    expect(hits.map((hit) => hit.score)).toEqual([1, 0.75, 0.5]);
  });

  it("scores a document by each query word's best match times the weight of its field, summed", () => {
    const index = filled({}, [note('p', 'Launch plan', ['launch'], 'The launch plan moved to May.')]);
    expect(index.search('launch plan')[0].score).toBe(200);
    // A word the query word begins, in the title (0.75 times 100), and a word with a letter changed, there too (0.5 times 100).
    expect(index.search('launc plam')[0].score).toBe(125);
  });

  it('keeps a tie in the order the documents were added, a document added again taking the last place', () => {
    const index = filled();
    expect(ids(index.search('the'))).toEqual(['n1', 'n2', 'n3']);
    index.addDocument(NOTES[0]);
    expect(ids(index.search('the'))).toEqual(['n2', 'n3', 'n1']);
  });

  it('marks whole words, in order, never overlapping, at UTF-16 offsets', () => {
    const index = filled();
    const [hit] = index.search('FACT');
    expect(words(hit.fields.title as Marked)).toEqual([]);
    expect((hit.fields.keywords as Marked[]).map(words)).toEqual([[], ['factory']]);
    expect((hit.fields.body as Marked).marks).toEqual([{ start: 22, end: 29 }]);
    // Two query words that match one word mark it once.
    expect((index.search('fact factory')[0].fields.body as Marked).marks).toEqual([{ start: 22, end: 29 }]);

    // An apostrophe inside a word keeps it one word, and a curly one is read as a straight one.
    const quoted = new FuzzyIndex({ fields: { title: 1 } });
    quoted.addDocument({ id: 'q', fields: { title: 'The Professor’s notes' } });
    const [professor] = quoted.search("professor's");
    expect(professor.score).toBe(1);
    expect(words(professor.fields.title as Marked)).toEqual(['Professor’s']);
    expect(words(quoted.search('professor')[0].fields.title as Marked)).toEqual(['Professor’s']);

    // An offset counts UTF-16 units: the emoji before the word is two of them.
    const emoji = new FuzzyIndex({ fields: { body: 1 } });
    emoji.addDocument({ id: 'e', fields: { body: '\u{1F600} factory' } });
    expect((emoji.search('factory')[0].fields.body as Marked).marks).toEqual([{ start: 3, end: 10 }]);
  });

  it("joins overlapping matches from a caller's tokenizer, so marks never overlap", () => {
    // Each word and each pair of neighbouring words, the pairs first and all of them in reverse.
    const pairs: FuzzyTokenizer = (text) => {
      const single = Array.from(text.matchAll(/\S+/g), (found) => ({ word: found[0], start: found.index ?? 0, end: (found.index ?? 0) + found[0].length }));
      const joined = single.slice(1).map((word, at) => ({ word: `${single[at].word}${word.word}`, start: single[at].start, end: word.end }));
      return [...joined, ...single].reverse();
    };
    const index = new FuzzyIndex({ fields: { body: 1 }, tokenize: pairs });
    index.addDocument({ id: 'p', fields: { body: 'red apple pie' } });
    // "apple" matches the word and, as a word it begins, the pair "applepie".
    expect((index.search('apple')[0].fields.body as Marked).marks).toEqual([{ start: 4, end: 13 }]);
  });

  it('shows at most three passages, the sentences or lines with the most query words, in the order of the text', () => {
    const index = filled({}, [VISITS]);
    expect(index.search('factory')[0].passages.map((passage) => passage.text)).toEqual([
      'The factory opens at nine.',
      'Bring the factory badge.',
      'The factory gate is on the left.',
    ]);
    // The sentence that holds both words is kept over an earlier one that holds one.
    const [both] = index.search('factory friday');
    expect(both.passages.map((passage) => passage.text)).toEqual(['The factory opens at nine.', 'Bring the factory badge.', 'Friday the factory closes early.']);
    expect(words(both.passages[2])).toEqual(['Friday', 'factory']);
  });

  it('ends a sentence at a full stop, a question mark or an exclamation mark before white space, and at a line break', () => {
    const index = filled();
    expect(index.search('churn')[0].passages.map((passage) => passage.text)).toEqual(['Churn 2.1 percent.', 'The board asked for a churn plan by 15 Nov.']);
    expect(index.search('revenue')[0].passages.map((passage) => passage.text)).toEqual(['Q3 revenue was 1.2M, up 18 percent.']);
    expect(index.search('moulds')[0].passages.map((passage) => passage.text)).toEqual([
      'The samples leave the factory on Friday; the moulds are confirmed on Wednesday.',
    ]);
    // A Chinese or Japanese full stop ends a sentence with no space after it; a danda ends one before white space.
    const scripts = filled({}, [
      { id: 'ja', fields: { body: '東京へ行く。大阪も好き。' } },
      { id: 'hi', fields: { body: 'मैं घर गया। फिर सोया।' } },
    ]);
    expect(scripts.search('大阪')[0].passages.map((passage) => passage.text)).toEqual(['大阪も好き。']);
    expect(scripts.search('घर')[0].passages.map((passage) => passage.text)).toEqual(['मैं घर गया।']);
  });

  it('clips a long passage to about passageWidth characters around its first match, at white space, with an ellipsis for what is left out', () => {
    const long = `${'word '.repeat(60)}factory${' more'.repeat(60)}.`;
    const wide = filled({}, [{ id: 'l', fields: { body: long } }]);
    const [passage] = wide.search('factory')[0].passages;
    expect(passage.text).toBe(`…${'word '.repeat(10)}factory${' more'.repeat(20)}…`);
    expect(words(passage)).toEqual(['factory']);
    const narrow = filled({ passageWidth: 40 }, [{ id: 'l', fields: { body: long } }]);
    expect(narrow.search('factory')[0].passages[0].text).toBe(`…${'word '.repeat(2)}factory${' more'.repeat(4)}…`);
  });

  it('shows the opening of the text, unmarked, when only a short field matched, and nothing when there is no text', () => {
    const [titled] = filled({}, [VISITS]).search('visits');
    expect(titled.passages).toEqual([{ text: 'Monday is quiet.', marks: [] }]);
    expect(words(titled.fields.title as Marked)).toEqual(['visits']);
    expect(filled({}, [{ id: 'b', fields: { title: 'Factory visits' } }]).search('visits')[0].passages).toEqual([]);
  });

  it('shows as many passages as told, none for 0', () => {
    expect(filled({ passages: 1 }, [VISITS]).search('factory')[0].passages.map((passage) => passage.text)).toEqual(['The factory opens at nine.']);
    expect(filled({ passages: 0 }, [VISITS]).search('factory')[0].passages).toEqual([]);
    expect(filled({ passages: 0 }, [VISITS]).search('visits')[0].passages).toEqual([]);
  });

  it('takes its passages from the fields named, in their order, or from the fields of the lowest weight', () => {
    const fields = { title: 10, summary: 2, body: 1 };
    const document = { id: 's', fields: { title: 'Plan', summary: 'The budget grows.', body: 'Budget first. Then hiring.' } };
    const lowest = new FuzzyIndex({ fields });
    lowest.addDocument(document);
    expect(lowest.search('budget')[0].passages.map((passage) => passage.text)).toEqual(['Budget first.']);
    const named = new FuzzyIndex({ fields, passageFields: ['summary', 'body'] });
    named.addDocument(document);
    expect(named.search('budget')[0].passages.map((passage) => passage.text)).toEqual(['The budget grows.', 'Budget first.']);
  });

  it('answers each field a document holds with its matches marked, and leaves out a field the index does not name', () => {
    const index = filled({}, [{ id: 'x', fields: { title: 'Budget', color: 'budget red', body: 'The budget grows.' } }]);
    expect(index.search('budget')[0].fields).toEqual({
      title: { text: 'Budget', marks: [{ start: 0, end: 6 }] },
      body: { text: 'The budget grows.', marks: [{ start: 4, end: 10 }] },
    });
    expect(index.search('red')).toEqual([]);
  });

  it('reads a decomposed accent inside its word, in NFC, folds case and accents, and keeps the vowel signs of Devanagari', () => {
    const index = filled({}, [
      { id: 'r', fields: { title: 'İstanbul trip', body: 'My résumé is ready.' } },
      { id: 'h', fields: { body: 'नई किताब' } },
    ]);
    for (const query of ['résumé', 'résumé', 'RESUME', 'resume']) {
      const [hit] = index.search(query);
      expect(hit?.score, query).toBe(1);
      // The text comes back in NFC, the accented word marked whole.
      expect(hit?.fields.body, query).toEqual({ text: 'My résumé is ready.', marks: [{ start: 3, end: 9 }] });
    }
    // A capital I with a dot folds to an i.
    expect(index.search('istanbul')[0].score).toBe(100);
    const [book] = index.search('किताब');
    expect(book.id).toBe('h');
    expect(words(book.fields.body as Marked)).toEqual(['किताब']);
  });

  it('answers at most topK hits, 10 unless given, and every hit for Infinity', () => {
    const index = filled({}, Array.from({ length: 12 }, (_, at) => ({ id: `d${at}`, fields: { body: `note ${at}` } })));
    expect(ids(index.search('note'))).toEqual(Array.from({ length: 10 }, (_, at) => `d${at}`));
    expect(ids(index.search('note', { topK: 2 }))).toEqual(['d0', 'd1']);
    expect(index.search('note', { topK: Number.POSITIVE_INFINITY })).toHaveLength(12);
    expect(index.search('note', { topK: 0 })).toEqual([]);
  });

  it('forgets a removed document and keeps the words it shared with the others', () => {
    const index = filled();
    expect(index.removeDocument('n2')).toBe(true);
    expect(index.removeDocument('n2')).toBe(false);
    expect(index.search('factory')).toEqual([]);
    expect(ids(index.search('the'))).toEqual(['n1', 'n3']);
  });

  it('finds nothing for an empty query, spaces, punctuation or a mark with no letter', () => {
    const index = filled();
    for (const query of ['', '   ', '?! ,', '́']) expect(index.search(query), JSON.stringify(query)).toEqual([]);
  });

  it('is saved as JSON and restored with the same answers and settings', () => {
    const index = filled({ editMinLength: 3, passages: 1, passageWidth: 40 });
    const saved = JSON.parse(JSON.stringify(index.toJSON()));
    expect(saved.v).toBe(1);
    const copy = FuzzyIndex.fromJSON(saved);
    for (const query of ['teh', 'factory friday', 'FACT', 'firday', 'atlas billing', 'churn']) {
      expect(copy.search(query), query).toEqual(index.search(query));
    }
    expect(copy.search('factory churn', { match: 'any' })).toEqual(index.search('factory churn', { match: 'any' }));
    copy.removeDocument('n2');
    expect(copy.search('factory')).toEqual([]);
    expect(ids(index.search('factory'))).toEqual(['n2']);
  });

  it('refuses a saved index of another version, or one toJSON could not have written, naming what is wrong', () => {
    const saved = filled().toJSON();
    const refused = (problem: string): string => `FuzzyIndex: a saved index whose ${problem}.`;
    expect(() => FuzzyIndex.fromJSON({ ...saved, v: 2 } as never)).toThrow('FuzzyIndex: a saved index of an unknown version.');
    expect(() => FuzzyIndex.fromJSON({ ...saved, fields: { title: -1 } })).toThrow(refused('field title has a weight that is not a finite number above 0'));
    expect(() => FuzzyIndex.fromJSON({ ...saved, editMinLength: 0 })).toThrow(refused('editMinLength is not a whole number of 1 or more'));
    expect(() => FuzzyIndex.fromJSON({ ...saved, documents: {} } as never)).toThrow(refused('documents are not an array'));
    expect(() => FuzzyIndex.fromJSON({ ...saved, documents: [['', {}]] })).toThrow(refused('documents[0] is not [id, fields]'));
    expect(() => FuzzyIndex.fromJSON({ ...saved, documents: [saved.documents[0], saved.documents[0]] })).toThrow(
      refused('documents[1] repeats the id of an earlier document'),
    );
    expect(() => FuzzyIndex.fromJSON({ ...saved, documents: [['x', { color: 'red' }]] })).toThrow(refused('documents[0] holds color, which is not a field'));
    expect(() => FuzzyIndex.fromJSON({ ...saved, documents: [['x', { title: 7 }]] } as never)).toThrow(
      refused('documents[0] holds title, which is not a text or a list of texts'),
    );
  });

  it("refuses a config, a document, a tokenizer's word or a search it cannot read, naming what is wrong", () => {
    expect(() => new FuzzyIndex({ fields: {} })).toThrow('FuzzyIndex: fields name no field.');
    for (const weight of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new FuzzyIndex({ fields: { title: weight } })).toThrow('FuzzyIndex: field title has a weight that is not a finite number above 0.');
    }
    expect(() => new FuzzyIndex({ fields: WEIGHTS, passageFields: ['notes'] })).toThrow('FuzzyIndex: passageFields names notes, which is not a field.');
    for (const editMinLength of [0, 1.5]) expect(() => new FuzzyIndex({ fields: WEIGHTS, editMinLength })).toThrow(RangeError);
    expect(() => new FuzzyIndex({ fields: WEIGHTS, passages: -1 })).toThrow(RangeError);
    expect(() => new FuzzyIndex({ fields: WEIGHTS, passageWidth: 0 })).toThrow(RangeError);

    const index = filled();
    expect(() => index.addDocument({ id: '', fields: {} })).toThrow('FuzzyIndex.addDocument: id must not be empty.');
    expect(() => index.addDocument({ id: 'x', fields: { title: 3 as never } })).toThrow(TypeError);
    const outside: FuzzyTokenizer = () => [{ word: 'short', start: 0, end: 99 }];
    expect(() => filled({ tokenize: outside }, [{ id: 'o', fields: { body: 'short' } }])).toThrow(RangeError);
    for (const topK of [-1, 1.5, Number.NaN]) expect(() => index.search('factory', { topK })).toThrow(RangeError);
    expect(() => index.search('factory', { match: 'most' as never })).toThrow(RangeError);
  });
});
