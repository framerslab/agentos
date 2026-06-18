import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { AnthropicProvider } from '../implementations/AnthropicProvider';

/** `data:` line for one SSE event object. */
const d = (o: unknown) => `data: ${JSON.stringify(o)}`;

function sseStream(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const payload = events.join('\n\n') + '\n\n';
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
}

function sseResponse(events: string[]): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers(),
    json: () => Promise.reject(new Error('SSE body, not JSON')),
    body: sseStream(events),
  } as unknown as Response;
}

describe('AnthropicProvider — streaming output-token accounting', () => {
  let provider: AnthropicProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    provider = new AnthropicProvider();
    await provider.initialize({ apiKey: 'test-key' });
  });

  it('does not double-count output_tokens across multiple message_delta events (cumulative, latest-wins)', async () => {
    // Anthropic reports output_tokens as a CUMULATIVE running total; the final
    // message_delta is authoritative. Two deltas reporting 50 then 120 mean the
    // turn used 120 output tokens — NOT 50 + 120 = 170.
    const events = [
      d({ type: 'message_start', message: { id: 'msg_x', type: 'message', role: 'assistant', model: 'claude-sonnet-4-20250514', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 1 } } }),
      d({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      d({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello world' } }),
      d({ type: 'content_block_stop', index: 0 }),
      d({ type: 'message_delta', delta: { stop_reason: null, stop_sequence: null }, usage: { output_tokens: 50 } }),
      d({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 120 } }),
      d({ type: 'message_stop' }),
    ];
    fetchMock.mockResolvedValueOnce(sseResponse(events));

    let finalCompletionTokens: number | undefined;
    for await (const chunk of provider.generateCompletionStream(
      'claude-sonnet-4-20250514',
      [{ role: 'user', content: 'hi' }],
      {},
    )) {
      const u = (chunk as { usage?: { completionTokens?: number } }).usage;
      if (u?.completionTokens !== undefined) finalCompletionTokens = u.completionTokens;
    }

    expect(finalCompletionTokens).toBe(120);
  });
});
