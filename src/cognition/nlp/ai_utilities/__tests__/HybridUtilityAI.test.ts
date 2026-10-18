import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HybridUtilityAI, type HybridUtilityAIConfig } from '../HybridUtilityAI';
import type { IUtilityAI } from '../IUtilityAI';

/** Creates a mock IUtilityAI with all methods stubbed. */
function createMockUtility(id: string): IUtilityAI {
  return {
    utilityId: id,
    initialize: vi.fn().mockResolvedValue(undefined),
    summarize: vi.fn().mockResolvedValue('summary'),
    classifyText: vi.fn().mockResolvedValue({ label: 'positive', confidence: 0.9 }),
    extractKeywords: vi.fn().mockResolvedValue(['keyword1', 'keyword2']),
    parseJsonSafe: vi.fn().mockResolvedValue({ parsed: true }),
    tokenize: vi.fn().mockResolvedValue(['token1', 'token2']),
    stemTokens: vi.fn().mockResolvedValue(['stem1', 'stem2']),
    normalizeText: vi.fn().mockResolvedValue('normalized'),
    generateNGrams: vi.fn().mockResolvedValue({ 2: [['a', 'b']] }),
    calculateReadability: vi.fn().mockResolvedValue({ score: 70, grade: '8th' }),
    calculateSimilarity: vi.fn().mockResolvedValue(0.85),
    analyzeSentiment: vi.fn().mockResolvedValue({ sentiment: 'positive', score: 0.9 }),
    detectLanguage: vi.fn().mockResolvedValue([{ language: 'en', confidence: 0.99 }]),
    checkHealth: vi.fn().mockResolvedValue({ isHealthy: true, details: 'ok' }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

describe('HybridUtilityAI', () => {
  let llmMock: IUtilityAI;
  let statMock: IUtilityAI;

  beforeEach(() => {
    llmMock = createMockUtility('llm-mock');
    statMock = createMockUtility('stat-mock');
  });

  // --- Constructor ---

  describe('constructor', () => {
    it('throws when neither llm nor statistical backend is provided', () => {
      expect(() => new HybridUtilityAI({ utilityId: 'test' })).toThrow(
        'requires at least one backend',
      );
    });

    it('accepts llm-only config', () => {
      const hybrid = new HybridUtilityAI({ llm: llmMock });
      expect(hybrid.utilityId).toContain('llm-mock');
    });

    it('accepts statistical-only config', () => {
      const hybrid = new HybridUtilityAI({ statistical: statMock });
      expect(hybrid.utilityId).toContain('stat-mock');
    });

    it('accepts both backends', () => {
      const hybrid = new HybridUtilityAI({ llm: llmMock, statistical: statMock });
      expect(hybrid.utilityId).toContain('llm-mock');
      expect(hybrid.utilityId).toContain('stat-mock');
    });

    it('uses custom utilityId if provided', () => {
      const hybrid = new HybridUtilityAI({ utilityId: 'custom-id', llm: llmMock, statistical: statMock });
      expect(hybrid.utilityId).toBe('custom-id');
    });
  });

  // --- LLM-preferred methods ---

  describe('LLM-preferred methods delegate to llm backend', () => {
    let hybrid: HybridUtilityAI;

    beforeEach(() => {
      hybrid = new HybridUtilityAI({ llm: llmMock, statistical: statMock });
    });

    it('summarize delegates to llm', async () => {
      await hybrid.summarize('text to summarize', { method: 'abstractive_llm' });
      expect(llmMock.summarize).toHaveBeenCalledWith('text to summarize', { method: 'abstractive_llm' });
      expect(statMock.summarize).not.toHaveBeenCalled();
    });

    it('classifyText delegates to llm', async () => {
      await hybrid.classifyText('text', { candidateClasses: ['a', 'b'] });
      expect(llmMock.classifyText).toHaveBeenCalled();
      expect(statMock.classifyText).not.toHaveBeenCalled();
    });

    it('extractKeywords delegates to llm', async () => {
      await hybrid.extractKeywords('some text');
      expect(llmMock.extractKeywords).toHaveBeenCalled();
      expect(statMock.extractKeywords).not.toHaveBeenCalled();
    });
  });

  // --- Statistical-preferred methods ---

  describe('Statistical-preferred methods delegate to stat backend', () => {
    let hybrid: HybridUtilityAI;

    beforeEach(() => {
      hybrid = new HybridUtilityAI({ llm: llmMock, statistical: statMock });
    });

    it('tokenize delegates to stat', async () => {
      await hybrid.tokenize('hello world');
      expect(statMock.tokenize).toHaveBeenCalled();
      expect(llmMock.tokenize).not.toHaveBeenCalled();
    });

    it('stemTokens delegates to stat', async () => {
      await hybrid.stemTokens(['running', 'jumped']);
      expect(statMock.stemTokens).toHaveBeenCalled();
      expect(llmMock.stemTokens).not.toHaveBeenCalled();
    });

    it('calculateSimilarity delegates to stat', async () => {
      await hybrid.calculateSimilarity('text1', 'text2');
      expect(statMock.calculateSimilarity).toHaveBeenCalled();
      expect(llmMock.calculateSimilarity).not.toHaveBeenCalled();
    });

    it('normalizeText delegates to stat', async () => {
      await hybrid.normalizeText('some TEXT');
      expect(statMock.normalizeText).toHaveBeenCalled();
      expect(llmMock.normalizeText).not.toHaveBeenCalled();
    });

    it('generateNGrams delegates to stat', async () => {
      await hybrid.generateNGrams(['a', 'b', 'c'], { n: [2] });
      expect(statMock.generateNGrams).toHaveBeenCalled();
      expect(llmMock.generateNGrams).not.toHaveBeenCalled();
    });

    it('calculateReadability delegates to stat', async () => {
      await hybrid.calculateReadability('text', { formula: 'flesch_kincaid_reading_ease' });
      expect(statMock.calculateReadability).toHaveBeenCalled();
      expect(llmMock.calculateReadability).not.toHaveBeenCalled();
    });

    it('analyzeSentiment delegates to stat', async () => {
      await hybrid.analyzeSentiment('happy text');
      expect(statMock.analyzeSentiment).toHaveBeenCalled();
      expect(llmMock.analyzeSentiment).not.toHaveBeenCalled();
    });

    it('detectLanguage delegates to stat', async () => {
      await hybrid.detectLanguage('bonjour le monde');
      expect(statMock.detectLanguage).toHaveBeenCalled();
      expect(llmMock.detectLanguage).not.toHaveBeenCalled();
    });
  });

  // --- Fallback: stat missing -> llm handles ---

  describe('fallback when statistical backend is missing', () => {
    let hybrid: HybridUtilityAI;

    beforeEach(() => {
      hybrid = new HybridUtilityAI({ llm: llmMock });
    });

    it('tokenize falls back to llm', async () => {
      await hybrid.tokenize('hello');
      expect(llmMock.tokenize).toHaveBeenCalled();
    });

    it('stemTokens falls back to llm', async () => {
      await hybrid.stemTokens(['run']);
      expect(llmMock.stemTokens).toHaveBeenCalled();
    });

    it('calculateSimilarity falls back to llm', async () => {
      await hybrid.calculateSimilarity('a', 'b');
      expect(llmMock.calculateSimilarity).toHaveBeenCalled();
    });
  });

  // --- Fallback: llm missing -> stat handles ---

  describe('fallback when llm backend is missing', () => {
    let hybrid: HybridUtilityAI;

    beforeEach(() => {
      hybrid = new HybridUtilityAI({ statistical: statMock });
    });

    it('summarize falls back to stat', async () => {
      await hybrid.summarize('text');
      expect(statMock.summarize).toHaveBeenCalled();
    });

    it('classifyText falls back to stat', async () => {
      await hybrid.classifyText('text', { candidateClasses: ['x'] });
      expect(statMock.classifyText).toHaveBeenCalled();
    });

    it('extractKeywords falls back to stat', async () => {
      await hybrid.extractKeywords('text');
      expect(statMock.extractKeywords).toHaveBeenCalled();
    });
  });

  // --- parseJsonSafe ---

  describe('parseJsonSafe', () => {
    it('tries stat first, then llm for repair if stat returns null', async () => {
      (statMock.parseJsonSafe as any).mockResolvedValue(null);
      (llmMock.parseJsonSafe as any).mockResolvedValue({ repaired: true });

      const hybrid = new HybridUtilityAI({ llm: llmMock, statistical: statMock });
      const result = await hybrid.parseJsonSafe('{"broken');
      expect(statMock.parseJsonSafe).toHaveBeenCalled();
      expect(llmMock.parseJsonSafe).toHaveBeenCalled();
      expect(result).toEqual({ repaired: true });
    });

    it('returns stat result directly when stat succeeds', async () => {
      (statMock.parseJsonSafe as any).mockResolvedValue({ valid: true });

      const hybrid = new HybridUtilityAI({ llm: llmMock, statistical: statMock });
      const result = await hybrid.parseJsonSafe('{"valid": true}');
      expect(result).toEqual({ valid: true });
      expect(llmMock.parseJsonSafe).not.toHaveBeenCalled();
    });

    it('returns null when only one backend and it fails', async () => {
      (statMock.parseJsonSafe as any).mockResolvedValue(null);

      const hybrid = new HybridUtilityAI({ statistical: statMock });
      const result = await hybrid.parseJsonSafe('bad json');
      expect(result).toBeNull();
    });
  });

  // --- checkHealth ---

  describe('checkHealth', () => {
    it('aggregates health from both backends', async () => {
      const hybrid = new HybridUtilityAI({ llm: llmMock, statistical: statMock });
      const health = await hybrid.checkHealth();
      expect(health.isHealthy).toBe(true);
      expect(health.dependencies).toHaveLength(2);
      expect(health.dependencies![0].name).toContain('llm');
      expect(health.dependencies![1].name).toContain('stat');
    });

    it('reports unhealthy when llm is unhealthy', async () => {
      (llmMock.checkHealth as any).mockResolvedValue({ isHealthy: false, details: 'down' });

      const hybrid = new HybridUtilityAI({ llm: llmMock, statistical: statMock });
      const health = await hybrid.checkHealth();
      expect(health.isHealthy).toBe(false);
    });

    it('handles checkHealth exceptions from a backend', async () => {
      (llmMock.checkHealth as any).mockRejectedValue(new Error('boom'));

      const hybrid = new HybridUtilityAI({ llm: llmMock, statistical: statMock });
      const health = await hybrid.checkHealth();
      expect(health.isHealthy).toBe(false);
      const llmDep = health.dependencies!.find((d) => d.name.includes('llm'));
      expect(llmDep!.isHealthy).toBe(false);
      expect(llmDep!.details).toBe('boom');
    });

    it('works with a single backend', async () => {
      const hybrid = new HybridUtilityAI({ statistical: statMock });
      const health = await hybrid.checkHealth();
      expect(health.isHealthy).toBe(true);
      expect(health.dependencies).toHaveLength(1);
    });
  });

  // --- shutdown ---

  describe('shutdown', () => {
    it('calls shutdown on both backends', async () => {
      const hybrid = new HybridUtilityAI({ llm: llmMock, statistical: statMock });
      await hybrid.shutdown();
      expect(llmMock.shutdown).toHaveBeenCalled();
      expect(statMock.shutdown).toHaveBeenCalled();
    });

    it('works when only one backend is present', async () => {
      const hybrid = new HybridUtilityAI({ llm: llmMock });
      await hybrid.shutdown();
      expect(llmMock.shutdown).toHaveBeenCalled();
    });
  });

  // --- initialize ---

  describe('initialize', () => {
    it('initializes both backends', async () => {
      const hybrid = new HybridUtilityAI({ llm: llmMock, statistical: statMock });
      await hybrid.initialize({ utilityId: 'init-test' });
      expect(llmMock.initialize).toHaveBeenCalledWith({ utilityId: 'init-test' });
      expect(statMock.initialize).toHaveBeenCalledWith({ utilityId: 'init-test' });
    });
  });
});
