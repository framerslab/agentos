/**
 * @fileoverview What a {@link SqlSpendMeter} keeps when it counts in a rolling window, and what its purge deletes, as
 * a suite a store's own test file runs with a factory.
 *
 * The factory makes an empty meter on its store with the counting it is given: `windowMs` for a rolling window,
 * `periodOf` for periods, neither for the meter the constructor refuses. The allowance is read from the `allowance`
 * map. `rows` counts what the store holds for the harness's own accounts, so a test reads what a purge left behind.
 *
 * @module safety/runtime/__tests__/SqlSpendMeter.window.contract
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ISpendMeter } from '../SpendMeter.js';
import type { SqlSpendMeter } from '../SqlSpendMeter.js';
import { NOV, OCT, monthOf } from './SpendMeter.contract.js';

/** The contract's methods and the SQL meter's purge. */
export type PurgingSpendMeter = ISpendMeter & Pick<SqlSpendMeter, 'purge'>;

export interface SpendMeterWindowHarness {
  meter: PurgingSpendMeter;
  /** The rows the store holds for this harness's accounts: their reservations, and their account or period rows. */
  rows(): Promise<{ reservations: number; periods: number }>;
  cleanup(): Promise<void>;
}

/** How a meter counts: in a rolling window, in the periods `periodOf` names, or (refused at construction) in neither. */
export interface SpendMeterCounting {
  windowMs?: number;
  periodOf?: (now: number) => string;
}

export type SpendMeterWindowFactory = (setup: { allowance: Map<string, number>; leaseMs: number } & SpendMeterCounting) => Promise<SpendMeterWindowHarness>;

/** One hour: the window every window meter of this suite counts in. */
const HOUR = 3_600_000;
/** A moment `minutes` minutes and `ms` milliseconds after 12:00 UTC on 15 October 2026. */
const at = (minutes: number, ms = 0): number => OCT + minutes * 60_000 + ms;

export function runSpendMeterWindowSuite(name: string, factory: SpendMeterWindowFactory): void {
  describe(`${name}: a rolling window and a purge`, () => {
    let harness: SpendMeterWindowHarness | null = null;
    /** Opens a meter that counts in a rolling hour, unless told how else to count. */
    const open = async (allowance: Record<string, number>, counting: SpendMeterCounting = { windowMs: HOUR }): Promise<SpendMeterWindowHarness> => {
      harness = await factory({ allowance: new Map(Object.entries(allowance)), leaseMs: 1_000, ...counting });
      return harness;
    };
    afterEach(async () => {
      await harness?.cleanup();
      harness = null;
    });

    it('holds the allowance over the last hour: a unit counts for an hour from its reservation and has left a millisecond after', async () => {
      const { meter } = await open({ a: 2 });
      expect(await meter.reserve({ accountId: 'a', operationId: 'noon', now: at(0) })).toMatchObject({ status: 'reserved', period: 'window', units: 1, attempt: 1, remaining: 1, expiresAt: at(0) + 1_000 });
      expect(await meter.settle({ operationId: 'noon', outcome: 'consumed', now: at(0) })).toEqual({ status: 'settled', state: 'consumed' });
      expect(await meter.reserve({ accountId: 'a', operationId: 'ten-past', now: at(10) })).toMatchObject({ status: 'reserved', period: 'window', remaining: 0 });
      await meter.settle({ operationId: 'ten-past', outcome: 'consumed', now: at(10) });
      expect(await meter.reserve({ accountId: 'a', operationId: 'third', now: at(20) })).toMatchObject({ status: 'denied', reason: 'allowance_exhausted', period: 'window', remaining: 0 });
      // at 13:00:00.000 the 12:00 unit is an hour old to the millisecond and still counts
      expect(await meter.reserve({ accountId: 'a', operationId: 'third', now: at(60) })).toMatchObject({ status: 'denied', reason: 'allowance_exhausted', remaining: 0 });
      // at 13:00:00.001 it has left the window and the 12:10 unit has not; the refusals left nothing behind
      expect(await meter.reserve({ accountId: 'a', operationId: 'third', now: at(60, 1) })).toMatchObject({ status: 'reserved', attempt: 1, remaining: 0 });
    });

    it('never counts a released reservation, and counts one still reserved until it settles or its lease runs out and reconcile releases it', async () => {
      const { meter } = await open({ a: 2 });
      await meter.reserve({ accountId: 'a', operationId: 'given-back', now: at(0) });
      await meter.reserve({ accountId: 'a', operationId: 'held', now: at(0) });
      expect(await meter.reserve({ accountId: 'a', operationId: 'next', now: at(1) })).toMatchObject({ status: 'denied', reason: 'allowance_exhausted', remaining: 0 });
      // released: its unit is free at once
      expect(await meter.settle({ operationId: 'given-back', outcome: 'released', now: at(1) })).toEqual({ status: 'settled', state: 'released' });
      expect(await meter.reserve({ accountId: 'a', operationId: 'next', now: at(1) })).toMatchObject({ status: 'reserved', attempt: 1, remaining: 0 });
      // the lease of `held` ran out at 12:00:01, yet nothing has settled it: it still counts
      expect(await meter.reserve({ accountId: 'a', operationId: 'more', now: at(1, 500) })).toMatchObject({ status: 'denied', reason: 'allowance_exhausted', remaining: 0 });
      // reconcile releases it, the default for an expired reservation nobody can account for; `next` lives until 12:01:01
      expect(await meter.reconcile({ now: at(1, 500) })).toEqual({ consumed: 0, released: 1, pending: 0 });
      expect(await meter.reserve({ accountId: 'a', operationId: 'more', now: at(1, 500) })).toMatchObject({ status: 'reserved', attempt: 1, remaining: 0 });
      expect(await meter.snapshot('a', at(1, 500))).toEqual({ accountId: 'a', period: 'window', allowance: 2, used: 0, reserved: 2, remaining: 0 });
    });

    it('answers a snapshot from the window: the units consumed and reserved inside it, what remains, and the period `window`', async () => {
      const { meter } = await open({ a: 5, b: 1 });
      // an account that never reserved shows its whole allowance
      expect(await meter.snapshot('a', at(0))).toEqual({ accountId: 'a', period: 'window', allowance: 5, used: 0, reserved: 0, remaining: 5 });
      await meter.reserve({ accountId: 'a', operationId: 'two', units: 2, now: at(0) });
      await meter.settle({ operationId: 'two', outcome: 'consumed', now: at(0) });
      await meter.reserve({ accountId: 'a', operationId: 'one', now: at(30) });
      await meter.settle({ operationId: 'one', outcome: 'consumed', now: at(30) });
      await meter.reserve({ accountId: 'a', operationId: 'open', now: at(45) });
      await meter.reserve({ accountId: 'b', operationId: 'other', now: at(45) });
      expect(await meter.snapshot('a', at(45))).toEqual({ accountId: 'a', period: 'window', allowance: 5, used: 3, reserved: 1, remaining: 1 });
      expect(await meter.snapshot('b', at(45))).toEqual({ accountId: 'b', period: 'window', allowance: 1, used: 0, reserved: 1, remaining: 0 });
      // at 13:00:00.001 the two units of 12:00 have left: the account's row still holds them, the window does not
      expect(await meter.snapshot('a', at(60, 1))).toEqual({ accountId: 'a', period: 'window', allowance: 5, used: 1, reserved: 1, remaining: 3 });
      // a plan change written at once shows at once, as it does for a period
      await meter.setAllowance('a', 2, at(60, 1));
      expect(await meter.snapshot('a', at(60, 1))).toEqual({ accountId: 'a', period: 'window', allowance: 2, used: 1, reserved: 1, remaining: 0 });
    });

    it('purges, a page at a time, the reservations settled before a time and the account rows idle since then, and never a reservation still reserved', async () => {
      const { meter, rows } = await open({ a: 5, b: 5, c: 5 });
      // a: one unit consumed and one released at 12:00, nothing since
      await meter.reserve({ accountId: 'a', operationId: 'a-used', now: at(0) });
      await meter.settle({ operationId: 'a-used', outcome: 'consumed', now: at(0) });
      await meter.reserve({ accountId: 'a', operationId: 'a-freed', now: at(0) });
      await meter.settle({ operationId: 'a-freed', outcome: 'released', now: at(0) });
      // b: one unit consumed at 12:00, and one reserved then that nothing has settled
      await meter.reserve({ accountId: 'b', operationId: 'b-used', now: at(0) });
      await meter.settle({ operationId: 'b-used', outcome: 'consumed', now: at(0) });
      await meter.reserve({ accountId: 'b', operationId: 'b-open', now: at(0) });
      // c: one unit consumed at 12:30
      await meter.reserve({ accountId: 'c', operationId: 'c-used', now: at(30) });
      await meter.settle({ operationId: 'c-used', outcome: 'consumed', now: at(30) });
      expect(await rows()).toEqual({ reservations: 5, periods: 3 });

      // three reservations settled before 12:10 and one account row idle since then: at most two of each a call
      expect(await meter.purge({ before: at(10), limit: 2 })).toEqual({ reservations: 2, periods: 1 });
      expect(await meter.purge({ before: at(10) })).toEqual({ reservations: 1, periods: 0 });
      expect(await meter.purge({ before: at(10) })).toEqual({ reservations: 0, periods: 0 });
      expect(await rows()).toEqual({ reservations: 2, periods: 2 });
      // the reservation still reserved is kept with its account's row: a duplicate of it is in flight, and it settles
      expect(await meter.reserve({ accountId: 'b', operationId: 'b-open', now: at(31) })).toMatchObject({ status: 'denied', reason: 'in_flight' });
      expect(await meter.settle({ operationId: 'b-open', outcome: 'consumed', now: at(31) })).toEqual({ status: 'settled', state: 'consumed' });
      // the reservation settled after 12:10 is kept: its operation still answers as counted
      expect(await meter.reserve({ accountId: 'c', operationId: 'c-used', now: at(31) })).toMatchObject({ status: 'denied', reason: 'already_consumed' });
      // a purged operation is gone: it is not found, and sent again it counts as new
      expect(await meter.settle({ operationId: 'a-used', outcome: 'replaced', now: at(31) })).toEqual({ status: 'not_found' });
      expect(await meter.reserve({ accountId: 'a', operationId: 'a-used', now: at(31) })).toMatchObject({ status: 'reserved', attempt: 1 });
    });

    it('keeps every unit the window counts when it purges up to one window back', async () => {
      const { meter, rows } = await open({ a: 3 });
      await meter.reserve({ accountId: 'a', operationId: 'old', now: at(0) });
      await meter.settle({ operationId: 'old', outcome: 'consumed', now: at(0) });
      await meter.reserve({ accountId: 'a', operationId: 'edge', now: at(10) });
      await meter.settle({ operationId: 'edge', outcome: 'consumed', now: at(10) });
      await meter.reserve({ accountId: 'a', operationId: 'new', now: at(40) });
      await meter.settle({ operationId: 'new', outcome: 'consumed', now: at(40) });
      // at 13:10 the window reaches back to 12:10 to the millisecond: the 12:10 unit is the oldest it counts
      const counted = await meter.snapshot('a', at(70));
      expect(counted).toEqual({ accountId: 'a', period: 'window', allowance: 3, used: 2, reserved: 0, remaining: 1 });
      expect(await meter.purge({ before: at(70) - HOUR })).toEqual({ reservations: 1, periods: 0 });
      expect(await meter.snapshot('a', at(70))).toEqual(counted);
      expect(await rows()).toEqual({ reservations: 2, periods: 1 });
    });

    it('keeps every period row of a meter with periods: a month reads the same once its settled reservations are purged', async () => {
      const { meter, rows } = await open({ a: 5 }, { periodOf: monthOf });
      await meter.reserve({ accountId: 'a', operationId: 'one', now: OCT });
      await meter.settle({ operationId: 'one', outcome: 'consumed', now: OCT });
      await meter.reserve({ accountId: 'a', operationId: 'two', now: OCT });
      await meter.settle({ operationId: 'two', outcome: 'consumed', now: OCT });
      const month = await meter.snapshot('a', OCT);
      expect(month).toEqual({ accountId: 'a', period: '2026-10', allowance: 5, used: 2, reserved: 0, remaining: 3 });
      // in November the month's row is idle and both reservations are settled: the reservations go, the row stays
      expect(await meter.purge({ before: NOV })).toEqual({ reservations: 2, periods: 0 });
      expect(await rows()).toEqual({ reservations: 0, periods: 1 });
      expect(await meter.snapshot('a', OCT)).toEqual(month);
    });

    it('refuses, at construction, a meter with neither a period nor a window, and a window that is no span of time', async () => {
      const setup = { allowance: new Map<string, number>(), leaseMs: 1_000 };
      await expect(factory(setup)).rejects.toThrow(/periodOf or windowMs/);
      for (const windowMs of [0, -60_000, Number.NaN]) {
        await expect(factory({ ...setup, windowMs }), String(windowMs)).rejects.toThrow(/positive number of milliseconds/);
      }
    });
  });
}
