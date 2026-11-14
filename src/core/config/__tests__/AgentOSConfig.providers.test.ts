import axios, { type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentOSConfig } from '../AgentOSConfig.js';
import { AIModelProviderManager } from '../../llm/providers/AIModelProviderManager.js';
import { resolveModelOption } from '../../../api/model.js';

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
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input) => {
      if (input !== 'https://api.openai.com/v1/models') {
        throw new Error(`Unexpected fetch request: ${String(input)}`);
      }
      return Response.json({ data: [] });
    }));
    const adapter: AxiosAdapter = async (config) => {
      requests.push(config);
      return { data: { data: [], models: [] }, status: 200, statusText: 'OK', headers: {}, config };
    };
    axios.defaults.adapter = adapter;
  });

  afterEach(async () => {
    await manager.shutdown();
    axios.defaults.adapter = originalAdapter;
    vi.unstubAllGlobals();
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

  it.each(['openai', 'openrouter', 'requesty', 'minimax', 'ollama'])(
    'gives %s the default model a model-less API call to it resolves to',
    async (providerId) => {
      vi.stubEnv('REQUESTY_API_KEY', 'test-requesty-key');
      vi.stubEnv('MINIMAX_API_KEY', 'test-minimax-key');
      const config = await createAgentOSConfig();
      const entry = config.modelProviderManagerConfig.providers.find((p) => p.providerId === providerId);
      if (!entry) throw new Error(`Missing provider entry: ${providerId}`);
      expect((entry.config as { defaultModelId?: string }).defaultModelId).toBe(resolveModelOption({ provider: providerId }, 'text').modelId);
    },
  );

  it.each([
    ['OpenAI', { OPENAI_API_KEY: 'test-openai-key' }, 'openai', 'gpt-4o'],
    ['OpenRouter', { OPENAI_API_KEY: '' }, 'openrouter', 'openai/gpt-4o-mini'],
    ['Requesty', { OPENAI_API_KEY: '', OPENROUTER_API_KEY: '', REQUESTY_API_KEY: 'test-requesty-key' }, 'requesty', 'openai/gpt-4o'],
    ['Ollama', { OPENAI_API_KEY: '', OPENROUTER_API_KEY: '', MINIMAX_API_KEY: '' }, 'ollama', 'llama3.2'],
  ] as const)(
    "makes the default entry's provider and default model the GMI default when %s is the default provider",
    async (_name, env, providerId, modelId) => {
      vi.stubEnv('MINIMAX_API_KEY', '');
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      const config = await createAgentOSConfig();
      const defaultEntry = config.modelProviderManagerConfig.providers.find((p) => p.isDefault);
      expect(defaultEntry?.providerId).toBe(providerId);
      expect(config.gmiManagerConfig.defaultGMIBaseConfigDefaults).toEqual({
        defaultLlmProviderId: providerId,
        defaultLlmModelId: modelId,
      });
    },
  );

  it('makes MiniMax the manager default and the GMI default when its key is the only cloud key', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    vi.stubEnv('MINIMAX_API_KEY', 'test-minimax-key');
    const config = await createAgentOSConfig();
    expect(config.gmiManagerConfig.defaultGMIBaseConfigDefaults).toEqual({
      defaultLlmProviderId: 'minimax',
      defaultLlmModelId: 'MiniMax-M3.1-Flash',
    });
    await manager.initialize(config.modelProviderManagerConfig);
    const provider = manager.getDefaultProvider();
    expect(provider?.providerId).toBe('minimax');
    expect(provider?.defaultModelId).toBe('MiniMax-M3.1-Flash');
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
