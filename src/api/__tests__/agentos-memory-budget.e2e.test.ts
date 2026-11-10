/**
 * @file agentos-memory-budget.e2e.test.ts
 * The recall budget on a host's memory manager: AgentOS.create() with a manager
 * from `gmiManagerConfig.cognitiveMemoryFactory` (a real CognitiveMemoryManager
 * over an InMemoryVectorStore with a word-hash embedding) whose config sets
 * `recall.budget.totalTokens`, with `recall.capture: 'metadata+stream'` so the
 * final response carries the record. Two turns of one user, the second
 * recalling what the first said; the memory block is read from the messages the
 * stubbed OpenAI provider received. A manager given a
 * recall setting of the wrong kind refuses it at initialize, writes one
 * `memory.recall.option_rejected` line and builds nothing, so the same manager
 * initializes with a valid setting afterwards.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';

const requests = vi.hoisted(() => ({ messages: [] as unknown[][] }));
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', () => {
  const base = { id: 'stub', object: 'chat.completion.chunk', created: 0 };
  class OpenAIProvider {
    readonly providerId = 'openai';
    isInitialized = false;
    async initialize() { this.isInitialized = true; }
    async generateCompletion() {
      return { choices: [{ message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }], responseText: 'ok' };
    }
    async *generateCompletionStream(modelId: string, messages: unknown[]) {
      requests.messages.push(JSON.parse(JSON.stringify(messages ?? [])));
      yield { ...base, modelId, choices: [], responseTextDelta: 'Noted.' };
      yield { ...base, modelId, isFinal: true, choices: [{ index: 0, message: { role: 'assistant', content: 'Noted.' }, finishReason: 'stop' }] };
      yield { ...base, modelId, isFinal: true, choices: [], usage: { promptTokens: 12, completionTokens: 2, totalTokens: 14 } };
    }
    async generateEmbeddings() { return { embeddings: [] }; }
    async listAvailableModels() { return []; }
    async getModelInfo() { return undefined; }
    async checkHealth() { return { isHealthy: true }; }
    async shutdown() {}
  }
  return { OpenAIProvider };
});

import { AgentOS } from '../AgentOS';
import { AgentOSResponseChunkType, type AgentOSResponse } from '../types/AgentOSResponse';
import { CognitiveMemoryManager } from '../../cognition/memory/CognitiveMemoryManager';
import type { CognitiveMemoryConfig, ManagerRecallConfig } from '../../cognition/memory/core/config';
import { RecallOptionError } from '../../cognition/memory/retrieval/recall/budget';
import { InMemoryVectorStore } from '../../cognition/rag/vector_stores/InMemoryVectorStore';
import { InMemoryWorkingMemory } from '../../cognition/substrate/memory/InMemoryWorkingMemory';
import type { IPersonaDefinition } from '../../cognition/substrate/personas/IPersonaDefinition';
import { resetLoggerFactory, setLogger } from '../../core/logging/loggerFactory';

const persona: IPersonaDefinition = {
  id: 'budget-tutor', name: 'Budget Tutor', description: 'Recalls what it was told.', version: '1.0.0', baseSystemPrompt: 'You are terse.',
  defaultProviderId: 'openai', defaultModelId: 'gpt-4o-mini',
};
const NEUTRAL = { valence: 0, arousal: 0, dominance: 0 };
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

const logged: Record<string, unknown>[] = [];
const events = (name: string) => logged.filter((line) => line.event === name);

/** A manager config over an in-memory store, with the given recall setting. */
async function managerConfig(recall?: unknown): Promise<CognitiveMemoryConfig> {
  const vectorStore = new InMemoryVectorStore();
  await vectorStore.initialize({ id: `budget-${Math.random()}`, type: 'in_memory' } as never);
  const noop = async () => undefined;
  return {
    agentId: 'budget-tutor',
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
    ...(recall !== undefined ? { recall } : {}),
  } as unknown as CognitiveMemoryConfig;
}

const managers: CognitiveMemoryManager[] = [];
let booted: AgentOS | undefined;

beforeEach(() => {
  requests.messages.length = 0;
  logged.length = 0;
  setLogger(pino({ level: 'debug', base: undefined }, { write(line: string) { logged.push(JSON.parse(line)); } }));
});
afterEach(async () => {
  await (booted as unknown as { shutdown?: () => Promise<void> } | undefined)?.shutdown?.()?.catch(() => undefined);
  booted = undefined;
  while (managers.length) await managers.pop()!.shutdown().catch(() => undefined);
  resetLoggerFactory();
  vi.restoreAllMocks();
});

async function boot(recall: ManagerRecallConfig): Promise<AgentOS> {
  const manager = new CognitiveMemoryManager();
  await manager.initialize(await managerConfig(recall));
  managers.push(manager);
  booted = await AgentOS.create({
    modelProviderManagerConfig: { providers: [{ providerId: 'openai', enabled: true, isDefault: true, config: { apiKey: 'test' } }] },
    turnPlanning: { enabled: false },
    personas: [persona],
    gmiManagerConfig: { cognitiveMemoryFactory: () => manager.forSession() },
  } as any);
  return booted;
}

/** One served turn's chunks, after checking it ended with the stub's reply and no error. */
async function turn(agentos: AgentOS, sessionId: string, textInput: string): Promise<AgentOSResponse[]> {
  const chunks: AgentOSResponse[] = [];
  for await (const chunk of agentos.processRequest({ userId: 'user-1', sessionId, selectedPersonaId: persona.id, textInput } as any)) {
    chunks.push(chunk as AgentOSResponse);
  }
  const errors = chunks
    .filter((c) => c.type === AgentOSResponseChunkType.ERROR)
    .map((c) => (c as unknown as { code?: string; message?: string }))
    .map(({ code, message }) => ({ code, message }));
  expect(errors).toEqual([]);
  expect(finalOf(chunks)?.finalResponseText).toBe('Noted.');
  return chunks;
}
const finalOf = (chunks: AgentOSResponse[]) => chunks.find((c) => c.type === AgentOSResponseChunkType.FINAL_RESPONSE) as Record<string, unknown> | undefined;

/** The texts of the last request the provider received. */
function lastRequestTexts(): string[] {
  const last = requests.messages.at(-1) ?? [];
  return last.map((m) => {
    const content = (m as { content?: unknown }).content;
    return typeof content === 'string' ? content : JSON.stringify(content ?? '');
  });
}

const SAID = 'The camping stove waits in parcel locker 14 and its code is 5832.';
const ASKED = 'Which parcel locker holds the camping stove?';

type RecallRecord = { budget: { requested: number }; tokensUsed: number; candidates: Array<{ outcome: string; reason?: string }> };

describe("a host manager's recall.budget.totalTokens", () => {
  it('unset, the block is assembled in 1600 tokens and reaches the model', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const agentos = await boot({ capture: 'metadata+stream' });
    await turn(agentos, 's-default', SAID);
    const chunks = await turn(agentos, 's-default', ASKED);
    const record = finalOf(chunks)!.memoryRecall as RecallRecord | undefined;
    expect(record?.budget.requested).toBe(1600);
    expect(record?.candidates.some((c) => c.outcome === 'included')).toBe(true);
    expect(lastRequestTexts().some((text) => text.includes(PREAMBLE_HEADING))).toBe(true);
  });

  it('set to 0, no block reaches the model, every candidate is left out for the budget, and the turn is served', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const agentos = await boot({ budget: { totalTokens: 0 }, capture: 'metadata+stream' });
    await turn(agentos, 's-zero', SAID);
    const chunks = await turn(agentos, 's-zero', ASKED);
    const record = finalOf(chunks)!.memoryRecall as RecallRecord | undefined;
    expect(record?.budget.requested).toBe(0);
    expect(record?.candidates.length).toBeGreaterThan(0);
    for (const c of record!.candidates) expect(c).toMatchObject({ outcome: 'left_out', reason: 'budget' });
    expect(lastRequestTexts().some((text) => text.includes(PREAMBLE_HEADING))).toBe(false);
  });
});

describe('a host manager given a recall setting of the wrong kind', () => {
  it.each([
    [{ budget: { totalTokens: -5 } }, 'budget.totalTokens'],
    [{ budget: { totalTokens: 1.5 } }, 'budget.totalTokens'],
    [{ capture: 'all' }, 'capture'],
    [{ budget: 1600 }, 'budget'],
  ])('refuses %j at initialize, writes one option_rejected line and builds nothing', async (recall, option) => {
    const manager = new CognitiveMemoryManager();
    const error = await manager.initialize(await managerConfig(recall)).then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(RecallOptionError);
    expect(error).toMatchObject({ option, reason: 'invalid_value' });
    expect((error as Error).message).toContain('CognitiveMemoryManager');
    expect(events('memory.recall.option_rejected')).toEqual([expect.objectContaining({ option, reason: 'invalid_value' })]);
    // Nothing was built: the same manager initializes with a valid setting.
    await manager.initialize(await managerConfig({ budget: { totalTokens: 800 } }));
    managers.push(manager);
    expect(manager.getConfig().recall).toEqual({ budget: { totalTokens: 800 } });
  });
});
