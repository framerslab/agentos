import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterProvider } from '../implementations/OpenRouterProvider';
import type { ChatMessage } from '../IProvider';

const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];

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
    // Streaming tests feed a non-stream mock to assert the timeout arg; silence
    // the provider's expected SSE-parse error so output stays clean.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('passes the per-call override as the makeApiRequest timeout (3rd arg)', async () => {
    await provider.generateCompletion('anthropic/claude-3', messages, { requestTimeout: 456789 } as never);
    expect(makeApiRequest).toHaveBeenCalledWith('/chat/completions', 'POST', 456789, expect.anything());
  });

  it('falls back to the config default timeout when no override is given', async () => {
    await provider.generateCompletion('anthropic/claude-3', messages, {} as never);
    expect(makeApiRequest).toHaveBeenCalledWith('/chat/completions', 'POST', 60000, expect.anything());
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
