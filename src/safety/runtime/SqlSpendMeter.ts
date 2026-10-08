/**
 * @fileoverview {@link ISpendMeter} over a `@framers/sql-storage-adapter` store: Postgres for a deployment, SQLite for
 * a single process and the tests.
 *
 * Every write is a conditional statement inside one transaction, never a read followed by a write, so the store's
 * own row locking decides a race: two reservations cannot both take the last unit, and a settle and a reconcile on
 * one operation make one transition between them.
 *
 * Give the meter an adapter of its own (or the product's own pool), never AgentOS's provenance-wrapped storage
 * adapter, whose write hooks can turn a `run()` into a no-op.
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
 * The meter's two tables. Every time is epoch milliseconds in a BIGINT. There is no literal question mark anywhere in
 * the text: the Postgres adapter rewrites each one to a numbered parameter. A product that runs its own migrations
 * copies this text into one of them and passes `ensureSchema: false`.
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
`;

/** What became of an operation whose lease ran out, as the product knows it: its reply was stored, it was not, or it cannot tell. */
export type SpendUnknownResolution = 'consumed' | 'released' | 'unknown';

export interface SqlSpendMeterOptions {
  db: StorageAdapter;
  /** The account's allowance for a period, in units. Read at every reservation, so a plan change applies at the next turn. */
  allowanceFor(accountId: string, period: string): number | Promise<number>;
  /** The period a moment falls in for an account, e.g. its calendar month in its own time zone ("2026-10"). */
  periodOf(now: number, accountId: string): string | Promise<string>;
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
  /** Create the tables when they are missing. Default true. */
  ensureSchema?: boolean;
}

interface ReservationRow {
  operation_id: string;
  account_id: string;
  period: string;
  units: number | string;
  state: SpendReservationState;
  attempts: number | string;
}

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
    this.db = opts.db;
    this.leaseMs = opts.leaseMs ?? 45_000;
    this.maxAttempts = opts.maxAttemptsPerOperation ?? 3;
    this.retry = opts.retry ?? DEFAULT_SPEND_RETRY_POLICY;
  }

  /** Creates the tables unless they answer a read already. Called before the first statement; safe to call again. */
  ensureSchema(): Promise<void> {
    if (this.opts.ensureSchema === false) return Promise.resolve();
    this.schemaReady ??= (async () => {
      try {
        await this.db.get('SELECT 1 FROM agentos_spend_meter LIMIT 1');
        await this.db.get('SELECT 1 FROM agentos_spend_reservations LIMIT 1');
      } catch {
        await this.db.exec(SPEND_METER_DDL);
      }
    })().catch((e) => {
      this.schemaReady = null;
      throw e;
    });
    return this.schemaReady;
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

  async reserve(req: SpendReserveRequest): Promise<SpendReserveResult> {
    const now = req.now ?? Date.now();
    const units = Math.max(1, Math.trunc(req.units ?? 1));
    let period: string;
    let allowance: number;
    try {
      period = await this.opts.periodOf(now, req.accountId);
      allowance = Math.max(0, Math.trunc(await this.opts.allowanceFor(req.accountId, period)));
    } catch (e) {
      throw new SpendMeterUnavailableError(`the allowance could not be read: ${e instanceof Error ? e.message : String(e)}`, e);
    }
    const base = { operationId: req.operationId, accountId: req.accountId, period };
    const expiresAt = now + this.leaseMs;
    return this.run(async () => {
      try {
        return await this.db.transaction(async (trx): Promise<SpendReserveResult> => {
          // (a) the reservation row: new, or a retry of one that was released
          const inserted = await trx.run(
            `INSERT INTO agentos_spend_reservations (operation_id, account_id, period, units, state, attempts, reserved_at, expires_at)
             VALUES (?, ?, ?, ?, 'reserved', 1, ?, ?) ON CONFLICT (operation_id) DO NOTHING`,
            [req.operationId, req.accountId, period, units, now, expiresAt],
          );
          let attempt = 1;
          if (!inserted.changes) {
            const retried = await trx.run(
              `UPDATE agentos_spend_reservations
                  SET state = 'reserved', attempts = attempts + 1, account_id = ?, period = ?, units = ?, reserved_at = ?, expires_at = ?,
                      outcome = NULL, settled_at = NULL, usage_json = NULL
                WHERE operation_id = ? AND state = 'released' AND attempts < ?`,
              [req.accountId, period, units, now, expiresAt, req.operationId, this.maxAttempts],
            );
            const row = await trx.get<ReservationRow>('SELECT state, attempts FROM agentos_spend_reservations WHERE operation_id = ?', [req.operationId]);
            if (!retried.changes) {
              const reason: SpendDenyReason = row?.state === 'reserved' ? 'in_flight' : row?.state === 'consumed' ? 'already_consumed' : 'retries_exhausted';
              return { status: 'denied', reason, ...base, remaining: await this.remainingIn(trx, req.accountId, period, allowance) };
            }
            attempt = num(row?.attempts);
          }
          // (b) the period's row, with the allowance in force today
          await trx.run(
            `INSERT INTO agentos_spend_meter (account_id, period, allowance, used, reserved, updated_at) VALUES (?, ?, ?, 0, 0, ?)
             ON CONFLICT (account_id, period) DO UPDATE SET allowance = excluded.allowance`,
            [req.accountId, period, allowance, now],
          );
          // (c) the units taken only where they fit: the row lock makes concurrent reservations queue here
          const taken = await trx.run(
            `UPDATE agentos_spend_meter SET reserved = reserved + ?, updated_at = ?
              WHERE account_id = ? AND period = ? AND used + reserved + ? <= allowance`,
            [units, now, req.accountId, period, units],
          );
          if (!taken.changes) throw new AllowanceExhausted(await this.remainingIn(trx, req.accountId, period, allowance));
          return { status: 'reserved', ...base, units, attempt, remaining: await this.remainingIn(trx, req.accountId, period, allowance), expiresAt };
        });
      } catch (e) {
        // the transaction rolled (a) and (b) back; the refusal is an answer, not a failure
        if (e instanceof AllowanceExhausted) return { status: 'denied', reason: 'allowance_exhausted', ...base, remaining: e.remaining };
        throw e;
      }
    });
  }

  private async remainingIn(trx: StorageAdapter, accountId: string, period: string, fallbackAllowance: number): Promise<number> {
    const m = await trx.get<{ allowance: unknown; used: unknown; reserved: unknown }>('SELECT allowance, used, reserved FROM agentos_spend_meter WHERE account_id = ? AND period = ?', [accountId, period]);
    if (!m) return fallbackAllowance;
    return Math.max(0, num(m.allowance) - num(m.used) - num(m.reserved));
  }

  async settle(req: SpendSettleRequest): Promise<SpendSettleResult> {
    const now = req.now ?? Date.now();
    return this.run(() =>
      this.db.transaction(async (trx): Promise<SpendSettleResult> => {
        const row = await trx.get<ReservationRow>('SELECT operation_id, account_id, period, units, state FROM agentos_spend_reservations WHERE operation_id = ?', [req.operationId]);
        if (!row) return { status: 'not_found' };
        const move = transition(row.state, req.outcome);
        if (!move) return { status: 'already_settled', state: row.state };
        // the move only from the state just read: a concurrent settle that got there first leaves nothing to change
        const changed = await trx.run(
          `UPDATE agentos_spend_reservations SET state = ?, outcome = ?, settled_at = ?, usage_json = ? WHERE operation_id = ? AND state = ?`,
          [move.to, req.outcome, now, req.usage ? JSON.stringify(req.usage) : null, req.operationId, row.state],
        );
        if (!changed.changes) {
          const current = await trx.get<{ state: SpendReservationState }>('SELECT state FROM agentos_spend_reservations WHERE operation_id = ?', [req.operationId]);
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
        await trx.run(`UPDATE agentos_spend_meter SET ${sets.join(', ')} WHERE account_id = ? AND period = ?`, params);
        return { status: 'settled', state: move.to };
      }),
    );
  }

  async heartbeat(operationId: string, now: number = Date.now()): Promise<void> {
    // every write goes through a transaction: on a single-connection SQLite store that is what keeps it out of another's
    await this.run(() =>
      this.db.transaction((trx) =>
        trx.run(`UPDATE agentos_spend_reservations SET expires_at = ? WHERE operation_id = ? AND state = 'reserved' AND expires_at < ?`, [
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
        `SELECT operation_id, account_id, period, units, state FROM agentos_spend_reservations WHERE state = 'reserved' AND expires_at <= ? ORDER BY expires_at LIMIT ${limit}`,
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
      period = await this.opts.periodOf(now, accountId);
      allowance = Math.max(0, Math.trunc(await this.opts.allowanceFor(accountId, period)));
    } catch (e) {
      throw new SpendMeterUnavailableError(`the allowance could not be read: ${e instanceof Error ? e.message : String(e)}`, e);
    }
    const m = await this.run(() =>
      this.db.get<{ allowance: unknown; used: unknown; reserved: unknown }>('SELECT allowance, used, reserved FROM agentos_spend_meter WHERE account_id = ? AND period = ?', [
        accountId,
        period,
      ]),
    );
    // what is enforced now: the period's stored allowance once the period has a row, else the product's answer
    const enforced = m ? num(m.allowance) : allowance;
    const used = num(m?.used);
    const reserved = num(m?.reserved);
    return { accountId, period, allowance: enforced, used, reserved, remaining: Math.max(0, enforced - used - reserved) };
  }

  async setAllowance(accountId: string, allowance: number, now: number = Date.now()): Promise<void> {
    const value = Math.max(0, Math.trunc(allowance));
    let period: string;
    try {
      period = await this.opts.periodOf(now, accountId);
    } catch (e) {
      throw new SpendMeterUnavailableError(`the period could not be read: ${e instanceof Error ? e.message : String(e)}`, e);
    }
    await this.run(() =>
      this.db.transaction((trx) =>
        trx.run(
          `INSERT INTO agentos_spend_meter (account_id, period, allowance, used, reserved, updated_at) VALUES (?, ?, ?, 0, 0, ?)
           ON CONFLICT (account_id, period) DO UPDATE SET allowance = excluded.allowance, updated_at = excluded.updated_at`,
          [accountId, period, value, now],
        ),
      ),
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
