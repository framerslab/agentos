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

/**
 * Whether `later` is `line`, or `line` lengthened. Only persistent memory's text is ever cut to fit, so only it can be
 * lengthened: its text before the truncation marker starts `later`.
 */
function keepsLine(line: string, later: string): boolean {
  if (later === line) return true;
  if (!line.endsWith(PERSISTENT_TRUNCATED)) return false;
  const at = line.lastIndexOf(PERSISTENT_TRUNCATED);
  return at > 0 && later.length > line.length - PERSISTENT_TRUNCATED.length && later.startsWith(line.slice(0, at));
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

    it('leaves out a trace that does not fit its section, in every formatting style, though a cut of it would fit', () => {
      const content = wordsText(6000);
      for (const traits of [{ conscientiousness: 0.9 }, { openness: 0.9 }, { emotionality: 0.9 }]) {
        const result = assembleMemoryContext({
          totalTokenBudget: 250, // under the preamble's threshold, so the trace has the whole budget
          traits,
          retrievedTraces: [makeScoredTrace({ id: 'huge', type: 'semantic', content })],
        });
        expect(result.contextText, JSON.stringify(traits)).toBe('');
        expect(result.includedMemoryIds, JSON.stringify(traits)).toEqual([]);
        expect(result.tokensUsed, JSON.stringify(traits)).toBe(0);
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

  describe('whole memories only', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
    const SEMANTIC_HEADER = "## Relevant Memories (facts — use as background truth, don't announce)";
    const EPISODIC_HEADER = '## Recent Experiences (events — weave in naturally, never list)';
    const RELATED_HEADER = '## Related Context (connected memories — use for depth)';
    const INVOLUNTARY_PREFIX = '[spontaneous memory] ';
    const STYLES = [
      ['structured', { conscientiousness: 0.9 }],
      ['narrative', { openness: 0.9 }],
      ['emotional', { emotionality: 0.9 }],
    ] as const;
    /** An allocation that gives the whole budget to section `key` and turns the others off. */
    const only = (key: keyof typeof DEFAULT_BUDGET_ALLOCATION) => ({
      persistentMemory: 0,
      workingMemory: 0,
      semanticRecall: 0,
      recentEpisodic: 0,
      prospectiveAlerts: 0,
      graphAssociations: 0,
      observationNotes: 0,
      [key]: 1,
    });
    /** Tokens of a line of `chars` characters with its newline, by the assembler's estimate. */
    const lineTokens = (chars: number) => Math.ceil((1 + chars) / 4);
    const vividTrace = (content: string) =>
      makeScoredTrace({
        id: 'old-vivid',
        type: 'episodic',
        createdAt: NOW - 30 * DAY_MS,
        content,
        emotionalContext: { valence: 0.8, arousal: 0.9, dominance: 0.5, intensity: 0.72, gmiMood: 'FOCUSED' },
      });

    it('a memory that does not fit whole in what is left of its section is left out, never cut, and a later one that fits is shown whole', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOW);
      for (const [style, traits] of STYLES) {
        const long = makeScoredTrace({ id: 'long', content: wordsText(500), createdAt: NOW });
        const short = makeScoredTrace({ id: 'short', content: wordsText(150, 3), createdAt: NOW });
        const longLine = memoryTraceLineLength(long, style, { now: NOW });
        const shortLine = memoryTraceLineLength(short, style, { now: NOW });
        // The least budget that holds the short line: under the preamble's threshold, with room for a cut of the long
        // line and not for the long line.
        const budget = Math.ceil((2 + SEMANTIC_HEADER.length + 1 + shortLine) / 4);
        const room = 4 * budget - 2 - SEMANTIC_HEADER.length - 1;
        expect(room, style).toBeLessThan(longLine);
        expect(formatMemoryTrace(long, style, { now: NOW, maxChars: room }), style).toContain(MEMORY_CUT_MARKER);

        const result = assembleMemoryContext({
          totalTokenBudget: budget,
          allocation: only('semanticRecall'),
          traits,
          retrievedTraces: [long, short],
        });
        expect(result.contextText, style).not.toContain(MEMORY_CUT_MARKER);
        expect(sectionLines(result.contextText, '## Relevant Memories'), style).toEqual([formatMemoryTrace(short, style, { now: NOW })]);
        expect(result.includedMemoryIds, style).toEqual(['short']);
        expect(result.lineOutcomes, style).toEqual([
          { id: 'long', section: 'semanticRecall', outcome: 'left_out', reason: 'section_full', tokens: lineTokens(longLine) },
          { id: 'short', section: 'semanticRecall', outcome: 'included', tokens: lineTokens(shortLine) },
        ]);
        expect(result.tokensUsed, style).toBeLessThanOrEqual(budget);
        expect(tokensOf(result.contextText), style).toBeLessThanOrEqual(budget);
      }
    });

    it('reports why a memory is left out: budget when its section was offered no room, section_full when it did not fit the room offered', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOW);
      const trace = makeScoredTrace({ id: 'a', content: wordsText(40), createdAt: NOW });
      const tokens = lineTokens(memoryTraceLineLength(trace, 'structured', { now: NOW }));

      const none = assembleMemoryContext({ totalTokenBudget: 0, allocation: only('semanticRecall'), traits: {}, retrievedTraces: [trace] });
      expect(none.contextText).toBe('');
      expect(none.lineOutcomes).toEqual([{ id: 'a', section: 'semanticRecall', outcome: 'left_out', reason: 'budget', tokens }]);

      // A section a share of 0 turns off is offered no room either, whatever the budget.
      const off = assembleMemoryContext({ totalTokenBudget: 1600, allocation: { semanticRecall: 0 }, traits: {}, retrievedTraces: [trace] });
      expect(off.contextText).not.toContain('## Relevant Memories');
      expect(off.lineOutcomes).toEqual([{ id: 'a', section: 'semanticRecall', outcome: 'left_out', reason: 'budget', tokens }]);

      // Twenty tokens hold the section's header and eight characters more: some room, too little for the line.
      const small = assembleMemoryContext({ totalTokenBudget: 20, allocation: only('semanticRecall'), traits: {}, retrievedTraces: [trace] });
      expect(small.contextText).toBe('');
      expect(small.lineOutcomes).toEqual([{ id: 'a', section: 'semanticRecall', outcome: 'left_out', reason: 'section_full', tokens }]);

      const whole = assembleMemoryContext({ totalTokenBudget: 1600, traits: {}, retrievedTraces: [trace] });
      expect(whole.contextText).toContain(trace.content);
      expect(whole.lineOutcomes).toEqual([{ id: 'a', section: 'semanticRecall', outcome: 'included', tokens }]);
      expect(whole.lineOutcomes?.[0]).not.toHaveProperty('reason');
    });

    it('a graph association renders whole or not at all, with or without a trace id', () => {
      const text = `[associated, activation=0.80] ${wordsText(500)}`;
      const line = `- ${text}`;
      // 69 tokens leave Related Context 218 characters for a line: room for a cut of this one, not for the line.
      const tight = assembleMemoryContext({
        totalTokenBudget: 69,
        allocation: only('graphAssociations'),
        traits: {},
        graphContext: [{ traceId: 'g', text }, text],
      });
      expect(4 * 69 - 2 - RELATED_HEADER.length - 1).toBeLessThan(line.length);
      expect(tight.contextText).toBe('');
      expect(tight.tokensUsed).toBe(0);
      // The association that carries a trace id is reported; a plain line leads to no trace.
      expect(tight.lineOutcomes).toEqual([
        { id: 'g', section: 'graphAssociations', outcome: 'left_out', reason: 'section_full', tokens: lineTokens(line.length) },
      ]);

      const budget = Math.ceil((2 + RELATED_HEADER.length + 1 + line.length) / 4);
      const roomy = assembleMemoryContext({
        totalTokenBudget: budget,
        allocation: only('graphAssociations'),
        traits: {},
        graphContext: [{ traceId: 'g', text }],
      });
      expect(sectionLines(roomy.contextText, '## Related Context')).toEqual([line]);
      expect(roomy.lineOutcomes).toEqual([
        { id: 'g', section: 'graphAssociations', outcome: 'included', tokens: lineTokens(line.length) },
      ]);
    });

    it('the involuntary memory renders whole or not at all', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOW);
      const vivid = vividTrace(wordsText(600));
      const lineChars = INVOLUNTARY_PREFIX.length + memoryTraceLineLength(vivid, 'structured', { now: NOW });
      const assemble = (budget: number) =>
        assembleMemoryContext({
          totalTokenBudget: budget,
          traits: { conscientiousness: 0.9 },
          mechanismsEngine: new CognitiveMechanismsEngine({ involuntaryRecall: { probability: 1 } }),
          allTraces: [vivid],
        });

      // 100 tokens have room for a cut of the memory and not for the memory: nothing renders.
      const tight = assemble(100);
      expect(tight.contextText).toBe('');
      expect(tight.includedMemoryIds).toEqual([]);
      expect(tight.lineOutcomes).toEqual([
        { id: 'old-vivid', section: 'involuntary', outcome: 'left_out', reason: 'section_full', tokens: lineTokens(lineChars) },
      ]);

      expect(assemble(0).lineOutcomes).toEqual([
        { id: 'old-vivid', section: 'involuntary', outcome: 'left_out', reason: 'budget', tokens: lineTokens(lineChars) },
      ]);

      const roomy = assemble(250);
      expect(roomy.contextText).toContain(`${INVOLUNTARY_PREFIX}${formatMemoryTrace(vivid, 'structured', { now: NOW })}`);
      expect(roomy.contextText).not.toContain(MEMORY_CUT_MARKER);
      expect(roomy.includedMemoryIds).toEqual(['old-vivid']);
      expect(roomy.lineOutcomes).toEqual([
        { id: 'old-vivid', section: 'involuntary', outcome: 'included', tokens: lineTokens(lineChars) },
      ]);
      expect(roomy.tokensUsed).toBeLessThanOrEqual(250);
    });

    describe('blocks whose memories all fit whole', () => {
      const PREAMBLE_HEAD = [
        '## How To Use Your Memories',
        '',
        '- **Working Memory**: Reference directly — this is your active context.',
        "- **Semantic Recall** (facts): Background truth. Don't announce — let it shape responses naturally.",
        '- **Episodic Memories** (experiences): Weave in naturally. Never list.',
        '- **Prospective Alerts** (reminders): Act on these. Bring up naturally.',
        '- **Relational Signals** (trust/bonds): Modulate TONE, not words. Never state explicitly.',
        '- **Graph Associations** (connected memories): Use for richer context and connection depth.',
        '- **Partial Memories** (feeling-of-knowing): Express uncertainty naturally — "I feel like we talked about..."',
      ];
      const preamble = (guidance: string) => [...PREAMBLE_HEAD, '', guidance].join('\n');
      const TIMETABLE = 'We checked the harbor timetable together. The ferry to the island leaves at 7:40 from pier 3.';
      const BASKET = '[associated, activation=0.40] We bought the picnic basket at the harbor market.';
      const NIGHT = 'The night the whole team stayed up to fix the outage.';

      /** A structured block of two traces: tags, a confidence above 0.8 and a retrieval score of its own. */
      const structuredInput = (): MemoryAssemblerInput => ({
        totalTokenBudget: 1600,
        traits: {},
        retrievedTraces: [
          makeScoredTrace({ id: 'sem', type: 'semantic', content: 'The team meets on Thursdays.', createdAt: NOW, tags: ['team', 'calendar'] }),
          makeScoredTrace({
            id: 'epi',
            type: 'episodic',
            content: 'We walked to the harbor after the meeting.',
            createdAt: NOW - 26 * DAY_MS,
            provenance: { sourceType: 'user_statement', sourceTimestamp: NOW, confidence: 0.9, verificationCount: 0 },
            retrievalScore: 0.62,
          }),
        ],
      });
      /** A narrative block with every section, and an association to a trace the block already holds. */
      const narrativeInput = (): MemoryAssemblerInput => ({
        totalTokenBudget: 1600,
        traits: { openness: 0.9 },
        persistentMemoryText: '# Notes\n- Prefers morning ferries.',
        workingMemoryText: '- [ACTIVE] mt_0001 (activation: 0.90)\n- [fading] mt_0002 (activation: 0.40)',
        retrievedTraces: [
          makeScoredTrace({
            id: 'd',
            type: 'episodic',
            content: TIMETABLE,
            entities: ['the harbor master', 'the ferry captain', 'the night watch', 'a fourth the line leaves out'],
            associatedTraceIds: ['e', 'f'],
            createdAt: NOW - 3 * DAY_MS,
          }),
        ],
        prospectiveAlerts: ['[time_based] Call the harbor office on Monday.'],
        graphContext: [
          { traceId: 'd', text: `[associated, activation=0.80] ${TIMETABLE}` },
          { traceId: 'e', text: BASKET },
          'A plain line that carries no trace id.',
        ],
        observationNotes: ['The user plans trips a week ahead.'],
      });
      /** An emotional block of one trace and the involuntary memory. */
      const emotionalInput = (): MemoryAssemblerInput => ({
        totalTokenBudget: 1600,
        traits: { emotionality: 0.9 },
        retrievedTraces: [
          makeScoredTrace({
            id: 'sem',
            type: 'semantic',
            content: 'The outage started in the billing queue.',
            createdAt: NOW - 2 * 3_600_000,
            emotionalContext: { valence: -0.6, arousal: 0.7, dominance: 0, intensity: 0.42, gmiMood: 'CONCERNED' },
          }),
        ],
        mechanismsEngine: new CognitiveMechanismsEngine({ involuntaryRecall: { probability: 1 } }),
        allTraces: [vividTrace(NIGHT)],
      });

      const STRUCTURED_BLOCK = [
        preamble('Organize your references to past knowledge logically. Connect facts to the current discussion with clear reasoning.'),
        '',
        SEMANTIC_HEADER,
        '- [semantic] The team meets on Thursdays. (just now, 2026-11-09 | moderate confidence | relevance: 0.80 | tags: team, calendar)',
        '',
        EPISODIC_HEADER,
        '- [episodic] We walked to the harbor after the meeting. (26 days ago, 2026-10-14 | high confidence | relevance: 0.62)',
      ].join('\n');
      const NARRATIVE_BLOCK = [
        preamble('Let memories flow into your responses as stories and associations. Draw creative connections between past and present.'),
        '',
        '## Persistent Memory',
        '',
        '# Notes',
        '- Prefers morning ferries.',
        '',
        '## Active Context (in focus — reference directly)',
        '- [ACTIVE] mt_0001 (activation: 0.90)',
        '- [fading] mt_0002 (activation: 0.40)',
        '',
        EPISODIC_HEADER,
        `3d ago, 2026-11-06: ${TIMETABLE} [linked to 2 other memories] (involves: the harbor master, the ferry captain, the night watch)`,
        '',
        '## Reminders (act on these — bring up naturally)',
        '- [time_based] Call the harbor office on Monday.',
        '',
        RELATED_HEADER,
        `- ${BASKET}`,
        '- A plain line that carries no trace id.',
        '',
        '## Observations',
        '- The user plans trips a week ahead.',
      ].join('\n');
      const EMOTIONAL_BLOCK = [
        preamble('Let emotional memories influence your mood and empathy. If you recall a time the user was struggling, let that inform your warmth now.'),
        '',
        SEMANTIC_HEADER,
        '(-) 2h ago, 2026-11-09: The outage started in the billing queue. [mood: CONCERNED]',
        '',
        '## Something This Reminds Me Of',
        `${INVOLUNTARY_PREFIX}(+) 30 days ago, 2026-10-10: ${NIGHT} [strongly felt, mood: FOCUSED]`,
      ].join('\n');

      it('render byte for byte the block pinned for them: leaving out what does not fit changes no line of a block that holds everything', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        // The three blocks are pinned from the assembler that cut a line to fit what was left of its section. None of
        // their lines needed a cut, so the assembler that leaves such a line out renders them the same.
        expect(assembleMemoryContext(structuredInput()).contextText).toBe(STRUCTURED_BLOCK);
        expect(assembleMemoryContext(narrativeInput()).contextText).toBe(NARRATIVE_BLOCK);
        expect(assembleMemoryContext(emotionalInput()).contextText).toBe(EMOTIONAL_BLOCK);
      });

      it('report every memory line as included, once: a trace the block shows in its own section is not reported again for its association', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        const lineOf = (block: string, header: string, index = 0) => sectionLines(block, header)[index].length;

        expect(assembleMemoryContext(structuredInput()).lineOutcomes).toEqual([
          { id: 'sem', section: 'semanticRecall', outcome: 'included', tokens: lineTokens(lineOf(STRUCTURED_BLOCK, '## Relevant Memories')) },
          { id: 'epi', section: 'recentEpisodic', outcome: 'included', tokens: lineTokens(lineOf(STRUCTURED_BLOCK, '## Recent Experiences')) },
        ]);
        expect(assembleMemoryContext(narrativeInput()).lineOutcomes).toEqual([
          { id: 'd', section: 'recentEpisodic', outcome: 'included', tokens: lineTokens(lineOf(NARRATIVE_BLOCK, '## Recent Experiences')) },
          { id: 'e', section: 'graphAssociations', outcome: 'included', tokens: lineTokens(lineOf(NARRATIVE_BLOCK, '## Related Context')) },
        ]);
        expect(assembleMemoryContext(emotionalInput()).lineOutcomes).toEqual([
          { id: 'sem', section: 'semanticRecall', outcome: 'included', tokens: lineTokens(lineOf(EMOTIONAL_BLOCK, '## Relevant Memories')) },
          { id: 'old-vivid', section: 'involuntary', outcome: 'included', tokens: lineTokens(lineOf(EMOTIONAL_BLOCK, '## Something This Reminds Me Of')) },
        ]);
      });
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
      const traces = many('episodic', 20, 400);
      const result = assembleMemoryContext({
        totalTokenBudget: 1600,
        traits: { conscientiousness: 0.9 },
        retrievedTraces: traces,
      });
      const bullets = sectionLines(result.contextText, '## Recent Experiences');
      // A fixed 25% share held three of these.
      expect(bullets.length).toBeGreaterThan(8);
      expect(result.contextText).not.toContain(MEMORY_CUT_MARKER);
      expect(result.tokensUsed).toBeLessThanOrEqual(1600);
      expect(tokensOf(result.contextText)).toBeLessThanOrEqual(1600);
      // Whole traces only: the room left is smaller than the line of any trace left out.
      const leftOut = traces.filter((trace) => !result.includedMemoryIds.includes(trace.id));
      expect(leftOut.length).toBeGreaterThan(0);
      const least = Math.min(...leftOut.map((trace) => memoryTraceLineLength(trace, 'structured')));
      expect((1600 - result.tokensUsed) * 4).toBeLessThan(1 + least);
    });

    it('fills Semantic Recall first from the spare budget and keeps Recent Episodic at least its own share', () => {
      const budget = 4000;
      const traces = [...many('semantic', 40, 400), ...many('episodic', 40, 400)];
      const result = assembleMemoryContext({
        totalTokenBudget: budget,
        traits: { conscientiousness: 0.9 },
        retrievedTraces: traces,
      });
      const preambleTokens = tokensOf(result.contextText.split('\n\n## Relevant Memories')[0]);
      const available = budget - preambleTokens;
      const semantic = sectionLines(result.contextText, '## Relevant Memories').join('\n');
      const episodic = sectionLines(result.contextText, '## Recent Experiences').join('\n');
      /** Tokens of the longest trace line with its newline: the most a section leaves unspent when a trace does not fit. */
      const lineTokens = Math.ceil((1 + Math.max(...traces.map((trace) => memoryTraceLineLength(trace, 'structured')))) / 4);
      // Episodic's share, give or take one whole trace: the trace that does not fit it, and what Semantic Recall left
      // unspent for the same reason. The 20 tokens cover the section's header and the rounding.
      expect(tokensOf(episodic)).toBeGreaterThan(Math.floor(available * 0.25) - lineTokens - 20);
      expect(tokensOf(episodic)).toBeLessThanOrEqual(Math.floor(available * 0.25) + lineTokens);
      // Semantic gets its 40% plus every share no other section used.
      expect(tokensOf(semantic)).toBeGreaterThan(Math.floor(available * 0.7) - 60);
      expect(result.tokensUsed).toBeLessThanOrEqual(budget);
    });

    it('gives the grant of a working memory too long for the block back to the recalled traces', () => {
      const input: MemoryAssemblerInput = {
        totalTokenBudget: 600,
        traits: { conscientiousness: 0.9 },
        workingMemoryText: wordsText(3000),
        retrievedTraces: many('semantic', 20, 400),
      };
      const result = assembleMemoryContext(input);
      expect(result.contextText).not.toContain('## Active Context');
      // The second pass gives working memory's unspent grant to Relevant Memories, which then holds one more trace.
      expect(result.includedMemoryIds.length).toBeGreaterThan(assembleMemoryContextFirstPass(input).includedMemoryIds.length);
      // Whole traces only: the room left is smaller than the line of any trace left out.
      const leftOut = input.retrievedTraces!.filter((trace) => !result.includedMemoryIds.includes(trace.id));
      expect(leftOut.length).toBeGreaterThan(0);
      const least = Math.min(...leftOut.map((trace) => memoryTraceLineLength(trace, 'structured')));
      expect((600 - result.tokensUsed) * 4).toBeLessThan(1 + least);
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
        // A tenth of 1600 tokens does not hold this trace; the rest of the block is empty.
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

    it('a graph association too long for what is left of its section is left out whole, and rendered whole when it fits', () => {
      const content = `${wordsText(400)} The spare key is under the blue flowerpot. ${wordsText(2000, 3)}`;
      const item = `[associated, activation=0.80] ${content}`;
      // 200 tokens have room for a cut of the association that would keep the fact, and not for the association.
      const result = assembleMemoryContext({ totalTokenBudget: 200, traits: {}, graphContext: [item] });
      expect(result.contextText).toBe('');
      expect(result.tokensUsed).toBe(0);
      // Whole when it fits.
      const whole = assembleMemoryContext({ totalTokenBudget: 1600, traits: {}, graphContext: [item.slice(0, 700)] });
      expect(whole.contextText).toContain(item.slice(0, 700));
      expect(whole.contextText).not.toContain(MEMORY_CUT_MARKER);
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

    it('shows a trace once when the second pass has room for it: Related Context keeps the association the first pass showed, and the room goes to the next trace', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const now = Date.UTC(2026, 10, 9, 12, 0, 0);
      vi.setSystemTime(now);
      const traits = { openness: 0.9 };
      const style = 'narrative' as const;
      const first = makeScoredTrace({ id: 'epi-1', type: 'episodic', content: `Lantern walk: ${wordsText(120, 1)}`, createdAt: now });
      const second = makeScoredTrace({ id: 'epi-2', type: 'episodic', content: `Ferry log: ${wordsText(60, 2)}`, createdAt: now });
      const third = makeScoredTrace({ id: 'epi-3', type: 'episodic', content: `Harbor notes: ${wordsText(60, 3)}`, createdAt: now });
      const association = { traceId: 'epi-2', text: '[associated, activation=0.70] Ferry log, in short.' };
      const [firstLine, secondLine, thirdLine] = [first, second, third].map((trace) => memoryTraceLineLength(trace, style, { now }));
      const associationLine = 2 + association.text.length;
      const episodicOverhead = 2 + '## Recent Experiences (events — weave in naturally, never list)'.length;
      const relatedOverhead = 2 + '## Related Context (connected memories — use for depth)'.length;
      // First pass: Recent Experiences renders on the tokens its first trace needs, with no room for another, and
      // Related Context on the tokens its association needs. The note is too long for any room, so its grant goes unspent.
      const episodicTokens = Math.ceil((episodicOverhead + 1 + firstLine) / 4);
      const relatedTokens = Math.ceil((relatedOverhead + 1 + associationLine) / 4);
      // Second pass: the note's grant gives Recent Experiences room for either of the two other traces, not for both.
      const noteTokens = Math.ceil((1 + Math.max(secondLine, thirdLine)) / 4) + 1;
      const total = episodicTokens + relatedTokens + noteTokens;
      const secondPassRoom = 4 * (episodicTokens + noteTokens) - episodicOverhead - 1 - firstLine;
      expect(secondPassRoom).toBeGreaterThanOrEqual(1 + secondLine);
      expect(secondPassRoom).toBeGreaterThanOrEqual(1 + thirdLine);
      expect(secondPassRoom).toBeLessThan(2 + secondLine + thirdLine);
      const input: MemoryAssemblerInput = {
        totalTokenBudget: total,
        allocation: {
          persistentMemory: 0,
          workingMemory: 0,
          semanticRecall: 0,
          prospectiveAlerts: 0,
          recentEpisodic: 0.1,
          graphAssociations: (relatedTokens + 0.5) / total,
          observationNotes: (noteTokens + 0.5) / total,
        },
        traits,
        retrievedTraces: [first, second, third],
        graphContext: [association],
        observationNotes: [wordsText(4000, 5)],
      };

      // The first pass shows the second trace only through its association.
      const firstPass = assembleMemoryContextFirstPass(input);
      expect(sectionLines(firstPass.contextText, '## Recent Experiences')).toEqual([formatMemoryTrace(first, style, { now })]);
      expect(sectionLines(firstPass.contextText, '## Related Context')).toEqual([`- ${association.text}`]);

      // The second pass has room for the second trace in Recent Experiences, which leaves it out, as the block already
      // shows it; the room goes to the third trace instead of staying unspent.
      const result = assembleMemoryContext(input);
      expect(result.contextText.split('Ferry log')).toHaveLength(2);
      expect(sectionLines(result.contextText, '## Related Context')).toEqual([`- ${association.text}`]);
      expect(sectionLines(result.contextText, '## Recent Experiences')).toEqual([
        formatMemoryTrace(first, style, { now }),
        formatMemoryTrace(third, style, { now }),
      ]);
      expect(result.includedMemoryIds).toEqual(['epi-1', 'epi-3']);
      expect(result.tokensUsed).toBeLessThanOrEqual(total);
      expect(tokensOf(result.contextText)).toBeLessThanOrEqual(total);
      // Each trace is reported once: the second under Related Context, which shows it.
      expect(result.lineOutcomes).toEqual([
        { id: 'epi-1', section: 'recentEpisodic', outcome: 'included', tokens: Math.ceil((1 + firstLine) / 4) },
        { id: 'epi-3', section: 'recentEpisodic', outcome: 'included', tokens: Math.ceil((1 + thirdLine) / 4) },
        { id: 'epi-2', section: 'graphAssociations', outcome: 'included', tokens: Math.ceil((1 + associationLine) / 4) },
      ]);
    });

    it('keeps working memory to its leading slots when a longer slot does not fit, and skips a graph association that does not fit', () => {
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
      // The room left after the first trace holds the short line, and the long one does not fit it.
      const lineShort = memoryTraceLineLength(short, 'structured', { now });

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
        const short = makeScoredTrace({ id: 'short', type: 'episodic', content: fact, createdAt: now });
        const bare = memoryTraceLineLength(makeScoredTrace({ type: 'episodic', content: '', createdAt: now }), style, { now });
        const shortLine = memoryTraceLineLength(short, style, { now });
        const overhead = sectionOverhead(now);

        // First pass: room for the short line, too little for the long one, eight characters longer than the room.
        const first = Math.ceil((overhead + shortLine) / 4);
        const firstRoom = 4 * first - overhead;
        expect(shortLine).toBeLessThanOrEqual(firstRoom);
        const long = makeScoredTrace({ id: 'long', type: 'episodic', content: 'b'.repeat(firstRoom + 8 - bare), createdAt: now });
        expect(memoryTraceLineLength(long, style, { now })).toBe(firstRoom + 8);
        // Twenty characters more: the long line fits whole, and the short line no longer fits after it.
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
        // Entities lengthen a line without lengthening its content.
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
        const graphChars = 2 + '## Related Context (connected memories — use for depth)'.length + 1 + 2 + association.text.length;

        // First pass: room for the short line, too little for the long line.
        const first = Math.ceil((overhead + shortLine) / 4);
        const firstRoom = 4 * first - overhead;
        expect(firstRoom).toBeLessThan(longLine);
        // Second pass: the long line, then too little room for the short line, but what is left holds Related Context
        // with the association.
        const left = shortLine - 11;
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

    it('keeps a Related Context line the first pass showed when the room left over would hold a longer line before it on its own (R2)', () => {
      const short = 'Call Ana at noon';
      const overhead = 2 + RELATED_HEADER.length; // the separator and the header
      const total = 40;
      // The first pass renders Related Context on its 20 tokens: the line room holds the short line, not the long one.
      // The note is too long for any room, so its 20 tokens go unspent.
      const firstRoom = 4 * 20 - overhead - 1;
      expect(firstRoom).toBeGreaterThanOrEqual(2 + short.length);
      // On all 40 tokens the long line fits on its own, with no room for the short line after it; beside the short
      // line the first pass showed, it does not fit.
      const totalRoom = 4 * total - overhead - 1;
      const long = 'x'.repeat(totalRoom - 2 - 4);
      const longLine = 2 + long.length;
      expect(longLine).toBeGreaterThan(firstRoom);
      expect(totalRoom - longLine - 1).toBeLessThan(2 + short.length);
      expect(totalRoom - (2 + short.length) - 1).toBeLessThan(longLine);
      const off = { persistentMemory: 0, workingMemory: 0, semanticRecall: 0, recentEpisodic: 0, prospectiveAlerts: 0 };
      const input: MemoryAssemblerInput = {
        totalTokenBudget: total,
        allocation: { ...off, graphAssociations: 0.5, observationNotes: 0.5 },
        traits: {},
        graphContext: [long, short],
        observationNotes: [wordsText(4000, 5)],
      };
      // Rendered from scratch on all 40 tokens, Related Context holds the long line alone.
      const scratch = assembleMemoryContext({
        totalTokenBudget: total,
        allocation: { ...off, graphAssociations: 1, observationNotes: 0 },
        traits: {},
        graphContext: [long, short],
      });
      expect(sectionLines(scratch.contextText, '## Related Context')).toEqual([`- ${long}`]);

      const result = assembleMemoryContext(input);
      expect(sectionLines(result.contextText, '## Related Context')).toEqual([`- ${short}`]);
      expect(result.contextText).not.toContain(MEMORY_CUT_MARKER);
      expect(result.tokensUsed).toBeLessThanOrEqual(total);
      expect(tokensOf(result.contextText)).toBeLessThanOrEqual(total);

      expect(sectionLines(assembleMemoryContextFirstPass(input).contextText, '## Related Context')).toEqual([`- ${short}`]);
      expectKeepsFirstPass(input, 'R2');
    });

    it('keeps a recalled trace the first pass showed when a longer one would take its room, and adds a later Related Context line beside the association that shows another (R1)', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const now = Date.UTC(2026, 10, 9, 12, 0, 0);
      vi.setSystemTime(now);
      const traits = { openness: 0.9 };
      const style = 'narrative' as const;
      const entities = ['the harbor master of the north landing', 'the ferry captain of the evening crossing', 'the night watch at the east gate'];
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
      const plain = `[associated through the harbor ledger and a ferry timetable] ${wordsText(50)}`;
      const toX = { traceId: 'x', text: 'Gate code 4417.' };

      const lineLength = (trace: ScoredMemoryTrace) => memoryTraceLineLength(trace, style, { now });
      expect([lineLength(x), lineLength(s), lineLength(e)]).toEqual([172, 201, 46]);
      // The two Related Context lines that can show: Y's association, and the plain line, longer than the 9
      // characters the first pass leaves after it and shorter than the 129 the second pass offers.
      expect([2 + toY.text.length, 2 + plain.length]).toEqual([100, 115]);
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
        graphContext: [toY, plain, toX],
        observationNotes: [wordsText(4000, 5)],
      };

      const result = assembleMemoryContext(input);
      // X stays where the first pass put it, once.
      expect(sectionLines(result.contextText, '## Relevant Memories')).toEqual([formatMemoryTrace(x, style, { now })]);
      expect(result.contextText.split('The gate code is 4417.')).toHaveLength(2);
      expect(result.contextText).not.toContain(toX.text);
      // Y stays shown once, through its association; Recent Experiences does not take it again.
      expect(sectionLines(result.contextText, '## Recent Experiences')).toEqual([formatMemoryTrace(e, style, { now })]);
      // The second pass adds the plain line after the association, whole.
      expect(sectionLines(result.contextText, '## Related Context')).toEqual([`- ${toY.text}`, `- ${plain}`]);
      expect(result.contextText).not.toContain(MEMORY_CUT_MARKER);
      expect(result.includedMemoryIds).toEqual(['x', 'e']);
      expect(result.tokensUsed).toBeLessThanOrEqual(total);
      expect(tokensOf(result.contextText)).toBeLessThanOrEqual(total);
      // One entry a trace, in the block's order: S left out of the room Relevant Memories was offered, Y under
      // Related Context, which shows it, and nothing again for X's association.
      const lineTokens = (chars: number) => Math.ceil((1 + chars) / 4);
      expect(result.lineOutcomes).toEqual([
        { id: 's', section: 'semanticRecall', outcome: 'left_out', reason: 'section_full', tokens: lineTokens(201) },
        { id: 'x', section: 'semanticRecall', outcome: 'included', tokens: lineTokens(172) },
        { id: 'e', section: 'recentEpisodic', outcome: 'included', tokens: lineTokens(46) },
        { id: 'y', section: 'graphAssociations', outcome: 'included', tokens: lineTokens(100) },
      ]);

      // The first pass: X in Relevant Memories, E in Recent Experiences, and Y through its association in Related
      // Context, where the plain line does not fit after it and X's association is left out as a duplicate.
      const first = assembleMemoryContextFirstPass(input);
      expect(sectionLines(first.contextText, '## Relevant Memories')).toEqual([formatMemoryTrace(x, style, { now })]);
      expect(sectionLines(first.contextText, '## Recent Experiences')).toEqual([formatMemoryTrace(e, style, { now })]);
      expect(sectionLines(first.contextText, '## Related Context')).toEqual([`- ${toY.text}`]);
      expectKeepsFirstPass(input, 'R1');
    });

    it('keeps every line the first pass renders, shows each trace once, cuts no memory line, reports each trace once and stays within the budget, over generated blocks', () => {
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
            // Lines of every length: each is shown whole or not at all.
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

        // No memory line is cut.
        expect(result.contextText, label).not.toContain(MEMORY_CUT_MARKER);
        // Every trace the block was given a line for (a retrieved trace, an association that carries its trace's id,
        // the involuntary memory) is reported once, with what became of it.
        const outcomes = result.lineOutcomes ?? [];
        const given = new Set([
          ...traces.map((trace) => trace.id),
          ...graphContext.flatMap((item) => (typeof item === 'string' ? [] : [item.traceId])),
          ...(vivid ? [vivid.id] : []),
        ]);
        expect(outcomes.map((line) => line.id).sort(), label).toEqual([...given].sort());
        const shown = blockSections(result.contextText);
        const shows = (header: string, needle: string) => (shown.get(header) ?? []).some((line) => line.includes(needle));
        for (const line of outcomes) {
          const where = `${label} ${line.id} (${line.section})`;
          // A trace's own line starts its content with its id; an association names the trace it leads to after `ref:`.
          const inTraceSection = shows('## Relevant Memories', `${line.id}: `) || shows('## Recent Experiences', `${line.id}: `);
          const inRelated = shows('## Related Context', `ref:${line.id} `);
          const asInvoluntary = shows('## Something This Reminds Me Of', `${line.id}: `);
          expect(line.tokens, where).toBeGreaterThan(0);
          if (line.outcome === 'included') {
            expect(line.reason, where).toBeUndefined();
            const inItsSection =
              line.section === 'graphAssociations' ? inRelated : line.section === 'involuntary' ? asInvoluntary : inTraceSection;
            expect(inItsSection, `${where} is shown there`).toBe(true);
          } else {
            expect(line.outcome, where).toBe('left_out');
            expect(['budget', 'section_full'], where).toContain(line.reason);
            if (input.totalTokenBudget === 0) expect(line.reason, where).toBe('budget');
            expect(inTraceSection || inRelated || asInvoluntary, `${where} is shown nowhere`).toBe(false);
          }
        }
        // The ids the block lists as included are the traces shown in their own section, and the involuntary memory.
        expect(
          outcomes.filter((line) => line.outcome === 'included' && line.section !== 'graphAssociations').map((line) => line.id).sort(),
          label,
        ).toEqual([...result.includedMemoryIds].sort());
      }
    });
  });
});
