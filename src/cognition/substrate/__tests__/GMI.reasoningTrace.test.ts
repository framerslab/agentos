/**
 * @file GMI.reasoningTrace.test.ts
 * A real GMI with stubbed collaborators: the reasoning trace keeps the number
 * of entries the persona or the runtime config allows, dropping the oldest,
 * raises a cap below the floor, and trims an over-full trace after a
 * re-initialize from the ERRORED state.
 */
import { describe, expect, it, vi } from 'vitest';
import { GMI } from '../GMI';
import { GMIPrimeState, ReasoningEntryType, type GMIBaseConfig } from '../IGMI';
import type { IPersonaDefinition } from '../personas/IPersonaDefinition';
import { InMemoryWorkingMemory } from '../memory/InMemoryWorkingMemory';
import { REASONING_TRACE_MIN_ENTRIES } from '../reasoningTraceLimits';
import type { IPromptEngine } from '../../../core/llm/IPromptEngine';
import type { AIModelProviderManager } from '../../../core/llm/providers/AIModelProviderManager';
import type { IUtilityAI } from '../../nlp/ai_utilities/IUtilityAI';
import type { IToolOrchestrator } from '../../../core/tools/IToolOrchestrator';

const base: IPersonaDefinition = { id: 'trace-persona', name: 'Trace', description: 'd', version: '1.0.0', baseSystemPrompt: 'You are terse.' };

type Defaults = { defaultReasoningTraceMaxEntries?: number; defaultReasoningTraceMaxMessageLength?: number };

function baseConfig(defaults: Defaults = {}): GMIBaseConfig {
  return {
    workingMemory: new InMemoryWorkingMemory(),
    promptEngine: {} as unknown as IPromptEngine,
    llmProviderManager: { getProvider: vi.fn(), getProviderForModel: vi.fn(), getDefaultProvider: vi.fn(), getModelInfo: vi.fn() } as unknown as AIModelProviderManager,
    utilityAI: {} as unknown as IUtilityAI,
    toolOrchestrator: { listAvailableTools: vi.fn(async () => []), processToolCall: vi.fn() } as unknown as IToolOrchestrator,
    ...defaults,
  } as GMIBaseConfig;
}

async function bootGmi(persona: IPersonaDefinition, defaults: Defaults = {}): Promise<GMI> {
  const gmi = new GMI(`gmi-${persona.id}`);
  await gmi.initialize(persona, baseConfig(defaults));
  return gmi;
}

async function feedback(gmi: GMI, times: number, from = 0): Promise<void> {
  for (let i = from; i < from + times; i++) {
    await gmi.recordUserFeedback({ userId: 'user-1', polarity: 'positive', text: `feedback ${i}` } as any);
  }
}

const texts = (gmi: GMI): unknown[] => gmi.getReasoningTrace().entries.map((entry) => entry.details?.text);

describe('GMI reasoning trace limits', () => {
  it("keeps the persona's maxEntries, dropping the oldest entries in order", async () => {
    const gmi = await bootGmi({ ...base, reasoningTraceConfig: { maxEntries: 20 } });
    await feedback(gmi, 25);
    const entries = gmi.getReasoningTrace().entries;
    expect(entries.length).toBe(20);
    expect(entries.every((entry) => entry.type === ReasoningEntryType.DEBUG)).toBe(true);
    expect(texts(gmi)).toEqual(Array.from({ length: 20 }, (_, i) => `feedback ${i + 5}`));
  });

  it('uses the runtime default when the persona sets none', async () => {
    const gmi = await bootGmi(base, { defaultReasoningTraceMaxEntries: 21 });
    await feedback(gmi, 30);
    expect(gmi.getReasoningTrace().entries.length).toBe(21);
    expect(texts(gmi).at(-1)).toBe('feedback 29');
  });

  it('raises an entry cap below the floor to the floor and records it', async () => {
    const gmi = await bootGmi({ ...base, reasoningTraceConfig: { maxEntries: 1 } });
    const warning = gmi.getReasoningTrace().entries.find((entry) => entry.type === ReasoningEntryType.WARNING && Array.isArray(entry.details?.ignored));
    expect(warning?.details?.ignored).toEqual([{ source: 'persona', key: 'maxEntries', value: 1, reason: 'below_floor' }]);
    await feedback(gmi, 25);
    expect(gmi.getReasoningTrace().entries.length).toBe(REASONING_TRACE_MIN_ENTRIES);
  });

  it('clamps an oversized persona limit to the ceiling and records it in the trace', async () => {
    const gmi = await bootGmi({ ...base, reasoningTraceConfig: { maxEntries: 50_000, maxMessageLength: 5 } });
    // The message is capped at 5 characters by the same setting, so find the entry by its details.
    const warning = gmi.getReasoningTrace().entries.find((entry) => entry.type === ReasoningEntryType.WARNING && Array.isArray(entry.details?.ignored));
    expect(warning?.details?.ignored).toEqual([{ source: 'persona', key: 'maxEntries', value: 50_000, reason: 'above_ceiling' }]);
    expect(warning?.message.length).toBeLessThanOrEqual(5);
  });

  it('records a runtime default that is not a positive integer', async () => {
    const gmi = await bootGmi(base, { defaultReasoningTraceMaxEntries: 2.5 });
    const warning = gmi.getReasoningTrace().entries.find((entry) => entry.type === ReasoningEntryType.WARNING);
    expect(warning?.details?.ignored).toEqual([{ source: 'config', key: 'maxEntries', value: 2.5, reason: 'not_a_positive_integer' }]);
  });

  it('truncates entry messages to maxMessageLength', async () => {
    const gmi = await bootGmi({ ...base, reasoningTraceConfig: { maxMessageLength: 8 } });
    await feedback(gmi, 1);
    const entries = gmi.getReasoningTrace().entries;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry.message.length <= 8)).toBe(true);
  });

  it('trims an over-full trace after a re-initialize from the ERRORED state', async () => {
    const gmi = await bootGmi({ ...base, reasoningTraceConfig: { maxEntries: 30 } });
    await feedback(gmi, 35);
    expect(gmi.getReasoningTrace().entries.length).toBe(30);
    // A re-initialize from ERRORED keeps the old entries; the next write must trim them to the new cap.
    (gmi as unknown as { state: GMIPrimeState }).state = GMIPrimeState.ERRORED;
    await gmi.initialize({ ...base, reasoningTraceConfig: { maxEntries: 20 } }, baseConfig());
    await feedback(gmi, 1, 100);
    expect(gmi.getReasoningTrace().entries.length).toBe(20);
    expect(texts(gmi).at(-1)).toBe('feedback 100');
  });
});
