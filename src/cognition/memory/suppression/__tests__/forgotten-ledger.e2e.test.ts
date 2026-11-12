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
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPostgresAdapter, resolveStorageAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
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

afterEach(async () => {
  vi.restoreAllMocks();
  while (adapters.length) await adapters.pop()!.close().catch(() => undefined);
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

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
    expect(await rowsOf(primary)).toEqual([]);
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

  /** A Postgres adapter whose tables go in a new schema of this run's own. */
  async function openPostgres(): Promise<StorageAdapter> {
    const segment = `forgotten_ledger_${RUN}_${segments.length}`;
    segments.push(segment);
    const adapter = createPostgresAdapter({ connectionString: POSTGRES_URL!, segment, max: 5 });
    await adapter.open();
    adapters.push(adapter);
    return adapter;
  }

  it('writes one unkeyed row for a user and finds it again, with the copy on a SQLite file', async () => {
    const primary = await openPostgres();
    const copy = await sqliteAt(path.join(folder(), 'forgotten.sqlite'));
    await writesOneUnkeyedRowAndFindsIt(primary, copy);
  });
});
