/**
 * @module safety/runtime/ActionLimiter
 *
 * Limits on what an actor may do, counted in a store several processes share: so many actions in a room, against one
 * account or in all, per rolling window. One {@link SqlSpendMeter} per distinct window, each under a table prefix of
 * its own; one unit reserved under every rule before an action starts, committed when it ran and released when it did
 * not.
 */
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { SqlSpendMeter, spendMeterDdl } from './SqlSpendMeter.js';

/** One limit: at most `max` actions per `windowMs` in a room, against one account, or in all. */
export interface ActionLimitRule {
  /**
   * A lower-case letter, then at most 18 lower-case letters, digits or underscores: 19 in all, so the id is a word a
   * log line may carry (a run of 20 or more reads as a credential there and is written `unknown`).
   */
  id: string;
  scope: 'room' | 'target' | 'platform';
  windowMs: number;
  max: number;
}

/** A limiter's answer: every rule reserved one unit, or one rule refused and nothing stays reserved. */
export type ActionLimitAnswer =
  | {
      status: 'reserved';
      commit(): Promise<void>;
      release(): Promise<void>;
      /** When the earliest of the reservations runs out of its lease, epoch milliseconds. A limiter without leases leaves it out. */
      expiresAt?: number;
    }
  | { status: 'denied'; reason: 'limit_reached' | 'duplicate' | 'in_flight' | 'retries_exhausted' | 'unresolvable'; ruleId?: string };

/** What a governed tool asks before its action runs. */
export interface ActionLimiter {
  reserve(request: {
    rules: readonly ActionLimitRule[];
    target: { accountId?: string; roomId?: string };
    /** The action's idempotency key. */
    operationId: string;
    dryRun: boolean;
  }): Promise<ActionLimitAnswer>;
}

export interface SqlActionLimiterOptions {
  db: StorageAdapter;
  /**
   * Every rule the host uses. The limiter builds its meters from this list, so a process that never reserves (a
   * deletion job, a nightly purge) still knows every window and every key. `reserve()` throws for a rule that is not
   * here or whose numbers differ: a configuration error, which a governed tool ends as `limiter_unavailable`.
   */
  rules: readonly ActionLimitRule[];
  /**
   * Default `agentos_action`. Each distinct `windowMs` gets one `SqlSpendMeter` under `<prefix>_w<windowMs>`. That
   * whole name must pass the meter's own rule (a lower-case letter and at most 37 more characters), so the constructor
   * refuses a prefix and a window that together run past it.
   */
  tablePrefix?: string;
  /**
   * How long a reservation lives while its tool runs. Default 60000. The constructor refuses one that is not shorter
   * than every rule's `windowMs`.
   */
  leaseMs?: number;
  /** As `SqlSpendMeterOptions.requireShared`: refuse a store several processes cannot share. Default true. */
  requireShared?: boolean;
  /** As `SqlSpendMeterOptions.ensureSchema`: create the tables when they are missing. Default true. */
  ensureSchema?: boolean;
}

const RULE_ID = /^[a-z][a-z0-9_]{0,18}$/;
const METER_PREFIX = /^[a-z][a-z0-9_]{0,37}$/;
const DEFAULT_PREFIX = 'agentos_action';
const SCOPES: ReadonlySet<string> = new Set(['room', 'target', 'platform']);

/**
 * The key a rule counts under: `<rule id>|r:<room>`, `<rule id>|t:<account>` or `<rule id>|p`, with `dry:` in front
 * for a dry run. Undefined when the rule's scope has no id in the target.
 *
 * @internal Not exported from the folder's index.
 */
export function limiterKeyOf(rule: ActionLimitRule, target: { accountId?: string; roomId?: string }, dryRun: boolean): string | undefined {
  const scope = rule.scope === 'platform' ? 'p'
    : rule.scope === 'room' ? (target.roomId !== undefined ? `r:${target.roomId}` : undefined)
    : (target.accountId !== undefined ? `t:${target.accountId}` : undefined);
  return scope === undefined ? undefined : `${dryRun ? 'dry:' : ''}${rule.id}|${scope}`;
}

/**
 * The operation one rule reserves an action under: `<idempotency key>:<rule id>`, with `dry:` in front for a dry run.
 *
 * @internal Not exported from the folder's index.
 */
export function limiterOperationOf(operationId: string, rule: ActionLimitRule, dryRun: boolean): string {
  return `${dryRun ? 'dry:' : ''}${operationId}:${rule.id}`;
}

/** The table prefix of one window's meter, checked against the meter's own rule. */
function tableName(tablePrefix: string | undefined, windowMs: number): string {
  const name = `${tablePrefix ?? DEFAULT_PREFIX}_w${windowMs}`;
  if (!METER_PREFIX.test(name)) {
    throw new TypeError(`An action limiter names a window's tables <tablePrefix>_w<windowMs>: a lower-case letter and at most 37 more lower-case letters, digits or underscores; got ${JSON.stringify(name)}.`);
  }
  return name;
}

/**
 * The DDL for the windows a host uses, for a host that runs its own migrations (`ensureSchema: false`): each distinct
 * window's two tables and their indexes, once.
 *
 * @param windowsMs - The `windowMs` of every rule the host uses.
 * @param tablePrefix - The limiter's `tablePrefix`; default `agentos_action`.
 * @returns The statements.
 * @throws TypeError when a prefix and a window together make a name the meter refuses.
 */
export function actionLimiterDdl(windowsMs: readonly number[], tablePrefix?: string): string {
  return [...new Set(windowsMs)].map((windowMs) => spendMeterDdl(tableName(tablePrefix, windowMs))).join('\n');
}

/**
 * {@link ActionLimiter} over a `@framers/sql-storage-adapter` store. Counts are rows in the host's database, so they
 * are shared between processes and survive a restart. They are not atomic across two rules: each rule reserves in its
 * own transaction, and a denial gives back the units taken before it.
 *
 * Someone must run {@link reconcile} (or {@link startReconciler} in one process): a reservation whose lease ran out
 * counts against its window, and keeps its action a duplicate, until a pass settles it as used.
 */
export class SqlActionLimiter implements ActionLimiter {
  private readonly db: StorageAdapter;
  private readonly rules = new Map<string, ActionLimitRule>();
  /** One meter per distinct window, with the prefix of its two tables. */
  private readonly meters = new Map<number, { meter: SqlSpendMeter; prefix: string }>();
  private reconciler: ReturnType<typeof setInterval> | null = null;

  /**
   * @param options - The store, every rule the host uses, and the tables' prefix.
   * @throws TypeError for a rule id that is not a word of at most 19 characters, a scope that is not room, target or
   * platform, a window or a ceiling that is not a whole number, one id listed twice with different numbers, no rule, a
   * lease not shorter than every window, or a prefix and a window whose table name runs past 38 characters.
   */
  constructor(options: SqlActionLimiterOptions) {
    this.db = options.db;
    const leaseMs = options.leaseMs ?? 60_000;
    if (!Number.isFinite(leaseMs) || leaseMs < 1) throw new TypeError('An action limiter needs leaseMs to be a positive number of milliseconds.');
    if (!Array.isArray(options.rules) || options.rules.length === 0) throw new TypeError('An action limiter needs at least one rule.');
    for (const rule of options.rules) {
      if (typeof rule.id !== 'string' || !RULE_ID.test(rule.id)) throw new TypeError('A limit rule id is a lower-case letter and at most 18 more lower-case letters, digits or underscores.');
      if (!SCOPES.has(rule.scope)) throw new TypeError(`Limit rule ${rule.id} needs a scope of room, target or platform.`);
      if (!Number.isInteger(rule.windowMs) || rule.windowMs < 1) throw new TypeError(`Limit rule ${rule.id} needs windowMs to be a positive whole number of milliseconds.`);
      if (!Number.isInteger(rule.max) || rule.max < 0) throw new TypeError(`Limit rule ${rule.id} needs max to be a whole number, zero or more.`);
      if (leaseMs >= rule.windowMs) throw new TypeError(`An action limiter's leaseMs must be shorter than every rule's windowMs; rule ${rule.id} has a window of ${rule.windowMs}.`);
      const known = this.rules.get(rule.id);
      if (known && !sameRule(known, rule)) throw new TypeError(`Limit rule ${rule.id} is listed twice with different numbers.`);
      this.rules.set(rule.id, { id: rule.id, scope: rule.scope, windowMs: rule.windowMs, max: rule.max });
    }
    for (const windowMs of new Set([...this.rules.values()].map((rule) => rule.windowMs))) {
      const prefix = tableName(options.tablePrefix, windowMs);
      const meter = new SqlSpendMeter({
        db: options.db,
        windowMs,
        leaseMs,
        // a crash between the reservation and the end counts the action: the cautious reading
        unknownAfterLease: 'consume',
        allowanceFor: (key) => this.maxOf(key),
        tablePrefix: prefix,
        ...(options.requireShared !== undefined ? { requireShared: options.requireShared } : {}),
        ...(options.ensureSchema !== undefined ? { ensureSchema: options.ensureSchema } : {}),
      });
      this.meters.set(windowMs, { meter, prefix });
    }
  }

  /** The `max` of the rule a key belongs to; zero for a key of no rule here. */
  private maxOf(key: string): number {
    const id = (key.startsWith('dry:') ? key.slice(4) : key).split('|', 1)[0];
    return this.rules.get(id)?.max ?? 0;
  }

  /**
   * Reserves one unit under every rule, in the order given; a rule listed more than once is reserved once. A rule with
   * no room left, an action that already ran or is running, one released three times, or a scope with no id in the
   * target refuses the whole action, and the units taken before it are given back.
   *
   * @throws TypeError for a rule this limiter was not built with, or whose numbers differ.
   * @throws SpendMeterUnavailableError when the store does not answer; the units taken are given back where they can be.
   */
  async reserve(request: Parameters<ActionLimiter['reserve']>[0]): Promise<ActionLimitAnswer> {
    // every rule is known and has its key before any unit is taken
    const plan: Array<{ rule: ActionLimitRule; key: string }> = [];
    const planned = new Set<string>();
    for (const asked of request.rules) {
      const rule = this.rules.get(asked.id);
      if (!rule || !sameRule(rule, asked)) throw new TypeError(`Limit rule ${RULE_ID.test(String(asked.id)) ? asked.id : 'of another shape'} is not one this limiter was built with.`);
      // copies of one rule share its key and its operation, so the rule is reserved once
      if (planned.has(rule.id)) continue;
      planned.add(rule.id);
      const key = limiterKeyOf(rule, request.target, request.dryRun);
      if (key === undefined) return { status: 'denied', reason: 'unresolvable', ruleId: rule.id };
      plan.push({ rule, key });
    }
    const taken: Array<{ meter: SqlSpendMeter; operationId: string }> = [];
    // every unit is settled whatever became of the one before it, and the first failure is thrown after the last
    const settle = async (outcome: 'consumed' | 'released'): Promise<void> => {
      let failure: { error: unknown } | undefined;
      for (const unit of taken) {
        try {
          await unit.meter.settle({ operationId: unit.operationId, outcome });
        } catch (error) {
          failure ??= { error };
        }
      }
      if (failure) throw failure.error;
    };
    let expiresAt = Number.POSITIVE_INFINITY;
    for (const { rule, key } of plan) {
      const meter = (this.meters.get(rule.windowMs) as { meter: SqlSpendMeter }).meter;
      const operationId = limiterOperationOf(request.operationId, rule, request.dryRun);
      let answer: Awaited<ReturnType<SqlSpendMeter['reserve']>>;
      try {
        answer = await meter.reserve({ accountId: key, operationId });
      } catch (error) {
        // the store did not answer: what was taken is given back when it can be, and left to its lease when it cannot
        await settle('released').catch(() => undefined);
        throw error;
      }
      if (answer.status === 'denied') {
        await settle('released');
        const reason = answer.reason === 'allowance_exhausted' ? 'limit_reached' : answer.reason === 'already_consumed' ? 'duplicate' : answer.reason;
        return { status: 'denied', reason, ruleId: rule.id };
      }
      taken.push({ meter, operationId });
      expiresAt = Math.min(expiresAt, answer.expiresAt);
    }
    return { status: 'reserved', expiresAt, commit: () => settle('consumed'), release: () => settle('released') };
  }

  /** Settles reservations whose lease ran out; each counts as used. */
  async reconcile(now?: number): Promise<void> {
    for (const { meter } of this.meters.values()) await meter.reconcile(now === undefined ? {} : { now });
  }

  /** Runs {@link reconcile} every interval (default 15000 ms) until {@link stopReconciler}. A failed pass is retried on the next tick. */
  startReconciler(intervalMs = 15_000, onError?: (error: unknown) => void): void {
    if (this.reconciler) return;
    this.reconciler = setInterval(() => { this.reconcile().catch((error) => onError?.(error)); }, intervalMs);
    this.reconciler.unref?.();
  }

  stopReconciler(): void {
    if (this.reconciler) clearInterval(this.reconciler);
    this.reconciler = null;
  }

  /**
   * Deletes settled reservations. Each meter deletes only those settled before both `before` and one of its own
   * windows back, so no unit a window still counts is deleted and an allowance never reopens early. An action whose
   * rows are gone is no longer a duplicate, so `before` is also how long a repeated action reads as one.
   */
  async purge(before: number): Promise<void> {
    const now = Date.now();
    for (const [windowMs, { meter }] of this.meters) await meter.purge({ before: Math.min(Math.trunc(before), now - windowMs) });
  }

  /**
   * Deletes the rows of every target-scoped rule whose key is exactly `<rule id>|t:<accountId>` (and its `dry:` twin),
   * in each meter's two tables, for a host's account deletion. An exact comparison per rule, never a pattern: an id
   * may hold `_`, which a LIKE reads as any character.
   */
  async forgetTarget(accountId: string): Promise<void> {
    for (const rule of this.rules.values()) {
      if (rule.scope !== 'target') continue;
      const { meter, prefix } = this.meters.get(rule.windowMs) as { meter: SqlSpendMeter; prefix: string };
      await meter.ensureSchema();
      for (const key of [`${rule.id}|t:${accountId}`, `dry:${rule.id}|t:${accountId}`]) {
        await this.db.transaction(async (trx) => {
          await trx.run(`DELETE FROM ${prefix}_reservations WHERE account_id = ?`, [key]);
          await trx.run(`DELETE FROM ${prefix}_meter WHERE account_id = ?`, [key]);
        });
      }
    }
  }
}

function sameRule(a: ActionLimitRule, b: ActionLimitRule): boolean {
  return a.id === b.id && a.scope === b.scope && a.windowMs === b.windowMs && a.max === b.max;
}
