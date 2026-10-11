import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';

import { idb, type IdbDatabaseLike } from '../idb.js';
import { openIndexedDbStore } from '../IndexedDbKeyValueStore.js';

describe('openIndexedDbStore', () => {
  it('opens a database another page made, reads its values in place and changes nothing of its shape', async () => {
    await new Promise<void>((resolve, reject) => {
      const request = idb().factory.open('made-before', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('kv');
      };
      request.onsuccess = () => {
        const tx = request.result.transaction('kv', 'readwrite');
        tx.objectStore('kv').put({ text: '## Note | kw: a', saved: 1 }, 'acct/cards');
        tx.oncomplete = () => {
          request.result.close();
          resolve();
        };
      };
      request.onerror = () => reject(request.error);
    });
    const store = await openIndexedDbStore({ dbName: 'made-before', storeName: 'kv' });
    expect(store.memoryOnly).toBe(false);
    expect(await store.get('acct/cards')).toEqual({ text: '## Note | kw: a', saved: 1 });
    await store.set('acct/lib/s/1', { title: 'One', bytes: new Uint8Array([1, 2]).buffer });
    expect(await store.keys('acct/lib/')).toEqual(['acct/lib/s/1']);
    await store.deletePrefix('acct/lib/');
    expect(await store.keys('acct/')).toEqual(['acct/cards']);
    store.close();
  });

  it('answers from memory when IndexedDB is refused', async () => {
    const scope = globalThis as unknown as { indexedDB: unknown };
    const original = scope.indexedDB;
    Object.defineProperty(globalThis, 'indexedDB', { value: { open: () => { throw new Error('denied'); } }, configurable: true, writable: true });
    try {
      const store = await openIndexedDbStore({ dbName: 'x', storeName: 'kv' });
      expect(store.memoryOnly).toBe(true);
      await store.set('k', 1);
      expect(await store.get('k')).toBe(1);
    } finally {
      Object.defineProperty(globalThis, 'indexedDB', { value: original, configurable: true, writable: true });
    }
  });

  it('rejects with the error of a write that fails inside its transaction', async () => {
    // A database another page made, whose object store takes each title once: the second write of a title is refused
    // after its transaction has started, which is how a browser reports a write it cannot keep.
    await new Promise<void>((resolve, reject) => {
      const request = idb().factory.open('one-title', 1);
      request.onupgradeneeded = () => {
        const made = request.result.createObjectStore('kv') as {
          createIndex(name: string, keyPath: string, options: { unique: boolean }): unknown;
        };
        made.createIndex('title', 'title', { unique: true });
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
    const store = await openIndexedDbStore({ dbName: 'one-title', storeName: 'kv' });
    await store.set('a', { title: 'One' });
    const refused: unknown = await store.set('b', { title: 'One' }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((refused as { name?: unknown } | null | undefined)?.name).toBe('ConstraintError');
    expect(await store.keys('')).toEqual(['a']);
    store.close();
  });

  it('leaves nothing open when an upgrade that waited on another tab has its turn after the store answered from memory', async () => {
    // Another tab holds the database at version 1 and does not close it for a newer version, so the store's open at
    // version 2 is blocked and the store answers from memory.
    const otherTab = await new Promise<IdbDatabaseLike>((resolve, reject) => {
      const request = idb().factory.open('held-by-another-tab', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('kv');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const store = await openIndexedDbStore({ dbName: 'held-by-another-tab', storeName: 'kv', version: 2 });
    expect(store.memoryOnly).toBe(true);
    // The other tab lets go, and the blocked open has its turn. Opens of one database run in the order they were
    // asked for, so the two below run after it.
    otherTab.close();
    const version = await new Promise<number>((resolve, reject) => {
      const request = idb().factory.open('held-by-another-tab');
      request.onsuccess = () => {
        const opened = request.result as unknown as { version: number; close(): void };
        opened.close();
        resolve(opened.version);
      };
      request.onerror = () => reject(request.error);
    });
    expect(version).toBe(1);
    // An open at a newer version is blocked while any other connection to the database is open.
    const outcome = await new Promise<'opened' | 'blocked'>((resolve, reject) => {
      const request = idb().factory.open('held-by-another-tab', 3);
      request.onblocked = () => resolve('blocked');
      request.onsuccess = () => {
        request.result.close();
        resolve('opened');
      };
      request.onerror = () => reject(request.error);
    });
    expect(outcome).toBe('opened');
  });
});
