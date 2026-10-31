/**
 * The browser key-value store in Chromium and in WebKit: the names a page imports from the storage entry are the
 * library's own functions, and a database written by the store as AgentOS 0.13.141 shipped it is read in place, key for
 * key, with its version and its object store as they were. The writer below is that store, cut to what writing takes:
 * the open, the upgrade and the put of src/core/storage/browser/IndexedDbKeyValueStore.ts at the tag v0.13.141, a file
 * unchanged since 91377cf2 (the store's first commit) through v0.15.2.
 */
import { describe, expect, it } from 'vitest';

import * as library from '@framers/sql-storage-adapter/kv';
import * as entry from '../index.js';
import { namespaced, openIndexedDbStore } from '../index.js';

/** The names the entry takes from the library. */
const FROM_THE_LIBRARY = ['MemoryKeyValueStore', 'namespaced', 'IndexedDbKeyValueStore', 'openIndexedDbStore', 'idb', 'createSqlKeyValueStore'] as const;

/** A request's outcome and its two events, as 0.13.141's idb.ts typed them. */
interface LegacyRequest<T> {
  readonly result: T;
  readonly error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

/** The part of an open database the writer and the shape check use. */
interface LegacyDatabase {
  readonly version: number;
  readonly objectStoreNames: { readonly length: number; contains(name: string): boolean };
  createObjectStore(name: string): unknown;
  transaction(
    storeName: string,
    mode: 'readonly' | 'readwrite',
  ): {
    readonly error: unknown;
    objectStore(name: string): { put(value: unknown, key: string): LegacyRequest<unknown> };
    oncomplete: (() => void) | null;
    onerror: (() => void) | null;
    onabort: (() => void) | null;
  };
  close(): void;
}

/** The request `open` answers. */
interface LegacyOpenRequest extends LegacyRequest<LegacyDatabase> {
  onupgradeneeded: (() => void) | null;
  onblocked: (() => void) | null;
}

/** The page's `indexedDB`, read as 0.13.141's `idb()` read it: structurally, without the DOM library. */
function legacyIdb(): { open(name: string, version?: number): LegacyOpenRequest } {
  const scope = globalThis as unknown as { indexedDB?: { open(name: string, version?: number): LegacyOpenRequest } };
  if (!scope.indexedDB) throw new Error('IndexedDB is not available here.');
  return scope.indexedDB;
}

/**
 * 0.13.141's `openIndexedDbStore`, the open and the upgrade: the database at version 1 unless given, the object store
 * made only when the open upgrades the database and it is missing.
 */
function legacyOpen(dbName: string, storeName: string, version = 1): Promise<LegacyDatabase> {
  return new Promise((resolve, reject) => {
    const request = legacyIdb().open(dbName, version);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('the database is held open by another tab at an older version'));
  });
}

/** 0.13.141's `IndexedDbKeyValueStore.set`: one readwrite transaction, `put(value, key)`, fulfilled when it completes. */
function legacySet(db: LegacyDatabase, storeName: string, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    const request = transaction.objectStore(storeName).put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? request.error ?? new Error('IndexedDB request failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** Writes `values` into `dbName`/`storeName` as a page on 0.13.141 did, one transaction a key, and closes the database. */
async function writtenBy0_13_141(dbName: string, storeName: string, values: Record<string, unknown>): Promise<void> {
  const db = await legacyOpen(dbName, storeName);
  try {
    for (const [key, value] of Object.entries(values)) await legacySet(db, storeName, key, value);
  } finally {
    db.close();
  }
}

/** The database's version and its number of object stores, through a connection of its own opened at the version it has. */
async function shapeOf(dbName: string): Promise<{ version: number; stores: number }> {
  const db = await new Promise<LegacyDatabase>((resolve, reject) => {
    const request = legacyIdb().open(dbName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return { version: db.version, stores: db.objectStoreNames.length };
  } finally {
    db.close();
  }
}

/** A database name no other test uses. */
const unique = (name: string): string => `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

describe('the browser key-value store, in the browser', () => {
  it("is the library's: each name the entry exports is the function the library exports", () => {
    const own = entry as Record<string, unknown>;
    const theirs = library as Record<string, unknown>;
    for (const name of FROM_THE_LIBRARY) {
      expect(own[name], name).toBeDefined();
      expect(own[name], name).toBe(theirs[name]);
    }
  });

  it('reads every key of a database the 0.13.141 store wrote, in place, as it was written', async () => {
    const dbName = unique('written-by-0-13-141');
    const written: Record<string, unknown> = {
      'acct/cards': { text: '## Note | kw: a', saved: 1 },
      'acct/lib/s/1': { title: 'One', turns: [{ at: 0, words: 'hello' }], marks: new Map([['m1', { at: 3 }]]) },
      'acct/lib/s/2': { title: 'Two', tags: new Set(['a', 'b']), when: new Date(1_700_000_000_000) },
      'acct/settings': { theme: 'dark', fontPx: 16, dense: false, note: null },
      'acct/bytes': new Uint8Array([1, 2, 3, 255]),
      'other/cards': 'a string',
      z: 42,
    };
    await writtenBy0_13_141(dbName, 'kv', written);

    const store = await openIndexedDbStore({ dbName, storeName: 'kv' });
    try {
      expect(store.memoryOnly).toBe(false);
      expect(await store.keys('')).toEqual(Object.keys(written).sort());
      for (const [key, value] of Object.entries(written)) expect(await store.get(key), key).toEqual(value);
      // A namespaced store answers its keys without the namespace, with the prefix asked for still on them.
      expect(await namespaced(store, 'acct/').keys('lib/')).toEqual(['lib/s/1', 'lib/s/2']);
    } finally {
      store.close();
    }
    // Opened as it was: the same version, the one object store.
    expect(await shapeOf(dbName)).toEqual({ version: 1, stores: 1 });
  });
});
