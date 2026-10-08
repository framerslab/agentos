/**
 * @file gatewayProviderManager.test.ts
 * A GMI on the completion gateway gets a GatewayProviderManager as its
 * `llmProviderManager`: the manager calls the GMI, the metaprompt executor and
 * LLMUtilityAI make are answered from the hop that serves the turn. A call
 * that names another provider finds nothing, which the caller reports.
 */
import { describe, expect, it, vi } from 'vitest';
import { GatewayProviderManager } from '../gatewayProviderManager.js';
import type { CompletionResolution } from '../completionGateway.js';
import { LLMUtilityAI } from '../../../cognition/nlp/ai_utilities/LLMUtilityAI.js';

function resolution(providerId: string, modelId: string, providerMembers: Record<string, unknown> = {}): CompletionResolution {
  const provider = { providerId, defaultModelId: modelId, isInitialized: true, ...providerMembers };
  return {
    providerId, modelId, hop: 0, maxContextTokens: 1000, capabilities: [], toolFormat: 'openai_functions', optionOverrides: {}, chain: [{ provider: providerId, model: modelId }],
    providerManager: {
      getProvider: (id: string) => (id === providerId ? provider : undefined),
      getModelInfo: async (m: string, p?: string) => ({ modelId: m, providerId: p ?? providerId, contextWindowSize: 1000, capabilities: [] }),
    } as never,
  };
}

describe('GatewayProviderManager', () => {
  it('throws a clear error before the GMI resolved a hop', () => {
    expect(() => new GatewayProviderManager().getProvider('openai')).toThrow(/no resolution yet/);
  });

  it('answers the four manager calls from the hop that serves the turn', async () => {
    const m = new GatewayProviderManager();
    m.setResolution(resolution('anthropic', 'claude-x'));
    expect(m.getProvider('anthropic')?.providerId).toBe('anthropic');
    expect(m.getProvider('openai')).toBeUndefined();
    expect(m.getDefaultProvider()?.providerId).toBe('anthropic');
    expect(m.getProviderForModel('claude-x')?.providerId).toBe('anthropic');
    expect(m.getProviderForModel('gpt-4o')).toBeUndefined();
    expect(await m.getModelInfo('claude-x')).toMatchObject({ providerId: 'anthropic', contextWindowSize: 1000 });
    m.setResolution(resolution('openai', 'gpt-4o'));
    expect(m.getDefaultProvider()?.providerId).toBe('openai');
  });

  it('serves LLMUtilityAI through asProviderManager(); after a move to another hop the same call finds nothing', async () => {
    const generateCompletion = vi.fn(async (modelId: string, _messages: unknown, _options: unknown) => ({
      choices: [{ index: 0, message: { role: 'assistant', content: `Summary from ${modelId}.` }, finishReason: 'stop' }],
    }));
    const m = new GatewayProviderManager();
    m.setResolution(resolution('anthropic', 'claude-x', { generateCompletion }));
    const utility = new LLMUtilityAI('gateway-utility');
    await utility.initialize({ llmProviderManager: m.asProviderManager(), defaultModelId: 'claude-x', defaultProviderId: 'anthropic' });

    await expect(utility.summarize('A long quarterly report.')).resolves.toBe('Summary from claude-x.');
    expect(generateCompletion).toHaveBeenCalledTimes(1);
    expect(generateCompletion.mock.calls[0][0]).toBe('claude-x');

    // The turn moved to the openai hop; the utility still names anthropic.
    m.setResolution(resolution('openai', 'gpt-4o', { generateCompletion }));
    await expect(utility.summarize('A long quarterly report.')).rejects.toThrow(/Provider 'anthropic' is not initialized/);
    expect(generateCompletion).toHaveBeenCalledTimes(1);
  });
});
