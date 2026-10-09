/**
 * @module AgentOS/Evaluation/wordErrorRate
 * The word error rate of a transcript against a reference, after one normalisation for every system: Unicode's
 * composed form (NFC); lower case; letters, digits and a word's inner apostrophe kept, with the combining marks on
 * them (an accent, a vowel sign), the typographic apostrophes (U+2019, U+2018, U+02BC) read as `'`; other
 * punctuation, symbols, bracketed marks (`[laughter]`) and filler words dropped; numbers left as written. The count
 * is a word-level edit distance's substitutions, deletions and insertions, and the rate their sum over the
 * reference's word count.
 */

/** The filler words dropped before counting. */
const FILLERS = new Set(['um', 'uh', 'er', 'ah', 'hmm', 'mm']);

/** What {@link wordErrorRate} counts. */
export interface WordErrorRateCounts {
  substitutions: number;
  deletions: number;
  insertions: number;
  /** The reference's words after normalisation. */
  referenceWords: number;
  /** `(substitutions + deletions + insertions) / max(referenceWords, 1)`. */
  rate: number;
}

/** A text's words under the one normalisation. */
export function normalizeTranscript(text: string): string[] {
  return text
    // one Unicode form, so a letter written as one code point (U+00E9) and as a letter and a combining mark
    // (e, U+0301) is the same string
    .normalize('NFC')
    .toLowerCase()
    // U+2019 is the apostrophe of typeset text and U+0027 the keyboard's; reading U+2019, U+2018 and U+02BC as
    // U+0027 keeps a curly "don't" one word, so a system that prints curly apostrophes is not charged for them
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/\[[^\]]*\]/g, ' ')
    // a combining mark (an accent, a vowel sign) stays with the letter or digit it follows, so a vowel sign is part
    // of its word; a mark on a dropped character, such as an emoji's variation selector, is dropped with it
    .replace(/(?:[^\p{L}\p{M}\p{N}']\p{M}*)+/gu, ' ')
    .split(' ')
    .map((word) => word.replace(/^'+|'+$/g, ''))
    .filter((word) => word !== '' && !FILLERS.has(word));
}

/** The word error rate of `hypothesis` against `reference`, with its counts. */
export function wordErrorRate(hypothesis: string, reference: string): WordErrorRateCounts {
  const h = normalizeTranscript(hypothesis);
  const r = normalizeTranscript(reference);
  // cost[i][j]: the cheapest edit of r's first i words into h's first j, with the counts it took
  type Cell = { cost: number; s: number; d: number; i: number };
  let previous: Cell[] = h.map((_, j) => ({ cost: j + 1, s: 0, d: 0, i: j + 1 }));
  previous.unshift({ cost: 0, s: 0, d: 0, i: 0 });
  for (let i = 1; i <= r.length; i += 1) {
    const row: Cell[] = [{ cost: i, s: 0, d: i, i: 0 }];
    for (let j = 1; j <= h.length; j += 1) {
      const same = r[i - 1] === h[j - 1];
      const diagonal = previous[j - 1]!;
      const up = previous[j]!;
      const left = row[j - 1]!;
      const options: Cell[] = [
        { cost: diagonal.cost + (same ? 0 : 1), s: diagonal.s + (same ? 0 : 1), d: diagonal.d, i: diagonal.i },
        { cost: up.cost + 1, s: up.s, d: up.d + 1, i: up.i },
        { cost: left.cost + 1, s: left.s, d: left.d, i: left.i + 1 },
      ];
      row.push(options.reduce((best, option) => (option.cost < best.cost ? option : best)));
    }
    previous = row;
  }
  const last = previous[h.length]!;
  return {
    substitutions: last.s,
    deletions: last.d,
    insertions: last.i,
    referenceWords: r.length,
    rate: (last.s + last.d + last.i) / Math.max(r.length, 1),
  };
}
