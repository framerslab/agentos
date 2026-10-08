/**
 * @fileoverview The spend meter contract: a persisted, per-account allowance of turns (or any unit a product
 * meters), reserved atomically before a turn reaches a model provider and settled when the turn ends.
 *
 * A reservation is keyed by the caller's durable `operationId`, so a request retried with the same id replays its
 * reservation instead of charging twice. A reservation that is never settled (the process died mid-turn) carries a
 * lease; {@link ISpendMeter.reconcile} settles the expired ones, asking the product what became of each.
 *
 * @module safety/runtime/SpendMeter
 */

/** How a reservation ends: the turn counted, it did not, or its reply was replaced after it counted (refunded). */
export type SpendOutcome = 'consumed' | 'released' | 'replaced';

/** The state of one reservation row. A replaced reservation ends `released`, with the outcome `replaced`. */
export type SpendReservationState = 'reserved' | 'consumed' | 'released';

/** Why a reservation was refused. */
export type SpendDenyReason =
  /** The period's allowance has no room for the units asked. */
  | 'allowance_exhausted'
  /** The operation already holds a live reservation (a concurrent duplicate of the same request). */
  | 'in_flight'
  /** The operation already counted: a retry of a request that finished. */
  | 'already_consumed'
  /** The operation was released and retried as many times as the meter allows. */
  | 'retries_exhausted';

/** Token usage a settle may record beside the outcome. */
export interface SpendUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  totalCostUSD?: number;
}

export interface SpendReserveRequest {
  accountId: string;
  /** The product's durable id for the request; a retry with the same id replays the reservation. */
  operationId: string;
  /** Units to reserve. Default 1. */
  units?: number;
  /** The clock, in epoch milliseconds; for tests. */
  now?: number;
}

export type SpendReserveResult =
  | {
      status: 'reserved';
      operationId: string;
      accountId: string;
      period: string;
      units: number;
      /** 1 for a first reservation, more for a retry of a released one. */
      attempt: number;
      /** Units left in the period after this reservation. */
      remaining: number;
      expiresAt: number;
    }
  | {
      status: 'denied';
      reason: SpendDenyReason;
      operationId: string;
      accountId: string;
      period: string;
      remaining: number;
    };

export interface SpendSettleRequest {
  operationId: string;
  outcome: SpendOutcome;
  usage?: SpendUsage;
  now?: number;
}

export interface SpendSettleResult {
  /** `already_settled` when the reservation had already left the state this outcome moves it from. */
  status: 'settled' | 'already_settled' | 'not_found';
  state?: SpendReservationState;
}

export interface SpendMeterSnapshot {
  accountId: string;
  period: string;
  allowance: number;
  used: number;
  reserved: number;
  remaining: number;
}

export interface SpendReconcileResult {
  consumed: number;
  released: number;
  /** Expired reservations still reserved after the pass (a concurrent settle, or the page limit). */
  pending: number;
}

/**
 * A persisted per-account meter. Every method is safe to call from several processes at once against one store:
 * two reservations cannot both take the last unit, and a reservation settles exactly once.
 */
export interface ISpendMeter {
  /** Reserves units for an operation, or refuses. Rejects with {@link SpendMeterUnavailableError} when the store cannot answer. */
  reserve(req: SpendReserveRequest): Promise<SpendReserveResult>;
  /** Settles an operation's reservation. Idempotent per operation and outcome. */
  settle(req: SpendSettleRequest): Promise<SpendSettleResult>;
  /** Pushes a live reservation's lease forward while its turn runs. */
  heartbeat(operationId: string, now?: number): Promise<void>;
  /** Settles the reservations whose lease ran out. */
  reconcile(opts?: { now?: number; limit?: number }): Promise<SpendReconcileResult>;
  /** The account's current period: its allowance, the units used and reserved, and what remains. */
  snapshot(accountId: string, now?: number): Promise<SpendMeterSnapshot>;
  /**
   * Writes the current period's allowance at once after a plan change; the units used stay. A store that reads the
   * product's allowance at every reservation takes the product's answer again at the next one.
   */
  setAllowance(accountId: string, allowance: number, now?: number): Promise<void>;
}

/** Thrown when the meter's store cannot answer within its retry policy. A caller fails closed on it: no turn runs. */
export class SpendMeterUnavailableError extends Error {
  readonly code = 'SPEND_METER_UNAVAILABLE';
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'SpendMeterUnavailableError';
  }
}

export interface SpendRetryPolicy {
  /** Tries in all, the first included. */
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** No new try starts after this many milliseconds from the first. */
  deadlineMs: number;
}

export const DEFAULT_SPEND_RETRY_POLICY: SpendRetryPolicy = { attempts: 3, baseDelayMs: 50, maxDelayMs: 400, deadlineMs: 2_000 };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn`, trying again on an error `isTransient` accepts, with a doubling delay, until the tries or the deadline
 * run out. Any failure that ends the loop is thrown as a {@link SpendMeterUnavailableError} carrying the last error.
 */
export async function withBoundedRetry<T>(fn: () => Promise<T>, policy: SpendRetryPolicy, isTransient: (e: unknown) => boolean): Promise<T> {
  const started = Date.now();
  let last: unknown;
  for (let attempt = 1; attempt <= Math.max(1, policy.attempts); attempt += 1) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!isTransient(e)) break;
      const delay = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
      if (attempt === policy.attempts || Date.now() - started + delay > policy.deadlineMs) break;
      await sleep(delay);
    }
  }
  const message = last instanceof Error ? last.message : String(last);
  throw new SpendMeterUnavailableError(`the spend meter's store did not answer: ${message}`, last);
}

/**
 * The store errors worth a second try: Postgres serialization failures and deadlocks (40001, 40P01), its connection
 * class (08xxx) and an administrator's shutdown (57P01); SQLite's busy and locked; and the network errors a pool
 * reports when a connection drops.
 */
export function isTransientStorageError(e: unknown): boolean {
  const err = e as { code?: unknown; message?: unknown } | null;
  const code = typeof err?.code === 'string' ? err.code : '';
  if (code === '40001' || code === '40P01' || code === '57P01' || code.startsWith('08')) return true;
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'EPIPE') return true;
  const message = typeof err?.message === 'string' ? err.message : '';
  return /database is locked|SQLITE_BUSY|Connection terminated|connection timeout/i.test(message);
}
