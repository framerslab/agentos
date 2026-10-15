/**
 * FuzzyIndex in Chromium and WebKit, imported from the library's browser entry as a page imports it: an index is
 * built, searched with a typo and with a word written with combining marks, its matches marked, and saved and
 * restored as JSON.
 */
import { describe, expect, it } from 'vitest';

import { FuzzyIndex, withinOneEdit } from '../browser.js';

describe('FuzzyIndex in a browser', () => {
  it('finds a word with a typo and one written with combining marks, marks them, and answers the same once restored', () => {
    const index = new FuzzyIndex({ fields: { title: 100, keywords: 10, body: 1 } });
    index.addDocuments([
      { id: 'a', fields: { title: 'Enclosure samples', keywords: ['factory'], body: 'The samples leave the factory on Friday.' } },
      { id: 'b', fields: { title: 'My résumé', body: 'Two pages, sent on Monday.' } },
    ]);
    const [typo] = index.search('firday');
    expect(typo.id).toBe('a');
    expect(typo.passages).toEqual([{ text: 'The samples leave the factory on Friday.', marks: [{ start: 33, end: 39 }] }]);
    expect(index.search('resume')[0].fields.title).toEqual({ text: 'My résumé', marks: [{ start: 3, end: 9 }] });
    const copy = FuzzyIndex.fromJSON(JSON.parse(JSON.stringify(index.toJSON())));
    expect(ids(copy.search('firday resume', { match: 'any' }))).toEqual(['b', 'a']);
    expect(copy.search('firday resume', { match: 'any' })).toEqual(index.search('firday resume', { match: 'any' }));
    expect(withinOneEdit('friday', 'firday')).toBe(true);
  });
});

/** The ids of some hits, in order. */
function ids(hits: Array<{ id: string }>): string[] {
  return hits.map((hit) => hit.id);
}
