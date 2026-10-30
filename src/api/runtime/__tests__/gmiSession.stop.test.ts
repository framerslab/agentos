/**
 * A GMI stream's error part when the caller's signal aborts: the signal's reason when the stop ended the turn, the
 * turn's own failure when that came first. The turn runner over a GMI that fails on its own, so the order is exact.
 */
import { describe, expect, it } from 'vitest';
import type { AgentOptions } from '../../agent.js';
import { GMIOutputChunkType, type GMIOutputChunk, type IGMI } from '../../../cognition/substrate/IGMI.js';
import { TurnLock, streamGmiTurn, type GmiSessionDeps } from '../gmiSession.js';

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
