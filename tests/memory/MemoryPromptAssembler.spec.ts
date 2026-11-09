/**
 * @fileoverview Unit tests for token-budgeted memory prompt assembly.
 * Tests budget allocation, overflow redistribution, and personality formatting.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  assembleMemoryContext,
  assembleMemoryContextFirstPass,
  type MemoryAssemblerInput,
} from '../../src/cognition/memory/core/prompt/MemoryPromptAssembler.js';
import {
  cutMemoryContent,
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

const SECTION_HEADERS = [
  '## Persistent Memory',
  '## Active Context',
  '## Relevant Memories',
  '## Recent Experiences',
  '## Reminders',
  '## Related Context',
  '## Observations',
  '## Something This Reminds Me Of',
] as const;
const PERSISTENT_TRUNCATED = '\n<!-- truncated -->';

/** The lines of each section of a block, by header; persistent memory's text counts as one line. */
function blockSections(contextText: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  for (const part of contextText.split(/\n\n(?=## )/)) {
    const header = SECTION_HEADERS.find((name) => part.startsWith(name));
    if (!header) continue;
    const body = part.slice(part.indexOf('\n') + 1);
    sections.set(header, header === '## Persistent Memory' ? [body.replace(/^\n/, '')] : body.split('\n'));
  }
  return sections;
}

/** Whether `later` is `line`, or `line` lengthened: a cut line's text before its marker starts `later`. */
function keepsLine(line: string, later: string): boolean {
  if (later === line) return true;
  const marker = line.endsWith(PERSISTENT_TRUNCATED) ? PERSISTENT_TRUNCATED : MEMORY_CUT_MARKER;
  const at = line.lastIndexOf(marker);
  return at > 0 && later.length > line.length - marker.length && later.startsWith(line.slice(0, at));
}

/**
 * Asserts that the block `input` assembles holds every line its first pass rendered, in its section and its order,
 * whole if it was whole, and stays within the budget.
 */
function expectKeepsFirstPass(input: MemoryAssemblerInput, label = ''): void {
  const first = assembleMemoryContextFirstPass(input);
  const result = assembleMemoryContext(input);
  const finalSections = blockSections(result.contextText);
  for (const [header, lines] of blockSections(first.contextText)) {
    const later = finalSections.get(header) ?? [];
    let at = 0;
    for (const line of lines) {
      while (at < later.length && !keepsLine(line, later[at])) at++;
      expect(at < later.length, `${label} ${header}: the first pass's line ${JSON.stringify(line.slice(0, 80))} is gone`).toBe(true);
      at++;
    }
  }
  for (const id of first.includedMemoryIds) expect(result.includedMemoryIds, `${label} id ${id}`).toContain(id);
  expect(result.tokensUsed, label).toBeGreaterThanOrEqual(first.tokensUsed);
  expect(result.tokensUsed, label).toBeLessThanOrEqual(input.totalTokenBudget);
  expect(tokensOf(result.contextText), label).toBeLessThanOrEqual(input.totalTokenBudget);
}

/** A seeded pseudo-random number generator (mulberry32): the same seed gives the same cases on every run. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
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
      const full = (allocation: MemoryAssemblerInput['allocation']) =>
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

    it('a share set to null keeps its default, as undefined does', () => {
      const semanticTrace = makeScoredTrace({ id: 'sem', type: 'semantic', content: 'The team meets on Thursdays.' });
      const withNull = assembleMemoryContext({
        totalTokenBudget: 1600,
        traits: {},
        allocation: { semanticRecall: null } as never,
        retrievedTraces: [semanticTrace],
      });
      const withDefault = assembleMemoryContext({ totalTokenBudget: 1600, traits: {}, retrievedTraces: [semanticTrace] });
      expect(withNull.allocation.semanticRecall).toBeCloseTo(DEFAULT_BUDGET_ALLOCATION.semanticRecall, 9);
      expect(withNull.allocation).toEqual(withDefault.allocation);
      expect(withNull.contextText).toBe(withDefault.contextText);
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

    it('leaves out of Related Context an association to a trace the block already holds, and the next association takes its room', () => {
      // Spreading activation leaves out only the top three retrieved seeds, so a fourth retrieved trace can come back as
      // an association of the first.
      const fact = 'The ferry to the island leaves at 7:40 from pier 3.';
      const recalled = makeScoredTrace({ id: 'd', type: 'episodic', content: `${wordsText(300)} ${fact}` });
      const next = { traceId: 'e', text: `[associated, activation=0.40] ${wordsText(300, 2)} We bought the picnic basket.` };
      const alone = assembleMemoryContext({ totalTokenBudget: 1600, traits: {}, retrievedTraces: [recalled], graphContext: [next] });
      expect(sectionLines(alone.contextText, '## Related Context')).toEqual([`- ${next.text}`]);

      // At the budget the recalled trace and the next association fill exactly, the duplicate takes none of it.
      const budget = alone.tokensUsed;
      const result = assembleMemoryContext({
        totalTokenBudget: budget,
        traits: {},
        retrievedTraces: [recalled],
        graphContext: [{ traceId: 'd', text: `[associated, activation=0.80] ${recalled.content}` }, next],
      });
      expect(result.contextText.split(fact)).toHaveLength(2);
      expect(sectionLines(result.contextText, '## Recent Experiences').join('\n')).toContain(fact);
      expect(sectionLines(result.contextText, '## Related Context')).toEqual([`- ${next.text}`]);
      expect(result.contextText).toBe(alone.contextText);
      expect(result.tokensUsed).toBeLessThanOrEqual(budget);

      // A plain line carries no id and is never left out for that.
      const plain = assembleMemoryContext({
        totalTokenBudget: 1600,
        traits: {},
        retrievedTraces: [recalled],
        graphContext: [`[associated, activation=0.80] ${recalled.content}`],
      });
      expect(sectionLines(plain.contextText, '## Related Context').join('\n')).toContain(fact);
    });

    it('shows a trace once when the second pass has room for it: Related Context keeps the association the first pass showed, and the room still goes to the block', () => {
      // The first pass shows the second episodic trace only through its association, cut to fit Related Context. The
      // second pass has room for the trace in Recent Experiences, which leaves it out, as the block already shows it;
      // the room goes to the association's cut instead of staying unspent.
      const budget = 820;
      const fact = makeScoredTrace({ id: 'sem', type: 'semantic', content: `Harbor notes: ${wordsText(950)}` });
      const first = makeScoredTrace({ id: 'epi-1', type: 'episodic', content: `Lantern walk: ${wordsText(950, 1)}` });
      const second = makeScoredTrace({ id: 'epi-2', type: 'episodic', content: `Ferry log: ${wordsText(950, 2)}` });
      const result = assembleMemoryContext({
        totalTokenBudget: budget,
        traits: {},
        retrievedTraces: [fact, first, second],
        graphContext: [{ traceId: 'epi-2', text: `[associated, activation=0.70] ${second.content}` }],
        observationNotes: [wordsText(4000, 5)],
      });
      expect(result.contextText.split('Ferry log:')).toHaveLength(2);
      expect(sectionLines(result.contextText, '## Related Context').join('\n')).toContain('Ferry log:');
      expect(sectionLines(result.contextText, '## Recent Experiences').join('\n')).not.toContain('Ferry log:');
      expect(result.includedMemoryIds).toEqual(['sem', 'epi-1']);
      // Something is left out (the association is cut, the note does not fit), so the block fills the budget but for
      // the few characters a cut at a word boundary leaves.
      expect(result.tokensUsed).toBeLessThanOrEqual(budget);
      expect(result.tokensUsed).toBeGreaterThanOrEqual(budget - 5);
    });

    it('keeps working memory to its leading slots when a longer slot does not fit, and skips a graph association too short to cut', () => {
      // Slots arrive sorted by activation, highest first; a shorter slot after one that does not fit stays out.
      const slots = [
        '- [ACTIVE] mt_first (activation: 0.95)',
        `- [ACTIVE] mt_${'long'.repeat(60)} (activation: 0.90)`,
        '- [weak] mt_last (activation: 0.30)',
      ];
      const wm = assembleMemoryContext({ totalTokenBudget: 40, traits: {}, workingMemoryText: slots.join('\n') });
      expect(sectionLines(wm.contextText, '## Active Context')).toEqual([slots[0]]);

      const graph = assembleMemoryContext({
        totalTokenBudget: 30,
        allocation: { graphAssociations: 1 },
        traits: {},
        graphContext: [`[associated, activation=0.80] ${'x'.repeat(200)}`, '[associated, activation=0.40] go'],
      });
      expect(graph.contextText).not.toContain('[associated, activation=0.80]');
      expect(graph.contextText).toContain('- [associated, activation=0.40] go');
      expect(graph.tokensUsed).toBeLessThanOrEqual(30);
    });

    it('keeps a blank line in working memory text and the slots after it when they fit', () => {
      // A host that calls assembleMemoryContext itself may separate its working memory with blank lines.
      const text = '- [ACTIVE] mt_first (activation: 0.95)\n\n- [ACTIVE] mt_second (activation: 0.90)';
      const result = assembleMemoryContext({ totalTokenBudget: 200, traits: {}, workingMemoryText: text });
      expect(result.contextText).toContain(`## Active Context (in focus — reference directly)\n${text}`);
      expect(result.tokensUsed).toBeLessThanOrEqual(200);
      expect(tokensOf(result.contextText)).toBeLessThanOrEqual(200);
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

    describe('a trace the first pass shows in its section', () => {
      // Narrative lines: the age, then the content, then the entities (`(involves: ...)`) when the trace has any.
      const traits = { openness: 0.9 };
      const style = 'narrative' as const;
      const fact = 'The ferry leaves pier 3 at 7:40 sharp.';
      /** Characters the Recent Experiences section takes besides its lines: separator, header and the newline before the first line. */
      const sectionOverhead = (now: number) => {
        const probe = assembleMemoryContext({
          totalTokenBudget: 200, // under the preamble's threshold
          traits,
          retrievedTraces: [makeScoredTrace({ type: 'episodic', createdAt: now })],
        });
        const header = probe.contextText.split('\n')[0];
        expect(header.startsWith('## Recent Experiences')).toBe(true);
        return 2 + header.length + 1;
      };
      /**
       * The block with Related Context and Observations beside Recent Experiences: of `total` tokens, Recent Experiences
       * renders in the first pass on all but `held`, which the two other sections are granted (1 and `held - 1`). Related
       * Context gives its grant up, as its one association leads to a trace Recent Experiences holds, and the note is
       * too long for any room, so the second pass offers Recent Experiences the whole `total`.
       */
      const assemble = (total: number, held: number, traces: ScoredMemoryTrace[], association: { traceId: string; text: string }) =>
        assembleMemoryContext({
          totalTokenBudget: total,
          allocation: {
            persistentMemory: 0,
            workingMemory: 0,
            semanticRecall: 0,
            prospectiveAlerts: 0,
            recentEpisodic: 0.5,
            graphAssociations: 1.5 / total,
            observationNotes: (held - 0.5) / total,
          },
          traits,
          retrievedTraces: traces,
          graphContext: [association],
          observationNotes: [wordsText(4000, 5)],
        });
      /** The ids Recent Experiences holds when it has all of `total` tokens to itself. */
      const alone = (total: number, traces: ScoredMemoryTrace[]) =>
        assembleMemoryContext({ totalTokenBudget: total, traits, retrievedTraces: traces }).includedMemoryIds;

      it('keeps the trace in its section when its association has no room to come back in Related Context', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const now = Date.UTC(2026, 10, 9, 12, 0, 0);
        vi.setSystemTime(now);
        const long = makeScoredTrace({ id: 'long', type: 'episodic', content: wordsText(2000), createdAt: now });
        const short = makeScoredTrace({ id: 'short', type: 'episodic', content: fact, createdAt: now });
        const bare = memoryTraceLineLength(makeScoredTrace({ type: 'episodic', content: '', createdAt: now }), style, { now });
        const shortLine = memoryTraceLineLength(short, style, { now });
        const overhead = sectionOverhead(now);

        // First pass: room for the short line, too little for the least cut of the long trace.
        const first = Math.ceil((overhead + bare + 42) / 4);
        const firstRoom = 4 * first - overhead;
        expect(shortLine).toBeLessThanOrEqual(firstRoom);
        expect(firstRoom - bare - MEMORY_CUT_MARKER.length).toBeLessThan(MIN_CUT_CONTENT_CHARS);
        // Twenty characters more: the long trace's cut fills the room and the short line no longer fits.
        const total = first + 5;
        expect(alone(first, [long, short])).toEqual(['short']);
        expect(alone(total, [long, short])).toEqual(['long']);

        const result = assemble(total, 5, [long, short], { traceId: 'short', text: fact });
        // The association has no room to show it, so the trace stays where the first pass put it.
        expect(result.contextText.split(fact)).toHaveLength(2);
        expect(sectionLines(result.contextText, '## Recent Experiences').join('\n')).toContain(fact);
        expect(result.includedMemoryIds).toContain('short');
        expect(result.tokensUsed).toBeLessThanOrEqual(total);
        expect(tokensOf(result.contextText)).toBeLessThanOrEqual(total);
      });

      it('keeps the trace in its section though a render from scratch would give its room to an earlier trace and Related Context has room for its association', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const now = Date.UTC(2026, 10, 9, 12, 0, 0);
        vi.setSystemTime(now);
        // Entities lengthen a line without lengthening its content, so the long trace's least cut needs more room than
        // the short trace's whole line.
        const long = makeScoredTrace({
          id: 'long',
          type: 'episodic',
          content: wordsText(50),
          entities: ['the harbor master of the north landing', 'the ferry captain of the evening crossing', 'the night watch at the east gate'],
          createdAt: now,
        });
        const short = makeScoredTrace({
          id: 'short',
          type: 'episodic',
          content: fact,
          entities: ['the harbor master', 'the ferry captain', 'the night watch'],
          createdAt: now,
        });
        const longLine = memoryTraceLineLength(long, style, { now });
        const longBare = longLine - long.content.length;
        const shortLine = memoryTraceLineLength(short, style, { now });
        const shortBare = shortLine - short.content.length;
        const overhead = sectionOverhead(now);
        const association = { traceId: 'short', text: '[associated, activation=0.70] Ferry at 7:40.' };
        const graphChars = 2 + '## Related Context (connected memories — use for depth)'.length + 1 + 2 + association.text.length;

        // First pass: room for the short line whole, too little for the long line or its least cut.
        const first = Math.ceil((overhead + shortLine) / 4);
        const firstRoom = 4 * first - overhead;
        expect(firstRoom).toBeLessThan(longLine);
        expect(firstRoom - longBare - MEMORY_CUT_MARKER.length).toBeLessThan(MIN_CUT_CONTENT_CHARS);
        // Second pass: the long line whole, then too little room for the short line or its least cut, but what is left
        // holds Related Context with the association.
        const left = shortLine - 11;
        expect(left - 1).toBeLessThan(shortBare + MEMORY_CUT_MARKER.length + MIN_CUT_CONTENT_CHARS);
        expect(Math.floor((left - 3) / 4) * 4).toBeGreaterThanOrEqual(graphChars);
        const total = Math.ceil((overhead + longLine + left) / 4);
        expect(alone(first, [long, short])).toEqual(['short']);
        expect(alone(total, [long, short])).toEqual(['long']);

        const result = assemble(total, total - first, [long, short], association);
        // The second pass only adds to the block: the short trace stays, the long one has no room beside it, and the
        // association stays out of Related Context, as the block already shows its trace.
        expect(sectionLines(result.contextText, '## Recent Experiences')).toEqual([formatMemoryTrace(short, style, { now })]);
        expect(result.includedMemoryIds).toEqual(['short']);
        expect(result.contextText).not.toContain('## Related Context');
        expect(result.contextText.split(fact)).toHaveLength(2);
        expect(result.tokensUsed).toBeLessThanOrEqual(total);
        expect(tokensOf(result.contextText)).toBeLessThanOrEqual(total);
      });

      it('keeps the trace in its section when its association would push a plain line Related Context showed out of it', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const now = Date.UTC(2026, 10, 9, 12, 0, 0);
        vi.setSystemTime(now);
        const long = makeScoredTrace({
          id: 'long',
          type: 'episodic',
          content: wordsText(50),
          entities: ['the harbor master of the north landing', 'the ferry captain of the evening crossing', 'the night watch at the east gate'],
          createdAt: now,
        });
        const short = makeScoredTrace({
          id: 'short',
          type: 'episodic',
          content: fact,
          entities: ['the harbor master', 'the ferry captain', 'the night watch'],
          createdAt: now,
        });
        const longLine = memoryTraceLineLength(long, style, { now });
        const shortLine = memoryTraceLineLength(short, style, { now });
        const overhead = sectionOverhead(now);
        const association = { traceId: 'short', text: '[associated, activation=0.70] Ferry at 7:40.' };
        const plain = 'Bring the red map.';
        const graphOverhead = 2 + '## Related Context (connected memories — use for depth)'.length + 1;

        // First pass: Recent Experiences holds the short line only; Related Context, on its grant, the plain line only.
        const first = Math.ceil((overhead + shortLine) / 4);
        const graphTokens = Math.ceil((graphOverhead + 2 + plain.length) / 4);
        // Second pass: Recent Experiences takes the long line on its tokens and the note's grant, leaving 8 tokens.
        const longTokens = Math.ceil((overhead + longLine) / 4);
        const second = longTokens + 8;
        const total = second + graphTokens;
        expect(alone(first, [long, short])).toEqual(['short']);
        expect(alone(second, [long, short])).toEqual(['long']);
        // Related Context on its tokens and those 8 holds the association, then too little room for the plain line.
        const graphRoom = 4 * (graphTokens + 8);
        expect(graphRoom).toBeGreaterThanOrEqual(graphOverhead + 2 + association.text.length);
        expect(graphRoom - graphOverhead - 2 - association.text.length - 1).toBeLessThan(2 + plain.length);

        const result = assembleMemoryContext({
          totalTokenBudget: total,
          allocation: {
            persistentMemory: 0,
            workingMemory: 0,
            semanticRecall: 0,
            prospectiveAlerts: 0,
            recentEpisodic: 0.5,
            graphAssociations: (graphTokens + 0.5) / total,
            observationNotes: (total - first - graphTokens + 0.5) / total,
          },
          traits,
          retrievedTraces: [long, short],
          graphContext: [association, plain],
          observationNotes: [wordsText(4000, 5)],
        });
        expect(sectionLines(result.contextText, '## Related Context')).toEqual([`- ${plain}`]);
        expect(result.contextText.split(fact)).toHaveLength(2);
        expect(result.includedMemoryIds).toEqual(['short']);
        expect(result.tokensUsed).toBeLessThanOrEqual(total);
        expect(tokensOf(result.contextText)).toBeLessThanOrEqual(total);
      });
    });

    it('shows an involuntary memory once: Related Context leaves out its association, and a late one stays out when Related Context shows it', () => {
      const content = 'The night the whole team stayed up to fix the outage.';
      const vivid = makeScoredTrace({
        id: 'old-vivid',
        type: 'episodic',
        createdAt: Date.now() - 30 * DAY_MS,
        content,
        emotionalContext: { valence: 0.8, arousal: 0.9, dominance: 0.5, intensity: 0.72, gmiMood: 'FOCUSED' },
      });
      const association = { traceId: 'old-vivid', text: `[associated, activation=0.60] ${content}` };
      const assemble = (budget: number) =>
        assembleMemoryContext({
          totalTokenBudget: budget,
          traits: { conscientiousness: 0.9 },
          graphContext: [association],
          mechanismsEngine: new CognitiveMechanismsEngine({ involuntaryRecall: { probability: 1 } }),
          allTraces: [vivid],
        });

      // Its tenth of 1600 tokens holds the memory whole, so the association to it is left out of Related Context.
      const held = assemble(1600);
      expect(held.contextText).toContain('## Something This Reminds Me Of');
      expect(held.contextText.split(content)).toHaveLength(2);
      expect(held.contextText).not.toContain('## Related Context');
      expect(held.includedMemoryIds).toEqual(['old-vivid']);

      // A tenth of 500 tokens after the preamble has no room for the line, so Related Context shows the association,
      // and the memory does not take the room the sections leave unspent.
      const late = assemble(500);
      expect(sectionLines(late.contextText, '## Related Context')).toEqual([`- ${association.text}`]);
      expect(late.contextText.split(content)).toHaveLength(2);
      expect(late.contextText).not.toContain('## Something This Reminds Me Of');
      expect(late.includedMemoryIds).toEqual([]);
    });
  });

  describe('the second pass only adds to the block', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    const RELATED_HEADER = '## Related Context (connected memories — use for depth)';
    /** The least `maxChars` for which `fits` holds. */
    const leastRoom = (fits: (maxChars: number) => boolean): number => {
      for (let maxChars = 0; maxChars <= 2000; maxChars++) if (fits(maxChars)) return maxChars;
      throw new Error('nothing up to 2000 characters fits');
    };

    it('keeps a Related Context line the first pass showed when the room left over would fit a cut of a long line before it (R2)', () => {
      const long = wordsText(2000);
      const short = 'Call Ana at noon';
      const overhead = 2 + RELATED_HEADER.length; // the separator and the header
      const total = 40;
      // The first pass renders Related Context on its 20 tokens: the line room holds the short line whole, not the
      // least cut of the long one. The note is too long for any room, so its 20 tokens go unspent.
      const firstRoom = 4 * 20 - overhead - 1;
      expect(firstRoom).toBeGreaterThanOrEqual(2 + short.length);
      expect(cutMemoryContent(long, firstRoom - 2)).toBe('');
      // On all 40 tokens, a cut of the long line fits the room the short line would take.
      expect(cutMemoryContent(long, 4 * total - overhead - 1 - 2)).not.toBe('');
      const input: MemoryAssemblerInput = {
        totalTokenBudget: total,
        allocation: {
          persistentMemory: 0,
          workingMemory: 0,
          semanticRecall: 0,
          recentEpisodic: 0,
          prospectiveAlerts: 0,
          graphAssociations: 0.5,
          observationNotes: 0.5,
        },
        traits: {},
        graphContext: [long, short],
        observationNotes: [wordsText(4000, 5)],
      };

      const result = assembleMemoryContext(input);
      const lines = sectionLines(result.contextText, '## Related Context');
      expect(lines.at(-1)).toBe(`- ${short}`);
      expect(lines).toHaveLength(2);
      expect(lines[0].startsWith(`- ${long.slice(0, 40)}`)).toBe(true);
      expect(lines[0].endsWith(MEMORY_CUT_MARKER)).toBe(true);
      expect(result.tokensUsed).toBeLessThanOrEqual(total);
      expect(tokensOf(result.contextText)).toBeLessThanOrEqual(total);

      expect(sectionLines(assembleMemoryContextFirstPass(input).contextText, '## Related Context')).toEqual([`- ${short}`]);
      expectKeepsFirstPass(input, 'R2');
    });

    it('keeps a recalled trace the first pass showed when a longer one would take its room and a later Related Context line would push out the association that showed it (R1)', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const now = Date.UTC(2026, 10, 9, 12, 0, 0);
      vi.setSystemTime(now);
      const traits = { openness: 0.9 };
      const style = 'narrative' as const;
      const entities = ['the harbor master of the north landing', 'the ferry captain of the evening crossing', 'the night watch at the east gate'];
      // Short content beside long entity lists: X and S are shown whole or not at all, never cut.
      const x = makeScoredTrace({ id: 'x', type: 'semantic', content: 'The gate code is 4417.', entities, createdAt: now });
      const s = makeScoredTrace({
        id: 's',
        type: 'semantic',
        content: 'The ferry leaves pier 3 at 7:40 sharp.',
        entities: [entities[0], entities[1], `${entities[2]} and the pier`],
        createdAt: now,
      });
      const e = makeScoredTrace({ id: 'e', type: 'episodic', content: 'We walked to the harbor.', createdAt: now });
      const y = makeScoredTrace({ id: 'y', type: 'episodic', content: wordsText(400), createdAt: now });
      const toY = { traceId: 'y', text: '[associated, activation=0.70] Ferry log for the evening crossing, kept by the harbor master at 9pm' };
      const tag = '[associated through the harbor ledger and a ferry timetable] ';
      const plainLong = `${tag}${wordsText(2000)}`;
      const toX = { traceId: 'x', text: 'Gate code 4417.' };

      const lineLength = (trace: ScoredMemoryTrace) => memoryTraceLineLength(trace, style, { now });
      expect([lineLength(x), lineLength(s), lineLength(e)]).toEqual([172, 201, 46]);
      // The least room a cut of Y needs, and a cut of the long Related Context line (its tag kept whole).
      expect(leastRoom((maxChars) => formatMemoryTrace(y, style, { now, maxChars }) !== '')).toBe(73);
      expect(2 + tag.length + leastRoom((maxChars) => cutMemoryContent(wordsText(2000), maxChars) !== '')).toBe(114);
      expect(2 + toY.text.length).toBe(100);
      // On its own, Relevant Memories holds X on the 62 tokens the first pass gives it, and S alone, X pushed out, when
      // rendered from scratch on the 94 the second pass offers.
      const alone = (budget: number) => assembleMemoryContext({ totalTokenBudget: budget, traits, retrievedTraces: [s, x] }).includedMemoryIds;
      expect(alone(62)).toEqual(['x']);
      expect(alone(94)).toEqual(['s']);

      const total = 162; // under the preamble's threshold
      const input: MemoryAssemblerInput = {
        totalTokenBudget: total,
        allocation: {
          persistentMemory: 0,
          workingMemory: 0,
          prospectiveAlerts: 0,
          semanticRecall: 0.25, // 40 tokens, then the 22 no share takes: 62
          recentEpisodic: 30.25 / total, // 30
          graphAssociations: 40.25 / total, // 40
          observationNotes: 30.25 / total, // 30, unspent: the note is too long for any room
        },
        traits,
        retrievedTraces: [s, x, e, y],
        graphContext: [toY, plainLong, toX],
        observationNotes: [wordsText(4000, 5)],
      };

      const result = assembleMemoryContext(input);
      // X stays where the first pass put it, once.
      expect(sectionLines(result.contextText, '## Relevant Memories')).toEqual([formatMemoryTrace(x, style, { now })]);
      expect(result.contextText.split('The gate code is 4417.')).toHaveLength(2);
      expect(result.contextText).not.toContain(toX.text);
      // Y stays shown once, through its association; Recent Experiences does not take it again.
      expect(sectionLines(result.contextText, '## Recent Experiences')).toEqual([formatMemoryTrace(e, style, { now })]);
      const related = sectionLines(result.contextText, '## Related Context');
      expect(related).toHaveLength(2);
      expect(related[0]).toBe(`- ${toY.text}`);
      expect(related[1].startsWith(`- ${tag}harbor`)).toBe(true);
      expect(related[1].endsWith(MEMORY_CUT_MARKER)).toBe(true);
      expect(result.includedMemoryIds).toEqual(['x', 'e']);
      expect(result.tokensUsed).toBeLessThanOrEqual(total);
      expect(tokensOf(result.contextText)).toBeLessThanOrEqual(total);

      // The first pass: X in Relevant Memories, E in Recent Experiences, and Y through its association in Related
      // Context, where the long line does not fit after it and X's association is left out as a duplicate.
      const first = assembleMemoryContextFirstPass(input);
      expect(sectionLines(first.contextText, '## Relevant Memories')).toEqual([formatMemoryTrace(x, style, { now })]);
      expect(sectionLines(first.contextText, '## Recent Experiences')).toEqual([formatMemoryTrace(e, style, { now })]);
      expect(sectionLines(first.contextText, '## Related Context')).toEqual([`- ${toY.text}`]);
      expectKeepsFirstPass(input, 'R1');
    });

    it('keeps every line the first pass renders, shows each trace once and stays within the budget, over generated blocks', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const now = Date.UTC(2026, 10, 9, 12, 0, 0);
      vi.setSystemTime(now);
      const random = seededRandom(20_261_109);
      const int = (lo: number, hi: number) => lo + Math.floor(random() * (hi - lo + 1));
      /** Text that starts with `id`, so no two items share a prefix. */
      const text = (id: string, chars: number) => `${id}: ${wordsText(chars, int(0, 7))}`;
      const keys = Object.keys(DEFAULT_BUDGET_ALLOCATION) as (keyof typeof DEFAULT_BUDGET_ALLOCATION)[];
      const styles = [{ conscientiousness: 0.9 }, { openness: 0.9 }, { emotionality: 0.9 }];

      for (let c = 0; c < 300; c++) {
        const label = `case ${c}`;
        const traces = Array.from({ length: int(0, 6) }, (_, i) => {
          const id = `t${c}x${i}`;
          return makeScoredTrace({
            id,
            type: random() < 0.5 ? 'semantic' : 'episodic',
            // Short content is shown whole or not at all; long content can be cut.
            content: text(id, random() < 0.4 ? int(1, 40) : int(41, 900)),
            entities: random() < 0.3 ? ['the harbor master', 'the ferry captain of the evening crossing'] : [],
            createdAt: now - int(0, 40) * DAY_MS,
          });
        });
        const vivid =
          random() < 0.3
            ? makeScoredTrace({
                id: `v${c}`,
                type: 'episodic',
                content: text(`v${c}`, int(10, 600)),
                createdAt: now - 30 * DAY_MS,
                emotionalContext: { valence: 0.8, arousal: 0.9, dominance: 0.5, intensity: 0.72, gmiMood: 'FOCUSED' },
              })
            : undefined;
        const targets = [...traces.map((trace) => trace.id), ...(vivid ? [vivid.id] : []), `elsewhere-${c}`];
        const graphContext = Array.from({ length: int(0, 6) }, (_, j) => {
          const body = text(`g${c}x${j}`, int(5, 700));
          if (random() < 0.35) return random() < 0.5 ? body : `[associated, activation=0.40] ${body}`;
          const traceId = targets[int(0, targets.length - 1)];
          return { traceId, text: `[associated, activation=0.60] ref:${traceId} ${body}` };
        });
        const lines = (prefix: string, maxChars: number) =>
          Array.from({ length: int(0, 3) }, (_, j) => text(`${prefix}${c}x${j}`, int(5, maxChars)));
        const allocation =
          random() < 0.4
            ? undefined
            : Object.fromEntries(
                keys.map((key) => {
                  const roll = random();
                  return [key, roll < 0.2 ? 0 : roll < 0.5 ? undefined : random() * 0.6];
                }),
              );
        const input: MemoryAssemblerInput = {
          totalTokenBudget: int(0, 900),
          allocation,
          traits: styles[int(0, 2)],
          persistentMemoryText: random() < 0.4 ? text(`p${c}`, int(10, 1500)) : undefined,
          workingMemoryText:
            random() < 0.5
              ? Array.from({ length: int(1, 5) }, (_, j) => `- [ACTIVE] mt_${c}_${j} ${wordsText(int(0, 120), j)}`).join('\n')
              : undefined,
          retrievedTraces: traces,
          prospectiveAlerts: lines('r', 200),
          graphContext,
          observationNotes: lines('o', 600),
          ...(vivid
            ? { mechanismsEngine: new CognitiveMechanismsEngine({ involuntaryRecall: { probability: 1 } }), allTraces: [vivid] }
            : {}),
        };

        expectKeepsFirstPass(input, label);
        // A trace appears once: Related Context shows no association to a trace the block holds elsewhere.
        const result = assembleMemoryContext(input);
        const referenced = sectionLines(result.contextText, '## Related Context').flatMap((line) => /ref:(\S+)/.exec(line)?.[1] ?? []);
        for (const id of referenced) expect(result.includedMemoryIds, `${label} ${id}`).not.toContain(id);
        expect(new Set(result.includedMemoryIds).size, label).toBe(result.includedMemoryIds.length);
      }
    });
  });
});
