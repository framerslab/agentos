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
import type { ModelCompletionResponse } from '../../../core/llm/providers/IProvider';
import { createScriptedGmi, runTurn, scriptedProvider, textReply, textTurn, toolCallReply } from './helpers/scriptedGmi';

/** A one-hop gateway that serves whatever provider the route names and records each route. */
function recordingGateway(replies?: ModelCompletionResponse[][]) {
  const routes: CompletionRoute[] = [];
  /** The provider of the hop that served each model call. */
  const served: string[] = [];
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
    stream: (resolution) => {
      served.push(resolution.providerId);
      const reply = replies ? replies.shift() : textReply('Aye.');
      if (!reply) throw new Error('unexpected model call');
      return Object.assign((async function* () { yield* reply; })(), { outcome: Promise.resolve({ kind: 'delivered' as const }) });
    },
  };
  return { gateway, routes, served };
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

  it('resolves the gateway route again for a tool result that names another provider and model than its turn, and keeps the hop for one that names the same', async () => {
    const { gateway, routes } = recordingGateway();
    const { gmi } = await createScriptedGmi({ gateway, persona: { defaultProviderId: 'openai', defaultModelId: 'gpt-4o-mini' } });
    const anthropic = { preferredModelId: 'claude-sonnet-4-0', preferredProviderId: 'anthropic' };

    await runTurn(gmi, textTurn('t1', 'Hello?'));
    await gmi.handleToolResults([lookupResult], 'user-1', undefined, anthropic);
    await gmi.handleToolResults([{ ...lookupResult, toolCallId: 'call_y' }], 'user-1', undefined, anthropic);

    expect(routes.map((route) => [route.providerId, route.modelId])).toEqual([
      ['openai', 'gpt-4o-mini'],
      ['anthropic', 'claude-sonnet-4-0'],
    ]);
  });

  it("keeps each stream on its own hop when a continuation that names another provider runs while its turn's stream goes on", async () => {
    // the turn's first step asks for lookup; while the GMI runs it, a tool result that names Anthropic continues the turn
    const { gateway, served } = recordingGateway([
      toolCallReply([{ id: 'call_a', name: 'lookup', args: { q: 'a' } }]),
      textReply('From Anthropic.'),
      textReply('From OpenAI.'),
      textReply('Anthropic again.'),
    ]);
    const { gmi, processToolCall } = await createScriptedGmi({ gateway, persona: { defaultProviderId: 'openai', defaultModelId: 'gpt-4o-mini' } });
    const anthropic = { preferredModelId: 'claude-sonnet-4-0', preferredProviderId: 'anthropic' };
    let overlapping: string | null | undefined;
    processToolCall.mockImplementationOnce(async ({ toolCallRequest }) => {
      overlapping = (await gmi.handleToolResults([lookupResult], 'user-1', undefined, anthropic)).responseText;
      return { toolCallId: toolCallRequest.id, toolName: toolCallRequest.name, output: { ok: true } };
    });

    await runTurn(gmi, textTurn('t1', 'Hello?'));
    // a later tool result that names neither keeps the route the newest continuation chose, and its hop
    const later = await gmi.handleToolResults([{ ...lookupResult, toolCallId: 'call_y' }], 'user-1');

    expect(overlapping).toBe('From Anthropic.');
    expect(later.responseText).toBe('Anthropic again.');
    expect(served).toEqual(['openai', 'anthropic', 'openai', 'anthropic']);
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
