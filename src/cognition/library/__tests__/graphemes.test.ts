import { describe, expect, it } from 'vitest';
import { graphemeClusters } from '../graphemes.js';

describe('graphemeClusters', () => {
  it('keeps a base with its marks, its joiner and its selectors, and a pair of regional indicators', () => {
    expect(graphemeClusters('किताब')).toEqual(['कि', 'ता', 'ब']);
    expect(graphemeClusters('كِتَاب')).toEqual(['كِ', 'تَ', 'ا', 'ب']);
    expect(graphemeClusters('ประชุม')).toEqual(['ป', 'ร', 'ะ', 'ชุ', 'ม']);
    expect(graphemeClusters('éa')).toEqual(['é', 'a']);
    // the zero width joiner is written as an escape: the lint step strips the character itself from a source file
    expect(graphemeClusters('\u{1F469}\u200D\u{1F4BB}x')).toEqual(['\u{1F469}\u200D\u{1F4BB}', 'x']);
    expect(graphemeClusters('\u{1F1EB}\u{1F1F7}\u{1F1E9}\u{1F1EA}')).toEqual(['\u{1F1EB}\u{1F1F7}', '\u{1F1E9}\u{1F1EA}']);
    expect(graphemeClusters('a\r\nb')).toEqual(['a', '\r\n', 'b']);
    expect(graphemeClusters('明日の会議')).toEqual(['明', '日', 'の', '会', '議']);
    expect(graphemeClusters('')).toEqual([]);
  });

  it('keeps the half-width voiced and semi-voiced sound marks with the kana before them', () => {
    // U+FF9E and U+FF9F are letters by the word rule and extending characters by the grapheme break property, so a
    // reader sees ｶﾞ as one character; the prolonged sound mark (U+FF70) is a letter of its own
    expect(graphemeClusters('ｶﾞｷﾞ')).toEqual(['ｶﾞ', 'ｷﾞ']);
    expect(graphemeClusters('ﾊﾟｿｺﾝ')).toEqual(['ﾊﾟ', 'ｿ', 'ｺ', 'ﾝ']);
    expect(graphemeClusters('ﾗｰﾒﾝ')).toEqual(['ﾗ', 'ｰ', 'ﾒ', 'ﾝ']);
  });

  it('follows the Hangul syllable rules, and joins a pictograph after the joiner only to a pictograph before it', () => {
    // a precomposed LV syllable before a final consonant (U+AC00 U+11A8); three jamo, then two; a leading consonant
    // before another; an LVT syllable before a vowel, which breaks (UAX #29, GB6 to GB8)
    expect(graphemeClusters('\u{AC00}\u{11A8}')).toEqual(['\u{AC00}\u{11A8}']);
    expect(graphemeClusters('\u{1100}\u{1161}\u{11A8}\u{1100}\u{1161}')).toEqual(['\u{1100}\u{1161}\u{11A8}', '\u{1100}\u{1161}']);
    expect(graphemeClusters('\u{1100}\u{1100}\u{1161}')).toEqual(['\u{1100}\u{1100}\u{1161}']);
    expect(graphemeClusters('\u{AC01}\u{1161}')).toEqual(['\u{AC01}', '\u{1161}']);
    // the joiner closes its cluster after a letter; after a pictograph and its emoji modifier it joins the pictograph
    // that follows (GB11); the joiner is written as an escape, since the lint step strips the character itself
    expect(graphemeClusters('a\u{200D}\u{1F469}')).toEqual(['a\u{200D}', '\u{1F469}']);
    expect(graphemeClusters('\u{1F469}\u{1F3FD}\u{200D}\u{1F4BB}')).toEqual(['\u{1F469}\u{1F3FD}\u{200D}\u{1F4BB}']);
  });

  it('answers what Intl.Segmenter answers for these scripts, where the runtime has it', () => {
    const Segmenter = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: 'grapheme' }) => { segment(text: string): Iterable<{ segment: string }> } }).Segmenter;
    if (typeof Segmenter !== 'function') return;
    const segmenter = new Segmenter(undefined, { granularity: 'grapheme' });
    const texts = [
      'किताब', 'كِتَاب', 'ประชุมพรุ่งนี้', 'éa', '明日の会議資料', 'q3 planning', '회의', 'ｶﾞｷﾞｸﾞ', 'ﾊﾟｿｺﾝ', 'ﾗｰﾒﾝ', 'コーヒー',
      '\u{AC00}\u{11A8}', '\u{1100}\u{1161}\u{11A8}\u{1100}\u{1161}', '\u{1100}\u{1100}\u{1161}', '\u{AC01}\u{1161}', 'a\u{200D}\u{1F469}', '\u{1F469}\u{1F3FD}\u{200D}\u{1F4BB}',
    ];
    for (const text of texts) {
      expect(graphemeClusters(text)).toEqual(Array.from(segmenter.segment(text), (part) => part.segment));
    }
  });
});
