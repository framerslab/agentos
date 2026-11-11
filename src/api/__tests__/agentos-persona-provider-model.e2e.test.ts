/**
 * @file agentos-persona-provider-model.e2e.test.ts
 * A persona, or a turn, that names a provider and no model runs on that provider's default model, never on the
 * runtime's default model, which belongs to another provider. A model named at the same or a more specific level is
 * kept. With no model named anywhere and no GMI default, a streamed turn runs on the default provider's default model.
 * The provider classes are stubbed at their module boundary; the factory, the provider manager, the GMI manager and
 * the GMI turn are the real ones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ streamed: [] as Array<{ providerId: string; modelId: string }> }));

/** A provider stub that records each streamed call and takes its default model from its entry's config. */
const stubProvider = vi.hoisted(() => (providerId: string, fallbackModelId?: string) =>
  class StubProvider {
    readonly providerId = providerId;
    isInitialized = false;
    defaultModelId?: string;
    async initialize(config: { defaultModelId?: string }) {
      this.defaultModelId = config.defaultModelId ?? fallbackModelId;
      this.isInitialized = true;
    }
    async generateCompletion() {
      return { choices: [{ message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }], responseText: 'ok' };
    }
    async *generateCompletionStream(modelId: string) {
      calls.streamed.push({ providerId, modelId });
      yield { responseTextDelta: `Served by ${providerId}.` };
      yield { isFinal: true, choices: [{ message: { role: 'assistant', content: `Served by ${providerId}.` }, finishReason: 'stop' }] };
    }
    async generateEmbeddings() { return { embeddings: [] }; }
    async listAvailableModels() { return []; }
    async getModelInfo() { return undefined; }
    async checkHealth() { return { isHealthy: true }; }
    async shutdown() {}
  },
);

vi.mock('../../core/llm/providers/implementations/OpenRouterProvider', () => ({ OpenRouterProvider: stubProvider('openrouter') }));
// MiniMax's own default model when its entry names none (MiniMaxProvider.initialize).
vi.mock('../../core/llm/providers/implementations/MiniMaxProvider', () => ({ MiniMaxProvider: stubProvider('minimax', 'MiniMax-M3.1-Flash') }));
// The factory always configures Ollama (OLLAMA_BASE_URL falls back to http://localhost:11434); the stub keeps the
// test off the network.
vi.mock('../../core/llm/providers/implementations/OllamaProvider', () => ({ OllamaProvider: stubProvider('ollama') }));

import { AgentOS } from '../AgentOS';
import { AgentOSResponseChunkType } from '../types/AgentOSResponse';
import type { IPersonaDefinition } from '../../cognition/substrate/personas/IPersonaDefinition';

const providers = [
  { providerId: 'openrouter', enabled: true, isDefault: true, config: { apiKey: 'test-openrouter-key', defaultModelId: 'openai/gpt-4o-mini' } },
  { providerId: 'minimax', enabled: true, config: { apiKey: 'test-minimax-key' } },
];

function persona(fields: Partial<IPersonaDefinition> = {}): IPersonaDefinition {
  return {
    id: 'provider-persona', name: 'Provider Persona', description: 'Names a provider.',
    version: '1.0.0', baseSystemPrompt: 'You are a helpful assistant.',
    ...fields,
  };
}

async function runTurn(agentos: AgentOS, personaId: string, options?: Record<string, unknown>): Promise<any[]> {
  const chunks: any[] = [];
  for await (const chunk of agentos.processRequest({
    userId: 'user-1', sessionId: `s-${Math.random().toString(36).slice(2)}`, selectedPersonaId: personaId,
    textInput: 'Say hello.', ...(options ? { options } : {}),
  } as any)) {
    chunks.push(chunk);
  }
  return chunks;
}

function expectNoError(chunks: any[]): void {
  const error = chunks.find((c) => c.type === AgentOSResponseChunkType.ERROR);
  expect(error, error ? `${error.code}: ${error.message}` : undefined).toBeUndefined();
}

describe('a provider named without a model', () => {
  let booted: AgentOS | undefined;

  beforeEach(() => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    vi.stubEnv('REQUESTY_API_KEY', '');
    vi.stubEnv('MINIMAX_API_KEY', '');
    vi.stubEnv('ENABLE_UTILITY_AI', 'false');
    calls.streamed.length = 0;
    booted = undefined;
  });

  afterEach(async () => {
    if (booted) await booted.shutdown();
    vi.unstubAllEnvs();
  });

  it("runs a persona that names a provider and no model on that provider's default model", async () => {
    const minimaxPersona = persona({ defaultProviderId: 'minimax' });
    booted = await AgentOS.create({
      modelProviderManagerConfig: { providers }, turnPlanning: { enabled: false }, personas: [minimaxPersona],
    } as any);

    const chunks = await runTurn(booted, minimaxPersona.id);

    expectNoError(chunks);
    expect(calls.streamed).toEqual([{ providerId: 'minimax', modelId: 'MiniMax-M3.1-Flash' }]);
  });

  it("runs a turn that names a provider and no model on that provider's default model", async () => {
    const plainPersona = persona({ id: 'plain-persona' });
    booted = await AgentOS.create({
      modelProviderManagerConfig: { providers }, turnPlanning: { enabled: false }, personas: [plainPersona],
    } as any);

    const chunks = await runTurn(booted, plainPersona.id, { preferredProviderId: 'minimax' });

    expectNoError(chunks);
    expect(calls.streamed).toEqual([{ providerId: 'minimax', modelId: 'MiniMax-M3.1-Flash' }]);
  });

  it('keeps a model the persona names beside its provider', async () => {
    const pinnedPersona = persona({ id: 'pinned-persona', defaultProviderId: 'minimax', defaultModelId: 'MiniMax-M3' });
    booted = await AgentOS.create({
      modelProviderManagerConfig: { providers }, turnPlanning: { enabled: false }, personas: [pinnedPersona],
    } as any);

    const chunks = await runTurn(booted, pinnedPersona.id);

    expectNoError(chunks);
    expect(calls.streamed).toEqual([{ providerId: 'minimax', modelId: 'MiniMax-M3' }]);
  });

  it("keeps the persona's model when a turn names the persona's own provider", async () => {
    // The persona spells the provider in another letter case: it is still the turn's provider.
    const pinnedPersona = persona({ id: 'pinned-same', defaultProviderId: 'MiniMax', defaultModelId: 'MiniMax-M3' });
    booted = await AgentOS.create({
      modelProviderManagerConfig: { providers }, turnPlanning: { enabled: false }, personas: [pinnedPersona],
    } as any);

    const chunks = await runTurn(booted, pinnedPersona.id, { preferredProviderId: 'minimax' });

    expectNoError(chunks);
    expect(calls.streamed).toEqual([{ providerId: 'minimax', modelId: 'MiniMax-M3' }]);
  });

  it("runs a streamed turn on the default provider's default model when no level names a model", async () => {
    const { createAgentOSConfig } = await import('../../core/config/AgentOSConfig');
    const base = await createAgentOSConfig();
    const plainPersona = persona({ id: 'no-model-persona' });
    booted = await AgentOS.create({
      modelProviderManagerConfig: { providers },
      // A host GMI config with no GMI default: no level names a provider or a model.
      gmiManagerConfig: { ...base.gmiManagerConfig, defaultGMIBaseConfigDefaults: undefined },
      turnPlanning: { enabled: false },
      personas: [plainPersona],
    } as any);

    const chunks = await runTurn(booted, plainPersona.id);

    expectNoError(chunks);
    expect(calls.streamed).toEqual([{ providerId: 'openrouter', modelId: 'openai/gpt-4o-mini' }]);
  });
});
