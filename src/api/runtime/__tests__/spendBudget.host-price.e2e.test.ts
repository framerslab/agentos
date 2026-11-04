/**
 * @file spendBudget.host-price.e2e.test.ts
 * A call is charged at the rate it was estimated at. A provider that sends its calls through the OpenAI provider
 * (LiteLLM, Groq, Mistral, Together, xAI) reports OpenAI's list price for a model id OpenAI's table holds, which is
 * not what the gateway or the vendor bills; where the host registered a price for that provider, the budget checks
 * the call at the host's rate before it is sent and charges it at the same rate after.
 *
 * Drives a real LiteLLMProvider through the metered provider a launched team's seat calls through, with only fetch
 * stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LiteLLMProvider } from '../../../core/llm/providers/implementations/LiteLLMProvider.js';
import { meteredProvider } from '../agencyLaunch/meteredProviderManager.js';
import { registerModelPricing } from '../modelPricing.js';
import { SpendBudget } from '../spendBudget.js';

const BASE_URL = 'http://litellm.test/v1';

/** The proxy's answers: an empty model list at initialization, then one chat completion billed 1,000 and 1,000 tokens. */
function proxyAnswer(url: string): Response {
  if (url.endsWith('/models')) {
    return new Response(JSON.stringify({ object: 'list', data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(
    JSON.stringify({
      id: 'chatcmpl_1',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-4o-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => proxyAnswer(String(input instanceof Request ? input.url : input))),
  );
});

afterEach(() => {
  registerModelPricing('litellm', () => undefined);
  vi.unstubAllGlobals();
});

describe('a call through a gateway the host prices', () => {
  it("charges a LiteLLM call at the host's rate for LiteLLM, not the OpenAI list price its client computes", async () => {
    // The host prices gpt-4o-mini behind its LiteLLM proxy at $1 input and $2 output per MTok; OpenAI's list price is
    // $0.15 and $0.60, which the OpenAI client LiteLLMProvider sends through reports as the call's cost.
    registerModelPricing('litellm', (id) => (id === 'gpt-4o-mini' ? { inputPerMTokUSD: 1, outputPerMTokUSD: 2 } : undefined));
    const litellm = new LiteLLMProvider();
    await litellm.initialize({ apiKey: 'litellm-test-key', baseURL: BASE_URL });
    const budget = new SpendBudget({ maxCostUSD: 1 });

    const response = await meteredProvider(litellm, budget, 'test.gateway').generateCompletion(
      'gpt-4o-mini',
      [{ role: 'user', content: 'hi' }],
      { maxTokens: 1000 },
    );

    expect(vi.mocked(globalThis.fetch).mock.calls.map(([url]) => String(url))).toContain(`${BASE_URL}/chat/completions`);
    expect(response.usage?.costUSD).toBeCloseTo((1000 * 0.15 + 1000 * 0.6) / 1e6, 12);
    expect(budget.spentUSD()).toBeCloseTo((1000 * 1 + 1000 * 2) / 1e6, 12);
  });

  it("keeps charging OpenAI's list price for a LiteLLM call when the host registered no price for LiteLLM", async () => {
    const litellm = new LiteLLMProvider();
    await litellm.initialize({ apiKey: 'litellm-test-key', baseURL: BASE_URL });
    // With no row the budget cannot check the call before it is sent; it lets it run and charges what it reports.
    const budget = new SpendBudget({ maxCostUSD: 1, unpriced: 'allow' });

    await meteredProvider(litellm, budget, 'test.gateway').generateCompletion('gpt-4o-mini', [{ role: 'user', content: 'hi' }], { maxTokens: 1000 });

    expect(budget.spentUSD()).toBeCloseTo((1000 * 0.15 + 1000 * 0.6) / 1e6, 12);
  });
});
