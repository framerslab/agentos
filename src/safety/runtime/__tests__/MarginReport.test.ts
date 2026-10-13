import { describe, expect, it } from 'vitest';
import { InMemoryCompoundCreditStore } from '../CompoundCreditStore.js';
import { completeLotRefund, grantCreditLot, refundCreditLot, reserveCompoundCredit, settleCompoundCredit, type AllocationPolicy } from '../CompoundCreditLedger.js';
import { authorizeModelAttempt, recordAttemptUsage } from '../ModelAttemptBudget.js';
import { buildMarginReport, marginReport, readMarginPeriod, type MarginAllocationPolicy } from '../MarginReport.js';
import { ATTEMPTS, FENCED, RATES } from './compoundCreditLedger.contract.js';

/** 12 October 2026, 10:00 UTC: every settlement below lands on that day. */
const D = Date.UTC(2026, 9, 12, 10, 0, 0);
const DAY = '2026-10-12';

async function call(store: InMemoryCompoundCreditStore, scopeId: string, op: string, durationSeconds: number, policy?: AllocationPolicy) {
  const held = await reserveCompoundCredit(store, {
    scopeId, operationId: op, kind: 'call', requestHash: op, rates: { primary: RATES }, mediaComponent: 'media_second', durationSeconds,
    attempts: ATTEMPTS, supplierDailyCapMicro: 1e12, at: D, expiresAt: D + 3_660_000, policy,
  });
  if (held.status !== 'reserved') throw new Error(held.status);
  return held.hold.holdId;
}

async function twoWorkspaces() {
  const store = new InMemoryCompoundCreditStore();
  await grantCreditLot(store, { scopeId: 'a', lotId: 'a-promo', kind: 'promotion', fundingRef: 'grant-a', principalMicro: 89_265, expiresAt: D + 30 * 86_400_000, at: D - 1 });
  await grantCreditLot(store, { scopeId: 'a', lotId: 'a-paid', kind: 'paid', fundingRef: 'pay-a', principalMicro: 1_000_000, at: D });
  await grantCreditLot(store, { scopeId: 'b', lotId: 'b-paid', kind: 'paid', fundingRef: 'pay-b', principalMicro: 500_000, at: D });
  const a1 = await call(store, 'a', 'a-1', 60);
  const a2 = await call(store, 'a', 'a-2', 600, (lots) => lots.filter((l) => l.kind === 'paid'));
  const a3 = await call(store, 'a', 'a-3', 60, (lots) => lots.filter((l) => l.kind === 'paid'));
  const b1 = await call(store, 'b', 'b-1', 60);
  await settleCompoundCredit(store, { holdId: a1, connectedMs: 60_000, fence: FENCED, at: D + 1 });
  await settleCompoundCredit(store, { holdId: a2, connectedMs: 120_000, fence: FENCED, at: D + 2 });
  await authorizeModelAttempt(store, { holdId: a3, attemptId: 'warm', purpose: 'initial', at: D + 3 });
  await recordAttemptUsage(store, { holdId: a3, attemptId: 'warm', usage: { input_token: 1_000 }, final: true, at: D + 3 });
  await settleCompoundCredit(store, { holdId: a3, connectedMs: 0, fence: FENCED, at: D + 4, unbilled: true });
  await settleCompoundCredit(store, { holdId: b1, connectedMs: 60_000, fence: FENCED, at: D + 5 });
  await refundCreditLot(store, { scopeId: 'a', lotId: 'a-paid', refundId: 'refund-1', amountMicro: 1_000, at: D + 6 });
  await completeLotRefund(store, { scopeId: 'a', refundId: 'refund-1', outcome: 'succeeded', at: D + 7 });
  return { store, a1, a2, a3, b1 };
}

const complete: MarginAllocationPolicy = {
  version: 'alloc-1',
  hostCostRate: { unit: 'millisecond', micro: 1, per: 100 },
  computeRuntime: [],
  otherCosts: [{ label: 'payment fees', micro: 3_000 }, { label: 'support', excludedReason: 'not measured in this period' }],
};

describe('the margin report', () => {
  it('reconciles a workspace from its settled usage, funding split, supplier cost of failed work, refunds and compute', async () => {
    const { store, a1, a2, a3 } = await twoWorkspaces();
    const input = await readMarginPeriod(store, { scopeId: 'a', fromDay: DAY, toDay: DAY, allocationVersion: 'alloc-1', asOf: D + 10 });
    const report = buildMarginReport(input, { ...complete, computeRuntime: [{ holdId: a1, runtimeMs: 60_000 }, { holdId: a2, runtimeMs: 120_000 }, { holdId: a3, runtimeMs: 5_000 }] });
    expect(report).toMatchObject({
      scopeId: 'a',
      currency: 'USD',
      paidFundedRevenueMicro: 166_234,
      promotionalUsageMicro: 83_117,
      revenueReversalsMicro: 0,
      refundsMicro: 1_000,
      supplierCostMicro: 25_000 + 50_000 + 150,
      failedWorkSupplierCostMicro: 150,
      openSupplierMicro: 0,
      computeAllocationMicro: 1_850,
      status: 'reconciled',
      unreconciledReasons: [],
      contributionMicro: 166_234 - 75_150 - 1_850 - 3_000,
    });
    expect(report.contributionRatio).toBeCloseTo(86_234 / 166_234, 10);
    expect(report.settledUsageRefs).toEqual(['a-1', 'a-2', 'a-3']);
    expect(report.otherCosts).toEqual([
      { label: 'payment fees', micro: 3_000, excludedReason: null },
      { label: 'support', micro: null, excludedReason: 'not measured in this period' },
    ]);
  });

  it('keeps the other workspace apart, and states no contribution while a cost is missing', async () => {
    const { store } = await twoWorkspaces();
    const b = await marginReport(store, { scopeId: 'b', fromDay: DAY, toDay: DAY, allocationVersion: 'alloc-1', asOf: D + 10 }, { version: 'alloc-1', computeRuntime: [], otherCosts: [{ label: 'payment fees' }] });
    expect(b).toMatchObject({ paidFundedRevenueMicro: 83_117, supplierCostMicro: 25_000, status: 'unreconciled', contributionMicro: null, contributionRatio: null });
    expect(b.unreconciledReasons).toEqual(['compute_cost_missing', 'other_cost_missing:payment fees']);
    expect(b.settledUsageRefs).toEqual(['b-1']);
  });

  it.each([1_000, 86_400_000])('counts a late report once and preserves historical asOf at delay %i', async (delay) => {
    const { store } = await twoWorkspaces();
    const holdId = await call(store, 'b', 'late-free', 1);
    await authorizeModelAttempt(store, { holdId, attemptId: 'late', purpose: 'initial', at: D + 10 });
    await settleCompoundCredit(store, { holdId, connectedMs: 0, fence: FENCED, unbilled: true, at: D + 11 });
    const query = { scopeId: 'b', fromDay: DAY, toDay: DAY, allocationVersion: 'alloc-1', asOf: D + 12 };
    const before = await readMarginPeriod(store, query);
    await recordAttemptUsage(store, { holdId, attemptId: 'late', usage: { input_token: 100 }, final: true, at: D + delay });
    expect(await readMarginPeriod(store, query)).toEqual(before);
    const today = await marginReport(store, { ...query, asOf: D + delay + 1 }, complete);
    expect(today.supplierCostMicro).toBe(25_000 + (delay < 86_400_000 ? 15 : 0));
    expect(today.failedWorkSupplierCostMicro).toBe(delay < 86_400_000 ? 15 : 0);
    if (delay === 86_400_000) {
      const tomorrow = await marginReport(store, { ...query, fromDay: '2026-10-13', toDay: '2026-10-13', asOf: D + delay + 1 }, complete);
      expect(tomorrow).toMatchObject({ supplierCostMicro: 15, failedWorkSupplierCostMicro: 15, paidFundedRevenueMicro: 0 });
    }
  });

  it('has no ratio at zero revenue, and counts an open attempt as unreconciled supplier cost', () => {
    const report = buildMarginReport(
      {
        scopeId: 'p', fromDay: DAY, toDay: DAY, asOf: D,
        settlements: [{ holdId: 'h', operationId: 'op', kind: 'call', day: DAY, chargedMicro: 9_000, paidFundedMicro: 0, promotionalMicro: 9_000, supplierSettledMicro: 3_000, supplierOpenMicro: 1_537, failed: false }],
        lateSupplierMicro: 0, reversalsMicro: 0, refundsMicro: 0, platformLossMicro: 0,
      },
      { ...complete, otherCosts: [] },
    );
    expect(report).toMatchObject({ paidFundedRevenueMicro: 0, promotionalUsageMicro: 9_000, openSupplierMicro: 1_537, status: 'unreconciled', contributionRatio: null });
    expect(report.unreconciledReasons).toEqual(['supplier_cost_open']);
  });
});
