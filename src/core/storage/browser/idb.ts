/**
 * @fileoverview The part of IndexedDB the key-value store calls, typed structurally: AgentOS compiles without the DOM
 * library, and a page's IndexedDB satisfies these shapes.
 * @module agentos/core/storage/browser/idb
 */

/** A request's outcome and its two events. */
export interface IdbRequestLike<T> {
  /** What the request answered, once it is done. */
  readonly result: T;
  /** Why the request failed, once it is done; null when it did not. */
  readonly error: unknown;
  /** Called when the request has succeeded. */
  onsuccess: (() => void) | null;
  /** Called when the request has failed. */
  onerror: (() => void) | null;
}

/** A key range; only made and passed on. */
export type IdbKeyRangeLike = object;

/** The object store's calls the store makes. */
export interface IdbObjectStoreLike {
  /** Reads the value under a key. */
  get(key: string): IdbRequestLike<unknown>;
  /** Writes a value under a key, in place of what was there. */
  put(value: unknown, key: string): IdbRequestLike<unknown>;
  /** Removes one key, or every key of a range. */
  delete(key: string | IdbKeyRangeLike): IdbRequestLike<unknown>;
  /** Removes every key. */
  clear(): IdbRequestLike<unknown>;
  /** Lists the keys of a range, or every key. */
  getAllKeys(range?: IdbKeyRangeLike): IdbRequestLike<unknown[]>;
}

/** A transaction and its three events. */
export interface IdbTransactionLike {
  /** Why the transaction was aborted; null until it is, and after a plain abort. */
  readonly error: unknown;
  /** One of the object stores the transaction was opened over. */
  objectStore(name: string): IdbObjectStoreLike;
  /** Called when everything the transaction did is kept. */
  oncomplete: (() => void) | null;
  /** Called when one of the transaction's requests has failed, before the transaction is aborted for it. */
  onerror: (() => void) | null;
  /** Called when the transaction is aborted and nothing it did is kept. */
  onabort: (() => void) | null;
}

/** An open database. */
export interface IdbDatabaseLike {
  /** The names of the database's object stores. */
  readonly objectStoreNames: { contains(name: string): boolean };
  /** Makes an object store with out-of-line keys; only inside an upgrade. */
  createObjectStore(name: string): unknown;
  /** Opens a transaction over one object store. */
  transaction(storeName: string, mode: 'readonly' | 'readwrite'): IdbTransactionLike;
  /** Closes the connection once its transactions are done. */
  close(): void;
}

/** The request `open` answers. */
export interface IdbOpenRequestLike extends IdbRequestLike<IdbDatabaseLike> {
  /** The upgrade's transaction while `onupgradeneeded` runs; null outside it. */
  readonly transaction: { abort(): void } | null;
  /** Called when the database is new or older than the version asked for, inside the upgrade. */
  onupgradeneeded: (() => void) | null;
  /** Called when an upgrade waits for another connection to close. */
  onblocked: (() => void) | null;
}

/** The page's `indexedDB` and `IDBKeyRange`, or an error when the page has none. */
export function idb(): { factory: { open(name: string, version?: number): IdbOpenRequestLike }; keyRange: { bound(lower: string, upper: string): IdbKeyRangeLike } } {
  const scope = globalThis as unknown as {
    indexedDB?: { open(name: string, version?: number): IdbOpenRequestLike };
    IDBKeyRange?: { bound(lower: string, upper: string): IdbKeyRangeLike };
  };
  if (!scope.indexedDB || !scope.IDBKeyRange) throw new Error('IndexedDB is not available here.');
  return { factory: scope.indexedDB, keyRange: scope.IDBKeyRange };
}
