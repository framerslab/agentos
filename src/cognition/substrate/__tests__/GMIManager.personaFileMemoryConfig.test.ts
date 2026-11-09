/**
 * @file GMIManager.personaFileMemoryConfig.test.ts
 * A persona read from a JSON file by the file-system PersonaLoader reaches the
 * host's `cognitiveMemoryFactory` matching `CognitiveMemoryPersonaConfig`: a
 * field or key the file sets to `null` arrives absent, as the type says.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { GMIManager, type GMICognitiveMemoryFactoryInput } from '../GMIManager';
import { PersonaLoader } from '../personas/PersonaLoader';
import type { ICognitiveMemoryManager } from '../../memory/CognitiveMemoryManager.js';
import type { IUtilityAI } from '../../nlp/ai_utilities/IUtilityAI';
import { ConversationContext } from '../../../core/conversation/ConversationContext';
import type { ConversationManager } from '../../../core/conversation/ConversationManager';
import type { IPromptEngine } from '../../../core/llm/IPromptEngine';
import type { AIModelProviderManager } from '../../../core/llm/providers/AIModelProviderManager';
import type { IToolOrchestrator } from '../../../core/tools/IToolOrchestrator';

describe('a persona file with null memory settings', () => {
  let dir: string;

  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'persona-null-'));
    await fs.writeFile(
      path.join(dir, 'p.json'),
      JSON.stringify({
        id: 'p',
        name: 'p',
        version: '1',
        baseSystemPrompt: 'x',
        cognitiveMemoryConfig: {
          decay: null,
          workingMemoryCapacity: null,
          tokenBudget: { semanticRecall: null, recentEpisodic: 0.3 },
          encoding: { baseStrength: 0.4, flashbulbThreshold: null },
        },
      }),
      'utf-8',
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reaches the cognitive memory factory with the null fields and keys absent', async () => {
    const seen: GMICognitiveMemoryFactoryInput[] = [];
    // A factory written against the type: it reads a set field as an object.
    const factory = vi.fn((input: GMICognitiveMemoryFactoryInput) => {
      seen.push(input);
      const memory = input.persona.cognitiveMemoryConfig ?? {};
      for (const value of [memory.decay, memory.encoding, memory.tokenBudget]) {
        if (value !== undefined) Object.entries(value);
      }
      return {
        encode: vi.fn(async () => ({})),
        observe: vi.fn(async () => null),
        shutdown: vi.fn(async () => undefined),
      } as unknown as ICognitiveMemoryManager;
    });

    const manager = new GMIManager(
      { personaLoaderConfig: { personaSource: dir }, cognitiveMemoryFactory: factory },
      undefined,
      undefined,
      { getOrCreateConversationContext: async () => new ConversationContext('conv-1') } as unknown as ConversationManager,
      { estimateTokenCount: async () => 10 } as unknown as IPromptEngine,
      {} as unknown as AIModelProviderManager,
      {} as unknown as IUtilityAI,
      { listAvailableTools: async () => [] } as unknown as IToolOrchestrator,
      undefined,
      new PersonaLoader(),
    );
    await manager.initialize();
    await manager.getOrCreateGMIForSession('user-1', 'session-1', 'p');

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveReturned();
    const memory = seen[0].persona.cognitiveMemoryConfig as Record<string, unknown>;
    expect(memory).toEqual({
      tokenBudget: { recentEpisodic: 0.3 },
      encoding: { baseStrength: 0.4 },
    });
    expect('decay' in memory).toBe(false);
    expect('workingMemoryCapacity' in memory).toBe(false);
    await manager.shutdown();
  });

  it('PersonaLoader drops a null cognitiveMemoryConfig itself', async () => {
    await fs.writeFile(
      path.join(dir, 'p.json'),
      JSON.stringify({ id: 'p', name: 'p', version: '1', baseSystemPrompt: 'x', cognitiveMemoryConfig: null }),
      'utf-8',
    );
    const loader = new PersonaLoader();
    await loader.initialize({ personaSource: dir });
    const persona = await loader.loadPersonaById('p');
    expect(persona).toBeDefined();
    expect('cognitiveMemoryConfig' in persona!).toBe(false);
  });
});
