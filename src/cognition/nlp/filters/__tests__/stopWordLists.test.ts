import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CODE_STOP_WORDS as codeFromFilter, ENGLISH_STOP_WORDS as englishFromFilter } from '../StopWordFilter.js';
import { CODE_STOP_WORDS, ENGLISH_STOP_WORDS } from '../stopWordLists.js';

describe('the stop-word lists', () => {
  it('are the sets StopWordFilter exports', () => {
    expect(englishFromFilter).toBe(ENGLISH_STOP_WORDS);
    expect(codeFromFilter).toBe(CODE_STOP_WORDS);
    expect(ENGLISH_STOP_WORDS.has('the')).toBe(true);
    expect(ENGLISH_STOP_WORDS.has('yourselves')).toBe(true);
    expect(CODE_STOP_WORDS.has('also')).toBe(true);
    expect(CODE_STOP_WORDS.has('class')).toBe(false);
  });

  it('live in a module that imports nothing, so a page can load them', () => {
    const source = readFileSync(new URL('../stopWordLists.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/^\s*(?:import|export)\s[^;]*\sfrom\s/m);
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});
