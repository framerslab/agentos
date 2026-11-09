import { describe, expect, it } from 'vitest';

import { FuzzyIndex, withinOneEdit, type FuzzyDocument, type FuzzyHit, type FuzzyIndexConfig, type Marked } from '../FuzzyIndex.js';

/**
 * A notes search held on the index as a configuration of it, with no code of its own: a note's title counts 100, its
 * keywords 10 and its text 1, a hit's passages come from the text, and a word matches one edit away where both words
 * have four letters or more. Each case below is one such a search answers over a person's notes: what it finds, in
 * what order, with which words marked and which passages shown. A caller that moves a search of that kind onto
 * FuzzyIndex keeps those answers while these cases hold.
 */
const NOTES_PROFILE: FuzzyIndexConfig = { fields: { title: 100, kw: 10, text: 1 }, passageFields: ['text'], editMinLength: 4 };

/** A note: its title, which is also its id, its keywords and the lines of its text. */
const note = (title: string, kw: string[], ...lines: string[]): FuzzyDocument => ({ id: title, fields: { title, kw, text: lines.join('\n') } });

/** Every note the query finds, best first. A notes search shows every note found, so it asks for every hit. */
const search = (notes: FuzzyDocument[], query: string): FuzzyHit[] => {
  const index = new FuzzyIndex(NOTES_PROFILE);
  index.addDocuments(notes);
  return index.search(query, { topK: Number.POSITIVE_INFINITY });
};

/** The titles of the notes found, in order. */
const titles = (hits: FuzzyHit[]): string[] => hits.map((hit) => hit.id);

/** The words a marked text marks, in order. */
const marked = (value: Marked): string[] => value.marks.map((mark) => value.text.slice(mark.start, mark.end));

/** A hit's title with its matched words marked. */
const titleOf = (hit: FuzzyHit): Marked => hit.fields.title as Marked;

/** A hit's keywords, each with its matched words marked. */
const keywordsOf = (hit: FuzzyHit): Marked[] => hit.fields.kw as Marked[];

const ROUND: FuzzyDocument[] = [
  note('Quarterly numbers', ['revenue', 'quarter', 'growth'], 'Q3 revenue was 1.2M, up 18 percent. Churn 2.1 percent. The board asked for a churn plan by 15 Nov.'),
  note('Enclosure samples', ['enclosure', 'factory'], 'The samples leave the factory on Friday; the moulds are confirmed on Wednesday.'),
  note('Project Atlas status', ['atlas', 'launch', 'deadline'], 'Beta ships 3 Oct. Two open blockers: the billing webhook and load testing.'),
];

const VISITS: FuzzyDocument[] = [
  note(
    'Factory visits',
    [],
    'Monday is quiet.',
    'The factory opens at nine. Lunch is at one.',
    'Bring the factory badge. The factory gate is on the left.',
    'Friday the factory closes early.',
  ),
];

describe('FuzzyIndex as a notes search: the title 100, the keywords 10, the text 1, one edit from four letters', () => {
  it('takes the weights by field name, the passages from the text and the four-letter floor, with three passages of about 160 characters', () => {
    const settings = { v: 1, fields: { title: 100, kw: 10, text: 1 }, passageFields: ['text'], editMinLength: 4, passages: 3, passageWidth: 160, documents: [] };
    expect(new FuzzyIndex(NOTES_PROFILE).toJSON()).toEqual(settings);
    // The floor and the passage field are also what the index takes when they are not given: 4, and the field of the lowest weight.
    expect(new FuzzyIndex({ fields: NOTES_PROFILE.fields }).toJSON()).toEqual(settings);
  });

  it('finds "factory friday" in the one note that holds both words, with only those two words marked in its passage', () => {
    const hits = search(ROUND, 'factory friday');
    expect(titles(hits)).toEqual(['Enclosure samples']);
    const [hit] = hits;
    // "factory" is a keyword (10 times 1) and "friday" a word of the text (1 times 1).
    expect(hit.score).toBe(11);
    expect(hit.passages).toHaveLength(1);
    expect(hit.passages[0].text).toBe('The samples leave the factory on Friday; the moulds are confirmed on Wednesday.');
    expect(marked(hit.passages[0])).toEqual(['factory', 'Friday']);
    expect(keywordsOf(hit).map(marked)).toEqual([[], ['factory']]);
    expect(marked(titleOf(hit))).toEqual([]);
  });

  it('shows a sentence or a line of the text as a passage, in the words it was given, the match marked', () => {
    const notes = [note('Shopping', [], 'Milk and eggs for Sunday.', 'Bread from the corner shop.', 'a dash line with old milk', 'Milk run')];
    const [hit] = search(notes, 'milk');
    expect(hit.passages.map((passage) => passage.text)).toEqual(['Milk and eggs for Sunday.', 'a dash line with old milk', 'Milk run']);
    expect(hit.passages.map(marked)).toEqual([['Milk'], ['milk'], ['Milk']]);
  });

  it("ranks a match in the title above one in the keywords, and one in the keywords above one in the text, a tie in the notes' own order", () => {
    const notes = [
      note('Weekly sync', ['team'], 'We talked about the launch plan.'),
      note('Weekly review', ['launch'], 'Numbers first.'),
      note('Launch checklist', [], 'Ship it.'),
      note('Another sync', ['team'], 'The launch moved.'),
    ];
    const hits = search(notes, 'launch');
    expect(titles(hits)).toEqual(['Launch checklist', 'Weekly review', 'Weekly sync', 'Another sync']);
    expect(hits.map((hit) => hit.score)).toEqual([100, 10, 1, 1]);
  });

  it('ranks the same word above a word it starts, and that above a word one edit away', () => {
    const notes = [note('One', [], 'A plain answer.'), note('Two', [], 'The planning starts.'), note('Three', [], 'The plan holds.')];
    const hits = search(notes, 'plan');
    expect(titles(hits)).toEqual(['Three', 'Two', 'One']);
    expect(hits.map((hit) => hit.score)).toEqual([1, 0.75, 0.5]);
  });

  it('matches a word by its start and marks the whole word', () => {
    const [hit] = search(ROUND, 'FACT');
    expect(hit.id).toBe('Enclosure samples');
    // The keyword "factory" begun: 10 times 0.75.
    expect(hit.score).toBe(7.5);
    expect(marked(hit.passages[0])).toEqual(['factory']);
    expect(keywordsOf(hit).map(marked)).toEqual([[], ['factory']]);
  });

  it('matches a word one edit away when both have four letters or more: a letter swapped, changed, dropped or added', () => {
    for (const typo of ['firday', 'fridey', 'frday', 'friiday']) {
      const hits = search(ROUND, typo);
      expect(titles(hits), typo).toEqual(['Enclosure samples']);
      // "Friday" in the text, one edit away: 1 times 0.5.
      expect(hits[0].score, typo).toBe(0.5);
      expect(marked(hits[0].passages[0]), typo).toEqual(['Friday']);
    }
    // Three letters are too few for a typo: "teh" finds no "the", and neither does "thee", four letters against three.
    expect(search(ROUND, 'teh')).toEqual([]);
    expect(search(ROUND, 'thee')).toEqual([]);
    expect(withinOneEdit('board', 'baord')).toBe(true);
    expect(withinOneEdit('board', 'bored')).toBe(false);
    expect(withinOneEdit('plan', 'plans')).toBe(true);
    expect(withinOneEdit('plan', 'planet')).toBe(false);
  });

  it('counts two letters side by side swapped as one edit wherever in the word they stand, in a search as in the rule', () => {
    // "friday" with each pair of neighbours swapped: the first two letters, each pair inside, the two on either side of its middle, the last two.
    for (const swapped of ['rfiday', 'firday', 'frdiay', 'friady', 'fridya']) {
      expect(withinOneEdit('friday', swapped), swapped).toBe(true);
      const hits = search(ROUND, swapped);
      expect(titles(hits), swapped).toEqual(['Enclosure samples']);
      expect(hits[0].score, swapped).toBe(0.5);
    }
    // "baord" finds "board", its second and third letters swapped; "bored" is two edits from it and finds nothing.
    const [board] = search(ROUND, 'baord');
    expect(board.id).toBe('Quarterly numbers');
    expect(board.score).toBe(0.5);
    expect(board.passages.map((passage) => passage.text)).toEqual(['The board asked for a churn plan by 15 Nov.']);
    expect(marked(board.passages[0])).toEqual(['board']);
    expect(search(ROUND, 'bored')).toEqual([]);
  });

  it('finds nothing by the edit rule for a query word under four letters: "bo" finds the words it starts alone', () => {
    // "do", "go", "so" and "to" are a letter changed from "bo" and "ob" is its two letters swapped: none is found.
    const notes = [note('To do', ['go', 'ob'], 'So it is.'), note('Board pack', [], 'Nothing else.')];
    const hits = search(notes, 'bo');
    expect(titles(hits)).toEqual(['Board pack']);
    // "Board" in the title, a word "bo" starts: 100 times 0.75.
    expect(hits[0].score).toBe(75);
    expect(marked(titleOf(hits[0]))).toEqual(['Board']);
  });

  it('asks every word of the query to match somewhere in the note, in any of its parts', () => {
    const atlas = search(ROUND, 'atlas billing');
    expect(titles(atlas)).toEqual(['Project Atlas status']);
    // "atlas" in the title (100) and "billing" in the text (1).
    expect(atlas[0].score).toBe(101);
    expect(search(ROUND, 'factory churn')).toEqual([]);
    expect(search(ROUND, 'moulds dimensions')).toEqual([]);
  });

  it('finds nothing for an empty query, spaces, or marks with no word in them', () => {
    // The last is two combining accents with no letter to carry them, which are no word either.
    for (const query of ['', '   ', '?! ,', '\u0301 \u0308']) expect(search(ROUND, query), JSON.stringify(query)).toEqual([]);
  });

  it('finds a note holding a word with decomposed accents by its composed, its unaccented and its decomposed spelling, the whole word marked in the text as the index holds it, in NFC', () => {
    const decomposed = 're\u0301sume\u0301';
    const precomposed = 'r\u00e9sum\u00e9';
    expect(decomposed).not.toBe(precomposed);
    expect(decomposed.normalize('NFC')).toBe(precomposed);
    const notes = [note('Job hunt', [], `Send the ${decomposed} to the recruiter on Friday.`), note('Groceries', [], 'Milk, eggs and bread.')];
    for (const query of [precomposed, 'resume', 'RESUME', decomposed]) {
      const hits = search(notes, query);
      expect(titles(hits), query).toEqual(['Job hunt']);
      // The index holds a text in NFC, so the passage is the note's text composed and the mark is the composed word, whole.
      expect(hits[0].passages[0].text, query).toBe(`Send the ${precomposed} to the recruiter on Friday.`);
      expect(marked(hits[0].passages[0]), query).toEqual([precomposed]);
    }
    // The word is found whole: its pieces on either side of the first accent are no words of the note.
    expect(search(notes, 'sume')).toEqual([]);
  });

  it("shows at most three passages, the sentences or lines holding the most query words first, in the text's order, and the opening when only the title matched", () => {
    const [hit] = search(VISITS, 'factory');
    expect(hit.passages.map((passage) => passage.text)).toEqual(['The factory opens at nine.', 'Bring the factory badge.', 'The factory gate is on the left.']);
    // The sentence that holds both words is kept over a later one that holds one, and the three stay in the text's order.
    const [both] = search(VISITS, 'factory friday');
    expect(both.passages.map((passage) => passage.text)).toEqual(['The factory opens at nine.', 'Bring the factory badge.', 'Friday the factory closes early.']);
    expect(marked(both.passages[2])).toEqual(['Friday', 'factory']);
    const [titled] = search(VISITS, 'visits');
    expect(titled.passages).toEqual([{ text: 'Monday is quiet.', marks: [] }]);
    expect(marked(titleOf(titled))).toEqual(['visits']);
  });

  it('clips a long passage to about 160 characters around its match at spaces, with an ellipsis for the text left out and the marks moved with it', () => {
    const before = 'word '.repeat(60);
    const after = ' more'.repeat(60);
    const [hit] = search([note('Long', [], `${before}factory${after}.`)], 'factory');
    const [passage] = hit.passages;
    expect(passage.text.length).toBeLessThanOrEqual(162);
    expect(passage.text.startsWith('\u2026word ')).toBe(true);
    expect(passage.text.endsWith('more\u2026')).toBe(true);
    expect(marked(passage)).toEqual(['factory']);
    // A passage that fits is kept whole.
    expect(search([note('Short', [], 'The factory opens at nine.')], 'factory')[0].passages).toEqual([{ text: 'The factory opens at nine.', marks: [{ start: 4, end: 11 }] }]);
  });

  it('finds a note by the last of its 200,000 keywords, with that keyword alone marked', () => {
    const keywords = Array.from({ length: 199_999 }, (_, at) => `k${at}`);
    const hits = search([note('Reading list', [...keywords, 'poetry'], 'Three books.')], 'poetry');
    expect(titles(hits)).toEqual(['Reading list']);
    const kw = keywordsOf(hits[0]);
    expect(kw).toHaveLength(200_000);
    expect(kw[kw.length - 1]).toEqual({ text: 'poetry', marks: [{ start: 0, end: 6 }] });
    expect(kw.filter((keyword) => keyword.marks.length > 0)).toHaveLength(1);
  });

  it('answers every note found when asked for every hit, where a search that names no number answers ten', () => {
    const notes = Array.from({ length: 12 }, (_, at) => note(`Note ${at}`, [], 'The launch moved.'));
    expect(titles(search(notes, 'launch'))).toEqual(notes.map((each) => each.id));
    const index = new FuzzyIndex(NOTES_PROFILE);
    index.addDocuments(notes);
    expect(index.search('launch')).toHaveLength(10);
  });
});
