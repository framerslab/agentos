import { describe, expect, it } from 'vitest';
import { NoOpStemmer } from '../stemmers/NoOpStemmer';
import { PorterStemmer } from '../stemmers/PorterStemmer';
import { NoOpLemmatizer } from '../lemmatizers/NoOpLemmatizer';
import { WordNetLemmatizer } from '../lemmatizers/WordNetLemmatizer';
import { getNaturalModule } from '../naturalInterop';
import { StopWordFilter, ENGLISH_STOP_WORDS, CODE_STOP_WORDS, getNaturalStopWords } from '../filters/StopWordFilter';
import { LowercaseNormalizer } from '../normalizers/LowercaseNormalizer';
import { AccentStripper } from '../normalizers/AccentStripper';
import type { Token } from '../types';

function makeTokens(words: string[]): Token[] {
  let pos = 0;
  return words.map(w => {
    const t: Token = { text: w, original: w, position: pos };
    pos += w.length + 1;
    return t;
  });
}

describe('NoOpStemmer', () => {
  it('returns tokens unchanged', () => {
    const stemmer = new NoOpStemmer();
    const tokens = makeTokens(['running', 'foxes', 'kubernetes']);
    const result = stemmer.process(tokens);
    expect(result.map(t => t.text)).toEqual(['running', 'foxes', 'kubernetes']);
  });

  it('has the correct name', () => {
    expect(new NoOpStemmer().name).toBe('NoOpStemmer');
  });
});

describe('NoOpLemmatizer', () => {
  it('returns tokens unchanged', () => {
    const lemmatizer = new NoOpLemmatizer();
    const tokens = makeTokens(['ran', 'better', 'mice']);
    const result = lemmatizer.process(tokens);
    expect(result.map(t => t.text)).toEqual(['ran', 'better', 'mice']);
  });
});

describe('WordNetLemmatizer', () => {
  it('sets the lemma, and the text, to the Lancaster stem: it looks nothing up in WordNet', () => {
    const lancaster = getNaturalModule()?.LancasterStemmer;
    expect(lancaster).toBeDefined();
    const words = ['mice', 'better', 'running'];
    const result = new WordNetLemmatizer().process(makeTokens(words));
    expect(result.map((t) => t.lemma)).toEqual(words.map((word) => lancaster!.stem(word)));
    expect(result.map((t) => t.text)).toEqual(result.map((t) => t.lemma));
    // A dictionary lemmatizer would answer mouse and good.
    expect(result.map((t) => t.lemma)).not.toContain('mouse');
    expect(result.map((t) => t.lemma)).not.toContain('good');
  });
});

describe('LowercaseNormalizer', () => {
  it('lowercases token text', () => {
    const normalizer = new LowercaseNormalizer();
    const tokens = makeTokens(['Hello', 'WORLD', 'FooBar']);
    const result = normalizer.process(tokens);
    expect(result.map(t => t.text)).toEqual(['hello', 'world', 'foobar']);
  });

  it('preserves original', () => {
    const normalizer = new LowercaseNormalizer();
    const tokens = makeTokens(['Hello']);
    const result = normalizer.process(tokens);
    expect(result[0].original).toBe('Hello');
    expect(result[0].text).toBe('hello');
  });
});

describe('AccentStripper', () => {
  it('removes diacritics', () => {
    const stripper = new AccentStripper();
    const tokens = makeTokens(['café', 'naïve', 'über', 'résumé']);
    const result = stripper.process(tokens);
    expect(result.map(t => t.text)).toEqual(['cafe', 'naive', 'uber', 'resume']);
  });

  it('leaves ASCII text unchanged', () => {
    const stripper = new AccentStripper();
    const tokens = makeTokens(['hello', 'world']);
    const result = stripper.process(tokens);
    expect(result.map(t => t.text)).toEqual(['hello', 'world']);
  });
});

describe('StopWordFilter', () => {
  it('filters English stop words', () => {
    const filter = new StopWordFilter(ENGLISH_STOP_WORDS);
    const tokens = makeTokens(['the', 'quick', 'brown', 'fox', 'is', 'running']);
    const result = filter.process(tokens);
    expect(result.map(t => t.text)).toEqual(['quick', 'brown', 'fox', 'running']);
  });

  it('code stop words preserve programming keywords', () => {
    const filter = new StopWordFilter(CODE_STOP_WORDS);
    const tokens = makeTokens(['the', 'function', 'class', 'is', 'import', 'return']);
    const result = filter.process(tokens);
    // 'the' and 'is' are code stop words, but 'function', 'class', 'import', 'return' are NOT
    expect(result.map(t => t.text)).toContain('function');
    expect(result.map(t => t.text)).toContain('class');
    expect(result.map(t => t.text)).toContain('import');
    expect(result.map(t => t.text)).toContain('return');
    expect(result.map(t => t.text)).not.toContain('the');
    expect(result.map(t => t.text)).not.toContain('is');
  });

  it('accepts custom stop word set', () => {
    const custom = new Set(['foo', 'bar']);
    const filter = new StopWordFilter(custom);
    const tokens = makeTokens(['foo', 'baz', 'bar', 'qux']);
    const result = filter.process(tokens);
    expect(result.map(t => t.text)).toEqual(['baz', 'qux']);
  });

  it('defaults to getNaturalStopWords (>= 120 words)', () => {
    const filter = new StopWordFilter();
    const tokens = makeTokens(['the', 'cat']);
    const result = filter.process(tokens);
    expect(result.map(t => t.text)).toEqual(['cat']);
  });
});

describe('PorterStemmer', () => {
  it('has the correct name', () => {
    expect(new PorterStemmer().name).toBe('PorterStemmer');
  });

  it('stems English words when natural is available', async () => {
    const stemmer = new PorterStemmer();
    await stemmer.initialize();

    const tokens = makeTokens(['running', 'foxes', 'connected', 'easily']);
    const result = stemmer.process(tokens);

    /* natural's Porter stemmer should reduce these */
    expect(result[0].text).not.toBe('running'); /* should be 'run' or similar */
    expect(result[0].stem).toBeDefined();
    expect(result[0].original).toBe('running');
    /* Each token should have both .text (stemmed) and .stem set */
    for (const t of result) {
      expect(t.stem).toBe(t.text);
    }
  });

  it('sets stem field on each token', async () => {
    const stemmer = new PorterStemmer();
    await stemmer.initialize();

    const tokens = makeTokens(['playing']);
    const result = stemmer.process(tokens);
    expect(result[0].stem).toBeDefined();
    expect(typeof result[0].stem).toBe('string');
  });

  it('preserves original text', async () => {
    const stemmer = new PorterStemmer();
    await stemmer.initialize();

    const tokens = makeTokens(['universities']);
    const result = stemmer.process(tokens);
    expect(result[0].original).toBe('universities');
    expect(result[0].text).not.toBe('universities'); /* should be stemmed */
  });
});

describe('getNaturalStopWords', () => {
  it('returns a Set with >= 120 words', () => {
    const stopWords = getNaturalStopWords();
    expect(stopWords.size).toBeGreaterThanOrEqual(120);
  });

  it('contains common English stop words', () => {
    const stopWords = getNaturalStopWords();
    expect(stopWords.has('the')).toBe(true);
    expect(stopWords.has('is')).toBe(true);
    expect(stopWords.has('and')).toBe(true);
    expect(stopWords.has('of')).toBe(true);
  });

  it('does NOT contain content words', () => {
    const stopWords = getNaturalStopWords();
    expect(stopWords.has('computer')).toBe(false);
    expect(stopWords.has('algorithm')).toBe(false);
    expect(stopWords.has('function')).toBe(false);
  });

  it('returns the same Set instance on repeated calls (cached)', () => {
    const a = getNaturalStopWords();
    const b = getNaturalStopWords();
    expect(a).toBe(b); /* same reference — singleton */
  });

  it('prefers natural library (170 words) when available', () => {
    const stopWords = getNaturalStopWords();
    /* natural is in agentos dependencies, so it should be available */
    /* natural.stopwords has 170 entries */
    expect(stopWords.size).toBeGreaterThanOrEqual(170);
  });
});
