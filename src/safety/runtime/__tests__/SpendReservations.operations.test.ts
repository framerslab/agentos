import { describe, expect, it } from 'vitest';
import { CostCapExceededError } from '../CostGuard.js';
import {
  InMemorySpendDayStore,
  beginOperationRun,
  endOperationRun,
  releaseExpiredSpend,
  renewOperationRun,
  reserveOperationSpend,
  reserveSpend,
  type SpendDayStore,
} from '../SpendReservations.js';

const T0 = new Date('2026-10-20T10:00:00.000Z');
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);
const BOUND = 3_000;

/** A question's admission: two runs' bounds reserved, run 1's recorded, a ten-minute window, a 45-second lease. */
function admission(operation = 'ask:q1', capMicro = 1_000_000) {
  return { kind: 'ask', micro: 2 * BOUND, at: T0, expires: at(600), capMicro, operation, runMicro: BOUND, leaseUntil: at(45) };
}

describe('operation reservations', () => {
  it('records the first run on admission, and refuses a second admission of the operation with nothing reserved', async () => {
    const store = new InMemorySpendDayStore();
    const first = await reserveOperationSpend(store, admission());
    expect(first).toEqual({ status: 'reserved', id: expect.any(String), run: 1 });
    expect(await store.openOperationReservation('ask:q1')).toMatchObject({ micro: 6_000, recordedMicro: 3_000, runs: 1, leaseRun: 1, leaseUntil: at(45) });
    expect(await reserveOperationSpend(store, admission())).toEqual({ status: 'in_flight' });
    expect(await store.lockDay('2026-10-20')).toBe(6_000);
  });

  it('refuses an operation admission past the day cap as reserveSpend does', async () => {
    const store = new InMemorySpendDayStore();
    await expect(reserveOperationSpend(store, admission('ask:q1', 5_000))).rejects.toBeInstanceOf(CostCapExceededError);
    expect(await store.lockDay('2026-10-20')).toBe(0);
  });

  it('refuses an operation admission on a store without the capability before the day is read', async () => {
    let read = false;
    const store: SpendDayStore = {
      lockDay: async () => ((read = true), 0),
      addReservation: async () => 'r',
      settleReservation: async () => true,
      expiredReservations: async () => [],
    };
    await expect(reserveOperationSpend(store, admission())).rejects.toThrow('operation reservations unsupported');
    expect(read).toBe(false);
  });

  it('begins a run in its order: gone for a settled row or one past its expiry, then in_flight while the lease lives, then gone at maxRuns', async () => {
    const store = new InMemorySpendDayStore();
    const { id } = (await reserveOperationSpend(store, admission())) as { id: string };
    expect(await beginOperationRun(store, id, { runMicro: BOUND, leaseUntil: at(80), maxRuns: 2, at: at(10) })).toEqual({ status: 'in_flight', leaseUntil: at(45) });
    expect(await beginOperationRun(store, id, { runMicro: BOUND, leaseUntil: at(91), maxRuns: 2, at: at(46) })).toEqual({ status: 'begun', run: 2 });
    expect(await beginOperationRun(store, id, { runMicro: BOUND, leaseUntil: at(100), maxRuns: 2, at: at(50) })).toEqual({ status: 'in_flight', leaseUntil: at(91) });
    expect(await beginOperationRun(store, id, { runMicro: BOUND, leaseUntil: at(140), maxRuns: 2, at: at(95) })).toEqual({ status: 'gone' });
    expect(await beginOperationRun(store, id, { runMicro: BOUND, leaseUntil: at(700), maxRuns: 3, at: at(601) })).toEqual({ status: 'gone' });
    expect(await store.openOperationReservation('ask:q1')).toMatchObject({ runs: 2, recordedMicro: 6_000, leaseRun: 2 });
  });

  it('gives one lease to two runs begun at once', async () => {
    const store = new InMemorySpendDayStore();
    const { id } = (await reserveOperationSpend(store, admission())) as { id: string };
    const both = await Promise.all([
      beginOperationRun(store, id, { runMicro: BOUND, leaseUntil: at(91), maxRuns: 2, at: at(46) }),
      beginOperationRun(store, id, { runMicro: BOUND, leaseUntil: at(91), maxRuns: 2, at: at(46) }),
    ]);
    expect(both.map((b) => b.status).sort()).toEqual(['begun', 'in_flight']);
  });

  it("puts the holder's settled figure in place of its bound, held to the bound, and clears the lease", async () => {
    const store = new InMemorySpendDayStore();
    const { id } = (await reserveOperationSpend(store, admission())) as { id: string };
    expect(await endOperationRun(store, id, { run: 1, settledMicro: 800, at: at(20), close: false })).toEqual({ holder: true, settled: false });
    expect(await store.openOperationReservation('ask:q1')).toMatchObject({ recordedMicro: 800, leaseRun: null, leaseUntil: null });
    const second = (await reserveOperationSpend(store, admission('ask:q2'))) as { id: string };
    await endOperationRun(store, second.id, { run: 1, settledMicro: 9_999, at: at(20), close: false });
    expect(await store.openOperationReservation('ask:q2')).toMatchObject({ recordedMicro: BOUND });
  });

  it("leaves a stale run's end on its own row, the lease and the figure unchanged; the holder then settles; a second end changes nothing", async () => {
    const store = new InMemorySpendDayStore();
    const { id } = (await reserveOperationSpend(store, admission())) as { id: string };
    await beginOperationRun(store, id, { runMicro: BOUND, leaseUntil: at(91), maxRuns: 2, at: at(46) });
    expect(await endOperationRun(store, id, { run: 1, settledMicro: 500, at: at(47), close: false })).toEqual({ holder: false, settled: false });
    expect(await store.openOperationReservation('ask:q1')).toMatchObject({ leaseRun: 2, leaseUntil: at(91), recordedMicro: 6_000 });
    expect(await endOperationRun(store, id, { run: 2, settledMicro: 700, at: at(60), close: false })).toEqual({ holder: true, settled: false });
    expect(await store.openOperationReservation('ask:q1')).toMatchObject({ recordedMicro: BOUND + 700, leaseRun: null });
    expect(await endOperationRun(store, id, { run: 2, settledMicro: 1, at: at(61), close: false })).toEqual({ holder: false, settled: false });
    expect(store.runOf(id, 1)).toMatchObject({ settledMicro: 500 });
  });

  it('settles the row in the same step when the holder ends past the expiry, or with close; a closed row takes no run', async () => {
    const store = new InMemorySpendDayStore();
    const { id } = (await reserveOperationSpend(store, admission())) as { id: string };
    expect(await endOperationRun(store, id, { run: 1, settledMicro: 0, at: at(5), close: true })).toEqual({ holder: true, settled: true });
    expect(await beginOperationRun(store, id, { runMicro: BOUND, leaseUntil: at(60), maxRuns: 2, at: at(10) })).toEqual({ status: 'gone' });
    expect(await store.lockDay('2026-10-20')).toBe(0);
    const late = (await reserveOperationSpend(store, admission('ask:q3'))) as { id: string };
    expect(await endOperationRun(store, late.id, { run: 1, settledMicro: 900, at: at(601), close: false })).toEqual({ holder: true, settled: true });
    expect(await store.lockDay('2026-10-20')).toBe(900);
  });

  it('sweeps an operation row only past its expiry with no live lease, at its recorded figure, a lost run whole, once', async () => {
    const store = new InMemorySpendDayStore();
    const { id } = (await reserveOperationSpend(store, admission())) as { id: string };
    await beginOperationRun(store, id, { runMicro: BOUND, leaseUntil: at(640), maxRuns: 2, at: at(595) });
    expect(await releaseExpiredSpend(store, at(601))).toBe(0);
    expect(await releaseExpiredSpend(store, at(641))).toBe(1);
    expect(await store.lockDay('2026-10-20')).toBe(6_000);
    expect(await releaseExpiredSpend(store, at(700))).toBe(0);
  });

  it('settles a reservation made by reserveSpend as it does today', async () => {
    const store = new InMemorySpendDayStore();
    await reserveSpend(store, { kind: 'call', micro: 1_000, at: T0, expires: at(60), capMicro: 1_000_000 });
    expect(await releaseExpiredSpend(store, at(61))).toBe(1);
    expect(await store.lockDay('2026-10-20')).toBe(1_000);
  });

  it('renews a lease only for the run that holds it while it lives, so no run begins during its holder\'s finalization', async () => {
    const store = new InMemorySpendDayStore();
    const { id } = (await reserveOperationSpend(store, admission())) as { id: string };
    expect(await renewOperationRun(store, id, { run: 1, leaseUntil: at(60), at: at(40) })).toBe(true);
    expect(await beginOperationRun(store, id, { runMicro: BOUND, leaseUntil: at(100), maxRuns: 2, at: at(50) })).toEqual({ status: 'in_flight', leaseUntil: at(60) });
    expect(await renewOperationRun(store, id, { run: 1, leaseUntil: at(90), at: at(61) })).toBe(false);
    await beginOperationRun(store, id, { runMicro: BOUND, leaseUntil: at(106), maxRuns: 2, at: at(61) });
    expect(await renewOperationRun(store, id, { run: 1, leaseUntil: at(120), at: at(62) })).toBe(false);
    expect(await store.openOperationReservation('ask:q1')).toMatchObject({ leaseRun: 2, leaseUntil: at(106) });
  });
});
