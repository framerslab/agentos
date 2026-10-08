/**
 * @file GMI.completion-gateway.test.ts
 * A GMI turn through the real completion gateway (`createCompletionGateway`):
 * its `resolve()` and `stream()`, the provider manager it creates and the real
 * prompt engine. Only the provider classes are stubbed, at their module
 * boundary (src/api/__tests__/helpers/stubProviders.ts); each case scripts its
 * providers under keys of its own, because provider managers are cached by
 * provider, key and base URL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('../../../api/__tests__/helpers/stubProviders')).stubProviderClass('openai') }));
vi.mock('../../../core/llm/providers/implementations/AnthropicProvider', async () => ({ AnthropicProvider: (await import('../../../api/__tests__/helpers/stubProviders')).stubProviderClass('anthropic') }));
import { createCompletionGateway } from '../../../api/runtime/completionGateway';
import { reply, script } from '../../../api/__tests__/helpers/stubProviders';
import { createConversationMessage, MessageRole } from '../../../core/conversation/ConversationMessage';
import type { IModelRouter, ModelRouteParams } from '../../../core/llm/routing/IModelRouter';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry';
import { GMIInteractionType } from '../IGMI';
import { createScriptedGmi, runTurn } from './helpers/scriptedGmi';

let n = 0;
const key = () => `k-gmi-gateway-${++n}`;

/** A router that picks nothing and records the task hint each route gave it. */
function recordingRouter() {
  const taskHints: string[] = [];
  const router = {
    routerId: 'recording',
    initialize: async () => undefined,
    selectModel: async (params: ModelRouteParams) => {
      taskHints.push(params.taskHint);
      return null;
    },
  } as unknown as IModelRouter;
  return { router, taskHints };
}

beforeEach(() => globalLLMProviderHealth.reset());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('GMI turn through the real completion gateway', () => {
  it("the router's task hint is the text of the user's message: the text parts of a multimodal one, not its serialised parts", async () => {
    const k = key(); script('openai', k, { replies: [reply.text('A cat.')] });
    const { router, taskHints } = recordingRouter();
    const { gmi } = await createScriptedGmi({ gateway: createCompletionGateway({ apiKey: k, fallbackProviders: [], router }) });
    await runTurn(gmi, {
      interactionId: 't1', userId: 'user-1', sessionId: 'session-1', type: GMIInteractionType.MULTIMODAL_CONTENT,
      content: [{ type: 'text', text: 'Describe this photo' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${'QUJD'.repeat(16)}` } }],
    });
    expect(taskHints).toEqual(['Describe this photo']);
  });

  it("a continuation that starts a route of its own is routed on the user's message, not on the continuation's internal text", async () => {
    const k = key(); script('openai', k, { replies: [reply.text('Found it.')] });
    const { router, taskHints } = recordingRouter();
    // A GMI built to continue a turn another instance started: it holds the history and no resolved hop.
    const { gmi } = await createScriptedGmi({ gateway: createCompletionGateway({ apiKey: k, fallbackProviders: [], router }) });
    gmi.hydrateConversationHistory([
      createConversationMessage(MessageRole.USER, 'Look up the release date.'),
      createConversationMessage(MessageRole.ASSISTANT, null, { tool_calls: [{ id: 'call_a', name: 'lookup', arguments: { q: 'release date' } }] }),
    ]);
    const output = await gmi.handleToolResults([{ toolCallId: 'call_a', toolName: 'lookup', output: { date: 'May 4' } }], 'user-1');
    expect(output.responseText).toBe('Found it.');
    expect(taskHints).toEqual(['Look up the release date.']);
  });
});
