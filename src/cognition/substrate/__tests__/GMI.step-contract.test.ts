/**
 * @file GMI.step-contract.test.ts
 * The step contract of a GMI turn on the runtime path (no completion
 * gateway): every text once, a TOOL_RESULT per recorded result, a
 * STEP_FINISHED per model step, usage on every chunk that carries it, every
 * completion option forwarded, and an in-band provider error keeping its code.
 */
import { describe, expect, it } from 'vitest';
import { GMIOutputChunkType, type GMIOutputChunk } from '../IGMI';
import { GMIErrorCode } from '../../../core/utils/errors';
import { createScriptedGmi, errorReply, runTurn, scriptedProvider, textReply, textTurn, toolCallReply } from './helpers/scriptedGmi';

const of = (chunks: GMIOutputChunk[], type: GMIOutputChunkType) => chunks.filter((c) => c.type === type);
const scriptedChunk = { id: 'scripted', object: 'chat.completion.chunk', created: 0, modelId: 'scripted-model' };

describe('GMI step contract (runtime path)', () => {
  it('a preamble, a tool-only step and the answer: every text once, a TOOL_RESULT per result, a STEP_FINISHED per step', async () => {
    const { provider } = scriptedProvider([
      toolCallReply([{ id: 'call_a', name: 'lookup', args: { q: 'a' } }], 'Let me check.'),
      toolCallReply([{ id: 'call_b', name: 'lookup', args: { q: 'b' } }]),
      textReply('Found it.'),
    ]);
    const { gmi } = await createScriptedGmi({ provider });
    const { chunks, output } = await runTurn(gmi, textTurn('t1', 'Look it up.'));
    expect(of(chunks, GMIOutputChunkType.TEXT_DELTA).map((c) => c.content)).toEqual(['Let me check.', 'Found it.']);
    expect(of(chunks, GMIOutputChunkType.TOOL_RESULT).map((c) => c.content)).toEqual([
      { toolCallId: 'call_a', name: 'lookup', result: { ok: true }, isError: false },
      { toolCallId: 'call_b', name: 'lookup', result: { ok: true }, isError: false },
    ]);
    const steps = of(chunks, GMIOutputChunkType.STEP_FINISHED).map((c) => c.content);
    expect(steps.map((s) => [s.stepIndex, s.text, s.finishReason])).toEqual([[0, 'Let me check.', 'tool_calls'], [1, '', 'tool_calls'], [2, 'Found it.', 'stop']]);
    expect(output.responseText).toBe('Let me check.Found it.');
  });

  it('a provider that sends no deltas gets its final content emitted once', async () => {
    const { provider } = scriptedProvider([[{ ...scriptedChunk, isFinal: true, choices: [{ index: 0, message: { role: 'assistant', content: 'Whole reply.' }, finishReason: 'stop' }] }] as never]);
    const { gmi } = await createScriptedGmi({ provider });
    const { chunks, output } = await runTurn(gmi, textTurn('t1', 'Hi.'));
    expect(of(chunks, GMIOutputChunkType.TEXT_DELTA).map((c) => c.content)).toEqual(['Whole reply.']);
    expect(output.responseText).toBe('Whole reply.');
  });

  it('usage from a trailing chunk with no choices is reported, and a running total is counted once', async () => {
    const usage = { promptTokens: 7, completionTokens: 2, totalTokens: 9 };
    const { provider } = scriptedProvider([[
      { ...scriptedChunk, choices: [], responseTextDelta: 'ok' },
      { ...scriptedChunk, isFinal: true, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }], usage },
      { ...scriptedChunk, isFinal: true, choices: [], usage },
    ] as never]);
    const { gmi } = await createScriptedGmi({ provider });
    const { chunks, output } = await runTurn(gmi, textTurn('t1', 'Hi.'));
    expect(of(chunks, GMIOutputChunkType.USAGE_UPDATE).length).toBe(2);
    expect(output.usage?.totalTokens).toBe(9);
  });

  it('forwards every completion option the persona and the turn set', async () => {
    const { provider, options } = scriptedProvider([textReply('ok')]);
    const { gmi } = await createScriptedGmi({
      provider,
      persona: { defaultModelCompletionOptions: { temperature: 0.1, topP: 0.9, frequencyPenalty: 0.2, presencePenalty: 0.3, stopSequences: ['END'], serviceTier: 'flex' } as never },
    });
    await runTurn(gmi, textTurn('t1', 'Hi.', { options: { maxTokens: 300, effort: 'low', preferredModelId: 'scripted-model' } } as never));
    expect(options[0]).toMatchObject({ temperature: 0.1, topP: 0.9, frequencyPenalty: 0.2, presencePenalty: 0.3, stopSequences: ['END'], serviceTier: 'flex', maxTokens: 300, effort: 'low', stream: true });
    expect(options[0]).not.toHaveProperty('preferredModelId');
  });

  it('an in-band provider error keeps LLM_PROVIDER_ERROR through the outer catch', async () => {
    const { provider } = scriptedProvider([errorReply('rate limited')]);
    const { gmi } = await createScriptedGmi({ provider });
    const { chunks } = await runTurn(gmi, textTurn('t1', 'Hi.'));
    expect(of(chunks, GMIOutputChunkType.ERROR)[0]?.errorDetails?.code).toBe(GMIErrorCode.LLM_PROVIDER_ERROR);
  });

  it('runs the tool calls of the last allowed step, as streamText does, and reports that step as tool_calls', async () => {
    const { provider } = scriptedProvider([
      toolCallReply([{ id: 'call_a', name: 'lookup', args: { q: 'a' } }]),
      toolCallReply([{ id: 'call_b', name: 'lookup', args: { q: 'b' } }]),
    ]);
    const { gmi, processToolCall } = await createScriptedGmi({ provider, maxToolLoopIterations: 2 });
    const { chunks } = await runTurn(gmi, textTurn('t1', 'Loop.'));
    expect(processToolCall).toHaveBeenCalledTimes(2);
    expect(of(chunks, GMIOutputChunkType.STEP_FINISHED).map((c) => c.content.finishReason)).toEqual(['tool_calls', 'tool_calls']);
  });
});
