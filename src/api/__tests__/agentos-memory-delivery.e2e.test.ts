/**
 * @file agentos-memory-delivery.e2e.test.ts
 * The memory block beside a host's long-term-memory text on the runtime path: `AgentOS.create()` with a memory
 * manager from `gmiManagerConfig.cognitiveMemoryFactory` (a real CognitiveMemoryManager over an InMemoryVectorStore
 * with a word-hash embedding), a host `longTermMemoryRetriever` whose text the turn pipeline hands the GMI, and
 * `processRequest()` turns of one user. Only the OpenAI provider class is stubbed (helpers/stubProviders.ts), with a
 * small context window, so the real runtime, turn pipeline, GMI, memory bridge and PromptEngine run, and what reached
 * the model is read from the request the stub received. The block's budget is what the model's retrieved-context
 * share leaves after the long-term-memory text; PromptEngine never reduces the block; and the final response's
 * `memoryRecall` names the clamp and what was delivered.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/llm/providers/implementations/OpenAIProvider')>()),
  OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai'),
}));
import { AgentOS } from '../AgentOS';
import { AgentOSResponseChunkType, type AgentOSResponse } from '../types/AgentOSResponse';
import { CognitiveMemoryManager } from '../../cognition/memory/CognitiveMemoryManager';
import type { CognitiveMemoryConfig } from '../../cognition/memory/core/config';
import type { MemoryRecallCapture } from '../../cognition/memory/retrieval/recall/capture';
import { InMemoryVectorStore } from '../../cognition/rag/vector_stores/InMemoryVectorStore';
import { InMemoryWorkingMemory } from '../../cognition/substrate/memory/InMemoryWorkingMemory';
import type { IPersonaDefinition } from '../../cognition/substrate/personas/IPersonaDefinition';
import type { ChatMessage } from '../../core/llm/providers/IProvider';
import type { ILongTermMemoryRetriever, LongTermMemoryRetrievalInput } from '../../core/conversation/ILongTermMemoryRetriever';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';
import { reply, script, type ProviderScript } from './helpers/stubProviders';

let n = 0;
const key = () => `k-memory-delivery-${++n}`;

const persona: IPersonaDefinition = {
  id: 'delivery-tutor', name: 'Delivery Tutor', description: 'Recalls what it was told.', version: '1.0.0', baseSystemPrompt: 'You are terse.',
  defaultProviderId: 'openai', defaultModelId: 'stub-model',
};
const NEUTRAL = { valence: 0, arousal: 0, dominance: 0 };
/** Starts every memory block (the assembler's preamble). */
const PREAMBLE_HEADING = '## How To Use Your Memories';

/** A 64-dimension embedding: each word adds 1 at the slot its hash names, then the vector is normalized. */
function wordHash(text: string): number[] {
  const vector = new Array<number>(64).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 0;
    for (let i = 0; i < word.length; i += 1) h = (h * 31 + word.charCodeAt(i)) >>> 0;
    vector[h % 64] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map((v) => v / norm);
}

const managers: CognitiveMemoryManager[] = [];
/** A memory manager whose capture rides the runtime stream, so the final response carries `memoryRecall`. */
async function memoryManager(): Promise<CognitiveMemoryManager> {
  const vectorStore = new InMemoryVectorStore();
  await vectorStore.initialize({ id: `delivery-${Math.random()}`, type: 'in_memory' } as never);
  const noop = async () => undefined;
  const manager = new CognitiveMemoryManager();
  await manager.initialize({
    agentId: 'delivery-tutor',
    traits: { openness: 0.5, conscientiousness: 0.5, extraversion: 0.5, agreeableness: 0.5, emotionality: 0.5, honesty: 0.5 },
    moodProvider: () => NEUTRAL,
    featureDetectionStrategy: 'keyword',
    workingMemory: new InMemoryWorkingMemory(),
    knowledgeGraph: { initialize: noop, recordMemory: async () => ({ id: 'm' }), deleteMemories: async () => 0, upsertEntity: async () => ({ id: 'e' }), upsertRelation: async () => ({ id: 'r' }), getRelations: async () => [], queryEntities: async () => [] },
    vectorStore,
    embeddingManager: {
      generateEmbeddings: async ({ texts }: { texts: string | string[] }) => ({ embeddings: (Array.isArray(texts) ? texts : [texts]).map(wordHash) }),
    },
    graph: { disabled: true },
    recall: { capture: 'metadata+stream' },
  } as unknown as CognitiveMemoryConfig);
  managers.push(manager);
  return manager;
}

/** A host retriever that returns `text` on every turn and counts its calls. */
function retrieverOf(text: string): ILongTermMemoryRetriever & { calls: LongTermMemoryRetrievalInput[] } {
  const calls: LongTermMemoryRetrievalInput[] = [];
  return { calls, retrieveLongTermMemory: async (input) => { calls.push(input); return { contextText: text }; } };
}

let booted: AgentOS | undefined;
afterEach(async () => {
  await booted?.shutdown().catch(() => undefined);
  booted = undefined;
  while (managers.length) await managers.pop()!.shutdown().catch(() => undefined);
  globalLLMProviderHealth.reset();
  vi.restoreAllMocks();
});

const STATEMENTS = Array.from(
  { length: 12 },
  (_, i) =>
    `Harbor ferry note ${i}: the island ferry leaves pier ${i + 3} at ${6 + i}:15 and the ticket desk for that pier opens forty minutes before, beside the blue kiosk with the tide table.`,
);

/** Boots the runtime on a model of `window` tokens with the retriever, its cadence one turn, so every turn reads it. */
async function boot(window: number, retriever: ILongTermMemoryRetriever): Promise<{ agentos: AgentOS; model: ProviderScript; manager: CognitiveMemoryManager }> {
  const manager = await memoryManager();
  const k = key();
  const model = script('openai', k, { window, replies: [] });
  booted = await AgentOS.create({
    modelProviderManagerConfig: { providers: [{ providerId: 'openai', enabled: true, isDefault: true, config: { apiKey: k } }] },
    turnPlanning: { enabled: false },
    personas: [persona],
    gmiManagerConfig: { cognitiveMemoryFactory: () => manager.forSession() },
    longTermMemoryRetriever: retriever,
    orchestratorConfig: { longTermMemoryRecall: { cadenceTurns: 1 } },
  } as never);
  return { agentos: booted, model, manager };
}

/** One served turn with the `user` long-term-memory scope on: its final response, after checking it carried no error. */
async function turn(agentos: AgentOS, model: ProviderScript, textInput: string, answer: string): Promise<Record<string, unknown>> {
  model.replies.push(reply.text(answer));
  const chunks: AgentOSResponse[] = [];
  for await (const chunk of agentos.processRequest({
    userId: 'user-1', sessionId: 's-delivery', selectedPersonaId: persona.id, textInput,
    memoryControl: { longTermMemory: { enabled: true, scopes: { user: true } } },
  } as never)) {
    chunks.push(chunk as AgentOSResponse);
  }
  const errors = chunks
    .filter((c) => c.type === AgentOSResponseChunkType.ERROR)
    .map((c) => (c as unknown as { code?: string; message?: string }))
    .map(({ code, message }) => ({ code, message }));
  expect(errors).toEqual([]);
  const final = chunks.find((c) => c.type === AgentOSResponseChunkType.FINAL_RESPONSE) as Record<string, unknown> | undefined;
  expect(final?.finalResponseText).toBe(answer);
  return final!;
}

function textOf(message: ChatMessage): string {
  const content = message.content as unknown;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
      .join('\n');
  }
  return '';
}

/** The text of the model's last request. */
const lastRequest = (model: ProviderScript) => model.seen.at(-1)!.messages.map(textOf).join('\n');

/** The texts of a message: its one string, or the text of each of its text parts. */
function textPartsOf(message: ChatMessage): string[] {
  const content = message.content as unknown;
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? [(part as { text: string }).text] : []));
}

/**
 * The memory block in the model's last request: from the preamble heading to where the other retrieved context
 * resumes, or to the end of the text part that carries the block when no other context follows it. The person's
 * words travel in a text part of their own, after that one, and are never part of the block.
 */
function blockIn(model: ProviderScript): string {
  const holder = model.seen.at(-1)!.messages.flatMap(textPartsOf).find((text) => text.includes(PREAMBLE_HEADING));
  if (!holder) return '';
  const start = holder.indexOf(PREAMBLE_HEADING);
  const end = holder.indexOf('\n\n---\n\n', start);
  return holder.slice(start, end === -1 ? undefined : end);
}

/** Tokens of a text by the assembler's estimate (about four characters a token). */
const tokensOf = (text: string) => Math.ceil(text.length / 4);

describe('the memory block beside a host long-term-memory retriever, through processRequest()', () => {
  it('long-term-memory text that fills most of the share shrinks the block to the remainder; both reach the model whole and the final response names the clamp', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // 8,000 tokens of context: the share is 1,600. About 1,000 tokens of long-term-memory text leave about 600 for
    // memory, under the block the twelve notes fill at 1,600.
    const longTerm = Array.from({ length: 45 }, (_, i) => `Profile line ${i}: the learner prefers morning crossings and window seats on the island ferry.`).join('\n');
    const otherTokens = tokensOf(longTerm);
    expect(otherTokens).toBeGreaterThan(950);
    expect(otherTokens).toBeLessThan(1_100);
    const retriever = retrieverOf(longTerm);
    const { agentos, model, manager } = await boot(8_000, retriever);
    for (const statement of STATEMENTS) await turn(agentos, model, statement, 'Noted.');
    const before = retriever.calls.length;
    const final = await turn(agentos, model, 'Which pier does the island harbor ferry leave from?', 'Pier 3.');
    expect(retriever.calls.length).toBe(before + 1);

    const record = final.memoryRecall as MemoryRecallCapture;
    expect(record?.version).toBe('memory-recall-capture/1');
    expect(record.budget).toMatchObject({ requested: 1600, clampReason: 'prompt_share', promptShareTokens: 1600, otherContextTokens: otherTokens, hop: 0, reassembled: true });
    expect(record.budget.effective).toBe(1600 - otherTokens);
    expect(record.tokensUsed).toBeLessThanOrEqual(record.budget.effective);
    expect(record.candidates.some((c) => c.outcome === 'left_out')).toBe(true);

    const request = lastRequest(model);
    // The long-term-memory text reached the model whole, after the block, and nothing was cut.
    expect(request).toContain(longTerm);
    expect(request.indexOf(PREAMBLE_HEADING)).toBeLessThan(request.indexOf('Profile line 0:'));
    expect(request).not.toContain('…[cut]');
    const block = blockIn(model);
    expect(block).toContain(PREAMBLE_HEADING);
    expect(tokensOf(block)).toBeLessThanOrEqual(record.budget.effective);
    const included = record.candidates.filter((c) => c.outcome === 'included');
    expect(included.length).toBeGreaterThan(0);
    for (const c of included) expect(block).toContain(manager.getStore().getTrace(c.id)!.content);

    // PromptEngine's own counts: the block it was handed (about the block's own size), and the other context whole.
    expect(record.delivery).toEqual({
      memoryBlockTokens: expect.any(Number),
      otherContext: { ragTokens: 0, longTermMemoryTokens: otherTokens, deliveredTokens: otherTokens },
    });
    expect(record.delivery!.memoryBlockTokens).toBeGreaterThan(0);
    expect(record.delivery!.memoryBlockTokens).toBeLessThanOrEqual(record.budget.effective);
  });

  it('a prompt over its budget keeps the block whole and reduces only the long-term-memory text, and the final response names the cut', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // 4,000 tokens of context: the share is 800. About 280 tokens of long-term-memory text leave about 520 for memory.
    // The question is about 3,500 tokens, which PromptEngine never reduces, so the prompt is over its budget: the
    // earlier turns and the long-term-memory text are reduced, and every memory line the block shows reaches the model whole.
    const longTerm = Array.from({ length: 20 }, (_, i) => `Profile line ${i}: the learner prefers morning crossings.`).join('\n');
    const otherTokens = tokensOf(longTerm);
    const filler = Array.from({ length: 140 }, (_, i) => `Background paragraph ${i}: the island ferry leaves its pier and the ticket desk opens before each crossing.`).join(' ');
    const question = `Which pier does the island harbor ferry leave from? ${filler}`;
    expect(tokensOf(question)).toBeGreaterThan(3_400);
    const { agentos, model, manager } = await boot(4_000, retrieverOf(longTerm));
    for (const statement of STATEMENTS) await turn(agentos, model, statement, 'Noted.');
    const final = await turn(agentos, model, question, 'Pier 3.');

    const record = final.memoryRecall as MemoryRecallCapture;
    expect(record.budget).toMatchObject({ requested: 1600, effective: 800 - otherTokens, clampReason: 'prompt_share', promptShareTokens: 800, otherContextTokens: otherTokens, hop: 0, reassembled: true });
    expect(record.delivery!.memoryBlockTokens).toBeGreaterThan(0);
    expect(record.delivery!.memoryBlockTokens).toBeLessThanOrEqual(record.budget.effective);
    expect(record.delivery?.otherContext).toMatchObject({ ragTokens: 0, longTermMemoryTokens: otherTokens, cutBy: 'prompt_engine_truncate' });
    expect(record.delivery!.otherContext!.deliveredTokens).toBeLessThan(otherTokens);

    const request = lastRequest(model);
    expect(request).toContain(question);
    expect(request).not.toContain('Profile line 19');
    expect(request).not.toContain('…[cut]');
    const block = blockIn(model);
    expect(tokensOf(block)).toBeLessThanOrEqual(record.budget.effective);
    const included = record.candidates.filter((c) => c.outcome === 'included');
    expect(included.length).toBeGreaterThan(0);
    for (const c of included) expect(block).toContain(manager.getStore().getTrace(c.id)!.content);
  });
});
