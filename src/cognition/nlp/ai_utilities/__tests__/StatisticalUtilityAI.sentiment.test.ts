/**
 * @fileoverview StatisticalUtilityAI.analyzeSentiment: the lexicons `natural` ships, chosen by the
 * language code, a custom lexicon from `sentimentConfig.lexiconPath` or from a call's
 * `lexiconNameOrPath`, negation, and the scale of the score.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StatisticalUtilityAI } from '../StatisticalUtilityAI';
import { GMIErrorCode } from '../../../../core/utils/errors.js';

let util: StatisticalUtilityAI;
let tmpDir: string | undefined;

beforeEach(async () => {
  util = new StatisticalUtilityAI('test-stat');
  await util.initialize({ utilityId: 'test-stat', defaultLanguage: 'en' });
});

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

/** Writes a lexicon file into this test's temporary folder and answers its path. */
function lexiconFile(name: string, content: string): string {
  tmpDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'stat-lexicon-'));
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

const words = (list?: Array<{ token: string }>): string[] => (list ?? []).map((entry) => entry.token);

describe('analyzeSentiment in English (AFINN)', () => {
  it('scores a plainly positive sentence above zero', async () => {
    const result = await util.analyzeSentiment('Thank you, this is wonderful and I love it.');
    expect(result.score).toBeGreaterThan(0.5);
    expect(result.polarity).toBe('positive');
    expect(result.intensity).toBe(Math.abs(result.score));
    expect(words(result.positiveTokens)).toEqual(expect.arrayContaining(['thank', 'wonderful', 'love']));
    expect(result.negativeTokens).toEqual([]);
  });

  it('scores a plainly negative sentence below zero', async () => {
    const result = await util.analyzeSentiment('This update is terrible, I hate it and the app is useless.');
    expect(result.score).toBeLessThan(-0.5);
    expect(result.polarity).toBe('negative');
    expect(words(result.negativeTokens)).toEqual(expect.arrayContaining(['terrible', 'hate', 'useless']));
    expect(result.positiveTokens).toEqual([]);
  });

  it('scores a sentence with no sentiment word 0', async () => {
    const result = await util.analyzeSentiment('The table is in the room next to the door.');
    expect(result.score).toBe(0);
    expect(result.polarity).toBe('neutral');
    expect(result.comparative).toBe(0);
    expect(result.positiveTokens).toEqual([]);
    expect(result.negativeTokens).toEqual([]);
  });

  it('answers neutral for an empty text', async () => {
    const result = await util.analyzeSentiment('');
    expect(result.score).toBe(0);
    expect(result.comparative).toBe(0);
    expect(result.polarity).toBe('neutral');
  });

  it('maps the sum of the word values into -1 to 1 as VADER maps its compound score', async () => {
    // terrible is -3 in AFINN: -3 / sqrt(3 * 3 + 15).
    const one = await util.analyzeSentiment('terrible');
    expect(one.score).toBeCloseTo(-3 / Math.sqrt(24), 12);
    expect(one.intensity).toBeCloseTo(3 / Math.sqrt(24), 12);
    // comparative is natural's: the sum over the number of words.
    expect(one.comparative).toBe(-3);
    expect((await util.analyzeSentiment('This is terrible')).comparative).toBe(-1);
    expect((await util.analyzeSentiment('terrible', { language: 'en-GB' })).score).toBe(one.score);
  });

  it('flips a word that a negation among the three words before it, in its clause, negates', async () => {
    expect((await util.analyzeSentiment('This is not good')).polarity).toBe('negative');
    expect((await util.analyzeSentiment("I don't like it")).polarity).toBe('negative');
    // "no" negates "problem" (-2 becomes 2); "great" is in the next clause and keeps its 3.
    const result = await util.analyzeSentiment('No problem, this is great');
    expect(result.polarity).toBe('positive');
    expect(result.positiveTokens).toEqual([
      { token: 'problem', score: 2 },
      { token: 'great', score: 3 },
    ]);
  });

  it('flips nothing past three words after the negation', async () => {
    expect((await util.analyzeSentiment('Never did anyone say the plan is good')).polarity).toBe('positive');
    expect((await util.analyzeSentiment('The plan is never good')).polarity).toBe('negative');
  });

  it('scores a phrase the lexicon lists as one entry, before its words', async () => {
    const result = await util.analyzeSentiment("I can't stand it");
    expect(result.negativeTokens).toEqual([{ token: "can't stand", score: -3 }]);
    expect(result.positiveTokens).toEqual([]);
  });

  it('scores a word only in a form the lexicon lists', async () => {
    // AFINN lists lively (2) and not lives: a word that shares a listed word's stem adds nothing.
    const result = await util.analyzeSentiment('The deploy key lives in the vault.');
    expect(result.score).toBe(0);
    expect(result.positiveTokens).toEqual([]);
  });
});

describe('analyzeSentiment in other languages', () => {
  it('scores Spanish with the Spanish AFINN lexicon', async () => {
    const positive = await util.analyzeSentiment('El servicio fue excelente y el producto es maravilloso', { language: 'es' });
    const negative = await util.analyzeSentiment('La comida fue horrible y el servicio terrible', { language: 'es-MX' });
    expect(positive.score).toBeGreaterThan(0.5);
    expect(negative.score).toBeLessThan(-0.5);
    expect((await util.analyzeSentiment('no es bueno', { language: 'es' })).polarity).toBe('negative');
    // The English lexicon holds none of the Spanish words.
    expect((await util.analyzeSentiment('excelente y maravilloso', { language: 'en' })).score).toBe(0);
  });

  it('scores French with the pattern lexicon', async () => {
    const positive = await util.analyzeSentiment('Le repas était parfait et le service magnifique', { language: 'fr' });
    const negative = await util.analyzeSentiment('Le repas était horrible et le service mauvais', { language: 'fr' });
    expect(positive.score).toBeGreaterThan(0.5);
    expect(negative.score).toBeLessThan(-0.5);
  });

  it('reads a call without a language in the configured default language', async () => {
    const spanish = new StatisticalUtilityAI('spanish-default');
    await spanish.initialize({ defaultLanguage: 'es' });
    expect((await spanish.analyzeSentiment('excelente')).polarity).toBe('positive');
  });

  it('scores 0 in a language natural has no lexicon for', async () => {
    const result = await util.analyzeSentiment('Это ужасно', { language: 'ru' });
    expect(result.score).toBe(0);
    expect(result.polarity).toBe('neutral');
  });
});

describe('analyzeSentiment with a custom lexicon', () => {
  it('adds the entries of sentimentConfig.lexiconPath to the built-in lexicon', async () => {
    const file = lexiconFile('custom.tsv', 'blorft\t4\nsnarvy\t-4\n# a comment line\ngood\t-1\n');
    const custom = new StatisticalUtilityAI('custom-lexicon');
    await custom.initialize({ sentimentConfig: { lexiconPath: file } });
    expect((await custom.analyzeSentiment('blorft')).polarity).toBe('positive');
    expect((await custom.analyzeSentiment('snarvy')).polarity).toBe('negative');
    // An entry replaces the built-in value of its word, and the rest of AFINN stays.
    expect((await custom.analyzeSentiment('good')).polarity).toBe('negative');
    expect((await custom.analyzeSentiment('terrible')).polarity).toBe('negative');
  });

  it('reads a relative lexiconPath under resourcePath, and a lexicon written as JSON', async () => {
    lexiconFile('custom.json', JSON.stringify({ blorft: 3 }));
    const custom = new StatisticalUtilityAI('resource-lexicon');
    await custom.initialize({ resourcePath: tmpDir, sentimentConfig: { lexiconPath: 'custom.json' } });
    expect((await custom.analyzeSentiment('blorft')).score).toBeCloseTo(3 / Math.sqrt(24), 12);
  });

  it('scores with the custom lexicon alone in a language natural has none for', async () => {
    const file = lexiconFile('sv.tsv', 'bra\t1\ndålig\t-1\n');
    const custom = new StatisticalUtilityAI('swedish-lexicon');
    await custom.initialize({ defaultLanguage: 'sv', sentimentConfig: { lexiconPath: file } });
    expect((await custom.analyzeSentiment('Det var bra')).polarity).toBe('positive');
    expect((await custom.analyzeSentiment('Det var dålig')).polarity).toBe('negative');
  });

  it('takes a lexicon by name or by path for one call', async () => {
    // gorgeous is in natural's English senticon lexicon and not in AFINN.
    expect((await util.analyzeSentiment('gorgeous')).score).toBe(0);
    expect((await util.analyzeSentiment('gorgeous', { lexiconNameOrPath: 'senticon' })).polarity).toBe('positive');
    const file = lexiconFile('call.tsv', 'gorgeous\t-2\n');
    expect((await util.analyzeSentiment('gorgeous', { lexiconNameOrPath: file })).polarity).toBe('negative');
    await expect(
      util.analyzeSentiment('bueno', { language: 'es', lexiconNameOrPath: 'pattern' }),
    ).rejects.toMatchObject({ code: GMIErrorCode.NOT_SUPPORTED });
  });

  it('refuses a lexicon file a call names that cannot be read', async () => {
    const missing = path.join(os.tmpdir(), `stat-no-such-lexicon-${process.pid}.tsv`);
    await expect(util.analyzeSentiment('good', { lexiconNameOrPath: missing })).rejects.toMatchObject({
      code: GMIErrorCode.RESOURCE_NOT_FOUND,
    });
  });
});
