import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { setLogger, resetLoggerFactory } from '../../../logging/loggerFactory.js';
import { OpenRouterProvider } from '../implementations/OpenRouterProvider';
import type { ChatMessage } from '../IProvider';

const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];

const logged: Record<string, unknown>[] = [];
beforeEach(() => {
  logged.length = 0;
  setLogger(pino({ level: 'debug', base: undefined }, { write(line: string) { logged.push(JSON.parse(line)); } }));
});
afterEach(() => resetLoggerFactory());

function okResponse() {
  return {
    id: 'gen-1',
    model: 'anthropic/claude-3',
    choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

describe('OpenRouterProvider — per-call requestTimeout override (CR8)', () => {
  let provider: OpenRouterProvider;
  let makeApiRequest: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    provider = new OpenRouterProvider();
    makeApiRequest = vi.fn().mockResolvedValue(okResponse());
    Object.assign(provider as unknown as Record<string, unknown>, {
      ensureInitialized: () => {},
      config: { requestTimeout: 60000, streamRequestTimeout: 120000 },
      makeApiRequest,
    });
    // Streaming tests feed a non-stream mock to assert the timeout arg; the
    // provider's expected SSE-parse failure goes to the logger set above.
  });

  it('passes the per-call override as the makeApiRequest timeout (3rd arg), and the caller\'s signal last', async () => {
    const signal = new AbortController().signal;
    await provider.generateCompletion('anthropic/claude-3', messages, { requestTimeout: 456789, abortSignal: signal } as never);
    expect(makeApiRequest).toHaveBeenCalledWith('/chat/completions', 'POST', 456789, expect.anything(), false, signal);
  });

  it('falls back to the config default timeout when no override is given', async () => {
    await provider.generateCompletion('anthropic/claude-3', messages, {} as never);
    expect(makeApiRequest).toHaveBeenCalledWith('/chat/completions', 'POST', 60000, expect.anything(), false, undefined);
  });

  // Streaming uses streamRequestTimeout as its default (not requestTimeout). The
  // makeApiRequest call fires before the non-stream mock is parsed as a stream.
  it('passes the per-call override as the streaming makeApiRequest timeout', async () => {
    const gen = provider.generateCompletionStream('anthropic/claude-3', messages, { requestTimeout: 999999 } as never);
    await gen.next().catch(() => {});
    const call = makeApiRequest.mock.calls.find((c) => c[0] === '/chat/completions');
    expect(call?.[2]).toBe(999999);
  });

  it('falls back to streamRequestTimeout for streaming when no override is given', async () => {
    const gen = provider.generateCompletionStream('anthropic/claude-3', messages, {} as never);
    await gen.next().catch(() => {});
    const call = makeApiRequest.mock.calls.find((c) => c[0] === '/chat/completions');
    expect(call?.[2]).toBe(120000);
  });
});
