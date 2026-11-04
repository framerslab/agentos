/**
 * @fileoverview OpenAI prompt-cache billing in the cost a call reports.
 *
 * OpenAI bills cached input at its own rate (gpt-6-sol: $0.20 against $2 input per 1M), a cache write with the
 * default 30-minute lifetime at 1.25x input and one with the 12-hour lifetime at 2.5x input, on GPT-5.6 and later
 * (https://developers.openai.com/api/docs/pricing and
 * https://developers.openai.com/api/docs/guides/prompt-caching, both read 2026-11-04). The Responses API splits the
 * writes by lifetime in `input_tokens_details.cache_write_tokens_details` (`ttl_30m_tokens`, `ttl_12h_tokens`), and
 * `cached_tokens` and `cache_write_tokens` do not overlap, so ordinary input is `input_tokens - cached_tokens -
 * cache_write_tokens`.
 *
 * The cases run the real OpenAIProvider, and generateText on top of it, with only fetch stubbed, and read costUSD from
 * the usage each path reports.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { generateText } from '../../../../api/generateText';
import { SpendBudget } from '../../../../api/runtime/spendBudget';
import { globalLLMProviderHealth } from '../../../safety/LLMProviderHealthRegistry';
import { OpenAIProvider } from '../implementations/OpenAIProvider';

/** Ids the mocked GET /v1/models lists. */
const LISTED_MODELS = ['gpt-6-sol', 'gpt-4.1'];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Answers every GET with the model listing and each POST from the handler whose endpoint the URL ends with. */
function serve(posts: Record<string, () => Response>): void {
  fetchMock.mockImplementation(async (url: unknown, init?: { method?: string }) => {
    const target = String(url);
    if ((init?.method ?? 'GET') === 'GET') {
      return jsonResponse({ object: 'list', data: LISTED_MODELS.map((id) => ({ id, object: 'model', created: 1, owned_by: 'openai' })) });
    }
    const handler = Object.entries(posts).find(([endpoint]) => target.endsWith(endpoint))?.[1];
    return handler ? handler() : jsonResponse({ error: { message: `unexpected POST ${target}`, type: 'invalid_request_error' } }, 404);
  });
}

/** A Chat Completions body whose usage reports the given counts. */
function chatCompletion(model: string, usage: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'chatcmpl-cache-pricing',
    object: 'chat.completion',
    created: 1,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  globalLLMProviderHealth.reset();
});

describe("OpenAIProvider's reported cost of cached input and cache writes", () => {
  it.each([
    // 200 x $2 + 800 x $0.20 + 1,000 x $10 per 1M: the 800 read are billed at the cached-input rate.
    ['gpt-6-sol', { prompt_tokens: 1_000, completion_tokens: 1_000, total_tokens: 2_000, prompt_tokens_details: { cached_tokens: 800 } }, 0.01056],
    // gpt-4.1: $2 input, $0.50 cached input and $8 output per 1M: 200 x $2 + 800 x $0.50 + 1,000 x $8.
    ['gpt-4.1', { prompt_tokens: 1_000, completion_tokens: 1_000, total_tokens: 2_000, prompt_tokens_details: { cached_tokens: 800 } }, 0.0088],
    // 400 ordinary x $2 + 600 written for 30 minutes x $2.50 per 1M: a write the report gives no lifetime for is
    // billed at the default lifetime's rate.
    ['gpt-6-sol', { prompt_tokens: 1_000, completion_tokens: 0, total_tokens: 1_000, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 600 } }, 0.0023],
    // Over 272,000 prompt tokens every rate doubles and output is 1.5x: 100,000 x $4 + 300,000 x $0.40 + 2,000 x $15.
    ['gpt-6-sol', { prompt_tokens: 400_000, completion_tokens: 2_000, total_tokens: 402_000, prompt_tokens_details: { cached_tokens: 300_000 } }, 0.55],
  ] as Array<[string, Record<string, unknown>, number]>)('%s with usage %j costs %f USD', async (model, usage, usd) => {
    serve({ '/chat/completions': () => jsonResponse(chatCompletion(model, usage)) });
    const provider = new OpenAIProvider();
    await provider.initialize({ apiKey: 'sk-cache-pricing', maxRetries: 1 });

    const res = await provider.generateCompletion(model, [{ role: 'user', content: 'hi' }], {});

    expect(res.usage?.costUSD).toBeCloseTo(usd, 9);
  });

  it('bills the 12-hour writes a /v1/responses usage names at 2.5x input, carries their count, and charges the budget that cost', async () => {
    // OpenAI's own example usage (the prompt-caching guide, "Input usage fields with both write lifetimes"): 12,000
    // input tokens, 4,000 read, 7,000 written, 3,000 of them for 30 minutes and 4,000 for 12 hours.
    serve({
      '/responses': () =>
        jsonResponse({
          id: 'resp_cache_pricing',
          object: 'response',
          created_at: 1,
          model: 'gpt-6-sol',
          status: 'completed',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] }],
          usage: {
            input_tokens: 12_000,
            output_tokens: 0,
            total_tokens: 12_000,
            input_tokens_details: {
              cached_tokens: 4_000,
              cache_write_tokens: 7_000,
              cache_write_tokens_details: { ttl_30m_tokens: 3_000, ttl_12h_tokens: 4_000 },
            },
          },
        }),
    });
    const budget = new SpendBudget({ maxCostUSD: 1 });

    const result = await generateText({
      provider: 'openai',
      model: 'gpt-6-sol',
      apiKey: 'sk-cache-pricing-responses',
      prompt: 'Use the tool if you need it.',
      tools: {
        lookup: {
          description: 'Looks up a passage.',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
          execute: async () => ({ passage: 'none' }),
        },
      },
      effort: 'high',
      fallbackProviders: [],
      budget,
    });

    expect(result.text).toBe('Done.');
    // 1,000 x $2 + 4,000 x $0.20 + 3,000 x $2.50 + 4,000 x $5 per 1M.
    const usd = (1_000 * 2 + 4_000 * 0.2 + 3_000 * 2.5 + 4_000 * 5) / 1e6;
    expect(result.usage.costUSD).toBeCloseTo(usd, 12);
    expect(result.usage.cacheCreationTokens).toBe(7_000);
    expect(result.usage.cacheCreationExtendedTokens).toBe(4_000);
    expect(budget.spentUSD()).toBeCloseTo(usd, 12);
  });
});
