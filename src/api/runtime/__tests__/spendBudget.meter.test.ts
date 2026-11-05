/**
 * @fileoverview A spend budget that holds its calls in a spend meter: each call's largest cost reserved before the call,
 * and settled at what it cost after it. The cases that read the meter's figures run on an in-memory meter and on
 * SqlSpendMeter over SQLite, the store a host runs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveStorageAdapter } from '@framers/sql-storage-adapter';

import { CostCapExceededError, CostGuard } from '../../../safety/runtime/CostGuard.js';
import {
  SpendMeterUnavailableError,
  type ISpendMeter,
  type SpendMeterSnapshot,
  type SpendReconcileResult,
  type SpendReserveRequest,
  type SpendReserveResult,
  type SpendReservationState,
  type SpendSettleRequest,
  type SpendSettleResult,
} from '../../../safety/runtime/SpendMeter.js';
import { SqlSpendMeter } from '../../../safety/runtime/SqlSpendMeter.js';
import { estimateMaxCallCostUSD, registerModelPricing, type MaxCostRequest } from '../modelPricing.js';
import {
  SpendBudget,
  UnpricedModelError,
  assertCallWithinBudget,
  bothBudgets,
  type SpendBudgetCall,
  type SpendLimitInfo,
} from '../spendBudget.js';

const PROVIDER = 'meter-test';
const MODEL = 'priced';
const ACCOUNT = 'acct-1';
const PERIOD = '2026-11';

/** A row whose bound falls between two micro-dollars, for the rounding a reservation takes. */
const FRACTIONAL_MODEL = 'priced-fractional';
/** A row a host priced at nothing. */
const FREE_MODEL = 'priced-free';

registerModelPricing(PROVIDER, (modelId) => {
  if (modelId === MODEL) return { inputPerMTokUSD: 1, outputPerMTokUSD: 10 };
  if (modelId === FRACTIONAL_MODEL) return { inputPerMTokUSD: 1.1, outputPerMTokUSD: 10 };
  return modelId === FREE_MODEL ? { inputPerMTokUSD: 0, outputPerMTokUSD: 0 } : undefined;
});

const REQUEST: MaxCostRequest = { messages: [{ role: 'user', content: 'hello' }], maxOutputTokens: 1_000 };
const MAX_USD = estimateMaxCallCostUSD(PROVIDER, MODEL, REQUEST) as number;
/** The call's largest cost in whole micro-dollars, the units a reservation holds. */
const MAX_MICRO = Math.ceil(MAX_USD * 1_000_000);

/** A call on the priced model under `operationId`. */
const callOf = (operationId: string, request: MaxCostRequest = REQUEST): SpendBudgetCall => ({ providerId: PROVIDER, modelId: MODEL, request, operationId });

/** A meter in memory: one period, atomic between its awaits, as a store's transaction is. */
class MemoryMeter implements ISpendMeter {
  used = 0;
  reserved = 0;
  readonly rows = new Map<string, { units: number; state: SpendReservationState; requireFence: boolean; settled: number }>();
  readonly reserve = vi.fn(async (req: SpendReserveRequest): Promise<SpendReserveResult> => {
    // A store's round trip: concurrent reservations interleave here.
    await Promise.resolve();
    const base = { operationId: req.operationId, accountId: req.accountId, period: PERIOD };
    const remaining = this.allowance - this.used - this.reserved;
    const row = this.rows.get(req.operationId);
    if (row?.state === 'reserved') return { status: 'denied', reason: 'in_flight', ...base, remaining };
    if (row?.state === 'consumed') return { status: 'denied', reason: 'already_consumed', ...base, remaining };
    const units = Math.max(1, Math.trunc(req.units ?? 1));
    if (units > remaining) return { status: 'denied', reason: 'allowance_exhausted', ...base, remaining };
    this.reserved += units;
    this.rows.set(req.operationId, { units, state: 'reserved', requireFence: req.requireFence === true, settled: 0 });
    return { status: 'reserved', ...base, units, attempt: 1, remaining: remaining - units, expiresAt: Date.now() + 60_000 };
  });
  readonly settle = vi.fn(async (req: SpendSettleRequest): Promise<SpendSettleResult> => {
    const row = this.rows.get(req.operationId);
    if (!row) return { status: 'not_found' };
    if (row.state !== 'reserved') return { status: 'already_settled', state: row.state };
    this.reserved -= row.units;
    if (req.outcome === 'consumed') {
      row.settled = req.units === undefined ? row.units : Math.min(row.units, Math.max(0, Math.trunc(req.units)));
      this.used += row.settled;
      row.state = 'consumed';
    } else {
      row.state = 'released';
    }
    return { status: 'settled', state: row.state };
  });

  constructor(readonly allowance: number) {}

  async heartbeat(): Promise<void> {}
  async reconcile(): Promise<SpendReconcileResult> {
    return { consumed: 0, released: 0, pending: 0 };
  }
  async snapshot(accountId: string): Promise<SpendMeterSnapshot> {
    return { accountId, period: PERIOD, allowance: this.allowance, used: this.used, reserved: this.reserved, remaining: this.allowance - this.used - this.reserved };
  }
  async setAllowance(): Promise<void> {}
}

/** The rejection a call ends in, or undefined when it resolves. */
async function rejectionOf(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (error) {
    return error;
  }
  return undefined;
}

const METERS: [string, (allowance: number) => Promise<{ meter: ISpendMeter; close: () => Promise<void> }>][] = [
  ['an in-memory meter', async (allowance) => ({ meter: new MemoryMeter(allowance), close: async () => {} })],
  [
    'SqlSpendMeter on SQLite',
    async (allowance) => {
      const db = await resolveStorageAdapter({ filePath: ':memory:', priority: ['better-sqlite3', 'sqljs'], quiet: true });
      return { meter: new SqlSpendMeter({ db, allowanceFor: () => allowance, periodOf: () => PERIOD, requireShared: false }), close: () => db.close() };
    },
  ],
];

for (const [name, open] of METERS) {
  describe(`a spend budget holding its calls in ${name}`, () => {
    let close: (() => Promise<void>) | undefined;
    const budgetOn = async (allowance: number) => {
      const opened = await open(allowance);
      close = opened.close;
      return { meter: opened.meter, budget: new SpendBudget({ maxCostUSD: Number.POSITIVE_INFINITY, meter: opened.meter, accountId: ACCOUNT }) };
    };
    afterEach(async () => {
      await close?.();
      close = undefined;
    });

    it('refuses the second of two concurrent calls whose maxima together pass the allowance, before any provider call', async () => {
      const { budget, meter } = await budgetOn(Math.floor(MAX_MICRO * 1.5));
      const provider = vi.fn();
      const answers = await Promise.allSettled(
        ['op-1', 'op-2'].map(async (operationId) => {
          await budget.assertCanSpend('call', callOf(operationId));
          provider(operationId);
        }),
      );
      expect(provider).toHaveBeenCalledTimes(1);
      const refused = answers.filter((answer): answer is PromiseRejectedResult => answer.status === 'rejected');
      expect(refused).toHaveLength(1);
      expect(refused[0].reason).toBeInstanceOf(CostCapExceededError);
      expect(refused[0].reason.message).toContain('allowance_exhausted');
      expect(await meter.snapshot(ACCOUNT)).toMatchObject({ used: 0, reserved: MAX_MICRO });
    });

    it('settles a finished call at what it cost and frees the rest of its reservation', async () => {
      const { budget, meter } = await budgetOn(MAX_MICRO * 2);
      await budget.assertCanSpend('call', callOf('op-1'));
      expect(await meter.snapshot(ACCOUNT)).toMatchObject({ used: 0, reserved: MAX_MICRO, remaining: MAX_MICRO });
      await budget.record(0.000123, 100, 'call', { operationId: 'op-1' });
      expect(await meter.snapshot(ACCOUNT)).toMatchObject({ used: 123, reserved: 0, remaining: MAX_MICRO * 2 - 123 });
      // The in-memory guard keeps its own count of the same call.
      expect(budget.spentUSD()).toBeCloseTo(0.000123, 10);
      expect(budget.tokensUsed()).toBe(100);
    });

    it('releases the whole reservation of a call that failed before any output', async () => {
      const { budget, meter } = await budgetOn(MAX_MICRO);
      await budget.assertCanSpend('call', callOf('op-1'));
      await budget.record(undefined, 0, 'call', { operationId: 'op-1', outcome: 'released' });
      expect(await meter.snapshot(ACCOUNT)).toMatchObject({ used: 0, reserved: 0, remaining: MAX_MICRO });
      expect(budget.spentUSD()).toBe(0);
    });

    it('consumes the whole reservation of a finished call whose cost is not known, since nothing shows it cost less', async () => {
      const { budget, meter } = await budgetOn(MAX_MICRO * 2);
      await budget.assertCanSpend('call', callOf('op-1'));
      await budget.record(undefined, 0, 'call', { operationId: 'op-1' });
      expect(await meter.snapshot(ACCOUNT)).toMatchObject({ used: MAX_MICRO, reserved: 0 });
    });

    it('holds a cost above the reservation to the reservation in the meter, and counts all of it in the guard', async () => {
      const { budget, meter } = await budgetOn(MAX_MICRO * 2);
      await budget.assertCanSpend('call', callOf('op-1'));
      await budget.record(MAX_USD * 3, 100, 'call', { operationId: 'op-1' });
      expect(await meter.snapshot(ACCOUNT)).toMatchObject({ used: MAX_MICRO, reserved: 0 });
      expect(budget.spentUSD()).toBeCloseTo(MAX_USD * 3, 10);
    });

    it('holds nothing for a call whose largest cost is zero, so a spent allowance does not refuse a free model', async () => {
      const { budget, meter } = await budgetOn(0);
      await budget.assertCanSpend('call', { ...callOf('op-1'), modelId: FREE_MODEL });
      await budget.record(0, 10, 'call', { operationId: 'op-1' });
      expect(await meter.snapshot(ACCOUNT)).toMatchObject({ used: 0, reserved: 0 });
    });

    it("names the meter's word for a refusal when a call is reserved twice under one operation id", async () => {
      const seen: SpendLimitInfo[] = [];
      const opened = await open(MAX_MICRO * 4);
      close = opened.close;
      const budget = new SpendBudget({
        maxCostUSD: Number.POSITIVE_INFINITY,
        meter: opened.meter,
        accountId: ACCOUNT,
        budgetId: 'run-1',
        onLimitReached: (info) => seen.push(info),
      });
      await budget.assertCanSpend('call', callOf('op-1'));
      expect(await rejectionOf(budget.assertCanSpend('call', callOf('op-1')))).toBeInstanceOf(CostCapExceededError);
      await budget.record(0.0001, 10, 'call', { operationId: 'op-1' });
      expect(await rejectionOf(budget.assertCanSpend('call', callOf('op-1')))).toBeInstanceOf(CostCapExceededError);
      expect(seen).toEqual([
        { budgetId: 'run-1', capType: 'usd', what: 'call', reason: 'in_flight' },
        { budgetId: 'run-1', capType: 'usd', what: 'call', reason: 'already_consumed' },
      ]);
    });
  });
}

describe('what a spend budget reserves', () => {
  it('reserves the bound in whole micro-dollars behind a fence, under the operation id and the account', async () => {
    const meter = new MemoryMeter(MAX_MICRO * 2);
    await new SpendBudget({ maxCostUSD: 1, meter, accountId: ACCOUNT }).assertCanSpend('call', callOf('op-1'));
    expect(meter.reserve).toHaveBeenCalledTimes(1);
    expect(meter.reserve).toHaveBeenCalledWith({ accountId: ACCOUNT, operationId: 'op-1', units: MAX_MICRO, requireFence: true });
  });

  it('rounds a bound between two micro-dollars up, so the reservation stays at or above it', async () => {
    const meter = new MemoryMeter(MAX_MICRO * 2);
    const fractional = { ...callOf('op-1'), modelId: FRACTIONAL_MODEL };
    const bound = (estimateMaxCallCostUSD(PROVIDER, FRACTIONAL_MODEL, REQUEST) as number) * 1_000_000;
    // The test's own footing: the bound falls below the half, where rounding to the nearest would drop under it.
    expect(bound - Math.floor(bound)).toBeGreaterThan(0.01);
    expect(bound - Math.floor(bound)).toBeLessThan(0.5);
    await new SpendBudget({ maxCostUSD: 1, meter, accountId: ACCOUNT }).assertCanSpend('call', fractional);
    expect(meter.reserve).toHaveBeenCalledWith(expect.objectContaining({ units: Math.ceil(bound) }));
  });

  it('counts a settled cost in whole micro-dollars with no floating-point unit added', async () => {
    const meter = new MemoryMeter(MAX_MICRO * 2);
    const budget = new SpendBudget({ maxCostUSD: 1, meter, accountId: ACCOUNT });
    await budget.assertCanSpend('call', callOf('op-1'));
    // 0.000123 * 1e6 is 123.00000000000001 in floating point.
    await budget.record(0.000123, 10, 'call', { operationId: 'op-1' });
    expect(meter.settle).toHaveBeenCalledWith({ operationId: 'op-1', outcome: 'consumed', units: 123 });
  });

  it('refuses a model with no price row with UnpricedModelError and reserves nothing', async () => {
    const meter = new MemoryMeter(MAX_MICRO * 2);
    const budget = new SpendBudget({ maxCostUSD: 1, meter, accountId: ACCOUNT });
    const refusal = await rejectionOf(budget.assertCanSpend('call', { ...callOf('op-1'), modelId: 'no-row' }));
    expect(refusal).toBeInstanceOf(UnpricedModelError);
    expect(refusal).toMatchObject({ providerId: PROVIDER, modelId: 'no-row' });
    expect(meter.reserve).not.toHaveBeenCalled();
  });

  it('refuses a request on a priced model that it cannot bound, saying so, and reserves nothing', async () => {
    const meter = new MemoryMeter(MAX_MICRO * 2);
    const seen: SpendLimitInfo[] = [];
    const budget = new SpendBudget({ maxCostUSD: 1, meter, accountId: ACCOUNT, onLimitReached: (info) => seen.push(info) });
    const refusal = await rejectionOf(budget.assertCanSpend('call', callOf('op-1', { ...REQUEST, n: 2 })));
    expect(refusal).toBeInstanceOf(UnpricedModelError);
    expect((refusal as Error).message).toContain('cannot be bounded');
    expect(seen).toMatchObject([{ capType: 'unpriced', what: 'call' }]);
    expect(seen[0].reason).toContain('cannot be bounded');
    expect(meter.reserve).not.toHaveBeenCalled();
  });

  it("refuses a call it cannot bound even under unpriced: 'allow', since a meter cannot hold an unknown", async () => {
    const meter = new MemoryMeter(MAX_MICRO * 2);
    const budget = new SpendBudget({ maxCostUSD: 1, meter, accountId: ACCOUNT, unpriced: 'allow' });
    expect(await rejectionOf(budget.assertCanSpend('call', { ...callOf('op-1'), modelId: 'no-row' }))).toBeInstanceOf(UnpricedModelError);
    expect(await rejectionOf(budget.assertCanSpend('call', callOf('op-2', { ...REQUEST, maxOutputTokens: undefined })))).toBeInstanceOf(UnpricedModelError);
    expect(meter.reserve).not.toHaveBeenCalled();
  });

  it("refuses at the budget's own caps before the meter is asked", async () => {
    const dollars = new MemoryMeter(MAX_MICRO * 2);
    const tooSmall = new SpendBudget({ maxCostUSD: MAX_USD / 2, meter: dollars, accountId: ACCOUNT });
    expect(await rejectionOf(tooSmall.assertCanSpend('call', callOf('op-1')))).toBeInstanceOf(CostCapExceededError);
    expect(dollars.reserve).not.toHaveBeenCalled();
    const tokens = new MemoryMeter(MAX_MICRO * 2);
    const noTokens = new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 1, meter: tokens, accountId: ACCOUNT });
    expect(await rejectionOf(noTokens.assertCanSpend('call', callOf('op-1')))).toBeInstanceOf(CostCapExceededError);
    expect(tokens.reserve).not.toHaveBeenCalled();
  });
});

describe('a spend budget when its meter fails', () => {
  it('fails closed when the store cannot answer: the rejection goes on and no provider call runs', async () => {
    const meter = new MemoryMeter(MAX_MICRO * 2);
    const down = new SpendMeterUnavailableError('the spend meter did not answer');
    meter.reserve.mockRejectedValueOnce(down);
    const provider = vi.fn();
    const budget = new SpendBudget({ maxCostUSD: 1, meter, accountId: ACCOUNT });
    const refusal = await rejectionOf(budget.assertCanSpend('call', callOf('op-1')).then(provider));
    expect(refusal).toBe(down);
    expect(provider).not.toHaveBeenCalled();
  });

  it('rejects a record whose settle failed, having charged the guard: the reservation stays held for the reconciler', async () => {
    const meter = new MemoryMeter(MAX_MICRO * 2);
    const budget = new SpendBudget({ maxCostUSD: 1, meter, accountId: ACCOUNT });
    await budget.assertCanSpend('call', callOf('op-1'));
    const down = new SpendMeterUnavailableError('the spend meter did not answer');
    meter.settle.mockRejectedValueOnce(down);
    expect(await rejectionOf(budget.record(0.0001, 10, 'call', { operationId: 'op-1' }))).toBe(down);
    expect(budget.spentUSD()).toBeCloseTo(0.0001, 10);
    expect(await meter.snapshot(ACCOUNT)).toMatchObject({ used: 0, reserved: MAX_MICRO });
  });

  it("settles a call whose charge throws, and rejects with what it threw, since a guard's cap function can throw", async () => {
    const meter = new MemoryMeter(MAX_MICRO * 2);
    const thrown = new Error('the cap function threw');
    const guard = new CostGuard({
      maxSingleOperationCostUsd: Number.POSITIVE_INFINITY,
      maxDailyCostUsd: Number.POSITIVE_INFINITY,
      onCapReached: () => {
        throw thrown;
      },
    });
    const budget = new SpendBudget({ maxCostUSD: MAX_USD, guard, budgetId: 'run-1', meter, accountId: ACCOUNT });
    await budget.assertCanSpend('call', callOf('op-1'));
    const recorded = budget.record(MAX_USD * 2, 10, 'call', { operationId: 'op-1' });
    expect(await rejectionOf(recorded)).toBe(thrown);
    expect(await meter.snapshot(ACCOUNT)).toMatchObject({ used: MAX_MICRO, reserved: 0 });
  });

  it('runs a refused call under onLimitReached: warn, holding nothing, and its record settles nothing', async () => {
    const meter = new MemoryMeter(1);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const budget = new SpendBudget({ maxCostUSD: 1, meter, accountId: ACCOUNT, onLimitReached: 'warn' });
      await expect(budget.assertCanSpend('call', callOf('op-1'))).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      await expect(budget.record(0.0001, 10, 'call', { operationId: 'op-1' })).resolves.toBeUndefined();
      expect(await meter.snapshot(ACCOUNT)).toMatchObject({ used: 0, reserved: 0 });
      expect(budget.spentUSD()).toBeCloseTo(0.0001, 10);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("a guard's cap function that throws while a cost is counted", () => {
  const thrown = new Error('the cap function threw');
  const throwingGuard = () =>
    new CostGuard({
      maxSingleOperationCostUsd: Number.POSITIVE_INFINITY,
      maxDailyCostUsd: Number.POSITIVE_INFINITY,
      onCapReached: () => {
        throw thrown;
      },
    });
  /** A budget whose guard throws on any cost at or above 0.00005. */
  const throwing = (budgetId: string, parent?: SpendBudget) => new SpendBudget({ maxCostUSD: 0.00005, guard: throwingGuard(), budgetId, parent });

  it('leaves the second of two budgets counting the call, and the first error goes on', () => {
    const second = new SpendBudget({ maxCostUSD: 1 });
    expect(() => bothBudgets(throwing('first'), second).record(0.0001, 10, 'call')).toThrow(thrown);
    expect(second.spentUSD()).toBeCloseTo(0.0001, 10);
    expect(second.tokensUsed()).toBe(10);
  });

  it('leaves a parent counting the call', () => {
    const parent = new SpendBudget({ maxCostUSD: 1 });
    expect(() => throwing('child', parent).record(0.0001, 10, 'call')).toThrow(thrown);
    expect(parent.spentUSD()).toBeCloseTo(0.0001, 10);
    expect(parent.tokensUsed()).toBe(10);
  });

  it('leaves the other budgets counting an outside cost', () => {
    const parent = new SpendBudget({ maxCostUSD: 1 });
    expect(() => throwing('child', parent).recordExternal(0.0001, 'minutes')).toThrow(thrown);
    expect(parent.spentUSD()).toBeCloseTo(0.0001, 10);
    const second = new SpendBudget({ maxCostUSD: 1 });
    expect(() => bothBudgets(throwing('first'), second).recordExternal(0.0001, 'minutes')).toThrow(thrown);
    expect(second.spentUSD()).toBeCloseTo(0.0001, 10);
  });
});

describe('a call on a budget with a meter that reserves nothing', () => {
  it('is refused by the synchronous check, so a call never passes a meter unseen', () => {
    const meter = new MemoryMeter(MAX_MICRO * 2);
    const seen: SpendLimitInfo[] = [];
    const budget = new SpendBudget({ maxCostUSD: 1, meter, accountId: ACCOUNT, budgetId: 'run-1', onLimitReached: (info) => seen.push(info) });
    expect(() => assertCallWithinBudget(budget, { providerId: PROVIDER, modelId: MODEL }, 100, 1_000, 'generate_text.step')).toThrow(CostCapExceededError);
    expect(seen).toMatchObject([{ budgetId: 'run-1', capType: 'usd', what: 'generate_text.step' }]);
    expect(meter.reserve).not.toHaveBeenCalled();
  });

  it("is refused inside another budget's limit function, which runs during that budget's reservation", async () => {
    const other = new SpendBudget({ maxCostUSD: 1, meter: new MemoryMeter(MAX_MICRO * 2), accountId: 'acct-other' });
    let inside: unknown;
    const budget = new SpendBudget({
      maxCostUSD: 1,
      meter: new MemoryMeter(1),
      accountId: ACCOUNT,
      onLimitReached: () => {
        try {
          other.assertCanSpend(0.001, 10, 'other');
        } catch (error) {
          inside = error;
        }
      },
    });
    expect(await rejectionOf(budget.assertCanSpend('call', callOf('op-1')))).toBeInstanceOf(CostCapExceededError);
    expect(inside).toBeInstanceOf(CostCapExceededError);
  });

  it("is refused for a child that draws on a budget with a meter, whose own function hears of it", () => {
    const meter = new MemoryMeter(MAX_MICRO * 2);
    const parent = new SpendBudget({ maxCostUSD: 1, meter, accountId: ACCOUNT });
    const heard = vi.fn();
    const child = new SpendBudget({ maxCostUSD: 1, parent, onLimitReached: heard });
    expect(() => child.assertCanSpend(0.001, 10, 'step')).toThrow(CostCapExceededError);
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe('a spend budget without a meter', () => {
  it('keeps its synchronous check and record, which return nothing', () => {
    const budget = new SpendBudget({ maxCostUSD: 1 });
    expect(budget.assertCanSpend(0.001, 10, 'step')).toBeUndefined();
    expect(budget.record(0.001, 10, 'step')).toBeUndefined();
    expect(budget.spentUSD()).toBeCloseTo(0.001, 10);
  });

  it("checks a named call's bound against what it has left, and its record charges the cost", async () => {
    const tooSmall = new SpendBudget({ maxCostUSD: MAX_USD / 2 });
    expect(await rejectionOf(tooSmall.assertCanSpend('call', callOf('op-1')))).toBeInstanceOf(CostCapExceededError);
    const budget = new SpendBudget({ maxCostUSD: 1 });
    await expect(budget.assertCanSpend('call', callOf('op-1'))).resolves.toBeUndefined();
    await expect(budget.record(0.0001, 10, 'call', { operationId: 'op-1' })).resolves.toBeUndefined();
    expect(budget.spentUSD()).toBeCloseTo(0.0001, 10);
  });

  it("lets a call it cannot bound run under unpriced: 'allow', as it lets a model with no price row", async () => {
    const budget = new SpendBudget({ maxCostUSD: 1, unpriced: 'allow' });
    await expect(budget.assertCanSpend('call', { ...callOf('op-1'), modelId: 'no-row' })).resolves.toBeUndefined();
  });
});

describe('budgets that draw on a budget with a meter', () => {
  it('reserves in the meter of a parent, and settles there, for a child with none', async () => {
    const meter = new MemoryMeter(MAX_MICRO * 2);
    const parent = new SpendBudget({ maxCostUSD: 1, meter, accountId: ACCOUNT });
    const child = new SpendBudget({ maxCostUSD: 1, parent });
    await child.assertCanSpend('call', callOf('op-1'));
    expect(await meter.snapshot(ACCOUNT)).toMatchObject({ used: 0, reserved: MAX_MICRO });
    await child.record(0.0001, 10, 'call', { operationId: 'op-1' });
    expect(await meter.snapshot(ACCOUNT)).toMatchObject({ used: 100, reserved: 0 });
    expect(parent.spentUSD()).toBeCloseTo(0.0001, 10);
    expect(child.spentUSD()).toBeCloseTo(0.0001, 10);
  });

  it("tells a child's function when the parent's meter refuses, with the parent's info", async () => {
    const meter = new MemoryMeter(1);
    const parent = new SpendBudget({ maxCostUSD: 1, meter, accountId: ACCOUNT, budgetId: 'team' });
    const heard: SpendLimitInfo[] = [];
    const child = new SpendBudget({ maxCostUSD: 1, parent, onLimitReached: (info) => heard.push(info) });
    expect(await rejectionOf(child.assertCanSpend('call', callOf('op-1')))).toBeInstanceOf(CostCapExceededError);
    expect(heard).toEqual([{ budgetId: 'team', capType: 'usd', what: 'call', reason: 'allowance_exhausted' }]);
  });

  it('holds one reservation for two budgets on one meter and one account, and settles it once', async () => {
    const meter = new MemoryMeter(MAX_MICRO * 2);
    const parent = new SpendBudget({ maxCostUSD: 1, meter, accountId: ACCOUNT });
    const child = new SpendBudget({ maxCostUSD: 1, parent, meter, accountId: ACCOUNT });
    await child.assertCanSpend('call', callOf('op-1'));
    expect(meter.reserve).toHaveBeenCalledTimes(1);
    await child.record(0.0001, 10, 'call', { operationId: 'op-1' });
    expect(meter.settle).toHaveBeenCalledTimes(1);
    expect(await meter.snapshot(ACCOUNT)).toMatchObject({ used: 100, reserved: 0 });
  });

  it('refuses for a budget set to throw when a parent set to warn names the same meter and account', async () => {
    const meter = new MemoryMeter(1);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const parent = new SpendBudget({ maxCostUSD: 1, meter, accountId: ACCOUNT, onLimitReached: 'warn' });
      const child = new SpendBudget({ maxCostUSD: 1, parent, meter, accountId: ACCOUNT });
      expect(await rejectionOf(child.assertCanSpend('call', callOf('op-1')))).toBeInstanceOf(CostCapExceededError);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses a call two accounts would hold on one meter, leaving neither holding it, since one operation id holds one reservation', async () => {
    const meter = new MemoryMeter(MAX_MICRO * 4);
    const parent = new SpendBudget({ maxCostUSD: 1, meter, accountId: 'acct-parent' });
    const child = new SpendBudget({ maxCostUSD: 1, parent, meter, accountId: 'acct-child' });
    expect(await rejectionOf(child.assertCanSpend('call', callOf('op-1')))).toBeInstanceOf(CostCapExceededError);
    expect(await meter.snapshot('acct-parent')).toMatchObject({ used: 0, reserved: 0 });
  });

  it('holds a call held to two budgets in both their meters, and settles both', async () => {
    const team = new MemoryMeter(MAX_MICRO * 2);
    const member = new MemoryMeter(MAX_MICRO * 2);
    const both = bothBudgets(
      new SpendBudget({ maxCostUSD: 1, meter: team, accountId: 'acct-team' }),
      new SpendBudget({ maxCostUSD: 1, meter: member, accountId: 'acct-member' }),
    );
    await both.assertCanSpend('call', callOf('op-1'));
    expect(team.reserved).toBe(MAX_MICRO);
    expect(member.reserved).toBe(MAX_MICRO);
    await both.record(0.0001, 10, 'call', { operationId: 'op-1' });
    expect(team.used).toBe(100);
    expect(member.used).toBe(100);
    expect(team.reserved).toBe(0);
    expect(member.reserved).toBe(0);
  });

  it('gives back what an earlier meter holds when a later one refuses, and the first budget hears of the refusal', async () => {
    const team = new MemoryMeter(MAX_MICRO * 2);
    const member = new MemoryMeter(1);
    const heard: SpendLimitInfo[] = [];
    const both = bothBudgets(
      new SpendBudget({ maxCostUSD: 1, meter: team, accountId: 'acct-team', onLimitReached: (info) => heard.push(info) }),
      new SpendBudget({ maxCostUSD: 1, meter: member, accountId: 'acct-member', budgetId: 'member' }),
    );
    expect(await rejectionOf(both.assertCanSpend('call', callOf('op-1')))).toBeInstanceOf(CostCapExceededError);
    expect(team.settle).toHaveBeenCalledWith({ operationId: 'op-1', outcome: 'released' });
    expect(team.reserved).toBe(0);
    expect(team.used).toBe(0);
    expect(heard).toEqual([{ budgetId: 'member', capType: 'usd', what: 'call', reason: 'allowance_exhausted' }]);
  });

  it("gives back what an earlier meter holds when a later meter's refusal is let through and another budget's cap then refuses", async () => {
    const team = new MemoryMeter(MAX_MICRO * 2);
    const member = new MemoryMeter(MAX_MICRO * 2);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const teamBudget = new SpendBudget({ maxCostUSD: MAX_USD, meter: team, accountId: 'acct-team' });
      const both = bothBudgets(teamBudget, new SpendBudget({ maxCostUSD: 1, meter: member, accountId: 'acct-member', onLimitReached: 'warn' }));
      // Another call's cost lands while this one waits on the store, so the look at the caps that reports the refusal
      // finds the team's budget spent.
      member.reserve.mockImplementationOnce(async (req) => {
        teamBudget.record(0.0001, 1, 'other');
        return { status: 'denied', reason: 'allowance_exhausted', operationId: req.operationId, accountId: req.accountId, period: PERIOD, remaining: 0 };
      });
      expect(await rejectionOf(both.assertCanSpend('call', callOf('op-1')))).toBeInstanceOf(CostCapExceededError);
      expect(team.reserved).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('gives back what an earlier meter holds when a later one cannot answer', async () => {
    const team = new MemoryMeter(MAX_MICRO * 2);
    const member = new MemoryMeter(MAX_MICRO * 2);
    const down = new SpendMeterUnavailableError('the spend meter did not answer');
    member.reserve.mockRejectedValueOnce(down);
    const both = bothBudgets(new SpendBudget({ maxCostUSD: 1, meter: team, accountId: 'acct-team' }), new SpendBudget({ maxCostUSD: 1, meter: member, accountId: 'acct-member' }));
    expect(await rejectionOf(both.assertCanSpend('call', callOf('op-1')))).toBe(down);
    expect(team.reserved).toBe(0);
  });
});

describe('a spend budget given a meter and an account', () => {
  it('needs an account to hold a meter', () => {
    const meter = new MemoryMeter(1);
    expect(() => new SpendBudget({ maxCostUSD: 1, meter })).toThrow(RangeError);
    expect(() => new SpendBudget({ maxCostUSD: 1, meter, accountId: '' })).toThrow(RangeError);
  });

  it('keeps an account without a meter, for a host to read', () => {
    expect(new SpendBudget({ maxCostUSD: 1, accountId: ACCOUNT }).options.accountId).toBe(ACCOUNT);
  });
});
