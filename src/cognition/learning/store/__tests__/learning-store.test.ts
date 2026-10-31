/**
 * @file learning-store.test.ts
 * The learning store contract run against the in-process store, and what the in-process store adds to it: calls run
 * one at a time in the order they are made, so a read made while a transaction runs waits for it and reads what it
 * committed, and a transaction's handle refuses every call once its transaction has ended.
 */
import { describe, expect, it } from 'vitest';
import { InMemoryLearningStore } from '../InMemoryLearningStore.js';
import type { LearningStoreTx } from '../LearningStore.js';
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

  it("refuses every call on a transaction's handle once its transaction has ended", async () => {
    const store = new InMemoryLearningStore();
    const handles: LearningStoreTx[] = [];
    await store.transaction(async (tx) => {
      handles.push(tx);
    });
    await expect(
      store.transaction(async (tx) => {
        handles.push(tx);
        throw new Error('the change failed');
      }),
    ).rejects.toThrow('the change failed');

    expect(handles).toHaveLength(2);
    for (const tx of handles) {
      await expect(tx.insertLedgerRow(ledgerRow({ id: 'late' }))).rejects.toThrow(/ended/);
      await expect(tx.insertTraitRow(traitRow())).rejects.toThrow(/ended/);
      await expect(tx.ledgerRow('late')).rejects.toThrow(/ended/);
    }
    expect(await store.ledgerRow('late')).toBeUndefined();
    expect(await store.traitRow('A', 'tutor', '42')).toBeUndefined();
  });
});
