/**
 * @file GMI.memory-budget.test.ts
 * The memory block on a model whose context is small, through the real GMI, PromptEngine and memory bridge over a
 * CognitiveMemoryManager built by `createAgentCognitiveMemory` (in-memory stores, a deterministic word-hash
 * embedding): the block's budget is clamped to what the model's retrieved-context share leaves after the turn's
 * long-term-memory text, and to what the prompt's fixed parts leave of the model's context, the block is re-rendered
 * at that remainder, PromptEngine never reduces the block, and the turn's recall record names the clamp and what
 * reached the model.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAgentCognitiveMemory, type AgentCognitiveMemory } from '../../../api/runtime/agentCognitiveMemory';
import type { AIModelProviderManager } from '../../../core/llm/providers/AIModelProviderManager';
import type { ChatMessage, IProvider } from '../../../core/llm/providers/IProvider';
import type { MemoryRecallCapture } from '../../memory/retrieval/recall/capture';
import { PromptEngine } from '../../../core/llm/PromptEngine';
import type { IPromptEngine, ModelTargetInfo, PromptComponents, PromptExecutionContext } from '../../../core/llm/IPromptEngine';
import type { IToolOrchestrator, ToolDefinitionForLLM } from '../../../core/tools/IToolOrchestrator';
import { createCompletionGateway, toolFormatFor, type CompletionGateway, type CompletionOutcome, type CompletionResolution } from '../../../api/runtime/completionGateway';
import { responseFormatCarriesSchema } from '../../../api/runtime/responseFormatForProvider';
import { AnthropicProvider } from '../../../core/llm/providers/implementations/AnthropicProvider';
import { GeminiProvider } from '../../../core/llm/providers/implementations/GeminiProvider';
import { createScriptedGmi, promptEngineConfig, runTurn, scriptedProvider, textReply, textTurn } from './helpers/scriptedGmi';

const DIM = 64;

/** A deterministic bag-of-words vector: texts that share words point the same way. */
function hashEmbed(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    let h = 0;
    for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % DIM] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

function makeEmbedder() {
  return {
    initialize: async () => undefined,
    generateEmbeddings: async (req: { texts: string | string[] }) => {
      const texts = Array.isArray(req.texts) ? req.texts : [req.texts];
      return { embeddings: texts.map(hashEmbed), modelId: 'test-embed', providerId: 'test', usage: { totalTokens: 0 } };
    },
    getEmbeddingModelInfo: async () => ({ modelId: 'test-embed', providerId: 'test', dimension: DIM }),
    getEmbeddingDimension: async () => DIM,
    checkHealth: async () => ({ isHealthy: true }),
    shutdown: async () => undefined,
  };
}

const neutral = { valence: 0, arousal: 0, dominance: 0 };
const FERRY = Array.from(
  { length: 10 },
  (_, i) => `Island ferry note ${i}: the island ferry leaves pier ${i + 3} at ${6 + i}:15, and the ticket desk beside that pier opens forty minutes before each crossing.`,
);

/** A memory holding the ferry notes, its block set to 1,600 tokens with the retrieval and rerank it runs beside. */
async function ferryMemory(): Promise<AgentCognitiveMemory> {
  const persona = {
    id: 'memo', name: 'Memo', description: 'd', version: '1.0.0', baseSystemPrompt: 'x',
    personalityTraits: { conscientiousness: 0.9, openness: 0.2, emotionality: 0.2 },
  } as never;
  const mem = await createAgentCognitiveMemory({
    persona,
    memory: { recall: { retrieval: 'dense', rerank: 'none', budget: { totalTokens: 1600 } } },
    embeddingManager: makeEmbedder() as never,
  });
  for (const note of FERRY) await mem.manager.encode(note, neutral, 'neutral', { type: 'episodic' });
  return mem;
}

/** A provider manager without a gateway whose every model has a context of `window` tokens. */
function smallWindowManager(provider: IProvider, window: number): AIModelProviderManager {
  return {
    getModelInfo: vi.fn(async (modelId: string) => ({ modelId, providerId: provider.providerId, contextWindowSize: window, capabilities: ['chat'] })),
    getProvider: vi.fn(() => provider),
    getProviderForModel: vi.fn(() => provider),
  } as unknown as AIModelProviderManager;
}

/** Tokens of a text by the assembler's estimate (about four characters a token). */
const tokensOf = (text: string) => Math.ceil(text.length / 4);

/** A tool whose schema is about 7,400 tokens of JSON. */
const TIMETABLE_TOOL: ToolDefinitionForLLM = {
  name: 'timetable',
  description: Array.from({ length: 315 }, (_, i) => `Timetable row ${String(i).padStart(3, '0')}: looks up when the island ferry leaves one pier on one crossing of the day.`).join(' '),
  inputSchema: { type: 'object', properties: { pier: { type: 'string' } } },
};

/**
 * A host's own completion gateway: one hop on a model of `window` tokens that answers every request with `answer`
 * and records the options each request was sent with. `toolsSentWithSchema`, when given, is the gateway's own answer
 * to whether a request with a response schema keeps its tools; a gateway written before the member has none. The hop
 * reports `providerId`, which says nothing of how the gateway writes the request it sends.
 */
function hostGateway(window: number, answer: string, toolsSentWithSchema?: () => boolean, providerId = 'openai') {
  const sent: Array<Record<string, unknown>> = [];
  const resolution: CompletionResolution = {
    providerId, modelId: 'host-model', hop: 0, maxContextTokens: window,
    capabilities: ['chat', 'tool_use'], toolFormat: toolFormatFor(providerId), optionOverrides: {},
    providerManager: {
      getProvider: () => ({ providerId, isInitialized: true }),
      getModelInfo: async () => ({ modelId: 'host-model', providerId, contextWindowSize: window, capabilities: ['chat', 'tool_use'] }),
    } as never,
    chain: [{ provider: providerId, model: 'host-model' }],
  };
  const gateway = {
    resolve: async (_route: unknown, after?: CompletionResolution) => (after ? null : resolution),
    stream: (_resolution: CompletionResolution, _messages: unknown, options: Record<string, unknown>) => {
      sent.push(options);
      return Object.assign((async function* () { yield* textReply(answer); })(), { outcome: Promise.resolve<CompletionOutcome>({ kind: 'delivered' }) });
    },
    ...(toolsSentWithSchema ? { toolsSentWithSchema } : {}),
  } as unknown as CompletionGateway;
  return { gateway, sent };
}

let mem: AgentCognitiveMemory | undefined;
afterEach(async () => {
  await mem?.close();
  mem = undefined;
  vi.restoreAllMocks();
});

describe('GMI memory block on a small model', () => {
  it('long-term-memory text that fills most of the share shrinks the memory block to the remainder, and the capture says why', async () => {
    mem = await ferryMemory();
    // 8,000 tokens of context: the share is 1,600. The long-term-memory text is about 1,400 tokens, so about 200 remain for memory.
    const longTerm = Array.from({ length: 60 }, (_, i) => `Profile line ${i}: the learner prefers morning crossings and window seats on the island ferry.`).join('\n');
    const otherTokens = tokensOf(longTerm);
    expect(otherTokens).toBeGreaterThan(1300);
    expect(otherTokens).toBeLessThan(1500);
    const { provider, received } = scriptedProvider([textReply('Pier 3.')]);
    const { gmi } = await createScriptedGmi({ provider, config: { cognitiveMemory: mem.manager.forSession(), llmProviderManager: smallWindowManager(provider, 8_000) } });
    const { output } = await runTurn(gmi, textTurn('t1', 'Which pier does the island ferry leave from?', { longTermMemoryContext: longTerm }));
    const capture = output.memoryRecall as MemoryRecallCapture;
    expect(capture).toBeDefined();
    expect(capture.budget).toMatchObject({ requested: 1600, clampReason: 'prompt_share', promptShareTokens: 1600, otherContextTokens: otherTokens, hop: 0, reassembled: true });
    expect(capture.budget.effective).toBe(1600 - otherTokens);
    expect(capture.tokensUsed).toBeLessThanOrEqual(capture.budget.effective);
    const prompt = JSON.stringify(received[0]);
    // The other context reached the model whole.
    expect(prompt).toContain('Profile line 59');
    expect(prompt).not.toContain('…[cut]');
    expect(capture.delivery).toMatchObject({ memoryBlockTokens: expect.any(Number), otherContext: { ragTokens: 0, longTermMemoryTokens: otherTokens, deliveredTokens: expect.any(Number) } });
    expect(capture.delivery!.otherContext!.cutBy).toBeUndefined();
    // Every memory the record says the block shows reached the model.
    for (const c of capture.candidates.filter((candidate) => candidate.outcome === 'included')) {
      expect(prompt).toContain(mem.manager.getStore().getTrace(c.id)!.content);
    }
  });

  it('a prompt over its budget keeps the memory block whole and reduces only the other context, named in the capture', async () => {
    mem = await ferryMemory();
    // 8,000 tokens of context: the share is 1,600. About 1,120 tokens of long-term-memory text leave about 480 for
    // memory. The question itself is about 6,800 tokens, which PromptEngine never reduces: it leaves the block more of
    // the context than the share does, so the share sizes the block, and with the block and the long-term-memory text
    // the prompt is over its budget. The long-term-memory text is reduced; every included memory line still reaches
    // the model whole.
    const longTerm = Array.from({ length: 80 }, (_, i) => `Profile line ${i}: the learner prefers morning crossings.`).join('\n');
    const otherTokens = tokensOf(longTerm);
    expect(otherTokens).toBeGreaterThan(1_080);
    expect(otherTokens).toBeLessThan(1_160);
    const filler = Array.from({ length: 255 }, (_, i) => `Background paragraph ${i}: the island ferry leaves its pier and the ticket desk opens before each crossing.`).join(' ');
    const question = `Which pier does the island ferry leave from? ${filler}`;
    expect(tokensOf(question)).toBeGreaterThan(6_750);
    expect(tokensOf(question)).toBeLessThan(6_850);
    const { provider, received } = scriptedProvider([textReply('Pier 3.')]);
    const { gmi } = await createScriptedGmi({ provider, config: { cognitiveMemory: mem.manager.forSession(), llmProviderManager: smallWindowManager(provider, 8_000) } });
    const { output } = await runTurn(gmi, textTurn('t1', question, { longTermMemoryContext: longTerm }));
    const capture = output.memoryRecall as MemoryRecallCapture;
    expect(capture.budget).toMatchObject({ requested: 1600, effective: 1600 - otherTokens, clampReason: 'prompt_share', hop: 0, reassembled: true });
    // What the fixed parts leave of the context is more than the share's remainder, so it is not the bound here.
    expect(8_000 - capture.budget.fixedPromptTokens!).toBeGreaterThanOrEqual(1600 - otherTokens);
    expect(capture.delivery!.otherContext!.cutBy).toBe('prompt_engine_truncate');
    expect(capture.delivery!.otherContext!.longTermMemoryTokens).toBe(otherTokens);
    expect(capture.delivery!.otherContext!.deliveredTokens).toBeLessThan(otherTokens);
    const prompt = JSON.stringify(received[0]);
    expect(prompt).not.toContain('Profile line 79');
    const included = capture.candidates.filter((candidate) => candidate.outcome === 'included');
    expect(included.length).toBeGreaterThan(0);
    for (const c of included) expect(prompt).toContain(mem.manager.getStore().getTrace(c.id)!.content);
    expect(prompt).not.toContain('…[cut]');
  });

  it("a turn whose fixed parts leave less of the model's context than the share does shrinks the memory block to what they leave, and the capture says why", async () => {
    mem = await ferryMemory();
    // 8,000 tokens of context: the share is 1,600, the whole configured budget, and the turn has no other context. The
    // question is about 7,400 tokens, which PromptEngine never reduces, so beside it, the system prompt, the note's
    // frame line and the tool schema, about 500 tokens of the context are left: the block is rendered again at that.
    const filler = Array.from({ length: 278 }, (_, i) => `Background paragraph ${i}: the island ferry leaves its pier and the ticket desk opens before each crossing.`).join(' ');
    const question = `Which pier does the island ferry leave from? ${filler}`;
    expect(tokensOf(question)).toBeGreaterThan(7_400);
    expect(tokensOf(question)).toBeLessThan(7_440);
    const { provider, received } = scriptedProvider([textReply('Pier 3.')]);
    const { gmi } = await createScriptedGmi({ provider, config: { cognitiveMemory: mem.manager.forSession(), llmProviderManager: smallWindowManager(provider, 8_000) } });
    const { output } = await runTurn(gmi, textTurn('t1', question));
    const capture = output.memoryRecall as MemoryRecallCapture;
    expect(capture).toBeDefined();
    expect(capture.budget).toMatchObject({ requested: 1600, clampReason: 'fixed_prompt', promptShareTokens: 1600, otherContextTokens: 0, hop: 0, reassembled: true });
    const fixed = capture.budget.fixedPromptTokens!;
    expect(fixed).toBeGreaterThan(tokensOf(question));
    expect(fixed).toBeLessThan(tokensOf(question) + 200);
    expect(capture.budget.effective).toBe(8_000 - fixed);
    expect(capture.budget.effective).toBeGreaterThan(300);
    expect(capture.tokensUsed).toBeLessThanOrEqual(capture.budget.effective);
    // PromptEngine's count of the prompt is within the model's budget: the record carries no over-budget warning.
    expect(capture.delivery).toEqual({ memoryBlockTokens: expect.any(Number) });
    expect(capture.delivery!.memoryBlockTokens).toBeLessThanOrEqual(capture.budget.effective);
    const prompt = JSON.stringify(received[0]);
    const included = capture.candidates.filter((candidate) => candidate.outcome === 'included');
    expect(included.length).toBeGreaterThan(0);
    for (const c of included) expect(prompt).toContain(mem.manager.getStore().getTrace(c.id)!.content);
    expect(prompt).not.toContain('…[cut]');
  });

  it("on a model id PromptEngine counts with fewer characters a token than the assembler, the block PromptEngine counts still fits what the fixed parts leave", async () => {
    mem = await ferryMemory();
    // gpt-4o-mini: PromptEngine counts 3.8 characters a token and the assembler 4, so a block of 1,000 of the
    // assembler's tokens (4,000 characters) reads 1,053 by PromptEngine's count. On 8,000 tokens of context a question
    // of about 7,400 of PromptEngine's tokens leaves about 500, and the block's budget is what holds 500 by that count.
    const engineTokensOf = (text: string) => Math.ceil(text.length / 3.8);
    const filler = Array.from({ length: 264 }, (_, i) => `Background paragraph ${i}: the island ferry leaves its pier and the ticket desk opens before each crossing.`).join(' ');
    const question = `Which pier does the island ferry leave from? ${filler}`;
    expect(engineTokensOf(question)).toBeGreaterThan(7_400);
    expect(engineTokensOf(question)).toBeLessThan(7_440);
    const { provider } = scriptedProvider([textReply('Pier 3.')]);
    const { gmi } = await createScriptedGmi({
      provider,
      persona: { defaultModelId: 'gpt-4o-mini' },
      config: { cognitiveMemory: mem.manager.forSession(), llmProviderManager: smallWindowManager(provider, 8_000) },
    });
    const { output } = await runTurn(gmi, textTurn('t1', question));
    const capture = output.memoryRecall as MemoryRecallCapture;
    expect(capture).toBeDefined();
    expect(capture.budget).toMatchObject({ requested: 1600, clampReason: 'fixed_prompt', promptShareTokens: 1600, otherContextTokens: 0, hop: 0, reassembled: true });
    const left = 8_000 - capture.budget.fixedPromptTokens!;
    expect(left).toBeGreaterThan(300);
    expect(left).toBeLessThan(700);
    expect(capture.budget.blockTokenRate).toBe(1.053);
    expect(capture.budget.effective).toBe(Math.floor(left / 1.053));
    expect(capture.tokensUsed).toBeLessThanOrEqual(capture.budget.effective);
    // PromptEngine's own count of the block is within what the fixed parts left, and of the prompt within its budget.
    expect(capture.delivery).toEqual({ memoryBlockTokens: expect.any(Number) });
    expect(capture.delivery!.memoryBlockTokens).toBeGreaterThan(0);
    expect(capture.delivery!.memoryBlockTokens).toBeLessThanOrEqual(left);
  });

  it('a re-render that fails sends the model no block, and the record says the render failed, not that the budget left the memories out', async () => {
    mem = await ferryMemory();
    // The first test's 8,000-token model and long-term-memory text: the block must be rendered again at about 200.
    const longTerm = Array.from({ length: 60 }, (_, i) => `Profile line ${i}: the learner prefers morning crossings and window seats on the island ferry.`).join('\n');
    const { provider, received } = scriptedProvider([textReply('Pier 3.')]);
    const { gmi } = await createScriptedGmi({ provider, config: { cognitiveMemory: mem.manager.forSession(), llmProviderManager: smallWindowManager(provider, 8_000) } });
    vi.spyOn(mem.manager as unknown as { reassembleForBudget: (...args: unknown[]) => Promise<unknown> }, 'reassembleForBudget').mockRejectedValue(new Error('assembler failed'));
    const { output } = await runTurn(gmi, textTurn('t1', 'Which pier does the island ferry leave from?', { longTermMemoryContext: longTerm }));
    const capture = output.memoryRecall as MemoryRecallCapture;
    expect(capture.budget).toMatchObject({ requested: 1600, clampReason: 'prompt_share', hop: 0, renderFailed: true });
    expect(capture.budget.reassembled).toBeUndefined();
    expect(capture.tokensUsed).toBe(0);
    expect(capture.candidates.filter((candidate) => candidate.outcome === 'included')).toEqual([]);
    expect(capture.candidates.some((candidate) => candidate.reason === 'render_failed')).toBe(true);
    expect(JSON.stringify(received[0])).not.toContain('How To Use Your Memories');
  });

  it("a host's own prompt engine that reads only retrievedContext still sends the block: the GMI joins it in front of the other context", async () => {
    mem = await ferryMemory();
    const real = new PromptEngine();
    await real.initialize(promptEngineConfig());
    const seen: PromptComponents[] = [];
    // An engine written before memoryContextText existed: it builds its prompt from the fields it knows.
    const legacy = {
      initialize: async () => undefined,
      estimateTokenCount: (content: string, modelId?: string) => real.estimateTokenCount(content, modelId),
      constructPrompt: async (components: PromptComponents, model: ModelTargetInfo, context: PromptExecutionContext) => {
        seen.push(components);
        const { memoryContextText: _unread, ...known } = components;
        return real.constructPrompt(known, model, context);
      },
    } as unknown as IPromptEngine;
    const { provider, received } = scriptedProvider([textReply('Pier 3.')]);
    const { gmi } = await createScriptedGmi({ provider, config: { promptEngine: legacy, cognitiveMemory: mem.manager.forSession(), llmProviderManager: smallWindowManager(provider, 128_000) } });
    await runTurn(gmi, textTurn('t1', 'Which pier does the island ferry leave from?', { longTermMemoryContext: 'Profile: the learner prefers window seats.' }));
    expect(seen).toHaveLength(1);
    expect(seen[0].memoryContextText).toBeUndefined();
    const retrieved = seen[0].retrievedContext as string;
    // The block first, then the long-term-memory text, joined as the GMI joined them before the field existed.
    expect(retrieved.indexOf('How To Use Your Memories')).toBeGreaterThanOrEqual(0);
    expect(retrieved.endsWith('\n\n---\n\nProfile: the learner prefers window seats.')).toBe(true);
    expect(JSON.stringify(received[0])).toContain('How To Use Your Memories');
  });

  it("a host's beforeModelCall that replaces the prompt is named in the record's delivery, whose counts are of the prompt PromptEngine built", async () => {
    mem = await ferryMemory();
    const { provider, received } = scriptedProvider([textReply('Pier 3.'), textReply('Pier 3.')]);
    const replace = vi.fn(async ({ messages }: { messages: Array<{ role: string; content: unknown }> }) =>
      messages.map((m) => (m.role === 'user' ? { ...m, content: 'Which pier does the island ferry leave from?' } : m)));
    const { gmi } = await createScriptedGmi({ provider, config: { beforeModelCall: replace, cognitiveMemory: mem.manager.forSession(), llmProviderManager: smallWindowManager(provider, 128_000) } as never });
    const { output } = await runTurn(gmi, textTurn('t1', 'Which pier does the island ferry leave from?'));
    expect(replace).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(received[0])).not.toContain('How To Use Your Memories');
    const capture = output.memoryRecall as MemoryRecallCapture;
    expect(capture.delivery).toEqual({ memoryBlockTokens: expect.any(Number), promptReplacedByHook: true });

    // A hook that returns nothing leaves the built prompt, and the record says nothing of a hook.
    const { gmi: plain } = await createScriptedGmi({ provider, config: { beforeModelCall: async () => undefined, cognitiveMemory: mem.manager.forSession(), llmProviderManager: smallWindowManager(provider, 128_000) } as never });
    const second = await runTurn(plain, textTurn('t2', 'Which pier does the island ferry leave from?'));
    expect((second.output.memoryRecall as MemoryRecallCapture).delivery).toEqual({ memoryBlockTokens: expect.any(Number) });
  });

  it('a model whose share holds the block takes the turn\'s first rendering: no re-render, the record names the hop', async () => {
    mem = await ferryMemory();
    const { provider, received } = scriptedProvider([textReply('Pier 3.')]);
    const { gmi } = await createScriptedGmi({ provider, config: { cognitiveMemory: mem.manager.forSession(), llmProviderManager: smallWindowManager(provider, 128_000) } });
    const reassemble = vi.spyOn(mem.manager as unknown as { reassembleForBudget: (...args: unknown[]) => unknown }, 'reassembleForBudget');
    const { output } = await runTurn(gmi, textTurn('t1', 'Which pier does the island ferry leave from?'));
    const capture = output.memoryRecall as MemoryRecallCapture;
    expect(reassemble).not.toHaveBeenCalled();
    // The record carries the count of the prompt's fixed parts: the system prompt, the question, the note's frame line
    // and the tool schema, a few dozen tokens here.
    // No rate: PromptEngine counts this model id's tokens as the assembler does.
    expect(capture.budget).toEqual({ requested: 1600, effective: 1600, promptShareTokens: 25_600, otherContextTokens: 0, fixedPromptTokens: expect.any(Number), hop: 0 });
    expect(capture.budget.fixedPromptTokens).toBeGreaterThan(0);
    expect(capture.budget.fixedPromptTokens).toBeLessThan(200);
    expect(capture.delivery).toEqual({ memoryBlockTokens: expect.any(Number) });
    expect(JSON.stringify(received[0])).toContain('How To Use Your Memories');
  });
});

describe('GMI memory block on a response-schema turn of a persona with tools', () => {
  it("a turn's passthrough parameters ride the request whole: tools a host passes there are counted and reserved, on a request the gateway sends without the turn's own tools", async () => {
    mem = await ferryMemory();
    // The gateway sends a response-schema request without the persona's tools, so they are not counted. The host
    // passes the same tool through customModelParams, which a provider writes into its request as given.
    const { gateway, sent } = hostGateway(8_000, '{"pier":"Pier 3"}', () => false);
    const toolOrchestrator = { orchestratorId: 'timetable-tools', listAvailableTools: vi.fn(async () => [TIMETABLE_TOOL]), processToolCall: vi.fn() } as unknown as IToolOrchestrator;
    const { gmi, promptEngine } = await createScriptedGmi({ gateway, config: { cognitiveMemory: mem.manager.forSession(), toolOrchestrator } });
    const construct = vi.spyOn(promptEngine, 'constructPrompt');
    const customModelParams = { tools: [{ type: 'function', function: { name: TIMETABLE_TOOL.name, description: TIMETABLE_TOOL.description, parameters: TIMETABLE_TOOL.inputSchema } }] };
    const { output } = await runTurn(gmi, textTurn('t1', 'Which pier does the island ferry leave from?', { options: { responseSchema: z.object({ pier: z.string() }), schemaName: 'answer', customModelParams } } as never));
    expect(sent).toHaveLength(1);
    expect(sent[0].customModelParams).toEqual(customModelParams);
    const passthroughTokens = tokensOf(JSON.stringify(customModelParams));
    expect(passthroughTokens).toBeGreaterThan(7_300);
    const built = construct.mock.calls[0][0] as PromptComponents & { reservedTokens?: number };
    expect(built.reservedTokens).toBe(passthroughTokens);
    const capture = output.memoryRecall as MemoryRecallCapture;
    expect(capture.budget).toMatchObject({ requested: 1600, clampReason: 'fixed_prompt', promptShareTokens: 1600, otherContextTokens: 0, hop: 0 });
    expect(capture.budget.fixedPromptTokens).toBeGreaterThanOrEqual(passthroughTokens);
    expect(capture.budget.effective).toBe(8_000 - capture.budget.fixedPromptTokens!);
  });

  it.each([
    { says: 'has no toolsSentWithSchema', toolsSentWithSchema: undefined, counted: true },
    { says: 'says a response-schema request keeps its tools', toolsSentWithSchema: () => true, counted: true },
    { says: 'says a response-schema request is sent without tools', toolsSentWithSchema: () => false, counted: false },
  ])("a gateway that $says: the tool schemas are counted among the request's fixed parts only where the request carries them", async ({ toolsSentWithSchema, counted }) => {
    mem = await ferryMemory();
    // 8,000 tokens of context and no other retrieved context: the share is 1,600, the whole configured budget. The
    // tool's schema is about 7,400 tokens, so where it is counted, the fixed parts leave the block about 500.
    const { gateway, sent } = hostGateway(8_000, '{"pier":"Pier 3"}', toolsSentWithSchema);
    const toolOrchestrator = { orchestratorId: 'timetable-tools', listAvailableTools: vi.fn(async () => [TIMETABLE_TOOL]), processToolCall: vi.fn() } as unknown as IToolOrchestrator;
    const { gmi, promptEngine } = await createScriptedGmi({ gateway, config: { cognitiveMemory: mem.manager.forSession(), toolOrchestrator } });
    const construct = vi.spyOn(promptEngine, 'constructPrompt');
    const schema = z.object({ pier: z.string() });
    const { output } = await runTurn(gmi, textTurn('t1', 'Which pier does the island ferry leave from?', { options: { responseSchema: schema, schemaName: 'answer' } } as never));
    expect(sent).toHaveLength(1);
    // The GMI hands the gateway the turn's tools either way: the gateway decides what its request carries.
    const toolTokens = tokensOf(JSON.stringify(sent[0].tools));
    expect(toolTokens).toBeGreaterThan(7_300);
    expect(toolTokens).toBeLessThan(7_600);
    const capture = output.memoryRecall as MemoryRecallCapture;
    expect(capture).toBeDefined();
    const built = construct.mock.calls[0][0] as PromptComponents & { reservedTokens?: number };
    if (counted) {
      expect(capture.budget).toMatchObject({ requested: 1600, clampReason: 'fixed_prompt', promptShareTokens: 1600, otherContextTokens: 0, hop: 0 });
      expect(capture.budget.fixedPromptTokens).toBeGreaterThanOrEqual(toolTokens);
      expect(capture.budget.effective).toBe(8_000 - capture.budget.fixedPromptTokens!);
      // The prompt is built with the same tokens taken off its budget.
      expect(built.reservedTokens).toBe(toolTokens);
    } else {
      expect(capture.budget.fixedPromptTokens, "the fixed parts, with the tool schemas' " + toolTokens + ' tokens left out').toBeLessThan(200);
      expect(capture.budget).toEqual({ requested: 1600, effective: 1600, promptShareTokens: 1600, otherContextTokens: 0, fixedPromptTokens: expect.any(Number), hop: 0 });
      expect(built.reservedTokens).toBeUndefined();
    }
  });
});

describe('GMI memory block beside the response format and passthrough parameters a turn forwards', () => {
  it('a forwarded responseFormat that carries a JSON schema, on a turn with no response schema, is counted and reserved as the request sends it', async () => {
    mem = await ferryMemory();
    // 8,000 tokens of context and no other retrieved context: the share is 1,600. The format's schema is about 7,400
    // tokens, which the request carries beside the prompt, so the fixed parts leave the block about 500.
    const { gateway, sent } = hostGateway(8_000, '{"pier":"Pier 3"}');
    const { gmi, promptEngine } = await createScriptedGmi({ gateway, config: { cognitiveMemory: mem.manager.forSession() } });
    const construct = vi.spyOn(promptEngine, 'constructPrompt');
    const responseFormat = {
      type: 'json_schema',
      json_schema: { name: 'answer', schema: { type: 'object', description: TIMETABLE_TOOL.description, properties: { pier: { type: 'string' } } } },
    };
    const { output } = await runTurn(gmi, textTurn('t1', 'Which pier does the island ferry leave from?', { options: { responseFormat } } as never));
    expect(sent).toHaveLength(1);
    expect(sent[0].responseFormat).toEqual(responseFormat);
    const formatTokens = tokensOf(JSON.stringify(responseFormat));
    expect(formatTokens).toBeGreaterThan(7_300);
    // Counted beside the tool schemas the turn offers, as the request carries both.
    const toolTokens = Array.isArray(sent[0].tools) && sent[0].tools.length > 0 ? tokensOf(JSON.stringify(sent[0].tools)) : 0;
    const built = construct.mock.calls[0][0] as PromptComponents & { reservedTokens?: number };
    expect(built.reservedTokens).toBe(toolTokens + formatTokens);
    const capture = output.memoryRecall as MemoryRecallCapture;
    expect(capture.budget).toMatchObject({ requested: 1600, clampReason: 'fixed_prompt', promptShareTokens: 1600, otherContextTokens: 0, hop: 0 });
    expect(capture.budget.fixedPromptTokens).toBeGreaterThanOrEqual(formatTokens);
    expect(capture.budget.effective).toBe(8_000 - capture.budget.fixedPromptTokens!);
  });

  it("passthrough tools and response_format replace the turn's own tools and responseFormat on the wire of a built-in provider, so they are counted in their place, once", async () => {
    mem = await ferryMemory();
    const { gateway, sent } = servingGateway('openai', 'host-model', 8_000, 'Pier 3.');
    const toolOrchestrator = { orchestratorId: 'timetable-tools', listAvailableTools: vi.fn(async () => [TIMETABLE_TOOL]), processToolCall: vi.fn() } as unknown as IToolOrchestrator;
    const { gmi, promptEngine } = await createScriptedGmi({ gateway, config: { cognitiveMemory: mem.manager.forSession(), toolOrchestrator } });
    const construct = vi.spyOn(promptEngine, 'constructPrompt');
    const responseFormat = { type: 'json_object' };
    const customModelParams = {
      tools: [{ type: 'function', function: { name: TIMETABLE_TOOL.name, description: TIMETABLE_TOOL.description, parameters: TIMETABLE_TOOL.inputSchema } }],
      response_format: { type: 'json_object' },
    };
    await runTurn(gmi, textTurn('t1', 'Which pier does the island ferry leave from?', { options: { responseFormat, customModelParams } } as never));
    expect(sent).toHaveLength(1);
    // The GMI hands the gateway the turn's own tools and format; OpenAI's provider writes the passthrough parameters last.
    expect(tokensOf(JSON.stringify(sent[0].options.tools))).toBeGreaterThan(7_300);
    expect(sent[0].options.responseFormat).toEqual(responseFormat);
    expect(sent[0].options.customModelParams).toEqual(customModelParams);
    const built = construct.mock.calls[0][0] as PromptComponents & { reservedTokens?: number };
    // Counted once: the turn's tools and format are not sent beside the passthrough parameters that replace them.
    expect(built.reservedTokens).toBe(tokensOf(JSON.stringify(customModelParams)));
  });

  it("on a host's own gateway, which may send the passthrough parameters beside the turn's tools and format, all three are counted", async () => {
    mem = await ferryMemory();
    const { gateway, sent } = hostGateway(8_000, 'Pier 3.');
    const toolOrchestrator = { orchestratorId: 'timetable-tools', listAvailableTools: vi.fn(async () => [TIMETABLE_TOOL]), processToolCall: vi.fn() } as unknown as IToolOrchestrator;
    const { gmi, promptEngine } = await createScriptedGmi({ gateway, config: { cognitiveMemory: mem.manager.forSession(), toolOrchestrator } });
    const construct = vi.spyOn(promptEngine, 'constructPrompt');
    const responseFormat = { type: 'json_object' };
    const customModelParams = {
      tools: [{ type: 'function', function: { name: TIMETABLE_TOOL.name, description: TIMETABLE_TOOL.description, parameters: TIMETABLE_TOOL.inputSchema } }],
      response_format: { type: 'json_object' },
    };
    await runTurn(gmi, textTurn('t1', 'Which pier does the island ferry leave from?', { options: { responseFormat, customModelParams } } as never));
    expect(sent).toHaveLength(1);
    const toolTokens = tokensOf(JSON.stringify(sent[0].tools));
    expect(toolTokens).toBeGreaterThan(7_300);
    const built = construct.mock.calls[0][0] as PromptComponents & { reservedTokens?: number };
    // The gateway's serializer is unknown: the passthrough parameters may ride beside what they would replace.
    expect(built.reservedTokens, 'the reservation beside the turn tools, its format and the passthrough parameters').toBe(
      toolTokens + tokensOf(JSON.stringify(responseFormat)) + tokensOf(JSON.stringify(customModelParams)),
    );
  });
});

/**
 * A completion gateway with one hop on `providerId`'s model `modelId`, whose schema answers are the default gateway's
 * (`createCompletionGateway`): it lowers a turn's response schema for that hop, and sends a response-schema request
 * the lowered payload and no tools, as the default gateway's `stream()` does, to the hop's own provider, which writes
 * the request (`requestWrittenByProvider`). It answers every request with `answer`
 * and records the messages and the options of each request as the hop's provider is given them.
 */
function servingGateway(providerId: string, modelId: string, window: number, answer: string) {
  const real = createCompletionGateway();
  const sent: Array<{ messages: ChatMessage[]; options: Record<string, unknown> }> = [];
  const resolution: CompletionResolution = {
    providerId, modelId, hop: 0, maxContextTokens: window,
    capabilities: ['chat', 'tool_use'], toolFormat: toolFormatFor(providerId), optionOverrides: {},
    providerManager: {
      getProvider: () => ({ providerId, isInitialized: true }),
      getModelInfo: async () => ({ modelId, providerId, contextWindowSize: window, capabilities: ['chat', 'tool_use'] }),
    } as never,
    chain: [{ provider: providerId, model: modelId }],
  };
  const gateway = {
    resolve: async (_route: unknown, after?: CompletionResolution) => (after ? null : resolution),
    stream: (hop: CompletionResolution, messages: ChatMessage[], options: Record<string, unknown>, responseSchema?: z.ZodType, schemaName = 'response') => {
      const payload = responseSchema ? real.schemaPayload!(hop, responseSchema, schemaName) : undefined;
      sent.push({ messages, options: { ...options, ...(responseSchema ? { responseFormat: payload, tools: undefined, toolChoice: undefined } : {}) } });
      return Object.assign((async function* () { yield* textReply(answer); })(), { outcome: Promise.resolve<CompletionOutcome>({ kind: 'delivered' }) });
    },
    schemaInstruction: real.schemaInstruction,
    schemaPayload: real.schemaPayload,
    toolsSentWithSchema: real.toolsSentWithSchema,
    requestWrittenByProvider: real.requestWrittenByProvider,
  } as unknown as CompletionGateway;
  return { gateway, sent, resolution, real };
}

/** The request body the hop's provider writes for a recorded request: GeminiProvider's or AnthropicProvider's own. */
async function wireRequestOf(providerId: 'gemini' | 'anthropic', modelId: string, request: { messages: ChatMessage[]; options: Record<string, unknown> }): Promise<Record<string, unknown>> {
  type Builds = { buildRequestPayload: (modelId: string, messages: ChatMessage[], options: unknown, stream?: boolean) => Record<string, unknown> };
  if (providerId === 'gemini') {
    const provider = new GeminiProvider();
    await provider.initialize({ apiKey: 'test-gemini-key' });
    return (provider as unknown as Builds).buildRequestPayload(modelId, request.messages, request.options);
  }
  const provider = new AnthropicProvider();
  await provider.initialize({ apiKey: 'test-anthropic-key' });
  return (provider as unknown as Builds).buildRequestPayload(modelId, request.messages, request.options, true);
}

/** A response schema of 200 named fields: a payload of thousands of tokens on every provider that takes it. */
function longAnswerSchema() {
  const shape: Record<string, z.ZodString> = { pier: z.string() };
  for (let i = 0; i < 200; i += 1) shape[`harbor_log_entry_for_crossing_${i}`] = z.string();
  return z.object(shape);
}

describe('GMI request beside passthrough parameters on a hop whose provider strips them', () => {
  it.each([
    {
      providerId: 'gemini' as const, modelId: 'gemini-3.5-flash',
      schemaOnWire: (wire: Record<string, unknown>) => (wire.generationConfig as { responseSchema?: unknown } | undefined)?.responseSchema,
    },
    {
      providerId: 'anthropic' as const, modelId: 'claude-sonnet-4-6',
      schemaOnWire: (wire: Record<string, unknown>) => (wire.output_config as { format?: unknown } | undefined)?.format ?? wire.tools,
    },
  ])("on a $providerId hop a passthrough response_format is not sent, so the response schema's payload the request carries is counted", async ({ providerId, modelId, schemaOnWire }) => {
    const { gateway, sent, resolution, real } = servingGateway(providerId, modelId, 32_000, '{"pier":"Pier 3"}');
    const { gmi, promptEngine } = await createScriptedGmi({ gateway });
    const construct = vi.spyOn(promptEngine, 'constructPrompt');
    const schema = longAnswerSchema();
    // Written for an OpenAI primary: OpenAI-compatible providers write it into the request in place of the payload.
    const customModelParams = { response_format: { type: 'json_object' } };
    await runTurn(gmi, textTurn('t1', 'Which pier does the island ferry leave from?', { options: { responseSchema: schema, schemaName: 'answer', customModelParams } } as never));
    expect(sent).toHaveLength(1);
    const payload = real.schemaPayload!(resolution, schema, 'answer');
    expect(responseFormatCarriesSchema(payload), "the hop's request carries the schema as a parameter").toBe(true);

    // The request as the hop's provider serializes it: the schema is sent, the passthrough response_format is not.
    const wire = await wireRequestOf(providerId, modelId, sent[0]);
    expect(wire.response_format, 'a response_format on the wire').toBeUndefined();
    const onWire = schemaOnWire(wire);
    expect(onWire, 'the schema on the wire').toBeDefined();
    const wireTokens = await promptEngine.estimateTokenCount(JSON.stringify(onWire), modelId);
    expect(wireTokens, 'the schema on the wire').toBeGreaterThan(3_000);

    const built = construct.mock.calls[0][0] as PromptComponents & { reservedTokens?: number };
    expect(built.reservedTokens ?? 0, `the reservation, beside a schema of ${wireTokens} tokens on the wire`).toBeGreaterThanOrEqual(wireTokens);
    // The payload as the GMI counts it, and nothing for a passthrough the provider leaves out.
    expect(built.reservedTokens).toBe(await promptEngine.estimateTokenCount(JSON.stringify(payload), modelId));
  });

  it.each([
    { providerId: 'openai', modelId: 'host-model', counted: false },
    { providerId: 'gemini', modelId: 'gemini-3.5-flash', counted: true },
  ])("a passthrough generationConfig is counted on a $providerId hop only where that provider sends it", async ({ providerId, modelId, counted }) => {
    const { gateway, sent } = servingGateway(providerId, modelId, 32_000, 'Pier 3.');
    const { gmi, promptEngine } = await createScriptedGmi({ gateway });
    const construct = vi.spyOn(promptEngine, 'constructPrompt');
    // Written for a Gemini primary; OpenAI's request leaves Gemini's fields out.
    const customModelParams = { generationConfig: { responseMimeType: 'application/json', responseSchema: { type: 'object', description: TIMETABLE_TOOL.description } } };
    await runTurn(gmi, textTurn('t1', 'Which pier does the island ferry leave from?', { options: { customModelParams } } as never));
    expect(sent).toHaveLength(1);
    expect(sent[0].options.customModelParams).toEqual(customModelParams);
    const passthroughTokens = await promptEngine.estimateTokenCount(JSON.stringify(customModelParams), modelId);
    expect(passthroughTokens).toBeGreaterThan(7_300);
    const tools = sent[0].options.tools;
    const toolTokens = Array.isArray(tools) && tools.length > 0 ? await promptEngine.estimateTokenCount(JSON.stringify(tools), modelId) : 0;
    const built = construct.mock.calls[0][0] as PromptComponents & { reservedTokens?: number };
    expect(built.reservedTokens ?? 0, `the reservation beside ${passthroughTokens} tokens of passthrough parameters`).toBe(toolTokens + (counted ? passthroughTokens : 0));
  });
  it.each(['groq', 'mistral', 'together', 'xai', 'litellm'])(
    'on a %s hop, which sends through the OpenAI request builder, the passthrough parameters it keeps are counted',
    async (providerId) => {
      const { gateway, sent } = servingGateway(providerId, 'host-model', 32_000, 'Pier 3.');
      const { gmi, promptEngine } = await createScriptedGmi({ gateway });
      const construct = vi.spyOn(promptEngine, 'constructPrompt');
      // A field OpenAI's request keeps, written over the request's top-level fields.
      const customModelParams = { metadata: { crossing_notes: TIMETABLE_TOOL.description } };
      await runTurn(gmi, textTurn('t1', 'Which pier does the island ferry leave from?', { options: { customModelParams } } as never));
      expect(sent).toHaveLength(1);
      const passthroughTokens = await promptEngine.estimateTokenCount(JSON.stringify(customModelParams), 'host-model');
      expect(passthroughTokens).toBeGreaterThan(7_300);
      const tools = sent[0].options.tools;
      const toolTokens = Array.isArray(tools) && tools.length > 0 ? await promptEngine.estimateTokenCount(JSON.stringify(tools), 'host-model') : 0;
      const built = construct.mock.calls[0][0] as PromptComponents & { reservedTokens?: number };
      expect(built.reservedTokens ?? 0, `the reservation beside ${passthroughTokens} tokens of passthrough parameters`).toBe(toolTokens + passthroughTokens);
    },
  );
});

describe('GMI request beside a response format a host gateway forwards on a response-schema turn', () => {
  it.each([
    { says: 'has no responseFormatReplacedWithSchema', replaced: undefined, counted: true },
    { says: 'says the request is sent the forwarded format', replaced: () => false, counted: true },
    { says: "says the schema's payload replaces the forwarded format", replaced: () => true, counted: false },
  ])('a gateway that $says: the forwarded responseFormat is counted only where the request carries it', async ({ replaced, counted }) => {
    // A host gateway that passes the turn's options through to its provider and reads the response schema only to
    // check the answer.
    const { gateway, sent } = hostGateway(32_000, '{"pier":"Pier 3"}');
    if (replaced) Object.assign(gateway, { responseFormatReplacedWithSchema: replaced });
    const { gmi, promptEngine } = await createScriptedGmi({ gateway });
    const construct = vi.spyOn(promptEngine, 'constructPrompt');
    const responseFormat = {
      type: 'json_schema',
      json_schema: { name: 'answer', strict: true, schema: { type: 'object', description: TIMETABLE_TOOL.description, properties: { pier: { type: 'string' } }, required: ['pier'], additionalProperties: false } },
    };
    await runTurn(gmi, textTurn('t1', 'Which pier does the island ferry leave from?', { options: { responseSchema: z.object({ pier: z.string() }), schemaName: 'answer', responseFormat } } as never));
    expect(sent).toHaveLength(1);
    expect(sent[0].responseFormat).toEqual(responseFormat);
    const formatTokens = tokensOf(JSON.stringify(responseFormat));
    expect(formatTokens).toBeGreaterThan(7_300);
    // The gateway has no toolsSentWithSchema, so the turn's tools are counted beside the format.
    const toolTokens = Array.isArray(sent[0].tools) && sent[0].tools.length > 0 ? tokensOf(JSON.stringify(sent[0].tools)) : 0;
    const built = construct.mock.calls[0][0] as PromptComponents & { reservedTokens?: number };
    expect(built.reservedTokens ?? 0, `the reservation, beside a forwarded format of ${formatTokens} tokens`).toBe(toolTokens + (counted ? formatTokens : 0));
  });
});

describe("GMI request beside passthrough parameters on a host's own gateway, whose serializer is unknown", () => {
  it.each([
    { providerId: 'gemini', key: 'response_format' },
    { providerId: 'anthropic', key: 'response_format' },
    { providerId: 'openai', key: 'generationConfig' },
  ])("a host gateway whose hop reports $providerId counts a passthrough $key whole, where that provider's own request would leave it out", async ({ providerId, key }) => {
    // A host gateway that posts the options to an OpenAI-compatible endpoint, the passthrough parameters at the
    // request's root, whatever provider its hop names: the provider's own strip of them says nothing of its request.
    const { gateway, sent } = hostGateway(8_000, 'Pier 3.', undefined, providerId);
    const { gmi, promptEngine } = await createScriptedGmi({ gateway });
    const construct = vi.spyOn(promptEngine, 'constructPrompt');
    const schema = { type: 'object', description: TIMETABLE_TOOL.description, properties: { pier: { type: 'string' } } };
    const customModelParams = key === 'response_format'
      ? { response_format: { type: 'json_schema', json_schema: { name: 'answer', schema } } }
      : { generationConfig: { responseMimeType: 'application/json', responseSchema: schema } };
    await runTurn(gmi, textTurn('t1', 'Which pier does the island ferry leave from?', { options: { customModelParams } } as never));
    expect(sent).toHaveLength(1);
    expect(sent[0].customModelParams).toEqual(customModelParams);
    const passthroughTokens = await promptEngine.estimateTokenCount(JSON.stringify(customModelParams), 'host-model');
    expect(passthroughTokens).toBeGreaterThan(7_300);
    const toolTokens = Array.isArray(sent[0].tools) && sent[0].tools.length > 0 ? await promptEngine.estimateTokenCount(JSON.stringify(sent[0].tools), 'host-model') : 0;
    const built = construct.mock.calls[0][0] as PromptComponents & { reservedTokens?: number };
    expect(built.reservedTokens ?? 0, `the reservation beside ${passthroughTokens} tokens of passthrough parameters`).toBe(toolTokens + passthroughTokens);
  });
});
