/**
 * @fileoverview Request-level and catalog coverage for Claude Opus 5.5,
 * Claude Fable 5.1, Claude Sonnet 5.5, Claude Opus 4.5 and the retired Claude
 * 4 snapshots.
 *
 * The request tests drive AnthropicProvider.generateCompletion against a
 * mocked fetch and assert on the JSON body the provider sends. The shapes they
 * guard against are ones the API rejects outright: a forced tool_choice on Opus
 * 5.5, Sonnet 5.5 or Fable 5.1, `temperature` on any reasoning-default model,
 * and a max_tokens above a model's output ceiling. Each returns HTTP 400
 * (live-probed 2026-09-29 and 2026-09-30).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import type { ModelInfo } from '../IProvider';
import {
  AnthropicProvider,
  modelSupportsTemperature,
  resolveAnthropicModelEntry,
  resolveModelCatalogEntry,
} from '../implementations/AnthropicProvider';

/** A completed SSE stream carrying one short text reply. */
function sseResponse(): Response {
  const d = (o: unknown) => `data: ${JSON.stringify(o)}`;
  const events = [
    d({
      type: 'message_start',
      message: {
        id: 'msg_refresh', type: 'message', role: 'assistant', content: [], model: 'claude-opus-5-5',
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 },
      },
    }),
    d({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    d({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }),
    d({ type: 'content_block_stop', index: 0 }),
    d({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }),
    d({ type: 'message_stop' }),
  ];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(events.join('\n\n') + '\n\n'));
      controller.close();
    },
  });
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers(),
    json: () => Promise.reject(new Error('SSE body, not JSON')),
    body,
  } as unknown as Response;
}

const aTool = {
  name: 'doThing',
  description: 'Do a thing.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

describe('AnthropicProvider request shape for the refreshed models', () => {
  let provider: AnthropicProvider;
  const sentBody = () => JSON.parse(fetchMock.mock.calls[0][1].body);

  beforeEach(async () => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async () => sseResponse());
    provider = new AnthropicProvider();
    await provider.initialize({ apiKey: 'test-anthropic-key' });
  });

  it.each(['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5'])('clamps a forced tool_choice to auto on %s', async (model) => {
    await provider.generateCompletion(model, [{ role: 'user', content: 'build it' }], {
      toolChoice: 'required',
      tools: [aTool],
    });
    expect(sentBody().tool_choice).toEqual({ type: 'auto' });
  });

  it.each(['claude-opus-5', 'claude-sonnet-5'])('keeps a forced tool_choice on %s', async (model) => {
    await provider.generateCompletion(model, [{ role: 'user', content: 'build it' }], {
      toolChoice: 'required',
      tools: [aTool],
    });
    expect(sentBody().tool_choice).toEqual({ type: 'any' });
  });

  it.each(['claude-opus-5-5', 'claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5-5'])('omits temperature on %s', async (model) => {
    await provider.generateCompletion(model, [{ role: 'user', content: 'hi' }], { temperature: 0.5 });
    expect(sentBody()).not.toHaveProperty('temperature');
  });

  it('sends the structured-output tool without forcing it on Claude Sonnet 5.5', async () => {
    await provider.generateCompletion('claude-sonnet-5-5', [{ role: 'user', content: 'answer' }], {
      responseFormat: {
        _agentosUseToolForStructuredOutput: true,
        tool: { name: 'out', input_schema: { type: 'object', properties: {} } },
      },
    });
    expect(sentBody().tool_choice).toEqual({ type: 'auto' });
  });

  it('sends only the adaptive thinking form and effort max on Claude Sonnet 5.5', async () => {
    await provider.generateCompletion('claude-sonnet-5-5', [{ role: 'user', content: 'hi' }], {
      thinking: { budgetTokens: 4000 },
      effort: 'max',
    });
    expect(sentBody().thinking).toEqual({ type: 'adaptive' });
    expect(sentBody().output_config).toEqual({ effort: 'max' });
  });

  it('clamps max_tokens to the 64K ceiling and still sends temperature on Claude Opus 4.5', async () => {
    await provider.generateCompletion('claude-opus-4-5-20251101', [{ role: 'user', content: 'hi' }], {
      maxTokens: 128000,
      temperature: 0.2,
    });
    expect(sentBody().max_tokens).toBe(64000);
    expect(sentBody().temperature).toBe(0.2);
  });

  it('still sends temperature to Claude Sonnet 4.6', async () => {
    await provider.generateCompletion('claude-sonnet-4-6', [{ role: 'user', content: 'hi' }], { temperature: 0.5 });
    expect(sentBody().temperature).toBe(0.5);
  });
});

describe('ANTHROPIC_MODELS rows', () => {
  let provider: AnthropicProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    provider = new AnthropicProvider();
    await provider.initialize({ apiKey: 'test-anthropic-key' });
  });

  it('lists Claude Opus 5.5 and Claude Fable 5.1 with their published limits and prices', async () => {
    expect(await provider.getModelInfo('claude-opus-5-5')).toMatchObject({
      contextWindowSize: 1000000,
      outputTokenLimit: 128000,
      pricePer1MTokensInput: 4,
      pricePer1MTokensOutput: 20,
      status: 'active',
    });
    expect(await provider.getModelInfo('claude-fable-5-1')).toMatchObject({
      contextWindowSize: 1000000,
      outputTokenLimit: 128000,
      pricePer1MTokensInput: 10,
      pricePer1MTokensOutput: 50,
      status: 'active',
    });
  });

  it('lists Claude Sonnet 5.5 and Claude Opus 4.5 with their published limits and prices', async () => {
    expect(await provider.getModelInfo('claude-sonnet-5-5')).toMatchObject({
      contextWindowSize: 1000000,
      outputTokenLimit: 128000,
      pricePer1MTokensInput: 2,
      pricePer1MTokensOutput: 10,
      status: 'active',
    });
    expect(await provider.getModelInfo('claude-opus-4-5-20251101')).toMatchObject({
      contextWindowSize: 200000,
      outputTokenLimit: 64000,
      pricePer1MTokensInput: 5,
      pricePer1MTokensOutput: 25,
      status: 'active',
    });
  });

  it('prices Claude Sonnet 5 at the standard $2/$10', async () => {
    expect(await provider.getModelInfo('claude-sonnet-5')).toMatchObject({
      pricePer1MTokensInput: 2,
      pricePer1MTokensOutput: 10,
    });
  });

  it('keeps the retired Claude 4 snapshots listed as deprecated', async () => {
    // Both ids return HTTP 404 not_found_error (probed 2026-09-29). A deleted
    // row and a row that never existed both read as undefined, so the status
    // is what tells a caller holding one of these ids that it is gone.
    for (const id of ['claude-opus-4-20250514', 'claude-sonnet-4-20250514']) {
      expect((await provider.getModelInfo(id))?.status).toBe('deprecated');
    }
  });
});

describe('resolveModelCatalogEntry', () => {
  const row = (modelId: string, price: number) =>
    ({ modelId, providerId: 'anthropic', capabilities: ['chat'], pricePer1MTokensInput: price }) as ModelInfo;
  // The shorter id is first on purpose: a first-match prefix scan over this
  // catalog resolves the dated Opus 5.5 id below to the Opus 5 row.
  const catalog = [row('claude-opus-5', 5), row('claude-opus-5-5', 4), row('claude-haiku-4-5-20251001', 1)];

  it('prefers the exact row', () => {
    expect(resolveModelCatalogEntry(catalog, 'claude-opus-5')?.pricePer1MTokensInput).toBe(5);
  });

  it('resolves a dated id to the longest matching prefix whatever the order', () => {
    expect(resolveModelCatalogEntry(catalog, 'claude-opus-5-5-20260901')?.modelId).toBe('claude-opus-5-5');
    expect(resolveModelCatalogEntry(catalog, 'claude-opus-5-20260701')?.modelId).toBe('claude-opus-5');
  });

  it('resolves a bare alias to the dated row it prefixes', () => {
    expect(resolveModelCatalogEntry(catalog, 'claude-haiku-4-5')?.modelId).toBe('claude-haiku-4-5-20251001');
  });

  it('returns undefined for an unknown id', () => {
    expect(resolveModelCatalogEntry(catalog, 'claude-nova-9')).toBeUndefined();
  });

  it('prices the real catalog at Opus 5.5 rates for bare and dated Opus 5.5 ids', () => {
    expect(resolveAnthropicModelEntry('claude-opus-5-5')?.pricePer1MTokensInput).toBe(4);
    expect(resolveAnthropicModelEntry('claude-opus-5-5-20260901')?.pricePer1MTokensInput).toBe(4);
    expect(resolveAnthropicModelEntry('claude-opus-5-20260701')?.pricePer1MTokensInput).toBe(5);
  });
});

describe('modelSupportsTemperature', () => {
  it('withholds temperature from the reasoning-default families', () => {
    for (const id of [
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-opus-5',
      'claude-opus-5-5',
      'claude-opus-5-5-20260901',
      'claude-sonnet-5',
      'claude-sonnet-5-5',
      'claude-sonnet-5-5-20261001',
      'claude-fable-5',
      'claude-fable-5-1',
    ]) {
      expect(modelSupportsTemperature(id)).toBe(false);
    }
  });

  it('still allows temperature on earlier models', () => {
    for (const id of [
      'claude-opus-4-6',
      'claude-opus-4-5-20251101',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5',
      'claude-haiku-4-5-20251001',
    ]) {
      expect(modelSupportsTemperature(id)).toBe(true);
    }
  });
});
