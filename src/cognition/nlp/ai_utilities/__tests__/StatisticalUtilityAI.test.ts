import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StatisticalUtilityAI, StatisticalUtilityAIConfig } from '../StatisticalUtilityAI';
import { IUtilityAI, TokenizationOptions, SummarizationOptions } from '../IUtilityAI';

const defaultConfig: StatisticalUtilityAIConfig = {
  utilityId: 'test-stat-utility',
  defaultLanguage: 'en',
  // No resourcePath needed for these basic tests using default internal resources
};

describe('StatisticalUtilityAI', () => {
  let statUtility: IUtilityAI;

  beforeEach(async () => {
    statUtility = new StatisticalUtilityAI();
    await statUtility.initialize(defaultConfig);
  });

  it('should be defined and initialize without errors', () => {
    expect(statUtility).toBeDefined();
    expect(statUtility.utilityId).toContain('stat-utility');
  });

  it('should tokenize text into words', async () => {
    const text = "This is a test sentence.";
    const options: TokenizationOptions = { type: 'word', toLowerCase: true, removePunctuation: true };
    const tokens = await statUtility.tokenize(text, options);
    expect(tokens).toEqual(['this', 'is', 'a', 'test', 'sentence']);
  });

  it('should tokenize text into sentences', async () => {
    const text = "First sentence. Second sentence! Third sentence?";
    const options: TokenizationOptions = { type: 'sentence' };
    const sentences = await statUtility.tokenize(text, options);
    expect(sentences).toEqual([
      "First sentence.",
      "Second sentence!",
      "Third sentence?"
    ]);
  });

  it('keeps the letters of any script, an accent included, inside one word', async () => {
    expect(await statUtility.tokenize('Привет мир, café crème')).toEqual(['привет', 'мир', 'café', 'crème']);
    // A letter and its accent written as two code points read as one letter.
    expect(await statUtility.tokenize('café')).toEqual(['café']);
    // An apostrophe or a hyphen ends a word.
    expect(await statUtility.tokenize("don't stop-start")).toEqual(['don', 't', 'stop', 'start']);
  });

  it('lower-cases sentences when toLowerCase is true, and keeps their case otherwise', async () => {
    const text = 'First one. Second one.';
    expect(await statUtility.tokenize(text, { type: 'sentence', toLowerCase: true })).toEqual(['first one.', 'second one.']);
    expect(await statUtility.tokenize(text, { type: 'sentence' })).toEqual(['First one.', 'Second one.']);
  });

  it("expands a contraction that ends in n't, written with a curly apostrophe too", async () => {
    const text = "I don't know, they won't go and she can’t stay";
    expect(await statUtility.normalizeText(text, { expandContractions: true })).toBe('i do not know they will not go and she cannot stay');
  });

  it('expands contractions written in capitals when toLowerCase is false', async () => {
    const text = "YOU'RE RIGHT, I'M SURE WE'LL GO";
    expect(await statUtility.normalizeText(text, { toLowerCase: false, expandContractions: true })).toBe(
      'YOU are RIGHT I am SURE WE will GO',
    );
  });

  it('counts the words of any script for keywords, most frequent first', async () => {
    expect(await statUtility.extractKeywords('Café crème, café noir, café au lait.', { maxKeywords: 2 })).toEqual(['café', 'crème']);
  });

  it("leaves the stop words of the call's language out of the keywords", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stat-keywords-'));
    try {
      const file = path.join(dir, 'es.txt');
      fs.writeFileSync(file, 'el\nla\nde\n', 'utf8');
      const custom = new StatisticalUtilityAI();
      await custom.initialize({ customStopWordsPaths: { es: file } });
      // The Spanish list drops el, la and de; natural's English list drops the y.
      expect(await custom.extractKeywords('el gato de la casa y el gato del vecino', { language: 'es', maxKeywords: 2 })).toEqual(['gato', 'casa']);
      // With no language, the class's English list, which drops the parts of a web address too.
      expect(await custom.extractKeywords('https www docs https www docs guide', { maxKeywords: 2 })).toEqual(['docs', 'guide']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads the corpusForIDF texts as it reads the two texts it compares', async () => {
    const similarity = (corpusForIDF: string[]) =>
      statUtility.calculateSimilarity('running dogs bark', 'running cats sleep', { corpusForIDF });
    // Both corpus texts stem to run and late, so they give every word the same inverse document frequency.
    expect(await similarity(['running late'])).toBe(await similarity(['run late']));
  });
  
  it('should perform basic summarization (first_n_sentences)', async () => {
    const text = "Sentence one. Sentence two. Sentence three. Sentence four. Sentence five.";
    const options: SummarizationOptions = { method: 'first_n_sentences', desiredLength: 2 };
    const summary = await statUtility.summarize(text, options);
    expect(summary).toBe("Sentence one. Sentence two.");
  });

  it('reads a desiredLength of 1 or less as a fraction of the sentences, 0 included', async () => {
    const text = 'The river rose. Crews closed the bridge. Traffic moved north. Schools opened late. The rain stopped.';
    const first = (desiredLength: number) => statUtility.summarize(text, { method: 'first_n_sentences', desiredLength });
    // 0 of the sentences is none, and a summary keeps at least one; 0.4 of five is two.
    expect(await first(0)).toBe('The river rose.');
    expect(await first(0.4)).toBe('The river rose. Crews closed the bridge.');
    // A number that is not a number keeps the default of three.
    expect(await first(Number.NaN)).toBe('The river rose. Crews closed the bridge. Traffic moved north.');
  });

  it('reads an absolute customStopWordsPaths file as given when resourcePath is set', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stat-stop-'));
    try {
      const file = path.join(dir, 'stop.txt');
      fs.writeFileSync(file, 'river\n', 'utf8');
      const custom = new StatisticalUtilityAI();
      await custom.initialize({ resourcePath: path.join(dir, 'resources'), customStopWordsPaths: { en: file } });
      // The file replaces the English list: "river" goes, and "the" stays.
      expect(await custom.normalizeText('The river rose', { removeStopWords: true })).toBe('the rose');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('should use language-specific stemmers when available', async () => {
    const spanishStem = await statUtility.stemTokens(['corriendo'], {
      algorithm: 'porter',
      language: 'es',
    });
    const russianStem = await statUtility.stemTokens(['машины'], {
      algorithm: 'porter',
      language: 'ru',
    });

    expect(spanishStem).toEqual(['corr']);
    expect(russianStem).toEqual(['машин']);
  });

  it('checkHealth should report as healthy if initialized', async () => {
    const health = await statUtility.checkHealth();
    expect(health.isHealthy).toBe(true);
    expect(health.details).toHaveProperty('status', 'Initialized');
  });

  it('should allow shutdown', async () => {
    await expect(statUtility.shutdown?.()).resolves.toBeUndefined();
    // Add any assertions about state after shutdown if applicable
  });

  describe('calculateReadability', () => {
    it('computes flesch_kincaid_reading_ease for simple text', async () => {
      const result = await statUtility.calculateReadability(
        'The cat sat on the mat. The dog ran fast.',
        { formula: 'flesch_kincaid_reading_ease' }
      );
      expect(result.score).toBeGreaterThan(70);
    });

    it('computes lower readability for complex text', async () => {
      const simple = await statUtility.calculateReadability(
        'The cat sat on the mat. The dog ran fast.',
        { formula: 'flesch_kincaid_reading_ease' }
      );
      const complex = await statUtility.calculateReadability(
        'Antidisestablishmentarianism characterizes the philosophical underpinnings of contemporary ecclesiastical governance methodologies.',
        { formula: 'flesch_kincaid_reading_ease' }
      );
      expect(complex.score).toBeLessThan(simple.score);
    });
  });
});
