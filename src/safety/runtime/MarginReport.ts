/**
 * @fileoverview A scope's margin over a bounded UTC period, reconciled to the compound credit ledger: revenue from
 * settled usage funded by paid lots, promotional consumption apart, revenue reversals (a dispute's receivable), refunds
 * of unspent credit (a liability, not revenue), supplier cost including failed work, occupied compute attributed by
 * measured runtime at a host-cost rate, and every other cost quantified or excluded with its reason. A missing cost
 * makes the report unreconciled, and an unreconciled report states no contribution. The host supplies the allocation
 * policy and the labels; the arithmetic is here.
 *
 * @module safety/runtime/MarginReport
 */
import { componentMicro, type RationalRate } from './CreditRates.js';
import type { CreditHoldRow, ICompoundCreditStore } from './CompoundCreditStore.js';
import { creditDay } from './CompoundCreditStore.js';

/** A report's query: one scope, a bounded UTC period, an allocation version. */
export interface MarginReportQuery {
  scopeId: string;
  /** The first UTC day, inclusive, `YYYY-MM-DD`. */
  fromDay: string;
  /** The last UTC day, inclusive. */
  toDay: string;
  allocationVersion: string;
  /** The time the report is as of; a later adjustment keeps its own period. */
  asOf: number;
}

/** One operation settled in the period, with its funding split. */
export interface MarginSettlement {
  holdId: string;
  operationId: string;
  kind: string;
  day: string;
  chargedMicro: number;
  /** The part of the charge consumed from paid lots: recognized revenue. */
  paidFundedMicro: number;
  /** The part consumed from promotions: subsidy. */
  promotionalMicro: number;
  supplierSettledMicro: number;
  supplierOpenMicro: number;
  /** Charged nothing: a setup that failed or a call that never connected. */
  failed: boolean;
}

/** What a period holds, read from a store. */
export interface MarginPeriodInput {
  scopeId: string;
  fromDay: string;
  toDay: string;
  asOf: number;
  settlements: MarginSettlement[];
  /** Supplier cost reported in the period for attempts of operations settled earlier. */
  lateSupplierMicro: number;
  /** The part of lateSupplierMicro attributable to customer-free operations. */
  lateFailedSupplierMicro?: number;
  /** Consumed funds reversed by lost disputes in the period (their receivables). */
  reversalsMicro: number;
  /** Refunds of unspent paid credit completed in the period. */
  refundsMicro: number;
  /** Losses the ledger recorded in the period (overruns past a hold). */
  platformLossMicro: number;
}

/** The host's allocation policy for one report. */
export interface MarginAllocationPolicy {
  version: string;
  /** The cost of occupied compute per measured unit of runtime (milliseconds); absent leaves compute unreconciled. */
  hostCostRate?: RationalRate;
  /**
   * Measured runtime of the period's operations, by hold. Every hold settled in the period needs one, an explicit zero
   * included: a hold without one leaves compute unreconciled, never priced at zero.
   */
  computeRuntime: ReadonlyArray<{ holdId: string; runtimeMs: number }>;
  /** Every other cost: quantified, or excluded with its reason. */
  otherCosts: ReadonlyArray<{ label: string; micro?: number; excludedReason?: string }>;
}

/** A scope's margin over a period. Amounts are whole micro-dollars. */
export interface MarginReport {
  scopeId: string;
  currency: 'USD';
  fromDay: string;
  toDay: string;
  allocationVersion: string;
  asOf: number;
  /** The operations settled in the period. */
  settledUsageRefs: string[];
  paidFundedRevenueMicro: number;
  promotionalUsageMicro: number;
  revenueReversalsMicro: number;
  refundsMicro: number;
  /** Supplier cost settled in the period, failed work and late reports included. */
  supplierCostMicro: number;
  failedWorkSupplierCostMicro: number;
  /** Supplier liability still open: unreported attempts at their most. */
  openSupplierMicro: number;
  /** Occupied compute at the host-cost rate; null without the rate or without a measured runtime for every settled hold. */
  computeAllocationMicro: number | null;
  otherCosts: Array<{ label: string; micro: number | null; excludedReason: string | null }>;
  platformLossMicro: number;
  /** Revenue less reversals, supplier cost, compute and other costs; null while unreconciled. */
  contributionMicro: number | null;
  /** Contribution over revenue; null while unreconciled or at zero revenue. */
  contributionRatio: number | null;
  status: 'reconciled' | 'unreconciled';
  unreconciledReasons: string[];
}

const inPeriod = (day: string, from: string, to: string): boolean => day >= from && day <= to;

/**
 * Reads a scope's period from a store through the transaction reads every store implements: the holds settled or
 * released in the period (their settlement day), their allocations' consumption split by lot kind, and the period's
 * entries. The period's holds are the ones its settlement entries name, so however many holds the scope settled
 * before the period, none of the period's own is left out.
 */
export async function readMarginPeriod(store: ICompoundCreditStore, query: MarginReportQuery): Promise<MarginPeriodInput> {
  return store.withTransaction(async (trx) => {
    const entries = (await trx.listEntries({ scopeId: query.scopeId, fromDay: query.fromDay, toDay: query.toDay })).filter((e) => e.at <= query.asOf);
    const supplierEntries = entries.filter((e) => e.kind === 'supplier_settled');
    // Each settlement appends one hold_settled or hold_released entry on its own day, so the period's entries name every
    // hold it settled; a read of the scope's settled holds, oldest first, could stop before them.
    const settledIds = new Set(entries.flatMap((e) => ((e.kind === 'hold_settled' || e.kind === 'hold_released') && e.holdId !== null ? [e.holdId] : [])));
    const holds: CreditHoldRow[] = [];
    for (const holdId of settledIds) {
      const hold = await trx.getHold(holdId);
      if (!hold || hold.scopeId !== query.scopeId || hold.settledAt === null) continue;
      if (hold.settledAt <= query.asOf && inPeriod(creditDay(hold.settledAt), query.fromDay, query.toDay)) holds.push(hold);
    }
    const settlements: MarginSettlement[] = [];
    for (const hold of holds) {
      let paid = 0;
      let promotional = 0;
      for (const allocation of await trx.listAllocations(hold.holdId)) {
        const lot = await trx.getLot(allocation.lotId);
        if (lot?.kind === 'promotion') promotional += allocation.consumedMicro;
        else paid += allocation.consumedMicro;
      }
      settlements.push({
        holdId: hold.holdId,
        operationId: hold.operationId,
        kind: hold.kind,
        day: creditDay(hold.settledAt!),
        chargedMicro: hold.chargedMicro,
        paidFundedMicro: paid,
        promotionalMicro: promotional,
        supplierSettledMicro: supplierEntries.filter((e) => e.holdId === hold.holdId).reduce((sum, e) => sum + e.amountMicro, 0),
        supplierOpenMicro: (await trx.listAttempts(hold.holdId)).filter((attempt) =>
          attempt.authorizedAt <= query.asOf && (!attempt.final || attempt.recordedAt === null || attempt.recordedAt > query.asOf)
        ).length * hold.attemptSupplierMicro,
        failed: hold.chargedMicro === 0,
      });
    }
    const included = new Set(holds.map((hold) => hold.holdId));
    const late = supplierEntries.filter((e) => e.holdId !== null && !included.has(e.holdId));
    let lateFailedSupplierMicro = 0;
    for (const entry of late) {
      const hold = entry.holdId === null ? undefined : await trx.getHold(entry.holdId);
      if (hold?.chargedMicro === 0) lateFailedSupplierMicro += entry.amountMicro;
    }
    const sum = (pick: (e: (typeof entries)[number]) => boolean): number => entries.filter(pick).reduce((total, e) => total + e.amountMicro, 0);
    return {
      scopeId: query.scopeId,
      fromDay: query.fromDay,
      toDay: query.toDay,
      asOf: query.asOf,
      settlements: settlements.sort((a, b) => (a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0)),
      lateSupplierMicro: late.reduce((total, e) => total + e.amountMicro, 0),
      lateFailedSupplierMicro,
      reversalsMicro: sum((e) => e.kind === 'receivable'),
      refundsMicro: sum((e) => e.kind === 'refund_completed'),
      platformLossMicro: sum((e) => e.kind === 'platform_loss'),
    };
  });
}

/** The report's arithmetic over a period read by {@link readMarginPeriod}. */
export function buildMarginReport(input: MarginPeriodInput, policy: MarginAllocationPolicy): MarginReport {
  const reasons: string[] = [];
  const revenue = input.settlements.reduce((s, x) => s + x.paidFundedMicro, 0);
  const supplier = input.settlements.reduce((s, x) => s + x.supplierSettledMicro, 0) + input.lateSupplierMicro;
  const open = input.settlements.reduce((s, x) => s + x.supplierOpenMicro, 0);
  if (open > 0) reasons.push('supplier_cost_open');
  let compute: number | null = null;
  if (policy.hostCostRate) {
    const held = new Set(input.settlements.map((s) => s.holdId));
    const measured = policy.computeRuntime.filter((r) => held.has(r.holdId));
    // A settled hold with no measurement has an unknown compute cost, not a zero one.
    if (new Set(measured.map((r) => r.holdId)).size === held.size) {
      compute = componentMicro(measured.reduce((s, r) => s + r.runtimeMs, 0), policy.hostCostRate);
    } else {
      reasons.push('compute_runtime_missing');
    }
  } else {
    reasons.push('compute_cost_missing');
  }
  const otherCosts = policy.otherCosts.map((c) => {
    if (c.micro === undefined && !c.excludedReason) reasons.push(`other_cost_missing:${c.label}`);
    return { label: c.label, micro: c.micro ?? null, excludedReason: c.excludedReason ?? null };
  });
  const reconciled = reasons.length === 0;
  const others = otherCosts.reduce((s, c) => s + (c.micro ?? 0), 0);
  const contribution = reconciled ? revenue - input.reversalsMicro - supplier - (compute ?? 0) - others : null;
  return {
    scopeId: input.scopeId,
    currency: 'USD',
    fromDay: input.fromDay,
    toDay: input.toDay,
    allocationVersion: policy.version,
    asOf: input.asOf,
    settledUsageRefs: input.settlements.map((s) => s.operationId),
    paidFundedRevenueMicro: revenue,
    promotionalUsageMicro: input.settlements.reduce((s, x) => s + x.promotionalMicro, 0),
    revenueReversalsMicro: input.reversalsMicro,
    refundsMicro: input.refundsMicro,
    supplierCostMicro: supplier,
    failedWorkSupplierCostMicro: input.settlements.filter((s) => s.failed).reduce((s, x) => s + x.supplierSettledMicro, 0) + (input.lateFailedSupplierMicro ?? 0),
    openSupplierMicro: open,
    computeAllocationMicro: compute,
    otherCosts,
    platformLossMicro: input.platformLossMicro,
    contributionMicro: contribution,
    contributionRatio: contribution !== null && revenue > 0 ? contribution / revenue : null,
    status: reconciled ? 'reconciled' : 'unreconciled',
    unreconciledReasons: reasons,
  };
}

/** Reads a period and builds its report. */
export async function marginReport(store: ICompoundCreditStore, query: MarginReportQuery, policy: MarginAllocationPolicy): Promise<MarginReport> {
  return buildMarginReport(await readMarginPeriod(store, query), { ...policy, version: query.allocationVersion });
}
