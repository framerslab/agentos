/**
 * @fileoverview The spend meter over Postgres, where several processes share it: the contract, the rolling window and
 * the purge, on tables its meters make and again on tables a migration made, what a prefix names and refuses, two
 * meters with different rules on one database, twenty concurrent reservations against an allowance of five in a period
 * and of two in a window, a settle racing a reconcile on one operation, the indexes a store an earlier release made
 * gains and the statements a meter's start runs for them, and tables the meter's role does not own, used as they are
 * with each index Postgres refuses reported.
 *
 * Gated on `AGENTOS_TEST_POSTGRES_URL` (CI's service container); skipped without it. A reconcile or a purge reaches
 * every row of its meter's tables, so every test that runs one does so on tables named by a prefix of this run's own,
 * dropped after it. The other tests meter accounts and operations under a prefix of their own and delete them after,
 * or make tables of their own and drop them after, so runs that share a database never reach each other's rows. The
 * test of a role that does not own the tables creates that role, so the URL's user needs the right to create roles, as
 * CI's superuser has.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { SPEND_METER_DDL, SqlSpendMeter, spendMeterDdl, type SqlSpendMeterOptions } from '../SqlSpendMeter.js';
import { OCT, monthOf, runSpendMeterContractSuite } from './SpendMeter.contract.js';
import { runSpendMeterWindowSuite } from './SqlSpendMeter.window.contract.js';

const POSTGRES_URL = process.env.AGENTOS_TEST_POSTGRES_URL;
const describeIfPostgres = POSTGRES_URL ? describe : describe.skip;

/** This run's own mark, in the names of the tables and the role its tests make and drop. */
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
/** The prefix of this run's tables that its meters make themselves; both suites run on them, and they go with the run. */
const OWN_PREFIX = `own_${RUN}`;
/**
 * The prefix of this run's tables that `spendMeterDdl` makes, as a product's own migration does; both suites run on
 * them again, under meters that pass `ensureSchema: false`, and they go with the run.
 */
const ALT_PREFIX = `alt_${RUN}`;
/** The prefix of the tables the tests of an earlier release's store make afresh from its DDL, and drop after. */
const OLDER_PREFIX = `older_${RUN}`;
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

/** Drops the two tables of each prefix, the reservations first. */
const dropTables = (db: StorageAdapter, ...tablePrefixes: string[]): Promise<void> =>
  db.exec(tablePrefixes.map((p) => `DROP TABLE IF EXISTS ${tablesOf(p).reservations}; DROP TABLE IF EXISTS ${tablesOf(p).meter};`).join('\n'));

/** The adapter with the text of every statement it is given written to `statements`, in order, before the store runs it. */
function recording(db: StorageAdapter, statements: string[]): StorageAdapter {
  const record =
    <A extends unknown[], R>(fn: (statement: string, ...rest: A) => R) =>
    (statement: string, ...rest: A): R => {
      statements.push(statement);
      return fn(statement, ...rest);
    };
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'exec') return record(target.exec.bind(target));
      if (prop === 'run') return record(target.run.bind(target));
      if (prop === 'get') return record(target.get.bind(target));
      if (prop === 'all') return record(target.all.bind(target));
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** A statement that makes an index. */
const createsIndex = (statement: string): boolean => /CREATE INDEX/i.test(statement);

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

/**
 * The DDL a store an earlier release made holds: the two tables and the reconciler's index, without the window's
 * account index and the purge's settled index that came after it.
 */
const olderDdl = (tablePrefix?: string): string =>
  spendMeterDdl(tablePrefix)
    .split('\n')
    .filter((line) => !/_reservations_(account|settled) ON /.test(line))
    .join('\n');

describeIfPostgres('SqlSpendMeter on Postgres', () => {
  let db: StorageAdapter;
  beforeAll(async () => {
    db = await openPostgres();
    // this run's tables under its second prefix, made as a product's own migration makes them; the meters on them pass
    // ensureSchema: false
    await db.exec(spendMeterDdl(ALT_PREFIX));
  });
  afterAll(async () => {
    if (db) await dropTables(db, OWN_PREFIX, ALT_PREFIX);
    await db?.close();
  });

  /**
   * Runs the contract and the window suite on this run's tables under a prefix: the ones its meters make, or, under
   * meters that pass `ensureSchema: false`, the ones `spendMeterDdl` made. No other run reaches those tables, so a
   * reconcile or a purge there reads only this run's rows.
   */
  const runSuitesOnPostgres = (made: string, tablePrefix: string, schema: Pick<SqlSpendMeterOptions, 'ensureSchema'>): void => {
    const name = `SqlSpendMeter on Postgres, ${made}`;
    const tables = tablesOf(tablePrefix);

    runSpendMeterContractSuite(name, async ({ allowance, leaseMs, unknownAfterLease, resolveUnknown }) => {
      const prefix = prefixOf();
      const strip = (id: string) => (id.startsWith(prefix) ? id.slice(prefix.length) : id);
      const meter = new SqlSpendMeter({
        db,
        tablePrefix,
        ...schema,
        allowanceFor: (accountId) => allowance.get(strip(accountId)) ?? 0,
        periodOf: (now) => monthOf(now),
        leaseMs,
        unknownAfterLease,
        resolveUnknown: resolveUnknown ? (r) => resolveUnknown({ operationId: strip(r.operationId) }) : undefined,
      });
      await meter.ensureSchema();
      const { scoped, cleanup } = prefixed(db, prefix, meter, tables);
      return { meter: scoped, cleanup };
    });

    runSpendMeterWindowSuite(name, async ({ allowance, leaseMs, windowMs, periodOf }) => {
      const prefix = prefixOf();
      const strip = (id: string) => (id.startsWith(prefix) ? id.slice(prefix.length) : id);
      const meter = new SqlSpendMeter({ db, tablePrefix, ...schema, allowanceFor: (accountId) => allowance.get(strip(accountId)) ?? 0, windowMs, periodOf, leaseMs });
      await meter.ensureSchema();
      const { scoped, cleanup } = prefixed(db, prefix, meter, tables);
      return {
        meter: { ...scoped, purge: (opts: Parameters<SqlSpendMeter['purge']>[0]) => meter.purge(opts) },
        rows: () => rowsOf(db, tables, prefix),
        cleanup,
      };
    });
  };

  runSuitesOnPostgres('tables its meters make', OWN_PREFIX, {});
  runSuitesOnPostgres('tables a migration made', ALT_PREFIX, { ensureSchema: false });

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
    // the reconcile settles every expired reservation of its tables, so it runs on this run's own
    const own = tablesOf(OWN_PREFIX);
    const meter = new SqlSpendMeter({ db, tablePrefix: OWN_PREFIX, allowanceFor: () => 3, periodOf: monthOf, leaseMs: 10 });
    await meter.ensureSchema();
    const { cleanup } = prefixed(db, prefix, meter, own);
    try {
      await meter.reserve({ accountId: `${prefix}a`, operationId: `${prefix}op`, now: OCT });
      const [settled] = await Promise.all([meter.settle({ operationId: `${prefix}op`, outcome: 'consumed', now: OCT + 50 }), meter.reconcile({ now: OCT + 50 })]);
      expect(['settled', 'already_settled']).toContain(settled.status);
      const snap = await meter.snapshot(`${prefix}a`, OCT);
      // consumed by the settle, or released by the reconciler: one of the two, never both, never neither
      expect(snap.reserved).toBe(0);
      expect([0, 1]).toContain(snap.used);
      const row = await db.get<{ state: string }>(`SELECT state FROM ${own.reservations} WHERE operation_id = ?`, [`${prefix}op`]);
      expect(snap.used === 1 ? 'consumed' : 'released').toBe(row?.state);
    } finally {
      await cleanup();
    }
  });

  it('gives a store an earlier release made the indexes it lacks once a meter ensures the schema, keeping its rows, and adds nothing with ensureSchema: false', async () => {
    // tables of this test's own, made afresh from the DDL an earlier release ran
    const older = tablesOf(OLDER_PREFIX);
    const drop = () => db.exec(`DROP TABLE IF EXISTS ${older.reservations}; DROP TABLE IF EXISTS ${older.meter};`);
    await drop();
    try {
      await db.exec(olderDdl(OLDER_PREFIX));
      const due = { name: `idx_${OLDER_PREFIX}_reservations_due`, table: older.reservations, columns: ['state', 'expires_at'] };
      expect((await catalogue(db, older)).indexes).toEqual([due]);
      // a meter whose product runs its own migrations adds nothing, and counts on the tables as they are
      const migrated = new SqlSpendMeter({ db, tablePrefix: OLDER_PREFIX, ensureSchema: false, allowanceFor: () => 2, windowMs: HOUR });
      expect(await migrated.reserve({ accountId: 'a', operationId: 'before', now: OCT })).toMatchObject({ status: 'reserved', remaining: 1 });
      expect((await catalogue(db, older)).indexes).toEqual([due]);
      // a meter that ensures the schema adds the two indexes, and the unit reserved before it still counts
      const meter = new SqlSpendMeter({ db, tablePrefix: OLDER_PREFIX, allowanceFor: () => 2, windowMs: HOUR });
      await meter.ensureSchema();
      expect((await catalogue(db, older)).indexes).toEqual([
        { name: `idx_${OLDER_PREFIX}_reservations_account`, table: older.reservations, columns: ['account_id', 'reserved_at'] },
        due,
        { name: `idx_${OLDER_PREFIX}_reservations_settled`, table: older.reservations, columns: ['settled_at', 'state'] },
      ]);
      expect(await meter.snapshot('a', OCT)).toMatchObject({ used: 0, reserved: 1, remaining: 1 });
    } finally {
      await drop();
    }
  });

  it("runs at a meter's start the statements of the indexes its tables lack and of no other, so a meter on tables that hold all three runs no CREATE INDEX", async () => {
    const older = tablesOf(OLDER_PREFIX);
    const drop = () => db.exec(`DROP TABLE IF EXISTS ${older.reservations}; DROP TABLE IF EXISTS ${older.meter};`);
    await drop();
    try {
      await db.exec(olderDdl(OLDER_PREFIX));
      // the tables hold the reconciler's index: the first start makes the window's and the purge's
      const first: string[] = [];
      await new SqlSpendMeter({ db: recording(db, first), tablePrefix: OLDER_PREFIX, allowanceFor: () => 1, windowMs: HOUR }).ensureSchema();
      expect(first.filter(createsIndex)).toEqual([
        expect.stringContaining(`idx_${OLDER_PREFIX}_reservations_account ON`),
        expect.stringContaining(`idx_${OLDER_PREFIX}_reservations_settled ON`),
      ]);
      // a second start finds all three and runs none: a CREATE INDEX takes a SHARE lock on the table, which holds back
      // its writes, before it looks for the index's name
      const second: string[] = [];
      await new SqlSpendMeter({ db: recording(db, second), tablePrefix: OLDER_PREFIX, allowanceFor: () => 1, windowMs: HOUR }).ensureSchema();
      expect(second).not.toEqual([]);
      expect(second.filter(createsIndex)).toEqual([]);
    } finally {
      await drop();
    }
  });

  it('uses tables its role does not own as they are: Postgres refuses it the indexes they lack, the meter reports each refusal to onWarning, and still counts on them', async () => {
    // tables the database's owner makes from the DDL an earlier release ran, and a role that reads and writes them but owns neither
    const older = tablesOf(OLDER_PREFIX);
    const role = `spend_writer_${RUN}`;
    const password = `p${Math.random().toString(36).slice(2)}`;
    // the tables go first, and their grants with them, so the role is referenced nowhere when it is dropped
    const drop = async () => {
      await db.exec(`DROP TABLE IF EXISTS ${older.reservations}; DROP TABLE IF EXISTS ${older.meter};`);
      await db.exec(`DROP ROLE IF EXISTS ${role}`);
    };
    await drop();
    let writer: StorageAdapter | undefined;
    try {
      await db.exec(olderDdl(OLDER_PREFIX));
      await db.exec(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'; GRANT SELECT, INSERT, UPDATE, DELETE ON ${older.meter}, ${older.reservations} TO ${role};`);
      const url = new URL(POSTGRES_URL!);
      url.username = role;
      url.password = password;
      writer = createPostgresAdapter({ connectionString: url.toString(), max: 2 });
      await writer.open();
      const warnings: { statement: string; error: unknown }[] = [];
      const meter = new SqlSpendMeter({ db: writer, tablePrefix: OLDER_PREFIX, allowanceFor: () => 1, windowMs: HOUR, onWarning: (warning) => warnings.push(warning) });
      await expect(meter.ensureSchema()).resolves.toBeUndefined();
      // each index the tables lack is refused, 42501 being insufficient_privilege; the one they hold is not tried
      expect(warnings).toEqual([
        { statement: expect.stringContaining(`idx_${OLDER_PREFIX}_reservations_account ON`), error: expect.objectContaining({ code: '42501' }) },
        { statement: expect.stringContaining(`idx_${OLDER_PREFIX}_reservations_settled ON`), error: expect.objectContaining({ code: '42501' }) },
      ]);
      expect(await meter.reserve({ accountId: 'a', operationId: 'op', now: OCT })).toMatchObject({ status: 'reserved', remaining: 0 });
      expect((await catalogue(db, older)).indexes.map((index) => index.name)).toEqual([`idx_${OLDER_PREFIX}_reservations_due`]);
    } finally {
      await writer?.close();
      await drop();
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
      const alt = tablesOf(ALT_PREFIX);
      expect(await catalogue(db, alt)).toEqual({
        tables: [alt.meter, alt.reservations],
        indexes: [
          { name: `idx_${ALT_PREFIX}_reservations_account`, table: alt.reservations, columns: ['account_id', 'reserved_at'] },
          { name: `idx_${ALT_PREFIX}_reservations_due`, table: alt.reservations, columns: ['state', 'expires_at'] },
          { name: `idx_${ALT_PREFIX}_reservations_settled`, table: alt.reservations, columns: ['settled_at', 'state'] },
        ],
      });
    });

    it("keeps two meters with different rules apart on one database: each counts its own units, and one's purge leaves the other's rows", async () => {
      const prefix = prefixOf();
      const id = (s: string) => `${prefix}${s}`;
      // one unit an hour under this run's first prefix, one unit a day under its second, for the same account; a
      // purge reaches every row of its meter's tables, so both are this run's own
      const hourly = new SqlSpendMeter({ db, tablePrefix: OWN_PREFIX, allowanceFor: () => 1, windowMs: HOUR });
      const daily = new SqlSpendMeter({ db, tablePrefix: ALT_PREFIX, ensureSchema: false, allowanceFor: () => 1, windowMs: DAY });
      await hourly.ensureSchema();
      try {
        expect(await hourly.reserve({ accountId: id('a'), operationId: id('hour-1'), now: OCT })).toMatchObject({ status: 'reserved', remaining: 0 });
        expect(await daily.reserve({ accountId: id('a'), operationId: id('day-1'), now: OCT })).toMatchObject({ status: 'reserved', remaining: 0 });
        expect(await hourly.settle({ operationId: id('hour-1'), outcome: 'consumed', now: OCT })).toEqual({ status: 'settled', state: 'consumed' });
        expect(await daily.settle({ operationId: id('day-1'), outcome: 'consumed', now: OCT })).toEqual({ status: 'settled', state: 'consumed' });
        // the hourly meter's purge of what settled before 13:00 takes its own reservation and its idle account row
        expect(await hourly.purge({ before: OCT + HOUR })).toEqual({ reservations: 1, periods: 1 });
        expect(await rowsOf(db, tablesOf(OWN_PREFIX), prefix)).toEqual({ reservations: 0, periods: 0 });
        // the daily meter's rows stay: its unit still counts, and its operation still answers as counted
        expect(await rowsOf(db, tablesOf(ALT_PREFIX), prefix)).toEqual({ reservations: 1, periods: 1 });
        expect(await daily.snapshot(id('a'), OCT + HOUR)).toEqual({ accountId: id('a'), period: 'window', allowance: 1, used: 1, reserved: 0, remaining: 0 });
        expect(await daily.reserve({ accountId: id('a'), operationId: id('day-1'), now: OCT + HOUR })).toMatchObject({ status: 'denied', reason: 'already_consumed' });
      } finally {
        await prefixed(db, prefix, hourly, tablesOf(OWN_PREFIX)).cleanup();
        await prefixed(db, prefix, daily, tablesOf(ALT_PREFIX)).cleanup();
      }
    });

    it('takes a prefix of 38 characters, whose longest names fill the 63 bytes of a Postgres identifier and reach the catalogue whole, and refuses one of 39, one that is not a lower-case name, and spend', async () => {
      // a letter and 37 more, this run's mark among them
      const longest = `l${RUN}`.padEnd(38, 'x');
      expect(longest).toHaveLength(38);
      for (const tablePrefix of ['Bad-prefix', 'x; drop table y', '', '9lives', `${longest}x`, 'spend']) {
        expect(() => new SqlSpendMeter({ db, tablePrefix, allowanceFor: () => 1, periodOf: monthOf }), tablePrefix).toThrow(/tablePrefix/);
        expect(() => spendMeterDdl(tablePrefix), tablePrefix).toThrow(/tablePrefix/);
      }
      expect(() => new SqlSpendMeter({ db, tablePrefix: longest, allowanceFor: () => 1, periodOf: monthOf })).not.toThrow();
      // every name the DDL gives, tables and indexes; the names are ASCII, so a character is a byte
      const ddl = spendMeterDdl(longest);
      const names = [...ddl.matchAll(/CREATE (?:TABLE|INDEX) IF NOT EXISTS (\w+)/g)].map((match) => match[1]);
      expect(names).toHaveLength(5);
      expect(Math.max(...names.map((name) => name.length))).toBe(63);
      // Postgres cuts a longer identifier to 63 bytes, so the catalogue holding each name whole shows that none passes the limit
      const tables = tablesOf(longest);
      try {
        await db.exec(ddl);
        const held = await catalogue(db, tables);
        expect([...held.tables, ...held.indexes.map((index) => index.name)].sort()).toEqual([...names].sort());
      } finally {
        await dropTables(db, longest);
      }
    });
  });
});
