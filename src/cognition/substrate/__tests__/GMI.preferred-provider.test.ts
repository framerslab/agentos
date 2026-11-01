/**
 * @file GMI.preferred-provider.test.ts
 * A turn's `options.preferredProviderId` (AgentOSInput.options) picks the
 * provider the turn's model call goes to, over the persona's and the config's
 * default, on the gateway route and on the provider manager path alike; a turn
 * that names none keeps the persona's provider. A tool result that continues the
 * turn keeps the turn's provider and model, and one a GMI takes for a turn it did
 * not run takes the provider and model the result names.
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

  /** A GMI without a gateway on OpenAI and Anthropic, whose provider manager serves each call from the provider it names. */
  async function twoProviderGmi(openaiReplies: ReturnType<typeof textReply>[], anthropicReplies: ReturnType<typeof textReply>[]) {
    const openai = scriptedProvider(openaiReplies, 'openai');
    const anthropic = scriptedProvider(anthropicReplies, 'anthropic');
    const providers = { openai: openai.provider, anthropic: anthropic.provider };
    const getModelInfo = vi.fn(async (modelId: string, providerId?: string) => ({
      modelId, providerId: providerId ?? 'openai', contextWindowSize: 128_000, capabilities: ['chat', 'tool_use'],
    }));
    const llmProviderManager = {
      getModelInfo,
      getProvider: vi.fn((providerId: string) => providers[providerId as keyof typeof providers]),
      getProviderForModel: vi.fn(() => openai.provider),
    } as unknown as AIModelProviderManager;
    const { gmi } = await createScriptedGmi({ provider: openai.provider, config: { llmProviderManager } });
    return { gmi, openai, anthropic, getModelInfo };
  }

  const lookupResult = { toolCallId: 'call_x', toolName: 'lookup', output: { ok: true } };

  it("keeps the turn's provider and model for a tool result that continues it, and a later turn that names none goes back to the persona's", async () => {
    const { gmi, openai, anthropic, getModelInfo } = await twoProviderGmi([textReply('From OpenAI.')], [textReply('Aye.'), textReply('Continued.')]);

    await runTurn(gmi, textTurn('t1', 'Hello?', { options: { preferredModelId: 'claude-sonnet-4-0', preferredProviderId: 'anthropic' } }));
    // the continuation's input names no provider or model
    const continued = await gmi.handleToolResults([lookupResult], 'user-1');
    await runTurn(gmi, textTurn('t2', 'Again?'));

    expect(continued.responseText).toBe('Continued.');
    expect(anthropic.received).toHaveLength(2);
    expect(openai.received).toHaveLength(1);
    expect(getModelInfo.mock.calls).toEqual([
      ['claude-sonnet-4-0', 'anthropic'],
      ['claude-sonnet-4-0', 'anthropic'],
      ['scripted-model', 'openai'],
    ]);
  });

  it('takes the provider and model a tool result names for a turn the GMI did not run', async () => {
    const { gmi, openai, anthropic, getModelInfo } = await twoProviderGmi([], [textReply('Continued.')]);

    const continued = await gmi.handleToolResults([lookupResult], 'user-1', undefined, {
      preferredModelId: 'claude-sonnet-4-0',
      preferredProviderId: 'anthropic',
    });

    expect(continued.responseText).toBe('Continued.');
    expect(anthropic.received).toHaveLength(1);
    expect(openai.received).toHaveLength(0);
    expect(getModelInfo.mock.calls).toEqual([['claude-sonnet-4-0', 'anthropic']]);
  });
});
