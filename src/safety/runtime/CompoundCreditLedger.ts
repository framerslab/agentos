/**
 * @fileoverview The compound credit ledger: funding lots granted once, a call's most reserved against them before any
 * work starts, settled once from its measured quantities, and the movements a payment rail needs around it (refunds of
 * free paid principal, disputes, promotion expiry), each in one transaction of an {@link ICompoundCreditStore}.
 *
 * The invariants every operation keeps, per lot: `principal = consumed + held + refunded + retired + free` with every
 * term zero or more, so no path creates spendable credit or makes a free balance negative. A hold is allocated to lots
 * in the host's policy order when it is reserved, and settlement consumes those shares in that order; an expired
 * promotion's share stays valid for the hold that took it, and whatever such a share does not consume retires instead
 * of funding another call. A hold settles once, and only with evidence that its media closed and its inference
 * stopped; without it the hold is deferred, still held. Amounts are whole micro-dollars, times epoch milliseconds.
 *
 * @module safety/runtime/CompoundCreditLedger
 */
import { randomUUID } from 'node:crypto';
import {
  componentMicro,
  isBilledPerAttempt,
  quoteCompoundLiability,
  rateComponent,
  type AttemptLimits,
  type CompoundLiability,
  type RateSnapshot,
} from './CreditRates.js';
import {
  CreditConflictError,
  creditDay,
  type CreditAllocationRow,
  type CreditAttemptRow,
  type CreditHoldRow,
  type CreditLotKind,
  type CreditLotRow,
  type CreditTransaction,
  type ICompoundCreditStore,
} from './CompoundCreditStore.js';

/** The snapshots a hold is priced under: its primary, and the fallbacks its attempts may use. */
export interface HoldRates {
  primary: RateSnapshot;
  fallbacks: readonly RateSnapshot[];
}

/** Orders a scope's lots for allocation; lots it leaves out are not used. */
export type AllocationPolicy = (lots: readonly CreditLotRow[], at: number) => CreditLotRow[];

/** A lot's free balance: what is neither consumed, held, refunded nor retired. */
export function lotFreeMicro(lot: CreditLotRow): number {
  return lot.principalMicro - lot.consumedMicro - lot.heldMicro - lot.refundedMicro - lot.retiredMicro;
}

/** Whether a lot may fund a new hold at `at`: active, unexpired and with a free balance. */
export function isLotEligible(lot: CreditLotRow, at: number): boolean {
  return lot.state === 'active' && (lot.expiresAt === null || lot.expiresAt > at) && lotFreeMicro(lot) > 0;
}

/**
 * The default allocation policy: eligible promotions first, the earliest-expiring first, then paid lots in creation
 * and id order.
 */
export const promotionsFirstPolicy: AllocationPolicy = (lots, at) => {
  const eligible = lots.filter((lot) => isLotEligible(lot, at));
  const tie = (a: CreditLotRow, b: CreditLotRow): number => a.createdAt - b.createdAt || (a.lotId < b.lotId ? -1 : a.lotId > b.lotId ? 1 : 0);
  const promotions = eligible.filter((l) => l.kind === 'promotion').sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity) || tie(a, b));
  const paid = eligible.filter((l) => l.kind === 'paid').sort(tie);
  return [...promotions, ...paid];
};

/**
 * The supplier-day key every reservation locks before it reads the open supplier liability. That liability spans every
 * day, so admissions queue on this one platform-wide row: the row of the reservation's own day would let two
 * reservations on either side of midnight both read it before either holds.
 */
const SUPPLIER_ADMISSION_KEY = 'admission';

/** Throws unless `value` is a whole number at least `min`. */
function whole(name: string, value: number, min = 0): void {
  if (!Number.isSafeInteger(value) || value < min) throw new RangeError(`${name} must be a whole number of at least ${min}, not ${value}`);
}

/**
 * Runs `fn` in one transaction, again when a concurrent writer took a version or a unique key first (two first grants
 * of one scope, two reservations racing on a new account), at most three times in all.
 */
export async function withCreditRetry<T>(store: ICompoundCreditStore, fn: (trx: CreditTransaction) => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await store.withTransaction(fn);
    } catch (err) {
      if (!(err instanceof CreditConflictError)) throw err;
      last = err;
    }
  }
  throw last;
}

// ── Lots ──

/** What {@link grantCreditLot} grants. */
export interface GrantCreditLotInput {
  scopeId: string;
  /** The lot's id; one is made when absent. */
  lotId?: string;
  kind: CreditLotKind;
  /** The confirmed payment or the promotion the lot is for; a second grant for it answers the first lot. */
  fundingRef: string;
  principalMicro: number;
  /** When a promotion expires; null or absent for a lot that does not. */
  expiresAt?: number | null;
  at: number;
}

/** A grant's answer. */
export interface GrantCreditLotResult {
  status: 'granted' | 'existing';
  lot: CreditLotRow;
}

/** Grants a lot once by its funding reference, making the scope's account when it has none. */
export async function grantCreditLot(store: ICompoundCreditStore, input: GrantCreditLotInput): Promise<GrantCreditLotResult> {
  whole('principalMicro', input.principalMicro, 1);
  if (input.kind === 'paid' && input.expiresAt != null) throw new RangeError('a paid lot has no product-imposed expiry');
  return withCreditRetry(store, async (trx) => {
    const account = await trx.lockAccount(input.scopeId);
    if (!account) await trx.putAccount({ scopeId: input.scopeId, currency: 'USD', frozen: false, openDisputes: 0, createdAt: input.at, version: 1 });
    const existing = await trx.findLotByFundingRef(input.scopeId, input.fundingRef);
    if (existing) return { status: 'existing', lot: existing };
    const lot: CreditLotRow = {
      lotId: input.lotId ?? `lot_${randomUUID()}`,
      scopeId: input.scopeId,
      kind: input.kind,
      fundingRef: input.fundingRef,
      principalMicro: input.principalMicro,
      consumedMicro: 0,
      heldMicro: 0,
      refundedMicro: 0,
      retiredMicro: 0,
      state: 'active',
      expiresAt: input.expiresAt ?? null,
      createdAt: input.at,
      version: 1,
    };
    await trx.putLot(lot);
    await trx.appendEntry({ entryId: `lot:${lot.lotId}:granted`, scopeId: input.scopeId, kind: 'lot_granted', amountMicro: lot.principalMicro, lotId: lot.lotId, holdId: null, ref: input.fundingRef, at: input.at, day: creditDay(input.at) });
    return { status: 'granted', lot };
  });
}

/** A scope's balance: what new holds may take, what is held, and each lot's free balance. */
export interface CreditBalance {
  availableMicro: number;
  heldMicro: number;
  lots: Array<{ lotId: string; kind: CreditLotKind; freeMicro: number; heldMicro: number; expiresAt: number | null; state: CreditLotRow['state'] }>;
}

/** The scope's balance at `at`: available counts only the lots the policy would allocate from. */
export async function creditBalance(store: ICompoundCreditStore, scopeId: string, at: number, policy: AllocationPolicy = promotionsFirstPolicy): Promise<CreditBalance> {
  return store.withTransaction(async (trx) => {
    const lots = await trx.listLots(scopeId);
    const eligible = policy(lots, at);
    return {
      availableMicro: eligible.reduce((sum, lot) => sum + lotFreeMicro(lot), 0),
      heldMicro: lots.reduce((sum, lot) => sum + lot.heldMicro, 0),
      lots: lots.map((lot) => ({ lotId: lot.lotId, kind: lot.kind, freeMicro: lotFreeMicro(lot), heldMicro: lot.heldMicro, expiresAt: lot.expiresAt, state: lot.state })),
    };
  });
}

// ── Holds ──

/** What {@link reserveCompoundCredit} reserves: a call's most, quoted inside the ledger from its rates and limits. */
export interface ReserveCompoundCreditInput {
  scopeId: string;
  /** The host's id for the call or run; a hold is made once for it. */
  operationId: string;
  /** What is held for, such as `call` or `meeting_run`. */
  kind: string;
  /** A digest of the request the hold is for; the same operation with another digest is a conflict. */
  requestHash: string;
  rates: { primary: RateSnapshot; fallbacks?: readonly RateSnapshot[] };
  /** The component that prices connected time. */
  mediaComponent: string;
  /** The call's full requested duration, whole seconds. */
  durationSeconds: number;
  attempts: AttemptLimits;
  /** The platform's cap on supplier cost for the UTC day of `at`, across every scope. */
  supplierDailyCapMicro: number;
  at: number;
  /** When the hold's time is up and a reconcile asks about it. */
  expiresAt: number;
  policy?: AllocationPolicy;
}

/** A reservation's answer. */
export type ReserveCompoundCreditResult =
  | { status: 'reserved' | 'existing'; hold: CreditHoldRow; allocations: CreditAllocationRow[]; liability: CompoundLiability }
  | { status: 'refused'; reason: 'no_account' | 'account_frozen' | 'insufficient_credit' | 'supplier_cap'; availableMicro: number; liability: CompoundLiability }
  | { status: 'conflict'; hold: CreditHoldRow };

/**
 * Reserves a call's most before any room, dispatch or model work: the liability is quoted here from the rates and
 * limits, the customer's side is allocated to lots in the policy's order, and the supplier's side is checked against
 * the platform's daily cap together with every hold still open, whatever day it was made on. Reservations that reach
 * that check take it one at a time, on one platform-wide lock, so two on different UTC days never both read the open
 * liability before either holds. Idempotent per operation.
 */
export async function reserveCompoundCredit(store: ICompoundCreditStore, input: ReserveCompoundCreditInput): Promise<ReserveCompoundCreditResult> {
  whole('supplierDailyCapMicro', input.supplierDailyCapMicro, 0);
  if (!(input.expiresAt > input.at)) throw new RangeError('a hold expires after it is made');
  const fallbacks = input.rates.fallbacks ?? [];
  const liability = quoteCompoundLiability({ rates: input.rates.primary, fallbackRates: fallbacks, mediaComponent: input.mediaComponent, durationSeconds: input.durationSeconds, attempts: input.attempts });
  const policy = input.policy ?? promotionsFirstPolicy;
  return withCreditRetry(store, async (trx) => {
    const account = await trx.lockAccount(input.scopeId);
    const existing = await trx.findHoldByOperation(input.scopeId, input.operationId);
    if (existing) {
      if (existing.requestHash !== input.requestHash) return { status: 'conflict', hold: existing };
      return { status: 'existing', hold: existing, allocations: await trx.listAllocations(existing.holdId), liability };
    }
    if (!account) return { status: 'refused', reason: 'no_account', availableMicro: 0, liability };
    const ordered = policy(await trx.listLots(input.scopeId), input.at);
    const availableMicro = ordered.reduce((sum, lot) => sum + lotFreeMicro(lot), 0);
    if (account.frozen) return { status: 'refused', reason: 'account_frozen', availableMicro, liability };
    if (availableMicro < liability.customerMicro) return { status: 'refused', reason: 'insufficient_credit', availableMicro, liability };
    await trx.lockSupplierDay(SUPPLIER_ADMISSION_KEY);
    const day = await trx.lockSupplierDay(creditDay(input.at));
    const open = await trx.openSupplierMicro();
    if (day.settledMicro + open + liability.supplierMicro > input.supplierDailyCapMicro) {
      return { status: 'refused', reason: 'supplier_cap', availableMicro, liability };
    }
    const holdId = `hold_${randomUUID()}`;
    const allocations: CreditAllocationRow[] = [];
    let remaining = liability.customerMicro;
    for (const lot of ordered) {
      if (remaining === 0) break;
      const take = Math.min(lotFreeMicro(lot), remaining);
      if (take <= 0) continue;
      await trx.putLot({ ...lot, heldMicro: lot.heldMicro + take, version: lot.version + 1 });
      const allocation: CreditAllocationRow = { holdId, seq: allocations.length + 1, lotId: lot.lotId, amountMicro: take, consumedMicro: 0, releasedMicro: 0, retiredMicro: 0, settled: false };
      await trx.putAllocation(allocation);
      allocations.push(allocation);
      remaining -= take;
    }
    const hold: CreditHoldRow = {
      holdId,
      scopeId: input.scopeId,
      operationId: input.operationId,
      kind: input.kind,
      requestHash: input.requestHash,
      customerMicro: liability.customerMicro,
      supplierMicro: liability.supplierMicro,
      mediaCustomerMicro: liability.media.customerMicro,
      mediaSupplierMicro: liability.media.supplierMicro,
      attemptCustomerMicro: liability.perAttempt.customerMicro,
      attemptSupplierMicro: liability.perAttempt.supplierMicro,
      maxAttempts: liability.maxAttempts,
      attemptLimits: JSON.stringify(input.attempts),
      rateVersion: input.rates.primary.version,
      rates: JSON.stringify({ primary: input.rates.primary, fallbacks } satisfies HoldRates),
      mediaComponent: input.mediaComponent,
      state: 'held',
      chargedMicro: 0,
      supplierSettledMicro: 0,
      supplierOpenMicro: 0,
      createdAt: input.at,
      expiresAt: input.expiresAt,
      settledAt: null,
      deferredUntil: null,
      fenceEvidence: null,
      version: 1,
    };
    await trx.putHold(hold);
    await trx.appendEntry({ entryId: `hold:${holdId}:reserved`, scopeId: input.scopeId, kind: 'hold_reserved', amountMicro: liability.customerMicro, lotId: null, holdId, ref: input.operationId, at: input.at, day: creditDay(input.at) });
    return { status: 'reserved', hold, allocations, liability };
  });
}

/** Evidence that a call's work stopped: its media closed, and its inference ended (a native abort or a process exit). */
export interface CallFence {
  mediaClosed: boolean;
  inferenceTerminated: boolean;
  /** What showed it: a teardown id, an abort acknowledgement, an exit code. */
  evidence: string;
  observedAt: number;
}

/** What {@link settleCompoundCredit} settles. */
export interface SettleCompoundCreditInput {
  holdId: string;
  /** The call's connected time, the union of its connected intervals, in milliseconds. */
  connectedMs: number;
  fence: CallFence;
  at: number;
  /** When a deferred hold is asked about again; 15 seconds when absent. */
  retryAfterMs?: number;
  /**
   * A failure the customer does not pay for (a setup that never connected): the customer is charged nothing and the
   * hold is released, while the supplier cost the media and the recorded attempts incurred still settles.
   */
  unbilled?: boolean;
}

/** A settlement's answer. */
export type SettleCompoundCreditResult =
  | { status: 'settled'; hold: CreditHoldRow; chargedMicro: number; lossMicro: number; allocations: CreditAllocationRow[] }
  | { status: 'deferred'; hold: CreditHoldRow }
  | { status: 'already_settled'; hold: CreditHoldRow }
  | { status: 'not_found' };

/** The snapshot an attempt was priced under. */
function snapshotOf(rates: HoldRates, version: string): RateSnapshot {
  if (rates.primary.version === version) return rates.primary;
  const fallback = rates.fallbacks.find((r) => r.version === version);
  if (!fallback) throw new RangeError(`the hold has no snapshot ${version}`);
  return fallback;
}

/** An attempt's reported quantities, by component key. */
export function attemptUsageOf(attempt: CreditAttemptRow): Record<string, number> {
  if (!attempt.usage) return {};
  const parsed = JSON.parse(attempt.usage) as Record<string, number>;
  return parsed;
}

/**
 * What a hold's recorded attempts cost, on each side: each attempt's quantities summed per snapshot and component, the
 * customer's capped at the per-attempt limits, then each component rounded up once; plus each snapshot's per-attempt
 * minimum. Attempts never reported cost the customer nothing and keep their supplier most open.
 */
export function priceAttempts(hold: CreditHoldRow, attempts: readonly CreditAttemptRow[]): { customerMicro: number; supplierMicro: number; supplierOpenMicro: number } {
  const rates = JSON.parse(hold.rates) as HoldRates;
  const limits = JSON.parse(hold.attemptLimits) as AttemptLimits;
  const customerQty = new Map<string, Map<string, number>>();
  const supplierQty = new Map<string, Map<string, number>>();
  let customer = 0;
  let supplier = 0;
  let open = 0;
  const add = (table: Map<string, Map<string, number>>, version: string, key: string, quantity: number): void => {
    const byKey = table.get(version) ?? new Map<string, number>();
    byKey.set(key, (byKey.get(key) ?? 0) + quantity);
    table.set(version, byKey);
  };
  for (const attempt of attempts) {
    if (attempt.state !== 'recorded') {
      open += hold.attemptSupplierMicro;
      continue;
    }
    const snapshot = snapshotOf(rates, attempt.rateVersion);
    for (const [key, quantity] of Object.entries(attemptUsageOf(attempt))) {
      add(customerQty, snapshot.version, key, Math.min(quantity, limits.perAttempt[key] ?? 0));
      add(supplierQty, snapshot.version, key, quantity);
    }
    if (snapshot.attemptMinimum) {
      customer += snapshot.attemptMinimum.customerMicro;
      supplier += snapshot.attemptMinimum.supplierMicro;
    }
  }
  for (const [version, byKey] of customerQty) {
    const snapshot = snapshotOf(rates, version);
    for (const [key, quantity] of byKey) if (isBilledPerAttempt(snapshot, key)) customer += componentMicro(quantity, rateComponent(snapshot, key).customer);
  }
  for (const [version, byKey] of supplierQty) {
    const snapshot = snapshotOf(rates, version);
    for (const [key, quantity] of byKey) if (isBilledPerAttempt(snapshot, key)) supplier += componentMicro(quantity, rateComponent(snapshot, key).supplier);
  }
  return { customerMicro: customer, supplierMicro: supplier, supplierOpenMicro: open };
}

/** Moves a hold to deferred, still held, with its evidence and its next check. */
async function deferHold(trx: CreditTransaction, hold: CreditHoldRow, retryAt: number, evidence: string): Promise<CreditHoldRow> {
  const deferred: CreditHoldRow = { ...hold, state: 'deferred', deferredUntil: retryAt, fenceEvidence: evidence, version: hold.version + 1 };
  await trx.putHold(deferred);
  return deferred;
}

/**
 * Settles a hold once: connected time rounded up once to whole seconds at the media rate, plus the recorded attempts'
 * declared units, each final component rounded up once, held to the hold's customer most (an overrun is the platform's
 * loss, never an overdraft). The charge consumes the hold's allocations in their order; each share's remainder returns
 * to its lot, or retires when the lot is an expired promotion or closed. Supplier cost settles on the day of `at`.
 * Without evidence that the media closed and the inference stopped, nothing settles: the hold is deferred.
 */
export async function settleCompoundCredit(store: ICompoundCreditStore, input: SettleCompoundCreditInput): Promise<SettleCompoundCreditResult> {
  whole('connectedMs', input.connectedMs, 0);
  const scopeId = await store.withTransaction(async (trx) => (await trx.getHold(input.holdId))?.scopeId);
  if (scopeId === undefined) return { status: 'not_found' };
  return withCreditRetry(store, async (trx) => {
    await trx.lockAccount(scopeId);
    const hold = await trx.getHold(input.holdId);
    if (!hold) return { status: 'not_found' };
    if (hold.state === 'settled' || hold.state === 'released') return { status: 'already_settled', hold };
    if (!input.fence.mediaClosed || !input.fence.inferenceTerminated) {
      return { status: 'deferred', hold: await deferHold(trx, hold, input.at + (input.retryAfterMs ?? 15_000), JSON.stringify(input.fence)) };
    }
    const rates = JSON.parse(hold.rates) as HoldRates;
    const media = rateComponent(rates.primary, hold.mediaComponent);
    const seconds = Math.ceil(input.connectedMs / 1_000);
    const priced = priceAttempts(hold, await trx.listAttempts(hold.holdId));
    const owed = componentMicro(seconds, media.customer) + priced.customerMicro;
    const charged = input.unbilled ? 0 : Math.min(owed, hold.customerMicro);
    const lossMicro = input.unbilled ? 0 : owed - charged;
    const supplierSettled = componentMicro(seconds, media.supplier) + priced.supplierMicro;
    const allocations = await trx.listAllocations(hold.holdId);
    let remaining = charged;
    const settledAllocations: CreditAllocationRow[] = [];
    for (const allocation of allocations) {
      const take = Math.min(allocation.amountMicro, remaining);
      remaining -= take;
      const lot = await trx.getLot(allocation.lotId);
      if (!lot) throw new CreditConflictError('lots', allocation.lotId);
      const leftover = allocation.amountMicro - take;
      const expired = lot.expiresAt !== null && lot.expiresAt <= input.at;
      const retire = lot.state === 'closed' || (lot.kind === 'promotion' && expired) ? leftover : 0;
      await trx.putLot({ ...lot, heldMicro: lot.heldMicro - allocation.amountMicro, consumedMicro: lot.consumedMicro + take, retiredMicro: lot.retiredMicro + retire, version: lot.version + 1 });
      const settled: CreditAllocationRow = { ...allocation, consumedMicro: take, releasedMicro: leftover - retire, retiredMicro: retire, settled: true };
      await trx.putAllocation(settled);
      settledAllocations.push(settled);
      if (retire > 0) {
        await trx.appendEntry({ entryId: `hold:${hold.holdId}:retired:${allocation.seq}`, scopeId: hold.scopeId, kind: 'promotion_retired', amountMicro: retire, lotId: lot.lotId, holdId: hold.holdId, ref: null, at: input.at, day: creditDay(input.at) });
      }
    }
    const day = await trx.lockSupplierDay(creditDay(input.at));
    await trx.putSupplierDay({ day: day.day, settledMicro: day.settledMicro + supplierSettled, version: day.version + 1 });
    const done: CreditHoldRow = {
      ...hold,
      state: charged === 0 ? 'released' : 'settled',
      chargedMicro: charged,
      supplierSettledMicro: supplierSettled,
      supplierOpenMicro: priced.supplierOpenMicro,
      settledAt: input.at,
      deferredUntil: null,
      fenceEvidence: JSON.stringify(input.fence),
      version: hold.version + 1,
    };
    await trx.putHold(done);
    const entry = { scopeId: hold.scopeId, lotId: null, holdId: hold.holdId, at: input.at, day: creditDay(input.at) };
    await trx.appendEntry({ ...entry, entryId: `hold:${hold.holdId}:settled`, kind: charged === 0 ? 'hold_released' : 'hold_settled', amountMicro: charged, ref: hold.operationId });
    await trx.appendEntry({ ...entry, entryId: `hold:${hold.holdId}:supplier`, kind: 'supplier_settled', amountMicro: supplierSettled, ref: hold.operationId });
    if (lossMicro > 0) await trx.appendEntry({ ...entry, entryId: `hold:${hold.holdId}:loss`, kind: 'platform_loss', amountMicro: lossMicro, ref: 'customer_overrun' });
    const supplierOverrun = supplierSettled + priced.supplierOpenMicro - hold.supplierMicro;
    if (supplierOverrun > 0) await trx.appendEntry({ ...entry, entryId: `hold:${hold.holdId}:supplier_overrun`, kind: 'platform_loss', amountMicro: supplierOverrun, ref: 'supplier_overrun' });
    return { status: 'settled', hold: done, chargedMicro: charged, lossMicro, allocations: settledAllocations };
  });
}

/** Defers a hold whose work may still run, with its evidence and its next check. */
export async function deferCompoundHold(store: ICompoundCreditStore, input: { holdId: string; retryAt: number; evidence: string }): Promise<CreditHoldRow | undefined> {
  const scopeId = await store.withTransaction(async (trx) => (await trx.getHold(input.holdId))?.scopeId);
  if (scopeId === undefined) return undefined;
  return withCreditRetry(store, async (trx) => {
    await trx.lockAccount(scopeId);
    const hold = await trx.getHold(input.holdId);
    if (!hold || hold.state === 'settled' || hold.state === 'released') return hold;
    return deferHold(trx, hold, input.retryAt, input.evidence);
  });
}

// ── Refunds, disputes, expiry ──

/** What {@link refundCreditLot} reserves for a refund. */
export interface RefundCreditLotInput {
  scopeId: string;
  lotId: string;
  /** The host's stable id for the refund; a second call with it answers the first. */
  refundId: string;
  amountMicro: number;
  at: number;
}

/** A refund reservation's answer; `refundableMicro` is the lot's free paid principal at that moment. */
export type RefundCreditLotResult =
  | { status: 'reserved' | 'existing'; refundableMicro: number }
  | { status: 'refused'; reason: 'not_found' | 'not_paid' | 'not_active' | 'insufficient_refundable'; refundableMicro: number };

/**
 * Reserves a refund before the payment rail is asked for it: only the paid lot's free principal (neither held nor
 * consumed) can be refunded, so a refund of committed funds is refused with what can be refunded now. Confirm or revert
 * it with {@link completeLotRefund}.
 */
export async function refundCreditLot(store: ICompoundCreditStore, input: RefundCreditLotInput): Promise<RefundCreditLotResult> {
  whole('amountMicro', input.amountMicro, 1);
  return withCreditRetry(store, async (trx) => {
    await trx.lockAccount(input.scopeId);
    const lot = await trx.getLot(input.lotId);
    if (!lot || lot.scopeId !== input.scopeId) return { status: 'refused', reason: 'not_found', refundableMicro: 0 };
    if (await trx.getEntry(`refund:${input.refundId}:reserved`)) return { status: 'existing', refundableMicro: lotFreeMicro(lot) };
    if (lot.kind !== 'paid') return { status: 'refused', reason: 'not_paid', refundableMicro: 0 };
    if (lot.state !== 'active') return { status: 'refused', reason: 'not_active', refundableMicro: 0 };
    const free = lotFreeMicro(lot);
    if (input.amountMicro > free) return { status: 'refused', reason: 'insufficient_refundable', refundableMicro: free };
    await trx.putLot({ ...lot, refundedMicro: lot.refundedMicro + input.amountMicro, version: lot.version + 1 });
    await trx.appendEntry({ entryId: `refund:${input.refundId}:reserved`, scopeId: input.scopeId, kind: 'refund_reserved', amountMicro: input.amountMicro, lotId: lot.lotId, holdId: null, ref: input.refundId, at: input.at, day: creditDay(input.at) });
    return { status: 'reserved', refundableMicro: free - input.amountMicro };
  });
}

/** Confirms a reserved refund once the payment rail reports it, or reverts it when the rail refused it. */
export async function completeLotRefund(store: ICompoundCreditStore, input: { scopeId: string; refundId: string; outcome: 'succeeded' | 'failed'; at: number }): Promise<'completed' | 'reverted' | 'already_completed' | 'not_found'> {
  return withCreditRetry(store, async (trx) => {
    await trx.lockAccount(input.scopeId);
    const reserved = await trx.getEntry(`refund:${input.refundId}:reserved`);
    if (!reserved || reserved.scopeId !== input.scopeId || !reserved.lotId) return 'not_found';
    if ((await trx.getEntry(`refund:${input.refundId}:completed`)) || (await trx.getEntry(`refund:${input.refundId}:reverted`))) return 'already_completed';
    const base = { scopeId: input.scopeId, amountMicro: reserved.amountMicro, lotId: reserved.lotId, holdId: null, ref: input.refundId, at: input.at, day: creditDay(input.at) };
    if (input.outcome === 'succeeded') {
      await trx.appendEntry({ ...base, entryId: `refund:${input.refundId}:completed`, kind: 'refund_completed' });
      return 'completed';
    }
    const lot = await trx.getLot(reserved.lotId);
    if (!lot) return 'not_found';
    await trx.putLot({ ...lot, refundedMicro: lot.refundedMicro - reserved.amountMicro, version: lot.version + 1 });
    await trx.appendEntry({ ...base, entryId: `refund:${input.refundId}:reverted`, kind: 'refund_reverted' });
    return 'reverted';
  });
}

/**
 * Opens a dispute on a lot: the lot funds nothing new, the account admits no new hold, and the holds already allocated
 * to the lot stay held until their own fenced settlement. Answers those holds, for the host to stop their calls.
 */
export async function disputeCreditLot(store: ICompoundCreditStore, input: { scopeId: string; lotId: string; disputeId: string; at: number }): Promise<{ status: 'opened' | 'existing' | 'not_found'; affectedHoldIds: string[] }> {
  return withCreditRetry(store, async (trx) => {
    const account = await trx.lockAccount(input.scopeId);
    const lot = await trx.getLot(input.lotId);
    if (!account || !lot || lot.scopeId !== input.scopeId) return { status: 'not_found', affectedHoldIds: [] };
    const affected = (await trx.listAllocationsByLot(lot.lotId)).filter((a) => !a.settled).map((a) => a.holdId);
    if (await trx.getEntry(`dispute:${input.disputeId}:opened`)) return { status: 'existing', affectedHoldIds: [...new Set(affected)] };
    if (lot.state === 'active') await trx.putLot({ ...lot, state: 'disputed', version: lot.version + 1 });
    await trx.putAccount({ ...account, frozen: true, openDisputes: account.openDisputes + 1, version: account.version + 1 });
    await trx.appendEntry({ entryId: `dispute:${input.disputeId}:opened`, scopeId: input.scopeId, kind: 'dispute_opened', amountMicro: 0, lotId: lot.lotId, holdId: null, ref: input.disputeId, at: input.at, day: creditDay(input.at) });
    return { status: 'opened', affectedHoldIds: [...new Set(affected)] };
  });
}

/**
 * Resolves a dispute. Won: the lot is active again, and the account admits holds once no dispute is open. Lost: the
 * reversal takes what it can from the lot's free balance (retired), and the rest is recorded as a receivable outside
 * spendable credit, never subtracted from a hold or made a negative balance; the lot closes.
 */
export async function resolveCreditDispute(
  store: ICompoundCreditStore,
  input: { scopeId: string; lotId: string; disputeId: string; outcome: 'won' | 'lost'; reversedMicro: number; at: number },
): Promise<{ status: 'resolved' | 'already_resolved' | 'not_found'; receivableMicro: number }> {
  whole('reversedMicro', input.reversedMicro, 0);
  return withCreditRetry(store, async (trx) => {
    const account = await trx.lockAccount(input.scopeId);
    const lot = await trx.getLot(input.lotId);
    const opening = await trx.getEntry(`dispute:${input.disputeId}:opened`);
    if (!account || !lot || !opening || lot.scopeId !== input.scopeId ||
        opening.scopeId !== input.scopeId || opening.lotId !== lot.lotId ||
        opening.kind !== 'dispute_opened' || opening.ref !== input.disputeId) {
      return { status: 'not_found', receivableMicro: 0 };
    }
    if ((await trx.getEntry(`dispute:${input.disputeId}:won`)) || (await trx.getEntry(`dispute:${input.disputeId}:lost`))) return { status: 'already_resolved', receivableMicro: 0 };
    const base = { scopeId: input.scopeId, lotId: lot.lotId, holdId: null, ref: input.disputeId, at: input.at, day: creditDay(input.at) };
    let receivable = 0;
    if (input.outcome === 'won') {
      await trx.putLot({ ...lot, state: lot.state === 'disputed' ? 'active' : lot.state, version: lot.version + 1 });
      await trx.appendEntry({ ...base, entryId: `dispute:${input.disputeId}:won`, kind: 'dispute_won', amountMicro: 0 });
    } else {
      const fromFree = Math.min(input.reversedMicro, lotFreeMicro(lot));
      receivable = input.reversedMicro - fromFree;
      await trx.putLot({ ...lot, state: 'closed', retiredMicro: lot.retiredMicro + fromFree, version: lot.version + 1 });
      await trx.appendEntry({ ...base, entryId: `dispute:${input.disputeId}:lost`, kind: 'dispute_lost', amountMicro: input.reversedMicro });
      if (receivable > 0) await trx.appendEntry({ ...base, entryId: `dispute:${input.disputeId}:receivable`, kind: 'receivable', amountMicro: receivable });
    }
    const openDisputes = Math.max(0, account.openDisputes - 1);
    await trx.putAccount({ ...account, openDisputes, frozen: openDisputes > 0, version: account.version + 1 });
    return { status: 'resolved', receivableMicro: receivable };
  });
}

/** Retires the unheld remainder of every promotion of the scope that has expired at `at`; answers what retired. */
export async function retireExpiredPromotions(store: ICompoundCreditStore, input: { scopeId: string; at: number }): Promise<number> {
  return withCreditRetry(store, async (trx) => {
    await trx.lockAccount(input.scopeId);
    let retired = 0;
    for (const lot of await trx.listLots(input.scopeId)) {
      if (lot.kind !== 'promotion' || lot.expiresAt === null || lot.expiresAt > input.at) continue;
      const free = lotFreeMicro(lot);
      if (free <= 0) continue;
      await trx.putLot({ ...lot, retiredMicro: lot.retiredMicro + free, version: lot.version + 1 });
      await trx.appendEntry({ entryId: `lot:${lot.lotId}:retired:${lot.version + 1}`, scopeId: input.scopeId, kind: 'promotion_retired', amountMicro: free, lotId: lot.lotId, holdId: null, ref: null, at: input.at, day: creditDay(input.at) });
      retired += free;
    }
    return retired;
  });
}

// ── Reconciliation ──

/** What a host knows of a hold whose time is up. */
export type HoldResolution =
  | { action: 'settle'; connectedMs: number; fence: CallFence }
  | { action: 'defer'; retryAt: number; evidence: string };

/** What {@link reconcileCompoundCredit} did. */
export interface ReconcileCompoundCreditResult {
  settled: number;
  deferred: number;
  /** Holds still open after the pass for another reason: a concurrent settlement, the page limit. */
  pending: number;
}

/**
 * Asks the host about each hold whose time is up (a held hold past `expiresAt`, a deferred one past `deferredUntil`)
 * and settles or defers it. A resolver that throws defers the hold for 15 seconds: an expired lease is never itself
 * evidence that work stopped, so nothing is released or consumed on a failure.
 */
export async function reconcileCompoundCredit(
  store: ICompoundCreditStore,
  input: { at: number; limit?: number; resolve: (hold: CreditHoldRow) => Promise<HoldResolution> },
): Promise<ReconcileCompoundCreditResult> {
  const due = await store.withTransaction((trx) => trx.listHolds({ states: ['held', 'deferred'], dueAtOrBefore: input.at, limit: input.limit ?? 100 }));
  const result: ReconcileCompoundCreditResult = { settled: 0, deferred: 0, pending: 0 };
  for (const hold of due) {
    let resolution: HoldResolution;
    try {
      resolution = await input.resolve(hold);
    } catch {
      resolution = { action: 'defer', retryAt: input.at + 15_000, evidence: 'resolver_failed' };
    }
    if (resolution.action === 'defer') {
      const deferred = await deferCompoundHold(store, { holdId: hold.holdId, retryAt: resolution.retryAt, evidence: resolution.evidence });
      if (deferred?.state === 'deferred') result.deferred += 1;
      else result.pending += 1;
      continue;
    }
    const settled = await settleCompoundCredit(store, { holdId: hold.holdId, connectedMs: resolution.connectedMs, fence: resolution.fence, at: input.at });
    if (settled.status === 'settled') result.settled += 1;
    else if (settled.status === 'deferred') result.deferred += 1;
    else result.pending += 1;
  }
  return result;
}
