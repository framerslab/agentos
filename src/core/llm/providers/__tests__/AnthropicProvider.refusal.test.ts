/**
 * @fileoverview Claude refusals (`stop_reason: 'refusal'`) through
 * AnthropicProvider's public methods, with only fetch stubbed.
 *
 * Anthropic answers a refused request with HTTP 200, `stop_reason: 'refusal'`
 * and `stop_details`, before any output or partway through it, and partial
 * output must be discarded. The provider raises every refusal as an
 * AnthropicProviderError with code `content_filter`, which the fallback
 * chains recognize, and never hands back the partial text or its tool calls
 * as a completed turn.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { AnthropicProvider } from '../implementations/AnthropicProvider';
import { AnthropicProviderError } from '../errors/AnthropicProviderError';
import type { ModelCompletionResponse } from '../IProvider';
import { isContentPolicyRefusal, isRetryableError } from '../../../../api/generateText';

/** Placeholder stop_details; the provider keeps whatever the API sends. */
const STOP_DETAILS = { type: 'refusal', category: 'example_category', explanation: 'Declined.' };

/** An SSE response carrying `events` in order. */
function sse(events: unknown[]): Response {
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const messageStart = {
  type: 'message_start',
  message: {
    id: 'msg_refusal', type: 'message', role: 'assistant', content: [], model: 'claude-opus-5-5',
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 40, output_tokens: 1 },
  },
};

/** The closing message_delta of a turn that stopped for `stopReason`. */
function messageDelta(stopReason: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null, ...extra },
    usage: { output_tokens: 6 },
  };
}

/** A refusal before any output. */
function preOutputRefusal(): Response {
  return sse([messageStart, messageDelta('refusal', { stop_details: STOP_DETAILS }), { type: 'message_stop' }]);
}

/**
 * A refusal after the model wrote 'Here is the' and began a tool_use block
 * whose input JSON the refusal cut off.
 */
function partialRefusal(): Response {
  return sse([
    messageStart,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Here is the' } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_cut', name: 'get_weather', input: {} },
    },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"city":"Par' } },
    messageDelta('refusal', { stop_details: STOP_DETAILS }),
    { type: 'message_stop' },
  ]);
}

/** A completed turn that stopped for `stopReason` after writing 'Partial'. */
function stoppedTurn(stopReason: string): Response {
  return sse([
    messageStart,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial' } },
    { type: 'content_block_stop', index: 0 },
    messageDelta(stopReason),
    { type: 'message_stop' },
  ]);
}

/** Awaits `promise` and returns what it rejected with. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject');
}

/** Details the provider attaches to a refusal error. */
type RefusalDetails = {
  stopReason: string;
  stopDetails: { category?: string } | null;
  partialText: string;
  usage: { promptTokens?: number; completionTokens?: number };
};

describe('AnthropicProvider refusals', () => {
  let provider: AnthropicProvider;
  const messages = [{ role: 'user' as const, content: 'What is the weather in Paris?' }];

  beforeEach(async () => {
    fetchMock.mockReset();
    provider = new AnthropicProvider();
    await provider.initialize({ apiKey: 'test-anthropic-key' });
  });

  it('raises a pre-output refusal as a content-policy error, without a transport retry', async () => {
    fetchMock.mockResolvedValueOnce(preOutputRefusal());

    const error = await rejectionOf(provider.generateCompletion('claude-opus-5-5', messages, {}));

    expect(error).toBeInstanceOf(AnthropicProviderError);
    const refusal = error as AnthropicProviderError;
    expect(refusal.code).toBe('content_filter');
    expect(refusal.anthropicErrorType).toBe('refusal');
    const details = refusal.details as RefusalDetails;
    expect(details.stopDetails?.category).toBe('example_category');
    expect(details.partialText).toBe('');
    expect(details.usage).toMatchObject({ promptTokens: 40, completionTokens: 6 });
    // The fallback chains in generateText and streamText act on it.
    expect(isContentPolicyRefusal(refusal)).toBe(true);
    expect(isRetryableError(refusal)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('raises a refusal that cut off text and a tool input, instead of retrying a truncated stream', async () => {
    fetchMock.mockResolvedValueOnce(partialRefusal());

    const error = await rejectionOf(provider.generateCompletion('claude-opus-5-5', messages, {}));

    expect((error as AnthropicProviderError).code).toBe('content_filter');
    expect(((error as AnthropicProviderError).details as RefusalDetails).partialText).toBe('Here is the');
    // The cut-off tool input is not treated as a dropped connection, which
    // the transport would retry.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('raises a refusal on the single-shot JSON transport', async () => {
    const json = new AnthropicProvider();
    await json.initialize({ apiKey: 'test-anthropic-key', streamCompletions: false });
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'msg_refusal_json', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
          content: [], stop_reason: 'refusal', stop_sequence: null, stop_details: STOP_DETAILS,
          usage: { input_tokens: 40, output_tokens: 0 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const error = await rejectionOf(json.generateCompletion('claude-opus-5-5', messages, {}));

    expect((error as AnthropicProviderError).code).toBe('content_filter');
    expect(((error as AnthropicProviderError).details as RefusalDetails).stopDetails?.category).toBe(
      'example_category',
    );
  });

  it('throws a pre-output refusal from generateCompletionStream instead of yielding an error chunk', async () => {
    fetchMock.mockResolvedValueOnce(preOutputRefusal());
    const chunks: ModelCompletionResponse[] = [];

    const error = await rejectionOf(
      (async () => {
        for await (const chunk of provider.generateCompletionStream('claude-opus-5-5', messages, {})) {
          chunks.push(chunk);
        }
      })(),
    );

    expect((error as AnthropicProviderError).code).toBe('content_filter');
    expect(chunks).toEqual([]);
  });

  it('throws a refusal that arrives after streamed text, with no final chunk and no tool calls', async () => {
    fetchMock.mockResolvedValueOnce(partialRefusal());
    const chunks: ModelCompletionResponse[] = [];

    const error = await rejectionOf(
      (async () => {
        for await (const chunk of provider.generateCompletionStream('claude-opus-5-5', messages, {})) {
          chunks.push(chunk);
        }
      })(),
    );

    // The text delta already reached the caller; the turn still ends as a
    // refusal rather than a completed answer.
    expect(chunks.map((chunk) => chunk.responseTextDelta).filter(Boolean)).toEqual(['Here is the']);
    expect(chunks.some((chunk) => chunk.isFinal)).toBe(false);
    expect(chunks.some((chunk) => chunk.choices[0]?.message?.tool_calls?.length)).toBe(false);
    expect((error as AnthropicProviderError).code).toBe('content_filter');
    expect(((error as AnthropicProviderError).details as RefusalDetails).partialText).toBe('Here is the');
  });

  it('maps model_context_window_exceeded to length and passes pause_turn through', async () => {
    fetchMock.mockResolvedValueOnce(stoppedTurn('model_context_window_exceeded'));
    const truncated = await provider.generateCompletion('claude-opus-5-5', messages, {});
    expect(truncated.choices[0].finishReason).toBe('length');

    fetchMock.mockResolvedValueOnce(stoppedTurn('pause_turn'));
    const paused = await provider.generateCompletion('claude-opus-5-5', messages, {});
    expect(paused.choices[0].finishReason).toBe('pause_turn');
    expect(paused.choices[0].message.content).toBe('Partial');
  });
});
