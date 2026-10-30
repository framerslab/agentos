/**
 * A budget drawing on a parent: the parent checks first and receives every record; a refusal by any
 * budget above runs the child's own onLimitReached function before the error goes on; remaining() never goes
 * below zero. Pure logic: the launch builds its child budgets on it.
 */
import { describe, expect, it, vi } from 'vitest';
import { CostCapExceededError, CostGuard } from '../../../safety/runtime/CostGuard.js';
import { DEFAULT_OUTPUT_ESTIMATE_TOKENS, SpendBudget, bothBudgets, outputEstimateTokens, type SpendLimitInfo } from '../spendBudget.js';

describe('SpendBudget with a parent', () => {
  it('asks the parent first and records into both', () => {
    const parent = new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 1_000 });
    const child = new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 5_000, parent });
    // Within the child's token cap and past the parent's: the parent refuses.
    expect(() => child.assertCanSpend(0, 1_200, 'step')).toThrow(`Token cap exceeded for budget '${parent.id}'`);
    child.record(0.25, 300, 'step');
    child.recordExternal(0.1, 'stt');
    expect([child.tokensUsed(), parent.tokensUsed()]).toEqual([300, 300]);
    expect(parent.spentUSD()).toBeCloseTo(0.35);
    expect(child.spentUSD()).toBeCloseTo(0.35);
  });

  it("runs every refusing ancestor's function, then the child's, with the refusing budget's info", () => {
    const seen: string[] = [];
    const note = (who: string) => (info: SpendLimitInfo) => {
      seen.push(`${who}:${info.capType}:${info.budgetId}`);
    };
    const root = new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 100, onLimitReached: note('root') });
    const middle = new SpendBudget({ maxCostUSD: 1, parent: root, onLimitReached: note('middle') });
    const child = new SpendBudget({ maxCostUSD: Number.POSITIVE_INFINITY, parent: middle, onLimitReached: note('child') });
    expect(() => child.assertCanSpend(0, 500, 'step')).toThrow(CostCapExceededError);
    expect(seen).toEqual([`root:tokens:${root.id}`, `middle:tokens:${root.id}`, `child:tokens:${root.id}`]);
  });

  it('refuses a budget whose parent chain keeps its spending on the same guard and id, which would count each call twice', () => {
    const guard = new CostGuard({ maxSessionCostUsd: 1, maxDailyCostUsd: 10, maxSingleOperationCostUsd: 1 });
    const parent = new SpendBudget({ maxCostUSD: 1, guard, budgetId: 'run' });
    const middle = new SpendBudget({ maxCostUSD: 1, guard, budgetId: 'launch', parent });
    expect(() => new SpendBudget({ maxCostUSD: 0.5, guard, budgetId: 'run', parent })).toThrow(RangeError);
    expect(() => new SpendBudget({ maxCostUSD: 0.5, guard, budgetId: 'run', parent: middle })).toThrow(RangeError);
    // The refusal comes before the guard is touched: the parent's cap for the id holds.
    expect(guard.getSnapshot('run').sessionLimit).toBe(1);
    // A child on the same guard under an id of its own draws on the parent, each charged once.
    const child = new SpendBudget({ maxCostUSD: 1, guard, budgetId: 'step', parent });
    child.record(0.25, 300, 'step');
    expect([child.spentUSD(), parent.spentUSD()]).toEqual([0.25, 0.25]);
  });

  it("tells the budgets below an ancestor whose own function throws, and the call is refused with that function's error", () => {
    const seen: string[] = [];
    const root = new SpendBudget({
      maxCostUSD: 1,
      maxTotalTokens: 100,
      onLimitReached: () => {
        throw new Error('stop');
      },
    });
    const middle = new SpendBudget({ maxCostUSD: 1, parent: root, onLimitReached: (info) => { seen.push(`middle:${info.budgetId}`); } });
    const child = new SpendBudget({ maxCostUSD: 1, parent: middle, onLimitReached: (info) => { seen.push(`child:${info.budgetId}`); } });
    expect(() => child.assertCanSpend(0, 500, 'step')).toThrow('stop');
    expect(seen).toEqual([`middle:${root.id}`, `child:${root.id}`]);
  });

  it('tells the budgets below an ancestor whose own function throws a value that is not an object', () => {
    const seen: string[] = [];
    const stop = () => {
      throw 'stop';
    };
    const thrownBy = (check: () => void): unknown => {
      try {
        check();
      } catch (error) {
        return error;
      }
      return undefined;
    };
    const root = new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 100, onLimitReached: stop });
    const child = new SpendBudget({ maxCostUSD: 1, parent: root, onLimitReached: (info) => { seen.push(`child:${info.budgetId}`); } });
    expect(thrownBy(() => child.assertCanSpend(0, 500, 'step'))).toBe('stop');
    // Held to two budgets, the first hears of the second's refusal the same way.
    const capped = new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 100, onLimitReached: stop });
    const first = new SpendBudget({ maxCostUSD: 1, onLimitReached: (info) => { seen.push(`first:${info.budgetId}`); } });
    expect(thrownBy(() => bothBudgets(first, capped).assertCanSpend(0, 500, 'step'))).toBe('stop');
    expect(seen).toEqual([`child:${root.id}`, `first:${capped.id}`]);
  });

  it("lets the child's own check decide when a parent only warns", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const parent = new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 10, onLimitReached: 'warn' });
    const child = new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 1_000, parent });
    expect(() => child.assertCanSpend(0, 500, 'step')).not.toThrow();
    // The parent's check ran and only warned, so the child's own cap is what let the call through.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(`spend budget ${parent.id}:`);
    expect(() => child.assertCanSpend(0, 1_500, 'step')).toThrow(`Token cap exceeded for budget '${child.id}'`);
    warn.mockRestore();
  });

  it('reports what is left, never below zero, with no dollar cap as Infinity', () => {
    const spent = new SpendBudget({ maxCostUSD: 0.5, maxTotalTokens: 100 });
    spent.record(0.75, 150, 'step');
    expect(spent.remaining()).toEqual({ usd: 0, tokens: 0 });
    const open = new SpendBudget({ maxCostUSD: Number.POSITIVE_INFINITY });
    open.record(2, 10, 'step');
    expect(open.remaining()).toEqual({ usd: Number.POSITIVE_INFINITY });
  });

  it('estimates a call the way a check counts it', () => {
    expect(outputEstimateTokens('stub-model', undefined)).toBe(DEFAULT_OUTPUT_ESTIMATE_TOKENS);
    expect(outputEstimateTokens('stub-model', 2_000)).toBe(2_000);
  });
});
