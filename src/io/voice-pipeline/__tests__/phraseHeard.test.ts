import { describe, expect, it } from 'vitest';

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

  it('refuses an empty phrase', () => {
    expect(() => phraseHeard(' . ', [])).toThrow('no words');
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
