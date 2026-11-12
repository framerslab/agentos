/**
 * @file Memory.erasure.e2e.test.ts
 * What the facade does so that a deleted person's memory is gone from the store and from its files.
 *
 * - A SQLite store the library opens from a file path has `secure_delete` on, so the bytes of a deleted row are
 *   overwritten; a store on an adapter the host opened keeps the setting the host gave it.
 * - `deleteTraces` leaves a document chunk's text unless it is asked to delete it; asked, it deletes the chunks the
 *   traces were filed from, the pictures of those chunks, and each document left with no chunk.
 * - `deleteTracesNamingUser` deletes every trace that names a user, under any scope, soft-deleted rows included.
 * - `rebuildVectorIndex` writes the vector index again from the traces that are left, so a deleted trace's vector is
 *   in no index file, and removes the files when no trace is left; it fails when a file cannot be removed or written.
 * - `markForgotten` and `isForgotten` write and read the forgotten-user ledger the store was opened with; a store
 *   whose ledger does not open is closed again.
 *
 * `secure_delete` is a setting of a connection, not of the file, so each case reads it through the connection the
 * store itself uses. A real SQLite facade on a file in a folder of the case's own; the document and the user cases
 * also run on Postgres when `AGENTOS_TEST_POSTGRES_URL` is set, as CI's Test & Lint job sets it.
 *
 * hnswlib-node is a native addon whose build pnpm skips in CI, so the index the sidecar loads is replaced here by a
 * plain index with the same methods, written to and read from the index file as JSON; like the addon's, its delete
 * only marks a vector and its write answers with a promise. Everything else is the code a host runs: Memory,
 * HnswSidecar, HnswIndexSidecar and the database.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveStorageAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { Memory } from '../Memory.js';
import { Brain } from '../../../retrieval/store/Brain.js';
import { HnswSidecar, hnswIndexPath } from '../../../retrieval/store/HnswSidecar.js';
import { PORTABLE_TABLES } from '../../../retrieval/store/portable-tables.js';
import { ForgottenLedger, type SuppressionSubject } from '../../../suppression/ForgottenLedger.js';
import { openForgottenCopy } from '../../../suppression/forgottenCopy.js';

/** Whether the stand-in index refuses its next writes, as a full disk would. */
const indexWrites = vi.hoisted(() => ({ fail: false }));

vi.mock('hnswlib-node', async () => {
  const { readFileSync, writeFileSync } = await import('node:fs');

  /** A plain index behind hnswlib-node's HierarchicalNSW methods. */
  class HierarchicalNSW {
    private points = new Map<number, number[]>();
    private readonly removed = new Set<number>();

    constructor(_space: string, _dimensions: number) {}

    initIndex(_capacity: number, _m?: number, _efConstruction?: number): void {}

    setEf(_ef: number): void {}

    resizeIndex(_capacity: number): void {}

    addPoint(vector: number[], label: number): void {
      this.points.set(label, [...vector]);
    }

    /** As the addon's: the vector is marked and stays in the index, and so in the file a later write makes. */
    markDelete(label: number): void {
      this.removed.add(label);
    }

    searchKnn(_query: number[], k: number): { neighbors: number[]; distances: number[] } {
      const labels = [...this.points.keys()].filter((label) => !this.removed.has(label)).slice(0, k);
      return { neighbors: labels, distances: labels.map(() => 0) };
    }

    /** As the addon's: the write answers with a promise, which rejects when the file cannot be written. */
    async writeIndex(file: string): Promise<void> {
      if (indexWrites.fail) throw new Error('the index file cannot be written');
      writeFileSync(file, JSON.stringify([...this.points.entries()]));
    }

    readIndex(file: string): void {
      this.points = new Map(JSON.parse(readFileSync(file, 'utf8')) as Array<[number, number[]]>);
    }
  }

  return { HierarchicalNSW, default: { HierarchicalNSW } };
});

const POSTGRES_URL = process.env.AGENTOS_TEST_POSTGRES_URL;
/** This run's own mark, in the ids of the brains its Postgres cases make. */
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const dirs: string[] = [];
const memories: Memory[] = [];
const adapters: StorageAdapter[] = [];
afterEach(async () => {
  indexWrites.fail = false;
  vi.restoreAllMocks();
  while (memories.length) {
    const memory = memories.pop()!;
    const brain = brainOf(memory);
    if (brain.features.dialect.name === 'postgres') {
      // The Postgres database outlives the test: remove this brain's rows, children before parents.
      for (const table of [...PORTABLE_TABLES].reverse()) {
        await brain.run(`DELETE FROM ${table} WHERE brain_id = ?`, [brain.brainId]).catch(() => undefined);
      }
    }
    await memory.close();
  }
  while (adapters.length) await adapters.pop()!.close().catch(() => undefined);
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A new folder of this case's own, removed after it. */
function folder(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-erasure-'));
  dirs.push(dir);
  return dir;
}

function brainOf(memory: Memory): Brain {
  return (memory as unknown as { _brain: Brain })._brain;
}

interface Facade {
  memory: Memory;
  brain: Brain;
}

/** A facade on a SQLite file the library opens from its path. */
async function facade(): Promise<Facade & { file: string; dir: string }> {
  const dir = folder();
  const file = path.join(dir, 'brain.sqlite');
  const memory = await Memory.createSqlite(file, { brainId: 'tools-brain' });
  memories.push(memory);
  return { memory, brain: brainOf(memory), file, dir };
}

let postgresBrains = 0;

/** A facade on the Postgres database, with a brain of this case's own; its rows are removed after the case. */
async function postgresFacade(): Promise<Facade> {
  const memory = await Memory.createPostgres(POSTGRES_URL!, { brainId: `erasure_${RUN}_${postgresBrains++}` });
  memories.push(memory);
  return { memory, brain: brainOf(memory) };
}

/** What `PRAGMA secure_delete` answers on a connection: 0 off, 1 on. */
async function secureDeleteOf(connection: { get<T>(sql: string): Promise<T | null> }): Promise<number> {
  const row = await connection.get<Record<string, number>>('PRAGMA secure_delete');
  return Object.values(row!)[0];
}

/** How many rows of a table the brain holds. */
async function countOf(brain: Brain, table: 'documents' | 'document_chunks' | 'document_images'): Promise<number> {
  const row = await brain.get<{ n: number | string }>(`SELECT count(*) AS n FROM ${table} WHERE brain_id = ?`, [brain.brainId]);
  return Number(row?.n ?? 0);
}

/**
 * Files one document by SQL: a chunk on each trace, in order, and a picture on the first chunk. `Memory.ingest()`
 * files its traces under no scope id, so a document on the traces of a case's choosing is planted here.
 */
async function plantDocument(brain: Brain, { traceIds }: { traceIds: string[] }): Promise<void> {
  const brainId = brain.brainId;
  await brain.run(
    'INSERT INTO documents (brain_id, id, path, format, content_hash, chunk_count, ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [brainId, 'doc_1', 'handbook.md', 'md', 'h', traceIds.length, Date.now()],
  );
  for (const [index, traceId] of traceIds.entries()) {
    await brain.run(
      'INSERT INTO document_chunks (brain_id, id, document_id, trace_id, content, chunk_index) VALUES (?, ?, ?, ?, ?, ?)',
      [brainId, `chunk_${index}`, 'doc_1', traceId, `chunk text ${index}`, index],
    );
  }
  await brain.run(
    'INSERT INTO document_images (brain_id, id, document_id, chunk_id, data, mime_type) VALUES (?, ?, ?, ?, ?, ?)',
    [brainId, 'image_0', 'doc_1', 'chunk_0', Buffer.from([1]), 'image/png'],
  );
}

interface ChunkRow {
  id: string;
  trace_id: string | null;
  content: string;
}

/** The chunks the brain holds, in order, each with the trace it names. */
const chunksOf = (brain: Brain): Promise<ChunkRow[]> =>
  brain.all<ChunkRow>('SELECT id, trace_id, content FROM document_chunks WHERE brain_id = ? ORDER BY chunk_index', [brain.brainId]);

/** The text of every trace row the brain holds, soft-deleted rows included. */
const everyContent = async (brain: Brain): Promise<string[]> =>
  (await brain.all<{ content: string }>('SELECT content FROM memory_traces WHERE brain_id = ? ORDER BY content', [brain.brainId])).map(
    (row) => row.content,
  );

async function deletesChunksPicturesAndAnEmptiedDocument({ memory, brain }: Facade): Promise<void> {
  const first = await memory.remember('The handbook opens with the leave policy.', { scope: 'user', scopeId: 'ana' });
  const second = await memory.remember('The handbook ends with the expense policy.', { scope: 'user', scopeId: 'ana' });
  await plantDocument(brain, { traceIds: [first.id, second.id] });

  expect(await memory.deleteTraces([first.id], { documentChunks: 'delete' })).toEqual({ deleted: 1 });

  // The first chunk and its picture are gone with their text; the document still has a chunk, so it stays.
  expect(await chunksOf(brain)).toEqual([{ id: 'chunk_1', trace_id: second.id, content: 'chunk text 1' }]);
  expect(await countOf(brain, 'document_images')).toBe(0);
  expect(await countOf(brain, 'documents')).toBe(1);

  expect(await memory.deleteTraces([second.id], { documentChunks: 'delete' })).toEqual({ deleted: 1 });

  expect(await countOf(brain, 'document_chunks')).toBe(0);
  expect(await countOf(brain, 'document_images')).toBe(0);
  expect(await countOf(brain, 'documents')).toBe(0);
  expect(await everyContent(brain)).toEqual([]);
}

async function deletesEveryTraceThatNamesAUser({ memory, brain }: Facade): Promise<void> {
  await memory.remember('a', { scope: 'conversation', scopeId: 'c1:u:4:aria:5:alice;', metadata: { turnUserId: 'bob' } });
  const soft = await memory.remember('b', { scope: 'user', scopeId: 'x', metadata: { turnUserId: 'bob' } });
  await memory.remember('c', { metadata: { turnUserId: 'bobby' } });
  await memory.remember('d');
  // A soft-deleted row still holds the words: it goes too.
  await brain.run('UPDATE memory_traces SET deleted = 1 WHERE brain_id = ? AND id = ?', [brain.brainId, soft.id]);
  // A chunk one of the user's traces was filed from goes with its text.
  await plantDocument(brain, { traceIds: [soft.id] });

  expect(await memory.deleteTracesNamingUser('bob')).toEqual({ deleted: 2 });

  expect(await everyContent(brain)).toEqual(['c', 'd']);
  expect(await countOf(brain, 'document_chunks')).toBe(0);
  expect(await countOf(brain, 'documents')).toBe(0);
  expect(await memory.deleteTracesNamingUser('bob')).toEqual({ deleted: 0 });

  await expect(memory.deleteTracesNamingUser('')).rejects.toThrow(TypeError);
  await expect(memory.deleteTracesNamingUser(undefined as unknown as string)).rejects.toThrow(TypeError);
  expect(await everyContent(brain)).toEqual(['c', 'd']);
}

describe('secure_delete on a SQLite memory store', () => {
  it('opens a SQLite store from a path with secure_delete on', async () => {
    const { brain } = await facade();
    expect(await secureDeleteOf(brain)).toBe(1);
  });

  it('leaves a store on an adapter the host passed as the host opened it', async () => {
    const adapter = await resolveStorageAdapter({
      filePath: path.join(folder(), 'host.sqlite'),
      priority: ['better-sqlite3'],
      quiet: true,
    });
    const before = await secureDeleteOf(adapter);
    // The driver opens a file with the setting off; the host did not turn it on.
    expect(before).toBe(0);

    const memory = await Memory.createWithAdapter(adapter, { brainId: 'host' });
    memories.push(memory);

    expect(await secureDeleteOf(adapter)).toBe(before);
    expect(await secureDeleteOf(brainOf(memory))).toBe(before);
  });
});

describe('deleting the document chunks a trace was filed from', () => {
  it("keeps a chunk's text when a trace is deleted without the option", async () => {
    const { memory, brain } = await facade();
    const trace = await memory.remember('The handbook opens with the leave policy.', { scope: 'user', scopeId: 'ana' });
    await plantDocument(brain, { traceIds: [trace.id] });

    expect(await memory.deleteTraces([trace.id])).toEqual({ deleted: 1 });

    // The chunk lets go of the trace and keeps its text, which belongs to its document.
    expect(await chunksOf(brain)).toEqual([{ id: 'chunk_0', trace_id: null, content: 'chunk text 0' }]);
    expect(await countOf(brain, 'document_images')).toBe(1);
    expect(await countOf(brain, 'documents')).toBe(1);
  });

  it('deletes the chunks, their pictures and an emptied document with the option', async () => {
    await deletesChunksPicturesAndAnEmptiedDocument(await facade());
  });
});

describe('deleting the traces that name a user', () => {
  it('deletes every trace that names a user, under any scope, and no other', async () => {
    await deletesEveryTraceThatNamesAUser(await facade());
  });
});

describe('the vector index after a delete', () => {
  const AXES = ['bees', 'cello', 'chess'];
  /** One axis per topic, so each trace's vector is told from the others in the index file. */
  const vectorOf = (text: string): number[] => {
    const vector = new Array<number>(8).fill(0);
    const axis = AXES.findIndex((word) => text.includes(word));
    vector[axis < 0 ? 7 : axis] = 1;
    return vector;
  };

  /** A facade that embeds what it remembers, with the paths of its index files. */
  async function embeddingFacade(): Promise<Facade & { file: string; indexFile: string; mapFile: string }> {
    const file = path.join(folder(), 'brain.sqlite');
    const memory = await Memory.createSqlite(file, {
      brainId: 'tools-brain',
      embed: async (text) => vectorOf(text),
      embeddings: { provider: 'test', dimensions: 8 },
    });
    memories.push(memory);
    const indexFile = hnswIndexPath({ sqlitePath: file, brainId: 'tools-brain' });
    return { memory, brain: brainOf(memory), file, indexFile, mapFile: `${indexFile}.map.json` };
  }

  /** The trace ids the index's map file names. */
  const idsIn = (mapFile: string): string[] =>
    (JSON.parse(fs.readFileSync(mapFile, 'utf8')) as { entries: Array<[number, string]> }).entries.map(([, id]) => id).sort();

  /** The vectors the index file holds. */
  const vectorsIn = (indexFile: string): number[][] =>
    (JSON.parse(fs.readFileSync(indexFile, 'utf8')) as Array<[number, number[]]>).map(([, vector]) => vector);

  it('rewrites the vector index from the traces left, and removes its files when none is left', async () => {
    const { memory, indexFile, mapFile } = await embeddingFacade();
    const bees = await memory.remember('Ana keeps bees.');
    const cello = await memory.remember('Bo plays cello.');
    const chess = await memory.remember('Cy teaches chess.');

    expect(await memory.rebuildVectorIndex()).toEqual({ vectors: 3 });
    expect(idsIn(mapFile)).toEqual([bees.id, cello.id, chess.id].sort());

    await memory.deleteTraces([cello.id]);
    expect(await memory.rebuildVectorIndex()).toEqual({ vectors: 2 });

    // The files hold the two traces left: neither names the deleted trace, and its vector is in no file.
    expect(idsIn(mapFile)).toEqual([bees.id, chess.id].sort());
    expect(vectorsIn(indexFile)).toHaveLength(2);
    expect(vectorsIn(indexFile)).not.toContainEqual(vectorOf('cello'));
    expect(vectorsIn(indexFile)).toContainEqual(vectorOf('bees'));

    await memory.deleteTraces([bees.id, chess.id]);
    expect(await memory.rebuildVectorIndex()).toEqual({ vectors: 0 });
    expect(fs.existsSync(indexFile)).toBe(false);
    expect(fs.existsSync(mapFile)).toBe(false);
  });

  it('answers no vectors for a store with no file path', async () => {
    const adapter = await resolveStorageAdapter({
      filePath: path.join(folder(), 'host.sqlite'),
      priority: ['better-sqlite3'],
      quiet: true,
    });
    const memory = await Memory.createWithAdapter(adapter, { brainId: 'host' });
    memories.push(memory);
    await memory.remember('Ana keeps bees.');

    expect(await memory.rebuildVectorIndex()).toEqual({ vectors: 0 });
  });

  it('recovers vectors added after a rewrite when the store reopens', async () => {
    const { memory, file, mapFile } = await embeddingFacade();
    const first = await memory.remember('Ana keeps bees.');
    await memory.rebuildVectorIndex();
    const later = await memory.remember('Bo plays cello.');
    await memory.close();
    memories.splice(memories.indexOf(memory), 1);
    const reopened = await Memory.createSqlite(file, {
      brainId: 'tools-brain',
      embed: async (text) => vectorOf(text),
      embeddings: { provider: 'test', dimensions: 8 },
    });
    memories.push(reopened);
    await reopened.recall('cello');
    const index = (reopened as unknown as { _hnswSidecar: HnswSidecar })._hnswSidecar;
    expect(index.size).toBe(2);
    expect(idsIn(mapFile)).toEqual([first.id, later.id].sort());
  });

  it('can activate the index after a failed removal is repaired', async () => {
    const { memory, indexFile } = await embeddingFacade();
    fs.mkdirSync(indexFile);
    fs.writeFileSync(path.join(indexFile, 'held'), 'x');
    await expect(memory.rebuildVectorIndex()).rejects.toThrow();
    fs.rmSync(indexFile, { recursive: true });
    for (let n = 0; n < 1000; n += 1) await memory.remember(`distinct trace ${n}`);
    const index = (memory as unknown as { _hnswSidecar: HnswSidecar })._hnswSidecar;
    expect(index.isActive).toBe(true);
    expect(index.size).toBe(1000);
  }, 30_000);

  it('fails when an index file cannot be removed', async () => {
    const { memory, indexFile } = await embeddingFacade();
    await memory.remember('Ana keeps bees.');
    // A folder where the index file belongs, with a file in it: it cannot be removed as a file.
    fs.mkdirSync(indexFile);
    fs.writeFileSync(path.join(indexFile, 'held'), 'x');

    await expect(memory.rebuildVectorIndex()).rejects.toThrow();
    expect(fs.existsSync(path.join(indexFile, 'held'))).toBe(true);
  });

  /** Waits the time given. */
  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Holds the first start of an index after this call until `release()`, as a slow disk holds a rewrite once it has
   * read its traces; every later start runs at once.
   */
  function holdFirstIndexStart(): { reached: Promise<void>; release: () => void } {
    const start = HnswSidecar.prototype.init;
    let reach!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => (reach = resolve));
    const held = new Promise<void>((resolve) => (release = resolve));
    let starts = 0;
    vi.spyOn(HnswSidecar.prototype, 'init').mockImplementation(async function (this: HnswSidecar) {
      if (starts++ === 0) {
        reach();
        await held;
      }
      return start.call(this);
    });
    return { reached, release };
  }

  it('keeps a deleted trace out of the files when a rewrite that read it is still running', async () => {
    const { memory, brain, indexFile, mapFile } = await embeddingFacade();
    const bees = await memory.remember('Ana keeps bees.');
    const cello = await memory.remember('Bo plays cello.');

    // A first rewrite reads both traces, then waits before it writes.
    const hold = holdFirstIndexStart();
    const first = memory.rebuildVectorIndex();
    await hold.reached;

    // Meanwhile one trace is deleted for good and a second rewrite is asked for, as a second person's deletion asks.
    const deleted = memory.deleteTraces([cello.id]);
    const rowOf = () => brain.get('SELECT id FROM memory_traces WHERE brain_id = ? AND id = ?', [brain.brainId, cello.id]);
    for (let polls = 0; (await rowOf()) != null && polls < 200; polls += 1) await delay(10);
    expect(await rowOf()).toBeFalsy();
    const second = memory.rebuildVectorIndex();
    // Time enough for the second rewrite to finish, if nothing holds it behind the first.
    await Promise.race([second, delay(200)]);
    hold.release();
    await Promise.all([first, deleted, second]);

    // The files hold the trace that is left; the deleted trace's vector is in neither.
    expect(idsIn(mapFile)).toEqual([bees.id]);
    expect(vectorsIn(indexFile)).not.toContainEqual(vectorOf('cello'));
  });

  it('indexes a trace remembered while a rewrite is running', async () => {
    const { memory } = await embeddingFacade();
    await memory.remember('Ana keeps bees.');

    // A rewrite reads the one trace, then waits before it writes; a second trace is remembered meanwhile.
    const hold = holdFirstIndexStart();
    const rewrite = memory.rebuildVectorIndex();
    await hold.reached;
    const chess = memory.remember('Cy teaches chess.');
    await Promise.race([chess, delay(200)]);
    hold.release();
    await Promise.all([rewrite, chess]);

    // Both traces are in the index the store recalls from.
    expect((memory as unknown as { _hnswSidecar: HnswSidecar })._hnswSidecar.size).toBe(2);
  });

  it('fails when the rebuilt index does not save', async () => {
    const { memory, indexFile } = await embeddingFacade();
    await memory.remember('Ana keeps bees.');
    // The sidecar logs a write that failed; the case reads the error the call throws.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    indexWrites.fail = true;

    await expect(memory.rebuildVectorIndex()).rejects.toThrow(/did not save/);
    expect(fs.existsSync(indexFile)).toBe(false);

    // Once the file can be written, the same call writes it.
    indexWrites.fail = false;
    expect(await memory.rebuildVectorIndex()).toEqual({ vectors: 1 });
    expect(fs.existsSync(indexFile)).toBe(true);
  });
});

describe('user metadata written by an earlier importer', () => {
  it('deletes a numeric turnUserId by its textual user id', async () => {
    const { memory } = await facade();
    const numeric = await memory.remember('earlier imported words', { metadata: { turnUserId: 42 } });
    const other = await memory.remember('another person', { metadata: { turnUserId: '420' } });
    expect(await memory.deleteTracesNamingUser('42')).toEqual({ deleted: 1 });
    expect(await brainOf(memory).get('SELECT id FROM memory_traces WHERE id = ?', [numeric.id])).toBeFalsy();
    expect(await brainOf(memory).get('SELECT id FROM memory_traces WHERE id = ?', [other.id])).toBeTruthy();
  });
});

describe("the store's forgotten-user ledger", () => {
  const ALICE: SuppressionSubject = { kind: 'user', id: 'alice' };
  const BOB: SuppressionSubject = { kind: 'user', id: 'bob' };

  it("marks and reads a forgotten subject through the store's ledger, and refuses both without one", async () => {
    const dir = folder();
    const { adapter: copy } = await openForgottenCopy(path.join(dir, 'forgotten.sqlite'));
    adapters.push(copy);
    const memory = await Memory.createSqlite(path.join(dir, 'brain.sqlite'), { brainId: 'tools-brain', forgotten: { copy } });
    memories.push(memory);

    expect(memory.forgotten).toBeInstanceOf(ForgottenLedger);
    expect(await memory.isForgotten(ALICE)).toBe(false);
    expect(await memory.markForgotten(ALICE)).toEqual({ form: 'unkeyed', written: true });
    expect(await memory.isForgotten(ALICE)).toBe(true);
    expect(await memory.isForgotten(BOB)).toBe(false);

    // The tombstone is in the store's own database and in the copy outside it.
    const hash = await ForgottenLedger.hash('', ALICE);
    const tombstones = 'SELECT hash FROM agentos_learning_forgotten WHERE hash = ?';
    expect(await brainOf(memory).all(tombstones, [hash])).toEqual([{ hash }]);
    expect(await copy.all(tombstones, [hash])).toEqual([{ hash }]);

    // A ledger that is already open is taken as it is.
    const second = await Memory.createSqlite(path.join(dir, 'second.sqlite'), { brainId: 'tools-brain', forgotten: memory.forgotten });
    memories.push(second);
    expect(second.forgotten).toBe(memory.forgotten);
    expect(await second.isForgotten(ALICE)).toBe(true);

    // A store opened without a ledger has neither call.
    const { memory: plain } = await facade();
    expect(plain.forgotten).toBeUndefined();
    await expect(plain.markForgotten(ALICE)).rejects.toThrow(/without a forgotten-user ledger/);
    await expect(plain.isForgotten(ALICE)).rejects.toThrow(/without a forgotten-user ledger/);
  });

  it('closes a store whose ledger does not open, and opens it again with the right key', async () => {
    const file = path.join(folder(), 'brain.sqlite');
    const first = await Memory.createSqlite(file, { brainId: 'tools-brain', forgotten: { key: { current: 'k-first' } } });
    expect(await first.markForgotten(ALICE)).toEqual({ form: 'keyed', written: true });
    await first.close();

    const closed = vi.spyOn(Brain.prototype, 'close');
    await expect(Memory.createSqlite(file, { brainId: 'tools-brain', forgotten: { key: { current: 'k' } } })).rejects.toMatchObject({
      name: 'ForgottenLedgerError',
      code: 'KEY_REQUIRED',
    });
    // The refused open closed the database it had opened.
    expect(closed).toHaveBeenCalledTimes(1);
    closed.mockRestore();

    const again = await Memory.createSqlite(file, { brainId: 'tools-brain', forgotten: { key: { current: 'k-first' } } });
    memories.push(again);
    expect(await again.isForgotten(ALICE)).toBe(true);
  });

  it('adds the identity and the state to a store whose ledger was made without them', async () => {
    const file = path.join(folder(), 'brain.sqlite');
    // The ledger's table as a release before the identity and state rows wrote it: one tombstone, no copy marker.
    const handwritten = await resolveStorageAdapter({ filePath: file, priority: ['better-sqlite3'], quiet: true });
    await handwritten.exec(
      'CREATE TABLE IF NOT EXISTS agentos_learning_forgotten (hash TEXT PRIMARY KEY, namespace TEXT NOT NULL DEFAULT \'\', forgotten_at TEXT NOT NULL);',
    );
    const tombstone = { hash: 'd'.repeat(64), namespace: '', forgotten_at: '2026-10-12T11:00:00.000Z' };
    await handwritten.run('INSERT INTO agentos_learning_forgotten (hash, namespace, forgotten_at) VALUES (?, ?, ?)', [
      tombstone.hash,
      tombstone.namespace,
      tombstone.forgotten_at,
    ]);
    await handwritten.close();

    const memory = await Memory.createSqlite(file, { brainId: 'tools-brain', forgotten: {} });
    memories.push(memory);

    const rows = await brainOf(memory).all<{ hash: string; namespace: string; forgotten_at: string }>(
      'SELECT hash, namespace, forgotten_at FROM agentos_learning_forgotten ORDER BY hash',
    );
    expect(rows).toEqual([
      tombstone,
      { hash: 'i1:identity', namespace: '', forgotten_at: expect.stringMatching(/^[0-9a-f]{32}$/) },
      { hash: 's1:state', namespace: '', forgotten_at: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
  });

  it('opens a store that holds a user\'s memory and no ledger', async () => {
    const dir = folder();
    const file = path.join(dir, 'brain.sqlite');
    const before = await Memory.createSqlite(file, { brainId: 'tools-brain' });
    const trace = await before.remember('Ana keeps a canary named Lark.', { scope: 'user', scopeId: 'ana' });
    await before.close();

    const { adapter: copy } = await openForgottenCopy(path.join(dir, 'forgotten.sqlite'));
    adapters.push(copy);
    const memory = await Memory.createSqlite(file, { brainId: 'tools-brain', forgotten: { copy } });
    memories.push(memory);

    expect(await brainOf(memory).all('SELECT id FROM memory_traces WHERE id = ?', [trace.id])).toEqual([{ id: trace.id }]);
    expect(await memory.forgotten!.size()).toBe(0);
  });
});

describe.skipIf(!POSTGRES_URL)('erasure on Postgres', () => {
  it('deletes the chunks, their pictures and an emptied document with the option', async () => {
    await deletesChunksPicturesAndAnEmptiedDocument(await postgresFacade());
  });

  it('deletes every trace that names a user, under any scope, and no other', async () => {
    await deletesEveryTraceThatNamesAUser(await postgresFacade());
  });
});
