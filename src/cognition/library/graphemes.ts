/**
 * @file graphemes.ts
 * @description What a reader sees as one character, without `Intl.Segmenter`: a base with the marks, the joiner and
 * the selectors that attach to it. A subset of Unicode's extended grapheme clusters (UAX #29) covering the scripts the
 * tag rules cut: combining marks (`\p{M}`) and the spacing vowels Thai and Lao write after a consonant (U+0E33, U+0EB3);
 * the half-width kana's voiced and semi-voiced sound marks (U+FF9E, U+FF9F), letters that extend the kana before them;
 * the zero width joiner, and the pictograph after it when a pictograph stands before it; the zero width non-joiner;
 * variation selectors, emoji modifiers and tag characters; a pair of regional indicators; Hangul's syllable rules (a
 * leading consonant before another, a vowel or a syllable; a vowel or an LV syllable before a vowel or a final
 * consonant; a final consonant or an LVT syllable before a final consonant); and CR LF. It imports nothing.
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
 * (U+0E33, U+0EB3); the half-width kana's voiced and semi-voiced sound marks (U+FF9E, U+FF9F), which Unicode's grapheme
 * break property files as extending characters though the word rule reads them as letters, so `ｶﾞ` is one cluster as
 * `Intl.Segmenter` cuts it; the zero width non-joiner (U+200C); a variation selector (U+FE00 to U+FE0F); an emoji
 * modifier (U+1F3FB to U+1F3FF); a tag character (U+E0020 to U+E007F); a variation selector supplement (U+E0100 to
 * U+E01EF). Tested by code point, one range at a time: a character class that puts a mark after a non-mark, or a
 * modifier after a selector, is what ESLint's no-misleading-character-class (in the recommended set the repository
 * lints with) reports.
 */
function joinsBefore(char: string): boolean {
  if (MARK.test(char)) return true;
  const point = char.codePointAt(0) ?? 0;
  return (
    point === 0x0e33 ||
    point === 0x0eb3 ||
    point === 0xff9e ||
    point === 0xff9f ||
    point === 0x200c ||
    (point >= 0xfe00 && point <= 0xfe0f) ||
    (point >= 0x1f3fb && point <= 0x1f3ff) ||
    (point >= 0xe0020 && point <= 0xe007f) ||
    (point >= 0xe0100 && point <= 0xe01ef)
  );
}

/** A regional indicator, two of which spell a flag. */
const REGIONAL = /^[\u{1F1E6}-\u{1F1FF}]$/u;

/** A pictograph (`\p{Extended_Pictographic}`), which the zero width joiner joins to the pictograph before it. */
const PICTOGRAPH = /^\p{Extended_Pictographic}$/u;

/**
 * A cluster that ends in a pictograph, its extending characters (`\p{Grapheme_Extend}`, or an emoji modifier) and the
 * zero width joiner: a pictograph after the joiner joins it (UAX #29's rule GB11). After anything else the joiner
 * closes its cluster, so a letter, the joiner and a pictograph are two clusters, as `Intl.Segmenter` cuts them.
 */
const PICTOGRAPH_THEN_JOINER = /\p{Extended_Pictographic}(?:\p{Grapheme_Extend}|\p{Emoji_Modifier})*\u{200D}$/u;

/**
 * A Hangul character's syllable type (Unicode's `Hangul_Syllable_Type`): a leading consonant (L), a medial vowel (V), a
 * final consonant (T), a precomposed syllable of a leading consonant and a vowel (LV, every 28th code point from
 * U+AC00) or of all three (LVT); null for any other character.
 */
function hangulType(char: string): 'L' | 'V' | 'T' | 'LV' | 'LVT' | null {
  const point = char.codePointAt(0) ?? 0;
  if ((point >= 0x1100 && point <= 0x115f) || (point >= 0xa960 && point <= 0xa97c)) return 'L';
  if ((point >= 0x1160 && point <= 0x11a7) || (point >= 0xd7b0 && point <= 0xd7c6)) return 'V';
  if ((point >= 0x11a8 && point <= 0x11ff) || (point >= 0xd7cb && point <= 0xd7fb)) return 'T';
  if (point >= 0xac00 && point <= 0xd7a3) return (point - 0xac00) % 28 === 0 ? 'LV' : 'LVT';
  return null;
}

/**
 * Whether two Hangul characters stay in one cluster (UAX #29's rules GB6 to GB8): a leading consonant before another,
 * a vowel or a syllable; a vowel or an LV syllable before a vowel or a final consonant; a final consonant or an LVT
 * syllable before a final consonant.
 */
function hangulJoins(before: string, after: string): boolean {
  const first = hangulType(before);
  const second = hangulType(after);
  if (first === null || second === null) return false;
  if (first === 'L') return second !== 'T';
  if (first === 'V' || first === 'LV') return second === 'V' || second === 'T';
  return second === 'T';
}

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
        (previous === ZWJ && PICTOGRAPH.test(char) && PICTOGRAPH_THEN_JOINER.test(current)) ||
        (previous === '\r' && char === '\n') ||
        (regional && regionals % 2 === 1) ||
        hangulJoins(previous, char));
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
