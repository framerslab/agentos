import { describe, expect, it } from 'vitest';
import { Evaluator } from '../Evaluator.js';
import { normalizeTranscript, wordErrorRate } from '../wordErrorRate.js';

describe('normalizeTranscript', () => {
  it('lowers the case, keeps inner apostrophes and numbers as written, and drops punctuation, bracketed marks and filler words', () => {
    expect(normalizeTranscript("Um, the [laughter] cat's 3 mats... uh OK!")).toEqual(['the', "cat's", '3', 'mats', 'ok']);
    expect(normalizeTranscript('')).toEqual([]);
    // U+2019, U+2018 and U+02BC are apostrophes as well: inside a word they keep it whole, at its edges they go
    expect(normalizeTranscript('Don\u2019t \u2018em, rock\u02BCn\u02BCroll')).toEqual(["don't", 'em', "rock'n'roll"]);
    // a combining mark stays with the letter it follows: a Hindi word keeps its vowel signs and stays one word, and a
    // decomposed accent reads as the composed letter; an emoji's variation selector is dropped with the emoji
    expect(normalizeTranscript('\u0915\u093F\u0924\u093E\u092C cafe\u0301 nai\u0308ve I \u2764\uFE0F you')).toEqual(['\u0915\u093F\u0924\u093E\u092C', 'caf\u00E9', 'na\u00EFve', 'i', 'you']);
  });
});

describe('wordErrorRate', () => {
  it('counts a substitution, a deletion and an insertion against the reference', () => {
    expect(wordErrorRate('Hello, world.', 'hello world')).toMatchObject({ substitutions: 0, deletions: 0, insertions: 0, referenceWords: 2, rate: 0 });
    expect(wordErrorRate('the bat sat', 'the cat sat')).toMatchObject({ substitutions: 1, deletions: 0, insertions: 0, rate: 1 / 3 });
    expect(wordErrorRate('the sat', 'the cat sat')).toMatchObject({ substitutions: 0, deletions: 1, insertions: 0, rate: 1 / 3 });
    expect(wordErrorRate('the big cat sat', 'the cat sat')).toMatchObject({ substitutions: 0, deletions: 0, insertions: 1, rate: 1 / 3 });
    // a curly apostrophe against a straight one is no error
    expect(wordErrorRate('I don\u2019t know', "I don't know")).toMatchObject({ substitutions: 0, deletions: 0, insertions: 0, referenceWords: 3, rate: 0 });
    // a changed vowel sign is a substitution, and a decomposed accent against the composed letter is no error
    expect(wordErrorRate('\u0915\u093F', '\u0915')).toMatchObject({ substitutions: 1, deletions: 0, insertions: 0, referenceWords: 1, rate: 1 });
    expect(wordErrorRate('cafe\u0301', 'caf\u00E9')).toMatchObject({ substitutions: 0, deletions: 0, insertions: 0, referenceWords: 1, rate: 0 });
  });

  it('answers 1 for an empty hypothesis, 0 for two empty texts, and the insertions for an empty reference', () => {
    expect(wordErrorRate('', 'the cat sat')).toMatchObject({ deletions: 3, rate: 1 });
    expect(wordErrorRate('', '').rate).toBe(0);
    expect(wordErrorRate('a b', '')).toMatchObject({ insertions: 2, referenceWords: 0, rate: 2 });
  });
});

describe('the word_error_rate scorer', () => {
  it('scores 1 less the rate, never below 0, and 0 with no reference', async () => {
    const evaluator = new Evaluator();
    await expect(evaluator.score('word_error_rate', 'the bat sat', 'the cat sat')).resolves.toBeCloseTo(2 / 3, 6);
    await expect(evaluator.score('word_error_rate', 'x y z w', 'a')).resolves.toBe(0);
    await expect(evaluator.score('word_error_rate', 'anything', undefined)).resolves.toBe(0);
  });
});
