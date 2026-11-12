/**
 * @file agentos-factory-default-provider.e2e.test.ts
 * A persona that names no provider and no model, on the runtime `AgentOS.create()` builds from the environment:
 * with only `OPENROUTER_API_KEY` set, the turn runs on OpenRouter, the provider the factory makes the default, and on
 * that provider's default model. Given providers of its own (`modelProviderManagerConfig`), the runtime runs such a
 * persona on the default one of those, unless the host names a GMI default. The provider classes are stubbed at their
 * module boundary; the factory, the provider manager, the GMI manager and the GMI turn are the real ones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ streamed: [] as Array<{ providerId: string; modelId: string }> }));

vi.mock('../../core/llm/providers/implementations/OpenRouterProvider', () => {
  class OpenRouterProvider {
    readonly providerId = 'openrouter';
    isInitialized = false;
    defaultModelId?: string;
    async initialize(config: { defaultModelId?: string }) {
      this.defaultModelId = config.defaultModelId;
      this.isInitialized = true;
    }
    async generateCompletion() {
      return { choices: [{ message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }], responseText: 'ok' };
    }
    async *generateCompletionStream(modelId: string) {
      calls.streamed.push({ providerId: this.providerId, modelId });
      yield { responseTextDelta: 'Served by the default provider.' };
      yield { isFinal: true, choices: [{ message: { role: 'assistant', content: 'Served by the default provider.' }, finishReason: 'stop' }] };
    }
    async generateEmbeddings() { return { embeddings: [] }; }
    async listAvailableModels() { return []; }
    async getModelInfo() { return undefined; }
    async checkHealth() { return { isHealthy: true }; }
    async shutdown() {}
  }
  return { OpenRouterProvider };
});

// The factory always configures Ollama (OLLAMA_BASE_URL falls back to http://localhost:11434); the stub keeps the
// test off the network.
vi.mock('../../core/llm/providers/implementations/OllamaProvider', () => {
  class OllamaProvider {
    readonly providerId = 'ollama';
    isInitialized = false;
    defaultModelId?: string;
    async initialize(config: { defaultModelId?: string }) {
      this.defaultModelId = config.defaultModelId;
      this.isInitialized = true;
    }
    async generateCompletion() {
      return { choices: [{ message: { role: 'assistant', content: 'ollama' }, finishReason: 'stop' }], responseText: 'ollama' };
    }
    async *generateCompletionStream(modelId: string) {
      calls.streamed.push({ providerId: this.providerId, modelId });
      yield { isFinal: true, choices: [{ message: { role: 'assistant', content: 'Served by Ollama.' }, finishReason: 'stop' }] };
    }
    async generateEmbeddings() { return { embeddings: [] }; }
    async listAvailableModels() { return []; }
    async getModelInfo() { return undefined; }
    async checkHealth() { return { isHealthy: true }; }
    async shutdown() {}
  }
  return { OllamaProvider };
});

import { AgentOS } from '../AgentOS';
import { AgentOSResponseChunkType } from '../types/AgentOSResponse';
import { PROVIDER_DEFAULTS } from '../runtime/provider-defaults';
import { resolveModelOption } from '../model';
import type { IPersonaDefinition } from '../../cognition/substrate/personas/IPersonaDefinition';

/** A persona with no `defaultProviderId` and no `defaultModelId`. */
const persona: IPersonaDefinition = {
  id: 'no-model-persona', name: 'No Model', description: 'Names no provider and no model.',
  version: '1.0.0', baseSystemPrompt: 'You are a helpful assistant.',
};

describe('AgentOS.create() with only OPENROUTER_API_KEY set', () => {
  let booted: AgentOS | undefined;

  beforeEach(() => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-openrouter-key');
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

  it("serves a persona that names no model on OpenRouter's default model, the one a model-less API call uses", async () => {
    booted = await AgentOS.create({ turnPlanning: { enabled: false }, personas: [persona] } as any);
    const chunks: any[] = [];
    for await (const chunk of booted.processRequest({
      userId: 'user-1', sessionId: 's-default-provider', selectedPersonaId: persona.id, textInput: 'Say hello.',
    } as any)) {
      chunks.push(chunk);
    }

    const error = chunks.find((c) => c.type === AgentOSResponseChunkType.ERROR);
    expect(error, error ? `${error.code}: ${error.message}` : undefined).toBeUndefined();
    const text = chunks.filter((c) => c.type === AgentOSResponseChunkType.TEXT_DELTA).map((c) => c.textDelta).join('');
    expect(text).toContain('Served by the default provider.');
    expect(calls.streamed).toEqual([{ providerId: 'openrouter', modelId: 'openai/gpt-4o-mini' }]);
    // One default for OpenRouter: the GMI turn's model is the one generateText({ provider: 'openrouter' }) sends.
    expect(PROVIDER_DEFAULTS.openrouter?.text).toBe('openai/gpt-4o-mini');
    expect(resolveModelOption({ provider: 'openrouter' }, 'text')).toEqual({ providerId: 'openrouter', modelId: 'openai/gpt-4o-mini' });
  });
});

describe('AgentOS.create() given providers of its own', () => {
  let booted: AgentOS | undefined;

  beforeEach(() => {
    // No key in the environment: the factory's own provider list is the localhost Ollama entry alone.
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

  it('serves a persona that names no model on the default provider it was given, not on one the environment configures', async () => {
    booted = await AgentOS.create({
      modelProviderManagerConfig: { providers: [{ providerId: 'openrouter', enabled: true, isDefault: true, config: { apiKey: 'test-openrouter-key' } }] },
      turnPlanning: { enabled: false },
      personas: [persona],
    } as any);
    const chunks: any[] = [];
    for await (const chunk of booted.processRequest({
      userId: 'user-1', sessionId: 's-given-provider', selectedPersonaId: persona.id, textInput: 'Say hello.',
    } as any)) {
      chunks.push(chunk);
    }

    const error = chunks.find((c) => c.type === AgentOSResponseChunkType.ERROR);
    expect(error, error ? `${error.code}: ${error.message}` : undefined).toBeUndefined();
    expect(calls.streamed).toEqual([{ providerId: 'openrouter', modelId: 'openai/gpt-4o-mini' }]);
  });

  it('keeps a GMI default the host names', async () => {
    booted = await AgentOS.create({
      modelProviderManagerConfig: { providers: [{ providerId: 'openrouter', enabled: true, isDefault: true, config: { apiKey: 'test-openrouter-key' } }] },
      gmiManagerConfig: {
        defaultGMIBaseConfigDefaults: { defaultLlmProviderId: 'openrouter', defaultLlmModelId: 'anthropic/claude-haiku-4.5' },
      },
      turnPlanning: { enabled: false },
      personas: [persona],
    } as any);
    for await (const _chunk of booted.processRequest({
      userId: 'user-1', sessionId: 's-host-default', selectedPersonaId: persona.id, textInput: 'Say hello.',
    } as any)) { /* drain */ }

    expect(calls.streamed).toEqual([{ providerId: 'openrouter', modelId: 'anthropic/claude-haiku-4.5' }]);
  });

  it('keeps a GMI default the host names when it is the pair the factory took from the environment', async () => {
    // With no key set the factory's pair is Ollama's llama3.2; the host names that same pair on purpose, beside an
    // OpenRouter entry it marks default.
    booted = await AgentOS.create({
      modelProviderManagerConfig: {
        providers: [
          { providerId: 'openrouter', enabled: true, isDefault: true, config: { apiKey: 'test-openrouter-key' } },
          { providerId: 'ollama', enabled: true, config: { baseURL: 'http://localhost:11434' } },
        ],
      },
      gmiManagerConfig: {
        defaultGMIBaseConfigDefaults: { defaultLlmProviderId: 'ollama', defaultLlmModelId: 'llama3.2' },
      },
      turnPlanning: { enabled: false },
      personas: [persona],
    } as any);
    for await (const _chunk of booted.processRequest({
      userId: 'user-1', sessionId: 's-host-names-factory-pair', selectedPersonaId: persona.id, textInput: 'Say hello.',
    } as any)) { /* drain */ }

    expect(calls.streamed).toEqual([{ providerId: 'ollama', modelId: 'llama3.2' }]);
  });

  it("takes the default from the providers given when the host spreads a factory-built gmiManagerConfig", async () => {
    const { createAgentOSConfig } = await import('../../core/config/AgentOSConfig');
    const base = await createAgentOSConfig();
    booted = await AgentOS.create({
      modelProviderManagerConfig: { providers: [{ providerId: 'openrouter', enabled: true, isDefault: true, config: { apiKey: 'test-openrouter-key' } }] },
      gmiManagerConfig: { ...base.gmiManagerConfig, defaultGMIInactivityCleanupMinutes: 30 },
      turnPlanning: { enabled: false },
      personas: [persona],
    } as any);
    for await (const _chunk of booted.processRequest({
      userId: 'user-1', sessionId: 's-spread-factory-gmi', selectedPersonaId: persona.id, textInput: 'Say hello.',
    } as any)) { /* drain */ }

    expect(calls.streamed).toEqual([{ providerId: 'openrouter', modelId: 'openai/gpt-4o-mini' }]);
  });

  it('keeps a model the host sets in place on a factory-built config', async () => {
    const { createAgentOSConfig } = await import('../../core/config/AgentOSConfig');
    const base = await createAgentOSConfig();
    base.gmiManagerConfig.defaultGMIBaseConfigDefaults!.defaultLlmProviderId = 'openrouter';
    base.gmiManagerConfig.defaultGMIBaseConfigDefaults!.defaultLlmModelId = 'anthropic/claude-haiku-4.5';
    booted = await AgentOS.create({
      modelProviderManagerConfig: { providers: [{ providerId: 'openrouter', enabled: true, isDefault: true, config: { apiKey: 'test-openrouter-key' } }] },
      gmiManagerConfig: base.gmiManagerConfig,
      turnPlanning: { enabled: false },
      personas: [persona],
    } as any);
    for await (const _chunk of booted.processRequest({
      userId: 'user-1', sessionId: 's-edited-factory-gmi', selectedPersonaId: persona.id, textInput: 'Say hello.',
    } as any)) { /* drain */ }

    expect(calls.streamed).toEqual([{ providerId: 'openrouter', modelId: 'anthropic/claude-haiku-4.5' }]);
  });
});
