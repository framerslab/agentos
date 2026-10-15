/**
 * @fileoverview Every provider attempt authorized against a call's hold, immediately before the request is sent and
 * below every routing, retry and fallback loop: an initial generation, a tool continuation, a retry and a fallback each
 * consume one attempt of the call's aggregate allowance, and no request is sent without an authorization. The hold
 * reserved `maxAttempts` attempts at the dearest authorized snapshot when it was made, so an authorization only
 * partitions it; it creates no spendable credit and borrows nothing from another call. A retry never gets back the
 * allowance of the attempt it replaces: an attempt whose usage never arrives keeps its supplier most open.
 *
 * @module safety/runtime/ModelAttemptBudget
 */
import { randomUUID } from 'node:crypto';
import { type AttemptLimits, type RateSnapshot } from './CreditRates.js';
import { attemptUsageOf, priceAttempts, withCreditRetry, type HoldRates } from './CompoundCreditLedger.js';
import { creditDay, type AttemptPurpose, type CreditAttemptRow, type ICompoundCreditStore } from './CompoundCreditStore.js';

/** What {@link authorizeModelAttempt} authorizes. */
export interface AuthorizeModelAttemptInput {
  holdId: string;
  /** The caller's id for the attempt; a second authorization with it answers the first. */
  attemptId: string;
  purpose: AttemptPurpose;
  /** The snapshot the attempt is priced under: the hold's primary when absent, or one of its fallbacks. */
  rateVersion?: string;
  at: number;
}

/** An authorization's answer. `maxQuantities` is the most of each component the attempt may use. */
export type AuthorizeModelAttemptResult =
  | { status: 'authorized' | 'existing'; attempt: CreditAttemptRow; remainingAttempts: number; maxQuantities: Readonly<Record<string, number>> }
  | { status: 'refused'; reason: 'not_found' | 'hold_closed' | 'attempts_exhausted' | 'usage_exhausted' | 'unknown_rate' };

/** What {@link recordAttemptUsage} records: an attempt's quantities by component key. */
export interface RecordAttemptUsageInput {
  holdId: string;
  attemptId: string;
  usage: Readonly<Record<string, number>>;
  /** The attempt's last report; a report that is not final leaves the attempt open. */
  final: boolean;
  at: number;
}

/** A report's answer; `overLimit` names each component past its per-attempt limit, by how much. */
export type RecordAttemptUsageResult =
  | { status: 'recorded'; overLimit: Record<string, number> }
  | { status: 'already_recorded' }
  | { status: 'refused'; reason: 'not_found' | 'unknown_component' | 'invalid_quantity' | 'usage_regression' | 'conflicting_final' };

/** The scope a hold belongs to, read outside the locking transaction. */
async function scopeOf(store: ICompoundCreditStore, holdId: string): Promise<string | undefined> {
  return store.withTransaction(async (trx) => (await trx.getHold(holdId))?.scopeId);
}

/** The snapshot a version names among a hold's, or undefined. */
function findSnapshot(rates: HoldRates, version: string): RateSnapshot | undefined {
  return rates.primary.version === version ? rates.primary : rates.fallbacks.find((r) => r.version === version);
}

/**
 * Authorizes one provider attempt, debiting the hold's aggregate allowance in the same transaction that checks it.
 * Refused once the hold has made `maxAttempts` attempts or is no longer held; a refused attempt must not be sent.
 */
export async function authorizeModelAttempt(store: ICompoundCreditStore, input: AuthorizeModelAttemptInput): Promise<AuthorizeModelAttemptResult> {
  const scopeId = await scopeOf(store, input.holdId);
  if (scopeId === undefined) return { status: 'refused', reason: 'not_found' };
  return withCreditRetry(store, async (trx) => {
    await trx.lockAccount(scopeId);
    const hold = await trx.getHold(input.holdId);
    if (!hold) return { status: 'refused', reason: 'not_found' };
    const limits = JSON.parse(hold.attemptLimits) as AttemptLimits;
    const attempts = await trx.listAttempts(hold.holdId);
    if (await trx.getEntry(`hold:${hold.holdId}:attempt_exhausted`)) return { status: 'refused', reason: 'usage_exhausted' };
    if (hold.state !== 'held') return { status: 'refused', reason: 'hold_closed' };
    const existing = attempts.find((a) => a.attemptId === input.attemptId);
    if (existing) return { status: 'existing', attempt: existing, remainingAttempts: hold.maxAttempts - attempts.length, maxQuantities: limits.perAttempt };
    if (attempts.length >= hold.maxAttempts) return { status: 'refused', reason: 'attempts_exhausted' };
    const rates = JSON.parse(hold.rates) as HoldRates;
    const version = input.rateVersion ?? rates.primary.version;
    if (!findSnapshot(rates, version)) return { status: 'refused', reason: 'unknown_rate' };
    const attempt: CreditAttemptRow = {
      holdId: hold.holdId,
      attemptId: input.attemptId,
      seq: attempts.length + 1,
      purpose: input.purpose,
      rateVersion: version,
      state: 'authorized',
      usage: null,
      final: false,
      authorizedAt: input.at,
      recordedAt: null,
      version: 1,
    };
    await trx.putAttempt(attempt);
    return { status: 'authorized', attempt, remainingAttempts: hold.maxAttempts - attempt.seq, maxQuantities: limits.perAttempt };
  });
}

/**
 * Records an attempt's quantities. A component the attempt's snapshot does not price, or one its limits do not name,
 * is refused: an unknown unit cannot be priced as zero. A final report after the hold settled adds the attempt's
 * supplier cost to the day of `at` and closes its open liability; the customer is not charged again.
 */
export async function recordAttemptUsage(store: ICompoundCreditStore, input: RecordAttemptUsageInput): Promise<RecordAttemptUsageResult> {
  for (const quantity of Object.values(input.usage)) {
    if (!Number.isSafeInteger(quantity) || quantity < 0) return { status: 'refused', reason: 'invalid_quantity' };
  }
  const scopeId = await scopeOf(store, input.holdId);
  if (scopeId === undefined) return { status: 'refused', reason: 'not_found' };
  return withCreditRetry(store, async (trx) => {
    await trx.lockAccount(scopeId);
    const hold = await trx.getHold(input.holdId);
    const attempts = hold ? await trx.listAttempts(hold.holdId) : [];
    const attempt = attempts.find((a) => a.attemptId === input.attemptId);
    if (!hold || !attempt) return { status: 'refused', reason: 'not_found' };
    const rates = JSON.parse(hold.rates) as HoldRates;
    const limits = JSON.parse(hold.attemptLimits) as AttemptLimits;
    const snapshot = findSnapshot(rates, attempt.rateVersion);
    if (!snapshot) return { status: 'refused', reason: 'unknown_component' };
    const overLimit: Record<string, number> = {};
    for (const [key, quantity] of Object.entries(input.usage)) {
      if (!Object.prototype.hasOwnProperty.call(limits.perAttempt, key) || !Object.prototype.hasOwnProperty.call(snapshot.components, key)) {
        return { status: 'refused', reason: 'unknown_component' };
      }
      const limit = limits.perAttempt[key] ?? 0;
      if (quantity > limit) overLimit[key] = quantity - limit;
    }
    // Omitted components mean zero. Once positive, they must be present in every subsequent report.
    const keys = Object.keys(limits.perAttempt).sort();
    const previous = attemptUsageOf(attempt);
    const usage = Object.fromEntries(keys.map((key) => [key, input.usage[key] ?? 0]));
    if (attempt.final) {
      return input.final && keys.every((key) => usage[key] === (previous[key] ?? 0))
        ? { status: 'already_recorded' }
        : { status: 'refused', reason: 'conflicting_final' };
    }
    if (keys.some((key) => usage[key] < (previous[key] ?? 0))) return { status: 'refused', reason: 'usage_regression' };
    const recorded: CreditAttemptRow = {
      ...attempt,
      state: input.final ? 'recorded' : 'authorized',
      usage: JSON.stringify(usage),
      final: input.final,
      recordedAt: input.at,
      version: attempt.version + 1,
    };
    await trx.putAttempt(recorded);
    if (Object.keys(overLimit).length > 0) {
      await trx.appendEntry({ entryId: `hold:${hold.holdId}:attempt_exhausted`, scopeId, kind: 'attempt_exhausted',
        amountMicro: 0, lotId: null, holdId: hold.holdId, ref: attempt.attemptId, at: input.at, day: creditDay(input.at) });
    }
    if (input.final && (hold.state === 'settled' || hold.state === 'released')) {
      const before = priceAttempts(hold, attempts);
      const after = priceAttempts(hold, attempts.map((row) => row.attemptId === recorded.attemptId ? recorded : row));
      const cost = after.supplierMicro - before.supplierMicro;
      await trx.putHold({
        ...hold,
        supplierSettledMicro: hold.supplierSettledMicro + cost,
        supplierOpenMicro: after.supplierOpenMicro,
        version: hold.version + 1,
      });
      const day = await trx.lockSupplierDay(creditDay(input.at));
      await trx.putSupplierDay({ day: day.day, settledMicro: day.settledMicro + cost, version: day.version + 1 });
      await trx.appendEntry({ entryId: `attempt:${hold.holdId}:${attempt.attemptId}:supplier`, scopeId, kind: 'supplier_settled', amountMicro: cost, lotId: null, holdId: hold.holdId, ref: attempt.attemptId, at: input.at, day: creditDay(input.at) });
      const oldLoss = Math.max(0, hold.supplierSettledMicro + hold.supplierOpenMicro - hold.supplierMicro);
      const newLoss = Math.max(0, hold.supplierSettledMicro + cost + after.supplierOpenMicro - hold.supplierMicro);
      if (newLoss > oldLoss) await trx.appendEntry({ entryId: `attempt:${hold.holdId}:${attempt.attemptId}:loss`, scopeId,
        kind: 'platform_loss', amountMicro: newLoss - oldLoss, lotId: null, holdId: hold.holdId,
        ref: 'supplier_overrun', at: input.at, day: creditDay(input.at) });
    }
    return { status: 'recorded', overLimit };
  });
}

/** Thrown by an {@link IAttemptAuthorizer} that refuses an attempt; the request must not be sent. */
export class AttemptBudgetExhaustedError extends Error {
  /** @param reason - Why the attempt was refused. */
  constructor(readonly reason: 'not_found' | 'hold_closed' | 'attempts_exhausted' | 'usage_exhausted' | 'unknown_rate') {
    super(`model attempt refused: ${reason}`);
    this.name = 'AttemptBudgetExhaustedError';
  }
}

/** One authorized attempt, as an adapter holds it. */
export interface AttemptGrant {
  attemptId: string;
  /** The snapshot the attempt is priced under. */
  rateVersion: string;
  /** The most of each component the attempt may use; an adapter caps its request with these. */
  maxQuantities: Readonly<Record<string, number>>;
  remainingAttempts: number;
}

/** What a reasoning adapter calls before and after every provider request. */
export interface IAttemptAuthorizer {
  /**
   * Authorizes the next attempt.
   * @throws {AttemptBudgetExhaustedError} When the attempt is refused.
   */
  authorize(request: { purpose: AttemptPurpose; rateVersion?: string }): Promise<AttemptGrant>;
  /** Records an attempt's quantities by component key. */
  record(attemptId: string, usage: Readonly<Record<string, number>>, final: boolean): Promise<void>;
}

/** The per-call authorizer over a hold of the compound credit ledger. */
export class ModelAttemptBudget implements IAttemptAuthorizer {
  /** @param options - The store, the call's hold, and the clock. */
  constructor(private readonly options: { store: ICompoundCreditStore; holdId: string; now?: () => number }) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  async authorize(request: { purpose: AttemptPurpose; rateVersion?: string }): Promise<AttemptGrant> {
    const attemptId = `attempt_${randomUUID()}`;
    const answer = await authorizeModelAttempt(this.options.store, { holdId: this.options.holdId, attemptId, purpose: request.purpose, rateVersion: request.rateVersion, at: this.now() });
    if (answer.status === 'refused') throw new AttemptBudgetExhaustedError(answer.reason);
    return { attemptId, rateVersion: answer.attempt.rateVersion, maxQuantities: answer.maxQuantities, remainingAttempts: answer.remainingAttempts };
  }

  async record(attemptId: string, usage: Readonly<Record<string, number>>, final: boolean): Promise<void> {
    const answer = await recordAttemptUsage(this.options.store, { holdId: this.options.holdId, attemptId, usage, final, at: this.now() });
    if (answer.status === 'refused') throw new RangeError(`attempt usage refused: ${answer.reason}`);
    if (answer.status === 'recorded' && Object.keys(answer.overLimit).length > 0) throw new AttemptBudgetExhaustedError('usage_exhausted');
  }
}

/** An authorizer that counts attempts against a local limit, with no money: a local application's own policy. */
export class CountingAttemptBudget implements IAttemptAuthorizer {
  private used = 0;

  /** @param limits - The attempts allowed and each attempt's most. */
  constructor(private readonly limits: AttemptLimits) {}

  async authorize(_request: { purpose: AttemptPurpose; rateVersion?: string }): Promise<AttemptGrant> {
    if (this.used >= this.limits.maxAttempts) throw new AttemptBudgetExhaustedError('attempts_exhausted');
    this.used += 1;
    return { attemptId: `local_${this.used}`, rateVersion: 'local', maxQuantities: this.limits.perAttempt, remainingAttempts: this.limits.maxAttempts - this.used };
  }

  async record(_attemptId: string, _usage: Readonly<Record<string, number>>, _final: boolean): Promise<void> {
    // a local budget counts attempts only
  }
}
