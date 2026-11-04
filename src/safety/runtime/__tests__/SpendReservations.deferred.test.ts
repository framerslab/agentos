import { describe, expect, it } from 'vitest';
import { InMemorySpendDayStore, releaseExpiredSpend, releaseSpend, reserveSpend } from '../SpendReservations.js';

const AT = new Date(Date.UTC(2026, 9, 12, 12, 0, 0));
const later = (ms: number) => new Date(AT.getTime() + ms);

describe('releaseExpiredSpend with fenced holds', () => {
  it('rejects an unsupported store and keeps a resolver fence through a subsequent legacy sweep', async () => {
    const store = new InMemorySpendDayStore();
    const legacy = { lockDay: store.lockDay.bind(store), addReservation: store.addReservation.bind(store),
      settleReservation: store.settleReservation.bind(store), expiredReservations: store.expiredReservations.bind(store) };
    await expect(reserveSpend(legacy, { kind: 'call', micro: 17, at: AT, expires: later(1), capMicro: 101, requireFence: true }))
      .rejects.toThrow('fenced reservations unsupported');
    expect(await store.lockDay('2026-10-12')).toBe(0);
    const id = await reserveSpend(store, { kind: 'call', micro: 17, at: AT, expires: later(1), capMicro: 101 });
    const evidence = { transportClosed: true, inferenceTerminated: false, observedAt: later(2).getTime() };
    expect(await releaseExpiredSpend(store, later(2), { resolve: async () => ({ outcome: 'deferred', retryAt: later(3).getTime(), evidence }) })).toBe(0);
    expect(await store.expiredReservations(later(4))).toEqual([{ id, micro: 17, requireFence: true, evidence }]);
    expect(await releaseExpiredSpend(store, later(4))).toBe(0);
    expect(await store.lockDay('2026-10-12')).toBe(17);
    expect(await releaseExpiredSpend(store, later(5), { resolve: async () => ({ outcome: 'released' }) })).toBe(1);
    expect(await store.lockDay('2026-10-12')).toBe(0);
  });

  it('leaves a fenced hold to an opted-in sweep, keeps it committed while deferred, and settles it when told', async () => {
    const store = new InMemorySpendDayStore();
    const fenced = await reserveSpend(store, { kind: 'call', micro: 500, at: AT, expires: later(1_000), capMicro: 10_000, requireFence: true });
    await reserveSpend(store, { kind: 'session', micro: 100, at: AT, expires: later(1_000), capMicro: 10_000 });
    // the legacy sweep settles the ordinary admission at its whole amount and leaves the fenced one
    expect(await releaseExpiredSpend(store, later(2_000))).toBe(1);
    expect(await store.lockDay('2026-10-12')).toBe(600);
    const decisions = [{ outcome: 'deferred' as const, retryAt: later(10_000).getTime() }, { outcome: 'released' as const }];
    const resolve = async () => decisions.shift()!;
    expect(await releaseExpiredSpend(store, later(3_000), { resolve })).toBe(0);
    expect(await store.lockDay('2026-10-12')).toBe(600);
    // deferred until its next check: not asked before it
    expect(await releaseExpiredSpend(store, later(9_000), { resolve: async () => { throw new Error('must not be asked'); } })).toBe(0);
    expect(await releaseExpiredSpend(store, later(11_000), { resolve })).toBe(1);
    // released: settled at nothing, the open 500 leaves the day's total
    expect(await store.lockDay('2026-10-12')).toBe(100);
    expect(fenced).toMatch(/^reservation-/);
  });

  it('settles a consumed reservation at the micro-dollars the resolver says it cost, never above what it reserved', async () => {
    const store = new InMemorySpendDayStore();
    await reserveSpend(store, { kind: 'call', micro: 500, at: AT, expires: later(1_000), capMicro: 10_000, requireFence: true });
    await reserveSpend(store, { kind: 'call', micro: 300, at: AT, expires: later(1_000), capMicro: 10_000, requireFence: true });
    await reserveSpend(store, { kind: 'call', micro: 100, at: AT, expires: later(1_000), capMicro: 10_000, requireFence: true });
    // the 500 cost 200; the 300 reports 900, held to 300; the 100 reports no figure and is consumed whole
    const cost: Record<number, number | undefined> = { 500: 200, 300: 900, 100: undefined };
    expect(await releaseExpiredSpend(store, later(2_000), { resolve: async (r) => ({ outcome: 'consumed', units: cost[r.micro] }) })).toBe(3);
    expect(await store.lockDay('2026-10-12')).toBe(600);
  });

  it.each([-5, -0.5, -Infinity])('settles a consumed decision of %d at the whole amount, the rule releaseSpend keeps for a cost below zero', async (units) => {
    const swept = new InMemorySpendDayStore();
    await reserveSpend(swept, { kind: 'call', micro: 500, at: AT, expires: later(1_000), capMicro: 10_000, requireFence: true });
    expect(await releaseExpiredSpend(swept, later(2_000), { resolve: async () => ({ outcome: 'consumed', units }) })).toBe(1);
    expect(await swept.lockDay('2026-10-12')).toBe(500);
    const released = new InMemorySpendDayStore();
    const id = await reserveSpend(released, { kind: 'call', micro: 500, at: AT, expires: later(1_000), capMicro: 10_000 });
    expect(await releaseSpend(released, id, units, AT)).toBe(true);
    expect(await released.lockDay('2026-10-12')).toBe(await swept.lockDay('2026-10-12'));
  });

  it('defers on a resolver failure instead of settling at the whole amount', async () => {
    const store = new InMemorySpendDayStore();
    await reserveSpend(store, { kind: 'call', micro: 500, at: AT, expires: later(1_000), capMicro: 10_000, requireFence: true });
    expect(await releaseExpiredSpend(store, later(2_000), { resolve: async () => { throw new Error('unreachable'); } })).toBe(0);
    expect(await store.lockDay('2026-10-12')).toBe(500);
    expect(await store.expiredReservations(later(2_000))).toEqual([]);
    expect((await store.expiredReservations(later(20_000))).map((r) => r.micro)).toEqual([500]);
  });
});
