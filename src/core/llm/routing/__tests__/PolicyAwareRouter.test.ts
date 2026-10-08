import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PolicyAwareRouter } from '../PolicyAwareRouter';
import { createUncensoredModelCatalog } from '../UncensoredModelCatalog';
import type { UncensoredModelCatalog } from '../UncensoredModelCatalog';
import type { IModelRouter, ModelRouteParams, ModelRouteResult } from '../IModelRouter';

/** Minimal mock base router that returns a predictable result. */
function createMockBaseRouter(result: ModelRouteResult | null = null): IModelRouter {
  return {
    routerId: 'mock_base_router',
    initialize: vi.fn().mockResolvedValue(undefined),
    selectModel: vi.fn().mockResolvedValue(result),
  };
}

/** Convenience: build a minimal ModelRouteResult for mock returns. */
function mockResult(modelId: string): ModelRouteResult {
  return {
    provider: { providerId: 'mock', isInitialized: true } as any,
    modelId,
    modelInfo: { modelId, providerId: 'mock', capabilities: ['chat'] },
    reasoning: 'mock selection',
    confidence: 0.9,
  };
}

describe('PolicyAwareRouter', () => {
  let catalog: UncensoredModelCatalog;

  beforeEach(() => {
    catalog = createUncensoredModelCatalog();
  });

  // -------------------------------------------------------------------------
  // Safe / standard / absent tier
  // -------------------------------------------------------------------------

  it('returns null for safe tier when no base router', async () => {
    const router = new PolicyAwareRouter(catalog);
    const result = await router.selectModel({ taskHint: 'chat', policyTier: 'safe' });
    expect(result).toBeNull();
  });

  it('returns null for standard tier when no base router', async () => {
    const router = new PolicyAwareRouter(catalog);
    const result = await router.selectModel({ taskHint: 'chat', policyTier: 'standard' });
    expect(result).toBeNull();
  });

  it('returns null when policyTier is absent and no defaultPolicyTier', async () => {
    const router = new PolicyAwareRouter(catalog);
    const result = await router.selectModel({ taskHint: 'chat' });
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Mature / private-adult tiers
  // -------------------------------------------------------------------------

  it('returns OpenRouter model for private-adult tier', async () => {
    const router = new PolicyAwareRouter(catalog);
    const result = await router.selectModel({
      taskHint: 'companion_chat',
      policyTier: 'private-adult',
    });
    expect(result).not.toBeNull();
    expect(result!.modelInfo.providerId).toBe('openrouter');
    expect(result!.modelId).toContain('/');
    expect(result!.metadata?.policyRouted).toBe(true);
  });

  it('returns OpenRouter model for mature tier', async () => {
    const router = new PolicyAwareRouter(catalog);
    const result = await router.selectModel({
      taskHint: 'narration',
      policyTier: 'mature',
    });
    expect(result).not.toBeNull();
    expect(result!.modelInfo.providerId).toBe('openrouter');
  });

  it('respects contentIntent filter', async () => {
    const router = new PolicyAwareRouter(catalog);
    const result = await router.selectModel({
      taskHint: 'narration',
      policyTier: 'private-adult',
      contentIntent: 'horror',
    });
    expect(result).not.toBeNull();
    // The catalog entry for horror should not include toppy-m-7b
    expect(result!.modelId).not.toBe('undi95/toppy-m-7b');
  });

  // -------------------------------------------------------------------------
  // Base router delegation
  // -------------------------------------------------------------------------

  it('delegates to baseRouter for safe tier', async () => {
    const baseResult = mockResult('gpt-4o');
    const baseRouter = createMockBaseRouter(baseResult);
    const router = new PolicyAwareRouter(catalog, baseRouter);

    const params: ModelRouteParams = { taskHint: 'chat', policyTier: 'safe' };
    const result = await router.selectModel(params);

    expect(result).toBe(baseResult);
    expect(baseRouter.selectModel).toHaveBeenCalledWith(params, undefined);
  });

  it('delegates to baseRouter for standard tier', async () => {
    const baseResult = mockResult('claude-3-sonnet');
    const baseRouter = createMockBaseRouter(baseResult);
    const router = new PolicyAwareRouter(catalog, baseRouter);

    const result = await router.selectModel({
      taskHint: 'chat',
      policyTier: 'standard',
    });
    expect(result).toBe(baseResult);
  });

  it('does NOT delegate to baseRouter for private-adult tier', async () => {
    const baseRouter = createMockBaseRouter(mockResult('gpt-4o'));
    const router = new PolicyAwareRouter(catalog, baseRouter);

    const result = await router.selectModel({
      taskHint: 'chat',
      policyTier: 'private-adult',
    });
    expect(result).not.toBeNull();
    expect(result!.modelInfo.providerId).toBe('openrouter');
    expect(baseRouter.selectModel).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Overrides
  // -------------------------------------------------------------------------

  it('uses override model when provided for the tier', async () => {
    const router = new PolicyAwareRouter(catalog, null, {
      'private-adult': 'custom/my-uncensored-model',
    });

    const result = await router.selectModel({
      taskHint: 'chat',
      policyTier: 'private-adult',
    });
    expect(result).not.toBeNull();
    expect(result!.modelId).toBe('custom/my-uncensored-model');
    expect(result!.reasoning).toContain('Override');
  });

  it('falls through to catalog when override not set for the tier', async () => {
    const router = new PolicyAwareRouter(catalog, null, {
      'mature': 'custom/mature-model',
    });

    // private-adult has no override, should use catalog
    const result = await router.selectModel({
      taskHint: 'chat',
      policyTier: 'private-adult',
    });
    expect(result).not.toBeNull();
    expect(result!.modelId).not.toBe('custom/mature-model');
  });

  // -------------------------------------------------------------------------
  // defaultPolicyTier
  // -------------------------------------------------------------------------

  it('uses defaultPolicyTier when params.policyTier is absent', async () => {
    const router = new PolicyAwareRouter(catalog, null, {}, 'private-adult');

    const result = await router.selectModel({ taskHint: 'chat' });
    expect(result).not.toBeNull();
    expect(result!.modelInfo.providerId).toBe('openrouter');
    expect(result!.metadata?.policyRouted).toBe(true);
  });

  it('params.policyTier overrides defaultPolicyTier', async () => {
    const router = new PolicyAwareRouter(catalog, null, {}, 'private-adult');

    const result = await router.selectModel({
      taskHint: 'chat',
      policyTier: 'safe',
    });
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  it('initialize is a no-op (does not throw)', async () => {
    const router = new PolicyAwareRouter(catalog);
    await expect(router.initialize({}, null)).resolves.toBeUndefined();
  });

  it('exposes routerId', () => {
    const router = new PolicyAwareRouter(catalog);
    expect(router.routerId).toBe('policy_aware_router_v1');
  });
});

describe('PolicyAwareRouter.policyTier', () => {
  const catalog = createUncensoredModelCatalog();

  it('exposes the router default tier', () => {
    expect(new PolicyAwareRouter(catalog, null, {}, 'mature').policyTier).toBe('mature');
    expect(new PolicyAwareRouter(catalog).policyTier).toBeUndefined();
  });

  it('falls back to the base router tier when it has none of its own', () => {
    const base = new PolicyAwareRouter(catalog, null, {}, 'private-adult');
    expect(new PolicyAwareRouter(catalog, base).policyTier).toBe('private-adult');
    expect(new PolicyAwareRouter(catalog, base, {}, 'mature').policyTier).toBe('mature');
  });

  it('reports the tier its selection applies: a safe or standard default hands the request to the base unchanged', async () => {
    const matureBase = new PolicyAwareRouter(catalog, null, {}, 'mature');
    const standardOverMature = new PolicyAwareRouter(catalog, matureBase, {}, 'standard');
    // The wrapper delegates a request that carries no tier, so the base's
    // mature default picks the model, and the getter says so.
    const picked = await standardOverMature.selectModel({ taskHint: 'chat' });
    expect(picked?.modelId).toBe('meta-llama/llama-3.3-70b-instruct');
    expect(standardOverMature.policyTier).toBe('mature');
    expect(new PolicyAwareRouter(catalog, matureBase, {}, 'safe').policyTier).toBe('mature');
    // With no base default, the wrapper's own safe/standard default stands.
    expect(new PolicyAwareRouter(catalog, null, {}, 'standard').policyTier).toBe('standard');
    expect(new PolicyAwareRouter(catalog, new PolicyAwareRouter(catalog), {}, 'safe').policyTier).toBe('safe');
  });
});
