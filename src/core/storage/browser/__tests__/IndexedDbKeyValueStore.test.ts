import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';

import { idb } from '../idb.js';
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
});
