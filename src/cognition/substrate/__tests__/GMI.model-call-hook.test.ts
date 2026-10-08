/**
 * @file GMI.model-call-hook.test.ts
 * What a host that runs sessions over a GMI needs from each model step: the
 * beforeModelCall hook over every attempt's prompt, each step's thinking
 * blocks on its STEP_FINISHED, and prompt-cache diagnostics threaded through
 * the steps of a turn as generateText threads them.
 */
import { describe, expect, it } from 'vitest';
import { GMIOutputChunkType, ReasoningEntryType, type GMIBaseConfig, type GMIModelCallContext } from '../IGMI';
import { createScriptedGmi, runTurn, scriptedProvider, textReply, textTurn, toolCallReply } from './helpers/scriptedGmi';

const scriptedChunk = { id: 'scripted', object: 'chat.completion.chunk', created: 0, modelId: 'scripted-model' };
const lookupStep = () => toolCallReply([{ id: 'call_a', name: 'lookup', args: { q: 'a' } }]);

describe('GMI beforeModelCall hook and step payload', () => {
  it('calls the hook for every model step with its turn, step, hop, provider and model, and sends the prompt it returns', async () => {
    const { provider, received } = scriptedProvider([lookupStep(), textReply('Found it.')]);
    const seen: Array<Omit<GMIModelCallContext, 'messages'>> = [];
    const { gmi } = await createScriptedGmi({
      provider,
      config: {
        beforeModelCall: async ({ messages, ...ctx }) => {
          seen.push(ctx);
          return [...messages, { role: 'system', content: `HOOKED ${ctx.stepIndex}` }];
        },
      },
    });
    await runTurn(gmi, textTurn('t1', 'Look it up.'));
    expect(seen).toEqual([
      { turnId: 't1', stepIndex: 0, hop: 0, providerId: 'scripted', modelId: 'scripted-model' },
      { turnId: 't1', stepIndex: 1, hop: 0, providerId: 'scripted', modelId: 'scripted-model' },
    ]);
    expect(received.map((prompt) => prompt.at(-1))).toEqual([
      { role: 'system', content: 'HOOKED 0' },
      { role: 'system', content: 'HOOKED 1' },
    ]);
    // A replacement is that attempt's prompt only; it never enters the history.
    expect(received[1].some((message) => message.content === 'HOOKED 0')).toBe(false);
  });

  it('sends the built prompt when the hook throws or returns no messages, with a trace warning', async () => {
    const cases: Array<[NonNullable<GMIBaseConfig['beforeModelCall']>, string]> = [
      [async () => { throw new Error('hook broke'); }, 'hook broke'],
      [() => [], 'returned no messages'],
    ];
    for (const [beforeModelCall, warning] of cases) {
      const { provider, received } = scriptedProvider([textReply('ok')]);
      const { gmi } = await createScriptedGmi({ provider, config: { beforeModelCall } });
      const { chunks } = await runTurn(gmi, textTurn('t1', 'Hi.'));
      expect(received[0].some((message) => message.role === 'user' && message.content === 'Hi.')).toBe(true);
      expect(chunks.filter((c) => c.type === GMIOutputChunkType.TEXT_DELTA).map((c) => c.content)).toEqual(['ok']);
      expect(gmi.getReasoningTrace().entries.some((e) => e.type === ReasoningEntryType.WARNING && String(e.message).includes(warning))).toBe(true);
    }
  });

  it("puts a step's thinking blocks on that step's STEP_FINISHED only", async () => {
    const thinking = [{ type: 'thinking', thinking: 'plan', signature: 'sig' }];
    const thinkingToolStep = [{
      ...scriptedChunk,
      isFinal: true,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'lookup', arguments: '{"q":"a"}' } }], thinkingBlocks: thinking },
        finishReason: 'tool_calls',
      }],
    }];
    const { provider } = scriptedProvider([thinkingToolStep as never, textReply('done')]);
    const { gmi } = await createScriptedGmi({ provider });
    const { chunks } = await runTurn(gmi, textTurn('t1', 'Hi.'));
    const steps = chunks.filter((c) => c.type === GMIOutputChunkType.STEP_FINISHED).map((c) => c.content);
    expect(steps).toHaveLength(2);
    expect(steps[0].thinkingBlocks).toEqual(thinking);
    expect(steps[1]).not.toHaveProperty('thinkingBlocks');
  });

  it("threads cacheDiagnostics through a turn's steps: the caller's id first, then the previous step's response", async () => {
    const toolStep = lookupStep().map((chunk) => ({ ...chunk, id: 'msg_step0' }));
    const { provider, options } = scriptedProvider([toolStep, textReply('Found it.')]);
    const { gmi } = await createScriptedGmi({ provider });
    await runTurn(gmi, textTurn('t1', 'Look it up.', { options: { cacheDiagnostics: { previousMessageId: 'msg_1' } } } as never));
    expect(options.map((o) => o.cacheDiagnostics)).toEqual([{ previousMessageId: 'msg_1' }, { previousMessageId: 'msg_step0' }]);
  });

  it('cacheDiagnostics true opts in with nothing to compare; false keeps it off over a persona default', async () => {
    const on = scriptedProvider([textReply('ok')]);
    const { gmi: gmiOn } = await createScriptedGmi({ provider: on.provider });
    await runTurn(gmiOn, textTurn('t1', 'Hi.', { options: { cacheDiagnostics: true } } as never));
    expect(on.options[0].cacheDiagnostics).toEqual({ previousMessageId: null });

    const off = scriptedProvider([textReply('ok')]);
    const { gmi: gmiOff } = await createScriptedGmi({ provider: off.provider, persona: { defaultModelCompletionOptions: { cacheDiagnostics: true } as never } });
    await runTurn(gmiOff, textTurn('t1', 'Hi.', { options: { cacheDiagnostics: false } } as never));
    expect(off.options[0]).not.toHaveProperty('cacheDiagnostics');
  });
});
