/**
 * @file GMI.completion-gateway.test.ts
 * A GMI turn through the real completion gateway (`createCompletionGateway`):
 * its `resolve()` (a primary that cannot be set up, fallback legs that cannot
 * start, open circuits, the router's task hint) and its `stream()` (the
 * delivery boundary, the usage of failed attempts), the provider manager it
 * creates and the real prompt engine. Only the provider classes are stubbed, at
 * their module boundary (src/api/__tests__/helpers/stubProviders.ts); each case
 * scripts its providers under keys of its own, because provider managers are
 * cached by provider, key and base URL. GMI.gateway.test.ts covers the hop loop
 * over a scripted gateway.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('../../../api/__tests__/helpers/stubProviders')).stubProviderClass('openai') }));
vi.mock('../../../core/llm/providers/implementations/AnthropicProvider', async () => ({ AnthropicProvider: (await import('../../../api/__tests__/helpers/stubProviders')).stubProviderClass('anthropic') }));
import { createCompletionGateway } from '../../../api/runtime/completionGateway';
import { reply, script } from '../../../api/__tests__/helpers/stubProviders';
import { createConversationMessage, MessageRole } from '../../../core/conversation/ConversationMessage';
import type { IModelRouter, ModelRouteParams } from '../../../core/llm/routing/IModelRouter';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry';
import { GMIErrorCode } from '../../../core/utils/errors';
import { GMIInteractionType, GMIOutputChunkType, type GMIOutputChunk } from '../IGMI';
import { createScriptedGmi, runTurn, textTurn } from './helpers/scriptedGmi';

let n = 0;
const key = () => `k-gmi-gateway-${++n}`;
const of = (chunks: GMIOutputChunk[], type: GMIOutputChunkType) => chunks.filter((c) => c.type === type);
/** The bills of failed attempts a turn reported: each marked USAGE_UPDATE as [usage, metadata]. */
const failedBills = (chunks: GMIOutputChunk[]) =>
  of(chunks, GMIOutputChunkType.USAGE_UPDATE).filter((c) => c.metadata?.attemptFailed === true).map((c) => [c.content, c.metadata]);
const servedByPrimary = { attemptFailed: true, hop: 0, providerId: 'openai', modelId: 'scripted-model' };

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

  it('a primary with no credentials ends the turn with CONFIGURATION_ERROR and the configuration error\'s message', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const { gmi } = await createScriptedGmi({ gateway: createCompletionGateway({ fallbackProviders: [] }) });
    const { chunks } = await runTurn(gmi, textTurn('t1', 'Hi.'));
    const error = of(chunks, GMIOutputChunkType.ERROR)[0];
    expect(error?.errorDetails?.code).toBe(GMIErrorCode.CONFIGURATION_ERROR);
    expect(String(error?.content)).toContain('No API key for openai');
  });

  it('a fallback leg that cannot start is skipped: the failed primary moves on to the leg after it', async () => {
    const k = key(); const broken = key(); const healthy = key();
    const overloaded = Object.assign(new Error('overloaded'), { httpStatus: 529 });
    const primary = script('openai', k, { replies: [overloaded] });
    script('anthropic', broken, { initThrows: Object.assign(new Error('invalid x-api-key'), { httpStatus: 401 }) });
    const last = script('openai', healthy, { replies: [reply.text('From the last leg.')] });
    // Fallback legs take their credentials from the environment.
    vi.stubEnv('ANTHROPIC_API_KEY', broken);
    vi.stubEnv('OPENAI_API_KEY', healthy);
    const gateway = createCompletionGateway({
      apiKey: k,
      fallbackProviders: [{ provider: 'anthropic', model: 'claude-x' }, { provider: 'openai', model: 'stub-model' }],
    });
    const { gmi } = await createScriptedGmi({ gateway, persona: { defaultModelId: 'stub-model' } });
    const { chunks } = await runTurn(gmi, textTurn('t1', 'Hi.'));
    expect(of(chunks, GMIOutputChunkType.ERROR)).toEqual([]);
    expect(of(chunks, GMIOutputChunkType.STEP_FINISHED)[0].content).toMatchObject({ text: 'From the last leg.', providerId: 'openai', hop: 2 });
    expect([primary.seen.length, last.seen.length]).toEqual([1, 1]);
    const skipped = gmi.getReasoningTrace().entries.find((entry) => entry.message.includes("Provider 'anthropic' (hop 1) could not start"));
    expect(skipped).toBeDefined();
  });

  it('a primary whose circuit is open is skipped before any prompt is built or sent to it', async () => {
    const k = key(); const fb = key();
    const primary = script('anthropic', k, { replies: [reply.text('Should not run.')] });
    script('openai', fb, { replies: [reply.text('From the fallback.')] });
    vi.stubEnv('OPENAI_API_KEY', fb);
    // A rejected key opens the provider's circuit at once.
    globalLLMProviderHealth.recordFailure('anthropic', Object.assign(new Error('invalid x-api-key'), { httpStatus: 401 }));
    const { gmi, promptEngine } = await createScriptedGmi({
      gateway: createCompletionGateway({ apiKey: k, fallbackProviders: [{ provider: 'openai', model: 'stub-model' }] }),
      persona: { defaultProviderId: 'anthropic', defaultModelId: 'claude-x' },
    });
    const construct = vi.spyOn(promptEngine, 'constructPrompt');
    const { chunks } = await runTurn(gmi, textTurn('t1', 'Hi.'));
    expect(of(chunks, GMIOutputChunkType.STEP_FINISHED)[0].content).toMatchObject({ text: 'From the fallback.', providerId: 'openai', hop: 1 });
    expect(construct.mock.calls.map((call) => call[1].providerId)).toEqual(['openai']);
    expect(primary.seen).toHaveLength(0);
  });

  it('an attempt that fails before any content shows the GMI none of its chunks, only the bill it reported', async () => {
    const k = key(); const fb = key();
    const early = { promptTokens: 30, completionTokens: 0, totalTokens: 30 };
    // A usage chunk, then the provider fails: the chunk is buffered and dropped with the attempt.
    script('openai', k, { replies: [[{ id: 'stub', object: 'chat.completion.chunk', created: 0, modelId: 'stub-model', choices: [], usage: early }, Object.assign(new Error('overloaded'), { httpStatus: 529 })]] });
    script('anthropic', fb, { replies: [reply.text('From the fallback.')] });
    vi.stubEnv('ANTHROPIC_API_KEY', fb);
    const { gmi } = await createScriptedGmi({
      gateway: createCompletionGateway({ apiKey: k, fallbackProviders: [{ provider: 'anthropic', model: 'claude-x' }] }),
      persona: { defaultModelId: 'stub-model' },
    });
    const { chunks, output } = await runTurn(gmi, textTurn('t1', 'Hi.'));
    const usage = of(chunks, GMIOutputChunkType.USAGE_UPDATE);
    // The primary's usage chunk never reached the GMI as its own USAGE_UPDATE; it arrives once, as the failed attempt's bill.
    expect(usage.map((c) => [c.content, c.metadata?.attemptFailed === true])).toEqual([
      [early, true],
      [{ promptTokens: 12, completionTokens: 3, totalTokens: 15 }, false],
    ]);
    expect(of(chunks, GMIOutputChunkType.TEXT_DELTA).map((c) => c.content)).toEqual(['From the fallback.']);
    expect(output.usage).toMatchObject({ promptTokens: 42, completionTokens: 3, totalTokens: 45 });
  });

  it('a step that fails after output is still counted: the usage its provider error carries is reported and added to the turn', async () => {
    const k = key();
    const billed = { promptTokens: 12, completionTokens: 4, totalTokens: 16 };
    // A turn refused part-way: the provider throws, and the error reports what the request was billed.
    script('openai', k, { replies: [reply.textThenThrow('Sure, here', Object.assign(new Error('refused'), { details: { usage: billed } }))] });
    const { gmi } = await createScriptedGmi({ gateway: createCompletionGateway({ apiKey: k, fallbackProviders: [] }) });
    const { chunks, output } = await runTurn(gmi, textTurn('t1', 'Hi.'));
    expect(of(chunks, GMIOutputChunkType.TEXT_DELTA).map((c) => c.content)).toEqual(['Sure, here']);
    expect(of(chunks, GMIOutputChunkType.ERROR)[0]?.errorDetails?.code).toBe(GMIErrorCode.LLM_PROVIDER_ERROR);
    expect(of(chunks, GMIOutputChunkType.STEP_FINISHED)).toEqual([]);
    expect(failedBills(chunks)).toEqual([[billed, servedByPrimary]]);
    expect(output.usage).toMatchObject(billed);
  });

  it('a step that fails after output with an error that reports no usage counts what the step had reported', async () => {
    const k = key();
    const reported = { promptTokens: 7, completionTokens: 1, totalTokens: 8 };
    script('openai', k, {
      replies: [[
        { id: 'stub', object: 'chat.completion.chunk', created: 0, modelId: 'stub-model', choices: [], responseTextDelta: 'Sure', usage: reported },
        new Error('connection reset'),
      ]],
    });
    const { gmi } = await createScriptedGmi({ gateway: createCompletionGateway({ apiKey: k, fallbackProviders: [] }) });
    const { chunks, output } = await runTurn(gmi, textTurn('t1', 'Hi.'));
    expect(of(chunks, GMIOutputChunkType.ERROR)[0]?.errorDetails?.code).toBe(GMIErrorCode.LLM_PROVIDER_ERROR);
    expect(failedBills(chunks)).toEqual([[reported, servedByPrimary]]);
    expect(output.usage).toMatchObject(reported);
  });
});
