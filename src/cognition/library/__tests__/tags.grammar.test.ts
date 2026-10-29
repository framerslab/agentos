import { describe, expect, it } from 'vitest';
import { canonicalTag, classifyLegacyTag, compareCodePoints, isTag, normalizeTag, resolveTag, tagKey, tagKeysOf, tagVocabulary, type TagDocument, type TagUse } from '../tags.js';

const doc = (id: string, kind: TagDocument['kind'], tags: string[], changedAt: number | null): TagDocument => ({ id, kind, title: id, text: '', keywords: [], tags, changedAt });
const use = (tag: string, uses: number, lastUsed: number | null): TagUse => ({ tag, uses, notes: uses, sessions: 0, lastUsed });

describe('the tag grammar (U1)', () => {
  it('makes typing a tag with one spelling per key, and refuses rather than cuts', () => {
    expect(normalizeTag('Q3 Planning!')).toBe('q3-planning');
    for (const typed of ['Q3 Planning!', 'q3-planning', 'q3planning', 'Q3_PLANNING']) expect(canonicalTag(typed)).toBe('q3planning');
    expect(tagKey('  BUDGET ')).toBe('budget');
    expect(canonicalTag('Ｂｕｄｇｅｔ')).toBe('budget');
    expect(canonicalTag('Cafe\u0301')).toBe('caf\u00e9');
    expect(canonicalTag('caf\u00e9')).toBe('caf\u00e9');
    expect(canonicalTag('किताब')).toBe('किताब'.normalize('NFC'));
    expect(canonicalTag('كِتَاب')).toBe('كِتَاب');
    expect(canonicalTag('\u{1D400}\u{1D401}')).toBe('ab');
    expect(canonicalTag('\u{20000}\u{20001}')).toBe('\u{20000}\u{20001}');
    expect(canonicalTag('\u{20000}'.repeat(40))).toBe('\u{20000}'.repeat(40));
    expect(canonicalTag('\u{20000}'.repeat(41))).toBeNull();
    expect(canonicalTag('r')).toBe('r');
    expect(canonicalTag('a'.repeat(40))).toBe('a'.repeat(40));
    expect(canonicalTag('a'.repeat(41))).toBeNull();
    expect(normalizeTag(`${'a'.repeat(20)} ${'b'.repeat(20)}`)).toBeNull();
    for (const empty of ['', '   ', '!!!', '\u{1F600}', '\u0301']) expect(canonicalTag(empty)).toBeNull();
  });

  it('keeps every key a tag, in NFC where joining the runs composes a Hangul syllable', () => {
    expect(canonicalTag('\uAC00 \u11A8')).toBe('\uAC01');
    expect(canonicalTag('\u1100-\u1161')).toBe('\uAC00');
    expect(resolveTag('\uAC00 \u11A8', [use('\uAC01', 1, 1)])).toEqual({ kind: 'existing', tag: '\uAC01', via: 'key', from: '\uAC00 \u11A8' });
    for (const typed of ['Q3 Planning!', '\uFF22udget', 'Cafe\u0301', '\u0915\u093F\u0924\u093E\u092C', '\uAC00 \u11A8', '\u1100-\u1161']) expect(isTag(canonicalTag(typed) ?? ''), typed).toBe(true);
  });

  it('writes a sigma by its place in the key, so separators and the typed form of a sigma give one key', () => {
    for (const typed of ['\u039F\u03A3-\u0391', '\u039F\u03A3\u0391', '\u03BF\u03C2 \u03B1', '\u03BF\u03C3\u03B1', '\u039F\u03C2_\u03B1']) expect(canonicalTag(typed), typed).toBe('\u03BF\u03C3\u03B1');
    for (const typed of ['\u039B\u039F\u0393\u039F\u03A3', '\u03BB\u03BF\u03B3\u03BF\u03C2', '\u03BB\u03BF\u03B3\u03BF\u03C3']) expect(canonicalTag(typed), typed).toBe('\u03BB\u03BF\u03B3\u03BF\u03C2');
    expect(normalizeTag('\u039F\u03A3-\u0391')).toBe('\u03BF\u03C2-\u03B1');
  });

  it('writes a sigma by its place in its run, so the separator typed never changes a letter of the tag', () => {
    for (const typed of ['\u039F\u03A3-\u0391', '\u039F\u03A3.\u0391', '\u039F\u03A3:\u0391', '\u039F\u03A3\u0027\u0391', '\u039F\u03A3\u00B7\u0391']) expect(normalizeTag(typed), typed).toBe('\u03BF\u03C2-\u03B1');
    for (const typed of ['\u039B\u039F\u0393\u039F\u03A3', '\u03BB\u03BF\u03B3\u03BF\u03C2', '\u03BB\u03BF\u03B3\u03BF\u03C3']) expect(normalizeTag(typed), typed).toBe('\u03BB\u03BF\u03B3\u03BF\u03C2');
  });

  it('reads a tag as stored or typed', () => {
    for (const tag of ['budget', 'q3-planning', 'q3planning', 'caf\u00e9', 'किताब'.normalize('NFC'), 'r', '\u{20000}']) expect(isTag(tag), tag).toBe(true);
    for (const text of ['', 'Budget', 'q3--planning', '-budget', 'budget-', 'cafe\u0301', '\u0301a', 'a b', 'a'.repeat(41), 'c++', 'budget\n']) expect(isTag(text), text).toBe(false);
  });

  it('refuses a text with no key, so every tag has one', () => {
    for (const text of ['\uFE70', '\uFB03'.repeat(20)]) {
      expect(canonicalTag(text), text).toBeNull();
      expect(isTag(text), text).toBe(false);
    }
  });

  it('classifies a stored label without losing it: an alias only by case, normalization and separators', () => {
    expect(classifyLegacyTag('Q3 Planning')).toEqual({ state: 'alias', key: 'q3planning' });
    expect(classifyLegacyTag('q3_planning')).toEqual({ state: 'alias', key: 'q3planning' });
    expect(classifyLegacyTag('q3\u2013planning')).toEqual({ state: 'alias', key: 'q3planning' });
    expect(classifyLegacyTag('Ｂudget')).toEqual({ state: 'alias', key: 'budget' });
    expect(classifyLegacyTag(' Budget ')).toEqual({ state: 'alias', key: 'budget' });
    expect(classifyLegacyTag('C')).toEqual({ state: 'alias', key: 'c' });
    expect(classifyLegacyTag('C++')).toEqual({ state: 'unresolved', key: 'c' });
    expect(classifyLegacyTag('C#')).toEqual({ state: 'unresolved', key: 'c' });
    expect(classifyLegacyTag('budget.')).toEqual({ state: 'unresolved', key: 'budget' });
    expect(classifyLegacyTag('\u{1F3AF} goals')).toEqual({ state: 'unresolved', key: 'goals' });
    expect(classifyLegacyTag('!!!')).toEqual({ state: 'unresolved', key: null });
    expect(classifyLegacyTag('x'.repeat(41))).toEqual({ state: 'unresolved', key: null });
    expect(classifyLegacyTag('')).toEqual({ state: 'unresolved', key: null });
  });

  it('takes separators at either end of a stored label as separators, so the label stays an alias of its key', () => {
    for (const label of ['budget_', '-budget', '_budget', ' budget\u2013', '__Budget__']) expect(classifyLegacyTag(label), label).toEqual({ state: 'alias', key: 'budget' });
    expect(classifyLegacyTag('-q3 planning_')).toEqual({ state: 'alias', key: 'q3planning' });
    expect(classifyLegacyTag('_')).toEqual({ state: 'unresolved', key: null });
    expect(classifyLegacyTag('-C++')).toEqual({ state: 'unresolved', key: 'c' });
    expect(tagKeysOf({ tags: ['budget_', '-Budget', 'budget.'] })).toEqual(['budget']);
  });

  it('orders by code point, not by UTF-16 unit', () => {
    expect(compareCodePoints('\u{1F600}', '｡')).toBeGreaterThan(0);
    expect(compareCodePoints('ab', 'abc')).toBeLessThan(0);
    expect(compareCodePoints('b', 'b')).toBe(0);
  });
});

describe('tagVocabulary', () => {
  it('counts each document once a key, by kind, with its latest change; most used first, ties by code point', () => {
    expect(
      tagVocabulary([
        doc('a', 'note', ['budget', 'Budget', 'q3-planning'], 10),
        doc('b', 'note', ['budget'], 30),
        doc('c', 'session', ['q3planning', 'roadmap'], 20),
        doc('d', 'note', [], null),
      ]),
    ).toEqual([
      { tag: 'budget', uses: 2, notes: 2, sessions: 0, lastUsed: 30 },
      { tag: 'q3planning', uses: 2, notes: 1, sessions: 1, lastUsed: 20 },
      { tag: 'roadmap', uses: 1, notes: 0, sessions: 1, lastUsed: 20 },
    ]);
  });

  it('counts an alias under its key and leaves out a label the legacy classification keeps unresolved', () => {
    expect(tagKeysOf({ tags: ['Budget', 'q3-planning', 'C++', 'budget', 'q3 Planning'] })).toEqual(['budget', 'q3planning']);
    expect(tagVocabulary([doc('a', 'note', ['C++', 'C#'], 10), doc('b', 'note', ['c'], 20)])).toEqual([{ tag: 'c', uses: 1, notes: 1, sessions: 0, lastUsed: 20 }]);
  });
});

describe('resolveTag (A2)', () => {
  const vocabulary = [use('roadmap', 5, 100), use('q3', 3, 50), use('budget', 9, 10), use('2025budget', 1, 1), use('会議', 4, 1), use('plan', 1, 1)];

  it('resolves by key whatever the spelling, hyphenated or spaced', () => {
    expect(resolveTag('Q3', vocabulary)).toEqual({ kind: 'existing', tag: 'q3', via: 'key', from: 'Q3' });
    expect(resolveTag('road-map', vocabulary)).toEqual({ kind: 'existing', tag: 'roadmap', via: 'key', from: 'road-map' });
    expect(resolveTag('Road map', vocabulary)).toMatchObject({ kind: 'existing', tag: 'roadmap', via: 'key' });
  });

  it('resolves one spaced word by its stem', () => {
    expect(resolveTag('roadmaps', vocabulary)).toMatchObject({ kind: 'existing', tag: 'roadmap', via: 'stem' });
    expect(resolveTag('budgets', vocabulary)).toMatchObject({ kind: 'existing', tag: 'budget', via: 'stem' });
  });

  it('resolves one edit away only for keys of five code points or more, with the same digits, in a spaced script', () => {
    expect(resolveTag('budgte', vocabulary)).toMatchObject({ kind: 'existing', tag: 'budget', via: 'edit' });
    expect(resolveTag('q4', vocabulary)).toEqual({ kind: 'new', tag: 'q4', from: 'q4' });
    expect(resolveTag('2026budget', vocabulary)).toEqual({ kind: 'new', tag: '2026budget', from: '2026budget' });
    expect(resolveTag('play', vocabulary)).toEqual({ kind: 'new', tag: 'play', from: 'play' });
    expect(resolveTag('会义', vocabulary)).toEqual({ kind: 'new', tag: '会义', from: '会义' });
    expect(resolveTag('!!!', vocabulary)).toBeNull();
  });

  it('takes the most used, then the latest used, then the first by code point among several one edit away', () => {
    expect(resolveTag('abcdz', [use('abcdx', 2, 5), use('abcdy', 2, 5), use('abcdw', 3, 1)])?.tag).toBe('abcdw');
    expect(resolveTag('abcdz', [use('abcdx', 2, 5), use('abcdy', 2, 9)])?.tag).toBe('abcdy');
    expect(resolveTag('abcdz', [use('abcdy', 2, 5), use('abcdx', 2, 5)])?.tag).toBe('abcdx');
  });
});
