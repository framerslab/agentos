/**
 * @file forgotten-ledger.e2e.test.ts
 * The forgotten-user ledger over real databases. A ledger writes one row per forgotten subject into the table the
 * learning store already has, `agentos_learning_forgotten`: a hash of the subject, never its id. It keeps a second copy
 * of the table in a database a restore of the store does not replace, and copies it back on request, so a store
 * restored from before a deletion still knows the deletion. With a key the hash is an HMAC and the store records which
 * key wrote it; such a store does not open without every key it has used. A store whose copy is gone does not open.
 *
 * Every case runs on SQLite files in a folder of its own. The first case also runs with the store on Postgres and the
 * copy on a SQLite file when `AGENTOS_TEST_POSTGRES_URL` names a database (CI's Test & Lint job sets it); its tables go
 * in a schema of the run's own, dropped once the cases have run.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPostgresAdapter, resolveStorageAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { canonicalJson } from '../../../learning/ledger/canonical.js';
import { tombstoneHash } from '../../../learning/ledger/Ledger.js';
import * as root from '../../../../index.js';
import { ForgottenLedger, ForgottenLedgerError, type SuppressionSubject } from '../ForgottenLedger.js';

const POSTGRES_URL = process.env.AGENTOS_TEST_POSTGRES_URL;
/** This run's own mark, in the names of the schemas its Postgres cases make and drop. */
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
/** The schemas this run's Postgres cases made. */
const segments: string[] = [];

const EARLIER = '2026-10-12T11:00:00.000Z';
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
  });

  it('writes one unkeyed row for a user and finds it again', async () => {
    const { primary, copy } = await openPair(folder());
    await writesOneUnkeyedRowAndFindsIt(primary, copy);
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
