/**
 * @fileoverview `usage.costUSD` through AnthropicProvider's public methods,
 * with only fetch stubbed: the SSE transport generateCompletion rides by
 * default, generateCompletionStream, and the single-shot JSON transport.
 *
 * Each case pins a price that a flat cache-read multiplier, a 5-minute-only
 * write price, a missing catalog row or an empty model echo gets wrong:
 * per-model cache-read prices (Opus 5.5 at 0.05x, Fable 5.1 at 0.025x), 1-hour
 * cache writes at 2x, the Sonnet 5.5 and Opus 4.5 rows, and a response
 * without a model echo.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { AnthropicProvider } from '../implementations/AnthropicProvider';
import type { ModelCompletionResponse } from '../IProvider';

type Usage = Record<string, unknown>;

/**
 * A completed SSE reply. `usage` rides message_start as the API sends it; the
 * final message_delta carries the output token total.
 */
function sseReply(model: string, usage: Usage, outputTokens: number): Response {
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_price', type: 'message', role: 'assistant', content: [], model,
        stop_reason: null, stop_sequence: null, usage: { output_tokens: 1, ...usage },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: outputTokens },
    },
    { type: 'message_stop' },
  ];
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** A single-shot JSON reply for the `streamCompletions: false` transport. */
function jsonReply(model: string, usage: Usage): Response {
  return new Response(
    JSON.stringify({
      id: 'msg_price_json', type: 'message', role: 'assistant', model,
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn', stop_sequence: null, usage,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/** Opus 5.5 usage: 1000 uncached input tokens and 100000 cache reads. */
const OPUS_55_CACHED = {
  input_tokens: 1000,
  cache_read_input_tokens: 100000,
  cache_creation_input_tokens: 0,
};

describe('AnthropicProvider usage.costUSD', () => {
  let provider: AnthropicProvider;

  beforeEach(async () => {
    fetchMock.mockReset();
    provider = new AnthropicProvider();
    await provider.initialize({ apiKey: 'test-anthropic-key', maxRetries: 1 });
  });

  it('prices Claude Opus 5.5 cache reads at 0.05x on generateCompletion', async () => {
    fetchMock.mockResolvedValueOnce(sseReply('claude-opus-5-5', OPUS_55_CACHED, 500));
    const response = await provider.generateCompletion('claude-opus-5-5', [{ role: 'user', content: 'hi' }], {});
    // $0.004 input + 100000 x $0.20/M = $0.02 reads + 500 x $20/M = $0.01 output.
    // A flat 0.1x read rate would give $0.054.
    expect(response.usage?.costUSD).toBeCloseTo(0.034, 6);
  });

  it('prices Claude Opus 5.5 cache reads at 0.05x on the final streamed chunk', async () => {
    fetchMock.mockResolvedValueOnce(sseReply('claude-opus-5-5', OPUS_55_CACHED, 500));
    let final: ModelCompletionResponse | undefined;
    for await (const chunk of provider.generateCompletionStream(
      'claude-opus-5-5',
      [{ role: 'user', content: 'hi' }],
      {},
    )) {
      if (chunk.isFinal) final = chunk;
    }
    expect(final?.usage?.costUSD).toBeCloseTo(0.034, 6);
  });

  it('prices Claude Fable 5.1 cache reads at 0.025x on the JSON transport', async () => {
    const json = new AnthropicProvider();
    await json.initialize({ apiKey: 'test-anthropic-key', maxRetries: 1, streamCompletions: false });
    fetchMock.mockResolvedValueOnce(
      jsonReply('claude-fable-5-1', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 }),
    );
    const response = await json.generateCompletion('claude-fable-5-1', [{ role: 'user', content: 'hi' }], {});
    expect(response.usage?.costUSD).toBeCloseTo(0.25, 6);
  });

  it('prices 1-hour cache writes at 2x the input price', async () => {
    fetchMock.mockResolvedValueOnce(
      sseReply(
        'claude-sonnet-4-6',
        {
          input_tokens: 0,
          cache_creation_input_tokens: 10000,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 10000 },
        },
        0,
      ),
    );
    const response = await provider.generateCompletion(
      'claude-sonnet-4-6',
      [
        { role: 'system', content: 'A long, stable system prompt.' },
        { role: 'user', content: 'hi' },
      ],
      { cache: { ttl: '1h' } },
    );
    // 10000 x $3/M x 2. Priced as 5-minute writes it would be $0.0375.
    expect(response.usage?.costUSD).toBeCloseTo(0.06, 6);
  });

  it('prices Claude Sonnet 5.5 from its own $2/$10 row', async () => {
    fetchMock.mockResolvedValueOnce(sseReply('claude-sonnet-5-5', { input_tokens: 1000 }, 1000));
    const response = await provider.generateCompletion('claude-sonnet-5-5', [{ role: 'user', content: 'hi' }], {});
    expect(response.usage?.costUSD).toBeCloseTo(0.012, 6);
  });

  it('prices Claude Opus 4.5 at $5/$25', async () => {
    fetchMock.mockResolvedValueOnce(sseReply('claude-opus-4-5-20251101', { input_tokens: 1000 }, 1000));
    const response = await provider.generateCompletion(
      'claude-opus-4-5-20251101',
      [{ role: 'user', content: 'hi' }],
      {},
    );
    expect(response.usage?.costUSD).toBeCloseTo(0.03, 6);
  });

  it('prices a response without a model echo by the requested model', async () => {
    fetchMock.mockResolvedValueOnce(sseReply('', { input_tokens: 1000 }, 1000));
    const response = await provider.generateCompletion('claude-sonnet-4-6', [{ role: 'user', content: 'hi' }], {});
    // $3/$15 for Sonnet 4.6. Resolving the empty echo to the first catalog
    // row would bill Opus 5.5's $4/$20 ($0.024).
    expect(response.usage?.costUSD).toBeCloseTo(0.018, 6);
  });
});
