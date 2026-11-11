/**
 * @file agentos-memory-capture.e2e.test.ts
 * The recall capture on the runtime stream: AgentOS.create() with a memory
 * manager from `gmiManagerConfig.cognitiveMemoryFactory` (a real
 * CognitiveMemoryManager over an InMemoryVectorStore with a word-hash
 * embedding), two turns of one user, the second recalling what the first said.
 * With the manager's default capture the stream carries no `memorySources`
 * update and the final response no `memoryRecall`, and the GMI's reasoning-trace
 * entry "Cognitive memory context assembled." holds counts and no ids. With
 * `recall.capture: 'metadata+stream'` the stream carries one `METADATA_UPDATE`
 * with `memorySources` (the assembly's record) and the final response its
 * `memoryRecall` (the same record with the serving hop's budget and delivery); with
 * `recall.traceIds` the entry lists the ids. Only the OpenAI provider class is
 * stubbed; every turn is served (no error chunk, the stub's reply as the final
 * text), so the first turn's words are filed before the second recalls them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/llm/providers/implementations/OpenAIProvider', () => {
  // The providers' streamed shapes, as helpers/stubProviders.ts writes them.
  const base = { id: 'stub', object: 'chat.completion.chunk', created: 0 };
  class OpenAIProvider {
    readonly providerId = 'openai';
    isInitialized = false;
    async initialize() { this.isInitialized = true; }
    async generateCompletion() {
      return { choices: [{ message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }], responseText: 'ok' };
    }
    async *generateCompletionStream(modelId: string) {
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
import { InMemoryVectorStore } from '../../cognition/rag/vector_stores/InMemoryVectorStore';
import { InMemoryWorkingMemory } from '../../cognition/substrate/memory/InMemoryWorkingMemory';
import type { IPersonaDefinition } from '../../cognition/substrate/personas/IPersonaDefinition';

const persona: IPersonaDefinition = {
  id: 'capture-tutor', name: 'Capture Tutor', description: 'Recalls what it was told.', version: '1.0.0', baseSystemPrompt: 'You are terse.',
  // A turn with no model to call errors after its memory assembly and files nothing.
  defaultProviderId: 'openai', defaultModelId: 'gpt-4o-mini',
};
const NEUTRAL = { valence: 0, arousal: 0, dominance: 0 };
const ENTRY = 'Cognitive memory context assembled.';

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
async function memoryManager(recall?: ManagerRecallConfig): Promise<CognitiveMemoryManager> {
  const vectorStore = new InMemoryVectorStore();
  await vectorStore.initialize({ id: `capture-${Math.random()}`, type: 'in_memory' } as never);
  const noop = async () => undefined;
  const manager = new CognitiveMemoryManager();
  await manager.initialize({
    agentId: 'capture-tutor',
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
    ...(recall ? { recall } : {}),
  } as unknown as CognitiveMemoryConfig);
  managers.push(manager);
  return manager;
}

let booted: AgentOS | undefined;
afterEach(async () => {
  await (booted as unknown as { shutdown?: () => Promise<void> } | undefined)?.shutdown?.()?.catch(() => undefined);
  booted = undefined;
  while (managers.length) await managers.pop()!.shutdown().catch(() => undefined);
  vi.restoreAllMocks();
});

// No storageAdapter: the runtime boots on the package's Prisma stub with in-memory conversations.
async function boot(recall?: ManagerRecallConfig): Promise<AgentOS> {
  const manager = await memoryManager(recall);
  booted = await AgentOS.create({
    modelProviderManagerConfig: { providers: [{ providerId: 'openai', enabled: true, isDefault: true, config: { apiKey: 'test' } }] },
    turnPlanning: { enabled: false },
    personas: [persona],
    gmiManagerConfig: { cognitiveMemoryFactory: () => manager.forSession() },
  } as any);
  return booted;
}

/** One served turn: its chunks, after checking it ended with the stub's reply and no error. */
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

const memorySourceUpdates = (chunks: AgentOSResponse[]) =>
  chunks.filter((c) => c.type === AgentOSResponseChunkType.METADATA_UPDATE && (c as { updates?: Record<string, unknown> }).updates?.memorySources !== undefined);
const finalOf = (chunks: AgentOSResponse[]) => chunks.find((c) => c.type === AgentOSResponseChunkType.FINAL_RESPONSE) as Record<string, unknown> | undefined;

async function entriesOf(agentos: AgentOS, sessionId: string) {
  const { gmi } = await agentos.getGMIManager().getOrCreateGMIForSession('user-1', sessionId, persona.id);
  return gmi.getReasoningTrace().entries.filter((entry) => entry.message === ENTRY);
}

const SAID = 'The camping stove waits in parcel locker 14 and its code is 5832.';
const ASKED = 'Which parcel locker holds the camping stove?';

describe('the recall capture on the runtime stream', () => {
  it("with the manager's default capture the stream carries no memorySources and the final response no memoryRecall; the trace entry holds counts and no ids", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const agentos = await boot();
    await turn(agentos, 's-default', SAID);
    const chunks = await turn(agentos, 's-default', ASKED);
    expect(finalOf(chunks)).toBeDefined();
    expect(memorySourceUpdates(chunks)).toEqual([]);
    expect(finalOf(chunks)!.memoryRecall).toBeUndefined();

    const entries = await entriesOf(agentos, 's-default');
    expect(entries.length).toBeGreaterThan(0);
    const details = entries.at(-1)!.details as Record<string, unknown>;
    expect(Object.keys(details).sort()).toEqual(['candidates', 'included', 'leftOut', 'legsAbsent', 'reranker', 'retrieval', 'tokensUsed']);
    expect(details).toMatchObject({ retrieval: 'dense', reranker: 'none', legsAbsent: [] });
    expect(details.candidates as number).toBeGreaterThan(0);
    expect((details.included as number) + (details.leftOut as number)).toBe(details.candidates);
    expect(JSON.stringify(details)).not.toContain('5832');
  });

  it("with recall.capture 'metadata+stream' the stream carries one memorySources update per turn and the final response its memoryRecall; recall.traceIds lists the ids in the trace entry", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const agentos = await boot({ capture: 'metadata+stream', traceIds: true });
    await turn(agentos, 's-stream', SAID);
    const chunks = await turn(agentos, 's-stream', ASKED);

    const updates = memorySourceUpdates(chunks);
    expect(updates).toHaveLength(1);
    const streamed = (updates[0] as unknown as { updates: { memorySources: Record<string, any> } }).updates.memorySources;
    expect(streamed.version).toBe('memory-recall-capture/1');
    expect(streamed.candidates.length).toBeGreaterThan(0);
    // The update arrives before the reply's text.
    const firstText = chunks.findIndex((c) => c.type === AgentOSResponseChunkType.TEXT_DELTA);
    expect(chunks.indexOf(updates[0])).toBeLessThan(firstText === -1 ? chunks.length : firstText);

    const final = finalOf(chunks)!;
    expect((final.memoryRecall as Record<string, unknown> | undefined)?.version).toBe('memory-recall-capture/1');
    // The update carries the assembly's record; the final response the record of the model hop that served the turn:
    // the same candidates, with the hop's budget and what reached its model.
    expect(streamed.budget).toEqual({ requested: 1600, effective: 1600 });
    expect(streamed.delivery).toBeUndefined();
    expect(final.memoryRecall).toEqual({
      ...streamed,
      budget: { requested: 1600, effective: 1600, promptShareTokens: expect.any(Number), otherContextTokens: 0, hop: 0 },
      delivery: { memoryBlockTokens: expect.any(Number) },
    });
    expect((final.memoryRecall as { delivery: { memoryBlockTokens: number } }).delivery.memoryBlockTokens).toBeGreaterThan(0);
    const json = JSON.stringify(streamed);
    expect(json).not.toContain('5832');
    expect(json).not.toContain('Which parcel locker');

    const entries = await entriesOf(agentos, 's-stream');
    const details = entries.at(-1)!.details as Record<string, unknown>;
    const includedIds = (streamed.candidates as Array<{ id: string; outcome: string }>).filter((c) => c.outcome === 'included').map((c) => c.id);
    expect([...(details.includedMemoryIds as string[])].sort()).toEqual(includedIds.sort());
  });
});
