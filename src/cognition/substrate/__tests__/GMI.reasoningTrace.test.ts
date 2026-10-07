/**
 * @file GMI.reasoningTrace.test.ts
 * A real GMI with stubbed collaborators: the reasoning trace keeps the number
 * of entries the persona or the runtime config allows, dropping the oldest.
 */
import { describe, expect, it, vi } from 'vitest';
import { GMI } from '../GMI';
import { ReasoningEntryType } from '../IGMI';
import type { IPersonaDefinition } from '../personas/IPersonaDefinition';
import { InMemoryWorkingMemory } from '../memory/InMemoryWorkingMemory';
import type { IPromptEngine } from '../../../core/llm/IPromptEngine';
import type { AIModelProviderManager } from '../../../core/llm/providers/AIModelProviderManager';
import type { IUtilityAI } from '../../nlp/ai_utilities/IUtilityAI';
import type { IToolOrchestrator } from '../../../core/tools/IToolOrchestrator';

const base: IPersonaDefinition = { id: 'trace-persona', name: 'Trace', description: 'd', version: '1.0.0', baseSystemPrompt: 'You are terse.' };

async function bootGmi(persona: IPersonaDefinition, defaults: { defaultReasoningTraceMaxEntries?: number; defaultReasoningTraceMaxMessageLength?: number } = {}): Promise<GMI> {
  const gmi = new GMI(`gmi-${persona.id}`);
  await gmi.initialize(persona, {
    workingMemory: new InMemoryWorkingMemory(),
    promptEngine: {} as unknown as IPromptEngine,
    llmProviderManager: { getProvider: vi.fn(), getProviderForModel: vi.fn(), getDefaultProvider: vi.fn(), getModelInfo: vi.fn() } as unknown as AIModelProviderManager,
    utilityAI: {} as unknown as IUtilityAI,
    toolOrchestrator: { listAvailableTools: vi.fn(async () => []), processToolCall: vi.fn() } as unknown as IToolOrchestrator,
    ...defaults,
  });
  return gmi;
}

async function feedback(gmi: GMI, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    await gmi.recordUserFeedback({ userId: 'user-1', polarity: 'positive', text: `feedback ${i}` } as any);
  }
}

describe('GMI reasoning trace limits', () => {
  it('keeps the persona\'s maxEntries, dropping the oldest entries', async () => {
    const gmi = await bootGmi({ ...base, reasoningTraceConfig: { maxEntries: 3 } });
    await feedback(gmi, 5);
    const entries = gmi.getReasoningTrace().entries;
    expect(entries.length).toBe(3);
    expect(entries.every((entry) => entry.type === ReasoningEntryType.DEBUG)).toBe(true);
    expect(entries[entries.length - 1].details.text).toBe('feedback 4');
  });

  it('uses the runtime default when the persona sets none', async () => {
    const gmi = await bootGmi(base, { defaultReasoningTraceMaxEntries: 4 });
    await feedback(gmi, 6);
    expect(gmi.getReasoningTrace().entries.length).toBe(4);
  });

  it('truncates entry messages to maxMessageLength', async () => {
    const gmi = await bootGmi({ ...base, reasoningTraceConfig: { maxMessageLength: 8 } });
    await feedback(gmi, 1);
    const entries = gmi.getReasoningTrace().entries;
    expect(entries.every((entry) => entry.message.length <= 8)).toBe(true);
  });
});
