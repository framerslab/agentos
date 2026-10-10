/**
 * @fileoverview The spend meter over Postgres, where several processes share it: the contract, the rolling window and
 * the purge, both again on tables under a second prefix, what a prefix names and refuses, two meters with different
 * rules on one database, twenty concurrent reservations against an allowance of five in a period and of two in a
 * window, and a settle racing a reconcile on one operation.
 *
 * Gated on `AGENTOS_TEST_POSTGRES_URL` (CI's service container); skipped without it. Each test meters accounts and
 * operations under a prefix of its own and deletes them after, so runs never collide.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { SPEND_METER_DDL, SqlSpendMeter, spendMeterDdl, type SqlSpendMeterOptions } from '../SqlSpendMeter.js';
import { OCT, monthOf, runSpendMeterContractSuite } from './SpendMeter.contract.js';
import { runSpendMeterWindowSuite } from './SqlSpendMeter.window.contract.js';

const POSTGRES_URL = process.env.AGENTOS_TEST_POSTGRES_URL;
const describeIfPostgres = POSTGRES_URL ? describe : describe.skip;

/** The second prefix both suites run under, on tables `spendMeterDdl` made. */
const ALT_PREFIX = 'alt_spend';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function openPostgres(): Promise<StorageAdapter> {
  const db = createPostgresAdapter({ connectionString: POSTGRES_URL!, max: 25 });
  await db.open();
  return db;
}

/** The two tables a prefix names; the default prefix's when it is left out. */
const tablesOf = (tablePrefix = 'agentos_spend') => ({ meter: `${tablePrefix}_meter`, reservations: `${tablePrefix}_reservations` });
type MeterTables = ReturnType<typeof tablesOf>;

/** A meter whose account and operation ids carry a prefix of their own; cleanup deletes every row under it from the meter's tables. */
function prefixed(db: StorageAdapter, prefix: string, meter: SqlSpendMeter, tables: MeterTables = tablesOf()) {
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
    await db.run(`DELETE FROM ${tables.reservations} WHERE operation_id LIKE ?`, [`${prefix}%`]);
    await db.run(`DELETE FROM ${tables.meter} WHERE account_id LIKE ?`, [`${prefix}%`]);
  };
  return { scoped, cleanup };
}

const prefixOf = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}-`;

/** Moves the rows of other runs out of a test's way: reconcile reads every expired row, purge every settled reservation and every idle account row of a window. */
async function clearTheWay(db: StorageAdapter, tables: MeterTables, prefix: string): Promise<void> {
  await db.run(`UPDATE ${tables.reservations} SET expires_at = 9007199254740991 WHERE state = 'reserved' AND operation_id NOT LIKE ?`, [`${prefix}%`]);
  await db.run(`UPDATE ${tables.reservations} SET settled_at = 9007199254740991 WHERE state <> 'reserved' AND operation_id NOT LIKE ?`, [`${prefix}%`]);
  await db.run(`UPDATE ${tables.meter} SET updated_at = 9007199254740991 WHERE period = 'window' AND account_id NOT LIKE ?`, [`${prefix}%`]);
}

/** The rows a prefix's two tables hold for one run's ids. */
async function rowsOf(db: StorageAdapter, tables: MeterTables, prefix: string): Promise<{ reservations: number; periods: number }> {
  const count = async (table: string, id: string) => Number((await db.get<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE ${id} LIKE ?`, [`${prefix}%`]))?.n ?? 0);
  return { reservations: await count(tables.reservations, 'operation_id'), periods: await count(tables.meter, 'account_id') };
}

/** What the database's catalogue holds for a prefix's two tables: the tables, and each index with its table and its columns in order. The primary keys are left out. */
async function catalogue(db: StorageAdapter, tables: MeterTables): Promise<{ tables: string[]; indexes: { name: string; table: string; columns: string[] }[] }> {
  const names = [tables.meter, tables.reservations];
  const found = await db.all<{ tablename: string }>('SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename IN (?, ?)', names);
  const indexes = await db.all<{ indexname: string; tablename: string; indexdef: string }>(
    "SELECT indexname, tablename, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename IN (?, ?) AND indexname NOT LIKE '%_pkey'",
    names,
  );
  const byName = <T>(key: (row: T) => string) => (x: T, y: T) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0);
  return {
    tables: found.map((r) => r.tablename).sort(),
    // pg_indexes writes each definition as `CREATE INDEX <name> ON <schema>.<table> USING btree (<columns>)`
    indexes: indexes
      .map((r) => ({ name: r.indexname, table: r.tablename, columns: (/\(([^()]*)\)$/.exec(r.indexdef)?.[1] ?? '').split(', ') }))
      .sort(byName((r) => r.name)),
  };
}

describeIfPostgres('SqlSpendMeter on Postgres', () => {
  let db: StorageAdapter;
  beforeAll(async () => {
    db = await openPostgres();
    // the second prefix's tables, made as a product's own migration makes them; the meters on them pass ensureSchema: false
    await db.exec(spendMeterDdl(ALT_PREFIX));
  });
  afterAll(async () => {
    await db?.close();
  });

  /**
   * Runs the contract and the window suite on the tables of a prefix: the meter's own when it is left out, else the
   * ones `spendMeterDdl` made, under meters that pass `ensureSchema: false`.
   */
  const runSuitesOnPostgres = (tablePrefix?: string): void => {
    const name = tablePrefix === undefined ? 'SqlSpendMeter on Postgres' : `SqlSpendMeter on Postgres, tables under ${tablePrefix}`;
    const tables = tablesOf(tablePrefix);
    const schema: Pick<SqlSpendMeterOptions, 'tablePrefix' | 'ensureSchema'> = tablePrefix === undefined ? {} : { tablePrefix, ensureSchema: false };

    runSpendMeterContractSuite(name, async ({ allowance, leaseMs, unknownAfterLease, resolveUnknown }) => {
      const prefix = prefixOf();
      const strip = (id: string) => (id.startsWith(prefix) ? id.slice(prefix.length) : id);
      const meter = new SqlSpendMeter({
        db,
        ...schema,
        allowanceFor: (accountId) => allowance.get(strip(accountId)) ?? 0,
        periodOf: (now) => monthOf(now),
        leaseMs,
        unknownAfterLease,
        resolveUnknown: resolveUnknown ? (r) => resolveUnknown({ operationId: strip(r.operationId) }) : undefined,
      });
      await meter.ensureSchema();
      await clearTheWay(db, tables, prefix);
      const { scoped, cleanup } = prefixed(db, prefix, meter, tables);
      return { meter: scoped, cleanup };
    });

    runSpendMeterWindowSuite(name, async ({ allowance, leaseMs, windowMs, periodOf }) => {
      const prefix = prefixOf();
      const strip = (id: string) => (id.startsWith(prefix) ? id.slice(prefix.length) : id);
      const meter = new SqlSpendMeter({ db, ...schema, allowanceFor: (accountId) => allowance.get(strip(accountId)) ?? 0, windowMs, periodOf, leaseMs });
      await meter.ensureSchema();
      await clearTheWay(db, tables, prefix);
      const { scoped, cleanup } = prefixed(db, prefix, meter, tables);
      return {
        meter: { ...scoped, purge: (opts: Parameters<SqlSpendMeter['purge']>[0]) => meter.purge(opts) },
        rows: () => rowsOf(db, tables, prefix),
        cleanup,
      };
    });
  };

  runSuitesOnPostgres();
  runSuitesOnPostgres(ALT_PREFIX);

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

  describe('tables named by a prefix', () => {
    it("answers SPEND_METER_DDL word for word under the default prefix, named or left out, and a meter finds its tables and its three indexes, the purge's among them, under those names", async () => {
      expect(spendMeterDdl()).toBe(SPEND_METER_DDL);
      expect(spendMeterDdl('agentos_spend')).toBe(SPEND_METER_DDL);
      await new SqlSpendMeter({ db, allowanceFor: () => 1, periodOf: monthOf }).ensureSchema();
      expect(await catalogue(db, tablesOf())).toEqual({
        tables: ['agentos_spend_meter', 'agentos_spend_reservations'],
        indexes: [
          { name: 'idx_spend_reservations_account', table: 'agentos_spend_reservations', columns: ['account_id', 'reserved_at'] },
          { name: 'idx_spend_reservations_due', table: 'agentos_spend_reservations', columns: ['state', 'expires_at'] },
          { name: 'idx_spend_reservations_settled', table: 'agentos_spend_reservations', columns: ['settled_at', 'state'] },
        ],
      });
    });

    it("names both tables and every index from another prefix, nothing of the default's, and the database holds them under those names", async () => {
      const ddl = spendMeterDdl(ALT_PREFIX);
      expect(ddl).not.toMatch(/agentos_spend|idx_spend_/);
      await db.exec(ddl);
      expect(await catalogue(db, tablesOf(ALT_PREFIX))).toEqual({
        tables: ['alt_spend_meter', 'alt_spend_reservations'],
        indexes: [
          { name: 'idx_alt_spend_reservations_account', table: 'alt_spend_reservations', columns: ['account_id', 'reserved_at'] },
          { name: 'idx_alt_spend_reservations_due', table: 'alt_spend_reservations', columns: ['state', 'expires_at'] },
          { name: 'idx_alt_spend_reservations_settled', table: 'alt_spend_reservations', columns: ['settled_at', 'state'] },
        ],
      });
    });

    it("keeps two meters with different rules apart on one database: each counts its own units, and one's purge leaves the other's rows", async () => {
      const prefix = prefixOf();
      const id = (s: string) => `${prefix}${s}`;
      // one unit an hour under the default prefix, one unit a day under another, for the same account
      const hourly = new SqlSpendMeter({ db, allowanceFor: () => 1, windowMs: HOUR });
      const daily = new SqlSpendMeter({ db, tablePrefix: ALT_PREFIX, ensureSchema: false, allowanceFor: () => 1, windowMs: DAY });
      await hourly.ensureSchema();
      await clearTheWay(db, tablesOf(), prefix);
      await clearTheWay(db, tablesOf(ALT_PREFIX), prefix);
      try {
        expect(await hourly.reserve({ accountId: id('a'), operationId: id('hour-1'), now: OCT })).toMatchObject({ status: 'reserved', remaining: 0 });
        expect(await daily.reserve({ accountId: id('a'), operationId: id('day-1'), now: OCT })).toMatchObject({ status: 'reserved', remaining: 0 });
        expect(await hourly.settle({ operationId: id('hour-1'), outcome: 'consumed', now: OCT })).toEqual({ status: 'settled', state: 'consumed' });
        expect(await daily.settle({ operationId: id('day-1'), outcome: 'consumed', now: OCT })).toEqual({ status: 'settled', state: 'consumed' });
        // the hourly meter's purge of what settled before 13:00 takes its own reservation and its idle account row
        expect(await hourly.purge({ before: OCT + HOUR })).toEqual({ reservations: 1, periods: 1 });
        expect(await rowsOf(db, tablesOf(), prefix)).toEqual({ reservations: 0, periods: 0 });
        // the daily meter's rows stay: its unit still counts, and its operation still answers as counted
        expect(await rowsOf(db, tablesOf(ALT_PREFIX), prefix)).toEqual({ reservations: 1, periods: 1 });
        expect(await daily.snapshot(id('a'), OCT + HOUR)).toEqual({ accountId: id('a'), period: 'window', allowance: 1, used: 1, reserved: 0, remaining: 0 });
        expect(await daily.reserve({ accountId: id('a'), operationId: id('day-1'), now: OCT + HOUR })).toMatchObject({ status: 'denied', reason: 'already_consumed' });
      } finally {
        await prefixed(db, prefix, hourly).cleanup();
        await prefixed(db, prefix, daily, tablesOf(ALT_PREFIX)).cleanup();
      }
    });

    it('refuses a prefix that is not a lower-case name, or is spend, at construction and in spendMeterDdl', () => {
      for (const tablePrefix of ['Bad-prefix', 'x; drop table y', '', '9lives', `a${'b'.repeat(40)}`, 'spend']) {
        expect(() => new SqlSpendMeter({ db, tablePrefix, allowanceFor: () => 1, periodOf: monthOf }), tablePrefix).toThrow(/tablePrefix/);
        expect(() => spendMeterDdl(tablePrefix), tablePrefix).toThrow(/tablePrefix/);
      }
      // the longest it takes: a letter and 39 more
      const longest = `a${'b'.repeat(39)}`;
      expect(() => new SqlSpendMeter({ db, tablePrefix: longest, allowanceFor: () => 1, periodOf: monthOf })).not.toThrow();
      expect(spendMeterDdl(longest)).toContain(`CREATE TABLE IF NOT EXISTS ${longest}_meter (`);
    });
  });
});
