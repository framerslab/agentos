/**
 * @fileoverview OpenAI catalog coverage for the GPT-6 family, the GPT-5.6
 * repricing, and capability mapping for the reasoning families.
 *
 * The mapping cases run through OpenAIProvider.initialize, which lists models
 * from a mocked GET /v1/models, so they exercise the real
 * refreshAvailableModels filter and mapApiToModelInfo path. The mapper gives
 * GPT-5, GPT-6 and o-series models a context window and the capabilities this
 * provider can serve: tool_use, vision except on o3-mini, and chat only for
 * Responses-only models. The refresh filter admits the priced,
 * reachable o-series ids, which neither start with `gpt-` nor contain
 * `embedding`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import {
  OpenAIProvider,
  isOpenAIResponsesOnlyModel,
  openAiReasoningCapabilities,
  openAiReasoningContextWindow,
} from '../implementations/OpenAIProvider';
import { openAIModelPricing } from '../implementations/openaiPricing';

const MODEL_IDS = [
  'gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6.1-terra',
  'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6.1-sol',
  'gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.1',
  'o3', 'o4-mini', 'o3-mini', 'o3-pro', 'o1-mini', 'gpt-5-pro', 'gpt-5.3-chat-latest',
  'gpt-4o', 'gpt-4o-2024-05-13', 'gpt-4.1-nano', 'chatgpt-4o-latest', 'text-embedding-3-large',
];

function mockModelsResponse(): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve({
      object: 'list',
      data: MODEL_IDS.map(id => ({ id, object: 'model', created: 0, owned_by: 'openai' })),
    }),
    body: null,
  } as unknown as Response;
}

describe('openAiReasoningContextWindow', () => {
  it('puts the GPT-6 and GPT-5.6 families at 1.05M', () => {
    for (const id of ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra']) {
      expect(openAiReasoningContextWindow(id)).toBe(1050000);
    }
  });

  it('separates gpt-5.4 and gpt-5.4-pro (1.05M) from their 400K mini and nano siblings', () => {
    // A `gpt-5.4` prefix match would report the smaller siblings 2.6x too large.
    expect(openAiReasoningContextWindow('gpt-5.4')).toBe(1050000);
    expect(openAiReasoningContextWindow('gpt-5.4-pro')).toBe(1050000);
    expect(openAiReasoningContextWindow('gpt-5.4-2026-03-05')).toBe(1050000);
    expect(openAiReasoningContextWindow('gpt-5.4-pro-2026-03-05')).toBe(1050000);
    expect(openAiReasoningContextWindow('gpt-5.4-mini')).toBe(400000);
    expect(openAiReasoningContextWindow('gpt-5.4-nano')).toBe(400000);
  });

  it('puts gpt-5.5 at 1.05M and the older GPT-5 tiers at 400K', () => {
    expect(openAiReasoningContextWindow('gpt-5.5')).toBe(1050000);
    expect(openAiReasoningContextWindow('gpt-5.5-pro')).toBe(1050000);
    for (const id of ['gpt-5', 'gpt-5.1', 'gpt-5.2', 'gpt-5-mini', 'gpt-5-pro']) {
      expect(openAiReasoningContextWindow(id)).toBe(400000);
    }
  });

  it('puts the o-series at 200K', () => {
    for (const id of ['o1', 'o1-pro', 'o3', 'o3-mini', 'o3-pro', 'o4-mini']) {
      expect(openAiReasoningContextWindow(id)).toBe(200000);
    }
  });

  it('puts o1-mini, o1-preview and the GPT-5 chat-latest snapshots at 128K, and gpt-5.6-cyber at 400K', () => {
    for (const id of ['o1-mini', 'o1-preview', 'gpt-5-chat-latest', 'gpt-5.1-chat-latest', 'gpt-5.3-chat-latest']) {
      expect(openAiReasoningContextWindow(id)).toBe(128000);
    }
    expect(openAiReasoningContextWindow('gpt-5.6-cyber')).toBe(400000);
  });

  it('is case-insensitive', () => {
    expect(openAiReasoningContextWindow('GPT-6-SOL')).toBe(1050000);
    expect(openAiReasoningContextWindow('O3')).toBe(200000);
  });
});

describe('OpenAI model catalog mapping', () => {
  let provider: OpenAIProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async () => mockModelsResponse());
    provider = new OpenAIProvider();
    await provider.initialize({ apiKey: 'sk-test-key' });
  });

  it('advertises tool_use only where OpenAIProvider can serve tool calls', async () => {
    const toolCapable = (await provider.listAvailableModels({ capability: 'tool_use' })).map(m => m.modelId);
    // Every GPT-6 tool call, streamed or not, goes to /v1/responses.
    expect(toolCapable).toEqual(expect.arrayContaining([
      'gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.5', 'o3', 'gpt-4o',
    ]));
    // Responses-only models list as chat only.
    for (const id of ['o3-pro', 'gpt-5-pro']) {
      expect(toolCapable).not.toContain(id);
    }
  });

  it('grants vision to image-capable reasoning models', async () => {
    expect((await provider.getModelInfo('gpt-6-astra'))!.capabilities).toContain('vision_input');
    expect((await provider.getModelInfo('gpt-6.2-sol'))!.capabilities).toContain('vision_input');
    expect((await provider.getModelInfo('o3'))!.capabilities).toContain('vision_input');
  });

  it('lists Responses-only GPT-5 models as chat only', async () => {
    expect((await provider.getModelInfo('gpt-5-pro'))!.capabilities).toEqual(['chat']);
  });

  it('leaves out o-series ids it cannot call or price', async () => {
    // o3-pro is Responses-only and o1-mini has no price row, so listing them
    // would offer a model that fails when called or one that meters as free.
    const ids = (await provider.listAvailableModels()).map(m => m.modelId);
    expect(ids).not.toContain('o3-pro');
    expect(ids).not.toContain('o1-mini');
    expect(ids).toEqual(expect.arrayContaining(['o3']));
  });

  it('leaves out the models OpenAI has shut down, even when a listing names them', async () => {
    // OpenAI shut down o3-mini, o4-mini and gpt-4.1-nano on 2026-10-23 and
    // chatgpt-4o-latest on 2026-02-17, and the gpt-4o model page marks the
    // 2024-05-13 snapshot shut down: a call to any of them answers 404.
    const ids = (await provider.listAvailableModels()).map(m => m.modelId);
    for (const retired of ['o3-mini', 'o4-mini', 'gpt-4.1-nano', 'chatgpt-4o-latest', 'gpt-4o-2024-05-13']) {
      expect(ids).not.toContain(retired);
      expect(await provider.getModelInfo(retired)).toBeUndefined();
    }
    // A model with a shutdown day still to come is listed until that day.
    expect(ids).toEqual(expect.arrayContaining(['o3', 'gpt-5-pro', 'gpt-5.1', 'gpt-4o']));
  });

  it('gives reasoning models a context window', async () => {
    expect((await provider.getModelInfo('gpt-6-astra'))!.contextWindowSize).toBe(1050000);
    expect((await provider.getModelInfo('gpt-5.4-mini'))!.contextWindowSize).toBe(400000);
    expect((await provider.getModelInfo('o3'))!.contextWindowSize).toBe(200000);
    expect((await provider.getModelInfo('gpt-5.3-chat-latest'))!.contextWindowSize).toBe(128000);
  });

  it('includes the o-series in the listing', async () => {
    const ids = (await provider.listAvailableModels()).map(m => m.modelId);
    expect(ids).toEqual(expect.arrayContaining(['o3']));
  });

  it('reports ModelInfo prices per 1M tokens', async () => {
    // modelPricing is per 1K. gpt-4o is $2.50 in and $10 out per 1M on
    // OpenAI's pricing page, so an unscaled copy would read 0.0025 and 0.01.
    expect(await provider.getModelInfo('gpt-4o')).toMatchObject({
      pricePer1MTokensInput: 2.5,
      pricePer1MTokensOutput: 10,
    });
  });

  it('prices the GPT-6 family from the first-party rates', async () => {
    // A model with no row lists at 0 here and meters costUSD undefined.
    expect(await provider.getModelInfo('gpt-6-astra')).toMatchObject({
      pricePer1MTokensInput: 10,
      pricePer1MTokensOutput: 50,
    });
    expect(await provider.getModelInfo('gpt-6-sol')).toMatchObject({
      pricePer1MTokensInput: 2,
      pricePer1MTokensOutput: 10,
    });
    expect(await provider.getModelInfo('gpt-6-luna')).toMatchObject({
      pricePer1MTokensInput: 0.1,
      pricePer1MTokensOutput: 0.5,
    });
  });

  it('lists gpt-6.1-sol at $2 / $10 per 1M with a 1.05M window', async () => {
    // Released 2026-09-29 (developers.openai.com/api/docs/changelog). A model
    // with no price row lists at 0 here and meters costUSD undefined.
    expect(await provider.getModelInfo('gpt-6.1-sol')).toMatchObject({
      pricePer1MTokensInput: 2,
      pricePer1MTokensOutput: 10,
      contextWindowSize: 1050000,
    });
  });

  it('lists gpt-6.2-astra at $8 / $40 and gpt-6.2-sol at $2 / $10 per 1M, with a 1.05M window', async () => {
    // developers.openai.com/api/docs/pricing and the two model pages, read
    // 2026-11-17. Before these rows the two models listed at 0 and metered
    // costUSD undefined.
    expect(await provider.getModelInfo('gpt-6.2-astra')).toMatchObject({
      pricePer1MTokensInput: 8,
      pricePer1MTokensOutput: 40,
      contextWindowSize: 1050000,
      capabilities: ['chat', 'json_mode', 'tool_use', 'vision_input'],
    });
    expect(await provider.getModelInfo('gpt-6.2-sol')).toMatchObject({
      pricePer1MTokensInput: 2,
      pricePer1MTokensOutput: 10,
      contextWindowSize: 1050000,
      capabilities: ['chat', 'json_mode', 'tool_use', 'vision_input'],
    });
    expect(openAIModelPricing('gpt-6.2-astra')?.cachedInput).toBeCloseTo(0.0004, 10);
    expect(openAIModelPricing('gpt-6.2-sol')?.cachedInput).toBeCloseTo(0.0001, 10);
  });

  it('prices gpt-6.1-terra at $1 / $5 and gpt-5-pro at $15 / $120 per 1M', async () => {
    expect(await provider.getModelInfo('gpt-6.1-terra')).toMatchObject({
      pricePer1MTokensInput: 1,
      pricePer1MTokensOutput: 5,
    });
    expect(await provider.getModelInfo('gpt-5-pro')).toMatchObject({
      pricePer1MTokensInput: 15,
      pricePer1MTokensOutput: 120,
    });
  });

  it('keeps a snapshot that has its own row off the alias rate', () => {
    // gpt-4o-2024-05-13 kept its $5 / $15 launch price; the dated-snapshot
    // fallback alone would price it at the gpt-4o alias rate of $2.50 / $10.
    // OpenAI has shut it down, so it is priced only for a usage record.
    expect(openAIModelPricing('gpt-4o-2024-05-13')).toEqual({ input: 0.005, output: 0.015 });
  });

  it("prices gpt-5.6-sol at OpenAI's first-party rate", async () => {
    expect(await provider.getModelInfo('gpt-5.6-sol')).toMatchObject({
      pricePer1MTokensInput: 4,
      pricePer1MTokensOutput: 20,
    });
  });

  it('still maps gpt-4o and embeddings through their own branches', async () => {
    const gpt4o = await provider.getModelInfo('gpt-4o');
    expect(gpt4o!.contextWindowSize).toBe(128000);
    expect(gpt4o!.capabilities).toContain('vision_input');
    const emb = await provider.getModelInfo('text-embedding-3-large');
    expect(emb!.capabilities).toContain('embeddings');
    expect(emb!.embeddingDimension).toBe(3072);
  });
});

describe('openAiReasoningCapabilities', () => {
  it('limits capabilities to what the provider can serve', () => {
    expect(openAiReasoningCapabilities('gpt-5.6-sol')).toEqual(['chat', 'json_mode', 'tool_use', 'vision_input']);
    expect(openAiReasoningCapabilities('gpt-6-astra')).toEqual(['chat', 'json_mode', 'tool_use', 'vision_input']);
    expect(openAiReasoningCapabilities('o3-mini')).toEqual(['chat', 'json_mode', 'tool_use']);
    expect(openAiReasoningCapabilities('o1-mini')).toEqual(['chat']);
    for (const id of ['gpt-5-pro', 'gpt-5.5-pro', 'o3-pro', 'o3-pro-2025-06-10', 'gpt-5.3-codex', 'gpt-5.1-codex-max', 'gpt-5.6-cyber']) {
      expect(isOpenAIResponsesOnlyModel(id)).toBe(true);
      expect(openAiReasoningCapabilities(id)).toEqual(['chat']);
    }
    expect(isOpenAIResponsesOnlyModel('gpt-5.4')).toBe(false);
  });
});

describe('OpenAI cost metering', () => {
  it('prices a completion whose response names a dated snapshot', async () => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/models')) return mockModelsResponse();
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'application/json' }),
        body: null,
        json: () => Promise.resolve({
          id: 'chatcmpl-refresh',
          object: 'chat.completion',
          created: 1,
          // OpenAI names the dated snapshot that served the call, and usage is
          // costed from this id.
          model: 'gpt-5.4-mini-2026-03-17',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000 },
        }),
      } as unknown as Response;
    });
    const provider = new OpenAIProvider();
    await provider.initialize({ apiKey: 'sk-test-key' });

    const res = await provider.generateCompletion('gpt-5.4-mini', [{ role: 'user', content: 'hi' }], {});

    // gpt-5.4-mini is $0.75 in and $4.50 out per 1M, so 1K tokens each is $0.00525.
    expect(res.usage?.costUSD).toBeCloseTo(0.00525, 6);
  });
});
