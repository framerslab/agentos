/**
 * @fileoverview {@link ISpendMeter} over a `@framers/sql-storage-adapter` store: Postgres for a deployment, SQLite for
 * a single process and the tests.
 *
 * Every write is a conditional statement inside one transaction, never a read followed by a write, so the store's
 * own row locking decides a race: two reservations cannot both take the last unit, and a settle and a reconcile on
 * one operation make one transition between them. A meter with a rolling window counts from the reservations
 * themselves: its reservation takes the account row's lock with a write first, reads the window under that lock, and
 * rolls itself back when it does not fit, so the same holds.
 *
 * Give the meter an adapter of its own (or the product's own pool), never AgentOS's provenance-wrapped storage
 * adapter, whose write hooks can turn a `run()` into a no-op.
 *
 * A meter's two tables are named from its `tablePrefix`, and every statement it runs names them, so meters with
 * different rules keep their rows apart in one database, each under a prefix of its own.
 *
 * @module safety/runtime/SqlSpendMeter
 */
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import {
  DEFAULT_SPEND_RETRY_POLICY,
  isTransientStorageError,
  SpendMeterUnavailableError,
  withBoundedRetry,
  type ISpendMeter,
  type SpendDenyReason,
  type SpendMeterSnapshot,
  type SpendOutcome,
  type SpendReconcileResult,
  type SpendReservationState,
  type SpendReserveRequest,
  type SpendReserveResult,
  type SpendRetryPolicy,
  type SpendSettleRequest,
  type SpendSettleResult,
} from './SpendMeter.js';

/**
 * The meter's two tables and their indexes under the default prefix, `agentos_spend`: one index the reconciler reads
 * the due reservations through, one a rolling window counts an account's reservations through, and one a purge finds
 * the settled reservations through, by the time they settled. Every time is epoch milliseconds in a BIGINT. There is
 * no literal question mark anywhere in the text: the Postgres adapter rewrites each one to a numbered parameter. A
 * product that runs its own migrations copies this text, or {@link spendMeterDdl}'s for a prefix of its own, into one
 * of them and passes `ensureSchema: false`. `spendMeterDdl()` answers this text word for word.
 */
export const SPEND_METER_DDL = `
CREATE TABLE IF NOT EXISTS agentos_spend_meter (
  account_id TEXT NOT NULL,
  period TEXT NOT NULL,
  allowance BIGINT NOT NULL,
  used BIGINT NOT NULL DEFAULT 0,
  reserved BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (account_id, period),
  CHECK (used >= 0 AND reserved >= 0)
);
CREATE TABLE IF NOT EXISTS agentos_spend_reservations (
  operation_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  period TEXT NOT NULL,
  units BIGINT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'consumed', 'released')),
  outcome TEXT,
  attempts BIGINT NOT NULL DEFAULT 1,
  reserved_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  settled_at BIGINT,
  usage_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_spend_reservations_due ON agentos_spend_reservations (state, expires_at);
CREATE INDEX IF NOT EXISTS idx_spend_reservations_account ON agentos_spend_reservations (account_id, reserved_at);
CREATE INDEX IF NOT EXISTS idx_spend_reservations_settled ON agentos_spend_reservations (settled_at, state);
`;

/** The prefix of the tables' names when `tablePrefix` is left out: the names {@link SPEND_METER_DDL} makes. */
const DEFAULT_TABLE_PREFIX = 'agentos_spend';

/**
 * The prefixes a meter takes: a lower-case letter, then at most 37 lower-case letters, digits or underscores. A prefix
 * becomes part of SQL identifiers, so it is checked against this before any statement is built. At 38 characters the
 * longest names the meter gives, `idx_<prefix>_reservations_account` and `idx_<prefix>_reservations_settled`, take the
 * 63 bytes Postgres keeps of an identifier; Postgres cuts a longer name short, and its catalogue would then hold a
 * name other than the one {@link spendMeterDdl} gives.
 */
const TABLE_PREFIX = /^[a-z][a-z0-9_]{0,37}$/;

/** The names one prefix gives the meter's two tables, and the start of its indexes' names. */
interface SpendMeterTables {
  meter: string;
  reservations: string;
  /** `idx_spend_reservations` under the default prefix, `idx_<prefix>_reservations` under another. */
  index: string;
}

/**
 * The names a prefix gives the meter's tables and indexes, once the prefix is checked: one outside
 * {@link TABLE_PREFIX} is refused, and so is `spend`, whose index names would be the default prefix's.
 */
function spendMeterTables(tablePrefix: string | undefined): SpendMeterTables {
  const prefix = tablePrefix ?? DEFAULT_TABLE_PREFIX;
  if (typeof prefix !== 'string' || !TABLE_PREFIX.test(prefix)) {
    throw new Error(
      `A spend meter's tablePrefix is a lower-case letter and at most 37 more lower-case letters, digits or underscores, so that every name it gives fits the 63 bytes of a Postgres identifier; got ${JSON.stringify(prefix)}.`,
    );
  }
  // the default prefix keeps the index names SPEND_METER_DDL gives it, which are the ones `spend` would make
  if (prefix === 'spend') {
    throw new Error(`A spend meter's tablePrefix cannot be "spend": its index names would be those of the default prefix, ${DEFAULT_TABLE_PREFIX}.`);
  }
  return {
    meter: `${prefix}_meter`,
    reservations: `${prefix}_reservations`,
    index: prefix === DEFAULT_TABLE_PREFIX ? 'idx_spend_reservations' : `idx_${prefix}_reservations`,
  };
}

/** The meter's DDL under the names one prefix gives: its two tables, then its indexes. */
function ddlOf(t: SpendMeterTables): string {
  return `
CREATE TABLE IF NOT EXISTS ${t.meter} (
  account_id TEXT NOT NULL,
  period TEXT NOT NULL,
  allowance BIGINT NOT NULL,
  used BIGINT NOT NULL DEFAULT 0,
  reserved BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (account_id, period),
  CHECK (used >= 0 AND reserved >= 0)
);
CREATE TABLE IF NOT EXISTS ${t.reservations} (
  operation_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  period TEXT NOT NULL,
  units BIGINT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'consumed', 'released')),
  outcome TEXT,
  attempts BIGINT NOT NULL DEFAULT 1,
  reserved_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  settled_at BIGINT,
  usage_json TEXT
);
${indexesOf(t).map((index) => `${index.statement};`).join('\n')}
`;
}

/** One of the meter's indexes: its name, and the statement that makes it unless an index of that name exists. */
interface SpendMeterIndex {
  name: string;
  statement: string;
}

/**
 * The meter's indexes under the names one prefix gives, in the order its DDL makes them: the reconciler's, the
 * window's and the purge's. A purge's page reads `state <> 'reserved' AND settled_at < ?`, and `<>` on an index's first
 * column gives a B-tree no range to scan, so the purge's index leads with `settled_at`, whose `<` does, and holds
 * `state` beside it.
 */
function indexesOf(t: SpendMeterTables): SpendMeterIndex[] {
  return [
    { name: `${t.index}_due`, columns: 'state, expires_at' },
    { name: `${t.index}_account`, columns: 'account_id, reserved_at' },
    { name: `${t.index}_settled`, columns: 'settled_at, state' },
  ].map(({ name, columns }) => ({ name, statement: `CREATE INDEX IF NOT EXISTS ${name} ON ${t.reservations} (${columns})` }));
}

/**
 * The meter's two tables and their indexes under a prefix: `<prefix>_meter` and `<prefix>_reservations`, with indexes
 * named `idx_<prefix>_reservations_*`. The default prefix answers {@link SPEND_METER_DDL} itself, word for word. A
 * product that runs its own migrations copies this text for the prefix it gives its meter and passes
 * `ensureSchema: false`. The prefix is checked before the text is built, and one that
 * {@link SqlSpendMeterOptions.tablePrefix} refuses throws.
 */
export function spendMeterDdl(tablePrefix?: string): string {
  return ddlOf(spendMeterTables(tablePrefix));
}

/** What became of an operation whose lease ran out, as the product knows it: its reply was stored, it was not, or it cannot tell. */
export type SpendUnknownResolution = 'consumed' | 'released' | 'unknown';

export interface SqlSpendMeterOptions {
  db: StorageAdapter;
  /** The account's allowance for a period, in units. Read at every reservation, so a plan change applies at the next turn. */
  allowanceFor(accountId: string, period: string): number | Promise<number>;
  /**
   * The period a moment falls in for an account, e.g. its calendar month in its own time zone ("2026-10"). Required
   * unless `windowMs` is set; with a window it is not read.
   */
  periodOf?(now: number, accountId: string): string | Promise<string>;
  /**
   * A rolling window in milliseconds. The allowance then holds the units reserved or consumed in the `windowMs` before
   * each reservation, counted from the reservations themselves under the account's row lock, and every row of the
   * account carries the period `window`. A unit has left the window once more than `windowMs` have passed since its
   * reservation; a released one never counts.
   */
  windowMs?: number;
  /** How long a reservation lives without a heartbeat. Default 45 seconds. */
  leaseMs?: number;
  /** Reservations an operation may take in all, its retries after a release included. Default 3. */
  maxAttemptsPerOperation?: number;
  retry?: SpendRetryPolicy;
  /** Asked by {@link SqlSpendMeter.reconcile} for each expired reservation. */
  resolveUnknown?(reservation: { operationId: string; accountId: string; period: string; units: number }): SpendUnknownResolution | Promise<SpendUnknownResolution>;
  /** How an expired reservation settles when the product cannot tell. Default `release`: the person is not charged for a turn nobody saw finish. */
  unknownAfterLease?: 'release' | 'consume';
  /**
   * Refuse a store that several processes cannot share (no transactions, no persistence or no concurrent access): a
   * SQLite file per process would give every instance an allowance of its own. Default true; tests pass false.
   */
  requireShared?: boolean;
  /**
   * Create the tables when they are missing, and on tables that exist the indexes they lack (see
   * {@link SqlSpendMeter.ensureSchema}). Default true. With false the meter runs no DDL: the product's own migrations
   * make the tables and their indexes.
   */
  ensureSchema?: boolean;
  /**
   * The start of the two tables' names: `<prefix>_meter` and `<prefix>_reservations`, their indexes named after them
   * (`idx_<prefix>_reservations_*`). Default `agentos_spend`, the names {@link SPEND_METER_DDL} makes, whose indexes
   * are `idx_spend_reservations_*`. Meters with different rules share one database each under a prefix of its own, so
   * one's count and one's purge never reach another's rows; meters under one prefix share its tables.
   *
   * A lower-case letter, then at most 37 lower-case letters, digits or underscores, and not `spend`, whose index names
   * are the default prefix's. At 38 characters the longest names the meter gives, `idx_<prefix>_reservations_account`
   * and `idx_<prefix>_reservations_settled`, take the 63 bytes Postgres keeps of an identifier. The constructor checks
   * the prefix before any statement is built and throws on any other value, so nothing unchecked reaches the SQL text.
   * {@link spendMeterDdl} makes the tables for a prefix.
   */
  tablePrefix?: string;
}

/** What one purge deleted. */
export interface SpendPurgeResult {
  /** The settled reservations deleted. */
  reservations: number;
  /** A window meter's account rows deleted; a meter with periods deletes none. */
  periods: number;
}

interface ReservationRow {
  operation_id: string;
  account_id: string;
  period: string;
  units: number | string;
  state: SpendReservationState;
  attempts: number | string;
}

/** The one period every row of a window meter carries. The window's own statements name it literally. */
const WINDOW_PERIOD = 'window';

/** Rolls a reservation's transaction back when the allowance has no room; caught inside the same try, never retried. */
class AllowanceExhausted extends Error {
  constructor(readonly remaining: number) {
    super('allowance_exhausted');
  }
}

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0));

export class SqlSpendMeter implements ISpendMeter {
  private readonly db: StorageAdapter;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly retry: SpendRetryPolicy;
  /** The rolling window in whole milliseconds; undefined for a meter that counts in periods. */
  private readonly windowMs: number | undefined;
  /** The names of this meter's tables, from its checked prefix; every statement reads them here. */
  private readonly tables: SpendMeterTables;
  private schemaReady: Promise<void> | null = null;
  private reconciler: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: SqlSpendMeterOptions) {
    const caps = opts.db.capabilities;
    if (opts.requireShared !== false && !(caps.has('transactions') && caps.has('persistence') && caps.has('concurrent'))) {
      throw new Error(
        `SqlSpendMeter needs a store several processes share (transactions, persistence and concurrent access); "${opts.db.kind}" lacks one. Pass requireShared: false for a single process.`,
      );
    }
    if (!caps.has('transactions')) throw new Error(`SqlSpendMeter needs a store with transactions; "${opts.db.kind}" has none.`);
    this.tables = spendMeterTables(opts.tablePrefix);
    if (opts.windowMs === undefined) {
      if (typeof opts.periodOf !== 'function') {
        throw new Error('SqlSpendMeter needs periodOf or windowMs: the period a moment falls in, or a rolling window to count in.');
      }
    } else if (!Number.isFinite(opts.windowMs) || Math.trunc(opts.windowMs) < 1) {
      throw new Error(`SqlSpendMeter needs windowMs to be a positive number of milliseconds; got ${opts.windowMs}.`);
    }
    this.db = opts.db;
    this.leaseMs = opts.leaseMs ?? 45_000;
    this.maxAttempts = opts.maxAttemptsPerOperation ?? 3;
    this.retry = opts.retry ?? DEFAULT_SPEND_RETRY_POLICY;
    this.windowMs = opts.windowMs === undefined ? undefined : Math.trunc(opts.windowMs);
  }

  /**
   * Creates the tables and their indexes unless the tables answer a read already. On tables that answer it reads the
   * store's catalogue for the meter's index names (`pg_indexes` on Postgres, `sqlite_master` on SQLite) and runs the
   * `CREATE INDEX IF NOT EXISTS` statement of each index the tables lack, so a store an earlier release made gains the
   * indexes it lacks, and a store that holds them all runs no index statement: on Postgres each one takes a SHARE lock
   * on the reservations table, which holds back the table's writes, before it looks for the index's name. Called before
   * the first statement; safe to call again. Does nothing with `ensureSchema: false`.
   */
  ensureSchema(): Promise<void> {
    if (this.opts.ensureSchema === false) return Promise.resolve();
    this.schemaReady ??= (async () => {
      try {
        await this.db.get(`SELECT 1 FROM ${this.tables.meter} LIMIT 1`);
        await this.db.get(`SELECT 1 FROM ${this.tables.reservations} LIMIT 1`);
      } catch {
        await this.db.exec(ddlOf(this.tables));
        return;
      }
      await this.addMissingIndexes();
    })().catch((e) => {
      this.schemaReady = null;
      throw e;
    });
    return this.schemaReady;
  }

  /**
   * Runs, one at a time, the statement of each of the meter's indexes that the store's catalogue does not hold; a
   * catalogue that cannot be read leaves every statement to run. The indexes speed the meter's reads and change none of
   * its answers, so tables that refuse one are used as they are: Postgres checks that the role owns a table before it
   * looks for the index's name, and two processes adding one index at once can collide.
   */
  private async addMissingIndexes(): Promise<void> {
    const indexes = indexesOf(this.tables);
    const names = indexes.map((index) => index.name);
    const marks = names.map(() => '?').join(', ');
    const catalogue = this.db.kind.includes('postgres')
      ? `SELECT indexname AS name FROM pg_indexes WHERE schemaname = current_schema() AND indexname IN (${marks})`
      : `SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (${marks})`;
    const held = await this.db.all<{ name: string }>(catalogue, names).catch((): { name: string }[] => []);
    const present = new Set(held.map((row) => row.name));
    for (const index of indexes) {
      if (present.has(index.name)) continue;
      await this.db.exec(index.statement).catch(() => undefined);
    }
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    return withBoundedRetry(
      async () => {
        await this.ensureSchema();
        return fn();
      },
      this.retry,
      isTransientStorageError,
    );
  }

  /** The period a moment falls in for an account: the product's answer, or the one period of a window meter. */
  private periodAt(now: number, accountId: string): string | Promise<string> {
    // the constructor refused a meter with neither, so a meter without a window has a periodOf
    if (this.windowMs !== undefined || !this.opts.periodOf) return WINDOW_PERIOD;
    return this.opts.periodOf(now, accountId);
  }

  async reserve(req: SpendReserveRequest): Promise<SpendReserveResult> {
    const now = req.now ?? Date.now();
    const units = Math.max(1, Math.trunc(req.units ?? 1));
    let period: string;
    let allowance: number;
    try {
      period = await this.periodAt(now, req.accountId);
      allowance = Math.max(0, Math.trunc(await this.opts.allowanceFor(req.accountId, period)));
    } catch (e) {
      throw new SpendMeterUnavailableError(`the allowance could not be read: ${e instanceof Error ? e.message : String(e)}`, e);
    }
    const base = { operationId: req.operationId, accountId: req.accountId, period };
    const expiresAt = now + this.leaseMs;
    const windowMs = this.windowMs;
    const { meter, reservations } = this.tables;
    return this.run(async () => {
      try {
        return await this.db.transaction(async (trx): Promise<SpendReserveResult> => {
          // (a) the reservation row: new, or a retry of one that was released
          const inserted = await trx.run(
            `INSERT INTO ${reservations} (operation_id, account_id, period, units, state, attempts, reserved_at, expires_at)
             VALUES (?, ?, ?, ?, 'reserved', 1, ?, ?) ON CONFLICT (operation_id) DO NOTHING`,
            [req.operationId, req.accountId, period, units, now, expiresAt],
          );
          let attempt = 1;
          if (!inserted.changes) {
            const retried = await trx.run(
              `UPDATE ${reservations}
                  SET state = 'reserved', attempts = attempts + 1, account_id = ?, period = ?, units = ?, reserved_at = ?, expires_at = ?,
                      outcome = NULL, settled_at = NULL, usage_json = NULL
                WHERE operation_id = ? AND state = 'released' AND attempts < ?`,
              [req.accountId, period, units, now, expiresAt, req.operationId, this.maxAttempts],
            );
            const row = await trx.get<ReservationRow>(`SELECT state, attempts FROM ${reservations} WHERE operation_id = ?`, [req.operationId]);
            if (!retried.changes) {
              const reason: SpendDenyReason = row?.state === 'reserved' ? 'in_flight' : row?.state === 'consumed' ? 'already_consumed' : 'retries_exhausted';
              return { status: 'denied', reason, ...base, remaining: await this.remainingIn(trx, req.accountId, period, allowance, now) };
            }
            attempt = num(row?.attempts);
          }
          // (b) the period's row, with the allowance in force today
          await trx.run(
            `INSERT INTO ${meter} (account_id, period, allowance, used, reserved, updated_at) VALUES (?, ?, ?, 0, 0, ?)
             ON CONFLICT (account_id, period) DO UPDATE SET allowance = excluded.allowance`,
            [req.accountId, period, allowance, now],
          );
          if (windowMs !== undefined) {
            // (c) with a window: adding the units takes the row's lock, so concurrent reservations for one account
            // queue here. The units its other operations hold inside the window are read under that lock (at READ
            // COMMITTED, Postgres's default, the read sees every reservation that committed before it began), and
            // this one stays only where they leave it room.
            await trx.run(`UPDATE ${meter} SET reserved = reserved + ?, updated_at = ? WHERE account_id = ? AND period = 'window'`, [units, now, req.accountId]);
            const others = await this.windowUnits(trx, req.accountId, now - windowMs, req.operationId);
            const room = allowance - others.used - others.reserved;
            if (units > room) throw new AllowanceExhausted(Math.max(0, room));
            return { status: 'reserved', ...base, units, attempt, remaining: room - units, expiresAt };
          }
          // (c) the units taken only where they fit: the row lock makes concurrent reservations queue here
          const taken = await trx.run(
            `UPDATE ${meter} SET reserved = reserved + ?, updated_at = ?
              WHERE account_id = ? AND period = ? AND used + reserved + ? <= allowance`,
            [units, now, req.accountId, period, units],
          );
          if (!taken.changes) throw new AllowanceExhausted(await this.remainingIn(trx, req.accountId, period, allowance, now));
          return { status: 'reserved', ...base, units, attempt, remaining: await this.remainingIn(trx, req.accountId, period, allowance, now), expiresAt };
        });
      } catch (e) {
        // the transaction rolled back (a), (b) and, with a window, the units (c) added; the refusal is an answer, not a failure
        if (e instanceof AllowanceExhausted) return { status: 'denied', reason: 'allowance_exhausted', ...base, remaining: e.remaining };
        throw e;
      }
    });
  }

  /** The units left to an account at `now`: its allowance less what the period's row holds, or, with a window, less what the window holds. */
  private async remainingIn(trx: StorageAdapter, accountId: string, period: string, fallbackAllowance: number, now: number): Promise<number> {
    const m = await trx.get<{ allowance: unknown; used: unknown; reserved: unknown }>(`SELECT allowance, used, reserved FROM ${this.tables.meter} WHERE account_id = ? AND period = ?`, [
      accountId,
      period,
    ]);
    if (this.windowMs !== undefined) {
      const held = await this.windowUnits(trx, accountId, now - this.windowMs);
      return Math.max(0, (m ? num(m.allowance) : fallbackAllowance) - held.used - held.reserved);
    }
    if (!m) return fallbackAllowance;
    return Math.max(0, num(m.allowance) - num(m.used) - num(m.reserved));
  }

  /**
   * The units an account's reservations hold inside the window that reaches back to `since`: the consumed ones and
   * the ones still reserved, never a released one. `except` leaves one operation out: the reservation being decided.
   */
  private async windowUnits(db: StorageAdapter, accountId: string, since: number, except?: string): Promise<{ used: number; reserved: number }> {
    // reserved_at has no upper bound here: a unit another process stamped a little ahead of this clock still counts
    const held = await db.get<{ used: unknown; reserved: unknown }>(
      `SELECT COALESCE(SUM(CASE WHEN state = 'consumed' THEN units ELSE 0 END), 0) AS used,
              COALESCE(SUM(CASE WHEN state = 'reserved' THEN units ELSE 0 END), 0) AS reserved
         FROM ${this.tables.reservations}
        WHERE account_id = ? AND period = 'window' AND state <> 'released' AND reserved_at >= ?${except === undefined ? '' : ' AND operation_id <> ?'}`,
      except === undefined ? [accountId, since] : [accountId, since, except],
    );
    return { used: num(held?.used), reserved: num(held?.reserved) };
  }

  async settle(req: SpendSettleRequest): Promise<SpendSettleResult> {
    const now = req.now ?? Date.now();
    const { meter, reservations } = this.tables;
    return this.run(() =>
      this.db.transaction(async (trx): Promise<SpendSettleResult> => {
        const row = await trx.get<ReservationRow>(`SELECT operation_id, account_id, period, units, state FROM ${reservations} WHERE operation_id = ?`, [req.operationId]);
        if (!row) return { status: 'not_found' };
        const move = transition(row.state, req.outcome);
        if (!move) return { status: 'already_settled', state: row.state };
        // the move only from the state just read: a concurrent settle that got there first leaves nothing to change
        const changed = await trx.run(
          `UPDATE ${reservations} SET state = ?, outcome = ?, settled_at = ?, usage_json = ? WHERE operation_id = ? AND state = ?`,
          [move.to, req.outcome, now, req.usage ? JSON.stringify(req.usage) : null, req.operationId, row.state],
        );
        if (!changed.changes) {
          const current = await trx.get<{ state: SpendReservationState }>(`SELECT state FROM ${reservations} WHERE operation_id = ?`, [req.operationId]);
          return { status: 'already_settled', state: current?.state };
        }
        const units = num(row.units);
        const sets: string[] = [];
        const params: unknown[] = [];
        if (move.reserved) {
          sets.push('reserved = CASE WHEN reserved >= ? THEN reserved - ? ELSE 0 END');
          params.push(units, units);
        }
        if (move.used > 0) {
          sets.push('used = used + ?');
          params.push(units);
        } else if (move.used < 0) {
          sets.push('used = CASE WHEN used >= ? THEN used - ? ELSE 0 END');
          params.push(units, units);
        }
        sets.push('updated_at = ?');
        params.push(now, row.account_id, row.period);
        await trx.run(`UPDATE ${meter} SET ${sets.join(', ')} WHERE account_id = ? AND period = ?`, params);
        return { status: 'settled', state: move.to };
      }),
    );
  }

  async heartbeat(operationId: string, now: number = Date.now()): Promise<void> {
    // every write goes through a transaction: on a single-connection SQLite store that is what keeps it out of another's
    await this.run(() =>
      this.db.transaction((trx) =>
        trx.run(`UPDATE ${this.tables.reservations} SET expires_at = ? WHERE operation_id = ? AND state = 'reserved' AND expires_at < ?`, [
          now + this.leaseMs,
          operationId,
          now + this.leaseMs,
        ]),
      ),
    );
  }

  async reconcile(opts: { now?: number; limit?: number } = {}): Promise<SpendReconcileResult> {
    const now = opts.now ?? Date.now();
    const limit = Math.max(1, Math.trunc(opts.limit ?? 100));
    const due = await this.run(() =>
      this.db.all<ReservationRow>(
        `SELECT operation_id, account_id, period, units, state FROM ${this.tables.reservations} WHERE state = 'reserved' AND expires_at <= ? ORDER BY expires_at LIMIT ${limit}`,
        [now],
      ),
    );
    const out: SpendReconcileResult = { consumed: 0, released: 0, pending: 0 };
    for (const r of due) {
      let resolution: SpendUnknownResolution = 'unknown';
      try {
        if (this.opts.resolveUnknown) {
          resolution = await this.opts.resolveUnknown({ operationId: r.operation_id, accountId: r.account_id, period: r.period, units: num(r.units) });
        }
      } catch {
        resolution = 'unknown';
      }
      const outcome: SpendOutcome =
        resolution === 'consumed' ? 'consumed' : resolution === 'released' ? 'released' : this.opts.unknownAfterLease === 'consume' ? 'consumed' : 'released';
      const settled = await this.settle({ operationId: r.operation_id, outcome, now });
      if (settled.status !== 'settled') out.pending += settled.state === 'reserved' ? 1 : 0;
      else if (outcome === 'consumed') out.consumed += 1;
      else out.released += 1;
    }
    return out;
  }

  async snapshot(accountId: string, now: number = Date.now()): Promise<SpendMeterSnapshot> {
    let period: string;
    let allowance: number;
    try {
      period = await this.periodAt(now, accountId);
      allowance = Math.max(0, Math.trunc(await this.opts.allowanceFor(accountId, period)));
    } catch (e) {
      throw new SpendMeterUnavailableError(`the allowance could not be read: ${e instanceof Error ? e.message : String(e)}`, e);
    }
    const windowMs = this.windowMs;
    const { m, held } = await this.run(async () => ({
      m: await this.db.get<{ allowance: unknown; used: unknown; reserved: unknown }>(`SELECT allowance, used, reserved FROM ${this.tables.meter} WHERE account_id = ? AND period = ?`, [
        accountId,
        period,
      ]),
      // with a window the units are the ones its reservations hold inside it, never the row's own counters
      held: windowMs === undefined ? null : await this.windowUnits(this.db, accountId, now - windowMs),
    }));
    // what is enforced now: the period's stored allowance once the period has a row, else the product's answer
    const enforced = m ? num(m.allowance) : allowance;
    const used = held ? held.used : num(m?.used);
    const reserved = held ? held.reserved : num(m?.reserved);
    return { accountId, period, allowance: enforced, used, reserved, remaining: Math.max(0, enforced - used - reserved) };
  }

  async setAllowance(accountId: string, allowance: number, now: number = Date.now()): Promise<void> {
    const value = Math.max(0, Math.trunc(allowance));
    let period: string;
    try {
      period = await this.periodAt(now, accountId);
    } catch (e) {
      throw new SpendMeterUnavailableError(`the period could not be read: ${e instanceof Error ? e.message : String(e)}`, e);
    }
    await this.run(() =>
      this.db.transaction((trx) =>
        trx.run(
          `INSERT INTO ${this.tables.meter} (account_id, period, allowance, used, reserved, updated_at) VALUES (?, ?, ?, 0, 0, ?)
           ON CONFLICT (account_id, period) DO UPDATE SET allowance = excluded.allowance, updated_at = excluded.updated_at`,
          [accountId, period, value, now],
        ),
      ),
    );
  }

  /**
   * Deletes the reservations settled before `before` and, with a window, the account rows not updated since then that
   * hold nothing reserved, at most `limit` of each (default 1,000): the retention a product's terms set. It deletes
   * from this meter's own two tables, across every account in them, so a meter under a prefix of its own keeps its own
   * retention. A reservation still reserved is never deleted, nor is a period meter's period row, which holds the
   * period's count. With a window, a `before` at least one window back keeps every unit the window counts. An operation
   * retried after its row was purged counts again, so `before` lies past the time a retry can come.
   */
  async purge(opts: { before: number; limit?: number }): Promise<SpendPurgeResult> {
    const before = Math.trunc(opts.before);
    const limit = Math.max(1, Math.trunc(opts.limit ?? 1_000));
    const rolling = this.windowMs !== undefined;
    const { meter, reservations } = this.tables;
    return this.run(() =>
      this.db.transaction(async (trx): Promise<SpendPurgeResult> => {
        // Each delete states its condition twice. The inner one picks a page of rows; the outer one is checked again
        // on each row as it is deleted, so a reservation retried, or an account row written, after the page was read stays.
        const settled = await trx.run(
          `DELETE FROM ${reservations}
            WHERE state <> 'reserved' AND settled_at < ?
              AND operation_id IN (SELECT operation_id FROM ${reservations} WHERE state <> 'reserved' AND settled_at < ? LIMIT ?)`,
          [before, before, limit],
        );
        // a period's row holds the period's count, so a meter with periods keeps every one of them
        if (!rolling) return { reservations: settled.changes, periods: 0 };
        const periods = await trx.run(
          `DELETE FROM ${meter}
            WHERE period = 'window' AND reserved = 0 AND updated_at < ?
              AND account_id IN (SELECT account_id FROM ${meter} WHERE period = 'window' AND reserved = 0 AND updated_at < ? LIMIT ?)`,
          [before, before, limit],
        );
        return { reservations: settled.changes, periods: periods.changes };
      }),
    );
  }

  /** Runs {@link reconcile} every interval until {@link stopReconciler}. A failed pass is retried on the next tick. */
  startReconciler(intervalMs = 15_000, onError?: (e: unknown) => void): void {
    if (this.reconciler) return;
    this.reconciler = setInterval(() => {
      this.reconcile().catch((e) => onError?.(e));
    }, intervalMs);
    this.reconciler.unref?.();
  }

  stopReconciler(): void {
    if (this.reconciler) clearInterval(this.reconciler);
    this.reconciler = null;
  }
}

/** Where an outcome moves a reservation from its state, and what it does to the period's counters; null when it moves nothing. */
function transition(from: SpendReservationState, outcome: SpendOutcome): { to: SpendReservationState; reserved: boolean; used: -1 | 0 | 1 } | null {
  if (from === 'reserved') {
    if (outcome === 'consumed') return { to: 'consumed', reserved: true, used: 1 };
    return { to: 'released', reserved: true, used: 0 };
  }
  // a reply replaced after its turn counted is refunded
  if (from === 'consumed' && outcome === 'replaced') return { to: 'released', reserved: false, used: -1 };
  return null;
}
