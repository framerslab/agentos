/**
 * @file graphemes.ts
 * @description What a reader sees as one character, without `Intl.Segmenter`: a base with the marks, the joiner and
 * the selectors that attach to it. A subset of Unicode's extended grapheme clusters (UAX #29) covering the scripts the
 * tag rules cut: combining marks (`\p{M}`) and the spacing vowels Thai and Lao write after a consonant (U+0E33, U+0EB3);
 * the zero width joiner and the character after it; the zero width non-joiner; variation selectors, emoji modifiers
 * and tag characters; a pair of regional indicators; Hangul's medial vowels and final consonants after a leading
 * consonant or a vowel; and CR LF. It imports nothing.
 *
 * @module agentos/cognition/library/graphemes
 */

/** A combining mark (`\p{M}`), which joins the character it follows. */
const MARK = /^\p{M}$/u;

/**
 * The zero width joiner (U+200D), which joins the character after it to the one before. Written as an escape: the lint
 * step strips the character itself from a source file.
 */
const ZWJ = '\u200D';

/**
 * A character that joins the cluster before it: a combining mark; the spacing vowels Thai and Lao write after a consonant
 * (U+0E33, U+0EB3); the zero width non-joiner (U+200C); a variation selector (U+FE00 to U+FE0F); an emoji modifier
 * (U+1F3FB to U+1F3FF); a tag character (U+E0020 to U+E007F); a variation selector supplement (U+E0100 to U+E01EF).
 * Tested by code point, one range at a time: a character class that puts a mark after a non-mark, or a modifier after a
 * selector, is what ESLint's no-misleading-character-class (in the recommended set the repository lints with) reports.
 */
function joinsBefore(char: string): boolean {
  if (MARK.test(char)) return true;
  const point = char.codePointAt(0) ?? 0;
  return (
    point === 0x0e33 ||
    point === 0x0eb3 ||
    point === 0x200c ||
    (point >= 0xfe00 && point <= 0xfe0f) ||
    (point >= 0x1f3fb && point <= 0x1f3ff) ||
    (point >= 0xe0020 && point <= 0xe007f) ||
    (point >= 0xe0100 && point <= 0xe01ef)
  );
}

/** A regional indicator, two of which spell a flag. */
const REGIONAL = /^[\u{1F1E6}-\u{1F1FF}]$/u;

/** A Hangul leading consonant, or a medial vowel or final consonant. */
const JAMO_LEADING = /^[\u{1100}-\u{115F}\u{A960}-\u{A97C}]$/u;
const JAMO_FOLLOWING = /^[\u{1160}-\u{11FF}\u{D7B0}-\u{D7FB}]$/u;

/** The text's grapheme clusters, in order; joined they are the text. */
export function graphemeClusters(text: string): string[] {
  const clusters: string[] = [];
  let current = '';
  let previous = '';
  let regionals = 0;
  for (const char of text) {
    const regional = REGIONAL.test(char);
    const joins =
      current !== '' &&
      (joinsBefore(char) ||
        char === ZWJ ||
        previous === ZWJ ||
        (previous === '\r' && char === '\n') ||
        (regional && regionals % 2 === 1) ||
        ((JAMO_LEADING.test(previous) || JAMO_FOLLOWING.test(previous)) && JAMO_FOLLOWING.test(char)));
    if (joins) {
      current += char;
    } else {
      if (current !== '') clusters.push(current);
      current = char;
    }
    regionals = regional ? (joins ? regionals + 1 : 1) : 0;
    previous = char;
  }
  if (current !== '') clusters.push(current);
  return clusters;
}
