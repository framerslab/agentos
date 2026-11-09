/**
 * @fileoverview Unit tests for token-budgeted memory prompt assembly.
 * Tests budget allocation, overflow redistribution, and personality formatting.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { assembleMemoryContext, type MemoryAssemblerInput } from '../../src/cognition/memory/core/prompt/MemoryPromptAssembler.js';
import {
  formatMemoryTrace,
  memoryTraceLineLength,
  MEMORY_CUT_MARKER,
  MIN_CUT_CONTENT_CHARS,
} from '../../src/cognition/memory/core/prompt/MemoryFormatters.js';
import { CognitiveMechanismsEngine } from '../../src/cognition/memory/mechanisms/CognitiveMechanismsEngine.js';
import type { ScoredMemoryTrace } from '../../src/cognition/memory/core/types.js';
import { DEFAULT_BUDGET_ALLOCATION } from '../../src/cognition/memory/core/config.js';

const DAY_MS = 86_400_000;
const tokensOf = (text: string) => Math.ceil(text.length / 4);
const WORDS = ['harbor', 'lantern', 'meadow', 'copper', 'thistle', 'granite', 'orchard', 'pebble'];
/** Text of `chars` characters or a little more, made of whole words from WORDS. */
function wordsText(chars: number, seed = 0): string {
  const out: string[] = [];
  let length = 0;
  for (let i = seed; length < chars; i++) {
    const word = WORDS[i % WORDS.length];
    out.push(word);
    length += word.length + 1;
  }
  return out.join(' ');
}
/** The lines of the section whose header starts with `header`. */
function sectionLines(contextText: string, header: string): string[] {
  const section = contextText.split('\n\n').find((part) => part.startsWith(header));
  return section ? section.split('\n').slice(1) : [];
}

function makeScoredTrace(overrides: Partial<ScoredMemoryTrace> = {}): ScoredMemoryTrace {
  return {
    id: `trace-${Math.random().toString(36).slice(2, 6)}`,
    type: 'semantic',
    scope: 'user',
    scopeId: 'agent-1',
    content: 'A sample memory trace content for testing purposes.',
    entities: [],
    tags: [],
    provenance: { sourceType: 'user_statement', sourceTimestamp: Date.now(), confidence: 0.8, verificationCount: 0 },
    emotionalContext: { valence: 0, arousal: 0.5, dominance: 0, intensity: 0, gmiMood: '' },
    encodingStrength: 0.7,
    stability: 3_600_000,
    retrievalCount: 1,
    lastAccessedAt: Date.now(),
    accessCount: 2,
    reinforcementInterval: 3_600_000,
    associatedTraceIds: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    isActive: true,
    retrievalScore: 0.8,
    scoreBreakdown: {
      strengthScore: 0.7, similarityScore: 0.85, recencyScore: 0.5,
      emotionalCongruenceScore: 0.3, graphActivationScore: 0, importanceScore: 0.6,
    },
    ...overrides,
  };
}

describe('MemoryPromptAssembler', () => {
  describe('assembleMemoryContext', () => {
    it('returns valid AssembledMemoryContext shape', () => {
      const input: MemoryAssemblerInput = {
        totalTokenBudget: 1000,
        traits: {},
        workingMemoryText: 'Some active context',
        retrievedTraces: [makeScoredTrace()],
      };

      const result = assembleMemoryContext(input);
      expect(result).toHaveProperty('contextText');
      expect(result).toHaveProperty('tokensUsed');
      expect(result).toHaveProperty('allocation');
      expect(result).toHaveProperty('includedMemoryIds');
    });

    it('respects total token budget', () => {
      const traces = Array.from({ length: 20 }, (_, i) =>
        makeScoredTrace({ id: `t-${i}`, content: 'A'.repeat(400) }),
      );

      const input: MemoryAssemblerInput = {
        totalTokenBudget: 200,
        traits: {},
        retrievedTraces: traces,
      };

      const result = assembleMemoryContext(input);
      expect(result.tokensUsed).toBeLessThanOrEqual(200);
    });

    it('includes working memory section when provided', () => {
      const input: MemoryAssemblerInput = {
        totalTokenBudget: 1000,
        traits: {},
        workingMemoryText: 'Active scratchpad state here.',
      };

      const result = assembleMemoryContext(input);
      expect(result.contextText).toContain('Active Context');
      expect(result.contextText).toContain('Active scratchpad state here.');
    });

    it('separates episodic and semantic traces into different sections', () => {
      const input: MemoryAssemblerInput = {
        totalTokenBudget: 2000,
        traits: {},
        retrievedTraces: [
          makeScoredTrace({ type: 'semantic', content: 'semantic fact' }),
          makeScoredTrace({ type: 'episodic', content: 'episodic event' }),
        ],
      };

      const result = assembleMemoryContext(input);
      expect(result.contextText).toContain('Relevant Memories');
      expect(result.contextText).toContain('Recent Experiences');
    });

    it('overflows unused Batch 2 budgets into semantic recall', () => {
      // When no prospective/graph/observation data, their budgets flow to semantic
      const input: MemoryAssemblerInput = {
        totalTokenBudget: 1000,
        traits: {},
        retrievedTraces: Array.from({ length: 10 }, () => makeScoredTrace()),
        prospectiveAlerts: [],
        graphContext: [],
        observationNotes: [],
      };

      const result = assembleMemoryContext(input);
      // Should include more semantic traces since overflow is available
      expect(result.includedMemoryIds.length).toBeGreaterThan(0);
    });

    it('includes prospective alerts when provided', () => {
      const input: MemoryAssemblerInput = {
        totalTokenBudget: 1000,
        traits: {},
        prospectiveAlerts: ['Remember to follow up on the report'],
      };

      const result = assembleMemoryContext(input);
      expect(result.contextText).toContain('Reminders');
      expect(result.contextText).toContain('Remember to follow up');
    });

    it('includes graph context when provided', () => {
      const input: MemoryAssemblerInput = {
        totalTokenBudget: 1000,
        traits: {},
        graphContext: ['Associated memory: user prefers dark mode'],
      };

      const result = assembleMemoryContext(input);
      expect(result.contextText).toContain('Related Context');
    });

    it('includes observation notes when provided', () => {
      const input: MemoryAssemblerInput = {
        totalTokenBudget: 1000,
        traits: {},
        observationNotes: ['User seems frustrated with the API'],
      };

      const result = assembleMemoryContext(input);
      expect(result.contextText).toContain('Observations');
    });

    it('returns empty context when budget is 0', () => {
      const result = assembleMemoryContext({
        totalTokenBudget: 0,
        traits: {},
        retrievedTraces: [makeScoredTrace()],
      });
      expect(result.tokensUsed).toBe(0);
    });

    it('tracks included memory IDs', () => {
      const input: MemoryAssemblerInput = {
        totalTokenBudget: 2000,
        traits: {},
        retrievedTraces: [
          makeScoredTrace({ id: 'included-1' }),
          makeScoredTrace({ id: 'included-2' }),
        ],
      };

      const result = assembleMemoryContext(input);
      expect(result.includedMemoryIds).toContain('included-1');
      expect(result.includedMemoryIds).toContain('included-2');
    });
  });

  describe('whole traces', () => {
    it('renders a trace longer than 300 characters whole when it fits its section', () => {
      const content = `user: ${wordsText(200)}\nassistant: ${wordsText(400, 3)} The spare key is under the blue flowerpot.`;
      const result = assembleMemoryContext({
        totalTokenBudget: 1600,
        traits: { conscientiousness: 0.9 },
        retrievedTraces: [makeScoredTrace({ id: 'long', type: 'episodic', content })],
      });
      expect(result.contextText).toContain(content);
      expect(result.contextText).not.toContain(MEMORY_CUT_MARKER);
    });

    it('cuts a trace that does not fit what is left of its section to fit, at a word boundary, with a cut marker', () => {
      const content = wordsText(6000);
      for (const traits of [{ conscientiousness: 0.9 }, { openness: 0.9 }, { emotionality: 0.9 }]) {
        const result = assembleMemoryContext({
          totalTokenBudget: 250, // under the preamble's threshold, so the trace has the whole budget
          traits,
          retrievedTraces: [makeScoredTrace({ id: 'huge', type: 'semantic', content })],
        });
        expect(result.includedMemoryIds).toEqual(['huge']);
        const line = sectionLines(result.contextText, '## Relevant Memories')[0];
        const at = line.indexOf(MEMORY_CUT_MARKER);
        expect(at, JSON.stringify(traits)).toBeGreaterThan(0);
        const kept = line.slice(0, at);
        // The kept text ends on a whole word, and is far longer than a fixed 300-character cut.
        expect(WORDS.some((word) => kept.endsWith(` ${word}`))).toBe(true);
        expect(content.startsWith(kept.slice(kept.indexOf(WORDS[0])))).toBe(true);
        expect(kept.length).toBeGreaterThan(600);
        expect(result.tokensUsed).toBeLessThanOrEqual(250);
        expect(tokensOf(result.contextText)).toBeLessThanOrEqual(250);
      }
    });

    it('formatMemoryTrace returns the whole line without maxChars, a cut line within maxChars, and nothing when no useful cut fits', () => {
      const trace = makeScoredTrace({ content: wordsText(2000) });
      const now = Date.now();
      expect(formatMemoryTrace(trace, 'structured', { now })).toContain(trace.content);
      const cut = formatMemoryTrace(trace, 'structured', { now, maxChars: 500 });
      expect(cut.length).toBeLessThanOrEqual(500);
      expect(cut).toContain(MEMORY_CUT_MARKER);
      expect(formatMemoryTrace(trace, 'structured', { now, maxChars: 60 })).toBe('');
    });

    it('formatMemoryTrace leaves a trace out when the word boundary would keep fewer than the minimum characters', () => {
      const now = Date.now();
      // Room for exactly the minimum, with the only word boundary after character 21.
      const trace = makeScoredTrace({ content: `${'a'.repeat(21)} ${'b'.repeat(100)}` });
      const bare = memoryTraceLineLength(makeScoredTrace({ ...trace, content: '' }), 'structured', { now });
      const maxChars = bare + MEMORY_CUT_MARKER.length + MIN_CUT_CONTENT_CHARS;
      expect(formatMemoryTrace(trace, 'structured', { now, maxChars })).toBe('');
      // With a boundary late enough, the same room keeps a cut.
      const later = makeScoredTrace({ content: `${'a'.repeat(40)} ${'b'.repeat(100)}` });
      expect(formatMemoryTrace(later, 'structured', { now, maxChars })).toContain(`${'a'.repeat(40)}${MEMORY_CUT_MARKER}`);
    });
  });

  describe('ages', () => {
    it('counts ages of a week or more in days and puts the stored date beside every age', () => {
      const now = Date.UTC(2026, 10, 8, 12, 0, 0);
      const line = (ageMs: number) =>
        formatMemoryTrace(makeScoredTrace({ createdAt: now - ageMs }), 'structured', { now });
      expect(line(26 * DAY_MS)).toContain('(26 days ago, 2026-10-13 |');
      expect(line(7 * DAY_MS)).toContain('(7 days ago, 2026-11-01 |');
      expect(line(365 * DAY_MS)).toContain('(365 days ago, 2025-11-08 |');
      expect(line(3 * DAY_MS)).toContain('(3d ago, 2026-11-05 |');
      expect(line(2 * 3_600_000)).toContain('(2h ago, 2026-11-08 |');
      expect(line(5 * 60_000)).toContain('(5m ago, 2026-11-08 |');
      expect(line(0)).toContain('(just now, 2026-11-08 |');
      expect(formatMemoryTrace(makeScoredTrace({ createdAt: now - 26 * DAY_MS }), 'narrative', { now }))
        .toMatch(/^26 days ago, 2026-10-13: /);
      expect(formatMemoryTrace(makeScoredTrace({ createdAt: now - 26 * DAY_MS }), 'emotional', { now }))
        .toMatch(/^\(~\) 26 days ago, 2026-10-13: /);
    });

    it('leaves the date out, and still renders the block, for a stored time past the last instant a Date can hold', () => {
      const now = Date.UTC(2026, 10, 8, 12, 0, 0);
      // A nanosecond epoch: finite and positive, but above 8.64e15 ms, where toISOString throws.
      const trace = makeScoredTrace({ type: 'episodic', createdAt: now * 1_000_000 });
      expect(() => formatMemoryTrace(trace, 'structured', { now })).not.toThrow();
      expect(formatMemoryTrace(trace, 'structured', { now })).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      const result = assembleMemoryContext({ totalTokenBudget: 1000, traits: {}, retrievedTraces: [trace] });
      expect(result.includedMemoryIds).toContain(trace.id);
    });
  });

  describe('budget spill', () => {
    const many = (type: 'semantic' | 'episodic', count: number, chars: number) =>
      Array.from({ length: count }, (_, i) =>
        makeScoredTrace({ id: `${type}-${i}`, type, content: wordsText(chars, i) }),
      );

    it('gives an episodic-only recall the whole budget, never more', () => {
      const result = assembleMemoryContext({
        totalTokenBudget: 1600,
        traits: { conscientiousness: 0.9 },
        retrievedTraces: many('episodic', 20, 400),
      });
      const bullets = sectionLines(result.contextText, '## Recent Experiences');
      // A fixed 25% share held three of these.
      expect(bullets.length).toBeGreaterThan(8);
      expect(result.tokensUsed).toBeLessThanOrEqual(1600);
      expect(result.tokensUsed).toBeGreaterThan(1550);
      expect(tokensOf(result.contextText)).toBeLessThanOrEqual(1600);
    });

    it('fills Semantic Recall first from the spare budget and keeps Recent Episodic at least its own share', () => {
      const budget = 4000;
      const result = assembleMemoryContext({
        totalTokenBudget: budget,
        traits: { conscientiousness: 0.9 },
        retrievedTraces: [...many('semantic', 40, 400), ...many('episodic', 40, 400)],
      });
      const preambleTokens = tokensOf(result.contextText.split('\n\n## Relevant Memories')[0]);
      const available = budget - preambleTokens;
      const semantic = sectionLines(result.contextText, '## Relevant Memories').join('\n');
      const episodic = sectionLines(result.contextText, '## Recent Experiences').join('\n');
      // Episodic's share, give or take the one trace cut to fit and what Semantic Recall left unspent.
      expect(tokensOf(episodic)).toBeGreaterThanOrEqual(Math.floor(available * 0.25) - 80);
      expect(tokensOf(episodic)).toBeLessThanOrEqual(Math.floor(available * 0.25) + 40);
      // Semantic gets its 40% plus every share no other section used.
      expect(tokensOf(semantic)).toBeGreaterThan(Math.floor(available * 0.7) - 60);
      expect(result.tokensUsed).toBeLessThanOrEqual(budget);
    });

    it('gives the grant of a working memory too long for it back to the recalled traces', () => {
      const result = assembleMemoryContext({
        totalTokenBudget: 600,
        traits: { conscientiousness: 0.9 },
        workingMemoryText: wordsText(301),
        retrievedTraces: many('semantic', 20, 400),
      });
      // The whole budget less what the cut trace's word boundary and minimum can leave.
      expect(result.tokensUsed).toBeGreaterThan(560);
      expect(result.tokensUsed).toBeLessThanOrEqual(600);
      expect(tokensOf(result.contextText)).toBeLessThanOrEqual(600);
    });

    it('keeps the leading working-memory slots when the whole list does not fit', () => {
      const slots = Array.from({ length: 40 }, (_, i) => `- [ACTIVE] mt_${String(i).padStart(4, '0')} (activation: 0.90)`);
      const result = assembleMemoryContext({
        totalTokenBudget: 250,
        traits: { conscientiousness: 0.9 },
        workingMemoryText: slots.join('\n'),
      });
      const kept = sectionLines(result.contextText, '## Active Context');
      expect(kept.length).toBeGreaterThan(0);
      expect(kept.length).toBeLessThan(slots.length);
      expect(kept).toEqual(slots.slice(0, kept.length));
    });

    it('keeps room for an involuntary memory when recalled traces would fill the block', () => {
      const engine = new CognitiveMechanismsEngine({ involuntaryRecall: { probability: 1 } });
      const old = makeScoredTrace({
        id: 'old-vivid',
        type: 'episodic',
        createdAt: Date.now() - 30 * DAY_MS,
        content: 'The night the whole team stayed up to fix the outage.',
        emotionalContext: { valence: 0.8, arousal: 0.9, dominance: 0.5, intensity: 0.72, gmiMood: 'FOCUSED' },
      });
      const result = assembleMemoryContext({
        totalTokenBudget: 1600,
        traits: { conscientiousness: 0.9 },
        retrievedTraces: [...many('semantic', 20, 400), ...many('episodic', 20, 400)],
        mechanismsEngine: engine,
        allTraces: [old],
      });
      expect(result.contextText).toContain('## Something This Reminds Me Of');
      expect(result.contextText).toContain('The night the whole team stayed up to fix the outage.');
      expect(result.includedMemoryIds).toContain('old-vivid');
      expect(result.tokensUsed).toBeLessThanOrEqual(1600);
      expect(tokensOf(result.contextText)).toBeLessThanOrEqual(1600);
    });

    it('gives an involuntary memory what the sections leave unspent when its tenth is too small for it', () => {
      const vivid = (content: string) =>
        makeScoredTrace({
          id: 'old-vivid',
          type: 'episodic',
          createdAt: Date.now() - 30 * DAY_MS,
          content,
          emotionalContext: { valence: 0.8, arousal: 0.9, dominance: 0.5, intensity: 0.72, gmiMood: 'FOCUSED' },
        });
      const cases = [
        // A tenth of 500 tokens after the preamble has no room for the line; the rest of the block is empty.
        { budget: 500, content: 'The night the whole team stayed up to fix the outage.' },
        // A tenth of 1600 tokens would cut this trace; the rest of the block is empty.
        { budget: 1600, content: wordsText(1500) },
      ];
      for (const { budget, content } of cases) {
        const result = assembleMemoryContext({
          totalTokenBudget: budget,
          traits: { conscientiousness: 0.9 },
          mechanismsEngine: new CognitiveMechanismsEngine({ involuntaryRecall: { probability: 1 } }),
          allTraces: [vivid(content)],
        });
        expect(result.contextText, `budget ${budget}`).toContain('## Something This Reminds Me Of');
        expect(result.contextText, `budget ${budget}`).toContain(content);
        expect(result.contextText, `budget ${budget}`).not.toContain(MEMORY_CUT_MARKER);
        expect(result.includedMemoryIds, `budget ${budget}`).toEqual(['old-vivid']);
        expect(result.tokensUsed, `budget ${budget}`).toBeLessThanOrEqual(budget);
        expect(tokensOf(result.contextText), `budget ${budget}`).toBeLessThanOrEqual(budget);
      }
    });

    it('counts a share that is not a finite positive number as 0', () => {
      for (const bad of [Infinity, -Infinity, Number.NaN, -1]) {
        const empty = assembleMemoryContext({
          totalTokenBudget: 0,
          allocation: { prospectiveAlerts: bad },
          traits: {},
          prospectiveAlerts: ['Remember to follow up on the report'],
        });
        expect(empty.tokensUsed, String(bad)).toBe(0);
        expect(empty.contextText, String(bad)).toBe('');
        const small = assembleMemoryContext({
          totalTokenBudget: 120,
          allocation: { prospectiveAlerts: bad, graphAssociations: bad },
          traits: {},
          prospectiveAlerts: Array.from({ length: 20 }, (_, i) => wordsText(120, i)),
          graphContext: Array.from({ length: 20 }, (_, i) => wordsText(120, i)),
        });
        expect(small.tokensUsed, String(bad)).toBeLessThanOrEqual(120);
        expect(tokensOf(small.contextText), String(bad)).toBeLessThanOrEqual(120);
      }
    });

    it('never exceeds the budget with every section full, at any size, even when the shares add up to more than 1', () => {
      for (const budget of [0, 50, 150, 333, 777, 1600, 5000]) {
        for (const allocation of [undefined, { semanticRecall: 1, recentEpisodic: 1 }]) {
          const result = assembleMemoryContext({
            totalTokenBudget: budget,
            allocation,
            traits: { openness: 0.9 },
            persistentMemoryText: wordsText(3000),
            workingMemoryText: '- [ACTIVE] mt_1 (activation: 0.90)\n- [fading] mt_2 (activation: 0.50)',
            retrievedTraces: [...many('semantic', 30, 500), ...many('episodic', 30, 500)],
            prospectiveAlerts: Array.from({ length: 20 }, (_, i) => wordsText(120, i)),
            graphContext: Array.from({ length: 20 }, (_, i) => wordsText(120, i)),
            observationNotes: Array.from({ length: 20 }, (_, i) => wordsText(120, i)),
          });
          expect(result.tokensUsed, `budget ${budget}`).toBeLessThanOrEqual(budget);
          expect(tokensOf(result.contextText), `budget ${budget}`).toBeLessThanOrEqual(budget);
        }
      }
    });
  });
  describe('review follow-ups', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** A UTF-16 string that holds a lone surrogate. */
    const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

    it('a share set to exactly 0 turns its section off: no grant and no spill', () => {
      const traces = [
        makeScoredTrace({ id: 'sem', type: 'semantic', content: 'The team meets on Thursdays.' }),
        makeScoredTrace({ id: 'epi', type: 'episodic', content: 'We walked to the harbor after the meeting.' }),
      ];
      const off = assembleMemoryContext({
        totalTokenBudget: 1600,
        allocation: { recentEpisodic: 0 },
        traits: {},
        retrievedTraces: traces,
      });
      expect(off.contextText).not.toContain('## Recent Experiences');
      expect(off.contextText).not.toContain('We walked to the harbor');
      expect(off.includedMemoryIds).toEqual(['sem']);
      expect(off.allocation.recentEpisodic).toBe(0);
      // The default allocation has no zero share: the same traces render both sections.
      const on = assembleMemoryContext({ totalTokenBudget: 1600, traits: {}, retrievedTraces: traces });
      expect(on.contextText).toContain('## Recent Experiences');
      expect(on.includedMemoryIds).toEqual(['sem', 'epi']);
    });

    it('a share set to undefined keeps its default', () => {
      const result = assembleMemoryContext({
        totalTokenBudget: 1000,
        allocation: { semanticRecall: undefined },
        traits: {},
        retrievedTraces: [makeScoredTrace({ id: 'sem' })],
      });
      expect(result.allocation.semanticRecall).toBeCloseTo(DEFAULT_BUDGET_ALLOCATION.semanticRecall, 9);

      // With every section full and the other shares adding up to more than 1,
      // Semantic Recall holds its scaled default share, not the rounding left over.
      const many = (type: 'semantic' | 'episodic') =>
        Array.from({ length: 30 }, (_, i) => makeScoredTrace({ id: `${type}-${i}`, type, content: wordsText(500, i) }));
      const full = (allocation: Record<string, number | undefined>) =>
        assembleMemoryContext({
          totalTokenBudget: 4000,
          allocation,
          traits: { conscientiousness: 0.9 },
          workingMemoryText: Array.from({ length: 40 }, (_, i) => `- [ACTIVE] mt_${i} ${wordsText(60, i)}`).join('\n'),
          retrievedTraces: [...many('semantic'), ...many('episodic')],
          prospectiveAlerts: Array.from({ length: 40 }, (_, i) => wordsText(120, i)),
          graphContext: Array.from({ length: 40 }, (_, i) => wordsText(120, i)),
          observationNotes: Array.from({ length: 40 }, (_, i) => wordsText(120, i)),
          persistentMemoryText: wordsText(6000),
        });
      const withUndefined = full({ semanticRecall: undefined, recentEpisodic: 0.85 });
      const withDefault = full({ semanticRecall: DEFAULT_BUDGET_ALLOCATION.semanticRecall, recentEpisodic: 0.85 });
      const semantic = (text: string) => sectionLines(text, '## Relevant Memories').join('\n');
      expect(semantic(withUndefined.contextText)).toBe(semantic(withDefault.contextText));
      expect(withUndefined.allocation).toEqual(withDefault.allocation);
      expect(tokensOf(semantic(withUndefined.contextText))).toBeGreaterThan(400);
    });

    it('reports the shares the assembly used: scaled, and 0 for a share that is not a finite positive number', () => {
      const scaled = assembleMemoryContext({
        totalTokenBudget: 1000,
        allocation: { semanticRecall: 1, recentEpisodic: 1 },
        traits: {},
      });
      const sum = Object.values(scaled.allocation).reduce((n, share) => n + share, 0);
      expect(sum).toBeCloseTo(1, 9);
      const configuredSum = 1 + 1 + 0.15 + 0.05 * 4;
      expect(scaled.allocation.semanticRecall).toBeCloseTo(1 / configuredSum, 9);
      expect(scaled.allocation.recentEpisodic).toBeCloseTo(1 / configuredSum, 9);
      expect(scaled.allocation.workingMemory).toBeCloseTo(0.15 / configuredSum, 9);

      for (const bad of [Number.NaN, -1, Infinity, -Infinity, 0]) {
        const result = assembleMemoryContext({ totalTokenBudget: 1000, allocation: { prospectiveAlerts: bad }, traits: {} });
        expect(result.allocation.prospectiveAlerts, String(bad)).toBe(0);
        for (const share of Object.values(result.allocation)) {
          expect(Number.isFinite(share), String(bad)).toBe(true);
        }
      }

      const defaults = assembleMemoryContext({ totalTokenBudget: 1000, traits: {} });
      for (const [key, share] of Object.entries(DEFAULT_BUDGET_ALLOCATION)) {
        expect(defaults.allocation[key as keyof typeof DEFAULT_BUDGET_ALLOCATION], key).toBeCloseTo(share, 9);
      }
    });

    it('a graph association too long for what is left of its section is cut to fit at a word boundary, its tag whole', () => {
      const content = `${wordsText(400)} The spare key is under the blue flowerpot. ${wordsText(2000, 3)}`;
      const item = `[associated, activation=0.80] ${content}`;
      const result = assembleMemoryContext({ totalTokenBudget: 200, traits: {}, graphContext: [item] });
      const [line] = sectionLines(result.contextText, '## Related Context');
      expect(line).toBeDefined();
      expect(line.startsWith('- [associated, activation=0.80] ')).toBe(true);
      expect(line.endsWith(MEMORY_CUT_MARKER)).toBe(true);
      const kept = line.slice('- [associated, activation=0.80] '.length, -MEMORY_CUT_MARKER.length);
      expect(content.startsWith(kept)).toBe(true);
      expect(content[kept.length]).toBe(' ');
      expect(kept).toContain('The spare key is under the blue flowerpot.');
      expect(result.tokensUsed).toBeLessThanOrEqual(200);
      expect(tokensOf(result.contextText)).toBeLessThanOrEqual(200);
      // Whole when it fits.
      const whole = assembleMemoryContext({ totalTokenBudget: 1600, traits: {}, graphContext: [item.slice(0, 700)] });
      expect(whole.contextText).toContain(item.slice(0, 700));
    });

    it('never ends a cut inside a surrogate pair', () => {
      const emoji = '\u{1F600}'.repeat(2000);
      const now = Date.UTC(2026, 10, 8, 12, 0, 0);
      const trace = makeScoredTrace({ content: emoji, createdAt: now });
      const bare = memoryTraceLineLength(makeScoredTrace({ ...trace, content: '' }), 'structured', { now });
      for (let extra = 0; extra < 6; extra++) {
        const maxChars = bare + MEMORY_CUT_MARKER.length + MIN_CUT_CONTENT_CHARS + 1 + extra;
        const line = formatMemoryTrace(trace, 'structured', { now, maxChars });
        expect(line, `maxChars ${maxChars}`).toContain(MEMORY_CUT_MARKER);
        expect(line.length).toBeLessThanOrEqual(maxChars);
        expect(LONE_SURROGATE.test(line), `maxChars ${maxChars}`).toBe(false);
      }
      for (const budget of [60, 61, 62, 63, 64, 65]) {
        for (const extra of [0, 1]) {
          const result = assembleMemoryContext({
            totalTokenBudget: budget,
            traits: {},
            persistentMemoryText: `${'a'.repeat(extra)}${emoji}`,
          });
          expect(result.contextText, `budget ${budget}`).toContain('<!-- truncated -->');
          expect(LONE_SURROGATE.test(result.contextText), `budget ${budget}, offset ${extra}`).toBe(false);
        }
      }
    });

    it('skips an item that does not fit and tries the later ones while room is left', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const now = Date.UTC(2026, 10, 8, 12, 0, 0);
      vi.setSystemTime(now);
      const header = (() => {
        const probe = assembleMemoryContext({ totalTokenBudget: 200, traits: {}, retrievedTraces: [makeScoredTrace({ createdAt: now })] });
        return probe.contextText.split('\n')[0];
      })();
      expect(header.startsWith('## Relevant Memories')).toBe(true);

      const short = makeScoredTrace({ id: 'short', content: 'The gate code is 4417 at night.', createdAt: now });
      const long = makeScoredTrace({ id: 'long', content: wordsText(2000), createdAt: now });
      const lineShort = memoryTraceLineLength(short, 'structured', { now });
      const bareLong = memoryTraceLineLength(long, 'structured', { now }) - long.content.length;
      // The room left after the first trace holds the short line whole but not the least cut of the long one.
      expect(lineShort).toBeLessThan(bareLong + MEMORY_CUT_MARKER.length + MIN_CUT_CONTENT_CHARS);

      const budget = 200; // under the preamble's threshold, so the section has the whole budget
      const firstLine = 4 * budget - header.length - 4 - lineShort;
      const firstBare = memoryTraceLineLength(makeScoredTrace({ content: '', createdAt: now }), 'structured', { now });
      const first = makeScoredTrace({ id: 'first', content: 'b'.repeat(firstLine - firstBare), createdAt: now });
      expect(memoryTraceLineLength(first, 'structured', { now })).toBe(firstLine);

      const result = assembleMemoryContext({ totalTokenBudget: budget, traits: {}, retrievedTraces: [first, long, short] });
      expect(result.includedMemoryIds).toEqual(['first', 'short']);
      expect(result.contextText).toContain('The gate code is 4417 at night.');
      expect(result.tokensUsed).toBeLessThanOrEqual(budget);
      expect(tokensOf(result.contextText)).toBeLessThanOrEqual(budget);

      // Lines too: a reminder too long for the room left is skipped, the short one after it kept.
      const reminders = assembleMemoryContext({
        totalTokenBudget: 60,
        traits: {},
        prospectiveAlerts: ['x'.repeat(400), 'Call the plumber on Monday.'],
      });
      expect(reminders.contextText).toContain('- Call the plumber on Monday.');
    });

    it('counts an age of a day or more in UTC calendar days, so the age and the date agree', () => {
      const now = Date.UTC(2026, 10, 8, 0, 30, 0); // 2026-11-08 00:30 UTC
      const line = (createdAt: number) => formatMemoryTrace(makeScoredTrace({ createdAt }), 'structured', { now });
      expect(line(Date.UTC(2026, 9, 12, 23, 0, 0))).toContain('(27 days ago, 2026-10-12 |');
      expect(line(Date.UTC(2026, 10, 6, 23, 0, 0))).toContain('(2d ago, 2026-11-06 |');
      expect(line(Date.UTC(2026, 10, 1, 23, 0, 0))).toContain('(7 days ago, 2026-11-01 |');
      // Under a day the age stays in hours and minutes.
      expect(line(Date.UTC(2026, 10, 7, 23, 0, 0))).toContain('(1h ago, 2026-11-07 |');
      expect(line(Date.UTC(2026, 10, 8, 0, 10, 0))).toContain('(20m ago, 2026-11-08 |');
      expect(line(Date.UTC(2026, 10, 7, 0, 31, 0))).toContain('(23h ago, 2026-11-07 |');
    });
  });
});
