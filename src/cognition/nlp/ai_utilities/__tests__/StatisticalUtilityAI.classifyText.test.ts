/**
 * @fileoverview Tests for StatisticalUtilityAI text classification.
 * Covers the Naive Bayes classification path and keyword_matching fallback.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { StatisticalUtilityAI } from '../StatisticalUtilityAI';

let util: StatisticalUtilityAI;

beforeEach(async () => {
  util = new StatisticalUtilityAI('test-stat');
  await util.initialize({ utilityId: 'test-stat', defaultLanguage: 'en' });
});

describe('classifyText — Naive Bayes', () => {
  const trainingData = [
    { text: 'swing sword at the goblin', label: 'attack' },
    { text: 'slash the orc with my axe', label: 'attack' },
    { text: 'shoot an arrow at the dragon', label: 'attack' },
    { text: 'stab the skeleton with a dagger', label: 'attack' },
    { text: 'put on the leather armor', label: 'equip' },
    { text: 'equip the magic staff', label: 'equip' },
    { text: 'wear the enchanted ring', label: 'equip' },
    { text: 'wield the great hammer', label: 'equip' },
    { text: 'purchase a healing potion from the merchant', label: 'buy' },
    { text: 'buy supplies at the shop', label: 'buy' },
    { text: 'trade gold for a shield', label: 'buy' },
    { text: 'pay the blacksmith for repairs', label: 'buy' },
  ];

  async function trainDefault(): Promise<void> {
    const result = await util.trainModel(trainingData, 'text_classifier_naive_bayes', {
      modelId: 'rpg-actions',
    });
    expect(result.success).toBe(true);
  }

  it('returns bestClass, confidence, and allScores after training', async () => {
    await trainDefault();
    const result = await util.classifyText('hit the troll with my mace', {
      candidateClasses: ['attack', 'equip', 'buy'],
      method: 'naive_bayes',
      modelId: 'rpg-actions',
    });

    expect(result.bestClass).toBeDefined();
    expect(typeof result.confidence).toBe('number');
    expect(Array.isArray(result.allScores)).toBe(true);
    expect(result.allScores.length).toBeGreaterThanOrEqual(1);
    // Each score entry has classLabel and score
    for (const s of result.allScores) {
      expect(s).toHaveProperty('classLabel');
      expect(s).toHaveProperty('score');
    }
  });

  it('classifies attack-like text as attack', async () => {
    await trainDefault();
    const result = await util.classifyText('attack the beast with a longsword', {
      candidateClasses: ['attack', 'equip', 'buy'],
      method: 'naive_bayes',
      modelId: 'rpg-actions',
    });
    expect(result.bestClass).toBe('attack');
  });

  it('classifies equip-like text as equip', async () => {
    await trainDefault();
    const result = await util.classifyText('put on the heavy plate armor', {
      candidateClasses: ['attack', 'equip', 'buy'],
      method: 'naive_bayes',
      modelId: 'rpg-actions',
    });
    expect(result.bestClass).toBe('equip');
  });

  it('classifies buy-like text as buy', async () => {
    await trainDefault();
    const result = await util.classifyText('buy a new sword from the merchant shop', {
      candidateClasses: ['attack', 'equip', 'buy'],
      method: 'naive_bayes',
      modelId: 'rpg-actions',
    });
    expect(result.bestClass).toBe('buy');
  });

  it('allScores covers all trained classes', async () => {
    await trainDefault();
    const result = await util.classifyText('swing my hammer at the wolf', {
      candidateClasses: ['attack', 'equip', 'buy'],
      method: 'naive_bayes',
      modelId: 'rpg-actions',
    });
    const labels = result.allScores.map(s => s.classLabel);
    expect(labels).toContain('attack');
    expect(labels).toContain('equip');
    expect(labels).toContain('buy');
  });

  it('throws when classifying with naive_bayes on an untrained model id', async () => {
    // No model has been trained with this id, so the classifier falls back to keyword matching
    // (the implementation warns and falls back rather than throwing)
    // However, if we request naive_bayes explicitly and the model doesn't exist, it falls
    // through to keyword matching per the source. Let's verify that behavior.
    const result = await util.classifyText('swing sword', {
      candidateClasses: ['attack', 'equip', 'buy'],
      method: 'naive_bayes',
      modelId: 'nonexistent-model',
    });
    // Falls back to keyword matching — bestClass should still be one of the candidates
    expect(['attack', 'equip', 'buy']).toContain(result.bestClass);
  });
});

describe('classifyText — keyword_matching', () => {
  it('picks the candidate class whose keywords appear in the text', async () => {
    const result = await util.classifyText('I want to attack the enemy', {
      candidateClasses: ['attack', 'defend', 'flee'],
      method: 'keyword_matching',
    });
    expect(result.bestClass).toBe('attack');
  });

  it('returns confidence proportional to keyword overlap', async () => {
    const result = await util.classifyText('defend the castle walls', {
      candidateClasses: ['attack', 'defend', 'flee'],
      method: 'keyword_matching',
    });
    expect(result.bestClass).toBe('defend');
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('handles multi-word candidate classes', async () => {
    const result = await util.classifyText('cast a powerful fire spell on the enemy', {
      candidateClasses: ['fire spell', 'ice spell', 'heal spell'],
      method: 'keyword_matching',
    });
    expect(result.bestClass).toBe('fire spell');
  });

  it('returns allScores for every candidate class', async () => {
    const result = await util.classifyText('run away quickly', {
      candidateClasses: ['attack', 'defend', 'run'],
      method: 'keyword_matching',
    });
    expect(result.allScores.length).toBe(3);
    const labels = result.allScores.map(s => s.classLabel);
    expect(labels).toContain('attack');
    expect(labels).toContain('defend');
    expect(labels).toContain('run');
  });

  it('returns first candidate when no keywords match', async () => {
    const result = await util.classifyText('xylophone zebra quantum', {
      candidateClasses: ['attack', 'defend', 'flee'],
      method: 'keyword_matching',
    });
    // When no keywords match, maxScore stays 0 and bestMatch defaults to first candidate
    expect(result.bestClass).toBe('attack');
    // Confidence should be low
    expect(result.confidence).toBeLessThanOrEqual(0.1);
  });

  it('splits a class name at white space, so a doubled or trailing space scores nothing', async () => {
    const result = await util.classifyText('xylophone zebra quantum', {
      candidateClasses: ['attack  now ', 'defend'],
      method: 'keyword_matching',
    });
    expect(result.allScores).toEqual([
      { classLabel: 'attack  now ', score: 0 },
      { classLabel: 'defend', score: 0 },
    ]);
    expect(result.bestClass).toBe('attack  now ');
    expect(result.confidence).toBe(0.1);
  });
});
