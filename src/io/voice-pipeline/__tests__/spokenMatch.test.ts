/**
 * @module voice-pipeline/__tests__/spokenMatch
 *
 * Whether a voice said the text it was asked to say: both texts cut into words the same way, digits and written
 * numbers folded to one form, and the two word sequences compared. The written numbers come from CLDR's spell-out
 * rules for each of the nine languages (spokenNumbers.fixture.json, whose first key names the CLDR commit).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { spokenMatch, spokenWords } from '../spokenMatch.js';
import { foldNumbers } from '../spokenNumbers.js';

describe('spokenMatch', () => {
  it('matches the same text', () => {
    expect(spokenMatch('Nos vemos a las tres.', 'Nos vemos a las tres.', 'es')).toEqual({ match: true, ratio: 1 });
  });
  it('matches through punctuation, case and width', () => {
    expect(spokenMatch('Hello, World!', 'hello world', 'en').match).toBe(true);
    // Fullwidth letters and an ideographic space, written as escapes: the lint step rewrites a literal U+3000 in a source file.
    expect(spokenMatch('ＡＢＣ　ｄｅｆ', 'abc def', 'en').match).toBe(true);
  });
  it('refuses a dropped word, an added sentence and a changed number', () => {
    expect(spokenMatch('We meet at three today', 'We meet at three', 'en').match).toBe(false);
    expect(spokenMatch('We meet at three', 'We meet at three. See you there.', 'en').match).toBe(false);
    expect(spokenMatch('The room holds 15 people', 'The room holds 50 people', 'en').match).toBe(false);
  });
  it('folds a digit run and its written form', () => {
    expect(spokenMatch('We meet at 3', 'We meet at three', 'en').match).toBe(true);
    expect(spokenMatch('Tengo 3 gatos', 'Tengo tres gatos', 'es').match).toBe(true);
    expect(spokenMatch('Ich habe 3 Katzen', 'Ich habe drei Katzen', 'de').match).toBe(true);
  });
  it('keeps two numbers said side by side apart', () => {
    expect(spokenMatch('We need 7 chairs', 'We need three four chairs', 'en').match).toBe(false);
    expect(spokenMatch('We need 3 4 chairs', 'We need three four chairs', 'en').match).toBe(true);
  });
  it('compares a Chinese and a Hindi pair by words', () => {
    expect(spokenWords('我们三点见面。', 'zh-Hans').length).toBeGreaterThan(1);
    expect(spokenMatch('我们三点见面。', '我们三点见面', 'zh-Hans').match).toBe(true);
    expect(spokenMatch('我们三点见面', '我们四点见面', 'zh-Hans').match).toBe(false);
    expect(spokenMatch('हम तीन बजे मिलते हैं।', 'हम तीन बजे मिलते हैं', 'hi').match).toBe(true);
  });
  it('answers no match, and a ratio under one, for words in another order', () => {
    const verdict = spokenMatch('red green blue white', 'red blue green white', 'en');
    expect(verdict.match).toBe(false);
    expect(verdict.ratio).toBeCloseTo(0.75, 5);
  });
  it('answers no match for a reply with no transcript', () => {
    expect(spokenMatch('Hello', '', 'en')).toEqual({ match: false, ratio: 0 });
  });
});

/** The fixture: for each language, the BCP-47 tag the comparison is given, CLDR's rule set, and each number's written form. */
interface NumbersFixture {
  cldr: string;
  languages: Record<string, { tag: string; ruleset: string; forms: Record<string, string> }>;
}

const fixture = JSON.parse(
  readFileSync(new URL('./spokenNumbers.fixture.json', import.meta.url), 'utf8')
) as NumbersFixture;

const NUMBERS = ['0', '7', '15', '21', '50', '99', '100', '101', '365', '1000', '2026'];

describe('foldNumbers against CLDR spell-out', () => {
  it('names the CLDR commit first, and holds the nine launch languages with every number', () => {
    expect(Object.keys(fixture)[0]).toBe('cldr');
    expect(fixture.cldr).toMatch(/unicode-org\/cldr\/tree\/[0-9a-f]{40}\/common\/rbnf/);
    expect(Object.keys(fixture.languages).sort()).toEqual(['de', 'en', 'es', 'fr', 'hi', 'it', 'ko', 'pt', 'zh']);
    for (const { forms } of Object.values(fixture.languages)) expect(Object.keys(forms).sort()).toEqual([...NUMBERS].sort());
  });

  for (const [language, { tag, forms }] of Object.entries(fixture.languages)) {
    it(`folds ${language}'s numbers written as digits and in words to the same word`, () => {
      for (const [digits, written] of Object.entries(forms)) {
        expect(foldNumbers(spokenWords(digits, tag), tag), digits).toEqual([digits]);
        expect(foldNumbers(spokenWords(written, tag), tag), written).toEqual([digits]);
        expect(spokenMatch(digits, written, tag).match, `${digits} against ${written}`).toBe(true);
      }
    });
  }
});
