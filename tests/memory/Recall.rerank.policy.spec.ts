/**
 * @fileoverview Memory recall reranks only with the provider `recall.rerank` names: a `rerankerService` passed on the
 * manager's config is never called for memory (one `memory.recall.option_ignored` line per manager built, and
 * `getRerankerService()` returns it), a `recall.rerank` that names a remote provider is refused when the manager
 * initialises, and no environment variable turns memory rerank on.
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import pino from 'pino';
import { resetLoggerFactory, setLogger } from '../../src/core/logging/loggerFactory';
import { CognitiveMemoryManager } from '../../src/cognition/memory/CognitiveMemoryManager';
import type { CognitiveMemoryConfig, PADState } from '../../src/cognition/memory/core/config';
import { KnowledgeGraph } from '../../src/cognition/memory/retrieval/graph/knowledge/KnowledgeGraph';
import { resetRecallLogOnce } from '../../src/cognition/memory/retrieval/recall/log';
import { RerankerService } from '../../src/cognition/rag/reranking/RerankerService';
import { InMemoryVectorStore } from '../../src/cognition/rag/vector_stores/InMemoryVectorStore';
import { InMemoryWorkingMemory } from '../../src/cognition/substrate/memory/InMemoryWorkingMemory';
import { U1, WordHashEmbedder, trace } from './helpers/recallFixtures';

const NEUTRAL: PADState = { valence: 0, arousal: 0, dominance: 0 };
const logged: Array<Record<string, unknown>> = [];
const events = (name: string) => logged.filter((line) => line.event === name);

/** A manager over an in-memory store and the word-hash embedder, with `extra` merged into its config. */
async function managerWith(extra: Partial<CognitiveMemoryConfig> = {}): Promise<CognitiveMemoryManager> {
  const vectorStore = new InMemoryVectorStore();
  await vectorStore.initialize({ id: `policy-${Math.random().toString(36).slice(2)}`, type: 'in_memory', defaultEmbeddingDimension: 32, similarityMetric: 'cosine' } as never);
  const knowledgeGraph = new KnowledgeGraph();
  await knowledgeGraph.initialize();
  const workingMemory = new InMemoryWorkingMemory();
  await workingMemory.initialize('policy');
  const manager = new CognitiveMemoryManager();
  await manager.initialize({
    workingMemory,
    knowledgeGraph,
    vectorStore,
    embeddingManager: new WordHashEmbedder() as never,
    agentId: 'policy-agent',
    traits: {},
    moodProvider: () => NEUTRAL,
    featureDetectionStrategy: 'keyword',
    graph: { backend: 'knowledge-graph' },
    consolidation: { enabled: false },
    ...extra,
  } as CognitiveMemoryConfig);
  await manager.getStore().store(trace('a', 'The ferry leaves from pier 3.'));
  return manager;
}

beforeEach(() => {
  logged.length = 0;
  resetRecallLogOnce();
  setLogger(pino({ level: 'debug', base: undefined }, { write(line: string) { logged.push(JSON.parse(line)); } }));
});
afterEach(() => {
  resetLoggerFactory();
  resetRecallLogOnce();
  vi.unstubAllEnvs();
});

it('a rerankerService passed on the manager config is not called for memory recall, says so once, and is still returned', async () => {
  const called = vi.fn(async (input: { documents: Array<{ id: string; content: string }> }) => ({
    results: input.documents.map((d) => ({ id: d.id, content: d.content, relevanceScore: 1 })),
  }));
  const service = new RerankerService({ config: { providers: [{ providerId: 'cohere', apiKey: 'test-key' }], defaultProviderId: 'cohere' } });
  service.registerProvider({ providerId: 'cohere', isAvailable: async () => true, rerank: called } as never);
  for (const retrieval of ['dense', 'hybrid'] as const) {
    const manager = await managerWith({ rerankerService: service, recall: { retrieval } });
    const context = await manager.assembleForPrompt('which pier', 1600, NEUTRAL, { scopes: U1 });
    expect(context.contextText).toContain('pier 3');
    expect(context.capture!.reranker).toEqual({ provider: 'none', reason: 'none_configured' });
    expect(manager.getRerankerService()).toBe(service);
    await manager.shutdown();
  }
  expect(called).not.toHaveBeenCalled();
  // One per manager built.
  expect(events('memory.recall.option_ignored').filter((e) => e.option === 'remote_provider')).toHaveLength(2);
});

it("a manager's recall.rerank that names a remote provider is refused when it initialises, with one line, and no manager is built", async () => {
  const manager = new CognitiveMemoryManager();
  const vectorStore = new InMemoryVectorStore();
  await vectorStore.initialize({ id: 'policy-refused', type: 'in_memory', defaultEmbeddingDimension: 32, similarityMetric: 'cosine' } as never);
  await expect(
    manager.initialize({
      vectorStore,
      embeddingManager: new WordHashEmbedder() as never,
      agentId: 'policy-agent',
      traits: {},
      moodProvider: () => NEUTRAL,
      featureDetectionStrategy: 'keyword',
      recall: { rerank: { kind: 'cohere', apiKey: 'test-key' } },
    } as never),
  ).rejects.toMatchObject({ name: 'RecallOptionError', option: 'rerank', reason: 'unsupported_provider' });
  expect(events('memory.recall.option_rejected')).toEqual([expect.objectContaining({ option: 'rerank', reason: 'unsupported_provider' })]);
  await expect(manager.retrieve('which pier', NEUTRAL, { scopes: U1 })).rejects.toThrow('not initialized');
});

it('no environment variable turns memory rerank on', async () => {
  vi.stubEnv('COHERE_API_KEY', 'test-key');
  const manager = await managerWith();
  const context = await manager.assembleForPrompt('which pier', 1600, NEUTRAL, { scopes: U1 });
  expect(context.capture!.reranker).toEqual({ provider: 'none', reason: 'none_configured' });
  expect(events('memory.recall.option_ignored')).toEqual([]);
  await manager.shutdown();
});
