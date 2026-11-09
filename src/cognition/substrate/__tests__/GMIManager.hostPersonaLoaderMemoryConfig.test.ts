/**
 * @file GMIManager.hostPersonaLoaderMemoryConfig.test.ts
 * A persona from a host's own `IPersonaLoader` reaches the host's
 * `cognitiveMemoryFactory` normalized, as `CognitiveMemoryPersonaConfig` says:
 * GMIManager normalizes every definition it stores, whatever loader returned it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GMIManager, type GMICognitiveMemoryFactoryInput } from '../GMIManager';
import type { IPersonaLoader } from '../personas/IPersonaLoader';
import { InMemoryPersonaLoader } from '../personas/InMemoryPersonaLoader';
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

  it('loads the other personas when one has non-array sentiment presets, and reports that one', async () => {
    const malformed = JSON.parse(
      '{"id":"bad","name":"bad","version":"1.0.0","baseSystemPrompt":"x","sentimentTracking":{"enabled":true,"presets":"frustration_recovery"}}',
    ) as IPersonaDefinition;
    const nullPresets = JSON.parse(
      '{"id":"nul","name":"nul","version":"1.0.0","baseSystemPrompt":"x","sentimentTracking":{"enabled":true,"presets":null}}',
    ) as IPersonaDefinition;
    const good = { id: 'good', name: 'good', version: '1.0.0', baseSystemPrompt: 'x' } as IPersonaDefinition;
    const manager = createManager(hostLoader([malformed, nullPresets, good]), vi.fn() as never);
    await manager.initialize();

    expect(manager.getPersonaDefinition('good')).toBe(good);
    const stored = manager.getPersonaDefinition('bad');
    expect(stored).toBeDefined();
    expect(stored!.metaPrompts).toBeUndefined();
    const records = (manager as unknown as { allPersonaRecords: Map<string, { validation?: { issues: { code: string }[] } }> })
      .allPersonaRecords;
    const codes = records.get('bad')?.validation?.issues.map((issue) => issue.code) ?? [];
    expect(codes).toContain('invalid_sentiment_presets');
    const nullCodes = records.get('nul')?.validation?.issues.map((issue) => issue.code) ?? [];
    expect(nullCodes).toContain('invalid_sentiment_presets');
    const goodCodes = records.get('good')?.validation?.issues.map((issue) => issue.code) ?? [];
    expect(goodCodes).not.toContain('invalid_sentiment_presets');
    await manager.shutdown();
  });

  it('skips a definition the normalizer throws on, and loads and validates the rest', async () => {
    const other = { id: 'r', name: 'r', version: '1.0.0', baseSystemPrompt: 'x' } as IPersonaDefinition;
    // A getter that throws stands for any host object the normalizer cannot read.
    const broken = { id: 'broken', name: 'broken', version: '1.0.0', baseSystemPrompt: 'x' } as IPersonaDefinition;
    Object.defineProperty(broken, 'sentimentTracking', {
      enumerable: true,
      get: () => {
        throw new Error('unreadable');
      },
    });
    const manager = createManager(hostLoader([broken, other]), vi.fn() as never);
    await expect(manager.initialize()).resolves.toBeUndefined();
    expect(manager.getPersonaDefinition('broken')).toBeUndefined();
    expect(manager.getPersonaDefinition('r')).toBe(other);
    const records = (manager as unknown as { allPersonaRecords: Map<string, unknown> }).allPersonaRecords;
    expect([...records.keys()]).toEqual(['r']);
    await manager.shutdown();
  });

  it('stores a shipped loader persona with the preset metaprompts merged once, overrides kept', async () => {
    const override = { id: 'gmi_frustration_recovery', description: 'host override', promptTemplate: 'mine', trigger: { type: 'manual' } };
    const custom = { id: 'custom', description: 'custom', promptTemplate: 'custom', trigger: { type: 'manual' } };
    const definition = {
      id: 's',
      name: 's',
      version: '1.0.0',
      baseSystemPrompt: 'x',
      sentimentTracking: { enabled: true, presets: ['frustration_recovery', 'confusion_clarification'] },
      metaPrompts: [override, custom],
    } as unknown as IPersonaDefinition;
    const manager = createManager(new InMemoryPersonaLoader([definition]), vi.fn() as never);
    await manager.initialize();

    const stored = manager.getPersonaDefinition('s')!.metaPrompts!;
    expect(stored.map((metaPrompt) => metaPrompt.id)).toEqual(['gmi_frustration_recovery', 'gmi_confusion_clarification', 'custom']);
    expect(stored[0]).toEqual(override);
    expect(stored[2]).toEqual(custom);
    await manager.shutdown();
  });

  it('reports invalid_metaprompts when presets replace a host metaPrompts that is not an array', async () => {
    const parsed = JSON.parse(
      '{"id":"m","name":"m","version":"1.0.0","baseSystemPrompt":"x","metaPrompts":"","sentimentTracking":{"enabled":true,"presets":["frustration_recovery"]}}',
    ) as IPersonaDefinition;
    const manager = createManager(hostLoader([parsed]), vi.fn() as never);
    await manager.initialize();

    expect(manager.getPersonaDefinition('m')!.metaPrompts!.map((metaPrompt) => metaPrompt.id)).toEqual(['gmi_frustration_recovery']);
    const records = (manager as unknown as { allPersonaRecords: Map<string, { validation?: { issues: { code: string }[] } }> })
      .allPersonaRecords;
    expect(records.get('m')?.validation?.issues.map((issue) => issue.code)).toContain('invalid_metaprompts');
    await manager.shutdown();
  });

  it('reports a host persona whose metaPrompts is not an array', async () => {
    const parsed = JSON.parse('{"id":"n","name":"n","version":"1.0.0","baseSystemPrompt":"x","metaPrompts":"oops"}') as IPersonaDefinition;
    const manager = createManager(hostLoader([parsed]), vi.fn() as never);
    await manager.initialize();
    const records = (manager as unknown as { allPersonaRecords: Map<string, { validation?: { issues: { code: string }[] } }> })
      .allPersonaRecords;
    expect(records.get('n')?.validation?.issues.map((issue) => issue.code)).toContain('invalid_metaprompts');
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
