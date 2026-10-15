/**
 * @fileoverview The rows compound credit keeps, and the one transaction they are read and written in. A scope (a
 * workspace, an account: the host's choice) has a credit account; the account has funding lots (a confirmed payment, a
 * promotion); a hold reserves a call's most against the lots, through allocations, and its model attempts are
 * authorized against it one by one; entries record every movement of money; and the platform's supplier day holds
 * what supplier cost settled on each UTC day.
 *
 * A {@link CreditTransaction} is all a ledger operation sees. It locks the account first (a SQL store takes the row's
 * lock with a write), then reads and writes the rest; a row with a `version` is written by compare-and-set, its
 * `version` one above the one read (or `1` for a new row), and anything else throws {@link CreditConflictError}. One lot
 * exists per funding reference in a scope and one hold per operation in a scope. Amounts are whole micro-dollars; times
 * are epoch milliseconds.
 *
 * A store may also keep versioned documents ({@link CreditDocumentRow}) for an allocator built on these rows, such as
 * supplier transcription credit; they commit or roll back with the rows of the same transaction.
 *
 * @module safety/runtime/CompoundCreditStore
 */

/** A lot's source: a confirmed payment, or a promotion granted by the host. */
export type CreditLotKind = 'paid' | 'promotion';

/** A lot's standing: usable, frozen by a dispute, or closed by a lost dispute. */
export type CreditLotState = 'active' | 'disputed' | 'closed';

/** A scope's credit account. */
export interface CreditAccountRow {
  /** The scope the account belongs to. */
  scopeId: string;
  /** The account's currency. */
  currency: 'USD';
  /** Set while a dispute is open: no new hold is admitted. */
  frozen: boolean;
  /** The disputes open on the account's lots. */
  openDisputes: number;
  /** When the account was made. */
  createdAt: number;
  /** The row's version, for compare-and-set. */
  version: number;
}

/** A funding lot: principal granted once, and how much of it is consumed, held, refunded and retired. */
export interface CreditLotRow {
  lotId: string;
  scopeId: string;
  kind: CreditLotKind;
  /** The payment or promotion reference the lot was granted for; unique in the scope. */
  fundingRef: string;
  principalMicro: number;
  consumedMicro: number;
  heldMicro: number;
  /** Refunded or reserved for a refund in flight. */
  refundedMicro: number;
  /** Retired: an expired promotion's unheld remainder, or what a lost dispute took from the free balance. */
  retiredMicro: number;
  state: CreditLotState;
  /** When a promotion expires; null for a lot that does not. */
  expiresAt: number | null;
  createdAt: number;
  version: number;
}

/** A hold's standing. `deferred` is held, waiting for evidence that its work stopped. */
export type CreditHoldState = 'held' | 'deferred' | 'settled' | 'released';

/** A hold: one operation's most, reserved against the lots, and its settlement. */
export interface CreditHoldRow {
  holdId: string;
  scopeId: string;
  /** The host's id for the operation (a call); unique in the scope. */
  operationId: string;
  /** What is held for, such as `call` or `meeting_run`. */
  kind: string;
  /** A digest of the request the hold was made for; the same operation with another digest is a conflict. */
  requestHash: string;
  /** The customer's most, allocated to lots. */
  customerMicro: number;
  /** The supplier's most, counted against the platform's daily cap. */
  supplierMicro: number;
  mediaCustomerMicro: number;
  mediaSupplierMicro: number;
  /** One attempt's most on each side. */
  attemptCustomerMicro: number;
  attemptSupplierMicro: number;
  maxAttempts: number;
  /** The attempts' limits, as JSON of `AttemptLimits`. */
  attemptLimits: string;
  /** The primary snapshot's version. */
  rateVersion: string;
  /** JSON of `{ primary: RateSnapshot; fallbacks: RateSnapshot[] }`, immutable for the hold's life. */
  rates: string;
  /** The component that prices connected time. */
  mediaComponent: string;
  state: CreditHoldState;
  /** What the customer was charged at settlement. */
  chargedMicro: number;
  /** Supplier cost settled so far. */
  supplierSettledMicro: number;
  /** Supplier liability still open after settlement: attempts whose usage never arrived, at their most. */
  supplierOpenMicro: number;
  createdAt: number;
  /** When the hold's time is up and a reconcile asks about it. */
  expiresAt: number;
  settledAt: number | null;
  /** When a deferred hold is asked about again. */
  deferredUntil: number | null;
  /** The last fence evidence, as JSON. */
  fenceEvidence: string | null;
  version: number;
}

/** One share of a hold, reserved from one lot, in the order it was allocated. */
export interface CreditAllocationRow {
  holdId: string;
  /** The share's position in its hold, from 1; settlement consumes in this order. */
  seq: number;
  lotId: string;
  amountMicro: number;
  consumedMicro: number;
  releasedMicro: number;
  retiredMicro: number;
  settled: boolean;
}

/** Why an attempt is made. Every purpose consumes an attempt. */
export type AttemptPurpose = 'initial' | 'tool_continuation' | 'retry' | 'fallback';

/** An attempt's standing: authorized and not yet reported, or its usage recorded. */
export type CreditAttemptState = 'authorized' | 'recorded';

/** One provider attempt authorized against a hold. */
export interface CreditAttemptRow {
  holdId: string;
  attemptId: string;
  /** The attempt's position in its hold, from 1. */
  seq: number;
  purpose: AttemptPurpose;
  /** The snapshot the attempt is priced under: the hold's primary or one of its fallbacks. */
  rateVersion: string;
  state: CreditAttemptState;
  /** The reported quantities by component key, as JSON; null until reported. */
  usage: string | null;
  /** Whether the report is the attempt's final one. */
  final: boolean;
  authorizedAt: number;
  recordedAt: number | null;
  version: number;
}

/** What an entry records. */
export type CreditEntryKind =
  | 'lot_granted'
  | 'hold_reserved'
  | 'hold_settled'
  | 'hold_released'
  | 'refund_reserved'
  | 'refund_completed'
  | 'refund_reverted'
  | 'dispute_opened'
  | 'dispute_won'
  | 'dispute_lost'
  | 'promotion_retired'
  | 'supplier_settled'
  | 'attempt_exhausted'
  | 'platform_loss'
  | 'receivable';

/** One movement of money, appended once by its id. */
export interface CreditEntryRow {
  entryId: string;
  scopeId: string;
  kind: CreditEntryKind;
  amountMicro: number;
  lotId: string | null;
  holdId: string | null;
  /** A reference the entry belongs to: a refund id, a dispute id, a payment reference. */
  ref: string | null;
  at: number;
  /** The UTC day of `at`. */
  day: string;
}

/** The platform's supplier cost settled on one UTC day. */
export interface SupplierDayRow {
  day: string;
  settledMicro: number;
  version: number;
}

/** Which holds {@link CreditTransaction.listHolds} returns. */
export interface CreditHoldFilter {
  scopeId?: string;
  states?: readonly CreditHoldState[];
  /** Holds due at or before this time: a held one by its `expiresAt`, a deferred one by its `deferredUntil`. */
  dueAtOrBefore?: number;
  /** At most this many; default 1,000. */
  limit?: number;
}

/** Which entries {@link CreditTransaction.listEntries} returns. */
export interface CreditEntryFilter {
  scopeId?: string;
  kinds?: readonly CreditEntryKind[];
  /** The first UTC day, inclusive. */
  fromDay?: string;
  /** The last UTC day, inclusive. */
  toDay?: string;
}

/** Thrown when a write's version is not one above the version stored, or a unique key is taken. */
export class CreditConflictError extends Error {
  /**
   * @param table - The rows the write was to.
   * @param key - The row's key.
   */
  constructor(readonly table: string, readonly key: string) {
    super(`${table} ${key} changed under the transaction`);
    this.name = 'CreditConflictError';
  }
}

/** A library-owned versioned document, committed with the scope's native credit rows. */
export interface CreditDocumentRow {
  scopeId: string;
  documentId: string;
  /** The document's JSON text. */
  value: string;
  /** The row's version, for compare-and-set. */
  version: number;
}

/** The rows of one transaction. Every method reads or writes inside it. */
export interface CreditTransaction {
  /** The scope's account, locked for the rest of the transaction; undefined when there is none. */
  lockAccount(scopeId: string): Promise<CreditAccountRow | undefined>;
  /** Writes the account by compare-and-set. */
  putAccount(row: CreditAccountRow): Promise<void>;
  /** The scope's lots, by creation then id. */
  listLots(scopeId: string): Promise<CreditLotRow[]>;
  getLot(lotId: string): Promise<CreditLotRow | undefined>;
  findLotByFundingRef(scopeId: string, fundingRef: string): Promise<CreditLotRow | undefined>;
  /** Writes a lot by compare-and-set; a new lot whose funding reference the scope has is a conflict. */
  putLot(row: CreditLotRow): Promise<void>;
  getHold(holdId: string): Promise<CreditHoldRow | undefined>;
  findHoldByOperation(scopeId: string, operationId: string): Promise<CreditHoldRow | undefined>;
  /** Writes a hold by compare-and-set; a new hold whose operation the scope has is a conflict. */
  putHold(row: CreditHoldRow): Promise<void>;
  /** Holds by creation then id. */
  listHolds(filter: CreditHoldFilter): Promise<CreditHoldRow[]>;
  /** A hold's allocations, by `seq`. */
  listAllocations(holdId: string): Promise<CreditAllocationRow[]>;
  /** A lot's allocations, by hold then `seq`. */
  listAllocationsByLot(lotId: string): Promise<CreditAllocationRow[]>;
  /** Writes one allocation, keyed by its hold and `seq`. */
  putAllocation(row: CreditAllocationRow): Promise<void>;
  /** A hold's attempts, by `seq`. */
  listAttempts(holdId: string): Promise<CreditAttemptRow[]>;
  /** Writes an attempt by compare-and-set, keyed by its hold and id. */
  putAttempt(row: CreditAttemptRow): Promise<void>;
  /** Appends an entry; false, changing nothing, when its id exists. */
  appendEntry(row: CreditEntryRow): Promise<boolean>;
  getEntry(entryId: string): Promise<CreditEntryRow | undefined>;
  /** Entries by time then id. */
  listEntries(filter: CreditEntryFilter): Promise<CreditEntryRow[]>;
  /**
   * The supplier day, made when missing and locked for the transaction. Every reservation also locks the epoch's day,
   * `1970-01-01`, through it before it reads {@link CreditTransaction.openSupplierMicro}: one platform-wide row that
   * admissions queue on, kept like any other day.
   */
  lockSupplierDay(day: string): Promise<SupplierDayRow>;
  /** Writes the supplier day by compare-and-set. */
  putSupplierDay(row: SupplierDayRow): Promise<void>;
  /**
   * The open supplier liability: across every held or deferred hold, its supplier most less what settled; across every
   * settled or released hold, its `supplierOpenMicro`. Scoped to one scope when `scopeId` is given, across the platform otherwise.
   */
  openSupplierMicro(scopeId?: string): Promise<number>;
  /**
   * Optional extension state, read while the scope account is locked. Both document methods are optional, so a store
   * written before them still implements this interface; an allocator that needs them refuses a store without them.
   */
  getDocument?(scopeId: string, documentId: string): Promise<CreditDocumentRow | undefined>;
  /** Compare-and-set document write in this transaction; version starts at one. */
  putDocument?(row: CreditDocumentRow): Promise<void>;
}

/** A store of compound credit rows. */
export interface ICompoundCreditStore {
  /** Runs `fn` in one transaction: every write of it commits, or none does. */
  withTransaction<T>(fn: (trx: CreditTransaction) => Promise<T>): Promise<T>;
}

/** The UTC day of a time, `YYYY-MM-DD`. */
export function creditDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** Throws unless `next` is one above `stored` (or `1` for a row that does not exist). */
export function checkVersion(table: string, key: string, stored: number | undefined, next: number): void {
  const expected = stored === undefined ? 1 : stored + 1;
  if (next !== expected) throw new CreditConflictError(table, key);
}

interface CreditState {
  accounts: Map<string, CreditAccountRow>;
  lots: Map<string, CreditLotRow>;
  holds: Map<string, CreditHoldRow>;
  allocations: Map<string, CreditAllocationRow[]>;
  attempts: Map<string, CreditAttemptRow[]>;
  entries: Map<string, CreditEntryRow>;
  supplierDays: Map<string, SupplierDayRow>;
  documents: Map<string, CreditDocumentRow>;
}

function emptyState(): CreditState {
  return {
    accounts: new Map(), lots: new Map(), holds: new Map(), allocations: new Map(),
    attempts: new Map(), entries: new Map(), supplierDays: new Map(), documents: new Map(),
  };
}

const byCreation = <T extends { createdAt: number }>(key: (row: T) => string) => (a: T, b: T): number =>
  a.createdAt - b.createdAt || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);

/** The in-memory store's transaction: a working copy of the state, committed whole when the transaction resolves. */
class MemoryCreditTransaction implements CreditTransaction {
  constructor(private readonly s: CreditState) {}

  async lockAccount(scopeId: string): Promise<CreditAccountRow | undefined> {
    const row = this.s.accounts.get(scopeId);
    return row ? { ...row } : undefined;
  }
  async putAccount(row: CreditAccountRow): Promise<void> {
    checkVersion('accounts', row.scopeId, this.s.accounts.get(row.scopeId)?.version, row.version);
    this.s.accounts.set(row.scopeId, { ...row });
  }
  async listLots(scopeId: string): Promise<CreditLotRow[]> {
    return [...this.s.lots.values()].filter((l) => l.scopeId === scopeId).sort(byCreation<CreditLotRow>((l) => l.lotId)).map((l) => ({ ...l }));
  }
  async getLot(lotId: string): Promise<CreditLotRow | undefined> {
    const row = this.s.lots.get(lotId);
    return row ? { ...row } : undefined;
  }
  async findLotByFundingRef(scopeId: string, fundingRef: string): Promise<CreditLotRow | undefined> {
    const row = [...this.s.lots.values()].find((l) => l.scopeId === scopeId && l.fundingRef === fundingRef);
    return row ? { ...row } : undefined;
  }
  async putLot(row: CreditLotRow): Promise<void> {
    const stored = this.s.lots.get(row.lotId);
    if (!stored && [...this.s.lots.values()].some((l) => l.scopeId === row.scopeId && l.fundingRef === row.fundingRef)) {
      throw new CreditConflictError('lots', `${row.scopeId}/${row.fundingRef}`);
    }
    checkVersion('lots', row.lotId, stored?.version, row.version);
    this.s.lots.set(row.lotId, { ...row });
  }
  async getHold(holdId: string): Promise<CreditHoldRow | undefined> {
    const row = this.s.holds.get(holdId);
    return row ? { ...row } : undefined;
  }
  async findHoldByOperation(scopeId: string, operationId: string): Promise<CreditHoldRow | undefined> {
    const row = [...this.s.holds.values()].find((h) => h.scopeId === scopeId && h.operationId === operationId);
    return row ? { ...row } : undefined;
  }
  async putHold(row: CreditHoldRow): Promise<void> {
    const stored = this.s.holds.get(row.holdId);
    if (!stored && [...this.s.holds.values()].some((h) => h.scopeId === row.scopeId && h.operationId === row.operationId)) {
      throw new CreditConflictError('holds', `${row.scopeId}/${row.operationId}`);
    }
    checkVersion('holds', row.holdId, stored?.version, row.version);
    this.s.holds.set(row.holdId, { ...row });
  }
  async listHolds(filter: CreditHoldFilter): Promise<CreditHoldRow[]> {
    const due = (h: CreditHoldRow): boolean => {
      if (filter.dueAtOrBefore === undefined) return true;
      if (h.state === 'deferred') return (h.deferredUntil ?? h.expiresAt) <= filter.dueAtOrBefore;
      return h.expiresAt <= filter.dueAtOrBefore;
    };
    return [...this.s.holds.values()]
      .filter((h) => (filter.scopeId === undefined || h.scopeId === filter.scopeId) && (!filter.states || filter.states.includes(h.state)) && due(h))
      .sort(byCreation<CreditHoldRow>((h) => h.holdId))
      .slice(0, filter.limit ?? 1_000)
      .map((h) => ({ ...h }));
  }
  async listAllocations(holdId: string): Promise<CreditAllocationRow[]> {
    return (this.s.allocations.get(holdId) ?? []).slice().sort((a, b) => a.seq - b.seq).map((a) => ({ ...a }));
  }
  async listAllocationsByLot(lotId: string): Promise<CreditAllocationRow[]> {
    return [...this.s.allocations.values()]
      .flat()
      .filter((a) => a.lotId === lotId)
      .sort((a, b) => (a.holdId < b.holdId ? -1 : a.holdId > b.holdId ? 1 : a.seq - b.seq))
      .map((a) => ({ ...a }));
  }
  async putAllocation(row: CreditAllocationRow): Promise<void> {
    const rows = (this.s.allocations.get(row.holdId) ?? []).filter((a) => a.seq !== row.seq);
    rows.push({ ...row });
    this.s.allocations.set(row.holdId, rows);
  }
  async listAttempts(holdId: string): Promise<CreditAttemptRow[]> {
    return (this.s.attempts.get(holdId) ?? []).slice().sort((a, b) => a.seq - b.seq).map((a) => ({ ...a }));
  }
  async putAttempt(row: CreditAttemptRow): Promise<void> {
    const rows = this.s.attempts.get(row.holdId) ?? [];
    const stored = rows.find((a) => a.attemptId === row.attemptId);
    checkVersion('attempts', `${row.holdId}/${row.attemptId}`, stored?.version, row.version);
    this.s.attempts.set(row.holdId, [...rows.filter((a) => a.attemptId !== row.attemptId), { ...row }]);
  }
  async appendEntry(row: CreditEntryRow): Promise<boolean> {
    if (this.s.entries.has(row.entryId)) return false;
    this.s.entries.set(row.entryId, { ...row });
    return true;
  }
  async getEntry(entryId: string): Promise<CreditEntryRow | undefined> {
    const row = this.s.entries.get(entryId);
    return row ? { ...row } : undefined;
  }
  async listEntries(filter: CreditEntryFilter): Promise<CreditEntryRow[]> {
    return [...this.s.entries.values()]
      .filter(
        (e) =>
          (filter.scopeId === undefined || e.scopeId === filter.scopeId) &&
          (!filter.kinds || filter.kinds.includes(e.kind)) &&
          (filter.fromDay === undefined || e.day >= filter.fromDay) &&
          (filter.toDay === undefined || e.day <= filter.toDay),
      )
      .sort((a, b) => a.at - b.at || (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0))
      .map((e) => ({ ...e }));
  }
  async lockSupplierDay(day: string): Promise<SupplierDayRow> {
    const row = this.s.supplierDays.get(day) ?? { day, settledMicro: 0, version: 0 };
    return { ...row };
  }
  async putSupplierDay(row: SupplierDayRow): Promise<void> {
    const stored = this.s.supplierDays.get(row.day);
    checkVersion('supplier_days', row.day, stored?.version ?? 0, row.version);
    this.s.supplierDays.set(row.day, { ...row });
  }
  async openSupplierMicro(scopeId?: string): Promise<number> {
    let open = 0;
    for (const h of this.s.holds.values()) {
      if (scopeId !== undefined && h.scopeId !== scopeId) continue;
      if (h.state === 'held' || h.state === 'deferred') open += Math.max(0, h.supplierMicro - h.supplierSettledMicro);
      else open += h.supplierOpenMicro;
    }
    return open;
  }
  async getDocument(scopeId: string, documentId: string): Promise<CreditDocumentRow | undefined> {
    const row = this.s.documents.get(JSON.stringify([scopeId, documentId]));
    return row ? { ...row } : undefined;
  }
  async putDocument(row: CreditDocumentRow): Promise<void> {
    const key = JSON.stringify([row.scopeId, row.documentId]);
    checkVersion('documents', key, this.s.documents.get(key)?.version, row.version);
    this.s.documents.set(key, { ...row });
  }
}

/**
 * Compound credit in memory, for tests and one process. Transactions run one at a time, each on a copy of the state
 * that replaces the state only when the transaction resolves; a transaction that throws leaves nothing.
 */
export class InMemoryCompoundCreditStore implements ICompoundCreditStore {
  /** The committed state. */
  protected state: CreditState = emptyState();
  private queue: Promise<unknown> = Promise.resolve();

  withTransaction<T>(fn: (trx: CreditTransaction) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const draft = structuredClone(this.state);
      const result = await fn(new MemoryCreditTransaction(draft));
      this.state = draft;
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
