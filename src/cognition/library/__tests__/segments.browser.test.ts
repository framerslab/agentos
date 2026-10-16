import { describe, expect, it } from 'vitest';
import { graphemeClusters } from '../graphemes.js';
import { tagSegments } from '../tokens.js';

/** Where a text's grapheme clusters start and end. */
function boundaries(text: string): Set<number> {
  const found = new Set([0]);
  let at = 0;
  for (const cluster of graphemeClusters(text)) {
    at += cluster.length;
    found.add(at);
  }
  return found;
}

describe("the tag rules' words in a browser", () => {
  it('keeps the vowel marks of Devanagari and Arabic inside their words, with the browser word segmenter and without', () => {
    for (const wordSegmenter of [undefined, null] as const) {
      expect(tagSegments('किताब कहाँ है', { wordSegmenter }).map((s) => s.text)).toEqual(['किताब', 'कहाँ', 'है'].map((word) => word.normalize('NFC')));
      expect(tagSegments('كِتَاب مُفِيد', { wordSegmenter }).map((s) => s.text)).toEqual(['كِتَاب', 'مُفِيد']);
    }
  });

  it('cuts Chinese, Japanese and Thai runs into whole pieces that join back into the run', () => {
    for (const wordSegmenter of [undefined, null] as const) {
      for (const run of ['明日の会議資料', 'かいぎのしりょう', 'ประชุมพรุ่งนี้']) {
        const pieces = tagSegments(run, { wordSegmenter });
        const edges = boundaries(run);
        expect(pieces.map((piece) => piece.text).join('')).toBe(run);
        for (const piece of pieces) {
          expect(edges.has(piece.start)).toBe(true);
          expect(edges.has(piece.end)).toBe(true);
        }
      }
    }
  });
});
