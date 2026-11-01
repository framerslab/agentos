/**
 * @file learning-store.test.ts
 * The learning store contract run against the in-process store, and what the in-process store adds to it: calls run
 * one at a time in the order they are made, so a read made while a transaction runs waits for it and reads what it
 * committed.
 */
import { describe, expect, it } from 'vitest';
import { InMemoryLearningStore } from '../InMemoryLearningStore.js';
import { ledgerRow, runLearningStoreContract, traitRow } from './learning-store.contract.js';

runLearningStoreContract('InMemoryLearningStore', async () => new InMemoryLearningStore());

describe('InMemoryLearningStore', () => {
  it('reads what a transaction committed when the read is made while that transaction runs', async () => {
    const store = new InMemoryLearningStore();
    let wrote!: () => void;
    const written = new Promise<void>((resolve) => {
      wrote = resolve;
    });
    let finish!: () => void;
    const finishing = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const transaction = store.transaction(async (tx) => {
      await tx.insertLedgerRow(ledgerRow({ id: 'r-1' }));
      wrote();
      await finishing;
      await tx.insertTraitRow(traitRow());
      return 'committed';
    });
    await Promise.race([written, transaction]);

    const reads = Promise.all([store.ledgerRow('r-1'), store.traitRow('A', 'tutor', '42')]);
    finish();

    expect(await transaction).toBe('committed');
    const [row, trait] = await reads;
    expect(row).toMatchObject({ id: 'r-1' });
    expect(trait).toMatchObject({ namespace: 'A', userId: '42', version: 1 });
  });
});
