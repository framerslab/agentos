/**
 * @file GMI.gateway.test.ts
 * A GMI turn through a completion gateway: the hop is resolved before the
 * prompt is built, a failure before any output rebuilds the prompt for the
 * next hop, a turn stays on the hop that served its last step and the next
 * user turn starts at the primary, the error codes of the chain's ends, no
 * fallback after output, and the schema answer on STEP_FINISHED.
 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { GMIOutputChunkType, type GMIOutputChunk } from '../IGMI';
import { GMIErrorCode } from '../../../core/utils/errors';
import type { ChatMessage, ModelCompletionOptions, ModelCompletionResponse } from '../../../core/llm/providers/IProvider';
import { toolFormatFor, type CompletionGateway, type CompletionOutcome, type CompletionResolution } from '../../../api/runtime/completionGateway';
import { createScriptedGmi, runTurn, textReply, textTurn, toolCallReply } from './helpers/scriptedGmi';

type Attempt = { hop: number; chunks: ModelCompletionResponse[] } | { hop: number; fails: Error; retryable?: boolean };

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
      const outcome = Promise.resolve<CompletionOutcome>('fails' in next ? { kind: 'hopFailed', error: next.fails, retryable: next.retryable ?? true } : { kind: 'delivered' });
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
});
