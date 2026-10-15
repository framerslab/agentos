/**
 * @fileoverview The key-value store over one IndexedDB object store with out-of-line keys. It opens a database at
 * the version given (1 by default) and creates the object store only when the open upgrades the database (a new one,
 * or one below that version), so a database another page made at that version is read in place. A browser that
 * refuses IndexedDB gets the memory store.
 * @module agentos/core/storage/browser/IndexedDbKeyValueStore
 */

import { idb, type IdbDatabaseLike, type IdbKeyRangeLike, type IdbObjectStoreLike, type IdbRequestLike } from './idb.js';
import { MemoryKeyValueStore, type KeyValueStore } from './KeyValueStore.js';

/** Where the store lives. */
export interface IndexedDbStoreOptions {
  /** The database's name. */
  dbName: string;
  /** The object store's name. It is made, with out-of-line keys, only when the open upgrades the database. */
  storeName: string;
  /**
   * The version the database is opened at. A database that exists at this version is opened as it is, even when it
   * lacks the object store, and every call of the store then rejects; one below it is upgraded, and gains the object
   * store when it lacks it; one above it is refused by the browser.
   * @default 1
   */
  version?: number;
}

/**
 * The store over IndexedDB. Each call is one transaction over the object store: its promise is fulfilled when that
 * transaction completes, and rejected with the reason when its request fails or the transaction is aborted.
 *
 * `keys` and `deletePrefix` read the keys between `prefix` and `prefix` followed by U+FFFF, so they miss a key that
 * holds U+FFFF right after the prefix and goes on: keep keys to characters below it.
 *
 * The connection stays open until `close`: when another tab opens the database at a newer version, its upgrade waits
 * for this tab to close the store or go. A connection the browser closes (the database deleted, the site's storage
 * cleared) is not opened again, and every call then rejects.
 */
export class IndexedDbKeyValueStore implements KeyValueStore {
  /** Always false: the values are in the browser's database. */
  readonly memoryOnly = false;

  /**
   * @param db - An open database that holds the object store.
   * @param storeName - The object store's name.
   */
  constructor(private readonly db: IdbDatabaseLike, private readonly storeName: string) {}

  private run<T>(mode: 'readonly' | 'readwrite', work: (store: IdbObjectStoreLike) => IdbRequestLike<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(this.storeName, mode);
      const request = work(transaction.objectStore(this.storeName));
      transaction.oncomplete = () => resolve(request.result);
      // A failed request's event reaches the transaction before the transaction is aborted for it, so the
      // transaction's own error is still null then, and the request's says why. A transaction aborted for a reason
      // of its own has that reason set by the time its unfinished request's event arrives.
      transaction.onerror = () => reject(transaction.error ?? request.error ?? new Error('IndexedDB request failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    });
  }

  private static range(prefix: string): IdbKeyRangeLike | undefined {
    return prefix === '' ? undefined : idb().keyRange.bound(prefix, `${prefix}\uffff`);
  }

  /** The value held under `key`, or undefined when there is none. */
  async get<T = unknown>(key: string): Promise<T | undefined> {
    return (await this.run('readonly', (store) => store.get(key))) as T | undefined;
  }

  /** Holds a structured clone of `value` under `key`. */
  async set(key: string, value: unknown): Promise<void> {
    await this.run('readwrite', (store) => store.put(value, key));
  }

  /** Removes `key`. */
  async delete(key: string): Promise<void> {
    await this.run('readwrite', (store) => store.delete(key));
  }

  /**
   * Every key that begins with `prefix`, in order. With an empty prefix, every key of the object store, a key that is
   * not a string (a number, a date or an array another page wrote) given as `String` writes it.
   */
  async keys(prefix: string): Promise<string[]> {
    const keys = await this.run('readonly', (store) => store.getAllKeys(IndexedDbKeyValueStore.range(prefix)));
    return keys.map(String).filter((key) => key.startsWith(prefix)).sort();
  }

  /** Removes every key that begins with `prefix`; with an empty prefix, everything the object store holds. */
  async deletePrefix(prefix: string): Promise<void> {
    const range = IndexedDbKeyValueStore.range(prefix);
    await this.run('readwrite', (store) => (range ? store.delete(range) : store.clear()));
  }

  /** Closes the database connection. */
  close(): void {
    this.db.close();
  }
}

/**
 * Opens the store, or the memory store when the browser refuses IndexedDB: a page with no `indexedDB`, an `open`
 * that throws or fails (a database above `version` among them), or an upgrade that waits on another tab. The
 * answer's `memoryOnly` says which it is; the memory store's `close` does nothing.
 *
 * An upgrade that waited on another tab still has its turn once that tab closes the database. It is aborted then,
 * so the database stays as it was and the connection it opened is closed: nothing is left open behind the memory
 * store.
 */
export async function openIndexedDbStore(options: IndexedDbStoreOptions): Promise<KeyValueStore & { close(): void }> {
  try {
    const db = await new Promise<IdbDatabaseLike>((resolve, reject) => {
      const request = idb().factory.open(options.dbName, options.version ?? 1);
      // True once the promise is settled. The browser does not end a blocked open: it goes on when the other tab
      // closes the database, after the store has answered from memory, and what it opens then is nobody's.
      let answered = false;
      const refuse = (reason: unknown): void => {
        answered = true;
        reject(reason);
      };
      request.onupgradeneeded = () => {
        if (answered && request.transaction) {
          // Aborting the upgrade fails the open, which closes its connection and leaves the database as it was.
          request.transaction.abort();
          return;
        }
        if (!request.result.objectStoreNames.contains(options.storeName)) request.result.createObjectStore(options.storeName);
      };
      request.onsuccess = () => {
        if (answered) {
          // An open that succeeds after the answer (an upgrade that could not be aborted) is closed at once.
          request.result.close();
          return;
        }
        answered = true;
        resolve(request.result);
      };
      request.onerror = () => refuse(request.error);
      request.onblocked = () => refuse(new Error('the database is held open by another tab at an older version'));
    });
    return new IndexedDbKeyValueStore(db, options.storeName);
  } catch {
    const memory = new MemoryKeyValueStore();
    return Object.assign(memory, { close: () => undefined });
  }
}
