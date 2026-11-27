/**
 * PromptEngine's `reservedTokens`: the tokens of a request that travel beside the prompt or are written into it after
 * it is built, which the engine cannot count (tool schemas sent as a request parameter, a response schema's payload,
 * a system message the caller adds). The budget step takes them off the model's budget before it reduces the earlier
 * history and the other retrieved context, so the prompt and what travels beside it fit the model's context together.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { APPLICATION_NOTE_FRAME, PromptEngine } from '../PromptEngine';
import type { ModelTargetInfo, PromptEngineResult, PromptExecutionContext } from '../IPromptEngine';

/** A 4,000-token model whose id PromptEngine counts at four characters a token: the history share is 1,400 tokens, the retrieved-context share 800. */
const MODEL: ModelTargetInfo = {
  modelId: 'stub-model',
  providerId: 'openai',
  maxContextTokens: 4000,
  optimalContextTokens: 4000,
  capabilities: ['chat'],
  promptFormatType: 'openai_chat',
  toolSupport: { supported: false, format: 'openai_functions' },
};

const executionContext: PromptExecutionContext = {
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

/** A question of 1,000 tokens (4,000 characters). */
const QUESTION = 'Which crossing suits a morning ferry? '.repeat(110).slice(0, 4_000);
/** Twenty earlier messages of 400 characters, 100 tokens each: 2,000 tokens, over the 1,400-token history share. */
const EARLIER = Array.from({ length: 20 }, (_, i) => {
  const head = `Earlier message ${String(i).padStart(2, '0')}: `;
  return { role: i % 2 === 0 ? 'user' : 'assistant', content: head + 'x'.repeat(400 - head.length) };
});
/** Other retrieved context of 800 tokens (3,200 characters): the whole 800-token share. */
const RETRIEVED = 'Timetable row: the harbor office lists another crossing. '.repeat(60).slice(0, 3_200);
const base = { systemPrompts: [{ content: 'Base instructions' }], userInput: QUESTION };

/** The tokens of the built prompt's text, at four characters a token. */
function promptTokens(result: PromptEngineResult): number {
  const texts = (result.prompt as Array<{ content: unknown }>).flatMap((message) => {
    if (typeof message.content === 'string') return [message.content];
    if (!Array.isArray(message.content)) return [];
    return message.content.flatMap((part) => (part && typeof (part as { text?: unknown }).text === 'string' ? [(part as { text: string }).text] : []));
  });
  return texts.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0);
}
const codes = (result: PromptEngineResult) => (result.issues ?? []).map((issue) => issue.code);
/** How many of the earlier messages the built prompt carries. */
const earlierKept = (result: PromptEngineResult) => EARLIER.filter((message) => JSON.stringify(result.prompt).includes(message.content.slice(0, 19))).length;

describe('PromptEngine reservedTokens', () => {
  let engine: PromptEngine;
  const build = (components: Record<string, unknown>) => engine.constructPrompt(components as never, MODEL, executionContext);

  beforeEach(async () => {
    engine = new PromptEngine();
    await engine.initialize({
      defaultTemplateName: 'openai_chat',
      availableTemplates: {},
      tokenCounting: { strategy: 'estimated' },
      historyManagement: { defaultMaxMessages: 10, maxTokensForHistory: 2048, summarizationTriggerRatio: 0.8, preserveImportantMessages: true },
      contextManagement: { maxRAGContextTokens: 2048, summarizationQualityTier: 'balanced', preserveSourceAttributionInSummary: true },
      contextualElementSelection: { maxElementsPerType: {}, defaultMaxElementsPerType: 3, priorityResolutionStrategy: 'highest_first', conflictResolutionStrategy: 'skip_conflicting' },
      performance: { enableCaching: false, cacheTimeoutSeconds: 60 },
    });
  });

  it('the earlier history is kept to what the budget less the reservation leaves, so the prompt and the reservation fit the context together', async () => {
    const components = { ...base, conversationHistory: EARLIER };
    // With nothing reserved the history is held to its share alone: at 105 tokens a message (100 of text and 5 for the
    // message), the newest 13 of the 20 messages fit the 1,400-token share.
    const plain = await build(components);
    expect(earlierKept(plain)).toBe(13);
    expect(promptTokens(plain)).toBeGreaterThan(2_000);

    // 2,000 tokens travel beside the prompt: the question and the system text leave under 1,000 of the other 2,000.
    const reserved = await build({ ...components, reservedTokens: 2_000 });
    expect(promptTokens(reserved) + 2_000, `the prompt, ${promptTokens(reserved)} tokens, and the 2,000 reserved`).toBeLessThanOrEqual(4_000);
    expect(earlierKept(reserved)).toBeGreaterThan(0);
    expect(earlierKept(reserved)).toBeLessThan(14);
    expect(reserved.modificationDetails?.historyOmitted?.messages).toBe(20 - earlierKept(reserved));
    // The newest earlier message is among those kept: the oldest go first.
    expect(JSON.stringify(reserved.prompt)).toContain('Earlier message 19');
    expect(codes(reserved)).not.toContain('TOKEN_BUDGET_EXCEEDED_POST_OPT');
  });

  it("the earlier history is held to its target as the budget counts it, each message's overhead included", async () => {
    // Twenty earlier messages of 20 characters: 5 tokens of text and 5 for the message each, 200 tokens in all. The
    // reservation leaves the earlier history 100 tokens beside the question and the system text.
    const short = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `Short note ${String(i).padStart(2, '0')}: abcde` }));
    expect(short.every((message) => message.content.length === 20)).toBe(true);
    const fixed = await engine.estimateFixedPromptTokens(base as never, MODEL, executionContext);
    // estimateFixedPromptTokens counts the note's frame line, which a prompt with no retrieved text does not send.
    const frame = await engine.estimateTokenCount(`${APPLICATION_NOTE_FRAME}\n`, MODEL.modelId);
    const reservedTokens = 4_000 - (fixed - frame) - 100;
    const built = await build({ ...base, conversationHistory: short, reservedTokens });
    const kept = short.filter((message) => JSON.stringify(built.prompt).includes(message.content)).length;
    expect(kept, 'the earlier messages kept, at 10 tokens each against a target of 100').toBe(10);
    expect(JSON.stringify(built.prompt)).toContain('Short note 19');
    expect(built.modificationDetails?.historyOmitted).toEqual({ messages: 10, tokens: 100 });
    expect(codes(built)).not.toContain('TOKEN_BUDGET_EXCEEDED_POST_OPT');
  });

  it('the other retrieved context is reduced for the reservation too, to what the fixed parts and the reservation leave of the context', async () => {
    const components = { ...base, retrievedContext: RETRIEVED };
    const plain = await build(components);
    expect(plain.wasTruncatedOrSummarized).toBe(false);
    expect(JSON.stringify(plain.prompt)).toContain(RETRIEVED);

    // 2,500 tokens travel beside the prompt: the question, the system text and the 800 tokens of context are over the
    // other 1,500. The context is cut to what is left after the fixed parts, among them the frame line of the note
    // the context is sent in, which `estimateFixedPromptTokens` counts.
    const fixed = await engine.estimateFixedPromptTokens(base as never, MODEL, executionContext);
    const reserved = await build({ ...components, reservedTokens: 2_500 });
    expect(reserved.modificationDetails?.truncatedComponents).toContain('retrievedContext');
    const counts = reserved.metadata.contextTokens as { otherBefore: number; otherAfter: number };
    expect(counts.otherBefore).toBe(800);
    expect(counts.otherAfter).toBe(4_000 - 2_500 - fixed);
    expect(counts.otherAfter).toBeGreaterThan(400);
    expect(promptTokens(reserved) + 2_500, `the prompt, ${promptTokens(reserved)} tokens, and the 2,500 reserved`).toBeLessThanOrEqual(4_000);
    expect(codes(reserved)).not.toContain('TOKEN_BUDGET_EXCEEDED_POST_OPT');
  });

  it('retrieved context under its share is still reduced by what the prompt is over, where giving that up makes the prompt fit', async () => {
    // 400 tokens of retrieved context, half its share, beside 2,800 reserved tokens: the question, the system text and
    // the context are about 230 tokens over the 1,200 left, less than the context holds.
    const retrieved = RETRIEVED.slice(0, 1_600);
    const components = { ...base, retrievedContext: retrieved };
    const plain = await build(components);
    expect(plain.wasTruncatedOrSummarized).toBe(false);

    const fixed = await engine.estimateFixedPromptTokens(base as never, MODEL, executionContext);
    const reserved = await build({ ...components, reservedTokens: 2_800 });
    const counts = reserved.metadata.contextTokens as { otherBefore: number; otherAfter: number };
    expect(counts.otherBefore).toBe(400);
    // The context keeps what the fixed parts and the reservation leave of the model's context.
    expect(counts.otherAfter).toBe(4_000 - 2_800 - fixed);
    expect(counts.otherAfter).toBeGreaterThan(100);
    expect(reserved.modificationDetails?.truncatedComponents).toContain('retrievedContext');
    expect(promptTokens(reserved) + 2_800, `the prompt, ${promptTokens(reserved)} tokens, and the 2,800 reserved`).toBeLessThanOrEqual(4_000);
    expect(codes(reserved)).not.toContain('TOKEN_BUDGET_EXCEEDED_POST_OPT');
  });

  it('a prompt over its budget by exactly what its retrieved context holds sends none of that context, and fits', async () => {
    const retrieved = RETRIEVED.slice(0, 1_600);
    const fixed = await engine.estimateFixedPromptTokens(base as never, MODEL, executionContext);
    // The reservation that leaves the fixed parts the whole of what is left: the 400 tokens of context are the overrun.
    const reserved = await build({ ...base, retrievedContext: retrieved, reservedTokens: 4_000 - fixed });
    expect(reserved.modificationDetails?.removedComponents).toContain('retrievedContext');
    expect((reserved.metadata.contextTokens as { otherAfter: number }).otherAfter).toBe(0);
    expect(codes(reserved)).not.toContain('TOKEN_BUDGET_EXCEEDED_POST_OPT');
  });

  it.each([
    { share: 'the whole of its share', characters: 3_200 },
    { share: 'half its share', characters: 1_600 },
  ])('retrieved context of $share that is removed takes its note with it: a prompt whose remaining text fits the context writes no over-budget warning', async ({ characters }) => {
    // A question of 3,985 tokens: with the system text, 3,990 of the 4,000, so no token of retrieved context fits
    // beside the frame line its note would open with. Without the context no note is sent, and the prompt fits.
    const question = 'Which crossing suits a morning ferry? '.repeat(420).slice(0, 15_940);
    const built = await build({ ...base, userInput: question, retrievedContext: RETRIEVED.slice(0, characters) });
    expect(built.modificationDetails?.removedComponents).toContain('retrievedContext');
    expect((built.metadata.contextTokens as { otherAfter: number }).otherAfter).toBe(0);
    expect(promptTokens(built)).toBe(3_990);
    expect(JSON.stringify(built.prompt)).not.toContain('Note from the application');
    expect(codes(built)).not.toContain('TOKEN_BUDGET_EXCEEDED_POST_OPT');
  });

  it('a prompt whose fixed parts are over the budget less the reservation goes out with the over-budget warning, which names the reservation', async () => {
    expect(codes(await build(base))).not.toContain('TOKEN_BUDGET_EXCEEDED_POST_OPT');
    // The 1,000-token question beside 3,500 reserved tokens: nothing is left to reduce.
    const over = await build({ ...base, conversationHistory: EARLIER, reservedTokens: 3_500 });
    expect(earlierKept(over)).toBe(0);
    const warning = (over.issues ?? []).find((issue) => issue.code === 'TOKEN_BUDGET_EXCEEDED_POST_OPT');
    expect(warning, 'the over-budget warning').toBeDefined();
    expect(warning!.message).toContain('3500');
    expect(JSON.stringify(over.prompt)).toContain(QUESTION);
  });

  it('estimateFixedPromptTokens counts the reservation: nothing reduces it', async () => {
    const count = (components: Record<string, unknown>) => engine.estimateFixedPromptTokens(components as never, MODEL, executionContext);
    const plain = await count(base);
    expect(await count({ ...base, reservedTokens: 500 })).toBe(plain + 500);
  });

  it.each([
    ['a negative number', -200],
    ['zero', 0],
    ['not a number', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['a string', '2000'],
  ])('a reservation that is %s reserves nothing', async (_name, value) => {
    const components = { ...base, conversationHistory: EARLIER, retrievedContext: RETRIEVED };
    const plain = await build(components);
    const reserved = await build({ ...components, reservedTokens: value });
    expect(JSON.stringify(reserved.prompt)).toBe(JSON.stringify(plain.prompt));
    expect(codes(reserved)).toEqual(codes(plain));
    const count = (c: Record<string, unknown>) => engine.estimateFixedPromptTokens(c as never, MODEL, executionContext);
    expect(await count({ ...components, reservedTokens: value })).toBe(await count(components));
  });
});
