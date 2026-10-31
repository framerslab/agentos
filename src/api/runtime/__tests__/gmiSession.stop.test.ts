/**
 * A GMI stream's error part, and a send's rejection, when the caller's signal aborts: the signal's reason when the stop
 * ended the turn, the turn's own failure when that came first. The turn runner over a GMI that fails on its own, so the
 * order is exact.
 */
import { describe, expect, it } from 'vitest';
import type { AgentOptions } from '../../agent.js';
import { GMIOutputChunkType, type GMIOutputChunk, type IGMI } from '../../../cognition/substrate/IGMI.js';
import { TurnLock, sendGmiTurn, streamGmiTurn, type GmiSessionDeps } from '../gmiSession.js';

const chunk = (type: GMIOutputChunkType, content: unknown): GMIOutputChunk => ({ type, content, interactionId: 'i', timestamp: new Date() });

describe('streamGmiTurn and the caller signal', () => {
  it("keeps the turn's own failure in the error part when the caller's signal aborts after it", async () => {
    const stop = new AbortController();
    // A step that used tokens, then a failure of the GMI's own.
    const failing = {
      async *processTurnStream(): AsyncGenerator<GMIOutputChunk> {
        yield chunk(GMIOutputChunkType.STEP_FINISHED, {
          stepIndex: 0,
          text: '',
          finishReason: 'tool_calls',
          providerId: 'openai',
          modelId: 'stub-model',
          hop: 0,
          usage: { promptTokens: 5, completionTokens: 1, totalTokens: 6 },
        });
        throw new Error('provider down');
      },
    } as unknown as IGMI;
    const deps: GmiSessionDeps = {
      sessionId: 's1',
      opts: {} as AgentOptions,
      userId: 'u1',
      useMemoryProviderContext: false,
      history: null,
      // The turn hands over its usage once its failure is recorded, before the stream reports it: the caller stops then.
      onUsage: () => stop.abort(new Error('stopped late')),
      lock: new TurnLock(),
      gmiFor: async () => ({ gmi: failing }),
    };

    const result = streamGmiTurn(deps, 'Hi.', { abortSignal: stop.signal, callerSignal: stop.signal });
    const parts: Array<{ type: string; error?: unknown }> = [];
    for await (const part of result.fullStream) parts.push(part);
    expect(stop.signal.aborted).toBe(true);
    expect(parts.at(-1)).toMatchObject({ type: 'error', error: expect.objectContaining({ message: 'provider down' }) });
  });
});

describe('sendGmiTurn and the caller signal', () => {
  /** A GMI whose turn finishes a step that used tokens, runs `before`, then fails with `message`. */
  const failingAfter = (message: string, before: () => void = () => undefined): IGMI =>
    ({
      async *processTurnStream(): AsyncGenerator<GMIOutputChunk> {
        yield chunk(GMIOutputChunkType.STEP_FINISHED, {
          stepIndex: 0,
          text: '',
          finishReason: 'tool_calls',
          providerId: 'openai',
          modelId: 'stub-model',
          hop: 0,
          usage: { promptTokens: 5, completionTokens: 1, totalTokens: 6 },
        });
        before();
        throw new Error(message);
      },
    }) as unknown as IGMI;
  const depsOf = (gmi: IGMI, onUsage: () => void = () => undefined): GmiSessionDeps => ({
    sessionId: 's1',
    opts: {} as AgentOptions,
    userId: 'u1',
    useMemoryProviderContext: false,
    history: null,
    onUsage,
    lock: new TurnLock(),
    gmiFor: async () => ({ gmi }),
  });

  it("rejects with the turn's own failure when the caller's signal aborts after it", async () => {
    const stop = new AbortController();
    // The turn hands over its usage once its failure is recorded, before the send settles: the caller stops then.
    const deps = depsOf(failingAfter('provider down'), () => stop.abort(new Error('stopped late')));

    await expect(sendGmiTurn(deps, 'Hi.', { abortSignal: stop.signal, callerSignal: stop.signal })).rejects.toThrow('provider down');
    expect(stop.signal.aborted).toBe(true);
  });

  it("rejects with the signal's reason when the stop ended the turn", async () => {
    const stop = new AbortController();
    const reason = new Error('stopped');
    // The caller's signal aborts during the model call, which then fails on the abort.
    const deps = depsOf(failingAfter('Stream aborted by caller', () => stop.abort(reason)));

    await expect(sendGmiTurn(deps, 'Hi.', { abortSignal: stop.signal, callerSignal: stop.signal })).rejects.toBe(reason);
  });
});
