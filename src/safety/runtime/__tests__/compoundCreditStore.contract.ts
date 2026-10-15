/**
 * The store contract every compound credit store passes: the in-memory store here, the SQL store over SQLite and
 * Postgres adapters. A suite over a shared database names its rows with the run's own prefix.
 */
import { describe, expect, it } from 'vitest';
import {
  CreditConflictError,
  type CreditHoldRow,
  type CreditLotRow,
  type ICompoundCreditStore,
} from '../CompoundCreditStore.js';

/** A hold row with every field, for the store suite. */
export function holdRow(over: Partial<CreditHoldRow> & Pick<CreditHoldRow, 'holdId' | 'scopeId' | 'operationId'>): CreditHoldRow {
  return {
    kind: 'call',
    requestHash: 'hash-1',
    customerMicro: 1_000,
    supplierMicro: 400,
    mediaCustomerMicro: 600,
    mediaSupplierMicro: 200,
    attemptCustomerMicro: 100,
    attemptSupplierMicro: 50,
    maxAttempts: 4,
    attemptLimits: JSON.stringify({ maxAttempts: 4, perAttempt: { input_token: 100 } }),
    rateVersion: 'v1',
    rates: JSON.stringify({ primary: { version: 'v1' }, fallbacks: [] }),
    mediaComponent: 'media_second',
    state: 'held',
    chargedMicro: 0,
    supplierSettledMicro: 0,
    supplierOpenMicro: 0,
    createdAt: 1_000,
    expiresAt: 61_000,
    settledAt: null,
    deferredUntil: null,
    fenceEvidence: null,
    version: 1,
    ...over,
  };
}

/** A lot row with every field, for the store suite. */
export function lotRow(over: Partial<CreditLotRow> & Pick<CreditLotRow, 'lotId' | 'scopeId' | 'fundingRef'>): CreditLotRow {
  return {
    kind: 'paid',
    principalMicro: 10_000_000,
    consumedMicro: 0,
    heldMicro: 0,
    refundedMicro: 0,
    retiredMicro: 0,
    state: 'active',
    expiresAt: null,
    createdAt: 1_000,
    version: 1,
    ...over,
  };
}

/**
 * The store suite.
 *
 * @param name - What the suite runs on.
 * @param make - A fresh store and the prefix its row ids carry.
 * @param options - `concurrent`: run the case that awaits many transactions at once (a store over one SQLite
 *   connection runs its transactions one at a time and skips it).
 */
export function runCompoundCreditStoreContract(
  name: string,
  make: () => Promise<{ store: ICompoundCreditStore; id: (s: string) => string }>,
  options: { concurrent: boolean },
): void {
  describe(`${name}: the compound credit store contract`, () => {
    it('commits a transaction whole and keeps nothing of one that throws', async () => {
      const { store, id } = await make();
      await store.withTransaction(async (trx) => {
        await trx.putAccount({ scopeId: id('s'), currency: 'USD', frozen: false, openDisputes: 0, createdAt: 1, version: 1 });
        await trx.putLot(lotRow({ lotId: id('lot-a'), scopeId: id('s'), fundingRef: id('pay-a') }));
      });
      await expect(
        store.withTransaction(async (trx) => {
          await trx.putLot(lotRow({ lotId: id('lot-b'), scopeId: id('s'), fundingRef: id('pay-b') }));
          throw new Error('rolled back');
        }),
      ).rejects.toThrow('rolled back');
      const lots = await store.withTransaction((trx) => trx.listLots(id('s')));
      expect(lots.map((l) => l.lotId)).toEqual([id('lot-a')]);
    });

    it('refuses a write over a version it did not read', async () => {
      const { store, id } = await make();
      await store.withTransaction((trx) => trx.putLot(lotRow({ lotId: id('lot'), scopeId: id('s'), fundingRef: id('pay') })));
      await expect(
        store.withTransaction((trx) => trx.putLot(lotRow({ lotId: id('lot'), scopeId: id('s'), fundingRef: id('pay'), version: 3 }))),
      ).rejects.toBeInstanceOf(CreditConflictError);
      await store.withTransaction(async (trx) => {
        const lot = await trx.getLot(id('lot'));
        await trx.putLot({ ...lot!, consumedMicro: 5, version: lot!.version + 1 });
      });
      expect((await store.withTransaction((trx) => trx.getLot(id('lot'))))?.consumedMicro).toBe(5);
    });

    it('keeps one lot per funding reference and one hold per operation in a scope', async () => {
      const { store, id } = await make();
      await store.withTransaction((trx) => trx.putLot(lotRow({ lotId: id('lot-1'), scopeId: id('s'), fundingRef: id('pay') })));
      await expect(
        store.withTransaction((trx) => trx.putLot(lotRow({ lotId: id('lot-2'), scopeId: id('s'), fundingRef: id('pay') }))),
      ).rejects.toBeInstanceOf(CreditConflictError);
      await store.withTransaction((trx) => trx.putHold(holdRow({ holdId: id('h-1'), scopeId: id('s'), operationId: id('op') })));
      await expect(
        store.withTransaction((trx) => trx.putHold(holdRow({ holdId: id('h-2'), scopeId: id('s'), operationId: id('op') }))),
      ).rejects.toBeInstanceOf(CreditConflictError);
      const found = await store.withTransaction((trx) => trx.findHoldByOperation(id('s'), id('op')));
      expect(found?.holdId).toBe(id('h-1'));
      expect((await store.withTransaction((trx) => trx.findLotByFundingRef(id('s'), id('pay'))))?.lotId).toBe(id('lot-1'));
    });

    it('appends an entry once by its id and lists entries by scope, kind and day', async () => {
      const { store, id } = await make();
      const entry = { entryId: id('e-1'), scopeId: id('s'), kind: 'lot_granted' as const, amountMicro: 10, lotId: id('lot'), holdId: null, ref: null, at: 1, day: '2026-10-12' };
      expect(await store.withTransaction((trx) => trx.appendEntry(entry))).toBe(true);
      expect(await store.withTransaction((trx) => trx.appendEntry({ ...entry, amountMicro: 99 }))).toBe(false);
      const listed = await store.withTransaction((trx) => trx.listEntries({ scopeId: id('s'), kinds: ['lot_granted'], fromDay: '2026-10-12', toDay: '2026-10-12' }));
      expect(listed).toEqual([entry]);
      expect(await store.withTransaction((trx) => trx.getEntry(id('e-1')))).toEqual(entry);
    });

    it('lists due holds in order and sums the open supplier liability', async () => {
      const { store, id } = await make();
      await store.withTransaction(async (trx) => {
        await trx.putHold(holdRow({ holdId: id('h-held'), scopeId: id('s'), operationId: id('o1'), supplierMicro: 400, expiresAt: 5_000 }));
        await trx.putHold(holdRow({ holdId: id('h-deferred'), scopeId: id('s'), operationId: id('o2'), state: 'deferred', supplierMicro: 300, deferredUntil: 6_000, createdAt: 2_000 }));
        await trx.putHold(holdRow({ holdId: id('h-settled'), scopeId: id('s'), operationId: id('o3'), state: 'settled', supplierMicro: 300, supplierSettledMicro: 100, supplierOpenMicro: 50, createdAt: 3_000 }));
      });
      const due = await store.withTransaction((trx) => trx.listHolds({ scopeId: id('s'), states: ['held', 'deferred'], dueAtOrBefore: 10_000 }));
      expect(due.map((h) => h.holdId)).toEqual([id('h-held'), id('h-deferred')]);
      const early = await store.withTransaction((trx) => trx.listHolds({ scopeId: id('s'), states: ['held', 'deferred'], dueAtOrBefore: 5_500 }));
      expect(early.map((h) => h.holdId)).toEqual([id('h-held')]);
      const open = await store.withTransaction((trx) => trx.openSupplierMicro(id('s')));
      expect(open).toBe(400 + 300 + 50);
    });

    it('keeps allocations and attempts by hold, in sequence', async () => {
      const { store, id } = await make();
      await store.withTransaction(async (trx) => {
        await trx.putHold(holdRow({ holdId: id('h'), scopeId: id('s'), operationId: id('o') }));
        await trx.putAllocation({ holdId: id('h'), seq: 2, lotId: id('lot-b'), amountMicro: 300, consumedMicro: 0, releasedMicro: 0, retiredMicro: 0, settled: false });
        await trx.putAllocation({ holdId: id('h'), seq: 1, lotId: id('lot-a'), amountMicro: 700, consumedMicro: 0, releasedMicro: 0, retiredMicro: 0, settled: false });
        await trx.putAttempt({ holdId: id('h'), attemptId: id('a-1'), seq: 1, purpose: 'initial', rateVersion: 'v1', state: 'authorized', usage: null, final: false, authorizedAt: 1, recordedAt: null, version: 1 });
      });
      const allocations = await store.withTransaction((trx) => trx.listAllocations(id('h')));
      expect(allocations.map((a) => a.seq)).toEqual([1, 2]);
      expect((await store.withTransaction((trx) => trx.listAllocationsByLot(id('lot-b'))))[0]?.amountMicro).toBe(300);
      await store.withTransaction(async (trx) => {
        const [attempt] = await trx.listAttempts(id('h'));
        await trx.putAttempt({ ...attempt!, state: 'recorded', usage: '{"input_token":5}', final: true, recordedAt: 2, version: 2 });
      });
      expect((await store.withTransaction((trx) => trx.listAttempts(id('h'))))[0]?.state).toBe('recorded');
    });

    it.runIf(options.concurrent)('serialises many transactions on one account', async () => {
      const { store, id } = await make();
      await store.withTransaction(async (trx) => {
        await trx.putAccount({ scopeId: id('s'), currency: 'USD', frozen: false, openDisputes: 0, createdAt: 1, version: 1 });
        await trx.putLot(lotRow({ lotId: id('lot'), scopeId: id('s'), fundingRef: id('pay') }));
      });
      await Promise.all(
        Array.from({ length: 12 }, () =>
          store.withTransaction(async (trx) => {
            const account = await trx.lockAccount(id('s'));
            await trx.putAccount({ ...account!, version: account!.version + 1 });
            const lot = await trx.getLot(id('lot'));
            await trx.putLot({ ...lot!, consumedMicro: lot!.consumedMicro + 1, version: lot!.version + 1 });
          }),
        ),
      );
      expect((await store.withTransaction((trx) => trx.getLot(id('lot'))))?.consumedMicro).toBe(12);
    });
  });
}
