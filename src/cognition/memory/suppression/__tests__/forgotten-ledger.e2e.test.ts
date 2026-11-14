/**
 * @file forgotten-ledger.e2e.test.ts
 * The forgotten-user ledger over real databases. A ledger writes one row per forgotten subject into the table the
 * learning store already has, `agentos_learning_forgotten`: a hash of the subject, never its id. It keeps a second copy
 * of the table in a database a restore of the store does not replace, and copies it back on request, so a store
 * restored from before a deletion still knows the deletion. With a key the hash is an HMAC and the store records which
 * key wrote it; such a store does not open without every key it has used. A store whose copy is gone does not open.
 * The copy's file is opened with `secure_delete` on, so a row deleted from it is overwritten in the file.
 *
 * The learning layer keeps a tombstone row of its own in its learning store and reaches the ledger through one route:
 * with no shared ledger the route makes the store calls the layer made without it; with one, a user either side
 * forgot is forgotten for both, the shared tombstone is written first, and a keyed ledger leaves no unkeyed row
 * behind. The route's cases run on a SQL learning store over a SQLite file and on the in-process store.
 *
 * Every case runs on SQLite files in a folder of its own. The first case also runs with the store on Postgres and the
 * copy on a SQLite file when `AGENTOS_TEST_POSTGRES_URL` names a database (CI's Test & Lint job sets it); its tables go
 * in a schema of the run's own, dropped once the cases have run.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { createPostgresAdapter, resolveStorageAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { resetLoggerFactory, setLogger } from '../../../../core/logging/loggerFactory.js';
import { createLearningLayer, InMemoryLearningStore } from '../../../learning/index.js';
import { canonicalJson } from '../../../learning/ledger/canonical.js';
import { tombstoneHash } from '../../../learning/ledger/Ledger.js';
import { SqlLearningStore } from '../../../learning/store/SqlLearningStore.js';
import * as root from '../../../../index.js';
import { ForgottenLedger, ForgottenLedgerError, type SuppressionSubject } from '../ForgottenLedger.js';
import { openForgottenCopy } from '../forgottenCopy.js';
import { learnerTombstones, shareForgottenLedger, sharedForgottenLedgerOf, type NamespacedUser } from '../learnerTombstones.js';

const POSTGRES_URL = process.env.AGENTOS_TEST_POSTGRES_URL;
/** This run's own mark, in the names of the schemas its Postgres cases make and drop. */
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
/** The schemas this run's Postgres cases made. */
const segments: string[] = [];

const EARLIER = '2026-10-12T11:00:00.000Z';
const NOW = '2026-10-12T12:00:00.000Z';
const TABLE_DDL = `CREATE TABLE IF NOT EXISTS agentos_learning_forgotten (
  hash TEXT PRIMARY KEY,
  namespace TEXT NOT NULL DEFAULT '',
  forgotten_at TEXT NOT NULL
);`;

const ALICE: SuppressionSubject = { kind: 'user', id: 'alice' };
const BOB: SuppressionSubject = { kind: 'user', id: 'bob' };

const dirs: string[] = [];
const adapters: StorageAdapter[] = [];
/** Every line the library logged in the case, parsed. */
let logged: Array<Record<string, unknown>> = [];

beforeEach(() => {
  logged = [];
  setLogger(
    pino(
      { level: 'debug', base: undefined },
      {
        write(line: string) {
          logged.push(JSON.parse(line) as Record<string, unknown>);
        },
      },
    ),
  );
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetLoggerFactory();
  while (adapters.length) await adapters.pop()!.close().catch(() => undefined);
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** The lines of the ledger's refusal event. */
const refusals = () => logged.filter((line) => line.event === 'memory.ledger_refused');

/** A new folder of this case's own, removed after it. */
function folder(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgotten-ledger-'));
  dirs.push(dir);
  return dir;
}

/** A SQLite adapter on a file, closed after the case. */
async function sqliteAt(file: string): Promise<StorageAdapter> {
  const adapter = await resolveStorageAdapter({ filePath: file, priority: ['better-sqlite3'], quiet: true });
  adapters.push(adapter);
  return adapter;
}

interface Pair {
  primary: StorageAdapter;
  copy: StorageAdapter;
}

/** The store's database and the copy's, as two SQLite files in one folder. */
async function openPair(dir: string): Promise<Pair> {
  return { primary: await sqliteAt(path.join(dir, 'memory.sqlite')), copy: await sqliteAt(path.join(dir, 'forgotten.sqlite')) };
}

/** Closes both databases, as a process that exits does. */
async function closePair(pair: Pair): Promise<void> {
  await pair.primary.close();
  await pair.copy.close();
}

interface LedgerRow {
  hash: string;
  namespace: string;
}

const rowsOf = (adapter: StorageAdapter): Promise<LedgerRow[]> =>
  adapter.all<LedgerRow>('SELECT hash, namespace FROM agentos_learning_forgotten ORDER BY hash');

/** The rows that are tombstones: a marker holds a ':', which no hash holds. */
const tombstonesOf = async (adapter: StorageAdapter): Promise<LedgerRow[]> => (await rowsOf(adapter)).filter((row) => !row.hash.includes(':'));

/** The marker rows that start with a prefix. */
const markersOf = async (adapter: StorageAdapter, prefix: string): Promise<string[]> =>
  (await rowsOf(adapter)).map((row) => row.hash).filter((hash) => hash.startsWith(prefix));

const insertRow = (adapter: StorageAdapter, hash: string, namespace: string): Promise<unknown> =>
  adapter.run('INSERT INTO agentos_learning_forgotten (hash, namespace, forgotten_at) VALUES (?, ?, ?)', [hash, namespace, EARLIER]);

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const markerOf = (key: string): string => `k1:${sha256(key).slice(0, 16)}`;

/** The row that holds a ledger's identity, and the row that holds its state mark. */
const IDENTITY = 'i1:identity';
const STATE = 's1:state';

interface FullRow {
  hash: string;
  namespace: string;
  forgotten_at: string;
}

/** Every row of a side with its value, to compare a side before and after a call. */
const everyRowOf = (adapter: StorageAdapter): Promise<FullRow[]> =>
  adapter.all<FullRow>('SELECT hash, namespace, forgotten_at FROM agentos_learning_forgotten ORDER BY hash');

/** Both sides' rows, store first. */
const bothSides = async (pair: Pair): Promise<FullRow[][]> => [await everyRowOf(pair.primary), await everyRowOf(pair.copy)];

/** The value a marker row holds on one side, or undefined when the side has no such row. */
async function valueOf(adapter: StorageAdapter, hash: string): Promise<string | undefined> {
  const row = await adapter.get<{ forgotten_at: string }>('SELECT forgotten_at FROM agentos_learning_forgotten WHERE hash = ?', [hash]);
  return row?.forgotten_at;
}
const identityOf = (adapter: StorageAdapter): Promise<string | undefined> => valueOf(adapter, IDENTITY);
const stateOf = (adapter: StorageAdapter): Promise<string | undefined> => valueOf(adapter, STATE);

/** The rows under `i` or `s` and a version: the identity and the state, and nothing else once a ledger has opened. */
const ledgerRowsOf = async (adapter: StorageAdapter): Promise<FullRow[]> =>
  (await everyRowOf(adapter)).filter((row) => /^[is][0-9]+:/.test(row.hash));

/** A side's state mark as the number it is. */
const markOf = async (adapter: StorageAdapter): Promise<bigint> => BigInt(`0x${(await stateOf(adapter)) ?? ''}`);

/** The millisecond in a state mark's first 16 hex characters. */
const timeOf = (mark: string | undefined): number => Number.parseInt((mark ?? '').slice(0, 16), 16);

/** A ledger as this library wrote it before the identity and state rows: the table, then its rows by SQL. */
async function writeOldLedger(adapter: StorageAdapter, rows: ReadonlyArray<readonly [hash: string, namespace: string]>): Promise<void> {
  await adapter.exec(TABLE_DDL);
  for (const [hash, namespace] of rows) await insertRow(adapter, hash, namespace);
}

/** Puts a handwritten old ledger in the place of a side's file; the side is closed first. */
async function replaceWithOldLedger(file: string, rows: ReadonlyArray<readonly [hash: string, namespace: string]>): Promise<void> {
  for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(`${file}${suffix}`, { force: true });
  const adapter = await sqliteAt(file);
  await writeOldLedger(adapter, rows);
  await adapter.close();
}

/** Calls the ledger has from this change on, reached through a typed view of a handle. */
interface StateReader {
  readState(): Promise<{ identity: string; mark: string }>;
}
const reader = (ledger: ForgottenLedger): StateReader => ledger as unknown as StateReader;

/** The state mark's first case, on whatever database holds the store: every tombstone write raises it, a repeat too. */
async function advancesOnEveryTombstone(pair: Pair): Promise<void> {
  const ledger = await ForgottenLedger.open(pair);
  const marks: bigint[] = [await markOf(pair.primary)];
  for (const subject of [ALICE, BOB]) {
    expect((await ledger.markForgotten(subject)).written).toBe(true);
    marks.push(await markOf(pair.primary));
    expect(await stateOf(pair.copy)).toBe(await stateOf(pair.primary));
  }
  const hash = await ForgottenLedger.hash('', ALICE);
  const forgottenAt = await valueOf(pair.primary, hash);
  // A repeat writes no row and keeps the tombstone's time, and still raises the mark.
  expect(await ledger.markForgotten(ALICE)).toEqual({ form: 'unkeyed', written: false });
  marks.push(await markOf(pair.primary));
  expect(await stateOf(pair.copy)).toBe(await stateOf(pair.primary));
  expect([await valueOf(pair.primary, hash), await valueOf(pair.copy, hash)]).toEqual([forgottenAt, forgottenAt]);
  for (const [index, mark] of marks.entries()) if (index > 0) expect(mark > marks[index - 1], `write ${index} raises the mark`).toBe(true);
}

/** The first case's body, on whatever database holds the store. */
async function writesOneUnkeyedRowAndFindsIt(primary: StorageAdapter, copy: StorageAdapter): Promise<void> {
  const ledger = await ForgottenLedger.open({ primary, copy });
  expect(ledger.keyed).toBe(false);
  expect(ledger.namespaces).toEqual(['']);

  expect(await ledger.markForgotten(ALICE)).toEqual({ form: 'unkeyed', written: true });

  const hash = await ForgottenLedger.hash('', ALICE);
  expect(hash).toMatch(/^[0-9a-f]{64}$/);
  expect(hash).toBe(sha256(canonicalJson(['', 'user', 'alice'])));
  expect(await tombstonesOf(primary)).toEqual([{ hash, namespace: '' }]);
  expect(await tombstonesOf(copy)).toEqual([{ hash, namespace: '' }]);
  // Neither database holds the id itself.
  for (const adapter of [primary, copy]) {
    const everything = await adapter.all<Record<string, unknown>>('SELECT * FROM agentos_learning_forgotten');
    expect(JSON.stringify(everything)).not.toContain('alice');
  }

  expect(await ledger.isForgotten(ALICE)).toBe(true);
  expect(await ledger.isForgotten(BOB)).toBe(false);
  expect(await ledger.markForgotten(ALICE)).toEqual({ form: 'unkeyed', written: false });
  expect(await tombstonesOf(primary)).toHaveLength(1);
}

describe('the forgotten-user ledger', () => {
  it('is exported from the package root', () => {
    expect(root.ForgottenLedger).toBe(ForgottenLedger);
    expect(root.ForgottenLedgerError).toBe(ForgottenLedgerError);
    expect(root.openForgottenCopy).toBe(openForgottenCopy);
  });

  it('writes one unkeyed row for a user and finds it again', async () => {
    const { primary, copy } = await openPair(folder());
    await writesOneUnkeyedRowAndFindsIt(primary, copy);
  });

  it('refuses the primary adapter as its own copy', async () => {
    const primary = await sqliteAt(path.join(folder(), 'memory.sqlite'));
    await expect(ForgottenLedger.open({ primary, copy: primary })).rejects.toMatchObject({ code: 'COPY_UNAVAILABLE' });
  });

  it('refuses a second connection to the primary file as its copy', async () => {
    const file = path.join(folder(), 'memory.sqlite');
    const primary = await sqliteAt(file);
    const copy = await sqliteAt(file);
    await expect(ForgottenLedger.open({ primary, copy })).rejects.toMatchObject({ code: 'COPY_UNAVAILABLE' });
  });

  it.each(['', new Uint8Array(0)])('refuses an empty current key (%s)', async (current) => {
    const pair = await openPair(folder());
    await expect(ForgottenLedger.open({ ...pair, key: { current } })).rejects.toThrow(TypeError);
  });

  it('refuses an empty previous key', async () => {
    const pair = await openPair(folder());
    await expect(ForgottenLedger.open({ ...pair, key: { current: 'secret', previous: [''] } })).rejects.toThrow(TypeError);
  });

  it('repairs an older copy before a later restore of the primary', async () => {
    const dir = folder();
    const copyFile = path.join(dir, 'forgotten.sqlite');
    const primaryFile = path.join(dir, 'memory.sqlite');
    const oldCopy = path.join(dir, 'old-copy.sqlite');
    const oldPrimary = path.join(dir, 'old-primary.sqlite');
    let pair = await openPair(dir);
    await ForgottenLedger.open(pair);
    await closePair(pair);
    fs.copyFileSync(copyFile, oldCopy);
    fs.copyFileSync(primaryFile, oldPrimary);
    pair = await openPair(dir);
    await (await ForgottenLedger.open(pair)).markForgotten(ALICE);
    await closePair(pair);
    fs.copyFileSync(oldCopy, copyFile);
    pair = await openPair(dir);
    const reopened = await ForgottenLedger.open(pair);
    expect(await tombstonesOf(pair.copy)).toEqual(await tombstonesOf(pair.primary));
    await reopened.reconcile();
    expect(await tombstonesOf(pair.copy)).toEqual(await tombstonesOf(pair.primary));
    await closePair(pair);
    fs.copyFileSync(oldPrimary, primaryFile);
    pair = await openPair(dir);
    const restored = await ForgottenLedger.open(pair);
    await restored.reconcile();
    expect(await restored.isForgotten(ALICE)).toBe(true);
  });

  it('reconciles a copy that loses a tombstone while the ledger is open', async () => {
    const pair = await openPair(folder());
    const ledger = await ForgottenLedger.open(pair);
    await ledger.markForgotten(ALICE);
    await pair.copy.run('DELETE FROM agentos_learning_forgotten WHERE hash = ?', [await ForgottenLedger.hash('', ALICE)]);
    await ledger.reconcile();
    expect(await tombstonesOf(pair.copy)).toEqual(await tombstonesOf(pair.primary));
  });

  it('names the ledger in errors outside a souled agent', async () => {
    const pair = await openPair(folder());
    await (await ForgottenLedger.open({ ...pair, key: { current: 'secret' } })).markForgotten(ALICE);
    await expect(ForgottenLedger.open(pair)).rejects.toThrow(/^ForgottenLedger:/);
  });

  it('keeps a session and a user of one id apart', async () => {
    const { primary, copy } = await openPair(folder());
    const ledger = await ForgottenLedger.open({ primary, copy });

    await ledger.markForgotten({ kind: 'user', id: 'bob' });
    expect(await ledger.isForgotten({ kind: 'user', id: 'bob' })).toBe(true);
    expect(await ledger.isForgotten({ kind: 'session', id: 'bob' })).toBe(false);

    await ledger.markForgotten({ kind: 'session', id: 'cy' });
    expect(await ledger.isForgotten({ kind: 'session', id: 'cy' })).toBe(true);
    expect(await ledger.isForgotten({ kind: 'user', id: 'cy' })).toBe(false);
  });

  it('reads a tombstone the learning layer wrote, for a user and never for a session', async () => {
    const primary = await sqliteAt(path.join(folder(), 'memory.sqlite'));
    const reading = await ForgottenLedger.open({ primary, namespaces: ['A', 'A', ''] });
    expect(reading.namespaces).toEqual(['', 'A']);
    const plain = await ForgottenLedger.open({ primary });

    await insertRow(primary, await tombstoneHash('A', 'ana'), 'A');
    expect(await reading.isForgotten({ kind: 'user', id: 'ana' })).toBe(true);
    expect(await reading.isForgotten({ kind: 'session', id: 'ana' })).toBe(false);
    // A ledger that does not read namespace A does not read its tombstones.
    expect(await plain.isForgotten({ kind: 'user', id: 'ana' })).toBe(false);
    expect(await plain.isForgotten({ kind: 'session', id: 'ana' })).toBe(false);

    // The layer's tombstone under the store-wide namespace is read by every ledger.
    await insertRow(primary, await tombstoneHash('', 'bea'), '');
    expect(await plain.isForgotten({ kind: 'user', id: 'bea' })).toBe(true);
    expect(await plain.isForgotten({ kind: 'session', id: 'bea' })).toBe(false);
  });

  it('writes the HMAC and one marker row with a key', async () => {
    const { primary, copy } = await openPair(folder());
    const ledger = await ForgottenLedger.open({ primary, copy, key: { current: 'k-one' } });
    expect(ledger.keyed).toBe(true);

    expect(await ledger.markForgotten(ALICE)).toEqual({ form: 'keyed', written: true });

    const keyed = createHmac('sha256', 'k-one').update(canonicalJson(['', 'user', 'alice'])).digest('hex');
    expect(keyed).not.toBe(await ForgottenLedger.hash('', ALICE));
    expect(await ForgottenLedger.hash('', ALICE, 'k-one')).toBe(keyed);
    for (const adapter of [primary, copy]) {
      expect(await tombstonesOf(adapter)).toEqual([{ hash: keyed, namespace: '' }]);
      expect(await markersOf(adapter, 'k1:')).toEqual([markerOf('k-one')]);
    }
    expect(await ledger.isForgotten(ALICE)).toBe(true);
    expect(await ledger.isForgotten(BOB)).toBe(false);

    // A key given as bytes is the key given as the text those bytes spell.
    const bytes = new TextEncoder().encode('k-one');
    expect(await ForgottenLedger.hash('', ALICE, bytes)).toBe(keyed);
    expect(await ForgottenLedger.keyMarker(bytes)).toBe(markerOf('k-one'));
    expect(await ForgottenLedger.keyMarker('k-one')).toBe(markerOf('k-one'));
  });

  it('still reads unkeyed tombstones written before the key', async () => {
    const dir = folder();
    let pair = await openPair(dir);
    await (await ForgottenLedger.open(pair)).markForgotten(ALICE);
    await closePair(pair);

    pair = await openPair(dir);
    const ledger = await ForgottenLedger.open({ ...pair, key: { current: 'k-one' } });
    expect(await ledger.isForgotten(ALICE)).toBe(true);

    expect(await ledger.markForgotten(BOB)).toEqual({ form: 'keyed', written: true });
    const hashes = (await tombstonesOf(pair.primary)).map((row) => row.hash);
    expect(hashes).toContain(await ForgottenLedger.hash('', ALICE));
    expect(hashes).toContain(await ForgottenLedger.hash('', BOB, 'k-one'));
    expect(hashes).not.toContain(await ForgottenLedger.hash('', BOB));
  });

  it('does not open a keyed store without its key', async () => {
    const dir = folder();
    let pair = await openPair(dir);
    await (await ForgottenLedger.open({ ...pair, key: { current: 'k-one' } })).markForgotten(ALICE);
    await closePair(pair);

    pair = await openPair(dir);
    const refused = await ForgottenLedger.open(pair).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ForgottenLedgerError);
    expect(refused).toMatchObject({ name: 'ForgottenLedgerError', code: 'KEY_REQUIRED' });
    expect((refused as Error).message).toMatch(/tombstoneKey/);
    expect((refused as Error).message).not.toContain('k-one');

    await expect(ForgottenLedger.open({ ...pair, key: { current: 'k-other' } })).rejects.toMatchObject({
      name: 'ForgottenLedgerError',
      code: 'KEY_REQUIRED',
    });

    // The key it was written with opens it.
    const ledger = await ForgottenLedger.open({ ...pair, key: { current: 'k-one' } });
    expect(await ledger.isForgotten(ALICE)).toBe(true);
  });

  it('holds old tombstones after a rotation', async () => {
    const dir = folder();
    let pair = await openPair(dir);
    await (await ForgottenLedger.open({ ...pair, key: { current: 'k-one' } })).markForgotten(ALICE);
    await closePair(pair);

    pair = await openPair(dir);
    const rotated = await ForgottenLedger.open({ ...pair, key: { current: 'k-two', previous: ['k-one'] } });
    expect(await rotated.isForgotten(ALICE)).toBe(true);
    expect(await rotated.markForgotten(BOB)).toEqual({ form: 'keyed', written: true });
    expect((await tombstonesOf(pair.primary)).map((row) => row.hash)).toContain(await ForgottenLedger.hash('', BOB, 'k-two'));
    for (const adapter of [pair.primary, pair.copy]) {
      expect(await markersOf(adapter, 'k1:')).toEqual([markerOf('k-one'), markerOf('k-two')].sort());
    }
    await closePair(pair);

    // A store two keys have written needs both.
    pair = await openPair(dir);
    await expect(ForgottenLedger.open({ ...pair, key: { current: 'k-two' } })).rejects.toMatchObject({ code: 'KEY_REQUIRED' });
    const both = await ForgottenLedger.open({ ...pair, key: { current: 'k-two', previous: ['k-one'] } });
    expect(await both.isForgotten(ALICE)).toBe(true);
    expect(await both.isForgotten(BOB)).toBe(true);
  });

  it('rejects the write when the copy cannot be written', async () => {
    const { primary, copy } = await openPair(folder());
    const ledger = await ForgottenLedger.open({ primary, copy });
    await copy.close();

    await expect(ledger.markForgotten(ALICE)).rejects.toThrow();
    expect(await tombstonesOf(primary)).toEqual([]);
  });

  it('reconciles a primary restored from before a deletion', async () => {
    const dir = folder();
    const memoryFile = path.join(dir, 'memory.sqlite');
    const before = path.join(dir, 'before.sqlite');
    let pair = await openPair(dir);
    await ForgottenLedger.open(pair);
    await closePair(pair);
    fs.copyFileSync(memoryFile, before);

    pair = await openPair(dir);
    await (await ForgottenLedger.open(pair)).markForgotten(ALICE);
    await closePair(pair);
    // The store's database goes back to the backup; the copy is not part of the backup.
    fs.copyFileSync(before, memoryFile);

    pair = await openPair(dir);
    const ledger = await ForgottenLedger.open(pair);
    const hash = await ForgottenLedger.hash('', ALICE);
    expect(await tombstonesOf(pair.primary)).toEqual([]);
    expect(await ledger.isForgotten(ALICE)).toBe(true);

    expect(await ledger.reconcile()).toEqual({ added: [hash] });
    expect(await tombstonesOf(pair.primary)).toEqual([{ hash, namespace: '' }]);
    expect(await ledger.reconcile()).toEqual({ added: [] });

    // The row is in the store's file, not only in this connection.
    await closePair(pair);
    const reopened = await sqliteAt(memoryFile);
    expect(await tombstonesOf(reopened)).toEqual([{ hash, namespace: '' }]);
  });

  it('answers an empty reconcile with no copy', async () => {
    const primary = await sqliteAt(path.join(folder(), 'memory.sqlite'));
    const ledger = await ForgottenLedger.open({ primary });
    expect(await ledger.markForgotten(ALICE)).toEqual({ form: 'unkeyed', written: true });
    expect(await ledger.isForgotten(ALICE)).toBe(true);
    expect(await ledger.reconcile()).toEqual({ added: [] });
    // A store that never had a copy holds no copy marker.
    expect(await markersOf(primary, 'c1:')).toEqual([]);
  });

  it('seeds a new copy with the tombstones the primary already holds', async () => {
    const { primary, copy } = await openPair(folder());
    await primary.exec(TABLE_DDL);
    const old = 'a'.repeat(64);
    await insertRow(primary, old, 'A');

    await ForgottenLedger.open({ primary, copy });

    expect(await tombstonesOf(copy)).toEqual([{ hash: old, namespace: 'A' }]);
    expect(await copy.get<{ forgotten_at: string }>('SELECT forgotten_at FROM agentos_learning_forgotten WHERE hash = ?', [old])).toEqual({
      forgotten_at: EARLIER,
    });
    expect(await markersOf(copy, 'c1:')).toEqual(['c1:copy']);
    expect(await tombstonesOf(primary)).toEqual([{ hash: old, namespace: 'A' }]);
    expect(await markersOf(primary, 'c1:')).toEqual(['c1:copy']);
  });

  it('does not open when the copy is gone or unreadable', async () => {
    const dir = folder();
    const copyFile = path.join(dir, 'forgotten.sqlite');
    let pair = await openPair(dir);
    await (await ForgottenLedger.open(pair)).markForgotten(ALICE);
    await closePair(pair);

    // The copy's file is gone: a fresh adapter on its path makes an empty database.
    fs.rmSync(copyFile);
    pair = await openPair(dir);
    const refused = await ForgottenLedger.open(pair).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ForgottenLedgerError);
    expect(refused).toMatchObject({ name: 'ForgottenLedgerError', code: 'COPY_UNAVAILABLE' });
    await closePair(pair);

    // The copy's file is not a database.
    fs.rmSync(copyFile, { force: true });
    fs.writeFileSync(copyFile, 'not a database');
    pair = await openPair(dir);
    await expect(ForgottenLedger.open(pair)).rejects.toMatchObject({ name: 'ForgottenLedgerError', code: 'COPY_UNAVAILABLE' });
    await closePair(pair);

    // No copy is configured for a store that had one.
    const primary = await sqliteAt(path.join(dir, 'memory.sqlite'));
    await expect(ForgottenLedger.open({ primary })).rejects.toMatchObject({ name: 'ForgottenLedgerError', code: 'COPY_UNAVAILABLE' });
  });

  it("counts the tombstones that are not one subject's", async () => {
    const plainPair = await openPair(folder());
    const plain = await ForgottenLedger.open(plainPair);
    expect(await plain.countNotOf(ALICE)).toBe(0);
    await plain.markForgotten(ALICE);
    expect(await plain.countNotOf(ALICE)).toBe(0);
    await plain.markForgotten({ kind: 'session', id: 's1' });
    expect(await plain.countNotOf(ALICE)).toBe(1);
    expect(await plain.countNotOf({ kind: 'session', id: 's1' })).toBe(1);
    expect(await plain.countNotOf(BOB)).toBe(2);

    // With a key, neither the key marker nor the copy marker is counted.
    const keyedPair = await openPair(folder());
    const keyed = await ForgottenLedger.open({ ...keyedPair, key: { current: 'k-one' } });
    await keyed.markForgotten(ALICE);
    await keyed.markForgotten({ kind: 'session', id: 's1' });
    expect(await markersOf(keyedPair.primary, 'k1:')).toHaveLength(1);
    expect(await keyed.countNotOf(ALICE)).toBe(1);
  });

  it('refuses a subject with no id', async () => {
    const primary = await sqliteAt(path.join(folder(), 'memory.sqlite'));
    const ledger = await ForgottenLedger.open({ primary });

    await expect(ledger.markForgotten({ kind: 'user', id: '' })).rejects.toThrow(TypeError);
    await expect(ledger.isForgotten({ kind: 'user', id: '' })).rejects.toThrow(TypeError);
    await expect(ledger.markForgotten({ kind: 'operator', id: 'x' } as unknown as SuppressionSubject)).rejects.toThrow(TypeError);
    expect(await tombstonesOf(primary)).toEqual([]);
  });

  it('refuses a tombstone write as unavailable while another connection holds the write lock, with one line', async () => {
    const dir = folder();
    const pair = await openPair(dir);
    const ledger = await ForgottenLedger.open(pair);
    // Another connection to the copy's file holds its write lock past this connection's busy timeout.
    await pair.copy.get('PRAGMA busy_timeout = 50');
    const holder = await sqliteAt(path.join(dir, 'forgotten.sqlite'));
    await holder.run('BEGIN IMMEDIATE');
    logged.length = 0;

    const refused = await ledger.markForgotten(ALICE).catch((error: unknown) => error);
    await holder.run('ROLLBACK');

    expect(refused).toBeInstanceOf(ForgottenLedgerError);
    expect(refused).toMatchObject({ name: 'ForgottenLedgerError', code: 'LEDGER_UNAVAILABLE' });
    expect(refusals()).toEqual([expect.objectContaining({ type: 'ForgottenLedgerError', code: 'LEDGER_UNAVAILABLE' })]);
    expect(await tombstonesOf(pair.primary)).toEqual([]);
    expect(await tombstonesOf(pair.copy)).toEqual([]);
    // Once the lock is let go, the same call writes the tombstone to both sides.
    expect(await ledger.markForgotten(ALICE)).toMatchObject({ written: true });
    expect(await tombstonesOf(pair.copy)).toHaveLength(1);
  });
});

describe("the ledger's identity", () => {
  const KEYED_HASH = 'b'.repeat(64);

  it('refuses a paired copy from another ledger before changing either side', async () => {
    const first = folder();
    const second = folder();
    for (const dir of [first, second]) {
      const pair = await openPair(dir);
      await ForgottenLedger.open(pair);
      await closePair(pair);
    }
    const crossed: Pair = {
      primary: await sqliteAt(path.join(first, 'memory.sqlite')),
      copy: await sqliteAt(path.join(second, 'forgotten.sqlite')),
    };
    const before = await bothSides(crossed);
    logged.length = 0;

    const refused = await ForgottenLedger.open(crossed).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(ForgottenLedgerError);
    expect(refused).toMatchObject({ name: 'ForgottenLedgerError', code: 'LEDGER_IDENTITY_MISMATCH' });
    expect(await bothSides(crossed)).toEqual(before);
    expect(refusals()).toEqual([expect.objectContaining({ type: 'ForgottenLedgerError', code: 'LEDGER_IDENTITY_MISMATCH' })]);
    const message = (refused as Error).message;
    expect(message).toMatch(/^ForgottenLedger:/);
    for (const identity of [await identityOf(crossed.primary), await identityOf(crossed.copy)]) {
      expect(identity).toMatch(/^[0-9a-f]{32}$/);
      expect(message).not.toContain(identity);
    }
  });

  it('gives a new ledger one identity row and one state row, the same on both sides', async () => {
    const pair = await openPair(folder());
    const startedAt = Date.now();
    await ForgottenLedger.open(pair);
    const endedAt = Date.now();

    for (const side of [pair.primary, pair.copy]) {
      expect(await ledgerRowsOf(side)).toEqual([
        { hash: IDENTITY, namespace: '', forgotten_at: expect.stringMatching(/^[0-9a-f]{32}$/) },
        { hash: STATE, namespace: '', forgotten_at: expect.stringMatching(/^[0-9a-f]{64}$/) },
      ]);
    }
    expect(await identityOf(pair.copy)).toBe(await identityOf(pair.primary));
    expect(await stateOf(pair.copy)).toBe(await stateOf(pair.primary));
    // A new ledger's mark holds the millisecond it was made.
    const madeAt = timeOf(await stateOf(pair.primary));
    expect(madeAt).toBeGreaterThanOrEqual(startedAt);
    expect(madeAt).toBeLessThanOrEqual(endedAt);

    // Another ledger has an identity of its own.
    const other = await openPair(folder());
    await ForgottenLedger.open(other);
    expect(await identityOf(other.primary)).toMatch(/^[0-9a-f]{32}$/);
    expect(await identityOf(other.primary)).not.toBe(await identityOf(pair.primary));

    // Neither row holds the subject's id, the key, the key's fingerprint or a tombstone's hash.
    const keyedPair = await openPair(folder());
    const keyed = await ForgottenLedger.open({ ...keyedPair, key: { current: 'k-secret' } });
    await keyed.markForgotten(ALICE);
    const tombstone = await ForgottenLedger.hash('', ALICE, 'k-secret');
    expect((await tombstonesOf(keyedPair.primary)).map((row) => row.hash)).toEqual([tombstone]);
    for (const side of [keyedPair.primary, keyedPair.copy]) {
      const values = (await ledgerRowsOf(side)).map((row) => row.forgotten_at);
      expect(values).toHaveLength(2);
      for (const value of values) {
        for (const secret of ['alice', 'k-secret', sha256('k-secret').slice(0, 16), tombstone]) expect(value).not.toContain(secret);
      }
    }
  });

  it('keeps its identity across a reopen and a key rotation', async () => {
    const dir = folder();
    let pair = await openPair(dir);
    await ForgottenLedger.open(pair);
    const identity = await identityOf(pair.primary);
    expect(identity).toMatch(/^[0-9a-f]{32}$/);
    await closePair(pair);

    pair = await openPair(dir);
    await ForgottenLedger.open(pair);
    expect([await identityOf(pair.primary), await identityOf(pair.copy)]).toEqual([identity, identity]);
    await closePair(pair);

    pair = await openPair(dir);
    await (await ForgottenLedger.open({ ...pair, key: { current: 'k-old' } })).markForgotten(ALICE);
    expect([await identityOf(pair.primary), await identityOf(pair.copy)]).toEqual([identity, identity]);
    await closePair(pair);

    pair = await openPair(dir);
    await ForgottenLedger.open({ ...pair, key: { current: 'k-new', previous: ['k-old'] } });
    expect([await identityOf(pair.primary), await identityOf(pair.copy)]).toEqual([identity, identity]);
  });

  it('adds the two rows to a ledger made without them, and keeps every row it held', async () => {
    const dir = folder();
    const old = [[KEYED_HASH, 'A'], ['c1:copy', ''], [markerOf('k-one'), '']] as const;
    let pair = await openPair(dir);
    await writeOldLedger(pair.primary, old);
    await writeOldLedger(pair.copy, old);
    const held = await everyRowOf(pair.primary);

    await ForgottenLedger.open({ ...pair, key: { current: 'k-one' } });

    for (const side of [pair.primary, pair.copy]) {
      expect(await ledgerRowsOf(side)).toEqual([
        { hash: IDENTITY, namespace: '', forgotten_at: expect.stringMatching(/^[0-9a-f]{32}$/) },
        { hash: STATE, namespace: '', forgotten_at: expect.stringMatching(/^[0-9a-f]{64}$/) },
      ]);
      // Every row the old ledger held keeps its hash, namespace and time.
      expect((await everyRowOf(side)).filter((row) => !/^[is][0-9]+:/.test(row.hash))).toEqual(held);
    }
    const identity = await identityOf(pair.primary);
    expect(await identityOf(pair.copy)).toBe(identity);
    expect(await stateOf(pair.copy)).toBe(await stateOf(pair.primary));
    await closePair(pair);

    pair = await openPair(dir);
    await ForgottenLedger.open({ ...pair, key: { current: 'k-one' } });
    expect([await identityOf(pair.primary), await identityOf(pair.copy)]).toEqual([identity, identity]);
  });

  it('adds the two rows to a ledger with no copy', async () => {
    const primary = await sqliteAt(path.join(folder(), 'memory.sqlite'));
    await writeOldLedger(primary, [[KEYED_HASH, '']]);

    await ForgottenLedger.open({ primary });

    expect(await ledgerRowsOf(primary)).toEqual([
      { hash: IDENTITY, namespace: '', forgotten_at: expect.stringMatching(/^[0-9a-f]{32}$/) },
      { hash: STATE, namespace: '', forgotten_at: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
    expect(await tombstonesOf(primary)).toEqual([{ hash: KEYED_HASH, namespace: '' }]);
    expect(await markersOf(primary, 'c1:')).toEqual([]);
  });

  it('gives a store without an identity the identity of its copy, with the copy\'s tombstones', async () => {
    const dir = folder();
    let pair = await openPair(dir);
    await (await ForgottenLedger.open(pair)).markForgotten(ALICE);
    await closePair(pair);
    await replaceWithOldLedger(path.join(dir, 'memory.sqlite'), [['c1:copy', '']]);

    pair = await openPair(dir);
    const ledger = await ForgottenLedger.open(pair);

    const hash = await ForgottenLedger.hash('', ALICE);
    expect(await identityOf(pair.primary)).toMatch(/^[0-9a-f]{32}$/);
    expect(await identityOf(pair.primary)).toBe(await identityOf(pair.copy));
    expect(await stateOf(pair.primary)).toBe(await stateOf(pair.copy));
    expect(await tombstonesOf(pair.primary)).toEqual([{ hash, namespace: '' }]);
    // The tombstone the open brought back is the next reconcile's to report, once.
    expect(await ledger.reconcile()).toEqual({ added: [hash] });
    expect(await ledger.reconcile()).toEqual({ added: [] });
  });

  it('refuses a store without an identity that holds a tombstone its copy lacks', async () => {
    const dir = folder();
    let pair = await openPair(dir);
    await (await ForgottenLedger.open(pair)).markForgotten(ALICE);
    await closePair(pair);
    await replaceWithOldLedger(path.join(dir, 'memory.sqlite'), [['c1:copy', ''], [await ForgottenLedger.hash('', BOB), '']]);

    pair = await openPair(dir);
    const before = await bothSides(pair);
    await expect(ForgottenLedger.open(pair)).rejects.toMatchObject({ name: 'ForgottenLedgerError', code: 'LEDGER_IDENTITY_MISMATCH' });
    expect(await bothSides(pair)).toEqual(before);
    expect(refusals()).toEqual([expect.objectContaining({ code: 'LEDGER_IDENTITY_MISMATCH' })]);
  });

  it('repairs a copy without an identity from its store', async () => {
    const dir = folder();
    let pair = await openPair(dir);
    await (await ForgottenLedger.open(pair)).markForgotten(ALICE);
    await closePair(pair);
    await replaceWithOldLedger(path.join(dir, 'forgotten.sqlite'), [['c1:copy', '']]);

    pair = await openPair(dir);
    await ForgottenLedger.open(pair);

    expect(await identityOf(pair.copy)).toMatch(/^[0-9a-f]{32}$/);
    expect(await identityOf(pair.copy)).toBe(await identityOf(pair.primary));
    expect(await stateOf(pair.copy)).toBe(await stateOf(pair.primary));
    expect(await tombstonesOf(pair.copy)).toEqual(await tombstonesOf(pair.primary));
    expect(await tombstonesOf(pair.copy)).toEqual([{ hash: await ForgottenLedger.hash('', ALICE), namespace: '' }]);
  });

  it('refuses a copy without an identity that holds a tombstone the store lacks', async () => {
    const dir = folder();
    let pair = await openPair(dir);
    await (await ForgottenLedger.open(pair)).markForgotten(ALICE);
    await closePair(pair);
    await replaceWithOldLedger(path.join(dir, 'forgotten.sqlite'), [['c1:copy', ''], [await ForgottenLedger.hash('', BOB), '']]);

    pair = await openPair(dir);
    const before = await bothSides(pair);
    await expect(ForgottenLedger.open(pair)).rejects.toMatchObject({ name: 'ForgottenLedgerError', code: 'LEDGER_IDENTITY_MISMATCH' });
    expect(await bothSides(pair)).toEqual(before);
  });

  const damages: Array<[name: string, side: 'store' | 'copy', damage: string]> = [
    ['the state row deleted', 'store', `DELETE FROM agentos_learning_forgotten WHERE hash = '${STATE}'`],
    ['the identity row deleted', 'copy', `DELETE FROM agentos_learning_forgotten WHERE hash = '${IDENTITY}'`],
    ['the identity in upper case', 'store', `UPDATE agentos_learning_forgotten SET forgotten_at = upper(forgotten_at) WHERE hash = '${IDENTITY}'`],
    ['an identity of 31 characters', 'copy', `UPDATE agentos_learning_forgotten SET forgotten_at = substr(forgotten_at, 1, 31) WHERE hash = '${IDENTITY}'`],
    ['a state of 63 characters', 'store', `UPDATE agentos_learning_forgotten SET forgotten_at = substr(forgotten_at, 1, 63) WHERE hash = '${STATE}'`],
    ['a state row with a namespace', 'copy', `UPDATE agentos_learning_forgotten SET namespace = 'x' WHERE hash = '${STATE}'`],
    ['a second identity row of another version', 'store', `INSERT INTO agentos_learning_forgotten (hash, namespace, forgotten_at) VALUES ('i2:identity', '', '${'c'.repeat(32)}')`],
    ['a state whose time reaches 2^53', 'copy', `UPDATE agentos_learning_forgotten SET forgotten_at = '0020000000000000${'0'.repeat(48)}' WHERE hash = '${STATE}'`],
  ];
  it.each(damages)('refuses a side that holds a damaged identity or state: %s', async (_name, side, damage) => {
    const dir = folder();
    let pair = await openPair(dir);
    await ForgottenLedger.open(pair);
    await (side === 'store' ? pair.primary : pair.copy).run(damage);
    await closePair(pair);

    pair = await openPair(dir);
    const before = await bothSides(pair);
    logged.length = 0;
    await expect(ForgottenLedger.open(pair)).rejects.toMatchObject({ name: 'ForgottenLedgerError', code: 'LEDGER_STATE_INVALID' });
    expect(await bothSides(pair)).toEqual(before);
    expect(refusals()).toEqual([expect.objectContaining({ type: 'ForgottenLedgerError', code: 'LEDGER_STATE_INVALID' })]);
  });

  const conflicts: Array<[field: string, change: string]> = [
    ['namespace', `UPDATE agentos_learning_forgotten SET namespace = 'x' WHERE hash = ?`],
    ['time', `UPDATE agentos_learning_forgotten SET forgotten_at = '${EARLIER}' WHERE hash = ?`],
  ];
  it.each(conflicts)('refuses a tombstone the two sides hold with another %s', async (_field, change) => {
    const dir = folder();
    let pair = await openPair(dir);
    await (await ForgottenLedger.open(pair)).markForgotten(ALICE);
    await pair.copy.run(change, [await ForgottenLedger.hash('', ALICE)]);
    await closePair(pair);

    pair = await openPair(dir);
    const before = await bothSides(pair);
    await expect(ForgottenLedger.open(pair)).rejects.toMatchObject({ name: 'ForgottenLedgerError', code: 'LEDGER_STATE_INVALID' });
    expect(await bothSides(pair)).toEqual(before);
  });

  it('pairs a store that has an identity with an empty copy', async () => {
    const dir = folder();
    const primary = await sqliteAt(path.join(dir, 'memory.sqlite'));
    await (await ForgottenLedger.open({ primary })).markForgotten(ALICE);
    const copy = await sqliteAt(path.join(dir, 'forgotten.sqlite'));

    await ForgottenLedger.open({ primary, copy });

    expect(await identityOf(copy)).toMatch(/^[0-9a-f]{32}$/);
    expect(await identityOf(copy)).toBe(await identityOf(primary));
    expect(await stateOf(copy)).toBe(await stateOf(primary));
    expect(await tombstonesOf(copy)).toEqual([{ hash: await ForgottenLedger.hash('', ALICE), namespace: '' }]);
    for (const side of [primary, copy]) expect(await markersOf(side, 'c1:')).toEqual(['c1:copy']);
  });

  it('keeps the two rows out of the counts', async () => {
    const ledger = await ForgottenLedger.open(await openPair(folder()));
    expect(await ledger.size()).toBe(0);
    expect(await ledger.countNotOf(ALICE)).toBe(0);
  });
});

describe("the ledger's state mark", () => {
  /** A fixed time, set before a ledger opens so the ledger's first mark follows the fake clock. */
  const T = Date.UTC(2026, 9, 12, 12);
  const CY: SuppressionSubject = { kind: 'session', id: 'cy' };
  const numberOf = (mark: string | undefined): bigint => BigInt(`0x${mark ?? ''}`);
  /** A trigger that makes the database refuse one hash's insert, as a failed write. */
  const refusing = (hash: string): string =>
    `CREATE TRIGGER refuse_one BEFORE INSERT ON agentos_learning_forgotten WHEN NEW.hash = '${hash}' BEGIN SELECT RAISE(ABORT, 'refused'); END;`;

  it('advances on every tombstone, and again for a repeat', async () => {
    await advancesOnEveryTombstone(await openPair(folder()));
  });

  it('advances with a stalled clock and with a clock set back', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T);
    const pair = await openPair(folder());
    const ledger = await ForgottenLedger.open(pair);

    vi.setSystemTime(T + 5);
    await ledger.markForgotten(ALICE);
    const first = await markOf(pair.primary);
    expect(timeOf(await stateOf(pair.primary))).toBe(T + 5);

    // The same millisecond again.
    await ledger.markForgotten(BOB);
    const second = await markOf(pair.primary);
    expect(second > first).toBe(true);

    // A clock set back an hour.
    vi.setSystemTime(T - 3_600_000);
    await ledger.markForgotten(CY);
    expect((await markOf(pair.primary)) > second).toBe(true);
    expect(await stateOf(pair.copy)).toBe(await stateOf(pair.primary));
  });

  it('gives two ledgers different marks for the same writes at the same times', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T);
    const pairs = [await openPair(folder()), await openPair(folder())];
    const ledgers = [await ForgottenLedger.open(pairs[0]), await ForgottenLedger.open(pairs[1])];
    let now = T;
    for (const subject of [ALICE, BOB, CY]) {
      now += 10;
      vi.setSystemTime(now);
      for (const ledger of ledgers) await ledger.markForgotten(subject);
    }
    const [one, two] = [await stateOf(pairs[0].primary), await stateOf(pairs[1].primary)];
    expect(timeOf(one)).toBe(now);
    expect(one?.slice(0, 16)).toBe(two?.slice(0, 16));
    expect(one?.slice(16)).not.toBe(two?.slice(16));
  });

  it("leaves the copy as it was when the copy's write fails", async () => {
    const pair = await openPair(folder());
    const ledger = await ForgottenLedger.open(pair);
    await pair.copy.exec(refusing(await ForgottenLedger.hash('', ALICE)));
    const before = await bothSides(pair);

    await expect(ledger.markForgotten(ALICE)).rejects.toThrow(/refused/);

    expect(await bothSides(pair)).toEqual(before);
  });

  it('recovers when the copy committed and the store did not', async () => {
    const dir = folder();
    let pair = await openPair(dir);
    let ledger = await ForgottenLedger.open(pair);
    const hash = await ForgottenLedger.hash('', ALICE);
    const copyMark = await markOf(pair.copy);
    await pair.primary.exec(refusing(hash));
    const store = await everyRowOf(pair.primary);

    await expect(ledger.markForgotten(ALICE)).rejects.toThrow(/refused/);

    expect(await tombstonesOf(pair.copy)).toEqual([{ hash, namespace: '' }]);
    expect((await markOf(pair.copy)) > copyMark).toBe(true);
    expect(await everyRowOf(pair.primary)).toEqual(store);
    expect(await ledger.isForgotten(ALICE)).toBe(true);

    await pair.primary.exec('DROP TRIGGER refuse_one');
    await closePair(pair);
    pair = await openPair(dir);
    ledger = await ForgottenLedger.open(pair);
    // The open repairs the copy and leaves the store; the reconcile brings the store up.
    expect(await everyRowOf(pair.primary)).toEqual(store);
    expect(await ledger.reconcile()).toEqual({ added: [hash] });
    expect(await stateOf(pair.primary)).toBe(await stateOf(pair.copy));
    expect(await tombstonesOf(pair.primary)).toEqual([{ hash, namespace: '' }]);
  });

  it('keeps the time a tombstone first got when its write is tried again after the store failed', async () => {
    const dir = folder();
    let pair = await openPair(dir);
    const ledger = await ForgottenLedger.open(pair);
    const hash = await ForgottenLedger.hash('', ALICE);
    await pair.primary.exec(refusing(hash));
    await expect(ledger.markForgotten(ALICE)).rejects.toThrow(/refused/);
    await pair.primary.exec('DROP TRIGGER refuse_one');
    // The copy holds the time the first try gave the tombstone.
    const first = await valueOf(pair.copy, hash);
    expect(first).toBeDefined();
    // The call is tried again at a later millisecond.
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(await ledger.markForgotten(ALICE)).toEqual({ form: 'unkeyed', written: true });

    expect(await valueOf(pair.primary, hash)).toBe(first);
    expect(await valueOf(pair.copy, hash)).toBe(first);
    await closePair(pair);
    pair = await openPair(dir);
    await expect(ForgottenLedger.open(pair)).resolves.toBeInstanceOf(ForgottenLedger);
  });

  it('brings an older store up to its copy', async () => {
    const dir = folder();
    const memoryFile = path.join(dir, 'memory.sqlite');
    const backupFile = path.join(dir, 'before.sqlite');
    let pair = await openPair(dir);
    await ForgottenLedger.open(pair);
    const backupState = await stateOf(pair.primary);
    await closePair(pair);
    fs.copyFileSync(memoryFile, backupFile);

    pair = await openPair(dir);
    await (await ForgottenLedger.open(pair)).markForgotten(ALICE);
    const copyState = await stateOf(pair.copy);
    await closePair(pair);
    expect(numberOf(copyState) > numberOf(backupState)).toBe(true);
    fs.copyFileSync(backupFile, memoryFile);

    pair = await openPair(dir);
    const ledger = await ForgottenLedger.open(pair);
    expect(await stateOf(pair.primary)).toBe(backupState);
    await ledger.reconcile();
    expect(await stateOf(pair.primary)).toBe(copyState);
    expect(await stateOf(pair.copy)).toBe(copyState);
  });

  it('brings an older copy up to its store', async () => {
    const dir = folder();
    const copyFile = path.join(dir, 'forgotten.sqlite');
    const oldCopy = path.join(dir, 'old-copy.sqlite');
    let pair = await openPair(dir);
    await ForgottenLedger.open(pair);
    const oldState = await stateOf(pair.copy);
    await closePair(pair);
    fs.copyFileSync(copyFile, oldCopy);

    pair = await openPair(dir);
    await (await ForgottenLedger.open(pair)).markForgotten(ALICE);
    const storeState = await stateOf(pair.primary);
    await closePair(pair);
    expect(numberOf(storeState) > numberOf(oldState)).toBe(true);
    fs.copyFileSync(oldCopy, copyFile);

    pair = await openPair(dir);
    await ForgottenLedger.open(pair);
    expect(await tombstonesOf(pair.copy)).toEqual(await tombstonesOf(pair.primary));
    expect(await stateOf(pair.copy)).toBe(storeState);
  });

  it('advances once for a tombstone written outside the ledger', async () => {
    const pair = await openPair(folder());
    const ledger = await ForgottenLedger.open(pair);
    const start = await markOf(pair.primary);
    const outside = 'e'.repeat(64);
    await insertRow(pair.primary, outside, '');

    await ledger.reconcile();

    expect(await tombstonesOf(pair.copy)).toEqual([{ hash: outside, namespace: '' }]);
    expect(await stateOf(pair.copy)).toBe(await stateOf(pair.primary));
    expect((await markOf(pair.primary)) > start).toBe(true);
    // Once: a second reconcile finds both sides alike and changes nothing.
    const united = await bothSides(pair);
    await ledger.reconcile();
    expect(await bothSides(pair)).toEqual(united);
  });

  it('reads its identity and mark in one call, and nothing else', async () => {
    const dir = folder();
    const memoryFile = path.join(dir, 'memory.sqlite');
    const backupFile = path.join(dir, 'before.sqlite');
    let pair = await openPair(dir);
    let ledger = await ForgottenLedger.open(pair);
    const first = await reader(ledger).readState();
    expect(Object.keys(first).sort()).toEqual(['identity', 'mark']);
    expect(first).toEqual({ identity: await identityOf(pair.primary), mark: await stateOf(pair.primary) });
    await closePair(pair);
    fs.copyFileSync(memoryFile, backupFile);

    pair = await openPair(dir);
    ledger = await ForgottenLedger.open(pair);
    await ledger.markForgotten(ALICE);
    const next = await reader(ledger).readState();
    expect(next.identity).toBe(first.identity);
    expect(numberOf(next.mark) > numberOf(first.mark)).toBe(true);
    await closePair(pair);

    // A store put back behind its copy: the state read brings its rows and mark up, and the next reconcile still
    // reports the tombstone that came back.
    fs.copyFileSync(backupFile, memoryFile);
    pair = await openPair(dir);
    ledger = await ForgottenLedger.open(pair);
    const hash = await ForgottenLedger.hash('', ALICE);
    const caughtUp = await reader(ledger).readState();
    expect(caughtUp).toEqual({ identity: first.identity, mark: await stateOf(pair.copy) });
    expect(await stateOf(pair.primary)).toBe(caughtUp.mark);
    expect(await tombstonesOf(pair.primary)).toEqual([{ hash, namespace: '' }]);
    expect(await ledger.reconcile()).toEqual({ added: [hash] });
  });

  it('refuses a state read when the copy under an open handle was replaced', async () => {
    const pair = await openPair(folder());
    const ledger = await ForgottenLedger.open(pair);
    await pair.copy.run(`UPDATE agentos_learning_forgotten SET forgotten_at = ? WHERE hash = '${IDENTITY}'`, ['f'.repeat(32)]);
    logged.length = 0;

    await expect(reader(ledger).readState()).rejects.toMatchObject({ name: 'ForgottenLedgerError', code: 'LEDGER_IDENTITY_MISMATCH' });
    await expect(ledger.markForgotten(ALICE)).rejects.toMatchObject({ name: 'ForgottenLedgerError', code: 'LEDGER_IDENTITY_MISMATCH' });

    expect(refusals()).toEqual([
      expect.objectContaining({ code: 'LEDGER_IDENTITY_MISMATCH' }),
      expect.objectContaining({ code: 'LEDGER_IDENTITY_MISMATCH' }),
    ]);
    expect(await tombstonesOf(pair.primary)).toEqual([]);
    expect(await tombstonesOf(pair.copy)).toEqual([]);
  });
});

describe("the tombstone copy's file", () => {
  it('opens the copy file with secure_delete on, and says whether it was there', async () => {
    const file = path.join(folder(), 'forgotten.sqlite');

    const first = await openForgottenCopy(file);
    adapters.push(first.adapter);
    expect(first.existed).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
    // The setting is the connection's, so it is read through the adapter the opener returned.
    const setting = await first.adapter.get<Record<string, number>>('PRAGMA secure_delete');
    expect(Object.values(setting!)[0]).toBe(1);

    // It is a ledger's copy: a tombstone written through it is in the file after a close.
    const primary = await sqliteAt(path.join(path.dirname(file), 'memory.sqlite'));
    await (await ForgottenLedger.open({ primary, copy: first.adapter })).markForgotten(ALICE);
    await first.adapter.close();

    const second = await openForgottenCopy(file);
    adapters.push(second.adapter);
    expect(second.existed).toBe(true);
    expect(Object.values((await second.adapter.get<Record<string, number>>('PRAGMA secure_delete'))!)[0]).toBe(1);
    expect(await tombstonesOf(second.adapter)).toEqual([{ hash: await ForgottenLedger.hash('', ALICE), namespace: '' }]);
    // A closed copy is one file: no write-ahead log beside it.
    expect(fs.existsSync(`${file}-wal`)).toBe(false);
  });
});

describe("the learning layer's route", () => {
  const ANA: NamespacedUser = { namespace: 'A', userId: 'ana' };

  /** A SQL learning store over a SQLite file of its own, with the adapter the case reads its rows through. */
  async function learningStoreIn(dir: string): Promise<{ store: SqlLearningStore; adapter: StorageAdapter }> {
    const adapter = await sqliteAt(path.join(dir, 'learning.sqlite'));
    const store = new SqlLearningStore({ adapter });
    // The first read makes the store's tables.
    await store.isForgotten('0'.repeat(64));
    return { store, adapter };
  }

  /** The ledger an agent's memory store uses: its table and its copy on two more files, reading namespace A. */
  async function sharedLedgerIn(dir: string, key?: string): Promise<Pair & { ledger: ForgottenLedger }> {
    const pair = await openPair(dir);
    const ledger = await ForgottenLedger.open({ ...pair, namespaces: ['A'], ...(key === undefined ? {} : { key: { current: key } }) });
    return { ...pair, ledger };
  }

  /** The hashes a learning store's own tombstone table holds. */
  const ownRowsOf = async (adapter: StorageAdapter): Promise<string[]> => (await rowsOf(adapter)).map((row) => row.hash);

  it("with no shared ledger, writes and reads the layer's own row and nothing else", async () => {
    const { store, adapter } = await learningStoreIn(folder());
    const route = learnerTombstones();
    const own = await tombstoneHash('A', 'ana');
    expect(await route.hashOf(ANA)).toBe(own);
    expect(await route.has(store, ANA)).toBe(false);

    await route.mark(store, ANA, NOW);

    expect(await adapter.all('SELECT hash, forgotten_at FROM agentos_learning_forgotten')).toEqual([{ hash: own, forgotten_at: NOW }]);
    expect(await route.sharedHas(ANA)).toBe(false);
    // One read of the route is one read of the store, of the layer's own hash.
    const read = vi.spyOn(store, 'isForgotten');
    expect(await route.has(store, ANA)).toBe(true);
    expect(read.mock.calls).toEqual([[own]]);
    // One write of the route is one write of the store.
    const write = vi.spyOn(store, 'insertForgotten');
    await route.mark(store, { namespace: 'A', userId: 'bo' }, NOW);
    expect(write.mock.calls).toEqual([[await tombstoneHash('A', 'bo'), NOW]]);

    // The same on the in-process store.
    const inProcess = new InMemoryLearningStore();
    await route.mark(inProcess, ANA, NOW);
    expect(await inProcess.isForgotten(own)).toBe(true);
    expect(await route.has(inProcess, ANA)).toBe(true);
    expect(await route.has(inProcess, { namespace: 'B', userId: 'ana' })).toBe(false);
  });

  it("with a shared ledger, writes the shared tombstone first and the layer's own row second", async () => {
    const dir = folder();
    const { store, adapter } = await learningStoreIn(dir);
    const shared = await sharedLedgerIn(dir);
    const route = learnerTombstones(shared.ledger);
    const sharedHash = await ForgottenLedger.hash('', { kind: 'user', id: 'ana' });
    // What the shared ledger held at the moment the layer's own row was written.
    let heldWhenOwnRowWritten: LedgerRow[] | undefined;
    const rows = {
      insertForgotten: async (hash: string, forgottenAt: string): Promise<void> => {
        heldWhenOwnRowWritten = await tombstonesOf(shared.primary);
        await store.insertForgotten(hash, forgottenAt);
      },
    };

    await route.mark(rows, ANA, NOW);

    expect(heldWhenOwnRowWritten).toEqual([{ hash: sharedHash, namespace: '' }]);
    expect(await tombstonesOf(shared.primary)).toEqual([{ hash: sharedHash, namespace: '' }]);
    expect(await tombstonesOf(shared.copy)).toEqual([{ hash: sharedHash, namespace: '' }]);
    expect(await ownRowsOf(adapter)).toEqual([await tombstoneHash('A', 'ana')]);

    // The shared write fails: the call rejects, and the layer's own store holds nothing of the user.
    await shared.copy.close();
    await expect(route.mark(store, { namespace: 'A', userId: 'bo' }, NOW)).rejects.toThrow();
    expect(await ownRowsOf(adapter)).toEqual([await tombstoneHash('A', 'ana')]);
    expect(await tombstonesOf(shared.primary)).toEqual([{ hash: sharedHash, namespace: '' }]);
  });

  it("reads the shared ledger when the layer's own row is missing", async () => {
    const dir = folder();
    const { store } = await learningStoreIn(dir);
    const shared = await sharedLedgerIn(dir);
    const route = learnerTombstones(shared.ledger);

    await shared.ledger.markForgotten({ kind: 'user', id: 'ana' });

    expect(await store.isForgotten(await tombstoneHash('A', 'ana'))).toBe(false);
    expect(await route.has(store, ANA)).toBe(true);
    expect(await route.sharedHas(ANA)).toBe(true);

    // The shared ledger does not read namespace B: it is neither asked nor written for a user there.
    const elsewhere: NamespacedUser = { namespace: 'B', userId: 'ana' };
    const asked = vi.spyOn(shared.ledger, 'isForgotten');
    expect(await route.has(store, elsewhere)).toBe(false);
    expect(await route.sharedHas(elsewhere)).toBe(false);
    expect(asked).not.toHaveBeenCalled();
    await route.mark(store, { namespace: 'B', userId: 'bo' }, NOW);
    expect(await shared.ledger.isForgotten({ kind: 'user', id: 'bo' })).toBe(false);
    expect(await store.isForgotten(await tombstoneHash('B', 'bo'))).toBe(true);
  });

  it('with a keyed shared ledger, leaves no unkeyed row in the learning store', async () => {
    const dir = folder();
    const { store, adapter } = await learningStoreIn(dir);
    const shared = await sharedLedgerIn(dir, 'k');
    const route = learnerTombstones(shared.ledger);

    await route.mark(store, ANA, NOW);

    expect(await ownRowsOf(adapter)).toEqual([]);
    expect((await tombstonesOf(shared.primary)).map((row) => row.hash)).toEqual([await ForgottenLedger.hash('', { kind: 'user', id: 'ana' }, 'k')]);
    expect(await route.has(store, ANA)).toBe(true);

    // A namespace the keyed ledger does not read has the layer's own row alone, so that row is written.
    await route.mark(store, { namespace: 'B', userId: 'bo' }, NOW);
    expect(await ownRowsOf(adapter)).toEqual([await tombstoneHash('B', 'bo')]);
  });

  it('a layer given a shared ledger refuses a learner the souled side forgot, and its forgetUser reaches the shared ledger', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const dir = folder();
    const { store } = await learningStoreIn(dir);
    const shared = await sharedLedgerIn(dir);
    const layer = createLearningLayer({ store, agentKey: 'tutor', namespace: 'A', forgotten: shared.ledger });

    await shared.ledger.markForgotten({ kind: 'user', id: '42' });
    await expect(
      layer.operatorSet({ learner: { namespace: 'A', agentKey: 'tutor', userId: '42' }, traits: { openness: 0.7 }, by: 'ops' }),
    ).rejects.toThrow(/forgotten in this namespace/);

    await layer.forgetUser('7', { namespace: 'A' });

    expect(await shared.ledger.isForgotten({ kind: 'user', id: '7' })).toBe(true);
    expect(await store.isForgotten(await tombstoneHash('A', '7'))).toBe(true);
    await expect(
      layer.operatorSet({ learner: { namespace: 'A', agentKey: 'tutor', userId: '7' }, traits: { openness: 0.7 }, by: 'ops' }),
    ).rejects.toThrow(/forgotten in this namespace/);

    // A layer with no shared ledger on the same learning store does not know the user the shared ledger alone holds:
    // the call gets past the tombstone and stops at the learner having no trait row yet.
    const alone = createLearningLayer({ store, agentKey: 'tutor', namespace: 'A' });
    await expect(
      alone.operatorSet({ learner: { namespace: 'A', agentKey: 'tutor', userId: '42' }, traits: { openness: 0.7 }, by: 'ops' }),
    ).rejects.toThrow(/has no trait row/);
  });

  it('raises the mark when the layer forgets a user through a shared ledger', async () => {
    const dir = folder();
    const { store } = await learningStoreIn(dir);
    const shared = await sharedLedgerIn(dir);
    const before = await markOf(shared.primary);

    await learnerTombstones(shared.ledger).mark(store, ANA, NOW);

    expect((await markOf(shared.primary)) > before).toBe(true);
    expect(await stateOf(shared.copy)).toBe(await stateOf(shared.primary));
  });

  it("raises the mark at the next reconcile for a row the layer wrote into the ledger's own table", async () => {
    const pair = await openPair(folder());
    const ledger = await ForgottenLedger.open({ ...pair, namespaces: ['A'] });
    // The layer's own store sits on the ledger's store adapter, and no shared ledger is handed to its route.
    const store = new SqlLearningStore({ adapter: pair.primary });
    const before = await markOf(pair.primary);

    await learnerTombstones().mark(store, ANA, NOW);
    await ledger.reconcile();

    expect((await tombstonesOf(pair.copy)).map((row) => row.hash)).toEqual([await tombstoneHash('A', 'ana')]);
    expect(await stateOf(pair.copy)).toBe(await stateOf(pair.primary));
    expect((await markOf(pair.primary)) > before).toBe(true);
  });

  it('shares a ledger by the options object, weakly', async () => {
    const shared = await sharedLedgerIn(folder());
    const options = { runtime: 'gmi' };
    expect(sharedForgottenLedgerOf(options)).toBeUndefined();

    shareForgottenLedger(options, shared.ledger);

    expect(sharedForgottenLedgerOf(options)).toBe(shared.ledger);
    // A copy of the options is another object: it finds nothing.
    expect(sharedForgottenLedgerOf({ ...options })).toBeUndefined();
  });
});

describe.skipIf(!POSTGRES_URL)('the forgotten-user ledger with the store on Postgres', () => {
  afterAll(async () => {
    if (segments.length === 0) return;
    const admin = createPostgresAdapter({ connectionString: POSTGRES_URL! });
    await admin.open();
    try {
      for (const segment of segments) await admin.exec(`DROP SCHEMA IF EXISTS "${segment}" CASCADE`);
    } finally {
      await admin.close();
    }
  });

  /** The name of a new schema of this run's own, dropped once the cases have run. */
  function newSchema(): string {
    const segment = `forgotten_ledger_${RUN}_${segments.length}`;
    segments.push(segment);
    return segment;
  }

  /**
   * A Postgres adapter whose tables go in a schema of this run's own: a new one, or one an earlier adapter opened, so
   * two adapter objects (two connection pools, as two processes have) reach the same tables.
   */
  async function openPostgres(segment: string = newSchema()): Promise<StorageAdapter> {
    const adapter = createPostgresAdapter({ connectionString: POSTGRES_URL!, segment, max: 5 });
    await adapter.open();
    adapters.push(adapter);
    return adapter;
  }

  /** Two handles' worth of adapters on one store schema and one copy schema, sharing no adapter object. */
  async function twoProcesses(store: string = newSchema(), copy: string = newSchema()): Promise<[Pair, Pair]> {
    const first: Pair = { primary: await openPostgres(store), copy: await openPostgres(copy) };
    const second: Pair = { primary: await openPostgres(store), copy: await openPostgres(copy) };
    return [first, second];
  }

  /**
   * Opens a ledger on both pairs at once. An open that loses a race on the table's first creation or on a lock is
   * tried once more; which happened is written to the test's output.
   */
  async function openTogether(pairs: [Pair, Pair]): Promise<void> {
    const outcomes = await Promise.allSettled(pairs.map((pair) => ForgottenLedger.open(pair)));
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status === 'fulfilled') continue;
      console.info(`forgotten-ledger race: open ${index} rejected (${String((outcome.reason as Error)?.message).slice(0, 120)}), tried again`);
      await ForgottenLedger.open(pairs[index]);
    }
    if (outcomes.every((outcome) => outcome.status === 'fulfilled')) console.info('forgotten-ledger race: both opens resolved');
  }

  /** Both sides of the shared tables hold one identity, the same, and one state row. */
  async function expectOneIdentity(pair: Pair): Promise<void> {
    const store = await ledgerRowsOf(pair.primary);
    const copy = await ledgerRowsOf(pair.copy);
    for (const rows of [store, copy]) {
      expect(rows.map((row) => row.hash)).toEqual([IDENTITY, STATE]);
      expect(rows[0].forgotten_at).toMatch(/^[0-9a-f]{32}$/);
    }
    expect(copy[0].forgotten_at).toBe(store[0].forgotten_at);
  }

  it('writes one unkeyed row for a user and finds it again, with the copy on a SQLite file', async () => {
    const primary = await openPostgres();
    const copy = await sqliteAt(path.join(folder(), 'forgotten.sqlite'));
    await writesOneUnkeyedRowAndFindsIt(primary, copy);
  });

  it("refuses a copy that is a second pool on the store's own database and schema, and pairs nothing", async () => {
    const schema = newSchema();
    const primary = await openPostgres(schema);
    const copy = await openPostgres(schema);

    await expect(ForgottenLedger.open({ primary, copy })).rejects.toMatchObject({ name: 'ForgottenLedgerError', code: 'COPY_UNAVAILABLE' });
    // Neither the pair's markers nor the row the open read the copy by are left in the one table both name.
    expect(await everyRowOf(primary)).toEqual([]);
    expect(refusals()).toHaveLength(1);
  });

  it('two first opens of one store and copy end with one identity', async () => {
    const pairs = await twoProcesses();
    await openTogether(pairs);
    await expectOneIdentity(pairs[0]);
  });

  it('two opens of a ledger made without the two rows end with one identity', async () => {
    const pairs = await twoProcesses();
    const old = [['c1:copy', ''], [await ForgottenLedger.hash('', ALICE), '']] as const;
    await writeOldLedger(pairs[0].primary, old);
    await writeOldLedger(pairs[0].copy, old);
    await openTogether(pairs);
    await expectOneIdentity(pairs[0]);
    expect(await tombstonesOf(pairs[1].primary)).toEqual([{ hash: await ForgottenLedger.hash('', ALICE), namespace: '' }]);
  });

  it('advances on every tombstone with the store on Postgres', async () => {
    await advancesOnEveryTombstone({ primary: await openPostgres(), copy: await sqliteAt(path.join(folder(), 'forgotten.sqlite')) });
  });

  it('two writers on one store and copy lose no tombstone and never lower the mark', async () => {
    const storeSchema = newSchema();
    const copySchema = newSchema();
    const pairs = await twoProcesses(storeSchema, copySchema);
    // Opened one after the other: the race of two first opens is the case above.
    const ledgers = [await ForgottenLedger.open(pairs[0]), await ForgottenLedger.open(pairs[1])];
    const start = await markOf(pairs[0].primary);
    const users = (prefix: string): SuppressionSubject[] => Array.from({ length: 10 }, (_, index) => ({ kind: 'user', id: `${prefix}-${index}` }));

    // A third connection pool reads the store's state row while the writers run.
    const watcher = await openPostgres(storeSchema);
    const seen: bigint[] = [];
    let writing = true;
    const watching = (async () => {
      while (writing) {
        const state = await stateOf(watcher);
        if (state !== undefined) seen.push(BigInt(`0x${state}`));
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    })();
    try {
      await Promise.all([...users('one').map((user) => ledgers[0].markForgotten(user)), ...users('two').map((user) => ledgers[1].markForgotten(user))]);
    } finally {
      writing = false;
      await watching;
    }

    expect(await tombstonesOf(pairs[0].primary)).toHaveLength(20);
    expect(await tombstonesOf(pairs[0].copy)).toHaveLength(20);
    expect(await stateOf(pairs[0].copy)).toBe(await stateOf(pairs[0].primary));
    expect((await markOf(pairs[0].primary)) > start).toBe(true);
    for (const [index, mark] of seen.entries()) if (index > 0) expect(mark >= seen[index - 1], `read ${index} is not lower`).toBe(true);
    const third = await ForgottenLedger.open({ primary: await openPostgres(storeSchema), copy: await openPostgres(copySchema) });
    expect((await reader(third).readState()).mark).toBe(await stateOf(pairs[0].primary));
  });
});
