/**
 * Deferred expiry: an expired reservation whose work may still run stays reserved, with its evidence and its next
 * check, until a resolver settles it, and a meter without a resolver cannot settle one made with `requireFence`. A
 * pass writes each decision only to the reservation it read, as it read it, whatever happens while its resolver is
 * asked, and fenced holds never keep a legacy pass from the ordinary reservations behind them. Runs on SQLite in
 * memory always, and on Postgres when `AGENTOS_TEST_POSTGRES_URL` is set (tables under this run's prefix, dropped
 * after).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createPostgresAdapter, resolveStorageAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { SqlSpendMeter, type SqlSpendMeterOptions } from '../SqlSpendMeter.js';
import type { SpendExpiryDecision, SpendReconcileResult, SpendReserveResult } from '../SpendMeter.js';

const POSTGRES_URL = process.env.AGENTOS_TEST_POSTGRES_URL;
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const HOUR = 3_600_000;
const NOON = Date.UTC(2026, 9, 12, 12, 0, 0);
const at = (minutes: number, ms = 0) => NOON + minutes * 60_000 + ms;

function suite(name: string, open: () => Promise<{ db: StorageAdapter; prefix: string }>, shared: boolean) {
  const meter = (db: StorageAdapter, prefix: string, extra: Partial<SqlSpendMeterOptions> = {}) =>
    new SqlSpendMeter({ db, tablePrefix: prefix, requireShared: shared, leaseMs: 1_000, allowanceFor: () => 2, periodOf: () => '2026-10', ...extra });

  describe(`${name}: deferred expiry`, () => {
    it('retains resolver-established fencing when a fresh legacy client sweeps', async () => {
      const { db, prefix } = await open(); const plain = meter(db, prefix);
      await plain.reserve({ accountId: 'a', operationId: 'uncertain', now: at(0) });
      const evidence = { transportClosed: false, inferenceTerminated: false, observedAt: at(1) };
      const resolver = meter(db, prefix, { resolveExpired: async () => ({ outcome: 'deferred', retryAt: at(2), evidence }) });
      expect(await resolver.reconcile({ now: at(1) })).toMatchObject({ deferred: 1, pending: 1 });
      const legacy = meter(db, prefix);
      expect(await legacy.reconcile({ now: at(3) })).toEqual({ consumed: 0, released: 0, pending: 1 });
      expect(await legacy.snapshot('a', at(3))).toMatchObject({ reserved: 1, used: 0 });
      const row = await db.get<{ outcome: string; usage_json: string }>(`SELECT outcome, usage_json FROM ${prefix}_reservations WHERE operation_id = 'uncertain'`);
      expect(row?.outcome).toBe('deferred'); expect(JSON.parse(row!.usage_json).deferral.evidence).toEqual(evidence);
      const final = meter(db, prefix, { resolveExpired: async () => ({ outcome: 'released' }) });
      expect(await final.reconcile({ now: at(3) })).toMatchObject({ released: 1, pending: 0 });
      expect(await legacy.snapshot('a', at(3))).toMatchObject({ reserved: 0, used: 0 });
    });
    it('keeps a fenced reservation reserved and counted under a legacy reconcile, and lets an explicit settle end it', async () => {
      const { db, prefix } = await open();
      const optedIn = meter(db, prefix, { resolveExpired: async () => ({ outcome: 'deferred', retryAt: at(5), evidence: { transportClosed: false, inferenceTerminated: false, observedAt: at(0) } }) });
      expect(await optedIn.reserve({ accountId: 'a', operationId: 'call', requireFence: true, now: at(0) })).toMatchObject({ status: 'reserved' });
      const legacy = meter(db, prefix);
      expect(await legacy.reconcile({ now: at(1) })).toEqual({ consumed: 0, released: 0, pending: 1 });
      expect(await legacy.snapshot('a', at(1))).toMatchObject({ reserved: 1, used: 0 });
      expect(await legacy.settle({ operationId: 'call', outcome: 'consumed', now: at(2) })).toEqual({ status: 'settled', state: 'consumed' });
      expect(await legacy.snapshot('a', at(2))).toMatchObject({ reserved: 0, used: 1 });
    });

    it('defers with persisted evidence and a next check, defers again on a resolver failure, and settles when told', async () => {
      const { db, prefix } = await open();
      const decisions: Array<SpendExpiryDecision | Error> = [
        { outcome: 'deferred', retryAt: at(10), evidence: { transportClosed: true, inferenceTerminated: false, observedAt: at(1), note: 'worker alive' } },
        new Error('control plane unreachable'),
        { outcome: 'released' },
      ];
      const asked: Array<{ deferredCount: number; requireFence: boolean }> = [];
      const m = meter(db, prefix, {
        resolveExpired: async (r) => {
          asked.push({ deferredCount: r.deferredCount, requireFence: r.requireFence });
          const next = decisions.shift()!;
          if (next instanceof Error) throw next;
          return next;
        },
      });
      await m.reserve({ accountId: 'a', operationId: 'call', requireFence: true, now: at(0) });
      expect(await m.reconcile({ now: at(1) })).toEqual({ consumed: 0, released: 0, pending: 1, deferred: 1 });
      const row = await db.get<{ state: string; outcome: string; expires_at: number | string; usage_json: string }>(`SELECT state, outcome, expires_at, usage_json FROM ${prefix}_reservations WHERE operation_id = 'call'`);
      expect(row).toMatchObject({ state: 'reserved', outcome: 'deferred' });
      expect(Number(row!.expires_at)).toBe(at(10));
      expect(JSON.parse(row!.usage_json)).toEqual({ deferral: { count: 1, evidence: { transportClosed: true, inferenceTerminated: false, observedAt: at(1), note: 'worker alive' } } });
      // not due before its next check
      expect(await m.reconcile({ now: at(9) })).toEqual({ consumed: 0, released: 0, pending: 0, deferred: 0 });
      // a resolver that throws defers again for one lease; it never falls through to release
      expect(await m.reconcile({ now: at(10) })).toEqual({ consumed: 0, released: 0, pending: 1, deferred: 1 });
      expect(await m.snapshot('a', at(10))).toMatchObject({ reserved: 1 });
      expect(await m.reconcile({ now: at(10, 1_000) })).toEqual({ consumed: 0, released: 1, pending: 0, deferred: 0 });
      expect(asked).toEqual([{ deferredCount: 0, requireFence: true }, { deferredCount: 1, requireFence: true }, { deferredCount: 2, requireFence: true }]);
    });

    it('counts a reservation still reserved in a rolling window whatever its age', async () => {
      const { db, prefix } = await open();
      const m = meter(db, `${prefix}w`, { windowMs: HOUR, periodOf: undefined, allowanceFor: () => 1, resolveExpired: async () => ({ outcome: 'deferred', retryAt: at(180) }) });
      await m.reserve({ accountId: 'a', operationId: 'long-call', requireFence: true, now: at(0) });
      await m.reconcile({ now: at(1) });
      // two hours on, the deferred hold still holds the window's only unit
      expect(await m.reserve({ accountId: 'a', operationId: 'next', now: at(120) })).toMatchObject({ status: 'denied', reason: 'allowance_exhausted' });
      expect(await m.snapshot('a', at(120))).toMatchObject({ reserved: 1, remaining: 0 });
      await m.settle({ operationId: 'long-call', outcome: 'released', now: at(121) });
      expect(await m.reserve({ accountId: 'a', operationId: 'next', now: at(121) })).toMatchObject({ status: 'reserved' });
    });

    it('settles an ordinary expired reservation as before, with the legacy result shape', async () => {
      const { db, prefix } = await open();
      const m = meter(db, `${prefix}l`);
      await m.reserve({ accountId: 'a', operationId: 'turn', now: at(0) });
      expect(await m.reconcile({ now: at(1) })).toEqual({ consumed: 0, released: 1, pending: 0 });
    });
  });

  describe(`${name}: a pass's decisions hold only for the reservation it read`, () => {
    const evidence = { transportClosed: false, inferenceTerminated: false, observedAt: at(1) };

    it('leaves a hold reserved and counted when an opted-in pass defers it while a legacy pass asks resolveUnknown about it', async () => {
      const { db, prefix } = await open();
      const optedIn = meter(db, prefix, { resolveExpired: async () => ({ outcome: 'deferred', retryAt: at(5), evidence }) });
      let meanwhile: SpendReconcileResult | undefined;
      const legacy = meter(db, prefix, {
        resolveUnknown: async () => {
          // the opted-in pass runs while the legacy one waits on its resolver, and finds the hold's work may still run
          meanwhile = await optedIn.reconcile({ now: at(1) });
          return 'unknown';
        },
      });
      await legacy.reserve({ accountId: 'a', operationId: 'uncertain', now: at(0) });
      const result = await legacy.reconcile({ now: at(1) });
      expect(meanwhile).toEqual({ consumed: 0, released: 0, pending: 1, deferred: 1 });
      expect(result).toEqual({ consumed: 0, released: 0, pending: 1 });
      expect(await legacy.snapshot('a', at(1))).toMatchObject({ reserved: 1, used: 0 });
      const row = await db.get<{ state: string; outcome: string | null; expires_at: number | string }>(`SELECT state, outcome, expires_at FROM ${prefix}_reservations WHERE operation_id = 'uncertain'`);
      expect(row).toMatchObject({ state: 'reserved', outcome: 'deferred' });
      expect(Number(row!.expires_at)).toBe(at(5));
    });

    it('leaves a turn reserved when its heartbeat renews the lease while a legacy pass asks resolveUnknown about it', async () => {
      const { db, prefix } = await open();
      const legacy: SqlSpendMeter = meter(db, prefix, {
        resolveUnknown: async (r) => {
          // the turn was alive after all: its heartbeat lands while the pass waits on its resolver
          await legacy.heartbeat(r.operationId, at(1));
          return 'unknown';
        },
      });
      await legacy.reserve({ accountId: 'a', operationId: 'turn', now: at(0) });
      expect(await legacy.reconcile({ now: at(1) })).toEqual({ consumed: 0, released: 0, pending: 1 });
      expect(await legacy.snapshot('a', at(1))).toMatchObject({ reserved: 1, used: 0 });
      // the turn ends inside its renewed lease, and its own settlement counts it
      expect(await legacy.settle({ operationId: 'turn', outcome: 'consumed', now: at(1, 500) })).toEqual({ status: 'settled', state: 'consumed' });
      expect(await legacy.snapshot('a', at(1, 500))).toMatchObject({ reserved: 0, used: 1 });
    });

    it('settles the ordinary expired reservations behind fenced ones on a meter without resolveExpired, at any page size', async () => {
      const { db, prefix } = await open();
      const legacy = meter(db, prefix);
      // the fenced hold's lease runs out first, and a pass without resolveExpired leaves it reserved at every pass
      await legacy.reserve({ accountId: 'a', operationId: 'call', requireFence: true, now: at(0) });
      await legacy.reserve({ accountId: 'a', operationId: 'turn', now: at(0, 500) });
      expect(await legacy.reconcile({ now: at(1), limit: 1 })).toEqual({ consumed: 0, released: 1, pending: 0 });
      const turn = await db.get<{ state: string }>(`SELECT state FROM ${prefix}_reservations WHERE operation_id = 'turn'`);
      expect(turn?.state).toBe('released');
      // with no ordinary reservation left to settle, the page reaches the fenced hold: still reserved, counted pending
      expect(await legacy.reconcile({ now: at(1), limit: 1 })).toEqual({ consumed: 0, released: 0, pending: 1 });
      expect(await legacy.snapshot('a', at(1))).toMatchObject({ reserved: 1, used: 0 });
    });

    it('drops a deferral when the operation is released and retried while resolveExpired is asked, so the retry keeps its own lease', async () => {
      const { db, prefix } = await open();
      let retry: SpendReserveResult | undefined;
      const optedIn: SqlSpendMeter = meter(db, prefix, {
        resolveExpired: async (r) => {
          // meanwhile its owner releases the first attempt and the client retries the operation: a new attempt, with a lease of its own
          await optedIn.settle({ operationId: r.operationId, outcome: 'released', now: at(1) });
          retry = await optedIn.reserve({ accountId: 'a', operationId: r.operationId, now: at(1) });
          return { outcome: 'deferred', retryAt: at(1, 500), evidence };
        },
      });
      await optedIn.reserve({ accountId: 'a', operationId: 'turn', now: at(0) });
      const result = await optedIn.reconcile({ now: at(1) });
      expect(retry).toMatchObject({ status: 'reserved', attempt: 2, expiresAt: at(1, 1_000) });
      expect(result).toMatchObject({ deferred: 0 });
      // the second attempt carries no fence, none of the first attempt's deferral, and the lease its reservation took
      const row = await db.get<{ state: string; attempts: number | string; outcome: string | null; expires_at: number | string; usage_json: string | null }>(
        `SELECT state, attempts, outcome, expires_at, usage_json FROM ${prefix}_reservations WHERE operation_id = 'turn'`,
      );
      expect(row).toMatchObject({ state: 'reserved', outcome: null, usage_json: null });
      expect(Number(row!.attempts)).toBe(2);
      expect(Number(row!.expires_at)).toBe(at(1, 1_000));
    });

    it('settles no attempt resolveExpired was not asked about, even a retry already due when the pass began', async () => {
      const { db, prefix } = await open();
      const optedIn: SqlSpendMeter = meter(db, prefix, {
        resolveExpired: async (r) => {
          await optedIn.settle({ operationId: r.operationId, outcome: 'released', now: at(1) });
          // the retry is stamped by a process whose clock runs behind, so its lease is out at the pass's now as well
          await optedIn.reserve({ accountId: 'a', operationId: r.operationId, now: at(0) });
          return { outcome: 'consumed' };
        },
      });
      await optedIn.reserve({ accountId: 'a', operationId: 'turn', now: at(0) });
      expect(await optedIn.reconcile({ now: at(1) })).toMatchObject({ consumed: 0, released: 0 });
      expect(await optedIn.snapshot('a', at(1))).toMatchObject({ reserved: 1, used: 0 });
      const row = await db.get<{ state: string; attempts: number | string }>(`SELECT state, attempts FROM ${prefix}_reservations WHERE operation_id = 'turn'`);
      expect(row?.state).toBe('reserved');
      expect(Number(row!.attempts)).toBe(2);
    });
  });
}

let sqliteN = 0;
suite('sqlite', async () => ({ db: await resolveStorageAdapter({ filePath: ':memory:', priority: ['better-sqlite3', 'sqljs'], quiet: true }), prefix: `deferred_${(sqliteN += 1)}` }), false);

const madePrefixes: string[] = [];
let pg: StorageAdapter | undefined;
describe.skipIf(!POSTGRES_URL)('postgres', () => {
  suite('postgres', async () => {
    if (!pg) {
      pg = createPostgresAdapter({ connectionString: POSTGRES_URL!, max: 10 });
      await pg.open();
    }
    const prefix = `dx${RUN}_${madePrefixes.length + 1}`;
    madePrefixes.push(prefix, `${prefix}w`, `${prefix}l`);
    return { db: pg, prefix };
  }, true);
  afterAll(async () => {
    if (!pg) return;
    for (const prefix of madePrefixes) for (const table of ['meter', 'reservations']) await pg.exec(`DROP TABLE IF EXISTS ${prefix}_${table}`);
    await pg.close();
  });
});
