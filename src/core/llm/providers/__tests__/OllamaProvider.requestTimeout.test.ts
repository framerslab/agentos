import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OllamaProvider } from '../implementations/OllamaProvider';
import type { ChatMessage } from '../IProvider';

const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];

describe('OllamaProvider — per-call requestTimeout override (CR8)', () => {
  let provider: OllamaProvider;
  let post: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    provider = new OllamaProvider();
    post = vi.fn().mockResolvedValue({
      data: { message: { role: 'assistant', content: 'hi' }, prompt_eval_count: 1, eval_count: 1, done: true },
    });
    Object.assign(provider as unknown as Record<string, unknown>, {
      ensureInitialized: () => {},
      config: { requestTimeout: 60000 },
      client: { post },
    });
    // Streaming tests feed a non-stream mock to assert the timeout arg; silence
    // the provider's expected "not async iterable" error so output stays clean.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('passes the per-call override as the axios request timeout', async () => {
    await provider.generateCompletion('llama3', messages, { requestTimeout: 345678 } as never);
    expect(post).toHaveBeenCalledWith('/chat', expect.anything(), expect.objectContaining({ timeout: 345678 }));
  });

  it('falls back to the config default timeout when no override is given', async () => {
    await provider.generateCompletion('llama3', messages, {} as never);
    expect(post).toHaveBeenCalledWith('/chat', expect.anything(), expect.objectContaining({ timeout: 60000 }));
  });

  // The streaming post fires before the (mock) stream body is parsed, so the
  // call is recorded even though consuming the non-stream mock then throws.
  it('passes the per-call override as the streaming axios timeout', async () => {
    const gen = provider.generateCompletionStream('llama3', messages, { requestTimeout: 789012 } as never);
    await gen.next().catch(() => {});
    const call = post.mock.calls.find((c) => c[0] === '/chat');
    expect(call?.[2]).toEqual(expect.objectContaining({ timeout: 789012, responseType: 'stream' }));
  });

  it('falls back to the config default for streaming when no override is given', async () => {
    const gen = provider.generateCompletionStream('llama3', messages, {} as never);
    await gen.next().catch(() => {});
    const call = post.mock.calls.find((c) => c[0] === '/chat');
    expect(call?.[2]).toEqual(expect.objectContaining({ timeout: 60000, responseType: 'stream' }));
  });
});
