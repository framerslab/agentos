import { describe, expect, it } from 'vitest';
import { tagKey } from '../tags.js';
import { loadLabelCases, loadTagFixtures, longFixture, TAG_FIXTURE_SETS, type TagFixture } from './tags.fixtures.js';

/** Case-folded NFC, so a word stands in a text whatever its capitals. */
const fold = (text: string): string => text.normalize('NFC').toLowerCase();

/** Every string a fixture holds: its text and what a host passes beside it. */
const stringsOf = (fixture: TagFixture): string[] => [
  fixture.title,
  ...fixture.headings,
  fixture.path ?? '',
  fixture.text,
  ...fixture.vocabulary.map((use) => use.label),
  ...fixture.typed,
  ...(fixture.report ?? []).flatMap((tag) => [tag.label, ...tag.quotes]),
];

const EMAIL = /[^\s@<>()[\]]+@[^\s@<>()[\]]+\.[a-z]{2,}/i;
const TELEPHONE = /(?:\+\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)|\+\d{1,3}[\s.-]?\d{2,4}[\s.-]?\d{3,4}[\s.-]?\d{3,4}/;
const LONG_DIGITS = /\d{13,}|(?<!\d)(?:\d{4}[ -]){3}\d{1,7}(?!\d)/;

describe('the tag suggestion fixture texts', () => {
  const fixtures = loadTagFixtures();

  it('every fixture parses and has an id no other has', () => {
    expect(fixtures.length).toBeGreaterThan(0);
    const ids = fixtures.map((fixture) => fixture.id);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
    expect(loadLabelCases()).toHaveLength(40);
  });

  it('each set holds its count: plain 20, sessions 10, sensitive 10, languages 10, injection 5, bytes 4', () => {
    const counts = Object.fromEntries(Object.keys(TAG_FIXTURE_SETS).map((set) => [set, loadTagFixtures(set).length]));
    expect(counts).toEqual({ plain: 20, sessions: 10, sensitive: 10, languages: 10, injection: 5, bytes: 4 });
  });

  it('every word a fixture says must not be proposed stands in its own text', () => {
    expect(loadTagFixtures('sensitive').filter((fixture) => fixture.mustNot.length === 0).map((f) => f.id)).toEqual([]);
    const absent = fixtures.flatMap((fixture) =>
      fixture.mustNot.filter((word) => !fold(fixture.text).includes(fold(word))).map((word) => `${fixture.id}: ${word}`),
    );
    expect(absent).toEqual([]);
  });

  it('every tag an injection fixture asks for stands in its text and in no expected list', () => {
    const injection = loadTagFixtures('injection');
    expect(injection.filter((fixture) => fixture.asks.length === 0).map((fixture) => fixture.id)).toEqual([]);
    const wrong = injection.flatMap((fixture) => {
      const expected = [...fixture.expected.existing, ...fixture.expected.new];
      return fixture.asks.flatMap((ask) => [
        ...(fold(fixture.text).includes(fold(ask)) ? [] : [`${fixture.id}: ${ask} is not in the text`]),
        ...(expected.includes(tagKey(ask) ?? ask) || expected.includes(ask) ? [`${fixture.id}: ${ask} is expected`] : []),
      ]);
    });
    expect(wrong).toEqual([]);
    expect(fixtures.filter((fixture) => fixture.set !== 'injection' && fixture.asks.length > 0).map((f) => f.id)).toEqual([]);
  });

  it('no fixture holds an email address, a telephone number or a run of 13 to 19 digits', () => {
    const found = fixtures.flatMap((fixture) =>
      stringsOf(fixture).flatMap((text) =>
        [EMAIL, TELEPHONE, LONG_DIGITS].flatMap((pattern) => {
          const match = pattern.exec(text);
          return match ? [`${fixture.id}: ${match[0]}`] : [];
        }),
      ),
    );
    expect(found).toEqual([]);
    for (const sample of ['write to someone@example.org', 'call 555 010 4477', 'call +44 20 7946 0000', '4000123412341234']) {
      expect([EMAIL, TELEPHONE, LONG_DIGITS].some((pattern) => pattern.test(sample)), sample).toBe(true);
    }
  });

  it('each bytes fixture is longer in UTF-8 bytes than four characters a token would count: its bytes divided by four pass its characters divided by four, or its text holds no letter', () => {
    const bytes = loadTagFixtures('bytes');
    expect(bytes).toHaveLength(4);
    const short = bytes.filter(
      (fixture) => !(Buffer.byteLength(fixture.text, 'utf8') / 4 > fixture.text.length / 4 || !/\p{L}/u.test(fixture.text)),
    );
    expect(short.map((fixture) => fixture.id)).toEqual([]);
  });

  it('the languages set names ten languages, one fixture each, none English', () => {
    const languages = loadTagFixtures('languages').map((fixture) => fixture.language).sort();
    expect(languages).toEqual(['ar', 'de', 'es', 'fr', 'hi', 'ja', 'ko', 'pt', 'ru', 'zh']);
    expect(loadTagFixtures('languages').filter((fixture) => fixture.expected.new.length > 0).map((f) => f.id)).toEqual([]);
  });

  it('every expected tag is a key: the existing ones of its vocabulary, the new ones of no vocabulary label and no word it must not propose', () => {
    const wrong = fixtures.flatMap((fixture) => {
      const vocabulary = new Set(fixture.vocabulary.map((use) => tagKey(use.label)));
      const refused = new Set(fixture.mustNot.map((word) => tagKey(word)));
      const labels = new Set(fixture.vocabulary.map((use) => use.label));
      return [
        ...fixture.vocabulary.filter((use) => tagKey(use.label) === null).map((use) => `${fixture.id}: label ${use.label} has no key`),
        ...[...fixture.expected.existing, ...fixture.expected.new].filter((key) => tagKey(key) !== key).map((key) => `${fixture.id}: ${key} is not a key`),
        ...fixture.expected.existing.filter((key) => !vocabulary.has(key)).map((key) => `${fixture.id}: ${key} is not in its vocabulary`),
        ...fixture.expected.new.filter((key) => vocabulary.has(key) || refused.has(key)).map((key) => `${fixture.id}: ${key} is not new`),
        ...fixture.typed.filter((label) => !labels.has(label)).map((label) => `${fixture.id}: typed ${label} is not in its vocabulary`),
      ];
    });
    expect(wrong).toEqual([]);
    // Past the vocabulary's ceiling of 500 no new tag may be offered, and outside English none is.
    const past = loadTagFixtures('plain').filter((fixture) => fixture.vocabulary.length > 500);
    expect(past).toHaveLength(2);
    expect(past.filter((fixture) => fixture.expected.new.length > 0).map((fixture) => fixture.id)).toEqual([]);
    expect(fixtures.filter((f) => f.language !== 'en' && f.expected.new.length > 0).map((fixture) => fixture.id)).toEqual([]);
  });

  it('two sessions report a tag whose quote is not in the text, and every other quote of a report stands in its text', () => {
    const sessions = loadTagFixtures('sessions');
    expect(sessions.filter((fixture) => fixture.kind !== 'session' || fixture.report === undefined).map((f) => f.id)).toEqual([]);
    const absent = sessions.filter((fixture) =>
      (fixture.report ?? []).some((tag) => tag.quotes.some((quote) => !fold(fixture.text).includes(fold(quote)))),
    );
    expect(absent).toHaveLength(2);
    // Each quote is counted, not each tag, so a tag with a second absent quote fails here.
    const quotesAbsent = absent.flatMap((fixture) =>
      (fixture.report ?? []).flatMap((tag) =>
        tag.quotes.filter((quote) => !fold(fixture.text).includes(fold(quote))).map((quote) => `${fixture.id}: ${quote}`),
      ),
    );
    expect(quotesAbsent).toHaveLength(2);
    expect(fixtures.filter((fixture) => fixture.set !== 'sessions' && fixture.report !== undefined).map((f) => f.id)).toEqual([]);
  });

  it('makes a long text of the length asked from the plain set, with no two paragraphs the same', () => {
    const text = longFixture(50_000);
    expect(text).toHaveLength(50_000);
    const paragraphs = text.split('\n\n').filter((paragraph) => paragraph.length > 0).slice(0, -1);
    expect(new Set(paragraphs).size).toBe(paragraphs.length);
  });
});
