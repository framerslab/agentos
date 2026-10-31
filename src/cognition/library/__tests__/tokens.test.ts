import { describe, expect, it, vi } from 'vitest';
import { defaultWordSegmenter, isUnspacedScript, stemWord, tagSegments } from '../tokens.js';

describe('stemWord', () => {
  it('drops -ing past five letters, -ed and -es past four, -s past three unless -ss', () => {
    expect(stemWord('planning')).toBe('plann');
    expect(stemWord('going')).toBe('going');
    expect(stemWord('planned')).toBe('plann');
    expect(stemWord('boxes')).toBe('box');
    expect(stemWord('roadmaps')).toBe('roadmap');
    expect(stemWord('plans')).toBe('plan');
    expect(stemWord('bus')).toBe('bus');
    expect(stemWord('class')).toBe('class');
  });

  it('keeps words apart that Porter joins', () => {
    expect(stemWord('university')).not.toBe(stemWord('universe'));
  });

  it('holds the four-letter boundary of -ed and -es, and takes -es off a word that then ends in -ss', () => {
    // "used" has four letters, so "-ed" stays; "uses" has four, so "-es" stays and the "-s" rule takes one letter;
    // "glasses" has seven, so "-es" comes off before the "-ss" guard is read
    expect(stemWord('used')).toBe('used');
    expect(stemWord('uses')).toBe('use');
    expect(stemWord('glasses')).toBe('glass');
  });
});

describe('isUnspacedScript', () => {
  it('finds Thai, kana, CJK ideographs and Hangul syllables anywhere in a word', () => {
    for (const word of ['会議', 'ประชุม', 'かいぎ', 'カイギ', '회의', 'meeting会議']) expect(isUnspacedScript(word)).toBe(true);
    for (const word of ['budget', 'किताब', 'كِتَاب', 'q3', '']) expect(isUnspacedScript(word)).toBe(false);
  });

  it('reads each script by its Unicode property, so no block of it is left out', () => {
    // half-width katakana; a compatibility ideograph with no canonical decomposition (U+FA11); a supplementary
    // ideograph (U+20BB7); a number in Thai digits, which sits inside a Thai run; a conjoining jamo (U+1112)
    for (const word of ['ｶｲｷﾞ', '﨑', '𠮷', '๒๕๖๙', 'ᄒ']) expect(isUnspacedScript(word)).toBe(true);
  });

  it('counts the kana marks written in the Common script, so a kana run is not cut at one', () => {
    // the prolonged sound mark (U+30FC) and its half-width form (U+FF70), the half-width voiced and semi-voiced marks
    // (U+FF9E, U+FF9F): letters by the word rule, Common by their Script property, kana by Script_Extensions; a reader
    // of a run character by character must see every character of a kana word as unspaced
    for (const mark of ['\u30FC', '\uFF70', '\uFF9E', '\uFF9F']) expect(isUnspacedScript(mark)).toBe(true);
    for (const word of ['コーヒー', 'ﾗｰﾒﾝ']) for (const char of word) expect(isUnspacedScript(char)).toBe(true);
  });

  it('leaves a word of a spaced script spaced whatever mark or modifier letter it holds', () => {
    // Script_Extensions files the modifier letter apostrophe (U+02BC) and the combining tilde, overline, dot below and
    // macron below (U+0303, U+0305, U+0323, U+0331) under Thai or Katakana; a rule that read it would route a French,
    // a Ukrainian or a transliterated word to substring matching
    for (const word of ['l\u02BChomme', 'nin\u0303o', 'o\u0305', 'a\u0323', 'a\u0331']) expect(isUnspacedScript(word)).toBe(false);
  });

  it('counts the other letters and marks the kana and the ideographs share, each on its own', () => {
    // the closing mark 〆 (U+3006), an ideographic tone mark (U+302A), a vertical kana repeat mark (U+3031), the masu
    // mark 〼 (U+303C), the combining voiced mark (U+3099) and the spacing voiced mark (U+309B): Common or Inherited by
    // their Script property, Han or kana by Script_Extensions, and each named in the constant one by one
    for (const char of ['\u3006', '\u302A', '\u3031', '\u303C', '\u3099', '\u309B']) expect(isUnspacedScript(char)).toBe(true);
  });

  it('leaves the ideographic numerals written in the Common script out: a number is neither script', () => {
    // a parenthesized ideograph one (U+3220), a circled ideograph one (U+3280), a kanbun annotation mark (U+3192) and a
    // counting rod digit (U+1D360): numbers by the word rule, Han by Script_Extensions alone
    for (const char of ['\u3220', '\u3280', '\u3192', '\u{1D360}']) expect(isUnspacedScript(char)).toBe(false);
  });
});

describe('tagSegments', () => {
  const nfc = (text: string): string => text.normalize('NFC');

  it('keeps combining marks inside a word of a spaced script and starts no word with a mark', () => {
    expect(tagSegments('किताब पढ़ो', { wordSegmenter: null }).map((s) => s.text)).toEqual([nfc('किताब'), nfc('पढ़ो')]);
    expect(tagSegments('كِتَاب جَدِيد', { wordSegmenter: null }).map((s) => s.text)).toEqual(['كِتَاب', 'جَدِيد']);
    // a combining acute accent (U+0301) with no letter before it, written as an escape
    expect(tagSegments('\u0301budget review!', { wordSegmenter: null }).map((s) => s.text)).toEqual(['budget', 'review']);
    expect(tagSegments('Café plans', { wordSegmenter: null }).map((s) => s.text)).toEqual(['Café', 'plans']);
  });

  it('says what separates a word from the one before, and cuts a run where its script changes', () => {
    expect(
      tagSegments('Q3-planning budget, 明日のmeeting', { wordSegmenter: null }).map((s) => [s.text, s.gap, s.unspaced, s.unit]),
    ).toEqual([
      ['Q3', 'other', false, 'spaced'],
      ['planning', 'other', false, 'spaced'],
      ['budget', 'space', false, 'spaced'],
      ['明', 'other', true, 'grapheme'],
      ['日', 'none', true, 'grapheme'],
      ['の', 'none', true, 'grapheme'],
      ['meeting', 'none', false, 'spaced'],
    ]);
    // a digit belongs to the script around it: an unspaced run holds its digits, and a spaced word its own
    expect(tagSegments('3月の会議', { wordSegmenter: null }).map((s) => [s.text, s.unspaced])).toEqual([['3', true], ['月', true], ['の', true], ['会', true], ['議', true]]);
    expect(tagSegments('明日3時に', { wordSegmenter: null }).map((s) => s.unspaced)).toEqual([true, true, true, true, true]);
    expect(tagSegments('q3 2026budget', { wordSegmenter: null }).map((s) => [s.text, s.unspaced])).toEqual([['q3', false], ['2026budget', false]]);
  });

  it('keeps a run whole across a character two of its scripts share', () => {
    expect(tagSegments('ラーメン屋', { wordSegmenter: null }).map((s) => [s.text, s.unspaced])).toEqual([['ラ', true], ['ー', true], ['メ', true], ['ン', true], ['屋', true]]);
    const words = (run: string): string[] => (run === 'ラーメン屋' ? ['ラーメン', '屋'] : [run]);
    expect(tagSegments('ラーメン屋', { wordSegmenter: words }).map((s) => [s.text, s.unit])).toEqual([['ラーメン', 'word'], ['屋', 'word']]);
  });

  it('cuts an unspaced part with the word segmenter it is given, its places in the normalized text', () => {
    const words = (run: string): string[] => (run === '明日の会議資料' ? ['明日', 'の', '会議', '資料'] : [run]);
    const segments = tagSegments('明日の会議資料。', { wordSegmenter: words });
    expect(segments.map((s) => [s.text, s.start, s.end, s.unit, s.gap])).toEqual([
      ['明日', 0, 2, 'word', 'other'],
      ['の', 2, 3, 'word', 'none'],
      ['会議', 3, 5, 'word', 'none'],
      ['資料', 5, 7, 'word', 'none'],
    ]);
  });

  it('takes Intl.Segmenter by default where the runtime has it', () => {
    const has = typeof (Intl as unknown as { Segmenter?: unknown }).Segmenter === 'function';
    expect(defaultWordSegmenter() !== null).toBe(has);
    expect(tagSegments('明日の会議資料').map((s) => s.text).join('')).toBe('明日の会議資料');
  });

  it('cuts an unspaced part into grapheme clusters where the runtime has no Intl at all', async () => {
    // A fresh copy of the module, imported first: it looks for a segmenter on the first ask, which runs with no Intl.
    vi.resetModules();
    const fresh = await import('../tokens.js');
    let found: unknown = 'not asked';
    let pieces: string[][] = [];
    vi.stubGlobal('Intl', undefined);
    try {
      found = fresh.defaultWordSegmenter();
      pieces = fresh.tagSegments('明日の会議').map((s) => [s.text, s.unit]);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
    expect(found).toBeNull();
    expect(pieces).toEqual([['明', 'grapheme'], ['日', 'grapheme'], ['の', 'grapheme'], ['会', 'grapheme'], ['議', 'grapheme']]);
  });
});
