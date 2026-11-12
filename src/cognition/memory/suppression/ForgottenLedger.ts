/**
 * @module memory/suppression/ForgottenLedger
 *
 * The forgotten-user ledger: who a store has been told to forget, kept as hashes in the table the learning store
 * already has, `agentos_learning_forgotten`. A row holds a hash of a subject and the time it was forgotten, never an
 * id, a name or any text. The memory store and the learning layer read and write the same table, so a subject either
 * side forgot is forgotten for both.
 *
 * A ledger can keep a second copy of the table in a database a restore of the store does not replace. A tombstone is
 * written to the copy first and the store second, and `reconcile()` copies back into the store what the copy holds, so
 * a store restored from a backup taken before a deletion still knows the deletion. Once a store has a copy it does not
 * open without it.
 *
 * With a key a tombstone is an HMAC-SHA-256, and the store records which key wrote it as a marker row. A store that
 * holds a key's marker does not open unless that key is given, so a missing key never reads as "nobody was forgotten".
 *
 * Each side also holds two rows that name the ledger: `i1:identity`, 16 random bytes made once when the ledger is
 * created, and `s1:state`, the ledger's state mark. Opening compares the identity of the store with the identity of
 * its copy and refuses a copy that belongs to another store; a side whose identity or state row is missing beside the
 * other, malformed, or in conflict does not open. A ledger made before these rows existed gains them at its next open.
 * The state mark rises with every tombstone written, and `readState()` returns the identity and the mark.
 *
 * Each step that changes rows runs two short transactions, the copy's and then the store's, never one inside the
 * other; each takes the table's write lock with its first statement. A handle's steps run one at a time.
 */
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { listedErrorFields } from '../../../core/logging/events.js';
import { canonicalJson, sha256Hex } from '../../learning/ledger/canonical.js';
import { memoryLog } from '../log.js';
import {
  IDENTITY_MARKER,
  STATE_MARKER,
  advanceStateMark,
  compareStateMarks,
  isLedgerIdentity,
  isReservedLedgerKey,
  isStateMark,
  newLedgerIdentity,
} from './ledgerState.js';

/** The table both ledgers use: the learning store's own, unchanged in name and columns. */
export const FORGOTTEN_DDL = `CREATE TABLE IF NOT EXISTS agentos_learning_forgotten (
  hash TEXT PRIMARY KEY,
  namespace TEXT NOT NULL DEFAULT '',
  forgotten_at TEXT NOT NULL
);`;
/** The marker both ledgers hold once a store has a copy. A marker holds a ':', which no 64-character hex hash holds. */
export const COPY_MARKER = 'c1:copy';
/** A key marker: this prefix, then the first 16 hex characters of SHA-256 over the key's bytes. */
export const KEY_MARKER_PREFIX = 'k1:';

/** Who a tombstone is of: a named user or an anonymous session. */
export type SuppressionSubject = { kind: 'user' | 'session'; id: string };
/** A secret that keys the tombstones (HMAC-SHA-256). A string is read as its UTF-8 bytes. */
export type TombstoneKey = string | Uint8Array;

export interface ForgottenLedgerOptions {
  /** The store's own adapter: the table lives beside `memory_traces`, database-wide rather than per brain. */
  primary: StorageAdapter;
  /** The copy a restore of the store does not replace. */
  copy?: StorageAdapter;
  /** `current` writes; `previous` are read after it. Every key must contain at least one byte. */
  key?: { current: TombstoneKey; previous?: ReadonlyArray<TombstoneKey> };
  /** The namespaces a check reads: the store-wide `''` always; an agent that runs a learning layer adds the layer's. */
  namespaces?: readonly string[];
}

/** Why a ledger did not open, or refused a call. The message never holds an id, a key, a hash, an identity or a mark. */
export class ForgottenLedgerError extends Error {
  override readonly name = 'ForgottenLedgerError';
  constructor(
    readonly code: 'COPY_UNAVAILABLE' | 'KEY_REQUIRED' | 'LEDGER_IDENTITY_MISMATCH' | 'LEDGER_STATE_INVALID' | 'LEDGER_UNAVAILABLE',
    message: string,
  ) {
    super(message);
  }
}

/** A row of the table. */
interface LedgerRow {
  hash: string;
  namespace: string;
  forgotten_at: string;
}

const INSERT_ROW =
  'INSERT INTO agentos_learning_forgotten (hash, namespace, forgotten_at) VALUES (?, ?, ?) ON CONFLICT (hash) DO NOTHING';

/**
 * The first statement of a side's transaction on PostgreSQL. The mode conflicts with itself and with the row writes
 * of other writers, and lets plain reads go on; it is held until the transaction ends.
 */
const LOCK_POSTGRES = 'LOCK TABLE agentos_learning_forgotten IN SHARE ROW EXCLUSIVE MODE';
/** The first statement of a side's transaction on SQLite: a write, which takes the database's write lock. */
const LOCK_SQLITE = `UPDATE agentos_learning_forgotten SET forgotten_at = forgotten_at WHERE hash = '${STATE_MARKER}'`;

const isNode = typeof process !== 'undefined' && !!process.versions?.node;

const hexOf = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

/** A key's bytes: a string's UTF-8 bytes, or a copy of the bytes given. */
const bytesOf = (key: TombstoneKey) => (typeof key === 'string' ? new TextEncoder().encode(key) : new Uint8Array(key));

/** HMAC-SHA-256 of a text under a key, as lowercase hexadecimal. */
async function hmacSha256Hex(key: TombstoneKey, text: string): Promise<string> {
  if (isNode) {
    const { createHmac } = await import('node:crypto');
    return createHmac('sha256', key).update(text, 'utf8').digest('hex');
  }
  const subtle = globalThis.crypto.subtle;
  const cryptoKey = await subtle.importKey('raw', bytesOf(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hexOf(await subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(text)));
}

/** SHA-256 of a key's bytes, as lowercase hexadecimal. */
async function sha256OfKey(key: TombstoneKey): Promise<string> {
  if (isNode) {
    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(key).digest('hex');
  }
  return hexOf(await globalThis.crypto.subtle.digest('SHA-256', bytesOf(key)));
}

/** The subject, checked: a rejected call names the rule and never the value. */
function checked(subject: SuppressionSubject): SuppressionSubject {
  const given = subject as { kind?: unknown; id?: unknown } | null | undefined;
  const kind: unknown = given?.kind;
  const id: unknown = given?.id;
  if ((kind === 'user' || kind === 'session') && typeof id === 'string' && id.length > 0) return { kind, id };
  throw new TypeError('ForgottenLedger: a subject needs the kind user or session and a non-empty id');
}

/** Whether a row is a marker and not a tombstone. */
const isMarker = (hash: string): boolean => hash.includes(':');

/** The refusal of a store whose tombstone copy is missing or unreadable. @internal */
export const copyUnavailableError = (): ForgottenLedgerError =>
  new ForgottenLedgerError(
    'COPY_UNAVAILABLE',
    "ForgottenLedger: this store's tombstone copy is missing or unreadable; put the copy back (never from an older backup) or pass tombstoneCopy. No memory is served without it.",
  );

const keyRequired = (): ForgottenLedgerError =>
  new ForgottenLedgerError(
    'KEY_REQUIRED',
    "ForgottenLedger: this store's tombstones are keyed; pass tombstoneKey (the current key, or the current and previous keys after a rotation)",
  );

const identityMismatch = (): ForgottenLedgerError =>
  new ForgottenLedgerError(
    'LEDGER_IDENTITY_MISMATCH',
    'ForgottenLedger: the store and copy do not have a checked common identity; restore the current matching copy. No memory is served.',
  );

const stateInvalid = (): ForgottenLedgerError =>
  new ForgottenLedgerError(
    'LEDGER_STATE_INVALID',
    "ForgottenLedger: the ledger's identity or state rows are missing beside each other, malformed, or in conflict between the store and its copy; no row was changed.",
  );

const unavailable = (): ForgottenLedgerError =>
  new ForgottenLedgerError(
    'LEDGER_UNAVAILABLE',
    'ForgottenLedger: the ledger needs a storage adapter with transactions and a secure random source (globalThis.crypto.getRandomValues); no row was changed.',
  );

/** Writes the one line of a refusal, where the refusal is thrown; callers pass the error on without another line. */
function logRefusal(error: unknown): void {
  if (error instanceof ForgottenLedgerError) memoryLog.warn('memory.ledger_refused', listedErrorFields(error));
}

/** One side of a ledger, read and checked. */
interface LedgerSide {
  /** Every row but the identity and the state: tombstones and the copy and key markers, by hash. */
  rows: Map<string, LedgerRow>;
  /** The side's identity; undefined on a side made before the identity existed. */
  identity?: string;
  /** The side's state mark, present exactly when the identity is. */
  mark?: string;
}

/**
 * A side's rows, checked: the identity and the state are both there or both missing, each in its form and with an
 * empty namespace, and no other key is reserved for them.
 *
 * @throws {ForgottenLedgerError} `LEDGER_STATE_INVALID` otherwise.
 */
function sideOf(rows: readonly LedgerRow[]): LedgerSide {
  const side: LedgerSide = { rows: new Map() };
  for (const row of rows) {
    if (row.hash === IDENTITY_MARKER) {
      if (row.namespace !== '' || !isLedgerIdentity(row.forgotten_at)) throw stateInvalid();
      side.identity = row.forgotten_at;
    } else if (row.hash === STATE_MARKER) {
      if (row.namespace !== '' || !isStateMark(row.forgotten_at)) throw stateInvalid();
      side.mark = row.forgotten_at;
    } else if (isReservedLedgerKey(row.hash)) {
      throw stateInvalid();
    } else {
      side.rows.set(row.hash, row);
    }
  }
  if ((side.identity === undefined) !== (side.mark === undefined)) throw stateInvalid();
  return side;
}

/**
 * Refuses a tombstone the two sides hold with another namespace or another time: one of them is damaged, and the
 * ledger does not choose between them. Markers may differ in time.
 */
function checkAgreement(store: LedgerSide, copy: LedgerSide): void {
  for (const [hash, row] of store.rows) {
    const other = copy.rows.get(hash);
    if (other !== undefined && !isMarker(hash) && (other.namespace !== row.namespace || other.forgotten_at !== row.forgotten_at)) {
      throw stateInvalid();
    }
  }
}

/** The higher of two valid marks of one ledger. */
const higherMark = (a: string, b: string): string => (compareStateMarks(a, b) >= 0 ? a : b);

/**
 * Whether a side holds a tombstone the other lacks without holding the strictly higher mark. A side's rows and mark
 * commit together, so such a row was written outside the ledger: a learning layer's own insert, an older version, or
 * SQL by hand.
 */
function foundOutside(store: LedgerSide, copy: LedgerSide): boolean {
  const order = compareStateMarks(store.mark!, copy.mark!);
  const holdsMore = (side: LedgerSide, other: LedgerSide): boolean =>
    [...side.rows.keys()].some((hash) => !isMarker(hash) && !other.rows.has(hash));
  return (order <= 0 && holdsMore(store, copy)) || (order >= 0 && holdsMore(copy, store));
}

/** Whether `whole` holds every tombstone and key marker `part` holds; the copy marker aside. */
const holdsAllOf = (whole: LedgerSide, part: LedgerSide): boolean =>
  [...part.rows.keys()].every((hash) => hash === COPY_MARKER || whole.rows.has(hash));

/** Rows in the order they are written: markers first, so no keyed tombstone is ever without its key's marker. */
const markersFirst = (rows: Iterable<LedgerRow>): LedgerRow[] =>
  [...rows].sort((a, b) => Number(isMarker(b.hash)) - Number(isMarker(a.hash)));

/** A new identity; a runtime without a secure random source refuses. */
function freshIdentity(): string {
  try {
    return newLedgerIdentity();
  } catch {
    throw unavailable();
  }
}

/** The mark after `previous`, at the current time; a mark that would leave its range is damaged state. */
function nextMark(previous: string | undefined): string {
  try {
    return advanceStateMark(previous, Date.now());
  } catch (error) {
    throw error instanceof RangeError ? stateInvalid() : unavailable();
  }
}

/**
 * Runs one side's step in a transaction of its own whose first statement takes the table's write lock, so no other
 * writer changes the side between the step's reads and its commit. Every statement of the step runs on `trx`. A
 * step never opens the other side's transaction.
 */
function locked<T>(adapter: StorageAdapter, step: (trx: StorageAdapter) => Promise<T>): Promise<T> {
  return adapter.transaction(async (trx) => {
    await trx.run(adapter.kind.includes('postgres') ? LOCK_POSTGRES : LOCK_SQLITE);
    return step(trx);
  });
}

/** Whether two native SQLite connections name the same file, including links to it. */
async function sameSqliteFile(primary: StorageAdapter, copy: StorageAdapter): Promise<boolean> {
  if (primary.kind !== 'better-sqlite3' || copy.kind !== 'better-sqlite3') return false;
  const fileOf = async (adapter: StorageAdapter): Promise<string | undefined> =>
    (await adapter.all<{ name: string; file: string }>('PRAGMA database_list')).find((row) => row.name === 'main')?.file;
  const [primaryFile, copyFile] = await Promise.all([fileOf(primary), fileOf(copy)]);
  // An in-memory database has no filename; separate adapters then hold separate databases.
  if (!primaryFile || !copyFile) return false;
  if (primaryFile === copyFile) return true;
  const { stat } = await import('node:fs/promises');
  const [primaryStat, copyStat] = await Promise.all([stat(primaryFile), stat(copyFile)]);
  return primaryStat.ino !== 0 && primaryStat.dev === copyStat.dev && primaryStat.ino === copyStat.ino;
}

/**
 * The forgotten subjects of one store.
 *
 * @example
 * const ledger = await ForgottenLedger.open({ primary: storeAdapter, copy: copyAdapter, key: { current: secret } });
 * await ledger.markForgotten({ kind: 'user', id: userId });
 * await ledger.isForgotten({ kind: 'user', id: userId }); // true
 */
export class ForgottenLedger {
  /** The namespaces a check reads, `''` first, each once. */
  readonly namespaces: readonly string[];
  /** Whether writes are keyed. */
  readonly keyed: boolean;
  /** The tombstones an open or a step brought from the copy into the store, for the next `reconcile()` to report. */
  private readonly broughtBack = new Set<string>();
  /** The identity the open found or made; every later step checks both sides still hold it. */
  private identity = '';
  /** The end of the handle's last step: the handle's work on rows runs one step at a time. */
  private queue: Promise<void> = Promise.resolve();
  /** The key markers of the keys this handle was given, made once. */
  private givenMarkers: Promise<Set<string>> | undefined;

  private constructor(
    private readonly primary: StorageAdapter,
    private readonly copy: StorageAdapter | undefined,
    /** The keys a check reads, the one that writes first. */
    private readonly keys: readonly TombstoneKey[],
    namespaces: readonly string[],
  ) {
    this.namespaces = namespaces;
    this.keyed = keys.length > 0;
  }

  /**
   * Creates the table where missing on each adapter, then checks the copy marker, the key markers and the two rows
   * that name the ledger: `i1:identity` and `s1:state`.
   *
   * A store that never had a copy and is given one has both marked as a pair. An existing copy is repaired from
   * the primary too, after marker validation, so replacing the copy with an older backup cannot lose tombstones.
   * The tombstones stay where they are on the store until `reconcile()`.
   *
   * A new ledger gets one identity, 16 random bytes, and one state mark, the same on both sides. A ledger made before
   * these rows existed gains them and keeps every row it held. A store without them beside a copy that has them takes
   * the copy's identity, state and tombstones, and a copy without them is repaired from its store, when the side
   * without them holds no tombstone or key marker the other lacks.
   *
   * @throws {TypeError} When any current or previous key is empty.
   *
   * @throws {ForgottenLedgerError} `COPY_UNAVAILABLE` when the copy is the primary database, cannot be read, or when
   *   the store had a copy and the copy given does not know it (or none is given); `KEY_REQUIRED` when either ledger holds the marker of a key
   *   that was not passed; `LEDGER_IDENTITY_MISMATCH` when the store and the copy hold different identities, or the
   *   side without an identity holds a tombstone or key marker the other lacks; `LEDGER_STATE_INVALID` when a side
   *   holds one of the two rows without the other, a malformed one, or a tombstone the other side holds with another
   *   namespace or time; `LEDGER_UNAVAILABLE` when an adapter has no transactions or the runtime has no secure random
   *   source. Nothing is copied or marked by an open that is refused, and each refusal writes one
   *   `memory.ledger_refused` line.
   */
  static async open(options: ForgottenLedgerOptions): Promise<ForgottenLedger> {
    try {
      return await ForgottenLedger.opened(options);
    } catch (error) {
      logRefusal(error);
      throw error;
    }
  }

  /** The open, whose refusals {@link ForgottenLedger.open} logs. */
  private static async opened(options: ForgottenLedgerOptions): Promise<ForgottenLedger> {
    const { primary, copy } = options;
    const keys = options.key ? [options.key.current, ...(options.key.previous ?? [])] : [];
    if (keys.some((key) => bytesOf(key).byteLength === 0)) {
      throw new TypeError('ForgottenLedger: each current or previous key must contain at least one byte');
    }
    if (copy) {
      let same: boolean;
      try {
        same = copy === primary || (await sameSqliteFile(primary, copy));
      } catch {
        throw copyUnavailableError();
      }
      if (same) {
        throw new ForgottenLedgerError('COPY_UNAVAILABLE', 'ForgottenLedger: the tombstone copy must use a separate database from the primary');
      }
    }
    const namespaces = [...new Set(['', ...(options.namespaces ?? [])])];

    await primary.exec(FORGOTTEN_DDL);
    let copyRows: LedgerRow[] = [];
    if (copy) {
      try {
        await copy.exec(FORGOTTEN_DDL);
        copyRows = await ForgottenLedger.rowsOf(copy);
      } catch {
        throw copyUnavailableError();
      }
    }
    const primaryRows = await ForgottenLedger.rowsOf(primary);

    const primaryPaired = primaryRows.some((row) => row.hash === COPY_MARKER);
    const copyPaired = copyRows.some((row) => row.hash === COPY_MARKER);
    // The store had a copy, and the copy given was lost, replaced by an empty database, or left out.
    if (primaryPaired && !copyPaired) throw copyUnavailableError();

    const held = [...primaryRows, ...copyRows].map((row) => row.hash).filter((hash) => hash.startsWith(KEY_MARKER_PREFIX));
    if (held.length > 0) {
      const given = new Set(await Promise.all(keys.map((key) => ForgottenLedger.keyMarker(key))));
      if (held.some((marker) => !given.has(marker))) throw keyRequired();
    }

    // Every write below runs in a transaction, and a new ledger needs random bytes: without either, nothing is written.
    for (const adapter of copy ? [primary, copy] : [primary]) {
      if (!adapter.capabilities.has('transactions')) throw unavailable();
    }
    try {
      newLedgerIdentity();
    } catch {
      throw unavailable();
    }

    // Repair an older copy too: primary tombstones must survive a later restore of the primary. Do this only
    // after both ledgers' markers have been checked, so a refused open still copies nothing.
    const ledger = new ForgottenLedger(primary, copy, keys, namespaces);
    await ledger.settleAtOpen(sideOf(primaryRows));
    return ledger;
  }

  /**
   * The open's rows, after its copy and key checks: the identity and the state of both sides are read, checked and
   * written where a side lacks them; the copy gains the store's rows it lacks, and is paired. The store's rows read
   * here (`store`) are a plain read; the copy is read again under its lock, and the store under its own.
   */
  private async settleAtOpen(store: LedgerSide): Promise<void> {
    const copy = this.copy;
    if (!copy) {
      // A store with no copy keeps its rows, or gains its identity and state alone.
      this.identity = store.identity ?? (await this.writeStore({ rows: [] })).identity;
      return;
    }
    const plan = await locked(copy, async (trx) => {
      const held = sideOf(await ForgottenLedger.rowsOf(trx));
      checkAgreement(store, held);
      const storePaired = store.rows.has(COPY_MARKER);
      let identity: string;
      let mark: string;
      if (store.identity !== undefined && held.identity !== undefined) {
        // Both sides are named: the same ledger, or not one to open.
        if (store.identity !== held.identity) throw identityMismatch();
        identity = store.identity;
        // The copy takes the higher mark, and one more advance for a tombstone a side holds without the higher mark.
        mark = higherMark(store.mark!, held.mark!);
        if (foundOutside(store, held)) mark = nextMark(mark);
      } else if (store.identity !== undefined) {
        // A copy without the two rows: an empty new copy of an unpaired store, or an older copy of this store.
        if (held.rows.size > 0 && (!storePaired || !holdsAllOf(store, held))) throw identityMismatch();
        identity = store.identity;
        mark = store.mark!;
      } else if (held.identity !== undefined) {
        // A store without the two rows beside a copy that has them: the store takes the copy's.
        if (!holdsAllOf(held, store)) throw identityMismatch();
        identity = held.identity;
        mark = held.mark!;
      } else {
        // Neither side has them: a new ledger, or one made before them. Both get one identity and one mark.
        identity = freshIdentity();
        mark = nextMark(undefined);
      }
      // The copy gains every row of the store it lacks, the pair's marker and the two rows; its tombstones go to the
      // store only where the store gets its first state row here, and otherwise at `reconcile()`.
      const pairing: LedgerRow = { hash: COPY_MARKER, namespace: '', forgotten_at: new Date().toISOString() };
      const union = new Map<string, LedgerRow>([[COPY_MARKER, pairing], ...held.rows, ...store.rows]);
      for (const row of markersFirst(union.values())) if (!held.rows.has(row.hash)) await ForgottenLedger.insert(trx, row);
      if (held.identity === undefined) await ForgottenLedger.writeNames(trx, identity, mark);
      else if (mark !== held.mark) await ForgottenLedger.setMark(trx, held.mark!, mark);
      return { identity, mark, union: [...union.values()] };
    });
    this.identity = plan.identity;
    if (store.identity === undefined) {
      // The store's first state row comes with every row under it.
      await this.writeStore({ identity: plan.identity, mark: plan.mark, rows: plan.union });
    } else if (!store.rows.has(COPY_MARKER)) {
      // The store is not filled at an open; it is paired.
      await this.writeStore({ identity: plan.identity, rows: [plan.union.find((row) => row.hash === COPY_MARKER)!] });
    }
  }

  /**
   * The store's part of a step, in a transaction of its own after the copy's has committed: under the store's lock its
   * rows are read again, the `rows` it lacks are written, and its state is set to the higher of its own and `mark`. A
   * store without the two rows gets `identity` and `mark` (a new ledger's when they are not given), unless `named`
   * says it must hold the handle's identity already. The tombstones it gains, `own` aside, are kept for the next
   * `reconcile()`.
   *
   * @returns The identity and the mark the store holds once the step commits.
   * @throws {ForgottenLedgerError} `LEDGER_IDENTITY_MISMATCH` when the store holds another identity, or none where it
   *   must hold one; `KEY_REQUIRED` for a key marker of a key the handle was not given.
   */
  private async writeStore(step: {
    identity?: string;
    mark?: string;
    rows: readonly LedgerRow[];
    own?: string;
    named?: boolean;
  }): Promise<{ identity: string; mark: string }> {
    const done = await locked(this.primary, async (trx) => {
      const held = sideOf(await ForgottenLedger.rowsOf(trx));
      if (step.named) await this.checkHeld(held);
      if (held.identity !== undefined && step.identity !== undefined && held.identity !== step.identity) throw identityMismatch();
      const gained: string[] = [];
      for (const row of markersFirst(step.rows)) {
        if (held.rows.has(row.hash) || !(await ForgottenLedger.insert(trx, row))) continue;
        if (!isMarker(row.hash) && row.hash !== step.own) gained.push(row.hash);
      }
      if (held.identity === undefined) {
        const named = { identity: step.identity ?? freshIdentity(), mark: step.mark ?? nextMark(undefined) };
        await ForgottenLedger.writeNames(trx, named.identity, named.mark);
        return { gained, identity: named.identity, mark: named.mark };
      }
      // A late store commit never lowers the store's mark.
      const mark = step.mark === undefined ? held.mark! : higherMark(held.mark!, step.mark);
      if (mark !== held.mark) await ForgottenLedger.setMark(trx, held.mark!, mark);
      return { gained, identity: held.identity, mark };
    });
    for (const hash of done.gained) this.broughtBack.add(hash);
    return { identity: done.identity, mark: done.mark };
  }

  /**
   * Sets a side's state mark from the value read under the lock to a new one: an update by equality, never a
   * comparison in SQL.
   *
   * @throws {ForgottenLedgerError} `LEDGER_UNAVAILABLE` when it does not change exactly one row: the lock was not held.
   */
  private static async setMark(trx: StorageAdapter, from: string, to: string): Promise<void> {
    const result = await trx.run(`UPDATE agentos_learning_forgotten SET forgotten_at = ? WHERE hash = '${STATE_MARKER}' AND forgotten_at = ?`, [to, from]);
    if (result.changes !== 1) throw unavailable();
  }

  /**
   * Refuses a side, read under its lock, that no longer holds this handle's identity (the database was replaced
   * under the open handle), or that holds the marker of a key the handle was not given.
   */
  private async checkHeld(side: LedgerSide): Promise<void> {
    if (side.identity !== this.identity) throw identityMismatch();
    this.givenMarkers ??= Promise.all(this.keys.map((key) => ForgottenLedger.keyMarker(key))).then((markers) => new Set(markers));
    const given = await this.givenMarkers;
    for (const hash of side.rows.keys()) if (hash.startsWith(KEY_MARKER_PREFIX) && !given.has(hash)) throw keyRequired();
  }

  /**
   * Runs one step of this handle's work on rows after the steps before it, and writes the line of a refusal it throws.
   */
  private step<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run.catch((error: unknown) => {
      logRefusal(error);
      throw error;
    });
  }

  /**
   * Unites the two sides, and writes a tombstone when one is given: the copy's transaction, then the store's, never one
   * inside the other.
   *
   * 1. The store's rows and state are read with plain reads.
   * 2. In the copy's transaction, under its lock, the copy is read; both sides must hold this handle's identity and no
   *    key marker it was not given. The rows of either side go to the copy, and the mark is decided: the higher of the
   *    two, advanced once when a side holds a tombstone the other lacks without holding the strictly higher mark (a
   *    row written outside the ledger), and once more for the tombstone written.
   * 3. In the store's transaction, under its lock, the store is read again and gains the rows it lacks; its state is
   *    set to the higher of its own and the decided mark.
   *
   * With no copy the store's transaction does it all.
   */
  private async unite(write?: { tombstone: LedgerRow; marker?: LedgerRow }): Promise<{ written: boolean; identity: string; mark: string }> {
    const copy = this.copy;
    if (!copy) {
      return locked(this.primary, async (trx) => {
        const held = sideOf(await ForgottenLedger.rowsOf(trx));
        await this.checkHeld(held);
        let written = false;
        let mark = held.mark!;
        if (write) {
          if (write.marker && !held.rows.has(write.marker.hash)) await ForgottenLedger.insert(trx, write.marker);
          if (!held.rows.has(write.tombstone.hash)) written = await ForgottenLedger.insert(trx, write.tombstone);
          mark = nextMark(mark);
          await ForgottenLedger.setMark(trx, held.mark!, mark);
        }
        return { written, identity: held.identity!, mark };
      });
    }
    const store = sideOf(await ForgottenLedger.rowsOf(this.primary));
    await this.checkHeld(store);
    const plan = await locked(copy, async (trx) => {
      const held = sideOf(await ForgottenLedger.rowsOf(trx));
      await this.checkHeld(held);
      checkAgreement(store, held);
      const union = new Map<string, LedgerRow>([...held.rows, ...store.rows]);
      let mark = higherMark(store.mark!, held.mark!);
      if (foundOutside(store, held)) mark = nextMark(mark);
      let written = false;
      if (write) {
        written = !store.rows.has(write.tombstone.hash) || !held.rows.has(write.tombstone.hash);
        // A tombstone either side already holds keeps its row and its time.
        for (const row of write.marker ? [write.marker, write.tombstone] : [write.tombstone]) if (!union.has(row.hash)) union.set(row.hash, row);
        mark = nextMark(mark);
      }
      for (const row of markersFirst(union.values())) if (!held.rows.has(row.hash)) await ForgottenLedger.insert(trx, row);
      if (mark !== held.mark) await ForgottenLedger.setMark(trx, held.mark!, mark);
      return { written, mark, rows: [...union.values()] };
    });
    const done = await this.writeStore({ identity: this.identity, mark: plan.mark, rows: plan.rows, own: write?.tombstone.hash, named: true });
    return { written: plan.written, ...done };
  }

  /** Writes a side's identity row and state row. */
  private static async writeNames(trx: StorageAdapter, identity: string, mark: string): Promise<void> {
    await ForgottenLedger.insert(trx, { hash: IDENTITY_MARKER, namespace: '', forgotten_at: identity });
    await ForgottenLedger.insert(trx, { hash: STATE_MARKER, namespace: '', forgotten_at: mark });
  }

  /** SHA-256, or HMAC-SHA-256 with a key, over the canonical JSON `[namespace, kind, id]`, as lowercase hex. */
  static hash(namespace: string, subject: SuppressionSubject, key?: TombstoneKey): Promise<string> {
    const text = canonicalJson([namespace, subject.kind, subject.id]);
    return key === undefined ? sha256Hex(text) : hmacSha256Hex(key, text);
  }

  /** `k1:` and the first 16 hex characters of SHA-256 over the key's bytes. */
  static async keyMarker(key: TombstoneKey): Promise<string> {
    return `${KEY_MARKER_PREFIX}${(await sha256OfKey(key)).slice(0, 16)}`;
  }

  /**
   * Writes the tombstone to the copy, then to the primary, each with its key's marker and a new state mark in one
   * transaction, after uniting the two sides' rows. `written` is false when both held it; the mark rises either way.
   * Rejects when either side's transaction fails: a caller deletes nothing without the tombstone in both.
   *
   * @throws {TypeError} For a subject with another kind or no id.
   * @throws {ForgottenLedgerError} `LEDGER_IDENTITY_MISMATCH` when a side no longer holds the ledger's identity,
   *   `LEDGER_STATE_INVALID` when a side's identity or state row is damaged, `KEY_REQUIRED` for a key marker of a key
   *   the handle was not given; nothing is written.
   */
  async markForgotten(subject: SuppressionSubject): Promise<{ form: 'keyed' | 'unkeyed'; written: boolean }> {
    const who = checked(subject);
    const current = this.keys[0];
    const forgottenAt = new Date().toISOString();
    // The key's marker goes in with the first tombstone it writes, so no keyed tombstone is without one.
    const marker: LedgerRow | undefined =
      current === undefined ? undefined : { hash: await ForgottenLedger.keyMarker(current), namespace: '', forgotten_at: forgottenAt };
    const tombstone: LedgerRow = { hash: await ForgottenLedger.hash('', who, current), namespace: '', forgotten_at: forgottenAt };
    const { written } = await this.step(() => this.unite({ tombstone, marker }));
    return { form: current === undefined ? 'unkeyed' : 'keyed', written };
  }

  /**
   * Whether either ledger holds a tombstone of the subject: every form, every namespace.
   *
   * @throws {TypeError} For a subject with another kind or no id.
   */
  async isForgotten(subject: SuppressionSubject): Promise<boolean> {
    const forms = await this.forms(checked(subject));
    const statement = `SELECT hash FROM agentos_learning_forgotten WHERE hash IN (${forms.map(() => '?').join(', ')})`;
    if ((await this.primary.get<{ hash: string }>(statement, forms)) != null) return true;
    return this.copy !== undefined && (await this.copy.get<{ hash: string }>(statement, forms)) != null;
  }

  /**
   * Fills missing rows in both directions and leaves both sides at the higher state mark; it never lowers one. A
   * tombstone one side holds without holding the higher mark was written outside the ledger, and raises the mark
   * once. `added` lists the tombstones brought back into the primary since the last `reconcile()` on this handle, its
   * own and those of an open, a deletion or a state read on the way, markers and a deletion's own tombstone left out.
   * With no copy there is nothing to bring back.
   */
  async reconcile(): Promise<{ added: string[] }> {
    return this.step(async () => {
      if (this.copy) await this.unite();
      const added = [...this.broughtBack];
      this.broughtBack.clear();
      return { added };
    });
  }

  /**
   * Brings both sides up to date, as `reconcile()` does, and returns the ledger's identity and the state mark the
   * store holds after it: two strings, and nothing else. Read fresh from storage on every call.
   *
   * @throws {ForgottenLedgerError} `LEDGER_IDENTITY_MISMATCH` when a side no longer holds the identity the open found
   *   (its database was replaced under the open handle), `LEDGER_STATE_INVALID` when a side's rows are damaged.
   *
   * @example
   * const { identity, mark } = await ledger.readState();
   * // Two marks of one identity: equal means no tombstone was written between the two reads.
   */
  async readState(): Promise<Readonly<{ identity: string; mark: string }>> {
    return this.step(async () => {
      const { identity, mark } = await this.unite();
      return Object.freeze({ identity, mark });
    });
  }

  /** How many tombstones either ledger holds, markers aside: 0 for a store that has forgotten nobody. */
  async size(): Promise<number> {
    const hashes = new Set<string>();
    for (const adapter of this.copy ? [this.primary, this.copy] : [this.primary]) {
      for (const row of await ForgottenLedger.rowsOf(adapter)) if (!isMarker(row.hash)) hashes.add(row.hash);
    }
    return hashes.size;
  }

  /**
   * How many tombstones of either ledger, markers aside, are none of this subject's forms.
   *
   * @throws {TypeError} For a subject with another kind or no id.
   */
  async countNotOf(subject: SuppressionSubject): Promise<number> {
    const own = new Set(await this.forms(checked(subject)));
    const others = new Set<string>();
    for (const adapter of this.copy ? [this.primary, this.copy] : [this.primary]) {
      for (const row of await ForgottenLedger.rowsOf(adapter)) {
        if (!isMarker(row.hash) && !own.has(row.hash)) others.add(row.hash);
      }
    }
    return others.size;
  }

  /**
   * Every hash a tombstone of the subject can have. Per namespace: the keyed form under each key, the unkeyed form,
   * and for a user the learning layer's form, SHA-256 over the canonical JSON `[namespace, id]`. A session has no
   * two-element form, so a session's id never matches a user's tombstone.
   */
  private async forms(subject: SuppressionSubject): Promise<string[]> {
    const forms = new Set<string>();
    for (const namespace of this.namespaces) {
      for (const key of this.keys) forms.add(await ForgottenLedger.hash(namespace, subject, key));
      forms.add(await ForgottenLedger.hash(namespace, subject));
      if (subject.kind === 'user') forms.add(await sha256Hex(canonicalJson([namespace, subject.id])));
    }
    return [...forms];
  }

  /** Writes one row; false when the table already held its hash. */
  private static async insert(adapter: StorageAdapter, row: LedgerRow): Promise<boolean> {
    const result = await adapter.run(INSERT_ROW, [row.hash, row.namespace, row.forgotten_at]);
    return result.changes > 0;
  }

  /** Every row of a ledger, markers included. */
  private static async rowsOf(adapter: StorageAdapter): Promise<LedgerRow[]> {
    const rows = await adapter.all<LedgerRow>('SELECT hash, namespace, forgotten_at FROM agentos_learning_forgotten');
    // A copied keyed tombstone must never precede the marker that requires its key on the next open.
    return rows.sort((a, b) => Number(isMarker(b.hash)) - Number(isMarker(a.hash)));
  }
}
