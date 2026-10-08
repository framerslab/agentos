/**
 * @fileoverview The contract every {@link ISpendMeter} keeps, as a suite a store's own test file runs with a factory.
 *
 * The factory makes an empty meter whose allowance is read from the `allowance` map it is given (so a test can change
 * a plan between calls) and whose period is the calendar month of the clock in UTC.
 *
 * @module safety/runtime/__tests__/SpendMeter.contract
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ISpendMeter } from '../SpendMeter.js';

export interface SpendMeterHarness {
  meter: ISpendMeter;
  cleanup(): Promise<void>;
}
export type SpendMeterFactory = (setup: {
  allowance: Map<string, number>;
  leaseMs: number;
  unknownAfterLease: 'release' | 'consume';
  resolveUnknown?: (r: { operationId: string }) => 'consumed' | 'released' | 'unknown';
}) => Promise<SpendMeterHarness>;

/** 15 October 2026, noon UTC: the period "2026-10". */
export const OCT = Date.UTC(2026, 9, 15, 12);
/** 1 November 2026, five minutes past midnight UTC: the period "2026-11". */
export const NOV = Date.UTC(2026, 10, 1, 0, 5);
export const monthOf = (now: number): string => new Date(now).toISOString().slice(0, 7);

export function runSpendMeterContractSuite(name: string, factory: SpendMeterFactory): void {
  describe(`${name}: the spend meter contract`, () => {
    let harness: SpendMeterHarness | null = null;
    const open = async (allowance: Record<string, number>, opts: Partial<Parameters<SpendMeterFactory>[0]> = {}) => {
      harness = await factory({ allowance: new Map(Object.entries(allowance)), leaseMs: 1_000, unknownAfterLease: 'release', ...opts });
      return harness.meter;
    };
    afterEach(async () => {
      await harness?.cleanup();
      harness = null;
    });

    it('reserves within the allowance, refuses past it, and counts a consumed turn as used', async () => {
      const meter = await open({ a: 2 });
      const first = await meter.reserve({ accountId: 'a', operationId: 'op-1', now: OCT });
      expect(first).toMatchObject({ status: 'reserved', period: '2026-10', units: 1, attempt: 1, remaining: 1, expiresAt: OCT + 1_000 });
      expect(await meter.reserve({ accountId: 'a', operationId: 'op-2', now: OCT })).toMatchObject({ status: 'reserved', remaining: 0 });
      expect(await meter.reserve({ accountId: 'a', operationId: 'op-3', now: OCT })).toMatchObject({ status: 'denied', reason: 'allowance_exhausted', remaining: 0 });
      expect(await meter.settle({ operationId: 'op-1', outcome: 'consumed', usage: { totalTokens: 12 }, now: OCT })).toEqual({ status: 'settled', state: 'consumed' });
      expect(await meter.snapshot('a', OCT)).toEqual({ accountId: 'a', period: '2026-10', allowance: 2, used: 1, reserved: 1, remaining: 0 });
      // a refused operation left nothing behind: once a unit is free it reserves as a first attempt
      expect(await meter.settle({ operationId: 'op-2', outcome: 'released', now: OCT })).toEqual({ status: 'settled', state: 'released' });
      expect(await meter.reserve({ accountId: 'a', operationId: 'op-3', now: OCT })).toMatchObject({ status: 'reserved', attempt: 1, remaining: 0 });
    });

    it('answers a replay of each state: a live reservation is in flight, a consumed one already counted, a released one reserves again up to the cap', async () => {
      const meter = await open({ a: 10 });
      await meter.reserve({ accountId: 'a', operationId: 'op', now: OCT });
      expect(await meter.reserve({ accountId: 'a', operationId: 'op', now: OCT })).toMatchObject({ status: 'denied', reason: 'in_flight' });
      await meter.settle({ operationId: 'op', outcome: 'released', now: OCT });
      expect(await meter.reserve({ accountId: 'a', operationId: 'op', now: OCT })).toMatchObject({ status: 'reserved', attempt: 2 });
      await meter.settle({ operationId: 'op', outcome: 'released', now: OCT });
      expect(await meter.reserve({ accountId: 'a', operationId: 'op', now: OCT })).toMatchObject({ status: 'reserved', attempt: 3 });
      await meter.settle({ operationId: 'op', outcome: 'released', now: OCT });
      expect(await meter.reserve({ accountId: 'a', operationId: 'op', now: OCT })).toMatchObject({ status: 'denied', reason: 'retries_exhausted' });
      await meter.reserve({ accountId: 'a', operationId: 'done', now: OCT });
      await meter.settle({ operationId: 'done', outcome: 'consumed', now: OCT });
      expect(await meter.reserve({ accountId: 'a', operationId: 'done', now: OCT })).toMatchObject({ status: 'denied', reason: 'already_consumed' });
      expect(await meter.snapshot('a', OCT)).toMatchObject({ used: 1, reserved: 0, remaining: 9 });
    });

    it('settles once: a second settle of any outcome changes nothing, and an unknown operation is not found', async () => {
      const meter = await open({ a: 5 });
      await meter.reserve({ accountId: 'a', operationId: 'op', now: OCT });
      expect(await meter.settle({ operationId: 'op', outcome: 'consumed', now: OCT })).toEqual({ status: 'settled', state: 'consumed' });
      expect(await meter.settle({ operationId: 'op', outcome: 'consumed', now: OCT })).toEqual({ status: 'already_settled', state: 'consumed' });
      expect(await meter.settle({ operationId: 'op', outcome: 'released', now: OCT })).toEqual({ status: 'already_settled', state: 'consumed' });
      expect(await meter.settle({ operationId: 'nope', outcome: 'consumed', now: OCT })).toEqual({ status: 'not_found' });
      expect(await meter.snapshot('a', OCT)).toMatchObject({ used: 1, reserved: 0 });
    });

    it('refunds a reply replaced after its turn counted, and releases one replaced before', async () => {
      const meter = await open({ a: 5 });
      await meter.reserve({ accountId: 'a', operationId: 'counted', now: OCT });
      await meter.settle({ operationId: 'counted', outcome: 'consumed', now: OCT });
      expect(await meter.settle({ operationId: 'counted', outcome: 'replaced', now: OCT })).toEqual({ status: 'settled', state: 'released' });
      expect(await meter.settle({ operationId: 'counted', outcome: 'replaced', now: OCT })).toEqual({ status: 'already_settled', state: 'released' });
      await meter.reserve({ accountId: 'a', operationId: 'early', now: OCT });
      expect(await meter.settle({ operationId: 'early', outcome: 'replaced', now: OCT })).toEqual({ status: 'settled', state: 'released' });
      // the turn's own settle arrives after the refund and changes nothing
      expect(await meter.settle({ operationId: 'early', outcome: 'consumed', now: OCT })).toEqual({ status: 'already_settled', state: 'released' });
      expect(await meter.snapshot('a', OCT)).toMatchObject({ used: 0, reserved: 0, remaining: 5 });
    });

    it('keeps a reservation alive by heartbeat and settles the expired ones by what the product knows, else by the default', async () => {
      const known: Record<string, 'consumed' | 'released' | 'unknown'> = { stored: 'consumed', lost: 'released' };
      const meter = await open({ a: 10 }, { resolveUnknown: (r) => known[r.operationId] ?? 'unknown' });
      for (const op of ['stored', 'lost', 'silent', 'alive']) await meter.reserve({ accountId: 'a', operationId: op, now: OCT });
      await meter.heartbeat('alive', OCT + 900);
      // at OCT + 1,500 the three without a heartbeat have expired; the one with it lives until OCT + 1,900
      expect(await meter.reconcile({ now: OCT + 1_500 })).toEqual({ consumed: 1, released: 2, pending: 0 });
      expect(await meter.snapshot('a', OCT)).toMatchObject({ used: 1, reserved: 1 });
      expect(await meter.reconcile({ now: OCT + 1_500 })).toEqual({ consumed: 0, released: 0, pending: 0 });
      expect(await meter.reconcile({ now: OCT + 2_000 })).toEqual({ consumed: 0, released: 1, pending: 0 });
      expect(await meter.snapshot('a', OCT)).toMatchObject({ used: 1, reserved: 0, remaining: 9 });
    });

    it('consumes an expired reservation the product cannot account for when told to', async () => {
      const meter = await open({ a: 3 }, { unknownAfterLease: 'consume' });
      await meter.reserve({ accountId: 'a', operationId: 'op', now: OCT });
      expect(await meter.reconcile({ now: OCT + 5_000 })).toEqual({ consumed: 1, released: 0, pending: 0 });
      expect(await meter.snapshot('a', OCT)).toMatchObject({ used: 1, reserved: 0 });
    });

    it('settles a reservation against its own period across a rollover, and starts the new period empty', async () => {
      const meter = await open({ a: 1 });
      await meter.reserve({ accountId: 'a', operationId: 'late', now: OCT });
      expect(await meter.reserve({ accountId: 'a', operationId: 'next', now: NOV })).toMatchObject({ status: 'reserved', period: '2026-11' });
      await meter.settle({ operationId: 'late', outcome: 'consumed', now: NOV });
      expect(await meter.snapshot('a', OCT)).toMatchObject({ period: '2026-10', used: 1, reserved: 0 });
      expect(await meter.snapshot('a', NOV)).toMatchObject({ period: '2026-11', used: 0, reserved: 1 });
    });

    it('takes a plan change at the next reservation and from setAllowance, keeping the units used', async () => {
      const allowance = new Map([['a', 2]]);
      harness = await factory({ allowance, leaseMs: 1_000, unknownAfterLease: 'release' });
      const meter = harness.meter;
      await meter.reserve({ accountId: 'a', operationId: 'one', now: OCT });
      await meter.settle({ operationId: 'one', outcome: 'consumed', now: OCT });
      await meter.reserve({ accountId: 'a', operationId: 'two', now: OCT });
      await meter.settle({ operationId: 'two', outcome: 'consumed', now: OCT });
      expect(await meter.reserve({ accountId: 'a', operationId: 'three', now: OCT })).toMatchObject({ status: 'denied', reason: 'allowance_exhausted' });
      allowance.set('a', 5);
      expect(await meter.reserve({ accountId: 'a', operationId: 'three', now: OCT })).toMatchObject({ status: 'reserved', remaining: 2 });
      // written at once: the snapshot shows what is enforced before any other reservation
      await meter.setAllowance('a', 3, OCT);
      expect(await meter.snapshot('a', OCT)).toEqual({ accountId: 'a', period: '2026-10', allowance: 3, used: 2, reserved: 1, remaining: 0 });
      expect(await meter.reserve({ accountId: 'a', operationId: 'four', now: OCT })).toMatchObject({ status: 'reserved', remaining: 1 });
    });

    it('keeps accounts apart and reserves several units at once', async () => {
      const meter = await open({ a: 3, b: 1 });
      expect(await meter.reserve({ accountId: 'a', operationId: 'big', units: 3, now: OCT })).toMatchObject({ status: 'reserved', units: 3, remaining: 0 });
      expect(await meter.reserve({ accountId: 'b', operationId: 'small', now: OCT })).toMatchObject({ status: 'reserved', remaining: 0 });
      expect(await meter.reserve({ accountId: 'b', operationId: 'more', now: OCT })).toMatchObject({ status: 'denied', reason: 'allowance_exhausted' });
      await meter.settle({ operationId: 'big', outcome: 'consumed', now: OCT });
      expect(await meter.snapshot('a', OCT)).toMatchObject({ used: 3, remaining: 0 });
      expect(await meter.snapshot('b', OCT)).toMatchObject({ used: 0, reserved: 1 });
      // an account that never reserved shows its whole allowance
      expect(await meter.snapshot('c', OCT)).toEqual({ accountId: 'c', period: '2026-10', allowance: 0, used: 0, reserved: 0, remaining: 0 });
    });
  });
}
