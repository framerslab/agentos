/**
 * @file GMIManager.hostPersonaLoaderMemoryConfig.test.ts
 * A persona from a host's own `IPersonaLoader` reaches the host's
 * `cognitiveMemoryFactory` normalized, as `CognitiveMemoryPersonaConfig` says:
 * GMIManager normalizes every definition it stores, whatever loader returned it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GMIManager, type GMICognitiveMemoryFactoryInput } from '../GMIManager';
import type { IPersonaLoader } from '../personas/IPersonaLoader';
import type { IPersonaDefinition } from '../personas/IPersonaDefinition';
import type { ICognitiveMemoryManager } from '../../memory/CognitiveMemoryManager.js';
import type { IUtilityAI } from '../../nlp/ai_utilities/IUtilityAI';
import { ConversationContext } from '../../../core/conversation/ConversationContext';
import type { ConversationManager } from '../../../core/conversation/ConversationManager';
import type { IPromptEngine } from '../../../core/llm/IPromptEngine';
import type { AIModelProviderManager } from '../../../core/llm/providers/AIModelProviderManager';
import type { IToolOrchestrator } from '../../../core/tools/IToolOrchestrator';

/** A host loader that hands back parsed JSON as it is, without normalizing it. */
function hostLoader(definitions: IPersonaDefinition[]): IPersonaLoader {
  return {
    initialize: async () => undefined,
    loadPersonaById: async (id: string) => definitions.find((definition) => definition.id === id),
    loadAllPersonaDefinitions: async () => definitions,
  } as unknown as IPersonaLoader;
}

function createManager(loader: IPersonaLoader, factory: (input: GMICognitiveMemoryFactoryInput) => ICognitiveMemoryManager) {
  return new GMIManager(
    { personaLoaderConfig: { personaSource: 'host' }, cognitiveMemoryFactory: factory },
    undefined,
    undefined,
    { getOrCreateConversationContext: async () => new ConversationContext('conv-1') } as unknown as ConversationManager,
    { estimateTokenCount: async () => 10 } as unknown as IPromptEngine,
    {} as unknown as AIModelProviderManager,
    {} as unknown as IUtilityAI,
    { listAvailableTools: async () => [] } as unknown as IToolOrchestrator,
    undefined,
    loader,
  );
}

describe('a host IPersonaLoader with null memory settings', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reaches the cognitive memory factory with the null fields absent', async () => {
    const seen: GMICognitiveMemoryFactoryInput[] = [];
    // A factory written against the type: it reads a set field as an object.
    const factory = vi.fn((input: GMICognitiveMemoryFactoryInput) => {
      seen.push(input);
      const decay = input.persona.cognitiveMemoryConfig?.decay;
      if (decay !== undefined) Object.entries(decay);
      return {
        encode: vi.fn(async () => ({})),
        observe: vi.fn(async () => null),
        shutdown: vi.fn(async () => undefined),
      } as unknown as ICognitiveMemoryManager;
    });
    const parsed = JSON.parse(
      '{"id":"p","name":"p","version":"1","baseSystemPrompt":"x","cognitiveMemoryConfig":{"decay":null}}',
    ) as IPersonaDefinition;

    const manager = createManager(hostLoader([parsed]), factory);
    await manager.initialize();
    await manager.getOrCreateGMIForSession('user-1', 'session-1', 'p');

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveReturned();
    const memory = seen[0].persona.cognitiveMemoryConfig as Record<string, unknown>;
    expect('decay' in memory).toBe(false);
    // The host's own object is left as it was.
    expect(parsed.cognitiveMemoryConfig).toEqual({ decay: null });
    await manager.shutdown();
  });

  it('stores a clean persona as the same object', async () => {
    const clean = { id: 'q', name: 'q', version: '1', baseSystemPrompt: 'x' } as IPersonaDefinition;
    const manager = createManager(hostLoader([clean]), vi.fn() as never);
    await manager.initialize();
    expect(manager.getPersonaDefinition('q')).toBe(clean);
    await manager.shutdown();
  });
});
