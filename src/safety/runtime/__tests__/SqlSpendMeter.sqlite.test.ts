/**
 * @fileoverview The spend meter's contract over an in-memory SQLite store, and the rollback of a refused reservation
 * when a later statement of its transaction fails.
 */
import { describe, expect, it } from 'vitest';
import { resolveStorageAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { SpendMeterUnavailableError, withBoundedRetry, isTransientStorageError } from '../SpendMeter.js';
import { SqlSpendMeter } from '../SqlSpendMeter.js';
import { OCT, monthOf, runSpendMeterContractSuite } from './SpendMeter.contract.js';

const openSqlite = () => resolveStorageAdapter({ filePath: ':memory:', priority: ['better-sqlite3', 'sqljs'], quiet: true });

runSpendMeterContractSuite('SqlSpendMeter on SQLite', async ({ allowance, leaseMs, unknownAfterLease, resolveUnknown }) => {
  const db = await openSqlite();
  const meter = new SqlSpendMeter({
    db,
    allowanceFor: (accountId) => allowance.get(accountId) ?? 0,
    periodOf: (now) => monthOf(now),
    leaseMs,
    unknownAfterLease,
    resolveUnknown,
    requireShared: false,
  });
  return { meter, cleanup: () => db.close() };
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
