/**
 * @file AIModelProviderManager.catalog.test.ts
 * gemini and gemini-cli serve several of the same model ids. The manager's
 * catalog must keep a row per (provider, model), so a ModelRouter rule or
 * default that names the second-registered provider still finds its model,
 * while bare-id lookups keep resolving to the first-registered provider.
 *
 * Uses the real GeminiProvider (static catalog, no network) and the real
 * GeminiCLIProvider with its CLI bridge mocked as installed and logged in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridgeMocks = vi.hoisted(() => ({
  checkBinaryInstalled: vi.fn(),
  checkAuthenticated: vi.fn(),
  execute: vi.fn(),
  executeWithSystemPrompt: vi.fn(),
  stream: vi.fn(),
  streamWithSystemPrompt: vi.fn(),
}));

vi.mock('../implementations/GeminiCLIBridge', () => ({
  GeminiCLIBridge: vi.fn().mockImplementation(() => bridgeMocks),
}));

import { AIModelProviderManager } from '../AIModelProviderManager';
import { ModelRouter } from '../../routing/ModelRouter';

/** A model id both the gemini and gemini-cli catalogs list. */
const SHARED_ID = 'gemini-3.1-pro-preview';

async function managerWith(order: Array<'gemini' | 'gemini-cli'>): Promise<AIModelProviderManager> {
  const manager = new AIModelProviderManager();
  await manager.initialize({
    providers: order.map((providerId) => ({
      providerId,
      enabled: true,
      config: providerId === 'gemini' ? { apiKey: 'test-gemini-key' } : {},
    })),
  });
  return manager;
}

beforeEach(() => {
  vi.clearAllMocks();
  bridgeMocks.checkBinaryInstalled.mockResolvedValue({
    installed: true,
    binaryPath: '/usr/local/bin/gemini',
    version: '1.0.5',
  });
  bridgeMocks.checkAuthenticated.mockResolvedValue(true);
});

describe('AIModelProviderManager catalog with overlapping model ids', () => {
  it('lists a model once per provider that serves it', async () => {
    const manager = await managerWith(['gemini-cli', 'gemini']);
    const models = await manager.listAllAvailableModels();

    const shared = models.filter((m) => m.modelId === SHARED_ID).map((m) => m.providerId);
    expect(shared).toEqual(['gemini-cli', 'gemini']);
    const pairs = models.map((m) => `${m.providerId}/${m.modelId}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('keeps bare-id lookups on the first-registered provider', async () => {
    const manager = await managerWith(['gemini-cli', 'gemini']);

    expect(manager.getProviderForModel(SHARED_ID)?.providerId).toBe('gemini-cli');
    const models = await manager.listAllAvailableModels();
    expect(models.find((m) => m.modelId === SHARED_ID)?.providerId).toBe('gemini-cli');
  });

  it('routes a rule that names the later-registered provider', async () => {
    const manager = await managerWith(['gemini-cli', 'gemini']);
    const router = new ModelRouter();
    await router.initialize(
      {
        rules: [{ id: 'pro-api', conditions: {}, action: { providerId: 'gemini', modelId: SHARED_ID } }],
        defaultProviderId: 'gemini-cli',
        defaultModelId: 'gemini-2.5-flash-lite',
      },
      manager,
    );

    const result = await router.selectModel({ taskHint: 'analysis' });

    expect(result?.provider.providerId).toBe('gemini');
    expect(result?.modelId).toBe(SHARED_ID);
    expect(result?.metadata?.matchedRuleId).toBe('pro-api');
  });

  it('resolves a default that names the later-registered provider', async () => {
    const manager = await managerWith(['gemini-cli', 'gemini']);
    const router = new ModelRouter();
    await router.initialize(
      { rules: [], defaultProviderId: 'gemini', defaultModelId: 'gemini-2.5-flash-lite' },
      manager,
    );

    const result = await router.selectModel({ taskHint: 'analysis' });

    expect(result?.provider.providerId).toBe('gemini');
  });

  it('routes a rule naming gemini-cli when gemini registered first', async () => {
    const manager = await managerWith(['gemini', 'gemini-cli']);
    const router = new ModelRouter();
    await router.initialize(
      {
        rules: [{ id: 'pro-cli', conditions: {}, action: { providerId: 'gemini-cli', modelId: SHARED_ID } }],
        defaultProviderId: 'gemini',
        defaultModelId: 'gemini-2.5-flash-lite',
      },
      manager,
    );

    const result = await router.selectModel({ taskHint: 'analysis' });

    expect(result?.provider.providerId).toBe('gemini-cli');
  });
});
