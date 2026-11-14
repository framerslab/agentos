/**
 * @fileoverview The vocabulary's labels and counts by kind, a candidate's resolution with the person's own spelling,
 * rename and merge by key, and the grammar's names in both of the library's entries.
 */
import { describe, expect, it } from 'vitest';
import { mergeTags, renameTag, resolveTag, tagVocabulary, type TagDocument } from '../tags.js';

const doc = (id: string, kind: TagDocument['kind'], tags: string[], changedAt: number | null): TagDocument => ({ id, kind, title: id, text: '', keywords: [], tags, changedAt });

/** The grammar's values, which both entries export. */
const GRAMMAR = [
  'TAG_MAX_CHARS',
  'TAGS_MAX',
  'TAG_SUGGESTIONS_MAX',
  'isTag',
  'normalizeTag',
  'tagKey',
  'canonicalTag',
  'classifyLegacyTag',
  'compareCodePoints',
  'tagKeysOf',
  'tagVocabulary',
  'preferredTagOrder',
  'resolveTag',
  'renameTag',
  'mergeTags',
];

describe('tagVocabulary with documents and labels', () => {
  it('counts a document once a key beside notes and sessions', () => {
    const vocabulary = tagVocabulary([
      doc('n', 'note', ['budget'], 10),
      doc('s', 'session', ['Budget'], 20),
      doc('d1', 'document', ['budget', 'budget'], 30),
      doc('d2', 'document', ['budget', 'q3'], 5),
    ]);
    expect(vocabulary[0]).toEqual({ tag: 'budget', label: 'budget', uses: 4, notes: 1, sessions: 1, documents: 2, lastUsed: 30 });
    expect(vocabulary[1]).toEqual({ tag: 'q3', label: 'q3', uses: 1, notes: 0, sessions: 0, documents: 1, lastUsed: 5 });
  });

  it("keeps the person's own spelling as the label: the one on the most documents", () => {
    const vocabulary = tagVocabulary([
      doc('a', 'document', ['Q3 Planning'], 10),
      doc('b', 'document', ['Q3 Planning', 'q3-planning'], 20),
      doc('c', 'note', ['Q3 Planning'], 30),
      doc('d', 'session', ['q3-planning'], 40),
    ]);
    expect(vocabulary).toEqual([{ tag: 'q3planning', label: 'Q3 Planning', uses: 4, notes: 1, sessions: 1, documents: 2, lastUsed: 40 }]);
  });

  it('breaks a tie of spellings by the latest use, then by code point', () => {
    const latest = tagVocabulary([doc('a', 'document', ['Road map'], 10), doc('b', 'document', ['road-map'], 30), doc('c', 'note', ['ROADMAP'], null)]);
    expect(latest).toEqual([expect.objectContaining({ tag: 'roadmap', label: 'road-map' })]);
    const tied = tagVocabulary([doc('a', 'document', ['road-map'], 30), doc('b', 'document', ['Road map'], 30), doc('c', 'note', ['ROADMAP'], 30)]);
    expect(tied).toEqual([expect.objectContaining({ tag: 'roadmap', label: 'ROADMAP' })]);
    const unknown = tagVocabulary([doc('a', 'document', ['road-map'], null), doc('b', 'document', ['Road map'], null)]);
    expect(unknown).toEqual([expect.objectContaining({ tag: 'roadmap', label: 'Road map' })]);
  });

  it('never rewrites a stored label: the documents given are not changed', () => {
    const given = [
      doc('a', 'document', ['Q3 Planning', 'C++'], 10),
      doc('b', 'document', ['q3-planning'], 20),
      doc('c', 'note', ['Q3 Planning'], 30),
    ];
    const before: unknown = JSON.parse(JSON.stringify(given));
    for (const document of given) Object.freeze(Object.freeze(document).tags);
    expect(tagVocabulary(given)).toEqual([expect.objectContaining({ tag: 'q3planning', label: 'Q3 Planning' })]);
    expect(given).toEqual(before);
  });
});

describe('resolveTag with labels', () => {
  const vocabulary = tagVocabulary([
    doc('a', 'document', ['Q3 Planning'], 10),
    doc('b', 'session', ['Q3 Planning'], 20),
    doc('c', 'note', ['q3planning'], 30),
    doc('d', 'document', ['Roadmap'], 40),
    doc('e', 'document', ['Budget review'], 50),
  ]);

  it("resolveTag answers an existing tag with the vocabulary's label and its key", () => {
    expect(resolveTag('q3 planning', vocabulary)).toEqual({ kind: 'existing', tag: 'q3planning', label: 'Q3 Planning', via: 'key', from: 'q3 planning' });
    expect(resolveTag('roadmaps', vocabulary)).toEqual({ kind: 'existing', tag: 'roadmap', label: 'Roadmap', via: 'stem', from: 'roadmaps' });
    expect(resolveTag('budgetreveiw', vocabulary)).toEqual({ kind: 'existing', tag: 'budgetreview', label: 'Budget review', via: 'edit', from: 'budgetreveiw' });
  });

  it("resolveTag answers a new tag with normalizeTag's form as its label", () => {
    expect(resolveTag('Road Map 2027!', vocabulary)).toEqual({ kind: 'new', tag: 'roadmap2027', label: 'road-map-2027', from: 'Road Map 2027!' });
    expect(resolveTag('!!!', vocabulary)).toBeNull();
  });
});

describe('renameTag and mergeTags', () => {
  it("renameTag renames by key, keeps the list's order and keeps the tag once", () => {
    expect(renameTag(['Budget', 'q3', 'budget '], 'budget', 'Finance')).toEqual(['Finance', 'q3']);
    expect(renameTag(['q3', 'Q3 Planning', 'roadmap'], 'q3-planning', 'Planning')).toEqual(['q3', 'Planning', 'roadmap']);
    expect(renameTag(['q3', 'roadmap'], 'budget', 'Finance')).toEqual(['q3', 'roadmap']);
  });

  it('renameTag onto a tag the list holds merges the two at the first place either stood', () => {
    expect(renameTag(['q3', 'Finance', 'roadmap', 'budget'], 'budget', 'finance')).toEqual(['q3', 'finance', 'roadmap']);
    expect(renameTag(['budget', 'q3', 'Finance'], 'Budget', 'finance')).toEqual(['finance', 'q3']);
    expect(renameTag(['q3', 'Finance'], 'budget', 'finance')).toEqual(['q3', 'Finance']);
  });

  it("mergeTags keeps the list's own spelling of the tag merged into", () => {
    expect(mergeTags(['budget', 'q3', 'Finance'], 'budget', 'finance')).toEqual(['Finance', 'q3']);
    expect(mergeTags(['q3', 'Budget', 'budget_'], 'budget', 'Finance')).toEqual(['q3', 'Finance']);
    expect(mergeTags(['q3', 'Finance'], 'budget', 'finance')).toEqual(['q3', 'Finance']);
  });

  it('renameTag and mergeTags leave a label with no key where it stands', () => {
    expect(renameTag(['C++', 'c', 'q3'], 'c', 'clang')).toEqual(['C++', 'clang', 'q3']);
    expect(mergeTags(['C++', 'c', 'q3'], 'c', 'q3')).toEqual(['C++', 'q3']);
    expect(renameTag(['q3', 'C++', 'c'], 'C++', 'cpp')).toEqual(['q3', 'cpp', 'c']);
    expect(mergeTags(['C++', 'cpp'], 'C++', 'CPP')).toEqual(['cpp']);
  });

  it('given lists are not changed', () => {
    const tags = Object.freeze(['Budget', 'q3', 'Finance']);
    expect(renameTag(tags, 'budget', 'Money')).toEqual(['Money', 'q3', 'Finance']);
    expect(mergeTags(tags, 'budget', 'finance')).toEqual(['Finance', 'q3']);
    expect(tags).toEqual(['Budget', 'q3', 'Finance']);
  });
});

describe("the library's entries", () => {
  it('both entries export the grammar', async () => {
    const library = Object.keys(await import('../index.js'));
    const browser = Object.keys(await import('../browser.js'));
    expect(library).toEqual(expect.arrayContaining(GRAMMAR));
    expect(browser).toEqual(expect.arrayContaining(GRAMMAR));
  });
});
