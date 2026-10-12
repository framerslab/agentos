import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIProvider } from '../implementations/OpenAIProvider.js';
import { AnthropicProvider } from '../implementations/AnthropicProvider.js';
import { GeminiProvider } from '../implementations/GeminiProvider.js';
import type { ModelCompletionOptions, ModelCompletionResponse } from '../IProvider.js';

const sentinel = 'sentinel-words-7731-é';
const messages = [{ role: 'user' as const, content: 'hello' }];

function streamResponse(body: string): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

async function drain(events: AsyncGenerator<ModelCompletionResponse>): Promise<void> {
  for await (const _event of events) { /* Consume the public stream to trigger parsing. */ }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('provider stream diagnostics', () => {
  it.each(['chat', 'responses', 'trailing'] as const)('keeps content out of OpenAI %s warnings', async (path) => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] })));
    vi.stubGlobal('fetch', fetch);
    const provider = new OpenAIProvider();
    await provider.initialize({ apiKey: 'test-key' });
    const options: ModelCompletionOptions = path === 'responses'
      ? { effort: 'high', tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }] }
      : {};
    const completed = path === 'responses'
      ? `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'reply-1', status: 'completed', output: [] } })}\n\n`
      : '';
    fetch.mockResolvedValueOnce(streamResponse(path === 'trailing' ? sentinel : `data: ${sentinel}\n\n${completed}`));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await drain(provider.generateCompletionStream(path === 'responses' ? 'gpt-5.5' : 'gpt-4o', messages, options));
    const message = path === 'responses'
      ? 'OpenAIProvider: Failed to parse /responses stream event JSON:'
      : path === 'trailing'
        ? 'OpenAIProvider: Trailing stream data not processed:'
        : 'OpenAIProvider: Failed to parse stream chunk JSON:';
    expect(warn).toHaveBeenCalledWith(message, {
      eventBytes: new TextEncoder().encode(sentinel).byteLength,
      error: path === 'trailing' ? 'Unrecognized stream framing.' : 'Invalid stream JSON.',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('sentinel-words-7731');
  });

  it.each(['stream', 'completion'] as const)('keeps content out of Anthropic %s warnings', async (path) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const provider = new AnthropicProvider();
    await provider.initialize({ apiKey: 'test-key' });
    const events = [
      sentinel,
      JSON.stringify({ type: 'message_start', message: { id: 'reply-1', model: 'claude-sonnet-4-6', usage: { input_tokens: 1, output_tokens: 0 } } }),
      JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }),
      JSON.stringify({ type: 'message_stop' }),
    ];
    fetch.mockResolvedValueOnce(streamResponse(events.map((event) => `data: ${event}\n\n`).join('')));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    if (path === 'stream') await drain(provider.generateCompletionStream('claude-sonnet-4-6', messages, { cache: false }));
    else await provider.generateCompletion('claude-sonnet-4-6', messages, { cache: false });
    expect(warn).toHaveBeenCalledWith('AnthropicProvider: Could not parse SSE event JSON:', {
      eventBytes: new TextEncoder().encode(sentinel).byteLength, error: 'Invalid stream JSON.',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('sentinel-words-7731');
  });

  it('keeps content out of Gemini warnings', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const provider = new GeminiProvider();
    await provider.initialize({ apiKey: 'test-key' });
    fetch.mockResolvedValueOnce(streamResponse(`data: ${sentinel}\n\n`));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await drain(provider.generateCompletionStream('gemini-2.5-flash', messages, {}));
    expect(warn).toHaveBeenCalledExactlyOnceWith('GeminiProvider: Could not parse SSE event JSON:', {
      eventBytes: new TextEncoder().encode(sentinel).byteLength, error: 'Invalid stream JSON.',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('sentinel-words-7731');
  });
});
