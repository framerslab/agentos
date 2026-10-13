import { describe, expect, it } from 'vitest';
import type { RateSnapshot } from '../CreditRates.js';
import { InMemoryCompoundCreditStore } from '../CompoundCreditStore.js';
import { grantCreditLot, reserveCompoundCredit, settleCompoundCredit } from '../CompoundCreditLedger.js';
import {
  AttemptBudgetExhaustedError,
  authorizeModelAttempt,
  CountingAttemptBudget,
  ModelAttemptBudget,
  recordAttemptUsage,
} from '../ModelAttemptBudget.js';
import { ATTEMPTS, FENCED, RATES, T } from './compoundCreditLedger.contract.js';

const FALLBACK: RateSnapshot = {
  ...RATES,
  version: 'rates-fallback',
  components: { ...RATES.components, output_token: { customer: RATES.components.output_token!.customer, supplier: { unit: 'token', micro: 2_000_000, per: 1_000_000 } } },
  attemptMinimum: { customerMicro: 0, supplierMicro: 10 },
};

async function heldCall() {
  const store = new InMemoryCompoundCreditStore();
  await grantCreditLot(store, { scopeId: 's', lotId: 'paid', kind: 'paid', fundingRef: 'pay', principalMicro: 1_000_000, at: T });
  const held = await reserveCompoundCredit(store, {
    scopeId: 's', operationId: 'call', kind: 'call', requestHash: 'h', rates: { primary: RATES, fallbacks: [FALLBACK] },
    mediaComponent: 'media_second', durationSeconds: 60, attempts: ATTEMPTS, supplierDailyCapMicro: 1e12, at: T, expiresAt: T + 3_660_000,
  });
  if (held.status !== 'reserved') throw new Error('not reserved');
  return { store, hold: held.hold };
}

describe('ModelAttemptBudget', () => {
  it('spends the aggregate allowance in one tool-using turn with a retry and a fallback, and no hold is exceeded', async () => {
    const { store, hold } = await heldCall();
    // the quote holds four attempts at the dearer fallback's supplier cost: 1229 + 1024 + 10 = 2263 each
    expect(hold).toMatchObject({ customerMicro: 83_117 + 4 * 1_537, supplierMicro: 25_000 + 4 * 2_263, maxAttempts: 4 });
    let now = T;
    const budget = new ModelAttemptBudget({ store, holdId: hold.holdId, now: () => (now += 1_000) });
    const initial = await budget.authorize({ purpose: 'initial' });
    await budget.record(initial.attemptId, { input_token: 8_000, output_token: 300 }, true);
    const tool = await budget.authorize({ purpose: 'tool_continuation' });
    await budget.record(tool.attemptId, { input_token: 8_192, output_token: 512, reasoning_token: 200 }, true);
    const timedOut = await budget.authorize({ purpose: 'retry' });
    const fallback = await budget.authorize({ purpose: 'fallback', rateVersion: 'rates-fallback' });
    expect(fallback.remainingAttempts).toBe(0);
    await budget.record(fallback.attemptId, { input_token: 4_000, output_token: 512 }, true);
    await expect(budget.authorize({ purpose: 'retry' })).rejects.toBeInstanceOf(AttemptBudgetExhaustedError);
    const settled = await settleCompoundCredit(store, { holdId: hold.holdId, connectedMs: 60_000, fence: FENCED, at: T + 90_000 });
    // customer: 83117 media, primary input 16192 -> 2429, output 812 -> 488, fallback input 4000 -> 600, output 512 -> 308
    expect(settled).toMatchObject({ status: 'settled', chargedMicro: 83_117 + 2_429 + 488 + 600 + 308, lossMicro: 0 });
    const after = await store.withTransaction((trx) => trx.getHold(hold.holdId));
    // supplier: 25000 media + 2429 + 488 + 600 + 1024 + 10 minimum; the timed-out attempt keeps its 2263 open
    expect(after).toMatchObject({ supplierSettledMicro: 25_000 + 2_429 + 488 + 600 + 1_024 + 10, supplierOpenMicro: 2_263 });
    expect(after!.chargedMicro).toBeLessThanOrEqual(after!.customerMicro);
    expect(after!.supplierSettledMicro + after!.supplierOpenMicro).toBeLessThanOrEqual(after!.supplierMicro);
    await budget.record(timedOut.attemptId, { input_token: 100, output_token: 10 }, true);
    const late = await store.withTransaction((trx) => trx.getHold(hold.holdId));
    expect(late).toMatchObject({ supplierSettledMicro: 25_000 + 2_429 + 488 + 600 + 1_024 + 10 + 15 + 6, supplierOpenMicro: 0, chargedMicro: settled.status === 'settled' ? settled.chargedMicro : -1 });
    await expect(budget.authorize({ purpose: 'initial' })).rejects.toMatchObject({ reason: 'hold_closed' });
  });

  it('answers a repeated authorization by its attempt id without a second debit', async () => {
    const { store, hold } = await heldCall();
    const first = await authorizeModelAttempt(store, { holdId: hold.holdId, attemptId: 'a-1', purpose: 'initial', at: T });
    const again = await authorizeModelAttempt(store, { holdId: hold.holdId, attemptId: 'a-1', purpose: 'initial', at: T });
    expect(first).toMatchObject({ status: 'authorized', remainingAttempts: 3 });
    expect(again).toMatchObject({ status: 'existing', remainingAttempts: 3 });
    expect(await authorizeModelAttempt(store, { holdId: hold.holdId, attemptId: 'a-2', purpose: 'initial', rateVersion: 'unknown', at: T })).toEqual({ status: 'refused', reason: 'unknown_rate' });
  });

  it('refuses a unit the snapshot does not price, keeps a non-final report open, and caps an over-limit attempt for the customer', async () => {
    const { store, hold } = await heldCall();
    await authorizeModelAttempt(store, { holdId: hold.holdId, attemptId: 'a-1', purpose: 'initial', at: T });
    expect(await recordAttemptUsage(store, { holdId: hold.holdId, attemptId: 'a-1', usage: { image_token: 5 }, final: true, at: T })).toEqual({ status: 'refused', reason: 'unknown_component' });
    expect(await recordAttemptUsage(store, { holdId: hold.holdId, attemptId: 'a-1', usage: { input_token: 1.5 }, final: true, at: T })).toEqual({ status: 'refused', reason: 'invalid_quantity' });
    await recordAttemptUsage(store, { holdId: hold.holdId, attemptId: 'a-1', usage: { input_token: 100 }, final: false, at: T });
    expect((await store.withTransaction((trx) => trx.listAttempts(hold.holdId)))[0]).toMatchObject({ state: 'authorized', final: false });
    expect(await recordAttemptUsage(store, { holdId: hold.holdId, attemptId: 'a-1', usage: { input_token: 9_000 }, final: true, at: T })).toEqual({ status: 'recorded', overLimit: { input_token: 808 } });
    expect(await recordAttemptUsage(store, { holdId: hold.holdId, attemptId: 'a-1', usage: { input_token: 1 }, final: true, at: T })).toEqual({ status: 'refused', reason: 'conflicting_final' });
    const settled = await settleCompoundCredit(store, { holdId: hold.holdId, connectedMs: 0, fence: FENCED, at: T + 1 });
    // the customer pays for 8192 input tokens at most (1229); the supplier's 9000 cost 1350
    expect(settled).toMatchObject({ chargedMicro: 1_229 });
    expect((await store.withTransaction((trx) => trx.getHold(hold.holdId)))?.supplierSettledMicro).toBe(1_350);
  });
});

describe('cumulative attempt accounting', () => {
  it('commits exhaustion with actual usage and stops a fresh authorizer', async () => {
    const { store, hold } = await heldCall();
    const budget = new ModelAttemptBudget({ store, holdId: hold.holdId, now: () => T });
    const grant = await budget.authorize({ purpose: 'initial' });
    await expect(budget.record(grant.attemptId, { input_token: 9_000 }, false)).rejects.toMatchObject({ reason: 'usage_exhausted' });
    const restarted = new ModelAttemptBudget({ store, holdId: hold.holdId, now: () => T + 1 });
    await expect(restarted.authorize({ purpose: 'retry' })).rejects.toMatchObject({ reason: 'usage_exhausted' });
    expect((await store.withTransaction((trx) => trx.listAttempts(hold.holdId)))).toHaveLength(1);
    await expect(restarted.record(grant.attemptId, { input_token: 9_100 }, true)).rejects.toMatchObject({ reason: 'usage_exhausted' });
    expect(await settleCompoundCredit(store, { holdId: hold.holdId, connectedMs: 0, fence: FENCED, at: T + 2 }))
      .toMatchObject({ chargedMicro: 1_229, hold: { supplierSettledMicro: 1_365, supplierOpenMicro: 0 } });
  });

  it('refuses smaller or omitted cumulative quantities and accepts only a matching canonical final', async () => {
    const { store, hold } = await heldCall();
    await authorizeModelAttempt(store, { holdId: hold.holdId, attemptId: 'a', purpose: 'initial', at: T });
    const record = (usage: Record<string, number>, final: boolean) => recordAttemptUsage(store, { holdId: hold.holdId, attemptId: 'a', usage, final, at: T + 1 });
    expect(await record({ input_token: 100, output_token: 2 }, false)).toMatchObject({ status: 'recorded' });
    for (const usage of [{ input_token: 1, output_token: 2 }, {}, { input_token: 100 }]) {
      expect(await record(usage, true)).toEqual({ status: 'refused', reason: 'usage_regression' });
    }
    expect(await record({ output_token: 2, input_token: 100 }, true)).toMatchObject({ status: 'recorded' });
    expect(await record({ reasoning_token: 0, input_token: 100, output_token: 2 }, true)).toEqual({ status: 'already_recorded' });
    expect(await record({ input_token: 101, output_token: 2 }, true)).toEqual({ status: 'refused', reason: 'conflicting_final' });
    const [row] = await store.withTransaction((trx) => trx.listAttempts(hold.holdId));
    expect(JSON.parse(row!.usage!)).toEqual({ input_token: 100, output_token: 2, reasoning_token: 0 });
  });

  it.each([[0, 1], [1, 0]])('rounds aggregate supplier units once in late order %j', async (first, second) => {
    for (const onTime of [0, 1, 2]) {
      const store = new InMemoryCompoundCreditStore();
      const rates: RateSnapshot = { version: 'fractional', currency: 'USD', reasoningInOutput: false, components: {
        media_second: { customer: { unit: 'second', micro: 0, per: 1 }, supplier: { unit: 'second', micro: 0, per: 1 } },
        input_token: { customer: { unit: 'token', micro: 2, per: 3 }, supplier: { unit: 'token', micro: 1, per: 3 } },
      } };
      await grantCreditLot(store, { scopeId: 's', kind: 'paid', fundingRef: 'p', principalMicro: 101, at: T });
      const held = await reserveCompoundCredit(store, { scopeId: 's', operationId: 'r', kind: 'call', requestHash: 'r',
        rates: { primary: rates }, mediaComponent: 'media_second', durationSeconds: 0,
        attempts: { maxAttempts: 2, perAttempt: { input_token: 1 } }, supplierDailyCapMicro: 101, at: T, expiresAt: T + 100 });
      if (held.status !== 'reserved') throw new Error('not reserved');
      const holdId = held.hold.holdId;
      for (const n of [0, 1]) await authorizeModelAttempt(store, { holdId, attemptId: `a${n}`, purpose: 'initial', at: T });
      const order = [first, second];
      const record = (n: number) => recordAttemptUsage(store, { holdId, attemptId: `a${n}`, usage: { input_token: 1 }, final: true, at: T + 1 });
      for (const n of order.slice(0, onTime)) await record(n);
      await settleCompoundCredit(store, { holdId, connectedMs: 0, fence: FENCED, at: T + 1 });
      for (const n of order.slice(onTime)) await record(n);
      const entries = await store.withTransaction((trx) => trx.listEntries({ kinds: ['supplier_settled'] }));
      expect(entries.reduce((sum, entry) => sum + entry.amountMicro, 0)).toBe(1);
      expect(await store.withTransaction((trx) => trx.getHold(holdId))).toMatchObject({ supplierSettledMicro: 1, supplierOpenMicro: 0 });
      await record(first);
      expect(await store.withTransaction((trx) => trx.listEntries({ kinds: ['supplier_settled'] }))).toEqual(entries);
    }
  });
});

describe('CountingAttemptBudget', () => {
  it('counts attempts against a local limit', async () => {
    const budget = new CountingAttemptBudget({ maxAttempts: 2, perAttempt: { input_token: 10 } });
    expect((await budget.authorize({ purpose: 'initial' })).remainingAttempts).toBe(1);
    expect((await budget.authorize({ purpose: 'retry' })).maxQuantities).toEqual({ input_token: 10 });
    await expect(budget.authorize({ purpose: 'retry' })).rejects.toBeInstanceOf(AttemptBudgetExhaustedError);
  });
});
