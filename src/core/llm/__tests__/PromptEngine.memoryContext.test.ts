/**
 * PromptEngine's `memoryContextText`: the cognitive memory block the GMI hands
 * in beside `retrievedContext`. PromptEngine counts it into the prompt's tokens
 * and never summarises or truncates it; only the other retrieved context is
 * reduced, to what the retrieved-context share leaves beside the block. With
 * nothing to reduce, the prompt is the one the GMI's own join gave.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { PromptEngine } from '../PromptEngine';
import type { ModelTargetInfo, PromptExecutionContext } from '../IPromptEngine';

const baseModelInfo: ModelTargetInfo = {
  modelId: 'gpt-4o-mini',
  providerId: 'openai',
  maxContextTokens: 128000,
  optimalContextTokens: 64000,
  capabilities: ['chat'],
  promptFormatType: 'openai_chat',
  toolSupport: { supported: false, format: 'openai_functions' },
};

const baseExecutionContext: PromptExecutionContext = {
  activePersona: {
    id: 'persona-test',
    name: 'Test Persona',
    description: 'Test persona',
    baseSystemPrompt: 'You are helpful.',
    contextualPromptElements: [],
  } as any,
  workingMemory: {
    id: 'wm-test',
    initialize: async () => undefined,
    set: async () => undefined,
    get: async () => undefined,
    delete: async () => undefined,
    getAll: async () => ({}),
    clear: async () => undefined,
    size: async () => 0,
    has: async () => false,
    close: async () => undefined,
  } as any,
};

/** A 4,000-token model: the retrieved-context share is 800 tokens. */
const SMALL: ModelTargetInfo = { ...baseModelInfo, maxContextTokens: 4000, optimalContextTokens: 4000 };
const MEMORY =
  '## How To Use Your Memories\nUse them.\n\n## Relevant Memories\n' +
  Array.from({ length: 12 }, (_, i) => `- [episodic] The island ferry leaves pier ${i + 3} at ${6 + i}:15.`).join('\n');
const RAG_SHORT = 'Source A: the ferry timetable changes on the first of the month.';
const RAG_LONG = Array.from(
  { length: 200 },
  (_, i) => `Timetable row ${i}: the harbor office lists another crossing for the island route.`,
).join('\n');
const base = { systemPrompts: [{ content: 'Base instructions' }], userInput: 'When does the ferry leave?' };

type Counts = { memory: number; otherBefore: number; otherAfter: number };
const contextTokens = (r: { metadata: Record<string, unknown> }) => r.metadata.contextTokens as Counts;

describe('PromptEngine memoryContextText', () => {
  let engine: PromptEngine;
  const build = (components: Record<string, unknown>, model: ModelTargetInfo = SMALL) =>
    engine.constructPrompt(components as never, model, baseExecutionContext);

  beforeEach(async () => {
    engine = new PromptEngine();
    await engine.initialize({
      defaultTemplateName: 'openai_chat',
      availableTemplates: {},
      tokenCounting: { strategy: 'estimated' },
      historyManagement: {
        defaultMaxMessages: 10,
        maxTokensForHistory: 2048,
        summarizationTriggerRatio: 0.8,
        preserveImportantMessages: true,
      },
      contextManagement: {
        maxRAGContextTokens: 2048,
        summarizationQualityTier: 'balanced',
        preserveSourceAttributionInSummary: true,
      },
      contextualElementSelection: {
        maxElementsPerType: {},
        defaultMaxElementsPerType: 3,
        priorityResolutionStrategy: 'highest_first',
        conflictResolutionStrategy: 'skip_conflicting',
      },
      performance: {
        enableCaching: true,
        cacheTimeoutSeconds: 60,
      },
    });
  });

  it("with nothing to reduce, the prompt is byte-identical to today's join of memory and retrieved context", async () => {
    const split = await build({ ...base, memoryContextText: MEMORY, retrievedContext: RAG_SHORT }, baseModelInfo);
    const joined = await build({ ...base, retrievedContext: [MEMORY, RAG_SHORT].join('\n\n---\n\n') }, baseModelInfo);
    expect(JSON.stringify(split.prompt)).toBe(JSON.stringify(joined.prompt));
    expect(split.wasTruncatedOrSummarized).toBe(false);
    expect(contextTokens(split).otherAfter).toBe(contextTokens(split).otherBefore);
    expect(contextTokens(split).memory).toBeGreaterThan(0);
  });

  it('memory with no other context is the prompt the same text gives as retrievedContext', async () => {
    const split = await build({ ...base, memoryContextText: MEMORY }, baseModelInfo);
    const joined = await build({ ...base, retrievedContext: MEMORY }, baseModelInfo);
    expect(JSON.stringify(split.prompt)).toBe(JSON.stringify(joined.prompt));
    expect(contextTokens(split)).toMatchObject({ otherBefore: 0, otherAfter: 0 });
  });

  it('over the retrieved-context share, the memory text is unchanged and first and only the other context is reduced', async () => {
    const r = await build({ ...base, memoryContextText: MEMORY, retrievedContext: RAG_LONG });
    const text = JSON.stringify(r.prompt);
    expect(text).toContain(JSON.stringify(MEMORY).slice(1, -1));
    expect(text.indexOf('How To Use Your Memories')).toBeLessThan(text.indexOf('Timetable row 0'));
    expect(text).not.toContain('Timetable row 199');
    expect(r.modificationDetails?.truncatedComponents).toEqual(['retrievedContext']);
    const t = contextTokens(r);
    expect(t.otherAfter).toBeLessThan(t.otherBefore);
    expect(t.memory + t.otherAfter).toBeLessThanOrEqual(800);
  });

  it('a memory text larger than the whole share stays whole; the other context is removed and the change is reported', async () => {
    const big =
      MEMORY +
      '\n' +
      Array.from(
        { length: 80 },
        (_, i) => `- [semantic] Harbor note ${i}: the ticket desk opens forty minutes before each crossing.`,
      ).join('\n');
    const r = await build({ ...base, memoryContextText: big, retrievedContext: RAG_SHORT });
    const text = JSON.stringify(r.prompt);
    expect(text).toContain('Harbor note 79');
    expect(text).toContain(JSON.stringify(big).slice(1, -1));
    expect(text).not.toContain('Source A');
    expect(r.modificationDetails?.removedComponents).toEqual(['retrievedContext']);
    expect(contextTokens(r).otherAfter).toBe(0);
  });

  it('a prompt over its budget with no other context keeps the memory text whole and reports the overrun', async () => {
    const tiny: ModelTargetInfo = { ...baseModelInfo, maxContextTokens: 120, optimalContextTokens: 120 };
    const r = await build({ ...base, memoryContextText: MEMORY }, tiny);
    expect(JSON.stringify(r.prompt)).toContain(JSON.stringify(MEMORY).slice(1, -1));
    expect(r.issues?.map((issue) => issue.code)).toContain('TOKEN_BUDGET_EXCEEDED_POST_OPT');
    expect(contextTokens(r)).toMatchObject({ otherBefore: 0, otherAfter: 0 });
  });

  it('estimateFixedPromptTokens counts what the budget step never reduces: a memory text of the context less that count leaves the prompt within its budget', async () => {
    // About 3,300 tokens of question on the 4,000-token model, with earlier history and other retrieved context, both
    // of which the budget step reduces before it reports a prompt over its budget.
    const userInput = 'Which crossing suits a morning ferry? '.repeat(330);
    const conversationHistory = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Earlier message ${i}: the harbor office lists another crossing for the island route.`,
    }));
    const components = { ...base, userInput, conversationHistory, retrievedContext: RAG_LONG };
    const fixed = await engine.estimateFixedPromptTokens(components as never, SMALL, baseExecutionContext);
    // The question, and beside it the system prompt and the frame line that opens the note a memory text is sent in.
    const questionTokens = await engine.estimateTokenCount(userInput, SMALL.modelId);
    expect(fixed).toBeGreaterThan(questionTokens);
    expect(fixed).toBeLessThan(questionTokens + 100);
    // The same count with no history and no other context: neither is a fixed part.
    expect(await engine.estimateFixedPromptTokens({ ...base, userInput } as never, SMALL, baseExecutionContext)).toBe(fixed);

    const room = 4000 - fixed;
    expect(room).toBeGreaterThan(400);
    // A text PromptEngine counts as `tokens` on this model (3.8 characters a token).
    const memoryOf = (tokens: number) => 'm'.repeat(Math.floor(tokens * 3.8));
    expect(await engine.estimateTokenCount(memoryOf(room), SMALL.modelId)).toBe(room);

    const fits = await build({ ...components, memoryContextText: memoryOf(room) });
    expect(fits.issues?.map((issue) => issue.code) ?? []).not.toContain('TOKEN_BUDGET_EXCEEDED_POST_OPT');
    expect(JSON.stringify(fits.prompt)).toContain(memoryOf(room));
    expect(contextTokens(fits)).toMatchObject({ memory: room, otherAfter: 0 });

    // A memory text 40 tokens larger, more than the frame line's own count, takes the prompt over its budget.
    const over = await build({ ...components, memoryContextText: memoryOf(room + 40) });
    expect(over.issues?.map((issue) => issue.code)).toContain('TOKEN_BUDGET_EXCEEDED_POST_OPT');
  });

  it('estimateFixedPromptTokens counts the current turn\'s messages, the tools and the host\'s note, and leaves the history before the turn out', async () => {
    const earlier = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `Earlier message ${i}: the harbor office lists another crossing.` }));
    const turn = [{ role: 'user', content: 'When does the ferry leave? '.repeat(40) }];
    const count = (components: Record<string, unknown>) => engine.estimateFixedPromptTokens(components as never, SMALL, baseExecutionContext);
    const system = { systemPrompts: base.systemPrompts };
    const withTurn = await count({ ...system, conversationHistory: [...earlier, ...turn], currentTurnMessageCount: 1 });
    // The turn's message and its five tokens of overhead, as the budget step counts a message.
    const turnTokens = (await engine.estimateTokenCount(turn[0].content, SMALL.modelId)) + 5;
    expect(withTurn).toBe((await count({ ...system, userInput: 'x' })) - 1 + turnTokens);
    // The history before the turn changes nothing.
    expect(await count({ ...system, conversationHistory: turn, currentTurnMessageCount: 1 })).toBe(withTurn);
    // Each tool counts 50, as in the budget step.
    expect(await count({ ...system, conversationHistory: turn, currentTurnMessageCount: 1, tools: [{ name: 'lookup' }, { name: 'route' }] })).toBe(withTurn + 100);
    // The host's note counts with its frame line and the separator after it, in place of the frame line alone.
    const withNote = await count({ ...system, conversationHistory: turn, currentTurnMessageCount: 1, applicationNote: 'The harbor is closed on Mondays.' });
    expect(withNote).toBeGreaterThan(withTurn);
  });

  it('a prompt over its budget whose other context fits beside the memory text leaves that context as it is and reports no cut', async () => {
    // About 4,000 tokens of question on a 4,000-token model: the prompt is a few hundred tokens over its budget, and
    // the share less the memory text and the overrun still holds the short retrieved context.
    const userInput = 'Which crossing suits a morning ferry? '.repeat(400);
    const r = await build({ ...base, userInput, memoryContextText: MEMORY, retrievedContext: RAG_SHORT });
    const t = contextTokens(r);
    expect(t.otherAfter).toBe(t.otherBefore);
    expect(r.modificationDetails?.truncatedComponents ?? []).not.toContain('retrievedContext');
    expect(r.modificationDetails?.summarizedComponents ?? []).not.toContain('retrievedContext');
    expect(r.modificationDetails?.removedComponents ?? []).not.toContain('retrievedContext');
    expect(JSON.stringify(r.prompt)).toContain(RAG_SHORT);
    expect(r.issues?.map((issue) => issue.code)).toContain('TOKEN_BUDGET_EXCEEDED_POST_OPT');
  });

  it('beside a list of retrieved context the memory entry is counted as the template sends it, labels included', async () => {
    const memoryTokens = await engine.estimateTokenCount(MEMORY, SMALL.modelId);
    const room = 800 - memoryTokens;
    // Fits the share beside the bare memory text, not beside the labelled entry the template renders.
    const content = 'r'.repeat(Math.floor(room * 3.8));
    expect(await engine.estimateTokenCount(content, SMALL.modelId)).toBeLessThanOrEqual(room);
    const r = await build({ ...base, memoryContextText: MEMORY, retrievedContext: [{ source: 'timetable', content }] });
    const labelled = await engine.estimateTokenCount(`Source: cognitive_memory\nContent: ${MEMORY}\n\n`, SMALL.modelId);
    const t = contextTokens(r);
    expect(t.memory).toBe(labelled);
    expect(r.modificationDetails?.truncatedComponents).toEqual(['retrievedContext']);
    expect(t.memory + t.otherAfter).toBeLessThanOrEqual(800);
    expect(JSON.stringify(r.prompt)).toContain(JSON.stringify(MEMORY).slice(1, -1));
  });

  it('estimateFixedPromptTokens counts the labels a list of retrieved context puts on the memory entry: beside an empty list, a memory text of the context less that count leaves the prompt within its budget', async () => {
    // About 3,300 tokens of question on the 4,000-token model, and a host note, which the budget step counts as the
    // estimate does. The retrieved context is a list with no entry: the template still sends the memory text as the
    // list's first entry, under its `Source:` and `Content:` labels.
    const components = {
      ...base,
      userInput: 'Which crossing suits a morning ferry? '.repeat(330),
      applicationNote: 'The harbor office is closed on Mondays.',
    };
    const count = (c: Record<string, unknown>) => engine.estimateFixedPromptTokens(c as never, SMALL, baseExecutionContext);
    const fixed = await count({ ...components, retrievedContext: [] });
    const room = 4000 - fixed;
    expect(room).toBeGreaterThan(400);
    // A text PromptEngine counts as `tokens` on this model (3.8 characters a token).
    const memoryOf = (tokens: number) => 'm'.repeat(Math.floor(tokens * 3.8));
    const fits = await build({ ...components, retrievedContext: [], memoryContextText: memoryOf(room) });
    expect(JSON.stringify(fits.prompt)).toContain(`Source: cognitive_memory\\nContent: ${memoryOf(room)}`);
    expect(fits.issues?.map((issue) => issue.code) ?? []).not.toContain('TOKEN_BUDGET_EXCEEDED_POST_OPT');

    // The labels are the count's difference from the same prompt with no list.
    const withoutList = await count(components);
    const labels = await engine.estimateTokenCount('Source: cognitive_memory\nContent: ', SMALL.modelId);
    expect(labels).toBe(9);
    expect(fixed).toBe(withoutList + labels);
    // Beside entries, the blank line after the memory entry is counted too; the entries themselves are no fixed part.
    expect(await count({ ...components, retrievedContext: [{ source: 'timetable', content: RAG_LONG }] })).toBe(
      withoutList + (await engine.estimateTokenCount('Source: cognitive_memory\nContent: \n\n', SMALL.modelId)),
    );
  });

  it.each(['anthropic_messages', 'generic_completion'])('the %s template sends the memory block and the other context in front of the query', async (template) => {
    const model = { ...baseModelInfo, promptFormatType: template } as ModelTargetInfo;
    const r = await build({ ...base, memoryContextText: MEMORY, retrievedContext: RAG_SHORT }, model);
    expect(r.metadata.templateUsed).toBe(template);
    const text = JSON.stringify(r.prompt);
    expect(text).toContain(JSON.stringify(MEMORY).slice(1, -1));
    expect(text).toContain(RAG_SHORT);
    expect(text.indexOf('How To Use Your Memories')).toBeLessThan(text.indexOf(RAG_SHORT));
    expect(text.indexOf(RAG_SHORT)).toBeLessThan(text.indexOf('When does the ferry leave?'));
  });

  it('does not serve a prompt cached for another memory text', async () => {
    await build({ ...base, memoryContextText: 'The user prefers tea.' }, baseModelInfo);
    const second = await build({ ...base, memoryContextText: 'The user prefers coffee.' }, baseModelInfo);
    expect(JSON.stringify(second.prompt)).toContain('coffee');
    expect(JSON.stringify(second.prompt)).not.toContain('tea.');
  });
});
