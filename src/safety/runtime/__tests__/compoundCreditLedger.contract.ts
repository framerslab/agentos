/**
 * The ledger's behaviour over the memory, SQLite and PostgreSQL adapters. Every amount below
 * follows from a synthetic snapshot: media at 83117/60 customer and 25000/60 supplier micro-units per second, input tokens at $0.15
 * and output tokens at $0.60 per million on both sides, reasoning counted inside output, and four attempts of at most
 * 8,192 input and 512 output tokens: 1,537 micro-dollars an attempt on each side. A 60-second call is held at 89,265
 * (customer) and 31,148 (supplier); a 600-second call at 837,318 and 256,148.
 */
import { describe, expect, it } from 'vitest';
import type { RateSnapshot } from '../CreditRates.js';
import type { CreditLotRow, CreditTransaction, ICompoundCreditStore } from '../CompoundCreditStore.js';
import {
  completeLotRefund,
  creditBalance,
  disputeCreditLot,
  grantCreditLot,
  lotFreeMicro,
  reconcileCompoundCredit,
  refundCreditLot,
  reserveCompoundCredit,
  resolveCreditDispute,
  retireExpiredPromotions,
  settleCompoundCredit,
  type CallFence,
  type ReserveCompoundCreditInput,
} from '../CompoundCreditLedger.js';

export const RATES: RateSnapshot = {
  version: 'rates-test-1',
  currency: 'USD',
  reasoningInOutput: true,
  components: {
    media_second: { customer: { unit: 'second', micro: 83_117, per: 60 }, supplier: { unit: 'second', micro: 25_000, per: 60 } },
    input_token: { customer: { unit: 'token', micro: 150_000, per: 1_000_000 }, supplier: { unit: 'token', micro: 150_000, per: 1_000_000 } },
    output_token: { customer: { unit: 'token', micro: 600_000, per: 1_000_000 }, supplier: { unit: 'token', micro: 600_000, per: 1_000_000 } },
    reasoning_token: { customer: { unit: 'token', micro: 600_000, per: 1_000_000 }, supplier: { unit: 'token', micro: 600_000, per: 1_000_000 } },
  },
};
export const ATTEMPTS = { maxAttempts: 4, perAttempt: { input_token: 8_192, output_token: 512, reasoning_token: 512 } };
/** 12 October 2026, 23:59:00 UTC. */
export const T = Date.UTC(2026, 9, 12, 23, 59, 0);
export const FENCED: CallFence = { mediaClosed: true, inferenceTerminated: true, evidence: 'room-deleted;worker-exit-0', observedAt: T };
const BIG_CAP = 1_000_000_000_000;

/** The shared request of a reservation, with the run's ids. */
export function reserveInput(id: (s: string) => string, over: Partial<ReserveCompoundCreditInput> & { scopeId: string; operationId: string }): ReserveCompoundCreditInput {
  return {
    kind: 'call',
    requestHash: 'hash-1',
    rates: { primary: RATES },
    mediaComponent: 'media_second',
    durationSeconds: 60,
    attempts: ATTEMPTS,
    supplierDailyCapMicro: BIG_CAP,
    at: T,
    expiresAt: T + 3_660_000,
    ...over,
    scopeId: id(over.scopeId),
    operationId: id(over.operationId),
  };
}

/** Every lot term is zero or more and they sum to the principal. */
export function expectConserved(lot: CreditLotRow | undefined): void {
  expect(lot).toBeDefined();
  const free = lotFreeMicro(lot!);
  for (const term of [lot!.consumedMicro, lot!.heldMicro, lot!.refundedMicro, lot!.retiredMicro, free]) expect(term).toBeGreaterThanOrEqual(0);
  expect(lot!.consumedMicro + lot!.heldMicro + lot!.refundedMicro + lot!.retiredMicro + free).toBe(lot!.principalMicro);
}

/**
 * The store, with each transaction held just after it reads the open supplier liability until `parties` transactions
 * have read it or `waitMs` has passed. Reservations that queue on no common lock then all read the liability before any
 * of them holds; reservations that do queue on one wait there instead, and read it one after another.
 */
function heldAfterOpenSupplierRead(store: ICompoundCreditStore, parties: number, waitMs: number): ICompoundCreditStore {
  let reads = 0;
  const waiting: Array<() => void> = [];
  return {
    withTransaction<R>(fn: (trx: CreditTransaction) => Promise<R>): Promise<R> {
      return store.withTransaction((trx) => {
        const held: CreditTransaction = Object.create(trx);
        held.openSupplierMicro = async (scopeId?: string): Promise<number> => {
          const open = await trx.openSupplierMicro(scopeId);
          reads += 1;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, waitMs);
            waiting.push(() => {
              clearTimeout(timer);
              resolve();
            });
            if (reads >= parties) for (const release of waiting.splice(0)) release();
          });
          return open;
        };
        return fn(held);
      });
    },
  };
}

export function runCompoundCreditLedgerContract(
  name: string,
  make: () => Promise<{ store: ICompoundCreditStore; id: (s: string) => string }>,
  options: { concurrent: boolean },
): void {
  const lotOf = (store: ICompoundCreditStore, lotId: string) => store.withTransaction((trx) => trx.getLot(lotId));

  describe(`${name}: the compound credit ledger`, () => {
    it('grants a lot once per funding reference', async () => {
      const { store, id } = await make();
      const first = await grantCreditLot(store, { scopeId: id('s'), lotId: id('lot'), kind: 'paid', fundingRef: id('pay-1'), principalMicro: 1_000_000, at: T });
      const second = await grantCreditLot(store, { scopeId: id('s'), lotId: id('lot-2'), kind: 'paid', fundingRef: id('pay-1'), principalMicro: 1_000_000, at: T });
      expect(first.status).toBe('granted');
      expect(second).toEqual({ status: 'existing', lot: first.lot });
      const entries = await store.withTransaction((trx) => trx.listEntries({ scopeId: id('s'), kinds: ['lot_granted'] }));
      expect(entries).toHaveLength(1);
      await expect(grantCreditLot(store, { scopeId: id('s'), kind: 'paid', fundingRef: id('pay-2'), principalMicro: 5, expiresAt: T + 1, at: T })).rejects.toThrow(RangeError);
    });

    it('allocates promotions by earliest expiry, then paid lots, and refuses what does not fit', async () => {
      const { store, id } = await make();
      await grantCreditLot(store, { scopeId: id('s'), lotId: id('promo-late'), kind: 'promotion', fundingRef: id('grant-a'), principalMicro: 50_000, expiresAt: T + 30 * 86_400_000, at: T - 2 });
      await grantCreditLot(store, { scopeId: id('s'), lotId: id('promo-soon'), kind: 'promotion', fundingRef: id('grant-b'), principalMicro: 40_000, expiresAt: T + 10 * 86_400_000, at: T - 1 });
      await grantCreditLot(store, { scopeId: id('s'), lotId: id('paid'), kind: 'paid', fundingRef: id('pay'), principalMicro: 1_000_000, at: T });
      const first = await reserveCompoundCredit(store, reserveInput(id, { scopeId: 's', operationId: 'call-1' }));
      expect(first.status).toBe('reserved');
      if (first.status !== 'reserved') throw new Error('not reserved');
      expect(first.hold.customerMicro).toBe(89_265);
      expect(first.hold.supplierMicro).toBe(31_148);
      expect(first.allocations.map((a) => [a.lotId, a.amountMicro])).toEqual([[id('promo-soon'), 40_000], [id('promo-late'), 49_265]]);
      const second = await reserveCompoundCredit(store, reserveInput(id, { scopeId: 's', operationId: 'call-2', durationSeconds: 600 }));
      if (second.status !== 'reserved') throw new Error('not reserved');
      expect(second.allocations.map((a) => [a.lotId, a.amountMicro])).toEqual([[id('promo-late'), 735], [id('paid'), 836_583]]);
      const third = await reserveCompoundCredit(store, reserveInput(id, { scopeId: 's', operationId: 'call-3', durationSeconds: 600 }));
      expect(third).toMatchObject({ status: 'refused', reason: 'insufficient_credit', availableMicro: 163_417 });
      expect(await reserveCompoundCredit(store, reserveInput(id, { scopeId: 'nobody', operationId: 'call-4' }))).toMatchObject({ status: 'refused', reason: 'no_account' });
      expect((await creditBalance(store, id('s'), T)).availableMicro).toBe(163_417);
      for (const lot of ['promo-late', 'promo-soon', 'paid']) expectConserved(await lotOf(store, id(lot)));
    });

    it('answers a repeated reservation with its hold, and refuses the same operation with another request', async () => {
      const { store, id } = await make();
      await grantCreditLot(store, { scopeId: id('s'), kind: 'paid', fundingRef: id('pay'), principalMicro: 1_000_000, at: T });
      const first = await reserveCompoundCredit(store, reserveInput(id, { scopeId: 's', operationId: 'call' }));
      const again = await reserveCompoundCredit(store, reserveInput(id, { scopeId: 's', operationId: 'call' }));
      const other = await reserveCompoundCredit(store, reserveInput(id, { scopeId: 's', operationId: 'call', requestHash: 'hash-2' }));
      if (first.status !== 'reserved' || again.status !== 'existing') throw new Error(`${first.status} then ${again.status}`);
      expect(again.hold.holdId).toBe(first.hold.holdId);
      expect(other.status).toBe('conflict');
      expect((await creditBalance(store, id('s'), T)).heldMicro).toBe(89_265);
    });

    it('keeps supplier holds committed across the UTC boundary until they settle', async () => {
      const { store, id } = await make();
      for (const scope of ['a', 'b']) await grantCreditLot(store, { scopeId: id(scope), kind: 'paid', fundingRef: id(`pay-${scope}`), principalMicro: 1_000_000, at: T });
      const a = await reserveCompoundCredit(store, reserveInput(id, { scopeId: 'a', operationId: 'call-a', supplierDailyCapMicro: 40_000 }));
      expect(a.status).toBe('reserved');
      const nextDay = T + 2 * 60_000;
      const b = await reserveCompoundCredit(store, reserveInput(id, { scopeId: 'b', operationId: 'call-b', supplierDailyCapMicro: 40_000, at: nextDay, expiresAt: nextDay + 3_660_000 }));
      expect(b).toMatchObject({ status: 'refused', reason: 'supplier_cap' });
      if (a.status !== 'reserved') throw new Error('not reserved');
      await settleCompoundCredit(store, { holdId: a.hold.holdId, connectedMs: 60_000, fence: FENCED, at: nextDay });
      expect(await reserveCompoundCredit(store, reserveInput(id, { scopeId: 'b', operationId: 'call-b', supplierDailyCapMicro: 40_000, at: nextDay, expiresAt: nextDay + 3_660_000 }))).toMatchObject({ status: 'refused', reason: 'supplier_cap' });
      expect(await reserveCompoundCredit(store, reserveInput(id, { scopeId: 'b', operationId: 'call-b', supplierDailyCapMicro: 60_000, at: nextDay, expiresAt: nextDay + 3_660_000 }))).toMatchObject({ status: 'reserved' });
    });

    it.runIf(options.concurrent)('admits supplier holds one at a time on either side of midnight, so two that each fit the cap never both hold past it', async () => {
      const { store, id } = await make();
      for (const scope of ['a', 'b']) await grantCreditLot(store, { scopeId: id(scope), kind: 'paid', fundingRef: id(`pay-${scope}`), principalMicro: 1_000_000, at: T });
      const racing = heldAfterOpenSupplierRead(store, 2, 3_000);
      const nextDay = T + 2 * 60_000;
      const results = await Promise.all([
        reserveCompoundCredit(racing, reserveInput(id, { scopeId: 'a', operationId: 'call-a', supplierDailyCapMicro: 40_000 })),
        reserveCompoundCredit(racing, reserveInput(id, { scopeId: 'b', operationId: 'call-b', supplierDailyCapMicro: 40_000, at: nextDay, expiresAt: nextDay + 3_660_000 })),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(['refused', 'reserved']);
      expect(results.find((r) => r.status === 'refused')).toMatchObject({ reason: 'supplier_cap' });
      expect(await store.withTransaction((trx) => trx.openSupplierMicro())).toBe(31_148);
    });

    it('settles once, rounding connected time up once, consuming the shares in order', async () => {
      const { store, id } = await make();
      await grantCreditLot(store, { scopeId: id('s'), lotId: id('paid'), kind: 'paid', fundingRef: id('pay'), principalMicro: 1_000_000, at: T });
      const held = await reserveCompoundCredit(store, reserveInput(id, { scopeId: 's', operationId: 'call', durationSeconds: 600 }));
      if (held.status !== 'reserved') throw new Error('not reserved');
      const settled = await settleCompoundCredit(store, { holdId: held.hold.holdId, connectedMs: 61_500, fence: FENCED, at: T + 120_000 });
      // 62 seconds: ceil(62 * 83117 / 60) = 85888
      expect(settled).toMatchObject({ status: 'settled', chargedMicro: 85_888, lossMicro: 0 });
      expect(await settleCompoundCredit(store, { holdId: held.hold.holdId, connectedMs: 900_000, fence: FENCED, at: T + 130_000 })).toMatchObject({ status: 'already_settled' });
      const lot = await lotOf(store, id('paid'));
      expect(lot).toMatchObject({ consumedMicro: 85_888, heldMicro: 0 });
      expectConserved(lot);
      const hold = await store.withTransaction((trx) => trx.getHold(held.hold.holdId));
      expect(hold).toMatchObject({ state: 'settled', chargedMicro: 85_888, supplierSettledMicro: 25_834, supplierOpenMicro: 0 });
    });

    it('defers, still held, until the media is closed and the inference has stopped', async () => {
      const { store, id } = await make();
      await grantCreditLot(store, { scopeId: id('s'), lotId: id('paid'), kind: 'paid', fundingRef: id('pay'), principalMicro: 1_000_000, at: T });
      const held = await reserveCompoundCredit(store, reserveInput(id, { scopeId: 's', operationId: 'call', durationSeconds: 600 }));
      if (held.status !== 'reserved') throw new Error('not reserved');
      const deferred = await settleCompoundCredit(store, { holdId: held.hold.holdId, connectedMs: 60_000, fence: { ...FENCED, inferenceTerminated: false }, at: T + 1_000 });
      expect(deferred).toMatchObject({ status: 'deferred', hold: { state: 'deferred', deferredUntil: T + 16_000 } });
      expect((await lotOf(store, id('paid')))?.heldMicro).toBe(837_318);
      expect(await settleCompoundCredit(store, { holdId: held.hold.holdId, connectedMs: 60_000, fence: FENCED, at: T + 20_000 })).toMatchObject({ status: 'settled', chargedMicro: 83_117 });
    });

    it('retires an expired promotion\'s unheld remainder, keeps the share an admitted hold took, and retires what that share leaves', async () => {
      const { store, id } = await make();
      await grantCreditLot(store, { scopeId: id('s'), lotId: id('promo'), kind: 'promotion', fundingRef: id('grant'), principalMicro: 100_000, expiresAt: T + 60_000, at: T });
      const held = await reserveCompoundCredit(store, reserveInput(id, { scopeId: 's', operationId: 'call' }));
      if (held.status !== 'reserved') throw new Error('not reserved');
      expect(await retireExpiredPromotions(store, { scopeId: id('s'), at: T + 61_000 })).toBe(10_735);
      expect((await lotOf(store, id('promo')))).toMatchObject({ heldMicro: 89_265, retiredMicro: 10_735 });
      await settleCompoundCredit(store, { holdId: held.hold.holdId, connectedMs: 30_000, fence: FENCED, at: T + 62_000 });
      const lot = await lotOf(store, id('promo'));
      expect(lot).toMatchObject({ consumedMicro: 41_559, heldMicro: 0, retiredMicro: 58_441 });
      expect(lotFreeMicro(lot!)).toBe(0);
      expectConserved(lot);
      expect(await reserveCompoundCredit(store, reserveInput(id, { scopeId: 's', operationId: 'call-2', at: T + 63_000, expiresAt: T + 4_000_000 }))).toMatchObject({ status: 'refused', reason: 'insufficient_credit', availableMicro: 0 });
    });

    it('funds no hold from an expired promotion, whatever order the policy answers', async () => {
      const { store, id } = await make();
      await grantCreditLot(store, { scopeId: id('s'), lotId: id('promo'), kind: 'promotion', fundingRef: id('grant'), principalMicro: 100_000, expiresAt: T + 60_000, at: T });
      const everyLot = (lots: readonly CreditLotRow[]): CreditLotRow[] => [...lots];
      const late = { at: T + 61_000, expiresAt: T + 4_000_000, policy: everyLot };
      expect(await reserveCompoundCredit(store, reserveInput(id, { scopeId: 's', operationId: 'call', ...late }))).toMatchObject({ status: 'refused', reason: 'insufficient_credit', availableMicro: 0 });
      expect((await creditBalance(store, id('s'), T + 61_000, everyLot)).availableMicro).toBe(0);
      expect(await lotOf(store, id('promo'))).toMatchObject({ heldMicro: 0, consumedMicro: 0 });
    });

    it('funds no hold from a closed lot, though a partial lost reversal left free principal on it', async () => {
      const { store, id } = await make();
      await grantCreditLot(store, { scopeId: id('s'), lotId: id('paid'), kind: 'paid', fundingRef: id('pay'), principalMicro: 1_000_000, at: T });
      await disputeCreditLot(store, { scopeId: id('s'), lotId: id('paid'), disputeId: id('dp'), at: T + 1 });
      expect(await resolveCreditDispute(store, { scopeId: id('s'), lotId: id('paid'), disputeId: id('dp'), outcome: 'lost', reversedMicro: 100_000, at: T + 2 })).toEqual({ status: 'resolved', receivableMicro: 0 });
      expect(await lotOf(store, id('paid'))).toMatchObject({ state: 'closed', retiredMicro: 100_000 });
      const paidOnly = (lots: readonly CreditLotRow[]): CreditLotRow[] => lots.filter((l) => l.kind === 'paid');
      expect(await reserveCompoundCredit(store, reserveInput(id, { scopeId: 's', operationId: 'call', at: T + 3, policy: paidOnly }))).toMatchObject({ status: 'refused', reason: 'insufficient_credit', availableMicro: 0 });
      expect((await creditBalance(store, id('s'), T + 3, paidOnly)).availableMicro).toBe(0);
      expect(await lotOf(store, id('paid'))).toMatchObject({ heldMicro: 0 });
    });

    it('refunds only a paid lot\'s free principal, once per refund id, and reverts a refused refund', async () => {
      const { store, id } = await make();
      await grantCreditLot(store, { scopeId: id('s'), lotId: id('paid'), kind: 'paid', fundingRef: id('pay'), principalMicro: 1_000_000, at: T });
      await grantCreditLot(store, { scopeId: id('s'), lotId: id('promo'), kind: 'promotion', fundingRef: id('grant'), principalMicro: 10_000, expiresAt: T + 86_400_000, at: T });
      await reserveCompoundCredit(store, reserveInput(id, { scopeId: 's', operationId: 'call', durationSeconds: 600, policy: (lots) => lots.filter((l) => l.kind === 'paid') }));
      expect(await refundCreditLot(store, { scopeId: id('s'), lotId: id('paid'), refundId: id('r-1'), amountMicro: 1_000_000, at: T })).toEqual({ status: 'refused', reason: 'insufficient_refundable', refundableMicro: 162_682 });
      expect(await refundCreditLot(store, { scopeId: id('s'), lotId: id('paid'), refundId: id('r-1'), amountMicro: 162_682, at: T })).toEqual({ status: 'reserved', refundableMicro: 0 });
      expect(await refundCreditLot(store, { scopeId: id('s'), lotId: id('paid'), refundId: id('r-1'), amountMicro: 162_682, at: T })).toMatchObject({ status: 'existing' });
      expect(await completeLotRefund(store, { scopeId: id('s'), refundId: id('r-1'), outcome: 'failed', at: T + 1 })).toBe('reverted');
      expect(await completeLotRefund(store, { scopeId: id('s'), refundId: id('r-1'), outcome: 'succeeded', at: T + 2 })).toBe('already_completed');
      expect((await lotOf(store, id('paid')))?.refundedMicro).toBe(0);
      expect(await refundCreditLot(store, { scopeId: id('s'), lotId: id('paid'), refundId: id('r-2'), amountMicro: 100, at: T + 3 })).toMatchObject({ status: 'reserved' });
      expect(await completeLotRefund(store, { scopeId: id('s'), refundId: id('r-2'), outcome: 'succeeded', at: T + 4 })).toBe('completed');
      expect(await refundCreditLot(store, { scopeId: id('s'), lotId: id('promo'), refundId: id('r-3'), amountMicro: 1, at: T })).toMatchObject({ status: 'refused', reason: 'not_paid' });
      expectConserved(await lotOf(store, id('paid')));
    });

    it('answers a refund id only for its own scope, lot and amount, and reserves nothing for another request under it', async () => {
      const { store, id } = await make();
      for (const [scope, lot] of [['s', 'paid-a'], ['s', 'paid-b'], ['t', 'paid-t']]) {
        await grantCreditLot(store, { scopeId: id(scope), lotId: id(lot), kind: 'paid', fundingRef: id(lot), principalMicro: 1_000_000, at: T });
      }
      expect(await refundCreditLot(store, { scopeId: id('s'), lotId: id('paid-a'), refundId: id('r'), amountMicro: 100, at: T })).toEqual({ status: 'reserved', refundableMicro: 999_900 });
      expect(await refundCreditLot(store, { scopeId: id('s'), lotId: id('paid-a'), refundId: id('r'), amountMicro: 100, at: T + 1 })).toEqual({ status: 'existing', refundableMicro: 999_900 });
      for (const [scope, lot, amountMicro] of [['s', 'paid-a', 500], ['s', 'paid-b', 100], ['t', 'paid-t', 100]] as const) {
        expect(await refundCreditLot(store, { scopeId: id(scope), lotId: id(lot), refundId: id('r'), amountMicro, at: T + 2 })).toEqual({ status: 'refused', reason: 'conflict', refundableMicro: 0 });
      }
      for (const [lot, refunded] of [['paid-a', 100], ['paid-b', 0], ['paid-t', 0]] as const) expect((await lotOf(store, id(lot)))?.refundedMicro).toBe(refunded);
      expect(await completeLotRefund(store, { scopeId: id('t'), refundId: id('r'), outcome: 'succeeded', at: T + 3 })).toBe('not_found');
      expect(await completeLotRefund(store, { scopeId: id('s'), refundId: id('r'), outcome: 'succeeded', at: T + 3 })).toBe('completed');
      for (const lot of ['paid-a', 'paid-b', 'paid-t']) expectConserved(await lotOf(store, id(lot)));
    });

    it('freezes admission on a dispute, settles the held call, and records a lost reversal past the free balance as a receivable', async () => {
      const { store, id } = await make();
      await grantCreditLot(store, { scopeId: id('s'), lotId: id('paid'), kind: 'paid', fundingRef: id('pay'), principalMicro: 1_000_000, at: T });
      const held = await reserveCompoundCredit(store, reserveInput(id, { scopeId: 's', operationId: 'call', durationSeconds: 600 }));
      if (held.status !== 'reserved') throw new Error('not reserved');
      expect(await disputeCreditLot(store, { scopeId: id('s'), lotId: id('paid'), disputeId: id('dp'), at: T + 1 })).toEqual({ status: 'opened', affectedHoldIds: [held.hold.holdId] });
      expect(await reserveCompoundCredit(store, reserveInput(id, { scopeId: 's', operationId: 'call-2' }))).toMatchObject({ status: 'refused', reason: 'account_frozen' });
      await settleCompoundCredit(store, { holdId: held.hold.holdId, connectedMs: 60_000, fence: FENCED, at: T + 2 });
      expect(await resolveCreditDispute(store, { scopeId: id('s'), lotId: id('paid'), disputeId: id('dp'), outcome: 'lost', reversedMicro: 1_000_000, at: T + 3 })).toEqual({ status: 'resolved', receivableMicro: 83_117 });
      const lot = await lotOf(store, id('paid'));
      expect(lot).toMatchObject({ state: 'closed', consumedMicro: 83_117, retiredMicro: 916_883 });
      expectConserved(lot);
      const account = await store.withTransaction((trx) => trx.lockAccount(id('s')));
      expect(account).toMatchObject({ frozen: false, openDisputes: 0 });
    });

    it('binds dispute resolution to the opening scope and lot without changing either account', async () => {
      const { store, id } = await make();
      for (const [scope, lot] of [['a', 'a-1'], ['a', 'a-2'], ['b', 'b-1']]) {
        await grantCreditLot(store, { scopeId: id(scope), lotId: id(lot), kind: 'paid', fundingRef: id(lot), principalMicro: 101, at: T });
      }
      await disputeCreditLot(store, { scopeId: id('a'), lotId: id('a-1'), disputeId: id('d'), at: T });
      const snapshot = () => store.withTransaction(async (trx) => ({
        accounts: await Promise.all(['a', 'b'].map((scope) => trx.lockAccount(id(scope)))),
        lots: await Promise.all(['a-1', 'a-2', 'b-1'].map((lot) => trx.getLot(id(lot)))),
        entries: await trx.listEntries({}),
      }));
      const before = await snapshot();
      for (const [scope, lot] of [['b', 'b-1'], ['a', 'b-1'], ['a', 'a-2']]) {
        expect(await resolveCreditDispute(store, { scopeId: id(scope), lotId: id(lot), disputeId: id('d'), outcome: 'lost', reversedMicro: 101, at: T + 1 }))
          .toEqual({ status: 'not_found', receivableMicro: 0 });
        expect(await snapshot()).toEqual(before);
      }
      expect(await resolveCreditDispute(store, { scopeId: id('a'), lotId: id('a-1'), disputeId: id('d'), outcome: 'won', reversedMicro: 0, at: T + 2 }))
        .toEqual({ status: 'resolved', receivableMicro: 0 });
      for (const lot of ['a-1', 'a-2', 'b-1']) expectConserved(await lotOf(store, id(lot)));
    });

    it('defers a hold whose resolver cannot tell or fails, and settles it once it can', async () => {
      const { store, id } = await make();
      await grantCreditLot(store, { scopeId: id('s'), kind: 'paid', fundingRef: id('pay'), principalMicro: 1_000_000, at: T });
      const held = await reserveCompoundCredit(store, reserveInput(id, { scopeId: 's', operationId: 'call', expiresAt: T + 60_000 }));
      if (held.status !== 'reserved') throw new Error('not reserved');
      const mine = (hold: { holdId: string }) => hold.holdId === held.hold.holdId;
      const pass = async (at: number, resolve: Parameters<typeof reconcileCompoundCredit>[1]['resolve']) =>
        reconcileCompoundCredit(store, { at, resolve: async (hold) => (mine(hold) ? resolve(hold) : { action: 'defer', retryAt: at + 3_600_000, evidence: 'other' }) });
      expect(await pass(T + 61_000, async () => ({ action: 'defer', retryAt: T + 70_000, evidence: 'worker-alive' }))).toMatchObject({ deferred: 1 });
      expect(await pass(T + 69_000, async () => { throw new Error('must not be asked'); })).toMatchObject({ settled: 0 });
      expect(await pass(T + 71_000, async () => { throw new Error('control plane unreachable'); })).toMatchObject({ deferred: 1 });
      expect((await store.withTransaction((trx) => trx.getHold(held.hold.holdId)))).toMatchObject({ state: 'deferred', fenceEvidence: 'resolver_failed', deferredUntil: T + 86_000 });
      expect(await pass(T + 87_000, async () => ({ action: 'settle', connectedMs: 10_000, fence: FENCED }))).toMatchObject({ settled: 1 });
    });

    it.runIf(options.concurrent)('admits exactly what the credit covers under concurrent reservations, and conserves every lot under racing settlements, refunds, expiry and a dispute', async () => {
      const { store, id } = await make();
      await grantCreditLot(store, { scopeId: id('s'), lotId: id('paid'), kind: 'paid', fundingRef: id('pay'), principalMicro: 5 * 89_265, at: T });
      await grantCreditLot(store, { scopeId: id('s'), lotId: id('promo'), kind: 'promotion', fundingRef: id('grant'), principalMicro: 89_265, expiresAt: T + 1_000, at: T + 1 });
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => reserveCompoundCredit(store, reserveInput(id, { scopeId: 's', operationId: `call-${i}`, policy: (lots) => lots.filter((l) => l.kind === 'paid') }))),
      );
      expect(results.filter((r) => r.status === 'reserved')).toHaveLength(5);
      expect(results.filter((r) => r.status === 'refused')).toHaveLength(15);
      const promoHold = await reserveCompoundCredit(store, reserveInput(id, { scopeId: 's', operationId: 'promo-call' }));
      expect(promoHold.status).toBe('reserved');
      const holds = [...results, promoHold].flatMap((r) => (r.status === 'reserved' ? [r.hold.holdId] : []));
      await Promise.all([
        ...holds.map((holdId, i) => settleCompoundCredit(store, { holdId, connectedMs: i * 7_000, fence: FENCED, at: T + 2_000 })),
        refundCreditLot(store, { scopeId: id('s'), lotId: id('paid'), refundId: id('r'), amountMicro: 1, at: T + 2_000 }),
        retireExpiredPromotions(store, { scopeId: id('s'), at: T + 2_000 }),
        disputeCreditLot(store, { scopeId: id('s'), lotId: id('paid'), disputeId: id('d'), at: T + 2_000 }),
      ]);
      for (const lot of ['paid', 'promo']) expectConserved(await lotOf(store, id(lot)));
      const settled = await store.withTransaction((trx) => trx.listHolds({ scopeId: id('s'), states: ['settled', 'released'] }));
      expect(settled).toHaveLength(6);
    });
  });
}
