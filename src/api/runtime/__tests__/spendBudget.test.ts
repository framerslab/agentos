import { describe, expect, it, vi } from 'vitest';

import { CostCapExceededError, CostGuard } from '../../../safety/runtime/CostGuard.js';
import {
  SpendBudget,
  UnpricedModelError,
  asSpendBudget,
  costOfUsageUSD,
  estimateCallCostUSD,
  promptCharsOf,
} from '../spendBudget.js';

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

describe('the estimates', () => {
  it("prices a gpt-6-luna call at its row's rates: 1,000 prompt tokens and a 1,000-token cap", () => {
    expect(estimateCallCostUSD('openai', 'gpt-6-luna', 4000, 1000)).toBeCloseTo(0.0006, 10);
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

  it('counts the characters of the messages and the system prompt', () => {
    expect(promptCharsOf([{ role: 'user', content: 'hello' }], 'be brief')).toBeGreaterThan(13);
  });
});
