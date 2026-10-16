import { describe, expect, it } from 'vitest';
import { isUnspacedScript, stemWord } from '../tokens.js';

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
