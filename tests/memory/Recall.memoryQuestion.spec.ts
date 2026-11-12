/**
 * @fileoverview The memory-question reserve of `retrieval: 'hybrid'`: the English rule that says a turn asks about
 * something said before, the exact-words candidates past the cut it reserves room for, and how the recall section
 * sets aside that room before it fills.
 */

import { describe, expect, it } from 'vitest';
import { assembleMemoryContext } from '../../src/cognition/memory/core/prompt/MemoryPromptAssembler';
import { memoryTraceLineLength } from '../../src/cognition/memory/core/prompt/MemoryFormatters';
import type { ScoredMemoryTrace } from '../../src/cognition/memory/core/types';
import { isMemoryQuestion, reserveFor } from '../../src/cognition/memory/retrieval/recall/memoryQuestion';
import { assertRecallConfig, RecallOptionError } from '../../src/cognition/memory/retrieval/recall/budget';
import { dedupePool } from '../../src/cognition/memory/retrieval/recall/dedupe';

describe('isMemoryQuestion', () => {
  it.each([
    'Do you remember my locker code?',
    'Can you recall the name of that cafe',
    'Remind me what we decided',
    'Did I say when the lease ends?',
    'Have I told you about Ana?',
    'What did I tell you about the trip',
    'What was my old address',
    "What's my sister's name?",
    'What is my favourite tea',
    'What is my favorite tea',
    'Last time we spoke you had a plan',
    'Earlier you mentioned a ferry',
    'You told me the pier number',
    'REMEMBER the code',
  ])('fires on "%s"', (text) => expect(isMemoryQuestion(text)).toBe(true));

  it.each(['What is the bike shed code?', 'Remembering is hard', 'I recalled nothing', 'What is the capital of Peru', 'The last timer went off', 'Tell me a story', ''])(
    'does not fire on "%s"',
    (text) => expect(isMemoryQuestion(text)).toBe(false),
  );
});

describe('reserveFor', () => {
  const e = (id: string, ranks: Record<string, number>) => ({ id, ranks, fusedScore: 0, trace: { id } }) as never;

  it('takes the exact-words candidates the dense leg did not return and the cut left out, in exact-words order, two at topK 20', () => {
    const pool = [
      ...Array.from({ length: 20 }, (_, i) => e(`d${i}`, { dense: i + 1 })),
      e('w3', { exact_words: 3 }),
      e('both', { dense: 30, exact_words: 2 }),
      e('w1', { exact_words: 1, recency: 4 }),
      e('w5', { exact_words: 5 }),
      e('r', { recency: 1 }),
    ];
    expect(reserveFor(pool, 20).map((p: { id: string }) => p.id)).toEqual(['w1', 'w3']);
    // max(1, floor(9 / 10))
    expect(reserveFor(pool, 9).map((p: { id: string }) => p.id)).toEqual(['w1']);
    expect(reserveFor(pool.slice(0, 20), 20)).toEqual([]);
  });

  it("a newer exact-words-only correction that took a dense candidate's place past the cut is reserved by its own legs", () => {
    const sister = 'My sister Ana moved out of the old riverside flat last spring and now lives in';
    const t = (id: string, content: string, createdAt: number) => ({ id, content, createdAt });
    const pool = [
      ...Array.from({ length: 20 }, (_, i) => ({ id: `d${i}`, trace: t(`d${i}`, `Garden note ${i} on row ${i}`, 50), ranks: { dense: i + 1 }, fusedScore: 0.7 / (61 + i) })),
      { id: 'old', trace: t('old', `${sister} Porto`, 100), ranks: { dense: 21 }, fusedScore: 0.7 / 81 },
      { id: 'new', trace: t('new', `${sister} Lisbon`, 200), ranks: { exact_words: 1 }, fusedScore: 0.3 / 61 },
    ];
    const { kept } = dedupePool(pool, 0.8);
    expect(kept.slice(20).map((e) => e.id)).toEqual(['new']);
    expect(reserveFor(kept, 20).map((e) => e.id)).toEqual(['new']);
  });
});

describe("the manager's memoryQuestion setting", () => {
  it('is refused unless it is a function', () => {
    expect(() => assertRecallConfig({ memoryQuestion: 'remember' } as never, 'test')).toThrow(RecallOptionError);
    expect(() => assertRecallConfig({ memoryQuestion: () => true } as never, 'test')).not.toThrow();
  });
});

const WORDS = ['harbor', 'lantern', 'meadow', 'copper', 'thistle', 'granite', 'orchard', 'pebble'];
/** Text of exactly `chars` characters, made of words from WORDS. */
function wordsText(chars: number): string {
  let text = '';
  for (let i = 0; text.length < chars; i++) text += `${WORDS[i % WORDS.length]} `;
  return text.slice(0, chars);
}

const NOW = Date.now();
function makeScoredTrace(overrides: Partial<ScoredMemoryTrace> = {}): ScoredMemoryTrace {
  return {
    id: 'trace',
    type: 'semantic',
    scope: 'user',
    scopeId: 'agent-1',
    content: 'A sample memory trace content for testing purposes.',
    entities: [],
    tags: [],
    provenance: { sourceType: 'user_statement', sourceTimestamp: NOW, confidence: 0.8, verificationCount: 0 },
    emotionalContext: { valence: 0, arousal: 0.5, dominance: 0, intensity: 0, gmiMood: '' },
    encodingStrength: 0.7,
    stability: 3_600_000,
    retrievalCount: 1,
    lastAccessedAt: NOW,
    accessCount: 2,
    reinforcementInterval: 3_600_000,
    associatedTraceIds: [],
    createdAt: NOW,
    updatedAt: NOW,
    isActive: true,
    retrievalScore: 0.8,
    scoreBreakdown: { strengthScore: 0.7, similarityScore: 0.85, recencyScore: 0.5, emotionalCongruenceScore: 0.3, graphActivationScore: 0, importanceScore: 0.6 },
    ...overrides,
  };
}

describe('the recall section with reserved lines', () => {
  const RECALL_HEADER = "## Relevant Memories (facts and past events, most relevant first — use as background, don't announce)";
  const CHARS = 60;
  const line = (id: string, chars: number) => makeScoredTrace({ id, content: wordsText(chars) });
  const ONLY_RECALL = { workingMemory: 0, recall: 1, prospectiveAlerts: 0, graphAssociations: 0, observationNotes: 0, persistentMemory: 0 };
  /**
   * A budget whose recall section holds exactly `lines` lines of `chars` characters of content: the section's separator
   * and header, then each line with its newline, sized from `memoryTraceLineLength`. Small enough that the block has no
   * preamble (it needs its own tokens and 100 more).
   */
  const sectionBudget = (lines: number, chars: number): number => {
    const lineChars = memoryTraceLineLength(line('x', chars), 'structured', { now: Date.now() });
    const budget = Math.ceil((2 + RECALL_HEADER.length + lines * (1 + lineChars)) / 4);
    // One more line does not fit.
    expect(budget * 4).toBeLessThan(2 + RECALL_HEADER.length + (lines + 1) * (1 + lineChars));
    return budget;
  };

  it('"Remember my locker code?": the two reserved lines take their room first, the last fused lines that no longer fit are section_full, and the reserved lines render last', () => {
    const fused = Array.from({ length: 6 }, (_, i) => line(`f${i}`, CHARS));
    const reserved = [line('r1', CHARS), line('r2', CHARS)];
    const result = assembleMemoryContext({
      totalTokenBudget: sectionBudget(6, CHARS),
      allocation: ONLY_RECALL,
      traits: {},
      recallTraces: [...fused, ...reserved],
      reservedIds: ['r1', 'r2'],
    } as never);
    expect(result.contextText).not.toContain('## How To Use Your Memories');
    expect(result.includedMemoryIds).toEqual(['f0', 'f1', 'f2', 'f3', 'r1', 'r2']);
    expect(result.lineOutcomes!.filter((o) => o.outcome === 'left_out')).toEqual([
      expect.objectContaining({ id: 'f4', reason: 'section_full' }),
      expect.objectContaining({ id: 'f5', reason: 'section_full' }),
    ]);
  });

  it('without reserved ids the same lines fill in fused order', () => {
    const fused = Array.from({ length: 6 }, (_, i) => line(`f${i}`, CHARS));
    const result = assembleMemoryContext({
      totalTokenBudget: sectionBudget(6, CHARS),
      allocation: ONLY_RECALL,
      traits: {},
      recallTraces: [...fused, line('r1', CHARS), line('r2', CHARS)],
    } as never);
    expect(result.includedMemoryIds).toEqual(['f0', 'f1', 'f2', 'f3', 'f4', 'f5']);
  });

  it('a reserved line larger than the section is section_full and takes no room', () => {
    const result = assembleMemoryContext({
      totalTokenBudget: sectionBudget(2, CHARS),
      allocation: ONLY_RECALL,
      traits: {},
      recallTraces: [line('f0', CHARS), line('f1', CHARS), line('huge', 4000)],
      reservedIds: ['huge'],
    } as never);
    expect(result.includedMemoryIds).toEqual(['f0', 'f1']);
    expect(result.lineOutcomes).toContainEqual(expect.objectContaining({ id: 'huge', outcome: 'left_out', reason: 'section_full' }));
  });

  it('at a budget of 0 every line, reserved or not, is left out for the budget', () => {
    const result = assembleMemoryContext({
      totalTokenBudget: 0,
      allocation: ONLY_RECALL,
      traits: {},
      recallTraces: [line('f0', CHARS), line('r1', CHARS)],
      reservedIds: ['r1'],
    } as never);
    expect(result.lineOutcomes!.map((o) => [o.id, o.outcome, o.reason])).toEqual([
      ['f0', 'left_out', 'budget'],
      ['r1', 'left_out', 'budget'],
    ]);
  });

  it('reserved ids are not read without a recall pool', () => {
    const result = assembleMemoryContext({
      totalTokenBudget: sectionBudget(2, CHARS) + 400,
      allocation: { ...ONLY_RECALL, semanticRecall: 1, recentEpisodic: 0 },
      traits: {},
      retrievedTraces: [line('f0', CHARS), line('r1', CHARS)],
      reservedIds: ['r1'],
    } as never);
    expect(result.includedMemoryIds).toEqual(['f0', 'r1']);
  });
});
