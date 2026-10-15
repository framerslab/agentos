import { describe, expect, it } from 'vitest';
import { resolveStorageAdapter } from '@framers/sql-storage-adapter';
import { COMPOUND_CREDIT_DDL, compoundCreditDdl, SqlCompoundCreditStore } from '../SqlCompoundCreditStore.js';
import { runCompoundCreditStoreContract } from './compoundCreditStore.contract.js';
import { runCompoundCreditLedgerContract } from './compoundCreditLedger.contract.js';

let n = 0;
async function make() {
  const db = await resolveStorageAdapter({ filePath: ':memory:', priority: ['better-sqlite3', 'sqljs'], quiet: true });
  return { store: new SqlCompoundCreditStore({ db, tablePrefix: `credit_${(n += 1)}`, requireShared: false }), id: (s: string) => s };
}

runCompoundCreditStoreContract('sqlite', make, { concurrent: false });
runCompoundCreditLedgerContract('sqlite', make, { concurrent: false });

describe('compoundCreditDdl', () => {
  it('names seven tables and their indexes under a prefix, and refuses a prefix that does not fit an identifier', () => {
    const ddl = compoundCreditDdl('acme_credit');
    for (const table of ['accounts', 'lots', 'holds', 'allocations', 'attempts', 'entries', 'supplier_days']) {
      expect(ddl).toContain(`CREATE TABLE IF NOT EXISTS acme_credit_${table} (`);
    }
    expect(ddl).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_acme_credit_lots_funding ON acme_credit_lots (scope_id, funding_ref)');
    expect(ddl).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_acme_credit_holds_operation ON acme_credit_holds (scope_id, operation_id)');
    expect(ddl).not.toContain('?');
    expect(compoundCreditDdl()).toBe(COMPOUND_CREDIT_DDL);
    expect(() => compoundCreditDdl('9bad')).toThrow();
    expect(() => compoundCreditDdl('a'.repeat(39))).toThrow();
  });

  it('serialises to a marker, never its adapter', async () => {
    const db = await resolveStorageAdapter({ filePath: ':memory:', priority: ['better-sqlite3', 'sqljs'], quiet: true });
    expect(JSON.stringify({ store: new SqlCompoundCreditStore({ db, requireShared: false }) })).toBe('{"store":"[SqlCompoundCreditStore]"}');
  });

  it('refuses a store several processes cannot share unless told it is one process', async () => {
    const db = await resolveStorageAdapter({ filePath: ':memory:', priority: ['better-sqlite3', 'sqljs'], quiet: true });
    expect(() => new SqlCompoundCreditStore({ db })).toThrow(/several processes/);
  });
});
