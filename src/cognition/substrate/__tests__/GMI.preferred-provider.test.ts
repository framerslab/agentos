/**
 * @file GMI.preferred-provider.test.ts
 * A turn's `options.preferredProviderId` (AgentOSInput.options) picks the
 * provider the turn's model call goes to, over the persona's and the config's
 * default, on the gateway route and on the provider manager path alike; a turn
 * that names none keeps the persona's provider.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AIModelProviderManager } from '../../../core/llm/providers/AIModelProviderManager';
import { toolFormatFor, type CompletionGateway, type CompletionRoute } from '../../../api/runtime/completionGateway';
import { createScriptedGmi, runTurn, scriptedProvider, textReply, textTurn } from './helpers/scriptedGmi';

/** A one-hop gateway that serves whatever provider the route names and records each route. */
function recordingGateway() {
  const routes: CompletionRoute[] = [];
  const gateway: CompletionGateway = {
    resolve: async (route, after) => {
      if (after) return null;
      routes.push(route);
      const providerId = route.providerId ?? 'unknown';
      const modelId = route.modelId ?? 'unknown-model';
      return {
        providerId, modelId, hop: 0, maxContextTokens: 128_000,
        capabilities: ['chat', 'tool_use'], toolFormat: toolFormatFor(providerId), optionOverrides: {},
        providerManager: {
          getProvider: () => ({ providerId, isInitialized: true }),
          getModelInfo: async () => ({ modelId, providerId, contextWindowSize: 128_000, capabilities: ['chat', 'tool_use'] }),
        } as never,
        chain: [{ provider: providerId, model: modelId }],
      };
    },
    stream: () => Object.assign((async function* () { yield* textReply('Aye.'); })(), { outcome: Promise.resolve({ kind: 'delivered' as const }) }),
  };
  return { gateway, routes };
}

describe('GMI turn provider selection', () => {
  it('routes the gateway call to the turn\'s preferred provider and model', async () => {
    const { gateway, routes } = recordingGateway();
    const { gmi } = await createScriptedGmi({ gateway, persona: { defaultProviderId: 'openai' } });

    await runTurn(gmi, textTurn('t1', 'Hello?', { options: { preferredModelId: 'claude-sonnet-4-0', preferredProviderId: 'anthropic' } }));

    expect(routes.map((route) => [route.providerId, route.modelId])).toEqual([['anthropic', 'claude-sonnet-4-0']]);
  });

  it('keeps the persona\'s provider when the turn names none', async () => {
    const { gateway, routes } = recordingGateway();
    const { gmi } = await createScriptedGmi({ gateway, persona: { defaultProviderId: 'openai' } });

    await runTurn(gmi, textTurn('t1', 'Hello?', { options: { preferredModelId: 'gpt-4o-mini' } }));

    expect(routes.map((route) => [route.providerId, route.modelId])).toEqual([['openai', 'gpt-4o-mini']]);
  });

  it('asks the provider manager for the preferred provider when no gateway is configured', async () => {
    const openai = scriptedProvider([textReply('wrong provider')], 'openai').provider;
    const anthropic = scriptedProvider([textReply('Aye.')], 'anthropic');
    const providers = { openai, anthropic: anthropic.provider };
    const getModelInfo = vi.fn(async (modelId: string, providerId?: string) => ({
      modelId, providerId: providerId ?? 'openai', contextWindowSize: 128_000, capabilities: ['chat', 'tool_use'],
    }));
    const llmProviderManager = {
      getModelInfo,
      getProvider: vi.fn((providerId: string) => providers[providerId as keyof typeof providers]),
      getProviderForModel: vi.fn(() => openai),
    } as unknown as AIModelProviderManager;
    const { gmi } = await createScriptedGmi({ provider: openai, config: { llmProviderManager } });

    const { chunks } = await runTurn(gmi, textTurn('t1', 'Hello?', { options: { preferredModelId: 'claude-sonnet-4-0', preferredProviderId: 'anthropic' } }));

    expect(getModelInfo).toHaveBeenCalledWith('claude-sonnet-4-0', 'anthropic');
    expect(anthropic.received).toHaveLength(1);
    expect(chunks.some((chunk) => chunk.content === 'Aye.')).toBe(true);
  });
});
