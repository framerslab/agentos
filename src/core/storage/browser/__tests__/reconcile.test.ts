import { describe, expect, it } from 'vitest';

import { reconcileList } from '../reconcile.js';

describe('reconcileList', () => {
  const local = [
    { id: 'a', version: 1, pending: false },
    { id: 'b', version: 3, pending: false },
    { id: 'c', version: 1, pending: true },
    { id: 'd', version: 1, pending: false },
  ];

  it('fetches what is new or newer, removes what the server deleted, keeps what waits', () => {
    expect(reconcileList(local, { items: [{ id: 'a', version: 2 }, { id: 'b', version: 3 }, { id: 'e', version: 1 }], deleted: ['c', 'd'], complete: false })).toEqual({
      fetch: ['a', 'e'],
      remove: ['d'],
    });
  });

  it('after a complete list, removes what it does not name unless it waits', () => {
    expect(reconcileList(local, { items: [{ id: 'a', version: 1 }], deleted: [], complete: true })).toEqual({ fetch: [], remove: ['b', 'd'] });
  });

  it('fetches an entry the device lacks whatever its version, and keeps one an incomplete list leaves out', () => {
    expect(reconcileList([{ id: 'kept', version: 1, pending: false }], { items: [{ id: 'new', version: -1 }], deleted: [], complete: false })).toEqual({
      fetch: ['new'],
      remove: [],
    });
  });
});
