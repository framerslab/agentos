/**
 * @fileoverview The spend meter over Postgres, where several processes share it: the contract, the rolling window and
 * the purge, twenty concurrent reservations against an allowance of five in a period and of two in a window, and a
 * settle racing a reconcile on one operation.
 *
 * Gated on `AGENTOS_TEST_POSTGRES_URL` (CI's service container); skipped without it. Each test meters accounts and
 * operations under a prefix of its own and deletes them after, so runs never collide.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { SqlSpendMeter } from '../SqlSpendMeter.js';
import { OCT, monthOf, runSpendMeterContractSuite } from './SpendMeter.contract.js';
import { runSpendMeterWindowSuite } from './SqlSpendMeter.window.contract.js';

const POSTGRES_URL = process.env.AGENTOS_TEST_POSTGRES_URL;
const describeIfPostgres = POSTGRES_URL ? describe : describe.skip;

async function openPostgres(): Promise<StorageAdapter> {
  const db = createPostgresAdapter({ connectionString: POSTGRES_URL!, max: 25 });
  await db.open();
  return db;
}

/** A meter whose account and operation ids carry a prefix of their own; cleanup deletes every row under it. */
function prefixed(db: StorageAdapter, prefix: string, meter: SqlSpendMeter) {
  const p = (id: string) => `${prefix}${id}`;
  const scoped = {
    reserve: (req: Parameters<SqlSpendMeter['reserve']>[0]) => meter.reserve({ ...req, accountId: p(req.accountId), operationId: p(req.operationId) }).then((r) => ({ ...r, accountId: req.accountId, operationId: req.operationId })),
    settle: (req: Parameters<SqlSpendMeter['settle']>[0]) => meter.settle({ ...req, operationId: p(req.operationId) }),
    heartbeat: (operationId: string, now?: number) => meter.heartbeat(p(operationId), now),
    reconcile: async (opts?: { now?: number; limit?: number }) => meter.reconcile(opts),
    snapshot: (accountId: string, now?: number) => meter.snapshot(p(accountId), now).then((s) => ({ ...s, accountId })),
    setAllowance: (accountId: string, allowance: number, now?: number) => meter.setAllowance(p(accountId), allowance, now),
  };
  const cleanup = async () => {
    await db.run('DELETE FROM agentos_spend_reservations WHERE operation_id LIKE ?', [`${prefix}%`]);
    await db.run('DELETE FROM agentos_spend_meter WHERE account_id LIKE ?', [`${prefix}%`]);
  };
  return { scoped, cleanup };
}

const prefixOf = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}-`;

describeIfPostgres('SqlSpendMeter on Postgres', () => {
  let db: StorageAdapter;
  beforeAll(async () => {
    db = await openPostgres();
  });
  afterAll(async () => {
    await db?.close();
  });

  runSpendMeterContractSuite('SqlSpendMeter on Postgres', async ({ allowance, leaseMs, unknownAfterLease, resolveUnknown }) => {
    const prefix = prefixOf();
    const strip = (id: string) => (id.startsWith(prefix) ? id.slice(prefix.length) : id);
    const meter = new SqlSpendMeter({
      db,
      allowanceFor: (accountId) => allowance.get(strip(accountId)) ?? 0,
      periodOf: (now) => monthOf(now),
      leaseMs,
      unknownAfterLease,
      resolveUnknown: resolveUnknown ? (r) => resolveUnknown({ operationId: strip(r.operationId) }) : undefined,
    });
    await meter.ensureSchema();
    // reconcile reads every expired row in the table; leave none of other runs' in this test's way
    await db.run("UPDATE agentos_spend_reservations SET expires_at = 9007199254740991 WHERE state = 'reserved' AND operation_id NOT LIKE ?", [`${prefix}%`]);
    const { scoped, cleanup } = prefixed(db, prefix, meter);
    return { meter: scoped, cleanup };
  });

  runSpendMeterWindowSuite('SqlSpendMeter on Postgres', async ({ allowance, leaseMs, windowMs, periodOf }) => {
    const prefix = prefixOf();
    const strip = (id: string) => (id.startsWith(prefix) ? id.slice(prefix.length) : id);
    const meter = new SqlSpendMeter({ db, allowanceFor: (accountId) => allowance.get(strip(accountId)) ?? 0, windowMs, periodOf, leaseMs });
    await meter.ensureSchema();
    // reconcile reads every expired row in the table, and purge every settled reservation and every idle account
    // row of a window; leave none of other runs' in this test's way
    await db.run("UPDATE agentos_spend_reservations SET expires_at = 9007199254740991 WHERE state = 'reserved' AND operation_id NOT LIKE ?", [`${prefix}%`]);
    await db.run("UPDATE agentos_spend_reservations SET settled_at = 9007199254740991 WHERE state <> 'reserved' AND operation_id NOT LIKE ?", [`${prefix}%`]);
    await db.run("UPDATE agentos_spend_meter SET updated_at = 9007199254740991 WHERE period = 'window' AND account_id NOT LIKE ?", [`${prefix}%`]);
    const { scoped, cleanup } = prefixed(db, prefix, meter);
    const count = async (table: string, id: string) => Number((await db.get<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE ${id} LIKE ?`, [`${prefix}%`]))?.n ?? 0);
    return {
      meter: { ...scoped, purge: (opts: Parameters<SqlSpendMeter['purge']>[0]) => meter.purge(opts) },
      rows: async () => ({ reservations: await count('agentos_spend_reservations', 'operation_id'), periods: await count('agentos_spend_meter', 'account_id') }),
      cleanup,
    };
  });

  it('gives exactly two of twenty concurrent reservations for one account inside one window', async () => {
    const prefix = prefixOf();
    const meter = new SqlSpendMeter({ db, allowanceFor: () => 2, windowMs: 3_600_000 });
    await meter.ensureSchema();
    const { cleanup } = prefixed(db, prefix, meter);
    try {
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => meter.reserve({ accountId: `${prefix}a`, operationId: `${prefix}op-${i}`, now: OCT })));
      expect(results.filter((r) => r.status === 'reserved')).toHaveLength(2);
      expect(results.filter((r) => r.status === 'denied' && r.reason === 'allowance_exhausted')).toHaveLength(18);
      expect(await meter.snapshot(`${prefix}a`, OCT)).toMatchObject({ period: 'window', allowance: 2, used: 0, reserved: 2, remaining: 0 });
      const rows = await db.all<{ n: string }>("SELECT count(*) AS n FROM agentos_spend_reservations WHERE operation_id LIKE ? AND state = 'reserved'", [`${prefix}%`]);
      expect(Number(rows[0].n)).toBe(2);
      // the account's row holds what its reservations hold: every refusal rolled its own units back
      const account = await db.get<{ reserved: string }>("SELECT reserved FROM agentos_spend_meter WHERE account_id = ? AND period = 'window'", [`${prefix}a`]);
      expect(Number(account?.reserved)).toBe(2);
    } finally {
      await cleanup();
    }
  });

  it('gives exactly five of twenty concurrent reservations against an allowance of five', async () => {
    const prefix = prefixOf();
    const meter = new SqlSpendMeter({ db, allowanceFor: () => 5, periodOf: monthOf });
    await meter.ensureSchema();
    const { cleanup } = prefixed(db, prefix, meter);
    try {
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => meter.reserve({ accountId: `${prefix}a`, operationId: `${prefix}op-${i}`, now: OCT })));
      expect(results.filter((r) => r.status === 'reserved')).toHaveLength(5);
      expect(results.filter((r) => r.status === 'denied' && r.reason === 'allowance_exhausted')).toHaveLength(15);
      expect(await meter.snapshot(`${prefix}a`, OCT)).toMatchObject({ allowance: 5, used: 0, reserved: 5, remaining: 0 });
      const rows = await db.all<{ n: string }>("SELECT count(*) AS n FROM agentos_spend_reservations WHERE operation_id LIKE ? AND state = 'reserved'", [`${prefix}%`]);
      expect(Number(rows[0].n)).toBe(5);
    } finally {
      await cleanup();
    }
  });

  it('makes one transition when a settle and a reconcile race on one operation', async () => {
    const prefix = prefixOf();
    const meter = new SqlSpendMeter({ db, allowanceFor: () => 3, periodOf: monthOf, leaseMs: 10 });
    await meter.ensureSchema();
    const { cleanup } = prefixed(db, prefix, meter);
    try {
      await meter.reserve({ accountId: `${prefix}a`, operationId: `${prefix}op`, now: OCT });
      const [settled] = await Promise.all([meter.settle({ operationId: `${prefix}op`, outcome: 'consumed', now: OCT + 50 }), meter.reconcile({ now: OCT + 50 })]);
      expect(['settled', 'already_settled']).toContain(settled.status);
      const snap = await meter.snapshot(`${prefix}a`, OCT);
      // consumed by the settle, or released by the reconciler: one of the two, never both, never neither
      expect(snap.reserved).toBe(0);
      expect([0, 1]).toContain(snap.used);
      const row = await db.get<{ state: string }>('SELECT state FROM agentos_spend_reservations WHERE operation_id = ?', [`${prefix}op`]);
      expect(snap.used === 1 ? 'consumed' : 'released').toBe(row?.state);
    } finally {
      await cleanup();
    }
  });
});
