import { describe, expect, it } from 'vitest';
import { graphemeClusters } from '../graphemes.js';

describe('graphemeClusters', () => {
  it('keeps a base with its marks, its joiner and its selectors, and a pair of regional indicators', () => {
    expect(graphemeClusters('किताब')).toEqual(['कि', 'ता', 'ब']);
    expect(graphemeClusters('كِتَاب')).toEqual(['كِ', 'تَ', 'ا', 'ب']);
    expect(graphemeClusters('ประชุม')).toEqual(['ป', 'ร', 'ะ', 'ชุ', 'ม']);
    expect(graphemeClusters('éa')).toEqual(['é', 'a']);
    // the zero width joiner is written as an escape: the lint step strips the character itself from a source file
    expect(graphemeClusters('\u{1F469}‍\u{1F4BB}x')).toEqual(['\u{1F469}‍\u{1F4BB}', 'x']);
    expect(graphemeClusters('\u{1F1EB}\u{1F1F7}\u{1F1E9}\u{1F1EA}')).toEqual(['\u{1F1EB}\u{1F1F7}', '\u{1F1E9}\u{1F1EA}']);
    expect(graphemeClusters('a\r\nb')).toEqual(['a', '\r\n', 'b']);
    expect(graphemeClusters('明日の会議')).toEqual(['明', '日', 'の', '会', '議']);
    expect(graphemeClusters('')).toEqual([]);
  });

  it('answers what Intl.Segmenter answers for these scripts, where the runtime has it', () => {
    const Segmenter = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: 'grapheme' }) => { segment(text: string): Iterable<{ segment: string }> } }).Segmenter;
    if (typeof Segmenter !== 'function') return;
    const segmenter = new Segmenter(undefined, { granularity: 'grapheme' });
    for (const text of ['किताब', 'كِتَاب', 'ประชุมพรุ่งนี้', 'éa', '明日の会議資料', 'q3 planning', '회의']) {
      expect(graphemeClusters(text)).toEqual(Array.from(segmenter.segment(text), (part) => part.segment));
    }
  });
});
