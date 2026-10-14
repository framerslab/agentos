import { describe, expect, it } from 'vitest';
import { phraseMatches, type PhraseEntry } from '../builtin/PhraseListGuardrail';

const entries: PhraseEntry[] = [
  { phrase: 'coming soon', match: 'word', onMatch: 'block', ruleId: 'timing' },
  { phrase: 'next', match: 'word', onMatch: 'block', ruleId: 'timing' },
  { phrase: 'in\\s+build', match: 'regex', onMatch: 'block', ruleId: 'stage' },
];

describe('phraseMatches', () => {
  it('matches under the guard\'s normalisation: case, look-alike letters, zero-width characters and whitespace', () => {
    // An escape, not the character: `pnpm run lint` (scripts/strip-nbsp.mjs) deletes literal zero-width characters under src, and CI lints before it tests.
    expect(phraseMatches(entries, 'Coming\u200B   Soon to every plan').map((e) => e.ruleId)).toEqual(['timing']);
    expect(phraseMatches(entries, 'It opens nеxt.').map((e) => e.phrase)).toEqual(['next']);
  });
  it('keeps word boundaries for word entries and runs regex entries over the normalised text', () => {
    expect(phraseMatches(entries, 'The nextcloud connector')).toEqual([]);
    expect(phraseMatches(entries, 'Live checks are IN BUILD').map((e) => e.ruleId)).toEqual(['stage']);
  });
  it('returns nothing for a text with no listed phrase and never calls a judge', () => {
    expect(phraseMatches([{ phrase: 'soon', match: 'word', onMatch: 'judge' }], 'Built today.')).toEqual([]);
  });
});
