/**
 * @file agentos-persona-traits.e2e.test.ts
 * On the full runtime, a persona's HEXACO traits reach the provider as the personality section of the system prompt
 * with no learning layer; a persona without traits sends no section; the hard limits still close the prompt.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const provider = vi.hoisted(() => ({
  seenMessages: [] as Array<Array<{ role: string; content: unknown }>>,
}));

vi.mock('../../core/llm/providers/implementations/OpenAIProvider', () => {
  class OpenAIProvider {
    readonly providerId = 'openai';
    isInitialized = false;
    async initialize() { this.isInitialized = true; }
    async generateCompletion() { return { choices: [{ message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }], responseText: 'ok' }; }
    async *generateCompletionStream(_modelId: string, messages: Array<{ role: string; content: unknown }>) {
      provider.seenMessages.push(messages);
      yield { responseTextDelta: 'Noted.' };
      yield { isFinal: true, choices: [{ message: { role: 'assistant', content: 'Noted.' }, finishReason: 'stop' }] };
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
import type { IPersonaDefinition } from '../../cognition/substrate/personas/IPersonaDefinition';
import { hardLimitsBlock } from '../../cognition/substrate/personas/hardLimits';
import { PERSONALITY_SECTION_HEADING, renderPersonalitySection } from '../../cognition/substrate/personas/personalityPrompt';
import { parseSoul } from '../../cognition/substrate/personas/SoulLoader';

const TRAITS = { honesty: 0.9, extraversion: 0.8 };
const warm = {
  id: 'warm', name: 'Warm', description: 'A persona with traits.', version: '1.0.0',
  baseSystemPrompt: 'You plan with the person.', personalityTraits: TRAITS, hardLimits: ['Never promise a date.'],
} as unknown as IPersonaDefinition;
const plain = { id: 'plain', name: 'Plain', description: 'A persona without traits.', version: '1.0.0', baseSystemPrompt: 'You are terse.' } as unknown as IPersonaDefinition;
const souled = parseSoul('---\nname: Aria\nagentId: aria-1\nhexaco:\n  honestyHumility: 0.9\n  extraversion: 0.8\n---\nYou are Aria.').personaDefinition;

async function boot(): Promise<AgentOS> {
  return AgentOS.create({ modelProviderManagerConfig: { providers: [{ providerId: 'openai', enabled: true, isDefault: true, config: { apiKey: 'test' } }] }, turnPlanning: { enabled: false }, personas: [warm, plain, souled] } as any);
}

const systemTextOf = (messages: Array<{ role: string; content: unknown }>): string =>
  messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n\n');

describe("a persona's traits in the system prompt with no learning layer", () => {
  let booted: AgentOS | undefined;
  afterEach(async () => {
    if (booted) await booted.shutdown();
    booted = undefined;
    provider.seenMessages.length = 0;
    vi.restoreAllMocks();
  });

  it('renders the personality section once, before the hard limits, and none for a persona without traits', async () => {
    booted = await boot();
    for await (const _chunk of booted.processRequest({ userId: 'u', sessionId: 's-warm', selectedPersonaId: 'warm', textInput: 'Will I pass?' } as any)) { /* drain */ }
    const system = systemTextOf(provider.seenMessages.at(-1) ?? []);
    expect(system).toContain(renderPersonalitySection(TRAITS)!);
    expect(system.split(PERSONALITY_SECTION_HEADING)).toHaveLength(2);
    expect(system.trimEnd().endsWith(hardLimitsBlock(warm.hardLimits)!)).toBe(true);
    for await (const _chunk of booted.processRequest({ userId: 'u', sessionId: 's-plain', selectedPersonaId: 'plain', textInput: 'Hello.' } as any)) { /* drain */ }
    expect(systemTextOf(provider.seenMessages.at(-1) ?? [])).not.toContain(PERSONALITY_SECTION_HEADING);
  });

  it("renders it for a persona loaded from a soul file's front matter", async () => {
    booted = await boot();
    for await (const _chunk of booted.processRequest({ userId: 'u', sessionId: 's-souled', selectedPersonaId: 'aria-1', textInput: 'Hello.' } as any)) { /* drain */ }
    const system = systemTextOf(provider.seenMessages.at(-1) ?? []);
    expect(system).toContain('You are Aria.');
    expect(system).toContain(renderPersonalitySection(TRAITS)!);
  });
});
