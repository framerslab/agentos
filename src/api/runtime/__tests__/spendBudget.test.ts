import { describe, expect, it, vi } from 'vitest';

import { CostCapExceededError, CostGuard } from '../../../safety/runtime/CostGuard.js';
import {
  SpendBudget,
  UnpricedModelError,
  asSpendBudget,
  assertCallWithinBudget,
  bothBudgets,
  costOfUsageUSD,
  estimateCallCostUSD,
  promptCharsOf,
} from '../spendBudget.js';
import { modelPricing, registerModelPricing } from '../modelPricing.js';

/** The error a call throws, or undefined when it throws none. */
function thrownBy(call: () => void): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('SpendBudget', () => {
  it('lets a call through while its estimate fits what is left, and refuses the one that would pass the cap', () => {
    const budget = new SpendBudget({ maxCostUSD: 0.001 });
    expect(() => budget.assertCanSpend(0.0004, 10, 'first')).not.toThrow();
    budget.record(0.0008, 10, 'first');
    expect(budget.spentUSD()).toBeCloseTo(0.0008, 10);
    expect(() => budget.assertCanSpend(0.0004, 10, 'second')).toThrow(CostCapExceededError);
  });

  it('shares its spending with every budget on the same guard and id', () => {
    const guard = new CostGuard({ maxDailyCostUsd: 100, maxSingleOperationCostUsd: 100 });
    const a = asSpendBudget({ maxCostUSD: 0.001, guard, budgetId: 'run-1' });
    const b = asSpendBudget({ maxCostUSD: 0.001, guard, budgetId: 'run-1' });
    a?.record(0.0009, 0, 'a');
    expect(() => b?.assertCanSpend(0.0002, 0, 'b')).toThrow(CostCapExceededError);
    expect(guard.getSnapshot('run-1').sessionCostUsd).toBeCloseTo(0.0009, 10);
  });

  it('keeps the daily cap its guard holds for its id', () => {
    // setAgentLimits replaces an id's limits, so a budget that set its session cap alone would lift the id's daily cap.
    const guard = new CostGuard({ maxDailyCostUsd: 100, maxSingleOperationCostUsd: 100 });
    guard.setAgentLimits('run-2', { maxDailyCostUsd: 0.001 });
    const budget = new SpendBudget({ maxCostUSD: 1, guard, budgetId: 'run-2' });
    expect(guard.getSnapshot('run-2')).toMatchObject({ sessionLimit: 1, dailyLimit: 0.001 });
    budget.record(0.0009, 0, 'first');
    expect(() => budget.assertCanSpend(0.0002, 0, 'second')).toThrow(CostCapExceededError);
  });

  it('warns and lets the call run when told to warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const budget = new SpendBudget({ maxCostUSD: 0.0001, onLimitReached: 'warn' });
    expect(() => budget.assertCanSpend(0.001, 0, 'call')).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('tells a callback what was refused, then refuses', () => {
    const seen: string[] = [];
    const budget = new SpendBudget({ maxCostUSD: 0.0001, onLimitReached: (info) => seen.push(`${info.capType} ${info.what}`) });
    expect(() => budget.assertCanSpend(0.001, 0, 'generate_text.step')).toThrow(CostCapExceededError);
    expect(seen).toEqual(['session generate_text.step']);
  });

  it('refuses a call whose output cap would pass the token budget', () => {
    const budget = new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 1000 });
    budget.record(0, 900, 'first');
    expect(() => budget.assertCanSpend(0, 200, 'second')).toThrow(CostCapExceededError);
  });

  it("names the cap that refused a call, with that cap's own numbers", () => {
    // The token cap has no cap type of its own: its refusal is the cap error, with a message that names the token cap.
    const byTokens = new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 1000 });
    byTokens.record(0.0001, 900, 'first');
    expect(thrownBy(() => byTokens.assertCanSpend(0, 200, 'second'))).toMatchObject({
      name: 'CostCapExceededError',
      message: expect.stringContaining('1100 tokens would pass 1000'),
    });
    // The guard's daily cap and its single-operation cap: the total and the limit of the cap that refused, where the
    // run's own total is nothing (its session starts again) and its own cap is one dollar.
    const guard = new CostGuard({ maxDailyCostUsd: 0.01, maxSingleOperationCostUsd: 0.005 });
    const budget = new SpendBudget({ maxCostUSD: 1, guard, budgetId: 'run-3' });
    budget.record(0.009, 0, 'first');
    guard.resetSession('run-3');
    expect(budget.spentUSD()).toBe(0);
    expect(thrownBy(() => budget.assertCanSpend(0.002, 0, 'second'))).toMatchObject({ capType: 'daily', currentCost: 0.009, limit: 0.01 });
    expect(thrownBy(() => budget.assertCanSpend(0.006, 0, 'third'))).toMatchObject({ capType: 'single_operation', currentCost: 0.006, limit: 0.005 });
  });

  it('counts a token count the provider reported as NaN as none, so the token budget still holds', () => {
    const budget = new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 1000 });
    budget.record(0, Number.NaN, 'first');
    budget.record(0, 900, 'second');
    expect(budget.tokensUsed()).toBe(900);
    expect(() => budget.assertCanSpend(0, 200, 'third')).toThrow(CostCapExceededError);
  });

  it('refuses a model with no price row unless told to allow it, and then counts it as nothing', () => {
    const refusing = new SpendBudget({ maxCostUSD: 1 });
    expect(() => refusing.assertCanSpend(undefined, 10, 'call')).toThrow(UnpricedModelError);
    const allowing = new SpendBudget({ maxCostUSD: 1, unpriced: 'allow' });
    expect(() => allowing.assertCanSpend(undefined, 10, 'call')).not.toThrow();
    allowing.record(undefined, 10, 'call');
    expect(allowing.spentUSD()).toBe(0);
  });

  it('still holds the token budget and a spent budget for a model it allows without a price', () => {
    const byTokens = new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 1000, unpriced: 'allow' });
    byTokens.record(undefined, 900, 'first');
    expect(() => byTokens.assertCanSpend(undefined, 200, 'second')).toThrow(CostCapExceededError);
    const spent = new SpendBudget({ maxCostUSD: 0.001, unpriced: 'allow' });
    spent.record(0.002, 0, 'a cost the provider reported');
    expect(() => spent.assertCanSpend(undefined, 0, 'next')).toThrow(CostCapExceededError);
  });

  it('records a cost made outside a provider call', () => {
    const budget = new SpendBudget({ maxCostUSD: 0.01 });
    budget.recordExternal(0.0095, 'stt');
    expect(() => budget.assertCanSpend(0.001, 0, 'next')).toThrow(CostCapExceededError);
  });
});

describe('bothBudgets', () => {
  it('charges a total two budgets share by guard and id once for each call and each outside cost, and lets each count the tokens', () => {
    const guard = new CostGuard({ maxDailyCostUsd: 100, maxSingleOperationCostUsd: 100 });
    // A launch's budget draws on the host's; the member's own is another budget on the host's guard and id.
    const host = new SpendBudget({ maxCostUSD: 5, guard, budgetId: 'account' });
    const launch = new SpendBudget({ maxCostUSD: 5, parent: host });
    const own = new SpendBudget({ maxCostUSD: 5, guard, budgetId: 'account' });
    const turn = bothBudgets(launch, own);

    turn.record(0.3, 15, 'gmi.step');
    expect(guard.getSnapshot('account').sessionCostUsd).toBeCloseTo(0.3, 10);
    expect(launch.spentUSD()).toBeCloseTo(0.3, 10);
    expect([launch.tokensUsed(), host.tokensUsed(), own.tokensUsed()]).toEqual([15, 15, 15]);

    turn.recordExternal(0.2, 'stt');
    expect(guard.getSnapshot('account').sessionCostUsd).toBeCloseTo(0.5, 10);
    expect(launch.spentUSD()).toBeCloseTo(0.5, 10);
  });
});

describe('the estimates', () => {
  it("prices a gpt-6-luna call at its row's rates: 1,000 prompt tokens and a 1,000-token cap", () => {
    expect(estimateCallCostUSD('openai', 'gpt-6-luna', 4000, 1000)).toBeCloseTo(0.0006, 10);
  });

  it("counts an output cap above the model's ceiling at the ceiling, as the request is sent", () => {
    // gpt-4o writes at most 16,384 tokens, and OpenAIProvider sends a cap of 32,000 as 16,384: 1,000 prompt tokens at
    // 0.0025 and 16,384 output tokens at 0.01 per 1K.
    expect(estimateCallCostUSD('openai', 'gpt-4o', 4000, 32_000)).toBeCloseTo(0.0025 + 0.16384, 10);
    // 1,000 + 16,384 tokens fit a token budget of 20,000, where 1,000 + 32,000 would not.
    const budget = new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 20_000 });
    expect(() => assertCallWithinBudget(budget, { providerId: 'openai', modelId: 'gpt-4o' }, 4000, 32_000, 'call')).not.toThrow();
  });

  it('knows no price for a provider or model the table does not hold', () => {
    expect(estimateCallCostUSD('openai', 'no-such-model', 4000, 1000)).toBeUndefined();
    expect(estimateCallCostUSD('ollama', 'llama3', 4000, 1000)).toBeUndefined();
  });

  it("takes a provider's reported cost first, else the tokens at the table's rates", () => {
    expect(costOfUsageUSD('openai', 'gpt-6-luna', { promptTokens: 1000, completionTokens: 1000, costUSD: 0.5 })).toBe(0.5);
    expect(costOfUsageUSD('openai', 'gpt-6-luna', { promptTokens: 1000, completionTokens: 1000 })).toBeCloseTo(0.0006, 10);
    expect(costOfUsageUSD('openai', 'text-embedding-3-small', { promptTokens: 1000 }, true)).toBeCloseTo(0.00002, 12);
  });

  it('prices the tokens when the reported cost is not a number zero or more, which a budget would record as nothing', () => {
    for (const costUSD of [Number.NaN, Number.POSITIVE_INFINITY, -0.5]) {
      expect(costOfUsageUSD('openai', 'gpt-6-luna', { promptTokens: 1000, completionTokens: 1000, costUSD }), String(costUSD)).toBeCloseTo(0.0006, 10);
    }
    const budget = new SpendBudget({ maxCostUSD: 0.001 });
    budget.record(costOfUsageUSD('openai', 'gpt-6-luna', { promptTokens: 1000, completionTokens: 1000, costUSD: Number.NaN }), 2000, 'call');
    expect(budget.spentUSD()).toBeCloseTo(0.0006, 10);
  });

  it("prices an Anthropic call at its row's rates, so a budget admits it instead of refusing it as unpriced", () => {
    // claude-sonnet-4-6: $3 input and $15 output per MTok (https://platform.claude.com/docs/en/about-claude/pricing,
    // read 2026-11-04). 4,000 characters are 1,000 prompt tokens at four characters a token.
    expect(estimateCallCostUSD('anthropic', 'claude-sonnet-4-6', 4000, 1000)).toBeCloseTo(0.003 + 0.015, 10);
    const budget = new SpendBudget({ maxCostUSD: 1 });
    expect(() => assertCallWithinBudget(budget, { providerId: 'anthropic', modelId: 'claude-sonnet-4-6' }, 4000, 1000, 'call')).not.toThrow();
    expect(() => assertCallWithinBudget(budget, { providerId: 'anthropic', modelId: 'claude-x' }, 4000, 1000, 'call')).toThrow(UnpricedModelError);
  });

  it("prices an Anthropic call's reported usage, at the long-context rates over the threshold", () => {
    expect(costOfUsageUSD('anthropic', 'claude-sonnet-4-6', { promptTokens: 1000, completionTokens: 1000 })).toBeCloseTo(0.018, 10);
    // claude-haiku-5-5 over 100,000 prompt tokens: $0.50 input and $2.50 output per MTok.
    expect(costOfUsageUSD('anthropic', 'claude-haiku-5-5', { promptTokens: 200_000, completionTokens: 1000 })).toBeCloseTo(0.1 + 0.0025, 10);
    expect(costOfUsageUSD('anthropic', 'claude-haiku-5-5', { promptTokens: 1000, completionTokens: 1000 })).toBeCloseTo(0.0001 + 0.0005, 10);
  });

  it("prices the cache reads and writes of usage with no reported cost, which an Anthropic report keeps out of its prompt tokens", () => {
    // A model the catalog lacks, priced by the host's table, so the provider reports no cost: $3 input, $0.30 cache
    // read, $6 cache write and $15 output per MTok; over 10,000 prompt tokens, twice that. The row names one write rate
    // and no default-lifetime rate, so every write is priced at that one.
    registerModelPricing('anthropic', (id) =>
      id === 'claude-host-1'
        ? {
            inputPerMTokUSD: 3,
            outputPerMTokUSD: 15,
            cacheReadPerMTokUSD: 0.3,
            cacheWritePerMTokUSD: 6,
            longContext: { thresholdTokens: 10_000, inputPerMTokUSD: 6, outputPerMTokUSD: 30, cacheReadPerMTokUSD: 0.6, cacheWritePerMTokUSD: 12 },
          }
        : undefined,
    );
    try {
      // AnthropicProvider's report: `promptTokens` is `input_tokens`, which leaves out the cache; the inclusive total
      // adds the 2,000 read and the 1,000 written back.
      const usage = { promptTokens: 100, completionTokens: 100, cacheReadInputTokens: 2_000, cacheCreationInputTokens: 1_000, inclusiveInputTokens: 3_100 };
      expect(costOfUsageUSD('anthropic', 'claude-host-1', usage)).toBeCloseTo((100 * 3 + 2_000 * 0.3 + 1_000 * 6 + 100 * 15) / 1e6, 12);
      // A report with no inclusive total: Anthropic's prompt tokens leave the cache out, so the cache is added to them.
      const bare = { promptTokens: 100, completionTokens: 100, cacheReadInputTokens: 2_000, cacheCreationInputTokens: 1_000 };
      expect(costOfUsageUSD('anthropic', 'claude-host-1', bare)).toBeCloseTo((100 * 3 + 2_000 * 0.3 + 1_000 * 6 + 100 * 15) / 1e6, 12);
      // A run's totals carry the same counts under the names generateText sums them as.
      const totals = { promptTokens: 100, completionTokens: 100, cacheReadTokens: 2_000, cacheCreationTokens: 1_000, inclusiveInputTokens: 3_100 };
      expect(costOfUsageUSD('anthropic', 'claude-host-1', totals)).toBeCloseTo((100 * 3 + 2_000 * 0.3 + 1_000 * 6 + 100 * 15) / 1e6, 12);
      // The cache counts toward the long-context threshold: 100 prompt tokens and 20,000 read is a 20,100-token prompt.
      const long = { promptTokens: 100, completionTokens: 100, cacheReadInputTokens: 20_000, inclusiveInputTokens: 20_100 };
      expect(costOfUsageUSD('anthropic', 'claude-host-1', long)).toBeCloseTo((100 * 6 + 20_000 * 0.6 + 100 * 30) / 1e6, 12);
    } finally {
      registerModelPricing('anthropic', () => undefined);
    }
    // OpenAI's prompt tokens hold its cached tokens, and its inclusive total is its prompt tokens. gpt-6-sol bills $2
    // input, $0.20 cached input and $10 output per MTok (https://developers.openai.com/api/docs/pricing, read
    // 2026-11-04): 200 tokens at $2, the 800 read at $0.20 and 1,000 output at $10 is $0.01056, not the $0.012 the
    // prompt costs at the input rate.
    expect(
      costOfUsageUSD('openai', 'gpt-6-sol', { promptTokens: 1_000, completionTokens: 1_000, cacheReadInputTokens: 800, inclusiveInputTokens: 1_000 }),
    ).toBeCloseTo((200 * 2 + 800 * 0.2 + 1_000 * 10) / 1e6, 12);
  });

  it("carries OpenAI's cached-input rate on every model its pricing page lists one for, doubled over 272,000 tokens", () => {
    // https://developers.openai.com/api/docs/pricing, standard tier, read 2026-11-04 (USD per MTok).
    const listed: Array<[string, number]> = [
      ['gpt-6-astra', 1],
      ['gpt-6.1-sol', 0.1],
      ['gpt-6-luna', 0.01],
      ['gpt-6-sol', 0.2],
      ['gpt-5.6-sol', 0.4],
      ['gpt-5.6-terra', 0.2],
      ['gpt-5.6-luna', 0.02],
      ['gpt-5.5', 0.5],
      ['gpt-5.4', 0.25],
      ['gpt-5.4-mini', 0.075],
      ['gpt-5.4-nano', 0.02],
      ['gpt-5.3-codex', 0.175],
      ['gpt-5.2', 0.175],
      ['gpt-5.1', 0.125],
      ['gpt-5', 0.125],
      ['gpt-5-mini', 0.025],
      ['gpt-5-nano', 0.005],
      ['gpt-4.1', 0.5],
      ['gpt-4.1-mini', 0.1],
      ['gpt-4o', 1.25],
      ['gpt-4o-mini', 0.075],
      ['o3', 0.5],
    ];
    for (const [model, cached] of listed) {
      expect(modelPricing('openai', model)?.cacheReadPerMTokUSD, model).toBeCloseTo(cached, 12);
    }
    // A dated snapshot without a row of its own takes its base model's.
    expect(modelPricing('openai', 'gpt-6-sol-2026-09-03')?.cacheReadPerMTokUSD).toBeCloseTo(0.2, 12);
    // The long-context card doubles the cached-input rate as it doubles the input rate.
    expect(modelPricing('openai', 'gpt-6-sol')?.longContext?.cacheReadPerMTokUSD).toBeCloseTo(0.4, 12);
    // The page lists no cached-input rate for the pro models: their reads are billed as input.
    expect(modelPricing('openai', 'gpt-5.5-pro')?.cacheReadPerMTokUSD).toBeUndefined();
    expect(modelPricing('openai', 'o3-pro')?.cacheReadPerMTokUSD).toBeUndefined();
  });

  it("prices an Anthropic cache write at the 5-minute rate when the report gives no lifetime, and the 1-hour share at the 1-hour rate", () => {
    // claude-sonnet-4-6: $3 input per MTok; a 5-minute write is 1.25x ($3.75), a 1-hour write 2x ($6)
    // (https://platform.claude.com/docs/en/about-claude/pricing, read 2026-11-04). The default lifetime is 5 minutes
    // (https://platform.claude.com/docs/en/build-with-claude/prompt-caching).
    const written = { promptTokens: 0, completionTokens: 0, cacheCreationInputTokens: 1_000_000 };
    // No split: the write is priced at the rate Anthropic bills by default, the 5-minute one.
    expect(costOfUsageUSD('anthropic', 'claude-sonnet-4-6', written)).toBeCloseTo(3.75, 12);
    // usage.cache_creation { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 0 }.
    expect(costOfUsageUSD('anthropic', 'claude-sonnet-4-6', { ...written, cacheCreationExtendedInputTokens: 0 })).toBeCloseTo(3.75, 12);
    // Every token written for an hour.
    expect(costOfUsageUSD('anthropic', 'claude-sonnet-4-6', { ...written, cacheCreationExtendedInputTokens: 1_000_000 })).toBeCloseTo(6, 12);
    // 600,000 for 5 minutes and 400,000 for an hour: 0.6 x $3.75 + 0.4 x $6.
    expect(costOfUsageUSD('anthropic', 'claude-sonnet-4-6', { ...written, cacheCreationExtendedInputTokens: 400_000 })).toBeCloseTo(2.25 + 2.4, 12);
    // A run's totals carry the count under the name generateText sums it as.
    expect(
      costOfUsageUSD('anthropic', 'claude-sonnet-4-6', { promptTokens: 0, completionTokens: 0, cacheCreationTokens: 1_000_000, cacheCreationExtendedTokens: 400_000 }),
    ).toBeCloseTo(2.25 + 2.4, 12);
    // A 1-hour count above the write total is held to the total.
    expect(costOfUsageUSD('anthropic', 'claude-sonnet-4-6', { ...written, cacheCreationExtendedInputTokens: 2_000_000 })).toBeCloseTo(6, 12);
    // The card names both rates.
    expect(modelPricing('anthropic', 'claude-sonnet-4-6')).toMatchObject({ defaultCacheWritePerMTokUSD: 3.75, cacheWritePerMTokUSD: 6 });
  });

  it("prices an OpenAI cache write at the 30-minute rate, and the 12-hour share the report names at the 12-hour rate", () => {
    // gpt-6-sol: $2 input, a 30-minute write $2.50 and a 12-hour write $5 per MTok
    // (https://developers.openai.com/api/docs/pricing, read 2026-11-04). 1,000 prompt tokens, all of them written.
    const written = { promptTokens: 1_000, completionTokens: 0, cacheCreationInputTokens: 1_000, inclusiveInputTokens: 1_000 };
    expect(costOfUsageUSD('openai', 'gpt-6-sol', written)).toBeCloseTo((1_000 * 2.5) / 1e6, 12);
    // cache_write_tokens_details { ttl_30m_tokens: 600, ttl_12h_tokens: 400 }.
    expect(costOfUsageUSD('openai', 'gpt-6-sol', { ...written, cacheCreationExtendedInputTokens: 400 })).toBeCloseTo((600 * 2.5 + 400 * 5) / 1e6, 12);
  });

  it("keeps a bill the provider's API reported over the host's row, and the host's row over a cost the OpenAI client computed", () => {
    // Every provider built on the OpenAI client: Groq, LiteLLM, Mistral, Together and xAI send through it, and MiniMax
    // extends it. Each reports OpenAI's list price for an id OpenAI's table holds.
    const throughOpenAI = ['groq', 'litellm', 'mistral', 'together', 'xai', 'minimax'];
    registerModelPricing('openrouter', (id) => (id === 'vendor/model' ? { inputPerMTokUSD: 1, outputPerMTokUSD: 2 } : undefined));
    for (const provider of throughOpenAI) {
      registerModelPricing(provider, (id) => (id === 'gpt-4o' ? { inputPerMTokUSD: 1, outputPerMTokUSD: 2 } : undefined));
    }
    try {
      // OpenRouter's `usage.cost` is what it charged: it stands.
      expect(costOfUsageUSD('openrouter', 'vendor/model', { promptTokens: 1000, completionTokens: 1000, costUSD: 0.5 })).toBe(0.5);
      for (const provider of throughOpenAI) {
        expect(costOfUsageUSD(provider, 'gpt-4o', { promptTokens: 1000, completionTokens: 1000, costUSD: 0.0125 })).toBeCloseTo(0.003, 12);
        // With no row of the host's, that reported cost is the one there is.
        expect(costOfUsageUSD(provider, 'other', { promptTokens: 1000, completionTokens: 1000, costUSD: 0.0125 })).toBe(0.0125);
      }
    } finally {
      for (const provider of ['openrouter', ...throughOpenAI]) registerModelPricing(provider, () => undefined);
    }
  });

  it('estimates a call at the long-context card once its assumed prompt tokens pass the threshold', () => {
    // claude-haiku-5-5: 800,000 characters are 200,000 tokens at four a token, over its 100,000, where it bills $0.50
    // input and $2.50 output per MTok (https://platform.claude.com/docs/en/about-claude/pricing, read 2026-11-04).
    expect(estimateCallCostUSD('anthropic', 'claude-haiku-5-5', 800_000, 1000)).toBeCloseTo(0.1 + 0.0025, 10);
    expect(estimateCallCostUSD('anthropic', 'claude-haiku-5-5', 4000, 1000)).toBeCloseTo(0.0001 + 0.0005, 10);
    // gpt-6-sol: 1,200,000 characters are 300,000 tokens, over 272,000, where it bills $4 and $15.
    expect(estimateCallCostUSD('openai', 'gpt-6-sol', 1_200_000, 1000)).toBeCloseTo(1.2 + 0.015, 10);
    expect(estimateCallCostUSD('openai', 'gpt-6-sol', 4000, 1000)).toBeCloseTo(0.002 + 0.01, 10);
  });

  it("prices OpenAI's reported usage over 272,000 prompt tokens at the long-context rates, as OpenAIProvider bills it", () => {
    // gpt-6-sol over 272K input tokens: $4 input and $15 output per MTok (https://developers.openai.com/api/docs/pricing,
    // read 2026-11-04), twice and one and a half times its $2 and $10.
    expect(costOfUsageUSD('openai', 'gpt-6-sol', { promptTokens: 300_000, completionTokens: 1000 })).toBeCloseTo(1.2 + 0.015, 10);
    expect(costOfUsageUSD('openai', 'gpt-6-sol', { promptTokens: 272_000, completionTokens: 1000 })).toBeCloseTo(0.544 + 0.01, 10);
  });

  it('counts the characters of the messages and the system prompt', () => {
    expect(promptCharsOf([{ role: 'user', content: 'hello' }], 'be brief')).toBeGreaterThan(13);
  });
});
