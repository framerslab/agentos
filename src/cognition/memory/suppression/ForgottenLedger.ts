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
 */
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { canonicalJson, sha256Hex } from '../../learning/ledger/canonical.js';

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

/** Why a ledger did not open. The message never holds an id or a key. */
export class ForgottenLedgerError extends Error {
  override readonly name = 'ForgottenLedgerError';
  constructor(
    readonly code: 'COPY_UNAVAILABLE' | 'KEY_REQUIRED',
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
   * Creates the table where missing on each adapter, then checks the copy marker and the key markers.
   *
   * A store that never had a copy and is given one has both marked as a pair. An existing copy is repaired from
   * the primary too, after marker validation, so replacing the copy with an older backup cannot lose tombstones.
   *
   * @throws {TypeError} When any current or previous key is empty.
   *
   * @throws {ForgottenLedgerError} `COPY_UNAVAILABLE` when the copy is the primary database, cannot be read, or when
   *   the store had a copy and the copy given does not know it (or none is given); `KEY_REQUIRED` when either ledger holds the marker of a key
   *   that was not passed. Nothing is copied or marked by an open that is refused.
   */
  static async open(options: ForgottenLedgerOptions): Promise<ForgottenLedger> {
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

    // Repair an older copy too: primary tombstones must survive a later restore of the primary. Do this only
    // after both ledgers' markers have been checked, so a refused open still copies nothing.
    if (copy) for (const row of primaryRows) await ForgottenLedger.insert(copy, row);
    if (copy && !primaryPaired && !copyPaired) {
      const marker: LedgerRow = { hash: COPY_MARKER, namespace: '', forgotten_at: new Date().toISOString() };
      await ForgottenLedger.insert(copy, marker);
      await ForgottenLedger.insert(primary, marker);
    }
    return new ForgottenLedger(primary, copy, keys, namespaces);
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
   * Writes the tombstone to the copy, then to the primary. `written` is false when both held it. Rejects when either
   * write fails: a caller deletes nothing without the tombstone in both.
   *
   * @throws {TypeError} For a subject with another kind or no id.
   */
  async markForgotten(subject: SuppressionSubject): Promise<{ form: 'keyed' | 'unkeyed'; written: boolean }> {
    const who = checked(subject);
    const current = this.keys[0];
    const forgottenAt = new Date().toISOString();
    if (current !== undefined) {
      // The key's marker goes in before the first tombstone it writes, so no keyed tombstone is without one.
      const marker: LedgerRow = { hash: await ForgottenLedger.keyMarker(current), namespace: '', forgotten_at: forgottenAt };
      if (this.copy) await ForgottenLedger.insert(this.copy, marker);
      await ForgottenLedger.insert(this.primary, marker);
    }
    const tombstone: LedgerRow = { hash: await ForgottenLedger.hash('', who, current), namespace: '', forgotten_at: forgottenAt };
    const inCopy = this.copy ? await ForgottenLedger.insert(this.copy, tombstone) : false;
    const inPrimary = await ForgottenLedger.insert(this.primary, tombstone);
    return { form: current === undefined ? 'unkeyed' : 'keyed', written: inCopy || inPrimary };
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
   * Fills missing rows in both directions. `added` lists the tombstones brought back into the primary, markers
   * left out. With no copy there is nothing to bring back.
   */
  async reconcile(): Promise<{ added: string[] }> {
    if (!this.copy) return { added: [] };
    const primaryRows = await ForgottenLedger.rowsOf(this.primary);
    const copyRows = await ForgottenLedger.rowsOf(this.copy);
    const held = new Set(primaryRows.map((row) => row.hash));
    for (const row of primaryRows) await ForgottenLedger.insert(this.copy, row);
    const added: string[] = [];
    for (const row of copyRows) {
      if (held.has(row.hash)) continue;
      if ((await ForgottenLedger.insert(this.primary, row)) && !isMarker(row.hash)) added.push(row.hash);
    }
    return { added };
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
