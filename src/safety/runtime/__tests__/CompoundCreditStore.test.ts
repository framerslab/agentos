import { describe, expect, it } from 'vitest';
import { creditDay, InMemoryCompoundCreditStore } from '../CompoundCreditStore.js';
import { runCompoundCreditStoreContract } from './compoundCreditStore.contract.js';

runCompoundCreditStoreContract('memory', async () => ({ store: new InMemoryCompoundCreditStore(), id: (s) => s }), { concurrent: true });

describe('creditDay', () => {
  it('is the UTC day of a time', () => {
    expect(creditDay(Date.UTC(2026, 9, 12, 23, 59, 59))).toBe('2026-10-12');
    expect(creditDay(Date.UTC(2026, 9, 13, 0, 0, 0))).toBe('2026-10-13');
  });
});

describe('InMemoryCompoundCreditStore', () => {
  it('hands out copies, so a row changed outside a transaction changes nothing stored', async () => {
    const store = new InMemoryCompoundCreditStore();
    await store.withTransaction((trx) => trx.putAccount({ scopeId: 's', currency: 'USD', frozen: false, openDisputes: 0, createdAt: 1, version: 1 }));
    const read = await store.withTransaction((trx) => trx.lockAccount('s'));
    read!.frozen = true;
    expect((await store.withTransaction((trx) => trx.lockAccount('s')))?.frozen).toBe(false);
  });
});
