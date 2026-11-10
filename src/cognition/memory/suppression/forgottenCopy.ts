/**
 * @module memory/suppression/forgottenCopy
 *
 * Opens the file that holds the second copy of a store's forgotten-user ledger: a SQLite database of its own, kept
 * outside the store's database so that a restore of the store does not replace it.
 */
import * as fs from 'node:fs';
import { createStorageFeatures, resolveStorageAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';

/**
 * Opens the SQLite file that holds the tombstone copy, made when missing, with `secure_delete` on. The file keeps
 * SQLite's default rollback journal, so a closed copy is one file. `existed` tells whether the file was there before.
 *
 * The caller closes the adapter.
 *
 * @example
 * const { adapter: copy } = await openForgottenCopy('./memory/.store/forgotten.sqlite');
 * const ledger = await ForgottenLedger.open({ primary: storeAdapter, copy });
 */
export async function openForgottenCopy(filePath: string): Promise<{ adapter: StorageAdapter; existed: boolean }> {
  const existed = fs.existsSync(filePath);
  const adapter = await resolveStorageAdapter({ filePath, priority: ['better-sqlite3', 'sqljs'], quiet: true });
  const secure = createStorageFeatures(adapter).dialect.pragma('secure_delete', 'ON');
  if (secure) await adapter.exec(secure);
  return { adapter, existed };
}
