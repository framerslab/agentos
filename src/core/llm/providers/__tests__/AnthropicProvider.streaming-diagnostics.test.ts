import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { AnthropicProvider } from '../implementations/AnthropicProvider';

/**
 * Streaming cache-diagnostics surfacing: the API delivers the verdict on the
 * `message_start` event (there is no later event carrying it), so the
 * streaming path must capture it there and attach the normalized form to the
 * final chunk — exactly where callers already read `id` for threading.
 */

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

function events(messageStartExtra: Record<string, unknown> = {}): string[] {
  return [
    d({
      type: 'message_start',
      message: {
        id: 'msg_stream_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 1 },
        ...messageStartExtra,
      },
    }),
    d({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    d({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }),
    d({ type: 'content_block_stop', index: 0 }),
    d({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 5 },
    }),
    d({ type: 'message_stop' }),
  ];
}

async function finalChunkOf(
  provider: AnthropicProvider,
): Promise<Record<string, unknown> | undefined> {
  let final: Record<string, unknown> | undefined;
  for await (const chunk of provider.generateCompletionStream(
    'claude-opus-4-8',
    [{ role: 'user', content: 'hi' }],
    { cacheDiagnostics: { previousMessageId: 'msg_prev' } },
  )) {
    const c = chunk as unknown as Record<string, unknown>;
    if (c.isFinal) final = c;
  }
  return final;
}

describe('AnthropicProvider — streaming cache-diagnostics surfacing', () => {
  let provider: AnthropicProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    provider = new AnthropicProvider();
    await provider.initialize({ apiKey: 'test-key' });
  });

  it('surfaces the normalized miss reason from message_start on the final chunk', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse(
        events({
          diagnostics: {
            cache_miss_reason: { type: 'messages_changed', cache_missed_input_tokens: 640 },
          },
        }),
      ),
    );

    const final = await finalChunkOf(provider);
    expect(final?.id).toBe('msg_stream_1');
    expect(final?.cacheDiagnostics).toEqual({
      cacheMissReason: { type: 'messages_changed', cacheMissedInputTokens: 640 },
    });
  });

  it('surfaces null for a compared-no-divergence streaming verdict', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse(events({ diagnostics: null })));

    const final = await finalChunkOf(provider);
    expect(final).toBeDefined();
    expect('cacheDiagnostics' in (final as object)).toBe(true);
    expect(final?.cacheDiagnostics).toBeNull();
  });

  it('leaves cacheDiagnostics absent when message_start carries no diagnostics', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse(events()));

    const final = await finalChunkOf(provider);
    expect(final).toBeDefined();
    expect('cacheDiagnostics' in (final as object)).toBe(false);
  });
});
