/**
 * @fileoverview {@link ICompoundCreditStore} over a `@framers/sql-storage-adapter` store: Postgres for a deployment,
 * SQLite for one process and the tests. Every operation of the ledger is one transaction; its first statement on an
 * account takes the account row's lock with a write, so two transactions on one account queue there; every versioned
 * write is a compare-and-set that must change exactly one row. Table names come from a checked prefix, so stores with
 * different prefixes share one database apart. A host that runs its own migrations copies {@link compoundCreditDdl}'s
 * text for its prefix and passes `ensureSchema: false`. A host whose own writes must commit with the credit rows passes
 * its open adapter transaction to {@link SqlCompoundCreditStore.withStorageTransaction}.
 *
 * Give the store an adapter of its own (or the host's own pool), never a provenance-wrapped adapter whose write hooks
 * can turn a `run()` into a no-op.
 *
 * @module safety/runtime/SqlCompoundCreditStore
 */
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import {
  CreditConflictError,
  type CreditAccountRow,
  type CreditAllocationRow,
  type CreditAttemptRow,
  type CreditDocumentRow,
  type CreditEntryFilter,
  type CreditEntryRow,
  type CreditHoldFilter,
  type CreditHoldRow,
  type CreditLotRow,
  type CreditTransaction,
  type ICompoundCreditStore,
  type SupplierDayRow,
} from './CompoundCreditStore.js';

/** The prefix when none is given. */
const DEFAULT_PREFIX = 'agentos_credit';

/**
 * A lower-case letter, then at most 37 lower-case letters, digits or underscores: the longest name the store gives,
 * `idx_<prefix>_entries_scope_day`, then fits the 63 bytes of a Postgres identifier.
 */
const TABLE_PREFIX = /^[a-z][a-z0-9_]{0,37}$/;

/** The names one prefix gives the store's tables. */
interface CreditTables {
  prefix: string;
  accounts: string;
  lots: string;
  holds: string;
  allocations: string;
  attempts: string;
  entries: string;
  supplierDays: string;
  documents: string;
}

function creditTables(tablePrefix: string | undefined): CreditTables {
  const prefix = tablePrefix ?? DEFAULT_PREFIX;
  if (typeof prefix !== 'string' || !TABLE_PREFIX.test(prefix)) {
    throw new Error(`A credit store's tablePrefix is a lower-case letter and at most 37 more lower-case letters, digits or underscores; got ${JSON.stringify(prefix)}.`);
  }
  return {
    prefix,
    accounts: `${prefix}_accounts`,
    lots: `${prefix}_lots`,
    holds: `${prefix}_holds`,
    allocations: `${prefix}_allocations`,
    attempts: `${prefix}_attempts`,
    entries: `${prefix}_entries`,
    supplierDays: `${prefix}_supplier_days`,
    documents: `${prefix}_documents`,
  };
}

function ddlOf(t: CreditTables): string {
  return `
CREATE TABLE IF NOT EXISTS ${t.accounts} (
  scope_id TEXT PRIMARY KEY,
  currency TEXT NOT NULL,
  frozen INTEGER NOT NULL DEFAULT 0,
  open_disputes BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  version BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS ${t.lots} (
  lot_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('paid', 'promotion')),
  funding_ref TEXT NOT NULL,
  principal_micro BIGINT NOT NULL,
  consumed_micro BIGINT NOT NULL,
  held_micro BIGINT NOT NULL,
  refunded_micro BIGINT NOT NULL,
  retired_micro BIGINT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'disputed', 'closed')),
  expires_at BIGINT,
  created_at BIGINT NOT NULL,
  version BIGINT NOT NULL,
  CHECK (consumed_micro >= 0 AND held_micro >= 0 AND refunded_micro >= 0 AND retired_micro >= 0),
  CHECK (consumed_micro + held_micro + refunded_micro + retired_micro <= principal_micro)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_${t.prefix}_lots_funding ON ${t.lots} (scope_id, funding_ref);
CREATE TABLE IF NOT EXISTS ${t.holds} (
  hold_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  customer_micro BIGINT NOT NULL,
  supplier_micro BIGINT NOT NULL,
  media_customer_micro BIGINT NOT NULL,
  media_supplier_micro BIGINT NOT NULL,
  attempt_customer_micro BIGINT NOT NULL,
  attempt_supplier_micro BIGINT NOT NULL,
  max_attempts BIGINT NOT NULL,
  attempt_limits TEXT NOT NULL,
  rate_version TEXT NOT NULL,
  rates TEXT NOT NULL,
  media_component TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('held', 'deferred', 'settled', 'released')),
  charged_micro BIGINT NOT NULL,
  supplier_settled_micro BIGINT NOT NULL,
  supplier_open_micro BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  settled_at BIGINT,
  deferred_until BIGINT,
  fence_evidence TEXT,
  version BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_${t.prefix}_holds_operation ON ${t.holds} (scope_id, operation_id);
CREATE INDEX IF NOT EXISTS idx_${t.prefix}_holds_due ON ${t.holds} (state, expires_at);
CREATE TABLE IF NOT EXISTS ${t.allocations} (
  hold_id TEXT NOT NULL,
  seq BIGINT NOT NULL,
  lot_id TEXT NOT NULL,
  amount_micro BIGINT NOT NULL,
  consumed_micro BIGINT NOT NULL,
  released_micro BIGINT NOT NULL,
  retired_micro BIGINT NOT NULL,
  settled INTEGER NOT NULL,
  PRIMARY KEY (hold_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_${t.prefix}_allocations_lot ON ${t.allocations} (lot_id);
CREATE TABLE IF NOT EXISTS ${t.attempts} (
  hold_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  seq BIGINT NOT NULL,
  purpose TEXT NOT NULL,
  rate_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('authorized', 'recorded')),
  usage_json TEXT,
  is_final INTEGER NOT NULL,
  authorized_at BIGINT NOT NULL,
  recorded_at BIGINT,
  version BIGINT NOT NULL,
  PRIMARY KEY (hold_id, attempt_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_${t.prefix}_attempts_seq ON ${t.attempts} (hold_id, seq);
CREATE TABLE IF NOT EXISTS ${t.entries} (
  entry_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount_micro BIGINT NOT NULL,
  lot_id TEXT,
  hold_id TEXT,
  ref TEXT,
  entry_at BIGINT NOT NULL,
  entry_day TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_${t.prefix}_entries_scope_day ON ${t.entries} (scope_id, entry_day);
CREATE TABLE IF NOT EXISTS ${t.supplierDays} (
  day_utc TEXT PRIMARY KEY,
  settled_micro BIGINT NOT NULL,
  version BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS ${t.documents} (
  scope_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  value_json TEXT NOT NULL,
  version BIGINT NOT NULL,
  PRIMARY KEY (scope_id, document_id)
);
`;
}

/** The store's tables and indexes under a prefix; the default prefix answers {@link COMPOUND_CREDIT_DDL}. */
export function compoundCreditDdl(tablePrefix?: string): string {
  return ddlOf(creditTables(tablePrefix));
}

/** The DDL under the default prefix, `agentos_credit`. */
export const COMPOUND_CREDIT_DDL = compoundCreditDdl();

/** How a {@link SqlCompoundCreditStore} is made. */
export interface SqlCompoundCreditStoreOptions {
  db: StorageAdapter;
  /** The start of the tables' names; `agentos_credit` when absent. */
  tablePrefix?: string;
  /** Create the tables when missing. Default true; false when the host's migrations make them. */
  ensureSchema?: boolean;
  /** Refuse a store several processes cannot share. Default true; a single process and the tests pass false. */
  requireShared?: boolean;
}

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

type Row = Record<string, unknown>;

const toAccount = (r: Row): CreditAccountRow => ({
  scopeId: String(r.scope_id), currency: 'USD', frozen: num(r.frozen) === 1, openDisputes: num(r.open_disputes), createdAt: num(r.created_at), version: num(r.version),
});
const toLot = (r: Row): CreditLotRow => ({
  lotId: String(r.lot_id), scopeId: String(r.scope_id), kind: r.kind as CreditLotRow['kind'], fundingRef: String(r.funding_ref),
  principalMicro: num(r.principal_micro), consumedMicro: num(r.consumed_micro), heldMicro: num(r.held_micro), refundedMicro: num(r.refunded_micro), retiredMicro: num(r.retired_micro),
  state: r.state as CreditLotRow['state'], expiresAt: numOrNull(r.expires_at), createdAt: num(r.created_at), version: num(r.version),
});
const toHold = (r: Row): CreditHoldRow => ({
  holdId: String(r.hold_id), scopeId: String(r.scope_id), operationId: String(r.operation_id), kind: String(r.kind), requestHash: String(r.request_hash),
  customerMicro: num(r.customer_micro), supplierMicro: num(r.supplier_micro), mediaCustomerMicro: num(r.media_customer_micro), mediaSupplierMicro: num(r.media_supplier_micro),
  attemptCustomerMicro: num(r.attempt_customer_micro), attemptSupplierMicro: num(r.attempt_supplier_micro), maxAttempts: num(r.max_attempts), attemptLimits: String(r.attempt_limits),
  rateVersion: String(r.rate_version), rates: String(r.rates), mediaComponent: String(r.media_component), state: r.state as CreditHoldRow['state'],
  chargedMicro: num(r.charged_micro), supplierSettledMicro: num(r.supplier_settled_micro), supplierOpenMicro: num(r.supplier_open_micro),
  createdAt: num(r.created_at), expiresAt: num(r.expires_at), settledAt: numOrNull(r.settled_at), deferredUntil: numOrNull(r.deferred_until), fenceEvidence: strOrNull(r.fence_evidence), version: num(r.version),
});
const toAllocation = (r: Row): CreditAllocationRow => ({
  holdId: String(r.hold_id), seq: num(r.seq), lotId: String(r.lot_id), amountMicro: num(r.amount_micro), consumedMicro: num(r.consumed_micro), releasedMicro: num(r.released_micro), retiredMicro: num(r.retired_micro), settled: num(r.settled) === 1,
});
const toAttempt = (r: Row): CreditAttemptRow => ({
  holdId: String(r.hold_id), attemptId: String(r.attempt_id), seq: num(r.seq), purpose: r.purpose as CreditAttemptRow['purpose'], rateVersion: String(r.rate_version),
  state: r.state as CreditAttemptRow['state'], usage: strOrNull(r.usage_json), final: num(r.is_final) === 1, authorizedAt: num(r.authorized_at), recordedAt: numOrNull(r.recorded_at), version: num(r.version),
});
const toEntry = (r: Row): CreditEntryRow => ({
  entryId: String(r.entry_id), scopeId: String(r.scope_id), kind: r.kind as CreditEntryRow['kind'], amountMicro: num(r.amount_micro), lotId: strOrNull(r.lot_id), holdId: strOrNull(r.hold_id), ref: strOrNull(r.ref), at: num(r.entry_at), day: String(r.entry_day),
});

const marks = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/** One transaction's rows over SQL. */
class SqlCreditTransaction implements CreditTransaction {
  constructor(private readonly db: StorageAdapter, private readonly t: CreditTables) {}

  /** Inserts a new row (version 1) or updates one at the version one below, or throws. */
  private async casWrite(table: string, key: string, version: number, insert: [string, unknown[]], update: [string, unknown[]]): Promise<void> {
    const [sql, params] = version === 1 ? insert : update;
    const result = await this.db.run(sql, params);
    if (result.changes !== 1) throw new CreditConflictError(table, key);
  }

  async lockAccount(scopeId: string): Promise<CreditAccountRow | undefined> {
    await this.db.run(`UPDATE ${this.t.accounts} SET version = version WHERE scope_id = ?`, [scopeId]);
    const row = await this.db.get<Row>(`SELECT * FROM ${this.t.accounts} WHERE scope_id = ?`, [scopeId]);
    return row ? toAccount(row) : undefined;
  }
  async putAccount(row: CreditAccountRow): Promise<void> {
    await this.casWrite(this.t.accounts, row.scopeId, row.version,
      [`INSERT INTO ${this.t.accounts} (scope_id, currency, frozen, open_disputes, created_at, version) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`, [row.scopeId, row.currency, row.frozen ? 1 : 0, row.openDisputes, row.createdAt, row.version]],
      [`UPDATE ${this.t.accounts} SET frozen = ?, open_disputes = ?, version = ? WHERE scope_id = ? AND version = ?`, [row.frozen ? 1 : 0, row.openDisputes, row.version, row.scopeId, row.version - 1]]);
  }
  async listLots(scopeId: string): Promise<CreditLotRow[]> {
    return (await this.db.all<Row>(`SELECT * FROM ${this.t.lots} WHERE scope_id = ? ORDER BY created_at, lot_id`, [scopeId])).map(toLot);
  }
  async getLot(lotId: string): Promise<CreditLotRow | undefined> {
    const row = await this.db.get<Row>(`SELECT * FROM ${this.t.lots} WHERE lot_id = ?`, [lotId]);
    return row ? toLot(row) : undefined;
  }
  async findLotByFundingRef(scopeId: string, fundingRef: string): Promise<CreditLotRow | undefined> {
    const row = await this.db.get<Row>(`SELECT * FROM ${this.t.lots} WHERE scope_id = ? AND funding_ref = ?`, [scopeId, fundingRef]);
    return row ? toLot(row) : undefined;
  }
  async putLot(row: CreditLotRow): Promise<void> {
    await this.casWrite(this.t.lots, row.lotId, row.version,
      [`INSERT INTO ${this.t.lots} (lot_id, scope_id, kind, funding_ref, principal_micro, consumed_micro, held_micro, refunded_micro, retired_micro, state, expires_at, created_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
       [row.lotId, row.scopeId, row.kind, row.fundingRef, row.principalMicro, row.consumedMicro, row.heldMicro, row.refundedMicro, row.retiredMicro, row.state, row.expiresAt, row.createdAt, row.version]],
      [`UPDATE ${this.t.lots} SET consumed_micro = ?, held_micro = ?, refunded_micro = ?, retired_micro = ?, state = ?, expires_at = ?, version = ? WHERE lot_id = ? AND version = ?`,
       [row.consumedMicro, row.heldMicro, row.refundedMicro, row.retiredMicro, row.state, row.expiresAt, row.version, row.lotId, row.version - 1]]);
  }
  async getHold(holdId: string): Promise<CreditHoldRow | undefined> {
    const row = await this.db.get<Row>(`SELECT * FROM ${this.t.holds} WHERE hold_id = ?`, [holdId]);
    return row ? toHold(row) : undefined;
  }
  async findHoldByOperation(scopeId: string, operationId: string): Promise<CreditHoldRow | undefined> {
    const row = await this.db.get<Row>(`SELECT * FROM ${this.t.holds} WHERE scope_id = ? AND operation_id = ?`, [scopeId, operationId]);
    return row ? toHold(row) : undefined;
  }
  async putHold(row: CreditHoldRow): Promise<void> {
    await this.casWrite(this.t.holds, row.holdId, row.version,
      [`INSERT INTO ${this.t.holds} (hold_id, scope_id, operation_id, kind, request_hash, customer_micro, supplier_micro, media_customer_micro, media_supplier_micro,
          attempt_customer_micro, attempt_supplier_micro, max_attempts, attempt_limits, rate_version, rates, media_component, state, charged_micro,
          supplier_settled_micro, supplier_open_micro, created_at, expires_at, settled_at, deferred_until, fence_evidence, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
       [row.holdId, row.scopeId, row.operationId, row.kind, row.requestHash, row.customerMicro, row.supplierMicro, row.mediaCustomerMicro, row.mediaSupplierMicro,
        row.attemptCustomerMicro, row.attemptSupplierMicro, row.maxAttempts, row.attemptLimits, row.rateVersion, row.rates, row.mediaComponent, row.state, row.chargedMicro,
        row.supplierSettledMicro, row.supplierOpenMicro, row.createdAt, row.expiresAt, row.settledAt, row.deferredUntil, row.fenceEvidence, row.version]],
      [`UPDATE ${this.t.holds} SET state = ?, charged_micro = ?, supplier_settled_micro = ?, supplier_open_micro = ?, settled_at = ?, deferred_until = ?, fence_evidence = ?, version = ?
         WHERE hold_id = ? AND version = ?`,
       [row.state, row.chargedMicro, row.supplierSettledMicro, row.supplierOpenMicro, row.settledAt, row.deferredUntil, row.fenceEvidence, row.version, row.holdId, row.version - 1]]);
  }
  async listHolds(filter: CreditHoldFilter): Promise<CreditHoldRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.scopeId !== undefined) {
      where.push('scope_id = ?');
      params.push(filter.scopeId);
    }
    if (filter.states && filter.states.length > 0) {
      where.push(`state IN (${marks(filter.states.length)})`);
      params.push(...filter.states);
    }
    if (filter.dueAtOrBefore !== undefined) {
      where.push(`((state = 'deferred' AND COALESCE(deferred_until, expires_at) <= ?) OR (state <> 'deferred' AND expires_at <= ?))`);
      params.push(filter.dueAtOrBefore, filter.dueAtOrBefore);
    }
    const limit = Math.max(1, Math.trunc(filter.limit ?? 1_000));
    const sql = `SELECT * FROM ${this.t.holds}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at, hold_id LIMIT ${limit}`;
    return (await this.db.all<Row>(sql, params)).map(toHold);
  }
  async listAllocations(holdId: string): Promise<CreditAllocationRow[]> {
    return (await this.db.all<Row>(`SELECT * FROM ${this.t.allocations} WHERE hold_id = ? ORDER BY seq`, [holdId])).map(toAllocation);
  }
  async listAllocationsByLot(lotId: string): Promise<CreditAllocationRow[]> {
    return (await this.db.all<Row>(`SELECT * FROM ${this.t.allocations} WHERE lot_id = ? ORDER BY hold_id, seq`, [lotId])).map(toAllocation);
  }
  async putAllocation(row: CreditAllocationRow): Promise<void> {
    await this.db.run(
      `INSERT INTO ${this.t.allocations} (hold_id, seq, lot_id, amount_micro, consumed_micro, released_micro, retired_micro, settled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (hold_id, seq) DO UPDATE SET lot_id = excluded.lot_id, amount_micro = excluded.amount_micro, consumed_micro = excluded.consumed_micro,
         released_micro = excluded.released_micro, retired_micro = excluded.retired_micro, settled = excluded.settled`,
      [row.holdId, row.seq, row.lotId, row.amountMicro, row.consumedMicro, row.releasedMicro, row.retiredMicro, row.settled ? 1 : 0],
    );
  }
  async listAttempts(holdId: string): Promise<CreditAttemptRow[]> {
    return (await this.db.all<Row>(`SELECT * FROM ${this.t.attempts} WHERE hold_id = ? ORDER BY seq`, [holdId])).map(toAttempt);
  }
  async putAttempt(row: CreditAttemptRow): Promise<void> {
    await this.casWrite(this.t.attempts, `${row.holdId}/${row.attemptId}`, row.version,
      [`INSERT INTO ${this.t.attempts} (hold_id, attempt_id, seq, purpose, rate_version, state, usage_json, is_final, authorized_at, recorded_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
       [row.holdId, row.attemptId, row.seq, row.purpose, row.rateVersion, row.state, row.usage, row.final ? 1 : 0, row.authorizedAt, row.recordedAt, row.version]],
      [`UPDATE ${this.t.attempts} SET state = ?, usage_json = ?, is_final = ?, recorded_at = ?, version = ? WHERE hold_id = ? AND attempt_id = ? AND version = ?`,
       [row.state, row.usage, row.final ? 1 : 0, row.recordedAt, row.version, row.holdId, row.attemptId, row.version - 1]]);
  }
  async appendEntry(row: CreditEntryRow): Promise<boolean> {
    const result = await this.db.run(
      `INSERT INTO ${this.t.entries} (entry_id, scope_id, kind, amount_micro, lot_id, hold_id, ref, entry_at, entry_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [row.entryId, row.scopeId, row.kind, row.amountMicro, row.lotId, row.holdId, row.ref, row.at, row.day],
    );
    return result.changes === 1;
  }
  async getEntry(entryId: string): Promise<CreditEntryRow | undefined> {
    const row = await this.db.get<Row>(`SELECT * FROM ${this.t.entries} WHERE entry_id = ?`, [entryId]);
    return row ? toEntry(row) : undefined;
  }
  async listEntries(filter: CreditEntryFilter): Promise<CreditEntryRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.scopeId !== undefined) {
      where.push('scope_id = ?');
      params.push(filter.scopeId);
    }
    if (filter.kinds && filter.kinds.length > 0) {
      where.push(`kind IN (${marks(filter.kinds.length)})`);
      params.push(...filter.kinds);
    }
    if (filter.fromDay !== undefined) {
      where.push('entry_day >= ?');
      params.push(filter.fromDay);
    }
    if (filter.toDay !== undefined) {
      where.push('entry_day <= ?');
      params.push(filter.toDay);
    }
    const sql = `SELECT * FROM ${this.t.entries}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY entry_at, entry_id`;
    return (await this.db.all<Row>(sql, params)).map(toEntry);
  }
  async lockSupplierDay(day: string): Promise<SupplierDayRow> {
    await this.db.run(`INSERT INTO ${this.t.supplierDays} (day_utc, settled_micro, version) VALUES (?, 0, 0) ON CONFLICT DO NOTHING`, [day]);
    await this.db.run(`UPDATE ${this.t.supplierDays} SET version = version WHERE day_utc = ?`, [day]);
    const row = await this.db.get<Row>(`SELECT * FROM ${this.t.supplierDays} WHERE day_utc = ?`, [day]);
    return { day, settledMicro: num(row?.settled_micro), version: num(row?.version) };
  }
  async putSupplierDay(row: SupplierDayRow): Promise<void> {
    const result = await this.db.run(`UPDATE ${this.t.supplierDays} SET settled_micro = ?, version = ? WHERE day_utc = ? AND version = ?`, [row.settledMicro, row.version, row.day, row.version - 1]);
    if (result.changes !== 1) throw new CreditConflictError(this.t.supplierDays, row.day);
  }
  async openSupplierMicro(scopeId?: string): Promise<number> {
    const row = await this.db.get<Row>(
      `SELECT COALESCE(SUM(CASE
          WHEN state IN ('held', 'deferred') THEN CASE WHEN supplier_micro > supplier_settled_micro THEN supplier_micro - supplier_settled_micro ELSE 0 END
          ELSE supplier_open_micro END), 0) AS open_micro
         FROM ${this.t.holds}${scopeId === undefined ? '' : ' WHERE scope_id = ?'}`,
      scopeId === undefined ? [] : [scopeId],
    );
    return num(row?.open_micro);
  }
  async getDocument(scopeId: string, documentId: string): Promise<CreditDocumentRow | undefined> {
    const row = await this.db.get<Row>(
      `SELECT * FROM ${this.t.documents} WHERE scope_id = ? AND document_id = ?`, [scopeId, documentId],
    );
    return row ? { scopeId: String(row.scope_id), documentId: String(row.document_id),
      value: String(row.value_json), version: num(row.version) } : undefined;
  }
  async putDocument(row: CreditDocumentRow): Promise<void> {
    await this.casWrite(this.t.documents, JSON.stringify([row.scopeId, row.documentId]), row.version,
      [`INSERT INTO ${this.t.documents} (scope_id, document_id, value_json, version) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        [row.scopeId, row.documentId, row.value, row.version]],
      [`UPDATE ${this.t.documents} SET value_json = ?, version = ? WHERE scope_id = ? AND document_id = ? AND version = ?`,
        [row.value, row.version, row.scopeId, row.documentId, row.version - 1]]);
  }
}

/** Compound credit over SQL. */
export class SqlCompoundCreditStore implements ICompoundCreditStore {
  private readonly tables: CreditTables;
  private schemaReady: Promise<void> | null = null;

  /**
   * @throws {Error} When the store is not shareable and `requireShared` is not false, has no transactions, or the
   *   prefix is refused.
   */
  constructor(private readonly options: SqlCompoundCreditStoreOptions) {
    const caps = options.db.capabilities;
    if (options.requireShared !== false && !(caps.has('transactions') && caps.has('persistence') && caps.has('concurrent'))) {
      throw new Error(`SqlCompoundCreditStore needs a store several processes share (transactions, persistence and concurrent access); "${options.db.kind}" lacks one. Pass requireShared: false for a single process.`);
    }
    if (!caps.has('transactions')) throw new Error(`SqlCompoundCreditStore needs a store with transactions; "${options.db.kind}" has none.`);
    this.tables = creditTables(options.tablePrefix);
  }

  /**
   * Creates the tables unless the first and the newest of them, `accounts` and `documents`, answer a read already;
   * does nothing with `ensureSchema: false`. A store made before the documents table gains it; every statement of the
   * DDL is idempotent.
   */
  ensureSchema(): Promise<void> {
    if (this.options.ensureSchema === false) return Promise.resolve();
    this.schemaReady ??= (async () => {
      try {
        await this.options.db.get(`SELECT 1 FROM ${this.tables.accounts} LIMIT 1`);
        await this.options.db.get(`SELECT 1 FROM ${this.tables.documents} LIMIT 1`);
      } catch {
        await this.options.db.exec(ddlOf(this.tables));
      }
    })().catch((err) => {
      this.schemaReady = null;
      throw err;
    });
    return this.schemaReady;
  }

  /**
   * Uses this store's rows inside the host's existing storage transaction, so host writes and credit rows commit or
   * roll back together. It neither begins, commits, retries nor closes a transaction: the host owns commit, rollback,
   * retry and lock ordering, and an error reaches the host's enclosing transaction. The schema must already exist.
   *
   * @param transaction - The host's active adapter transaction on this store's database.
   * @param fn - Credit work, plus any host writes that must commit with it.
   * @returns What `fn` answers.
   */
  withStorageTransaction<T>(transaction: StorageAdapter, fn: (trx: CreditTransaction) => Promise<T>): Promise<T> {
    return fn(new SqlCreditTransaction(transaction, this.tables));
  }

  async withTransaction<T>(fn: (trx: CreditTransaction) => Promise<T>): Promise<T> {
    await this.ensureSchema();
    return this.options.db.transaction((trx) => fn(new SqlCreditTransaction(trx, this.tables)));
  }

  /** Serialises to a marker, never its adapter. */
  toJSON(): string {
    return '[SqlCompoundCreditStore]';
  }
}
