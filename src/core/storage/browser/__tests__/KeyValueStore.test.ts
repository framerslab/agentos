import { describe, expect, it } from 'vitest';

import { MemoryKeyValueStore, namespaced } from '../KeyValueStore.js';

describe('MemoryKeyValueStore and namespaced', () => {
  it('gets, sets, lists by prefix and deletes by prefix', async () => {
    const store = new MemoryKeyValueStore();
    await store.set('a/1', { n: 1 });
    await store.set('a/2', { n: 2 });
    await store.set('b/1', 'x');
    expect(await store.get('a/1')).toEqual({ n: 1 });
    expect(await store.keys('a/')).toEqual(['a/1', 'a/2']);
    await store.deletePrefix('a/');
    expect(await store.keys('')).toEqual(['b/1']);
    expect(store.memoryOnly).toBe(true);
  });

  it('keeps two namespaces apart', async () => {
    const store = new MemoryKeyValueStore();
    const ann = namespaced(store, 'ann/');
    const bob = namespaced(store, 'bob/');
    await ann.set('notes', 'mine');
    expect(await bob.get('notes')).toBeUndefined();
    expect(await ann.keys('')).toEqual(['notes']);
    await bob.set('notes', 'his');
    await ann.deletePrefix('');
    expect(await bob.get('notes')).toBe('his');
    expect(await store.keys('')).toEqual(['bob/notes']);
  });

  it('hands out copies, as a structured clone would', async () => {
    const store = new MemoryKeyValueStore();
    const value = { list: [1] };
    await store.set('k', value);
    value.list.push(2);
    const read = await store.get<{ list: number[] }>('k');
    read?.list.push(3);
    expect(await store.get('k')).toEqual({ list: [1] });
  });
});
