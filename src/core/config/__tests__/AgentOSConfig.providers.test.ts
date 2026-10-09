import axios, { type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentOSConfig } from '../AgentOSConfig.js';
import { AIModelProviderManager } from '../../llm/providers/AIModelProviderManager.js';

describe('createAgentOSConfig provider defaults', () => {
  let originalAdapter: typeof axios.defaults.adapter;
  let requests: InternalAxiosRequestConfig[];
  let manager: AIModelProviderManager;

  beforeEach(() => {
    vi.stubEnv('DATABASE_URL', 'file:./provider-config-test.sqlite');
    vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-openrouter-key');
    vi.stubEnv('REQUESTY_API_KEY', '');
    vi.stubEnv('OLLAMA_BASE_URL', 'http://localhost:11434');
    vi.stubEnv('ENABLE_UTILITY_AI', 'false');
    originalAdapter = axios.defaults.adapter;
    requests = [];
    manager = new AIModelProviderManager();
    // Exercise provider initialization without contacting a model service.
    const adapter: AxiosAdapter = async (config) => {
      requests.push(config);
      return { data: { data: [], models: [] }, status: 200, statusText: 'OK', headers: {}, config };
    };
    axios.defaults.adapter = adapter;
  });

  afterEach(async () => {
    await manager.shutdown();
    axios.defaults.adapter = originalAdapter;
    vi.unstubAllEnvs();
  });

  it.each([
    ['openai', 'gpt-4o'],
    ['openrouter', 'openai/gpt-4o-mini'],
    ['ollama', 'llama3.2'],
  ] as const)('passes the configured default model to %s', async (providerId, modelId) => {
    const config = await createAgentOSConfig();
    await manager.initialize(config.modelProviderManagerConfig);
    const provider = manager.getProvider(providerId);
    if (!provider) throw new Error(`Missing provider: ${providerId}`);
    expect(provider.defaultModelId).toBe(modelId);
  });

  it('uses the longer local-model timeout for Ollama requests', async () => {
    const config = await createAgentOSConfig();
    await manager.initialize(config.modelProviderManagerConfig);
    const provider = manager.getProvider('ollama');
    if (!provider) throw new Error('Missing Ollama provider');
    await provider.listAvailableModels();
    expect(requests.find((request) => request.url === '/tags')?.timeout).toBe(120000);
  });
});
