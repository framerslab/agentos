/**
 * @file BuiltInPersonas.contract.spec.ts
 * @description Pins the metaprompts AgentOS ships (those of the built-in
 * personas and the preset library) to what MetapromptExecutor can run: every
 * trigger is a type the executor fires, and the handler that serves each
 * metaprompt fills every placeholder in its template.
 */
import { describe, it, expect } from 'vitest';
import { BUILT_IN_PERSONAS } from '../../src/cognition/substrate/personas/definitions/index.js';
import { ALL_METAPROMPT_PRESETS } from '../../src/cognition/substrate/personas/metaprompt_presets.js';
import { validatePersonas } from '../../src/cognition/substrate/personas/PersonaValidation.js';
import { MetapromptExecutor } from '../../src/cognition/substrate/MetapromptExecutor.js';
import { InMemoryWorkingMemory } from '../../src/cognition/substrate/memory/InMemoryWorkingMemory.js';
import { GMIMood, GMIPrimeState } from '../../src/cognition/substrate/IGMI.js';
import type { GMIEventType } from '../../src/cognition/substrate/GMIEvent.js';
import type { MetaPromptDefinition } from '../../src/cognition/substrate/personas/IPersonaDefinition.js';
import type { AIModelProviderManager } from '../../src/core/llm/providers/AIModelProviderManager.js';
import type { IUtilityAI } from '../../src/cognition/nlp/ai_utilities/IUtilityAI.js';

const SUPPORTED_TRIGGER_TYPES = ['turn_interval', 'event_based', 'manual'];
const TRIGGER_ISSUE_CODES = [
  'unsupported_metaprompt_trigger',
  'invalid_metaprompt_interval',
  'unknown_metaprompt_event',
];
const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;

const shippedMetaprompts: Array<{ owner: string; metaPrompt: MetaPromptDefinition }> = [
  ...BUILT_IN_PERSONAS.flatMap((persona) =>
    (persona.metaPrompts ?? []).map((metaPrompt) => ({ owner: persona.id, metaPrompt })),
  ),
  ...ALL_METAPROMPT_PRESETS.map((metaPrompt) => ({ owner: 'preset', metaPrompt })),
];

/**
 * Builds an executor whose LLM records every prompt it receives and answers
 * with an empty JSON object, so each handler runs to completion.
 */
async function createRecordingExecutor(prompts: string[]): Promise<MetapromptExecutor> {
  const workingMemory = new InMemoryWorkingMemory();
  await workingMemory.initialize('contract-gmi');
  const provider = {
    providerId: 'contract-provider',
    generateCompletion: async (_modelId: string, messages: Array<{ content: unknown }>) => {
      prompts.push(String(messages[0]?.content ?? ''));
      return {
        id: 'contract-completion',
        object: 'chat.completion',
        created: 0,
        modelId: 'contract-model',
        choices: [{ index: 0, message: { role: 'assistant', content: '{}' }, finishReason: 'stop' }],
      };
    },
  };

  return new MetapromptExecutor({
    workingMemory,
    llmProviderManager: { getProvider: () => provider } as unknown as AIModelProviderManager,
    utilityAI: { parseJsonSafe: async (text: string) => JSON.parse(text) } as unknown as IUtilityAI,
    getPersona: () => ({
      id: 'contract-persona',
      name: 'Contract Persona',
      description: 'Hosts the shipped metaprompts for this contract test.',
      version: '1.0.0',
      baseSystemPrompt: 'You are helpful.',
      defaultModelId: 'contract-model',
      defaultProviderId: 'contract-provider',
    }),
    addTraceEntry: () => undefined,
    getModelAndProvider: () => ({ modelId: 'contract-model', providerId: 'contract-provider' }),
    onMoodUpdate: () => undefined,
    onUserContextUpdate: () => undefined,
    onTaskContextUpdate: () => undefined,
    onMemoryImprint: async () => undefined,
    getPendingEvents: () => new Set<GMIEventType>(),
    getEventHistory: () => [],
    getConversationHistory: () => [{ role: 'user', content: 'How do I read a file in Python?' }],
    getReasoningTraceEntries: () => [],
    getMood: () => GMIMood.NEUTRAL,
    getUserContext: () => ({ userId: 'contract-user', skillLevel: 'intermediate' }),
    getTaskContext: () => ({ taskId: 'contract-task', complexity: 'moderate' }),
    setState: () => undefined,
    getState: () => GMIPrimeState.READY,
    getGmiId: () => 'contract-gmi',
  });
}

describe('Built-in persona metaprompt contract', () => {
  it('declares only metaprompt triggers the executor fires', async () => {
    const unsupported = shippedMetaprompts
      .filter(({ metaPrompt }) => !SUPPORTED_TRIGGER_TYPES.includes(String(metaPrompt.trigger?.type)))
      .map(({ owner, metaPrompt }) => `${owner}/${metaPrompt.id}: ${String(metaPrompt.trigger?.type)}`);
    expect(unsupported).toEqual([]);

    const report = await validatePersonas(BUILT_IN_PERSONAS);
    const triggerIssues = report.results
      .flatMap((result) => result.issues)
      .filter((issue) => TRIGGER_ISSUE_CODES.includes(issue.code));
    expect(triggerIssues).toEqual([]);
  });

  it('fills every placeholder in the shipped metaprompt templates', async () => {
    const prompts: string[] = [];
    const executor = await createRecordingExecutor(prompts);
    const unresolved: string[] = [];

    for (const { owner, metaPrompt } of shippedMetaprompts) {
      prompts.length = 0;
      await executor.executeMetapromptHandler(metaPrompt);
      expect(prompts).toHaveLength(1);
      for (const match of prompts[0].matchAll(PLACEHOLDER)) {
        unresolved.push(`${owner}/${metaPrompt.id}: {{${match[1]}}}`);
      }
    }

    expect(unresolved).toEqual([]);
  });
});
