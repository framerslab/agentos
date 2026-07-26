/**
 * @file modelRouter.test.ts
 * Tests for ModelRouter integration into generateText/streamText/agent.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';

const mockGenerateCompletion = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    choices: [{ message: { content: 'routed response', role: 'assistant' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }),
);

const mockGenerateCompletionStream = vi.hoisted(() =>
  vi.fn().mockImplementation(async function* () {
    yield {
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'streamed' },
          finishReason: 'stop',
        },
      ],
      responseTextDelta: 'streamed',
      isFinal: true,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };
  }),
);

const mockGetProvider = vi.hoisted(() =>
  vi.fn().mockReturnValue({
    generateCompletion: mockGenerateCompletion,
    generateCompletionStream: mockGenerateCompletionStream,
  }),
);

const mockResolveProvider = vi.hoisted(() =>
  vi.fn().mockReturnValue({ providerId: 'openai', modelId: 'gpt-4o' }),
);

vi.mock('../../model.js', () => ({
  resolveModelOption: vi.fn().mockReturnValue({ providerId: 'openai', modelId: 'gpt-4o' }),
  resolveProvider: mockResolveProvider,
  createProviderManager: vi.fn().mockResolvedValue({
    getProvider: mockGetProvider,
    getModelInfo: vi.fn().mockReturnValue(null),
  }),
}));

vi.mock('../../observability.js', () => ({
  attachUsageAttributes: vi.fn(),
  attachGenAiAttributes: vi.fn(),
  toTurnMetricUsage: vi.fn().mockReturnValue({}),
}));

// The provider-health circuit is module-global state: one test's intentional
// failure burst must not open the breaker for the rest of the file.
beforeEach(() => {
  globalLLMProviderHealth.reset();
});

vi.mock('../../../evaluation/observability/otel.js', () => ({
  withAgentOSSpan: vi.fn((_name: string, _attrs: unknown, fn?: Function) => {
    const callback = fn ?? _attrs;
    return typeof callback === 'function' ? (callback as Function)() : undefined;
  }),
  startAgentOSSpan: vi.fn().mockReturnValue({ end: vi.fn(), setAttribute: vi.fn() }),
  recordAgentOSTurnMetrics: vi.fn(),
}));

vi.mock('../usageLedger.js', () => ({
  recordAgentOSUsage: vi.fn().mockResolvedValue(undefined),
  getRecordedAgentOSUsage: vi.fn().mockResolvedValue({
    totalTokens: 0,
    totalCostUSD: 0,
    calls: 0,
  }),
}));

import { generateText } from '../../generateText.js';
import { streamText } from '../../streamText.js';
import type {
  IModelRouter,
  ModelRouteResult,
} from '../../../core/llm/routing/IModelRouter.js';

function createMockRouter(
  result: Partial<ModelRouteResult> | null,
): IModelRouter {
  return {
    routerId: 'test-router',
    initialize: vi.fn().mockResolvedValue(undefined),
    selectModel: vi.fn().mockResolvedValue(
      result
        ? {
            provider: {} as any,
            modelId: result.modelId ?? 'claude-sonnet-4-6',
            modelInfo: {
              providerId: result.modelInfo?.providerId ?? 'anthropic',
            } as any,
            reasoning: 'test routing',
            confidence: 0.9,
            ...result,
          }
        : null,
    ),
  };
}

describe('ModelRouter integration', () => {
  beforeEach(() => {
    mockGenerateCompletion.mockClear();
    mockGenerateCompletionStream.mockClear();
    mockGetProvider.mockClear();
    mockResolveProvider.mockClear();
    mockResolveProvider.mockReturnValue({
      providerId: 'openai',
      modelId: 'gpt-4o',
    });
  });

  it('overrides provider and model when router returns a result', async () => {
    const router = createMockRouter({
      modelId: 'claude-sonnet-4-6',
      modelInfo: { providerId: 'anthropic' } as any,
    });

    await generateText({ prompt: 'hello', router });

    expect(router.selectModel).toHaveBeenCalledOnce();
    expect(mockResolveProvider).toHaveBeenCalledWith(
      'anthropic',
      'claude-sonnet-4-6',
      expect.any(Object),
    );
  });

  it('falls back to standard resolution when router returns null', async () => {
    const router = createMockRouter(null);

    await generateText({ prompt: 'hello', router });

    expect(router.selectModel).toHaveBeenCalledOnce();
    expect(mockResolveProvider).toHaveBeenCalledWith(
      'openai',
      'gpt-4o',
      expect.any(Object),
    );
  });

  it('passes routerParams to selectModel', async () => {
    const router = createMockRouter(null);

    await generateText({
      prompt: 'hello',
      router,
      routerParams: {
        taskHint: 'code generation',
        optimizationPreference: 'quality',
      },
    });

    expect(router.selectModel).toHaveBeenCalledWith(
      expect.objectContaining({
        taskHint: 'code generation',
        optimizationPreference: 'quality',
      }),
      undefined,
    );
  });

  it('threads hostPolicy hints into router selection', async () => {
    const router = createMockRouter(null);

    await generateText({
      prompt: 'hello',
      router,
      hostPolicy: {
        optimizationPreference: 'cost',
        requiredCapabilities: ['json_mode'],
        allowedProviders: ['anthropic'],
        policyTier: 'mature',
      },
    });

    expect(router.selectModel).toHaveBeenCalledWith(
      expect.objectContaining({
        optimizationPreference: 'cost',
        requiredCapabilities: ['json_mode'],
        preferredProviderIds: ['anthropic'],
        policyTier: 'mature',
      }),
      undefined,
    );
  });

  it('auto-extracts taskHint from system prompt when routerParams not provided', async () => {
    const router = createMockRouter(null);

    await generateText({
      prompt: 'hello',
      system: 'You are a code assistant',
      router,
    });

    expect(router.selectModel).toHaveBeenCalledWith(
      expect.objectContaining({
        taskHint: 'You are a code assistant',
      }),
      undefined,
    );
  });

  it('falls back gracefully when router throws', async () => {
    const router: IModelRouter = {
      routerId: 'broken-router',
      initialize: vi.fn(),
      selectModel: vi.fn().mockRejectedValue(new Error('router failure')),
    };

    const result = await generateText({ prompt: 'hello', router });

    expect(result.text).toBe('routed response');
    expect(mockResolveProvider).toHaveBeenCalledWith(
      'openai',
      'gpt-4o',
      expect.any(Object),
    );
  });

  it('works with streamText — router is called', async () => {
    const router = createMockRouter({
      modelId: 'claude-sonnet-4-6',
      modelInfo: { providerId: 'anthropic' } as any,
    });

    // Start the stream — this triggers router resolution synchronously
    const result = streamText({ prompt: 'hello', router });

    // Consume the stream to trigger execution
    const chunks: string[] = [];
    for await (const chunk of result.textStream) {
      chunks.push(chunk);
    }

    expect(router.selectModel).toHaveBeenCalledOnce();
    expect(chunks.length).toBeGreaterThan(0);
  });
});
