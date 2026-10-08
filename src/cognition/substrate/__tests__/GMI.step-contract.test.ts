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
import type { IProvider } from '../../../core/llm/providers/IProvider';
import type { IToolOrchestrator } from '../../../core/tools/IToolOrchestrator';
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

  it('sets no temperature and no output budget of its own: unset, neither is sent; a persona value is sent, and a turn value replaces it', async () => {
    const bare = scriptedProvider([textReply('ok')]);
    const { gmi: plain } = await createScriptedGmi({ provider: bare.provider });
    await runTurn(plain, textTurn('t1', 'Hi.'));
    expect(bare.options[0]).not.toHaveProperty('temperature');
    expect(bare.options[0]).not.toHaveProperty('maxTokens');

    const { provider, options } = scriptedProvider([textReply('ok'), textReply('ok')]);
    const { gmi } = await createScriptedGmi({ provider, persona: { defaultModelCompletionOptions: { temperature: 0.2, maxTokens: 900 } as never } });
    await runTurn(gmi, textTurn('t1', 'Hi.'));
    await runTurn(gmi, textTurn('t2', 'Again.', { options: { temperature: 0.9, maxTokens: 300 } }));
    expect(options.map((o) => [o.temperature, o.maxTokens])).toEqual([[0.2, 900], [0.9, 300]]);
  });

  it('sends toolChoice only with tools: a turn with no tools to offer carries none, whatever the persona or the turn asks', async () => {
    const without = scriptedProvider([textReply('ok'), textReply('ok')]);
    const noTools = { orchestratorId: 'no-tools', listAvailableTools: async () => [], processToolCall: async () => { throw new Error('no tool call expected'); } } as unknown as IToolOrchestrator;
    const { gmi: bare } = await createScriptedGmi({
      provider: without.provider,
      persona: { defaultModelCompletionOptions: { toolChoice: 'auto' } as never },
      config: { toolOrchestrator: noTools },
    });
    await runTurn(bare, textTurn('t1', 'Hi.'));
    await runTurn(bare, textTurn('t2', 'Again.', { options: { toolChoice: 'required' } }));
    expect(without.options.map((o) => [o.tools, o.toolChoice])).toEqual([[undefined, undefined], [undefined, undefined]]);

    // With tools, the persona's choice is sent and the turn's replaces it.
    const withTools = scriptedProvider([textReply('ok'), textReply('ok')]);
    const { gmi } = await createScriptedGmi({ provider: withTools.provider, persona: { defaultModelCompletionOptions: { toolChoice: 'required' } as never } });
    await runTurn(gmi, textTurn('t1', 'Hi.'));
    await runTurn(gmi, textTurn('t2', 'Again.', { options: { toolChoice: 'none' } }));
    expect(withTools.options.map((o) => [Array.isArray(o.tools), o.toolChoice])).toEqual([[true, 'required'], [true, 'none']]);
  });

  it('an in-band provider error keeps LLM_PROVIDER_ERROR through the outer catch', async () => {
    const { provider } = scriptedProvider([errorReply('rate limited')]);
    const { gmi } = await createScriptedGmi({ provider });
    const { chunks } = await runTurn(gmi, textTurn('t1', 'Hi.'));
    expect(of(chunks, GMIOutputChunkType.ERROR)[0]?.errorDetails?.code).toBe(GMIErrorCode.LLM_PROVIDER_ERROR);
  });

  it('a step that fails after output is still counted: the usage on its error chunk, or the usage a thrown provider error carries', async () => {
    const billed = { promptTokens: 9, completionTokens: 2, totalTokens: 11 };
    const marked = { attemptFailed: true, hop: 0, providerId: 'scripted', modelId: 'scripted-model' };
    const bills = (chunks: GMIOutputChunk[]) =>
      of(chunks, GMIOutputChunkType.USAGE_UPDATE).filter((c) => c.metadata?.attemptFailed === true).map((c) => [c.content, c.metadata]);

    // An abort after some text: the provider ends the stream with an error chunk that carries the usage.
    const { provider: aborted } = scriptedProvider([[
      { ...scriptedChunk, choices: [], responseTextDelta: 'Partial' },
      { ...scriptedChunk, choices: [], isFinal: true, error: { message: 'aborted', type: 'abort' }, usage: billed },
    ] as never]);
    const inBand = await runTurn((await createScriptedGmi({ provider: aborted })).gmi, textTurn('t1', 'Hi.'));
    expect(of(inBand.chunks, GMIOutputChunkType.ERROR)[0]?.errorDetails?.code).toBe(GMIErrorCode.LLM_PROVIDER_ERROR);
    expect(bills(inBand.chunks)).toEqual([[billed, marked]]);
    expect(inBand.output.usage).toMatchObject(billed);

    // A refusal after some text: the provider throws, and the error carries the usage.
    const refusing = {
      providerId: 'scripted',
      isInitialized: true,
      generateCompletionStream: async function* () {
        yield { ...scriptedChunk, choices: [], responseTextDelta: 'Sure, here' };
        throw Object.assign(new Error('refused'), { details: { usage: billed } });
      },
    } as unknown as IProvider;
    const thrown = await runTurn((await createScriptedGmi({ provider: refusing })).gmi, textTurn('t1', 'Hi.'));
    expect(of(thrown.chunks, GMIOutputChunkType.ERROR)).toHaveLength(1);
    expect(bills(thrown.chunks)).toEqual([[billed, marked]]);
    expect(thrown.output.usage).toMatchObject(billed);
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
