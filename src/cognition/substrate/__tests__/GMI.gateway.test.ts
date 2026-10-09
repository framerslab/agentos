/**
 * @file GMI.gateway.test.ts
 * A GMI turn through a completion gateway: the hop is resolved before the
 * prompt is built, a failure before any output rebuilds the prompt for the
 * next hop (and runs beforeModelCall on it again), a turn stays on the hop
 * that served its last step and the next user turn starts at the primary,
 * the error codes of the chain's ends, no fallback after output, the schema
 * answer on STEP_FINISHED, and the usage a failed attempt was billed.
 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { GMIOutputChunkType, type GMIOutputChunk } from '../IGMI';
import { GMIErrorCode } from '../../../core/utils/errors';
import type { ChatMessage, ModelCompletionOptions, ModelCompletionResponse, ModelUsage } from '../../../core/llm/providers/IProvider';
import { toolFormatFor, type CompletionGateway, type CompletionOutcome, type CompletionResolution } from '../../../api/runtime/completionGateway';
import { createScriptedGmi, runTurn, textReply, textTurn, toolCallReply } from './helpers/scriptedGmi';

type Attempt = { hop: number; chunks: ModelCompletionResponse[] } | { hop: number; fails: Error; retryable?: boolean; usage?: ModelUsage };

/** A gateway whose hops and attempts are scripted; records what the GMI asked of it. */
function fakeGateway(hops: Array<{ providerId: string; window: number }>, attempts: Attempt[]) {
  const streamed: Array<{ hop: number; providerId: string; messages: ChatMessage[]; options: ModelCompletionOptions; schema?: unknown }> = [];
  const resolveCalls: Array<number | null> = [];
  const queue = [...attempts];
  const resolution = (hop: number): CompletionResolution => ({
    providerId: hops[hop].providerId, modelId: `${hops[hop].providerId}-model`, hop, maxContextTokens: hops[hop].window,
    capabilities: ['chat', 'tool_use'], toolFormat: toolFormatFor(hops[hop].providerId), optionOverrides: {},
    providerManager: {
      getProvider: () => ({ providerId: hops[hop].providerId, isInitialized: true }),
      getModelInfo: async () => ({ modelId: `${hops[hop].providerId}-model`, providerId: hops[hop].providerId, contextWindowSize: hops[hop].window, capabilities: ['chat', 'tool_use'] }),
    } as never,
    chain: hops.map((h) => ({ provider: h.providerId, model: `${h.providerId}-model` })),
  });
  const gateway: CompletionGateway = {
    resolve: async (_route, after) => {
      resolveCalls.push(after ? after.hop : null);
      const hop = after ? after.hop + 1 : 0;
      return hop < hops.length ? resolution(hop) : null;
    },
    stream: (res, messages, options, schema) => {
      const next = queue.shift();
      if (!next) throw new Error('unexpected model call');
      expect(next.hop).toBe(res.hop);
      streamed.push({ hop: res.hop, providerId: res.providerId, messages: JSON.parse(JSON.stringify(messages)), options, schema });
      const outcome = Promise.resolve<CompletionOutcome>('fails' in next
        ? { kind: 'hopFailed', error: next.fails, retryable: next.retryable ?? true, ...(next.usage ? { usage: next.usage } : {}) }
        : { kind: 'delivered' });
      const chunks = 'fails' in next ? [] : next.chunks;
      return Object.assign((async function* () { yield* chunks; })(), { outcome });
    },
  };
  return { gateway, streamed, resolveCalls };
}

const of = (chunks: GMIOutputChunk[], type: GMIOutputChunkType) => chunks.filter((c) => c.type === type);
const two = [{ providerId: 'openai', window: 128_000 }, { providerId: 'anthropic', window: 200_000 }];

describe('GMI turn through the completion gateway', () => {
  it('a retryable failure before output rebuilds the prompt for the next hop, which serves the step', async () => {
    const { gateway, streamed, resolveCalls } = fakeGateway(two, [{ hop: 0, fails: Object.assign(new Error('overloaded'), { httpStatus: 529 }) }, { hop: 1, chunks: textReply('Aye.') }]);
    const { gmi, promptEngine } = await createScriptedGmi({ gateway });
    const construct = vi.spyOn(promptEngine, 'constructPrompt');
    const { chunks } = await runTurn(gmi, textTurn('t1', 'Hello?'));
    expect(construct.mock.calls.map((call) => call[1].maxContextTokens)).toEqual([128_000, 200_000]);
    expect(streamed.map((s) => s.providerId)).toEqual(['openai', 'anthropic']);
    expect(resolveCalls).toEqual([null, 0]);
    expect(of(chunks, GMIOutputChunkType.TEXT_DELTA).map((c) => c.content)).toEqual(['Aye.']);
    expect(of(chunks, GMIOutputChunkType.STEP_FINISHED)[0].content).toMatchObject({ stepIndex: 0, text: 'Aye.', providerId: 'anthropic', modelId: 'anthropic-model', hop: 1, finishReason: 'stop' });
  });

  it('beforeModelCall runs on every attempt, a fallback hop rebuilt prompt included, and the prompt it returns is the one streamed', async () => {
    const { gateway, streamed } = fakeGateway(two, [{ hop: 0, fails: Object.assign(new Error('overloaded'), { httpStatus: 529 }) }, { hop: 1, chunks: textReply('Aye.') }]);
    const calls: Array<[number, number, string, string]> = [];
    const { gmi } = await createScriptedGmi({
      gateway,
      config: {
        beforeModelCall: ({ stepIndex, hop, providerId, modelId, messages }) => {
          calls.push([stepIndex, hop, providerId, modelId]);
          return [...messages, { role: 'system', content: `hop ${hop}` }];
        },
      },
    });
    await runTurn(gmi, textTurn('t1', 'Hello?'));
    expect(calls).toEqual([[0, 0, 'openai', 'openai-model'], [0, 1, 'anthropic', 'anthropic-model']]);
    expect(streamed.map((s) => s.messages.at(-1))).toEqual([{ role: 'system', content: 'hop 0' }, { role: 'system', content: 'hop 1' }]);
    expect(JSON.stringify(streamed[1].messages)).not.toContain('hop 0');
  });

  it('the next step of the turn stays on the serving hop; the next user turn starts at the primary', async () => {
    const { gateway, streamed, resolveCalls } = fakeGateway(two, [
      { hop: 0, fails: new Error('503 unavailable') },
      { hop: 1, chunks: toolCallReply([{ id: 'call_a', name: 'lookup', args: { q: 'a' } }]) },
      { hop: 1, chunks: textReply('Done.') },
      { hop: 0, chunks: textReply('Fresh.') },
    ]);
    const { gmi } = await createScriptedGmi({ gateway });
    await runTurn(gmi, textTurn('t1', 'Look it up.'));
    await runTurn(gmi, textTurn('t2', 'Next.'));
    expect(streamed.map((s) => s.hop)).toEqual([0, 1, 1, 0]);
    expect(resolveCalls).toEqual([null, 0, null]);
  });

  it('a non-retryable failure ends the turn with LLM_PROVIDER_ERROR and no fallback', async () => {
    const { gateway, resolveCalls } = fakeGateway(two, [{ hop: 0, fails: new Error('400 bad request'), retryable: false }]);
    const { gmi } = await createScriptedGmi({ gateway });
    const { chunks } = await runTurn(gmi, textTurn('t1', 'Hi.'));
    expect(of(chunks, GMIOutputChunkType.ERROR)[0]?.errorDetails?.code).toBe(GMIErrorCode.LLM_PROVIDER_ERROR);
    expect(resolveCalls).toEqual([null]);
  });

  it('an exhausted chain ends the turn with LLM_PROVIDER_ERROR naming the last failure', async () => {
    const { gateway } = fakeGateway([two[0]], [{ hop: 0, fails: new Error('overloaded') }]);
    const { gmi } = await createScriptedGmi({ gateway });
    const { chunks } = await runTurn(gmi, textTurn('t1', 'Hi.'));
    const error = of(chunks, GMIOutputChunkType.ERROR)[0];
    expect(error?.errorDetails?.code).toBe(GMIErrorCode.LLM_PROVIDER_ERROR);
    expect(String(error?.content)).toContain('overloaded');
  });

  it('no resolvable hop ends the turn with LLM_PROVIDER_UNAVAILABLE', async () => {
    const { gateway } = fakeGateway([], []);
    const { gmi } = await createScriptedGmi({ gateway });
    const { chunks } = await runTurn(gmi, textTurn('t1', 'Hi.'));
    expect(of(chunks, GMIOutputChunkType.ERROR)[0]?.errorDetails?.code).toBe(GMIErrorCode.LLM_PROVIDER_UNAVAILABLE);
  });

  it('an error after output ends the step with LLM_PROVIDER_ERROR and no second hop', async () => {
    const { gateway, resolveCalls } = fakeGateway(two, [{ hop: 0, chunks: [{ responseTextDelta: 'Partial' }, { isFinal: true, choices: [], error: { message: 'connection reset', details: { terminal: true } } }] as never }]);
    const { gmi } = await createScriptedGmi({ gateway });
    const { chunks } = await runTurn(gmi, textTurn('t1', 'Hi.'));
    expect(of(chunks, GMIOutputChunkType.TEXT_DELTA).map((c) => c.content)).toEqual(['Partial']);
    expect(of(chunks, GMIOutputChunkType.ERROR)[0]?.errorDetails?.code).toBe(GMIErrorCode.LLM_PROVIDER_ERROR);
    expect(resolveCalls).toEqual([null]);
  });

  it('passes the turn schema to the gateway and copies the structured answer onto STEP_FINISHED', async () => {
    const schema = z.object({ city: z.string() });
    const { gateway, streamed } = fakeGateway(two, [{ hop: 0, chunks: [{ isFinal: true, choices: [{ index: 0, message: { role: 'assistant', content: null }, finishReason: 'tool_use' }], structuredOutput: { city: 'Lyon' } }] as never }]);
    const { gmi } = await createScriptedGmi({ gateway });
    const { chunks } = await runTurn(gmi, textTurn('t1', 'Where?', { options: { responseSchema: schema, schemaName: 'answer' } } as never));
    expect(streamed[0].schema).toBe(schema);
    expect(of(chunks, GMIOutputChunkType.STEP_FINISHED)[0].content).toMatchObject({ structuredOutput: { city: 'Lyon' } });
    expect(of(chunks, GMIOutputChunkType.TOOL_CALL_REQUEST)).toEqual([]);
    expect(streamed[0].options).not.toHaveProperty('responseSchema');
  });

  it('a failed attempt the provider billed counts toward the turn and is reported on its own USAGE_UPDATE', async () => {
    const billed = { promptTokens: 40, completionTokens: 0, totalTokens: 40 };
    const { gateway } = fakeGateway(two, [{ hop: 0, fails: Object.assign(new Error('overloaded'), { httpStatus: 529 }), usage: billed }, { hop: 1, chunks: textReply('Aye.') }]);
    const { gmi } = await createScriptedGmi({ gateway });
    const { chunks, output } = await runTurn(gmi, textTurn('t1', 'Hello?'));
    const usageChunks = of(chunks, GMIOutputChunkType.USAGE_UPDATE);
    expect(usageChunks.filter((c) => c.metadata?.attemptFailed === true).map((c) => [c.content, c.metadata])).toEqual([
      [billed, { attemptFailed: true, hop: 0, providerId: 'openai', modelId: 'openai-model' }],
    ]);
    expect(usageChunks.findIndex((c) => c.metadata?.attemptFailed === true)).toBe(0);
    expect(of(chunks, GMIOutputChunkType.STEP_FINISHED)[0].content.usage).toEqual({ promptTokens: 10, completionTokens: 3, totalTokens: 13 });
    expect(output.usage).toMatchObject({ promptTokens: 50, completionTokens: 3, totalTokens: 53 });
  });

  it('a billed failure that ends the turn still counts in the returned usage', async () => {
    const billed = { promptTokens: 40, completionTokens: 0, totalTokens: 40 };
    const { gateway } = fakeGateway(two, [{ hop: 0, fails: new Error('400 bad request'), retryable: false, usage: billed }]);
    const { gmi } = await createScriptedGmi({ gateway });
    const { chunks, output } = await runTurn(gmi, textTurn('t1', 'Hi.'));
    expect(of(chunks, GMIOutputChunkType.ERROR)[0]?.errorDetails?.code).toBe(GMIErrorCode.LLM_PROVIDER_ERROR);
    expect(output.usage).toMatchObject({ promptTokens: 40, totalTokens: 40 });
  });
});
