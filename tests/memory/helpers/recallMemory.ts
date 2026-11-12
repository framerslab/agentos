/**
 * @fileoverview A real cognitive memory for the recall tests: `createAgentCognitiveMemory` over one of the
 * deterministic embedders, with an optional Brain and persona memory settings, and a way to file a trace into it.
 */

import { createAgentCognitiveMemory, type AgentCognitiveMemory } from '../../../src/api/runtime/agentCognitiveMemory';
import type { CognitiveMemoryPersonaConfig } from '../../../src/cognition/memory/core/config';
import type { MemoryTrace } from '../../../src/cognition/memory/core/types';
import type { Brain } from '../../../src/cognition/memory/retrieval/store/Brain';
import { WordHashEmbedder, trace } from './recallFixtures';

/**
 * A memory built as `agent({ runtime: 'gmi' })` builds one, with `memory.recall` set to `recall`, over `embedder`, on
 * `brain` when one is given, with the persona's `cognitiveMemoryConfig` when one is given.
 */
export async function memoryWith(
  recall: Record<string, unknown> | undefined,
  embedder: WordHashEmbedder = new WordHashEmbedder(),
  brain?: Brain,
  personaMemory?: CognitiveMemoryPersonaConfig,
): Promise<AgentCognitiveMemory> {
  const persona = {
    id: 'recall-agent',
    name: 'Recall',
    description: 'd',
    version: '1.0.0',
    baseSystemPrompt: 'x',
    personalityTraits: {},
    ...(personaMemory ? { cognitiveMemoryConfig: personaMemory } : {}),
  } as never;
  return createAgentCognitiveMemory({
    persona,
    memory: (recall ? { recall } : {}) as never,
    embeddingManager: embedder as never,
    ...(brain ? { brain } : {}),
  });
}

/** Files a trace of user `u1` (the fixtures' `trace`) through the memory's store. */
export async function plant(mem: AgentCognitiveMemory, id: string, text: string, over: Partial<MemoryTrace> = {}): Promise<void> {
  await mem.manager.getStore().store(trace(id, text, over));
}
