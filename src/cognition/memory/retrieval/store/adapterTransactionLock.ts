/**
 * @fileoverview One lock per PostgreSQL adapter a souled agent keeps its store on, for the transactions the memory
 * store opens on it.
 *
 * A souled agent runs each person's writes, compiles and deletions on a chain of their own, so a retention sweep of
 * one person, a deletion of another and a third's write can each open a transaction on the store's adapter at the
 * same moment. The agent's store may be on an adapter object whose transactions share one client
 * (`Brain.openWithAdapter`'s docs describe the hazard), so on the adapter a souled agent marks
 * ({@link serializeTransactionsOn}) the transactions this library opens run one after another. Reads and writes
 * outside a transaction stay concurrent, and a transaction the host runs on the adapter itself sits outside the lock.
 * An adapter no souled agent marked is not locked: its transactions run as the adapter runs them.
 *
 * @module memory/retrieval/store/adapterTransactionLock
 * @internal
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { StorageAdapter } from '@framers/sql-storage-adapter';

/** A lock held by the work it runs; `held` turns false once that work has settled. */
interface HeldLock {
  readonly adapter: StorageAdapter;
  held: boolean;
}

/** The adapters whose transactions run one at a time: each a PostgreSQL adapter a souled agent keeps its store on. */
const serialized = new WeakSet<StorageAdapter>();

/** The end of the chain of transactions each adapter runs through the lock. */
const tails = new WeakMap<StorageAdapter, Promise<void>>();

/**
 * The locks the running work holds. A transaction opened inside one, on the same adapter, runs at once: waiting for
 * the lock its own caller holds would never end. Made on the first locked transaction.
 */
let holding: AsyncLocalStorage<readonly HeldLock[]> | undefined;

/** Whether `adapter` is a PostgreSQL adapter, read as the Brain reads it. */
function isPostgres(adapter: StorageAdapter): boolean {
  return String(adapter.kind).includes('postgres');
}

/**
 * Marks `adapter` as one whose transactions run one at a time through {@link withAdapterTransactionLock}, for as long
 * as the adapter object lives. A souled agent marks the PostgreSQL adapter it keeps its store on, before the store
 * opens. An adapter of any other kind is left unmarked: SQLite adapters order their own transactions.
 *
 * @param adapter - The adapter the store is about to open on.
 * @internal
 */
export function serializeTransactionsOn(adapter: StorageAdapter): void {
  if (isPostgres(adapter)) serialized.add(adapter);
}

/**
 * Runs `work`, which opens a transaction on `adapter`. On an adapter {@link serializeTransactionsOn} marked, it runs
 * once every transaction this lock started earlier on the same adapter has ended; on any other adapter it runs at
 * once. Work that already holds the adapter's lock (a transaction opened inside another) runs at once too. The lock
 * is released when `work` settles, whether it resolves or rejects.
 *
 * @param adapter - The adapter the transaction is opened on.
 * @param work - Opens the transaction and resolves with its result.
 * @returns What `work` resolves with.
 * @internal
 */
export function withAdapterTransactionLock<T>(adapter: StorageAdapter, work: () => Promise<T>): Promise<T> {
  if (!serialized.has(adapter)) return work();
  holding ??= new AsyncLocalStorage<readonly HeldLock[]>();
  const store = holding;
  const held = store.getStore() ?? [];
  if (held.some((lock) => lock.adapter === adapter && lock.held)) return work();
  const lock: HeldLock = { adapter, held: false };
  const run = (tails.get(adapter) ?? Promise.resolve()).then(() => {
    lock.held = true;
    return store.run([...held, lock], work);
  });
  const release = (): void => {
    lock.held = false;
  };
  tails.set(adapter, run.then(release, release));
  return run;
}
