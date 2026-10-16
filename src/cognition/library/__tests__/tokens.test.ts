import { describe, expect, it } from 'vitest';
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
});
