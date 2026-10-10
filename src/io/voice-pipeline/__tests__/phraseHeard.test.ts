import { describe, expect, it, vi } from 'vitest';

// The word rule stays the real one. Each text it is handed is noted, so a test can see how far a text was read.
const read = vi.hoisted(() => ({ texts: [] as string[] }));

vi.mock('../../../cognition/library/tokens.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../cognition/library/tokens.js')>();
  return {
    ...real,
    lexicalTokens: (text: string) => {
      read.texts.push(text);
      return real.lexicalTokens(text);
    },
  };
});

import { lexicalTokens } from '../../../cognition/library/tokens.js';
import { phraseHeard } from '../phraseHeard.js';
import { TranscriptLedger } from '../transcriptLedger.js';

const LINE = "I use a live note assistant. OpenAI turns what we say into text and doesn't keep it beyond its own checks. I'm keeping the transcript in my account. Nothing is recorded as audio. Tell me if you'd rather I didn't.";

describe('phraseHeard', () => {
  it('hears the sentence said across two lines, and names them', () => {
    const result = phraseHeard(LINE, [
      { itemId: 'i1', text: 'OK, so before we start.' },
      { itemId: 'i2', text: 'I use a live note assistant, OpenAI turns what we say into text and does not keep it beyond its own checks.' },
      { itemId: 'i3', text: "I'm keeping the transcript in my account, nothing is recorded as audio. Tell me if you'd rather I didn't." },
    ]);
    expect(result.heard).toBe(true);
    expect(result.ratio).toBeGreaterThanOrEqual(0.8);
    expect(result.itemIds).toEqual(['i2', 'i3']);
  });

  it('does not hear it when fewer than eight words in ten came, or not in order', () => {
    expect(phraseHeard(LINE, [{ itemId: 'i1', text: 'I use a live note assistant. Tell me if you would rather I did not.' }]).heard).toBe(false);
    const shuffled = LINE.split(' ').reverse().join(' ');
    expect(phraseHeard(LINE, [{ itemId: 'i1', text: shuffled }]).heard).toBe(false);
  });

  it('hears 80 words of 100 by default, and not 79', () => {
    const words = Array.from({ length: 100 }, (_, k) => `w${k}`);
    const phrase = words.join(' ');
    expect(phraseHeard(phrase, [{ itemId: 'a', text: words.slice(0, 80).join(' ') }])).toEqual({ heard: true, ratio: 0.8, itemIds: ['a'] });
    expect(phraseHeard(phrase, [{ itemId: 'a', text: words.slice(0, 79).join(' ') }]).heard).toBe(false);
  });

  it('ignores case, punctuation and spacing, and takes another threshold', () => {
    expect(phraseHeard('Hello, World!', [{ itemId: 'a', text: 'hello world' }]).ratio).toBe(1);
    expect(phraseHeard('one two three four five', [{ itemId: 'a', text: 'one two three' }], { threshold: 0.6 }).heard).toBe(true);
  });

  it('reads at most maxWords words of the lines', () => {
    const filler = { itemId: 'f', text: 'filler '.repeat(50) };
    expect(phraseHeard('one two three', [filler, { itemId: 'a', text: 'one two three' }], { maxWords: 40 }).heard).toBe(false);
    expect(phraseHeard('one two three', [filler, { itemId: 'a', text: 'one two three' }], { maxWords: 60 }).heard).toBe(true);
  });

  it('reads a line no further than the last word maxWords takes', () => {
    const long = Array.from({ length: 10_000 }, (_, k) => `w${k}`).join(' ');
    read.texts.length = 0;
    const result = phraseHeard('w1 w2', [{ itemId: 'a', text: long }, { itemId: 'b', text: 'w1 w2' }], { maxWords: 3 });
    expect(result).toEqual({ heard: true, ratio: 1, itemIds: ['a'] });
    // The word rule was handed the phrase, then the three words the cap takes of the long line, and nothing else.
    expect(read.texts).toEqual(['w1 w2', 'w0 w1 w2']);

    // What the cap has left bounds the next line, and a line after the cap is not read.
    read.texts.length = 0;
    phraseHeard('one', [{ itemId: 'a', text: 'one two' }, { itemId: 'b', text: 'three four five six' }, { itemId: 'c', text: 'seven' }], { maxWords: 3 });
    expect(read.texts).toEqual(['one', 'one two', 'three']);

    read.texts.length = 0;
    phraseHeard('one', [{ itemId: 'a', text: long }], { maxWords: 0 });
    expect(read.texts).toEqual(['one']);
  });

  it('reads the words the word rule gives, whatever the cap', () => {
    // Apostrophes, digits, a capital I with a dot (two words in lower case), a combining accent and two scripts.
    const text = "It's 9 o'clock in \u0130stanbul, cafe\u0301 d\u00e9j\u00e0 vu: \u6771\u4eac 2026!";
    const all = lexicalTokens(text);
    expect(all).toEqual(['it', 's', '9', 'o', 'clock', 'in', 'i', 'stanbul', 'cafe', 'd\u00e9j\u00e0', 'vu', '\u6771\u4eac', '2026']);
    for (let cap = 1; cap < all.length; cap += 1) {
      // The phrase holds one word more than the cap: all but that word are found when the first `cap` words are read.
      const phrase = all.slice(0, cap + 1).join(' ');
      expect(phraseHeard(phrase, [{ itemId: 'a', text }], { maxWords: cap }).ratio).toBe(cap / (cap + 1));
    }
    expect(phraseHeard(all.join(' '), [{ itemId: 'a', text }], { maxWords: all.length }).ratio).toBe(1);
  });

  it('refuses an empty phrase', () => {
    expect(() => phraseHeard(' . ', [])).toThrow('no words');
  });

  it('refuses a threshold outside 0 to 1 and a maxWords that is not a whole number, 0 or more', () => {
    for (const threshold of [-0.1, 1.1, Number.NaN]) expect(() => phraseHeard('one', [], { threshold })).toThrow(RangeError);
    for (const maxWords of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => phraseHeard('one', [], { maxWords })).toThrow(RangeError);
    expect(phraseHeard('one', [{ itemId: 'a', text: 'one' }], { threshold: 1 }).heard).toBe(true);
    expect(phraseHeard('one', [{ itemId: 'a', text: 'one' }], { maxWords: 0 })).toEqual({ heard: false, ratio: 0, itemIds: [] });
  });

  it('refuses a phrase of more words than maxPhraseWords, 400 unless set', () => {
    const numbered = (count: number) => Array.from({ length: count }, (_, k) => `w${k}`).join(' ');
    expect(phraseHeard(numbered(400), [{ itemId: 'a', text: numbered(400) }]).ratio).toBe(1);
    expect(() => phraseHeard(numbered(401), [])).toThrow(RangeError);
    expect(() => phraseHeard(numbered(401), [])).toThrow('more than 400 words');
    expect(() => phraseHeard('one two three four', [], { maxPhraseWords: 3 })).toThrow('more than 3 words');
    expect(phraseHeard('one two three', [{ itemId: 'a', text: 'one two three' }], { maxPhraseWords: 3 }).ratio).toBe(1);
    expect(phraseHeard(numbered(401), [{ itemId: 'a', text: numbered(401) }], { maxPhraseWords: 401, maxWords: 401 }).ratio).toBe(1);
    for (const maxPhraseWords of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => phraseHeard('one', [], { maxPhraseWords })).toThrow(RangeError);

    // A phrase over the bound is refused at its first word past it: the word rule is handed no more of it.
    read.texts.length = 0;
    expect(() => phraseHeard(numbered(10_000), [], { maxPhraseWords: 3 })).toThrow(RangeError);
    expect(read.texts).toEqual(['w0 w1 w2 w3']);
  });

  it("reads a TranscriptLedger's final lines as they are", () => {
    const ledger = new TranscriptLedger();
    ledger.apply({ itemId: 'i1', text: 'OK, so before we start.', isFinal: true });
    ledger.apply({ itemId: 'i2', text: 'I use a live note assistant, OpenAI turns what we say into text and does not keep it beyond its own checks.', isFinal: true });
    ledger.apply({ itemId: 'i3', text: "I'm keeping the transcript in my account, nothing is recorded as audio.", isFinal: false });
    expect(phraseHeard(LINE, ledger.finalsAfter(undefined)).heard).toBe(false);
    ledger.apply({ itemId: 'i3', text: "I'm keeping the transcript in my account, nothing is recorded as audio. Tell me if you'd rather I didn't.", isFinal: true });
    expect(phraseHeard(LINE, ledger.finalsAfter(undefined))).toMatchObject({ heard: true, itemIds: ['i2', 'i3'] });
  });
});
