/**
 * Model abort propagation: the agent session adapter hands each request an
 * AbortSignal, abort() aborts that signal rather than only discarding the
 * text, and whenIdle() resolves once the request's iterator has unwound.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '../../../api/agent.js';
import { AgentSessionVoiceAdapter } from '../providers/AgentSessionVoiceAdapter.js';

const metadata = { speakers: [], endpointReason: 'manual' as const, speechDurationMs: 20, wasInterrupted: false, transcriptConfidence: 1 };

describe('model abort propagation', () => {
  it('aborts the actual request signal and waits for its iterator to finish', async () => {
    let requestSignal: AbortSignal | undefined;
    let exited = false;
    const stream = vi.fn((_text: unknown, opts?: { abortSignal?: AbortSignal }) => {
      requestSignal = opts?.abortSignal;
      return {
        textStream: (async function* () {
          try {
            yield 'first';
            await new Promise<void>((_resolve, reject) => {
              if (requestSignal?.aborted) reject(new Error('aborted'));
              else requestSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            });
          } finally {
            exited = true;
          }
        })(),
      };
    });
    const adapter = new AgentSessionVoiceAdapter({ stream } as unknown as AgentSession);
    const iterator = adapter.sendText('hello', metadata)[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ value: 'first', done: false });
    const next = iterator.next();
    adapter.abort();
    await next;
    await adapter.whenIdle();
    expect(requestSignal?.aborted).toBe(true);
    expect(exited).toBe(true);
  });
});
