/**
 * @file GovernedTool.sqlite.e2e.test.ts
 * The governed-tool suite on SQLite in memory, and the cases that need a clock the test moves: a reservation left
 * past its lease, a slow audit sink, a store slower than the lease, and a purge one hour back after a daily limit was
 * used.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveStorageAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { resetLoggerFactory } from '../../../core/logging/loggerFactory.js';
import type { ToolExecutionResult } from '../../../core/tools/ITool.js';
import { SqlActionLimiter, type ActionLimitRule } from '../ActionLimiter.js';
import { governTool, type ActionAuditSink, type ActionGovernance, type GovernedToolPolicy } from '../GovernedTool.js';
import { runGovernedToolSuite } from './GovernedTool.contract.js';
import { CONTEXT, HOUR, MUTE_POLICY, RULES, RULE_BOOK, auditSink, capture, message, messageStore, muteOf, muteTool, type MuteArgs, type RecordingSink } from './governedFixtures.js';

const openSqlite = (): Promise<StorageAdapter> => resolveStorageAdapter({ filePath: ':memory:', priority: ['better-sqlite3', 'sqljs'], quiet: true });
let made = 0;

runGovernedToolSuite('SQLite', async () => {
  const db = await openSqlite();
  return { db, prefix: () => `gt_${(made += 1)}`, close: async () => { await db.close(); } };
});

describe('a governed tool and the clock, SQLite', () => {
  const START = Date.parse('2026-11-10T00:00:00.000Z');
  const ROOM_HOUR: ActionLimitRule[] = [{ id: 'mute_room_hour', scope: 'room', windowMs: HOUR, max: 1 }];
  let db: StorageAdapter;
  let audit: RecordingSink;
  const governance = (result: ToolExecutionResult): { outcome: string; code?: string } => result.details?.governance;
  const governanceOf = (limiter: SqlActionLimiter, over: Partial<ActionGovernance> = {}): ActionGovernance => ({
    actor: { id: 'moderator-1', kind: 'agent' }, mode: 'enforce', limiter, evidenceSource: messageStore(), ruleBook: RULE_BOOK, audit, ...over,
  });
  /** Moves the test's clock in steps of `stepMs` until the call has settled. */
  async function settled(pending: Promise<ToolExecutionResult>, stepMs: number): Promise<ToolExecutionResult> {
    let result: ToolExecutionResult | undefined;
    void pending.then((r) => { result = r; });
    for (let turn = 0; turn < 5 && result === undefined; turn += 1) await vi.advanceTimersByTimeAsync(stepMs);
    return pending;
  }

  beforeEach(async () => { db = await openSqlite(); audit = auditSink(); capture(); });
  afterEach(async () => { vi.useRealTimers(); resetLoggerFactory(); await db.close(); });

  it('(i) a reservation left past its lease counts and blocks its key until a pass settles it, then leaves with its window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    const limiter = new SqlActionLimiter({ db, rules: ROOM_HOUR, tablePrefix: 'gt_i', requireShared: false });
    const policy: GovernedToolPolicy<MuteArgs> = { ...MUTE_POLICY, limits: ROOM_HOUR, idempotencyKey: (args) => `mute:${args.userId}` };
    const governed = governTool(muteTool(), policy, governanceOf(limiter));
    // a process reserved this action and died before it settled it
    const key = createHash('sha256').update('mute:u_attacker', 'utf8').digest('hex');
    expect((await limiter.reserve({ rules: ROOM_HOUR, target: { accountId: 'u_attacker', roomId: 'r1' }, operationId: key, dryRun: false })).status).toBe('reserved');

    vi.setSystemTime(START + 61_000);
    expect(governance(await governed.execute(muteOf(message('m1')), CONTEXT)).outcome).toBe('duplicate');
    expect(governance(await governed.execute(muteOf(message('m2')), CONTEXT))).toMatchObject({ outcome: 'limit_reached', code: 'mute_room_hour' });

    await limiter.reconcile();
    expect(governance(await governed.execute(muteOf(message('m1')), CONTEXT)).outcome).toBe('duplicate');
    expect(governance(await governed.execute(muteOf(message('m2')), CONTEXT)).outcome).toBe('limit_reached');

    vi.setSystemTime(START + HOUR + 1);
    expect(governance(await governed.execute(muteOf(message('m2')), CONTEXT)).outcome).toBe('executed');
  });

  it('(o) a slow audit sink cannot stretch a window: a unit counts from just before its action', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(START);
    const limiter = new SqlActionLimiter({ db, rules: ROOM_HOUR, tablePrefix: 'gt_o', requireShared: false });
    const starts: number[] = [];
    const mute = muteTool(async () => { starts.push(Date.now()); return { success: true, output: { muted: true } }; });
    const policy: GovernedToolPolicy<MuteArgs> = { ...MUTE_POLICY, limits: ROOM_HOUR };
    const slowSink: ActionAuditSink = {
      begin: (record) => (record.target.accountId === 'u_attacker' ? new Promise<void>((resolve) => { setTimeout(resolve, 61 * 60_000); }) : Promise.resolve()),
      finish: async () => undefined,
    };
    const slow = governTool(mute, policy, governanceOf(limiter, { audit: slowSink })).execute(muteOf(message('m1')), CONTEXT);
    const fast = await governTool(mute, policy, governanceOf(limiter)).execute(muteOf(message('m2')), CONTEXT);
    expect(governance(fast).outcome).toBe('executed');
    expect(governance(await settled(slow, 61 * 60_000)).outcome).toBe('executed');
    expect(starts).toHaveLength(2);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(HOUR);
  });

  it('(o) a store slower than the lease ends the call before the tool starts, and gives the units back', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(START);
    const delay = { on: false, seen: 0 };
    const slowDb = new Proxy(db, {
      get(target, prop) {
        if (prop === 'transaction') {
          return async (fn: never) => {
            const out = await target.transaction(fn);
            // the second reservation of the slow call commits, and its answer arrives 61 seconds later
            if (delay.on && (delay.seen += 1) === 2) await new Promise<void>((resolve) => { setTimeout(resolve, 61_000); });
            return out;
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as StorageAdapter;
    const limiter = new SqlActionLimiter({ db: slowDb, rules: RULES, tablePrefix: 'gt_s', requireShared: false });
    // the tables exist before the slow call, so its first transaction is its first rule's reservation
    const warm = await limiter.reserve({ rules: RULES, target: { accountId: 'u_warm', roomId: 'r9' }, operationId: 'warm', dryRun: false });
    if (warm.status === 'reserved') await warm.release();
    delay.on = true;

    const mute = muteTool();
    const result = await settled(governTool(mute, MUTE_POLICY, governanceOf(limiter)).execute(muteOf(message('m1')), CONTEXT), 61_000);
    expect(governance(result)).toMatchObject({ outcome: 'limiter_unavailable', code: 'LEASE_EXPIRED' });
    expect(mute.execute).not.toHaveBeenCalled();
    expect(await db.all<{ state: string }>(`SELECT state FROM gt_s_w${HOUR}_reservations WHERE account_id = 'mute_room_hour|r:r1'`)).toEqual([{ state: 'released' }]);
  });

  it('(p) a purge one hour back, two hours after a daily limit was used, keeps the unit the day still counts', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    const limiter = new SqlActionLimiter({ db, rules: RULES, tablePrefix: 'gt_p', requireShared: false });
    const mute = muteTool();
    const governed = governTool(mute, MUTE_POLICY, governanceOf(limiter));
    expect(governance(await governed.execute(muteOf(message('m1')), CONTEXT)).outcome).toBe('executed');

    // the hourly unit has left its window; the daily one has not, and a purge one hour back must not delete it
    vi.setSystemTime(START + 2 * HOUR);
    await limiter.purge(Date.now() - HOUR);
    // another message of the same author: a new action, the same target
    expect(governance(await governed.execute(muteOf(message('m5')), CONTEXT))).toMatchObject({ outcome: 'limit_reached', code: 'mute_target_day' });
    expect(mute.execute).toHaveBeenCalledTimes(1);
  });
});
