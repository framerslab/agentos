/**
 * @fileoverview The spend meter's contract over an in-memory SQLite store, its rolling window and its purge there,
 * both again on tables under a second prefix, what a prefix names and refuses, two meters with different rules on one
 * store, the indexes a store an earlier release made gains and the statements a meter's start runs for them, an index
 * the store refuses reported, and the rollback of a refused reservation when a later statement of its transaction
 * fails.
 */
import { describe, expect, it } from 'vitest';
import { resolveStorageAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { SpendMeterUnavailableError, withBoundedRetry, isTransientStorageError } from '../SpendMeter.js';
import { SPEND_METER_DDL, SqlSpendMeter, spendMeterDdl, type SqlSpendMeterOptions } from '../SqlSpendMeter.js';
import { OCT, monthOf, runSpendMeterContractSuite } from './SpendMeter.contract.js';
import { runSpendMeterWindowSuite } from './SqlSpendMeter.window.contract.js';

const openSqlite = () => resolveStorageAdapter({ filePath: ':memory:', priority: ['better-sqlite3', 'sqljs'], quiet: true });

/** The second prefix both suites run under, on tables `spendMeterDdl` made. */
const ALT_PREFIX = 'alt_spend';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The rows a store holds in two tables of one prefix. */
async function rowsUnder(db: StorageAdapter, tablePrefix: string): Promise<{ reservations: number; periods: number }> {
  const count = async (table: string) => Number((await db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))?.n ?? 0);
  return { reservations: await count(`${tablePrefix}_reservations`), periods: await count(`${tablePrefix}_meter`) };
}

/** What the store's catalogue holds: its tables, and each index with its table and its columns in order. SQLite's own indexes are left out. */
async function catalogue(db: StorageAdapter): Promise<{ tables: string[]; indexes: { name: string; table: string; columns: string[] }[] }> {
  const rows = await db.all<{ type: string; name: string; tbl_name: string }>(
    "SELECT type, name, tbl_name FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const indexes: { name: string; table: string; columns: string[] }[] = [];
  for (const row of rows.filter((r) => r.type === 'index')) {
    const columns = await db.all<{ name: string }>(`SELECT name FROM pragma_index_info('${row.name}') ORDER BY seqno`);
    indexes.push({ name: row.name, table: row.tbl_name, columns: columns.map((c) => c.name) });
  }
  return { tables: rows.filter((r) => r.type === 'table').map((r) => r.name), indexes };
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

/**
 * Runs the contract and the window suite on SQLite stores of their own. Without a prefix each meter makes its tables
 * itself. With one, each store holds only the tables `spendMeterDdl(tablePrefix)` made and its meter passes
 * `ensureSchema: false`, so a statement that left the prefix out finds no table and fails.
 */
function runSuitesOnSqlite(tablePrefix?: string): void {
  const name = tablePrefix === undefined ? 'SqlSpendMeter on SQLite' : `SqlSpendMeter on SQLite, tables under ${tablePrefix}`;
  const schema: Pick<SqlSpendMeterOptions, 'tablePrefix' | 'ensureSchema'> = tablePrefix === undefined ? {} : { tablePrefix, ensureSchema: false };
  const openStore = async (): Promise<StorageAdapter> => {
    const db = await openSqlite();
    if (tablePrefix !== undefined) await db.exec(spendMeterDdl(tablePrefix));
    return db;
  };

  runSpendMeterContractSuite(name, async ({ allowance, leaseMs, unknownAfterLease, resolveUnknown }) => {
    const db = await openStore();
    const meter = new SqlSpendMeter({
      db,
      ...schema,
      allowanceFor: (accountId) => allowance.get(accountId) ?? 0,
      periodOf: (now) => monthOf(now),
      leaseMs,
      unknownAfterLease,
      resolveUnknown,
      requireShared: false,
    });
    return { meter, cleanup: () => db.close() };
  });

  runSpendMeterWindowSuite(name, async ({ allowance, leaseMs, windowMs, periodOf }) => {
    const db = await openStore();
    try {
      const meter = new SqlSpendMeter({ db, ...schema, allowanceFor: (accountId) => allowance.get(accountId) ?? 0, windowMs, periodOf, leaseMs, requireShared: false });
      // the store is this harness's alone, so every row in it is one of its accounts'
      return { meter, rows: () => rowsUnder(db, tablePrefix ?? 'agentos_spend'), cleanup: () => db.close() };
    } catch (e) {
      // a meter the constructor refused leaves no harness to clean up after
      await db.close();
      throw e;
    }
  });
}

runSuitesOnSqlite();
runSuitesOnSqlite(ALT_PREFIX);

describe('SqlSpendMeter on SQLite, tables named by a prefix', () => {
  it("answers SPEND_METER_DDL word for word under the default prefix, named or left out, and a meter makes its tables and its three indexes, the purge's among them, under those names", async () => {
    expect(spendMeterDdl()).toBe(SPEND_METER_DDL);
    expect(spendMeterDdl('agentos_spend')).toBe(SPEND_METER_DDL);
    const db = await openSqlite();
    try {
      await new SqlSpendMeter({ db, allowanceFor: () => 1, periodOf: monthOf, requireShared: false }).ensureSchema();
      expect(await catalogue(db)).toEqual({
        tables: ['agentos_spend_meter', 'agentos_spend_reservations'],
        indexes: [
          { name: 'idx_spend_reservations_account', table: 'agentos_spend_reservations', columns: ['account_id', 'reserved_at'] },
          { name: 'idx_spend_reservations_due', table: 'agentos_spend_reservations', columns: ['state', 'expires_at'] },
          { name: 'idx_spend_reservations_settled', table: 'agentos_spend_reservations', columns: ['settled_at', 'state'] },
        ],
      });
    } finally {
      await db.close();
    }
  });

  it("names both tables and every index from another prefix, nothing of the default's, and the store holds them under those names", async () => {
    const ddl = spendMeterDdl(ALT_PREFIX);
    expect(ddl).not.toMatch(/agentos_spend|idx_spend_/);
    const db = await openSqlite();
    try {
      await db.exec(ddl);
      expect(await catalogue(db)).toEqual({
        tables: ['alt_spend_meter', 'alt_spend_reservations'],
        indexes: [
          { name: 'idx_alt_spend_reservations_account', table: 'alt_spend_reservations', columns: ['account_id', 'reserved_at'] },
          { name: 'idx_alt_spend_reservations_due', table: 'alt_spend_reservations', columns: ['state', 'expires_at'] },
          { name: 'idx_alt_spend_reservations_settled', table: 'alt_spend_reservations', columns: ['settled_at', 'state'] },
        ],
      });
    } finally {
      await db.close();
    }
  });

  it("keeps two meters with different rules apart on one store: each counts its own units, and one's purge leaves the other's rows", async () => {
    const db = await openSqlite();
    try {
      // one unit an hour under the default prefix, one unit a day under another, for the same account
      const hourly = new SqlSpendMeter({ db, allowanceFor: () => 1, windowMs: HOUR, requireShared: false });
      const daily = new SqlSpendMeter({ db, tablePrefix: ALT_PREFIX, allowanceFor: () => 1, windowMs: DAY, requireShared: false });
      expect(await hourly.reserve({ accountId: 'a', operationId: 'hour-1', now: OCT })).toMatchObject({ status: 'reserved', remaining: 0 });
      expect(await daily.reserve({ accountId: 'a', operationId: 'day-1', now: OCT })).toMatchObject({ status: 'reserved', remaining: 0 });
      expect(await hourly.settle({ operationId: 'hour-1', outcome: 'consumed', now: OCT })).toEqual({ status: 'settled', state: 'consumed' });
      expect(await daily.settle({ operationId: 'day-1', outcome: 'consumed', now: OCT })).toEqual({ status: 'settled', state: 'consumed' });
      // the hourly meter's purge of what settled before 13:00 takes its own reservation and its idle account row
      expect(await hourly.purge({ before: OCT + HOUR })).toEqual({ reservations: 1, periods: 1 });
      expect(await rowsUnder(db, 'agentos_spend')).toEqual({ reservations: 0, periods: 0 });
      // the daily meter's rows stay: its unit still counts, and its operation still answers as counted
      expect(await rowsUnder(db, ALT_PREFIX)).toEqual({ reservations: 1, periods: 1 });
      expect(await daily.snapshot('a', OCT + HOUR)).toEqual({ accountId: 'a', period: 'window', allowance: 1, used: 1, reserved: 0, remaining: 0 });
      expect(await daily.reserve({ accountId: 'a', operationId: 'day-1', now: OCT + HOUR })).toMatchObject({ status: 'denied', reason: 'already_consumed' });
    } finally {
      await db.close();
    }
  });

  it('takes a prefix of 38 characters, and refuses one of 39, one that is not a lower-case name, and spend, at construction and in spendMeterDdl', async () => {
    const db = await openSqlite();
    try {
      // the longest it takes: a letter and 37 more, whose longest names fill the 63 bytes of a Postgres identifier
      const longest = `a${'b'.repeat(37)}`;
      for (const tablePrefix of ['Bad-prefix', 'x; drop table y', '', '9lives', `${longest}b`, 'spend']) {
        expect(() => new SqlSpendMeter({ db, tablePrefix, allowanceFor: () => 1, periodOf: monthOf, requireShared: false }), tablePrefix).toThrow(/tablePrefix/);
        expect(() => spendMeterDdl(tablePrefix), tablePrefix).toThrow(/tablePrefix/);
      }
      expect(() => new SqlSpendMeter({ db, tablePrefix: longest, allowanceFor: () => 1, periodOf: monthOf, requireShared: false })).not.toThrow();
      expect(spendMeterDdl(longest)).toContain(`CREATE INDEX IF NOT EXISTS idx_${longest}_reservations_account ON ${longest}_reservations (`);
    } finally {
      await db.close();
    }
  });
});

/** The adapter with one statement made to fail: the transaction view throws on the first statement that matches. */
function failingOn(db: StorageAdapter, pattern: RegExp): StorageAdapter {
  const wrap = (inner: StorageAdapter): StorageAdapter =>
    new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'run') {
          return async (statement: string, params?: unknown) => {
            if (pattern.test(statement)) throw Object.assign(new Error('injected failure'), { code: 'XX000' });
            return target.run(statement, params as never);
          };
        }
        if (prop === 'transaction') return (fn: (trx: StorageAdapter) => Promise<unknown>) => target.transaction((trx) => fn(wrap(trx)));
        return Reflect.get(target, prop, receiver);
      },
    });
  return wrap(db);
}

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

describe('SqlSpendMeter on SQLite, beyond the contract', () => {
  it('rolls the reservation row back when taking the units fails, and reports the store as unavailable', async () => {
    const db = await openSqlite();
    try {
      const healthy = new SqlSpendMeter({ db, allowanceFor: () => 5, periodOf: monthOf, requireShared: false });
      await healthy.ensureSchema();
      const broken = new SqlSpendMeter({ db: failingOn(db, /SET reserved = reserved \+/), allowanceFor: () => 5, periodOf: monthOf, requireShared: false });
      await expect(broken.reserve({ accountId: 'a', operationId: 'op', now: OCT })).rejects.toBeInstanceOf(SpendMeterUnavailableError);
      expect(await db.get('SELECT operation_id FROM agentos_spend_reservations WHERE operation_id = ?', ['op'])).toBeNull();
      // the same operation reserves cleanly once the store answers
      expect(await healthy.reserve({ accountId: 'a', operationId: 'op', now: OCT })).toMatchObject({ status: 'reserved', attempt: 1 });
    } finally {
      await db.close();
    }
  });

  it('gives a store an earlier release made the indexes it lacks once a meter ensures the schema, keeping its rows, and adds nothing with ensureSchema: false', async () => {
    const db = await openSqlite();
    try {
      await db.exec(olderDdl());
      const due = { name: 'idx_spend_reservations_due', table: 'agentos_spend_reservations', columns: ['state', 'expires_at'] };
      expect((await catalogue(db)).indexes).toEqual([due]);
      // a meter whose product runs its own migrations adds nothing, and counts on the tables as they are
      const migrated = new SqlSpendMeter({ db, ensureSchema: false, allowanceFor: () => 2, windowMs: HOUR, requireShared: false });
      expect(await migrated.reserve({ accountId: 'a', operationId: 'before', now: OCT })).toMatchObject({ status: 'reserved', remaining: 1 });
      expect((await catalogue(db)).indexes).toEqual([due]);
      // a meter that ensures the schema adds the two indexes, and the unit reserved before it still counts
      const meter = new SqlSpendMeter({ db, allowanceFor: () => 2, windowMs: HOUR, requireShared: false });
      await meter.ensureSchema();
      expect((await catalogue(db)).indexes).toEqual([
        { name: 'idx_spend_reservations_account', table: 'agentos_spend_reservations', columns: ['account_id', 'reserved_at'] },
        due,
        { name: 'idx_spend_reservations_settled', table: 'agentos_spend_reservations', columns: ['settled_at', 'state'] },
      ]);
      expect(await meter.snapshot('a', OCT)).toMatchObject({ used: 0, reserved: 1, remaining: 1 });
    } finally {
      await db.close();
    }
  });

  it("runs at a meter's start the statements of the indexes its tables lack and of no other, so a meter on tables that hold all three runs no CREATE INDEX", async () => {
    const db = await openSqlite();
    try {
      await db.exec(olderDdl());
      // the tables hold the reconciler's index: the first start makes the window's and the purge's
      const first: string[] = [];
      await new SqlSpendMeter({ db: recording(db, first), allowanceFor: () => 1, windowMs: HOUR, requireShared: false }).ensureSchema();
      expect(first.filter(createsIndex)).toEqual([
        expect.stringContaining('idx_spend_reservations_account ON'),
        expect.stringContaining('idx_spend_reservations_settled ON'),
      ]);
      // a second start finds all three in sqlite_master and runs none
      const second: string[] = [];
      await new SqlSpendMeter({ db: recording(db, second), allowanceFor: () => 1, windowMs: HOUR, requireShared: false }).ensureSchema();
      expect(second).not.toEqual([]);
      expect(second.filter(createsIndex)).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('reports to onWarning an index statement the store refuses, with its error, makes the indexes nothing stands in the way of, and counts on the tables as they are', async () => {
    const db = await openSqlite();
    try {
      // a store an earlier release made, where a table holds the name of the window's index
      await db.exec(olderDdl());
      await db.exec('CREATE TABLE idx_spend_reservations_account (id INTEGER)');
      const warnings: { statement: string; error: unknown }[] = [];
      const meter = new SqlSpendMeter({ db, allowanceFor: () => 1, windowMs: HOUR, requireShared: false, onWarning: (warning) => warnings.push(warning) });
      await expect(meter.ensureSchema()).resolves.toBeUndefined();
      expect(warnings).toEqual([
        {
          statement: expect.stringContaining('idx_spend_reservations_account ON'),
          error: expect.objectContaining({ message: expect.stringContaining('there is already a table named idx_spend_reservations_account') }),
        },
      ]);
      expect((await catalogue(db)).indexes.map((index) => index.name)).toEqual(['idx_spend_reservations_due', 'idx_spend_reservations_settled']);
      expect(await meter.reserve({ accountId: 'a', operationId: 'op', now: OCT })).toMatchObject({ status: 'reserved', remaining: 0 });
    } finally {
      await db.close();
    }
  });

  it('refuses a store several processes cannot share unless told it is alone', async () => {
    const db = await openSqlite();
    try {
      expect(() => new SqlSpendMeter({ db, allowanceFor: () => 1, periodOf: monthOf })).toThrow(/several processes share/);
    } finally {
      await db.close();
    }
  });

  it('turns a failure to read the allowance into the unavailable error, before anything is written', async () => {
    const db = await openSqlite();
    try {
      const meter = new SqlSpendMeter({ db, allowanceFor: () => Promise.reject(new Error('plan lookup down')), periodOf: monthOf, requireShared: false });
      await expect(meter.reserve({ accountId: 'a', operationId: 'op', now: OCT })).rejects.toThrow(/allowance could not be read: plan lookup down/);
    } finally {
      await db.close();
    }
  });
});

describe('the bounded retry', () => {
  it('tries a transient failure again and gives up on any other at once', async () => {
    let calls = 0;
    const flaky = () => {
      calls += 1;
      return calls < 3 ? Promise.reject(Object.assign(new Error('deadlock detected'), { code: '40P01' })) : Promise.resolve('ok');
    };
    expect(await withBoundedRetry(flaky, { attempts: 3, baseDelayMs: 1, maxDelayMs: 2, deadlineMs: 1_000 }, isTransientStorageError)).toBe('ok');
    expect(calls).toBe(3);
    calls = 0;
    const broken = () => {
      calls += 1;
      return Promise.reject(Object.assign(new Error('syntax error'), { code: '42601' }));
    };
    await expect(withBoundedRetry(broken, { attempts: 3, baseDelayMs: 1, maxDelayMs: 2, deadlineMs: 1_000 }, isTransientStorageError)).rejects.toThrow(/did not answer: syntax error/);
    expect(calls).toBe(1);
  });

  it('stops at the deadline', async () => {
    let calls = 0;
    const busy = () => {
      calls += 1;
      return Promise.reject(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }));
    };
    await expect(withBoundedRetry(busy, { attempts: 10, baseDelayMs: 40, maxDelayMs: 40, deadlineMs: 100 }, isTransientStorageError)).rejects.toBeInstanceOf(SpendMeterUnavailableError);
    expect(calls).toBeLessThan(10);
  });

  it('reads the transient classes', () => {
    for (const code of ['40001', '40P01', '08006', '57P01', 'SQLITE_BUSY', 'ECONNRESET']) expect(isTransientStorageError({ code }), code).toBe(true);
    for (const code of ['42601', '23505', 'SQLITE_CONSTRAINT']) expect(isTransientStorageError({ code }), code).toBe(false);
  });
});
