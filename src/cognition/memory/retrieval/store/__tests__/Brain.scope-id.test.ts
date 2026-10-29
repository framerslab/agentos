/**
 * @file Brain.scope-id.test.ts
 * `memory_traces.scope_id`: the scope id of a trace as a column of its own. A Brain at schema version 2 gains the
 * column on open, filled from each row's metadata JSON (a malformed row stays ''), for every brain the file holds, with
 * one read of each row; a row a release without the column writes to a brain already at version 3 is filled at the next
 * open, a key spelled with a JSON escape included, by a fill that reads only the rows whose metadata can name a scope
 * id, through an index of those rows alone; a trace whose id is the empty string is filled as any other is; an open
 * that another connection beats to adding the column opens and fills it for every brain; the migration of a brain whose
 * table already has the column reads none of its rows and builds no index, which the open does once that migration has
 * committed; a fresh Brain has it; the index a per-scope read uses exists; every writer this file reaches sets it; and
 * the importers file by it and deduplicate inside one scope id, where a trace such a release wrote counts under the
 * scope id its metadata names. Real SQLite files through `@framers/sql-storage-adapter`, as the store opens them in
 * production.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStorageFeatures, resolveStorageAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { Brain } from '../Brain.js';
import { fillScopeIds, v2ToV3 } from '../migrations/v2-to-v3.js';
import { MemoryStore } from '../MemoryStore.js';
import { Memory } from '../../../io/facade/Memory.js';
import { MemoryAddTool } from '../../../io/tools/MemoryAddTool.js';
import { JsonImporter } from '../../../io/JsonImporter.js';
import { SqliteImporter } from '../../../io/SqliteImporter.js';
import { CsvImporter } from '../../../io/CsvImporter.js';
import { MarkdownImporter } from '../../../io/MarkdownImporter.js';
import { ChatGptImporter } from '../../../io/ChatGptImporter.js';
import { InMemoryVectorStore } from '../../../../rag/vector_stores/InMemoryVectorStore.js';
import type { IKnowledgeGraph } from '../../graph/knowledge/IKnowledgeGraph.js';
import type { IEmbeddingManager } from '../../../../../core/embeddings/IEmbeddingManager.js';
import type { MemoryTrace } from '../../../core/types.js';
import type { VectorStoreProviderConfig } from '../../../../../core/vector-store/IVectorStore.js';

const dirs: string[] = [];
const brains: Brain[] = [];
afterEach(async () => {
  while (brains.length) await brains.pop()!.close();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-scope-id-'));
  dirs.push(dir);
  return path.join(dir, 'brain.sqlite');
}

async function open(filePath: string, brainId: string): Promise<Brain> {
  const brain = await Brain.openSqlite(filePath, { brainId });
  brains.push(brain);
  return brain;
}

/** The two tables a schema-2 Brain held, exactly as schema 2 wrote them (no scope_id). */
const SCHEMA_2_DDL = `
CREATE TABLE brain_meta (brain_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (brain_id, key));
CREATE TABLE memory_traces (
  brain_id TEXT NOT NULL, id TEXT NOT NULL, type TEXT NOT NULL, scope TEXT NOT NULL, content TEXT NOT NULL,
  embedding BLOB, strength REAL NOT NULL DEFAULT 1.0, created_at INTEGER NOT NULL, last_accessed INTEGER,
  retrieval_count INTEGER NOT NULL DEFAULT 0, tags TEXT NOT NULL DEFAULT '[]', emotions TEXT NOT NULL DEFAULT '{}',
  metadata TEXT NOT NULL DEFAULT '{}', deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (brain_id, id)
);`;

/** A schema-2 file with two brains' rows: one row per metadata shape the backfill meets. */
async function schema2File(): Promise<string> {
  const filePath = tempFile();
  const raw: StorageAdapter = await resolveStorageAdapter({ filePath, priority: ['better-sqlite3', 'sqljs'], quiet: true });
  await raw.exec(SCHEMA_2_DDL);
  for (const brainId of ['b1', 'b2']) {
    await raw.run(`INSERT INTO brain_meta (brain_id, key, value) VALUES (?, 'schema_version', '2')`, [brainId]);
  }
  const rows: Array<[string, string, string, string]> = [
    ['b1', 't-user', 'user', JSON.stringify({ scopeId: 'ana' })],
    ['b1', 't-persona', 'persona', JSON.stringify({ scopeId: 'ana::tutor' })],
    ['b1', 't-none', 'user', JSON.stringify({ document_id: 'doc-1' })],
    ['b1', 't-bad', 'user', '{not json'],
    ['b2', 't-other', 'user', JSON.stringify({ scopeId: 'bo' })],
  ];
  for (const [brainId, id, scope, metadata] of rows) {
    await raw.run(
      `INSERT INTO memory_traces (brain_id, id, type, scope, content, created_at, metadata) VALUES (?, ?, 'episodic', ?, ?, 1, ?)`,
      [brainId, id, scope, `content of ${id}`, metadata],
    );
  }
  await raw.close();
  return filePath;
}

type Statement = { sql: string; params?: Parameters<StorageAdapter['all']>[1] };

/**
 * `raw`, counting how often each row comes back from the fill's reads, the statements on memory_traces that ask for
 * scope_id '', and keeping each such statement.
 */
function countingReads(raw: StorageAdapter): { adapter: StorageAdapter; reads: Record<string, number>; statements: Statement[] } {
  const reads: Record<string, number> = {};
  const statements: Statement[] = [];
  const adapter = {
    kind: raw.kind,
    get: raw.get.bind(raw),
    run: raw.run.bind(raw),
    exec: raw.exec.bind(raw),
    all: async (sql: string, params?: Parameters<StorageAdapter['all']>[1]) => {
      const rows = await raw.all<{ id?: string }>(sql, params);
      if (sql.includes('FROM memory_traces') && sql.includes("scope_id = ''")) {
        statements.push({ sql, params });
        for (const { id } of rows) if (id) reads[id] = (reads[id] ?? 0) + 1;
      }
      return rows;
    },
  } as unknown as StorageAdapter;
  return { adapter, reads, statements };
}

const scopeIdsOf = async (brain: Brain) =>
  Object.fromEntries(
    (await brain.all<{ id: string; scope_id: string }>('SELECT id, scope_id FROM memory_traces ORDER BY id')).map((r) => [r.id, r.scope_id]),
  );

describe('memory_traces.scope_id', () => {
  it('is added to a schema-2 Brain on open and filled from each row of every brain', async () => {
    const filePath = await schema2File();
    const b1 = await open(filePath, 'b1');
    expect(await b1.getMeta('schema_version')).toBe('3');
    expect(await scopeIdsOf(b1)).toEqual({ 't-bad': '', 't-none': '', 't-other': 'bo', 't-persona': 'ana::tutor', 't-user': 'ana' });
    const indexes = await b1.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'memory_traces'`);
    expect(indexes.map((i) => i.name)).toContain('idx_memory_traces_brain_scope_id');
    const columns = await b1.all<{ name: string }>(`SELECT name FROM pragma_index_info('idx_memory_traces_brain_scope_id') ORDER BY seqno`);
    expect(columns.map((c) => c.name)).toEqual(['brain_id', 'scope', 'scope_id', 'created_at']);
  });

  it('is filled for a brain whose rows an older writer added after another brain migrated', async () => {
    const filePath = await schema2File();
    await (await open(filePath, 'b1')).close();
    brains.length = 0;
    const raw = await resolveStorageAdapter({ filePath, priority: ['better-sqlite3', 'sqljs'], quiet: true });
    // A release without the column writes with the column's default.
    await raw.run(
      `INSERT INTO memory_traces (brain_id, id, type, scope, content, created_at, metadata) VALUES ('b2', 't-late', 'episodic', 'user', 'late', 2, ?)`,
      [JSON.stringify({ scopeId: 'cy' })],
    );
    await raw.close();
    const b2 = await open(filePath, 'b2');
    expect(await b2.getMeta('schema_version')).toBe('3');
    expect((await scopeIdsOf(b2))['t-late']).toBe('cy');
  });

  it('is filled at the next open for a row an older writer added after its own brain migrated', async () => {
    const filePath = await schema2File();
    await (await open(filePath, 'b1')).close();
    brains.length = 0;
    const raw = await resolveStorageAdapter({ filePath, priority: ['better-sqlite3', 'sqljs'], quiet: true });
    // b1 is at schema version 3 now, and a release without the column still writes the column's default.
    await raw.run(
      `INSERT INTO memory_traces (brain_id, id, type, scope, content, created_at, metadata) VALUES ('b1', 't-late', 'episodic', 'user', 'late', 2, ?)`,
      [JSON.stringify({ scopeId: 'cy' })],
    );
    await raw.close();
    const b1 = await open(filePath, 'b1');
    expect((await scopeIdsOf(b1))['t-late']).toBe('cy');
  });

  it('is filled at the next open for a row whose metadata spells the scopeId key with a JSON escape', async () => {
    const filePath = tempFile();
    await (await open(filePath, 'b1')).close();
    brains.length = 0;
    const raw = await resolveStorageAdapter({ filePath, priority: ['better-sqlite3', 'sqljs'], quiet: true });
    // JSON.parse reads the key "\u0073copeId" as scopeId: a writer may escape any letter of a key.
    await raw.run(
      `INSERT INTO memory_traces (brain_id, id, type, scope, content, created_at, metadata) VALUES ('b1', 't-escaped', 'episodic', 'user', 'x', 1, ?)`,
      ['{"\\u0073copeId":"cy"}'],
    );
    await raw.close();
    const b1 = await open(filePath, 'b1');
    expect((await scopeIdsOf(b1))['t-escaped']).toBe('cy');
  });

  it('is filled with one read of each row when the migration of the brain opened adds it', async () => {
    const raw = await resolveStorageAdapter({ filePath: await schema2File(), priority: ['better-sqlite3', 'sqljs'], quiet: true });
    const { adapter, reads } = countingReads(raw);
    try {
      await v2ToV3.up(adapter, createStorageFeatures(raw), 'b1');
    } finally {
      await raw.close();
    }
    expect(reads).toEqual({ 't-bad': 1, 't-none': 1, 't-other': 1, 't-persona': 1, 't-user': 1 });
  });

  it("is filled at an open from a read of only the rows whose metadata can name a scope id other than ''", async () => {
    const filePath = tempFile();
    await (await open(filePath, 'b1')).close();
    brains.length = 0;
    const raw = await resolveStorageAdapter({ filePath, priority: ['better-sqlite3', 'sqljs'], quiet: true });
    const rows: Array<[string, Record<string, unknown>]> = [
      // remember() files a trace that names no scope id with the metadata scopeId ''.
      ['t-unscoped', { content_hash: 'h1', scopeId: '' }],
      ['t-no-key', { document_id: 'doc-1' }],
      // A release without the column wrote these two: the scope id of the second is its top-level scopeId.
      ['t-ana', { scopeId: 'ana' }],
      ['t-nested', { scopeId: 'bo', origin: { scopeId: '' } }],
    ];
    for (const [id, metadata] of rows) {
      await raw.run(
        `INSERT INTO memory_traces (brain_id, id, type, scope, content, created_at, metadata) VALUES ('b1', ?, 'episodic', 'user', 'x', 1, ?)`,
        [id, JSON.stringify(metadata)],
      );
    }
    const { adapter, reads } = countingReads(raw);
    try {
      await fillScopeIds(adapter, 'b1');
      expect(reads).toEqual({ 't-ana': 1, 't-nested': 1 });
      expect(await raw.all(`SELECT id, scope_id FROM memory_traces WHERE brain_id = 'b1' ORDER BY id`)).toEqual([
        { id: 't-ana', scope_id: 'ana' },
        { id: 't-nested', scope_id: 'bo' },
        { id: 't-no-key', scope_id: '' },
        { id: 't-unscoped', scope_id: '' },
      ]);
    } finally {
      await raw.close();
    }
  });

  it('is filled at an open by a read of an index that holds only the rows it can fill', async () => {
    const filePath = tempFile();
    await (await open(filePath, 'b1')).close();
    brains.length = 0;
    const raw = await resolveStorageAdapter({ filePath, priority: ['better-sqlite3', 'sqljs'], quiet: true });
    const { adapter, statements } = countingReads(raw);
    try {
      await fillScopeIds(adapter, 'b1');
      expect(statements).toHaveLength(1);
      // The primary key would walk every row of the brain, the embedding of each before its metadata.
      const plan = await raw.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${statements[0]!.sql}`, statements[0]!.params);
      expect(plan.map((step) => step.detail).join('\n')).toContain('idx_memory_traces_unfiled_scope_id');
    } finally {
      await raw.close();
    }
  });

  it('is part of a fresh Brain, which seeds schema version 3', async () => {
    const brain = await open(tempFile(), 'fresh');
    const columns = await brain.all<{ name: string; notnull: number; dflt_value: string | null }>('PRAGMA table_info(memory_traces)');
    expect(columns.find((c) => c.name === 'scope_id')).toMatchObject({ notnull: 1, dflt_value: "''" });
    expect(await brain.getMeta('schema_version')).toBe('3');
  });

  it("is set by MemoryStore.store() from the trace's scope id", async () => {
    const brain = await open(tempFile(), 'store');
    const vectorStore = new InMemoryVectorStore();
    await vectorStore.initialize({ id: 'scope-id', type: 'in_memory', defaultEmbeddingDimension: 4, similarityMetric: 'cosine' } as VectorStoreProviderConfig);
    const store = new MemoryStore({
      vectorStore,
      embeddingManager: { generateEmbeddings: async () => ({ embeddings: [[1, 0, 0, 0]], model: 'fixed', usage: { promptTokens: 0, totalTokens: 0 } }) } as unknown as IEmbeddingManager,
      knowledgeGraph: { recordMemory: async () => ({}) } as unknown as IKnowledgeGraph,
      collectionPrefix: 'cogmem',
    });
    store.setBrain(brain);
    const now = Date.now();
    await store.store({
      id: 't-1', type: 'episodic', scope: 'user', scopeId: 'ana', content: 'Ana likes tea.', entities: [], tags: [],
      provenance: { sourceType: 'user_statement', sourceTimestamp: now, confidence: 1, verificationCount: 0 },
      emotionalContext: { valence: 0, arousal: 0, dominance: 0, intensity: 0, gmiMood: '' },
      encodingStrength: 1, stability: 3_600_000, retrievalCount: 0, lastAccessedAt: now, accessCount: 0,
      reinforcementInterval: 3_600_000, associatedTraceIds: [], createdAt: now, updatedAt: now, isActive: true,
    } as MemoryTrace);
    expect(await scopeIdsOf(brain)).toEqual({ 't-1': 'ana' });
  });

  it('fills every page of every brain', async () => {
    const filePath = tempFile();
    const raw: StorageAdapter = await resolveStorageAdapter({ filePath, priority: ['better-sqlite3', 'sqljs'], quiet: true });
    await raw.exec(SCHEMA_2_DDL);
    for (const brainId of ['b1', 'b2']) {
      await raw.run(`INSERT INTO brain_meta (brain_id, key, value) VALUES (?, 'schema_version', '2')`, [brainId]);
      for (let i = 0; i < 650; i += 1) {
        // Every third row holds no scope id, so a page holds rows the fill leaves as they are.
        const metadata = i % 3 === 0 ? { document_id: 'doc-1' } : { scopeId: `${brainId}-u${i}` };
        await raw.run(
          `INSERT INTO memory_traces (brain_id, id, type, scope, content, created_at, metadata) VALUES (?, ?, 'episodic', 'user', 'x', 1, ?)`,
          [brainId, `t-${String(i).padStart(4, '0')}`, JSON.stringify(metadata)],
        );
      }
    }
    await raw.close();
    const b1 = await open(filePath, 'b1');
    for (const brainId of ['b1', 'b2']) {
      const rows = await b1.all<{ scope_id: string; metadata: string }>('SELECT scope_id, metadata FROM memory_traces WHERE brain_id = ?', [brainId]);
      expect(rows).toHaveLength(650);
      expect(rows.filter((row) => row.scope_id !== (JSON.parse(row.metadata).scopeId ?? ''))).toEqual([]);
      expect(rows.filter((row) => row.scope_id !== '')).toHaveLength(433);
    }
  });

  it('is filled for a trace whose id is the empty string', async () => {
    const filePath = await schema2File();
    const raw = await resolveStorageAdapter({ filePath, priority: ['better-sqlite3', 'sqljs'], quiet: true });
    // A release without the column kept the id of an imported record, the empty string included.
    await raw.run(
      `INSERT INTO memory_traces (brain_id, id, type, scope, content, created_at, metadata) VALUES ('b1', '', 'episodic', 'user', 'x', 1, ?)`,
      [JSON.stringify({ scopeId: 'cy' })],
    );
    await raw.close();
    const b1 = await open(filePath, 'b1');
    expect((await scopeIdsOf(b1))['']).toBe('cy');
  });

  it('is filled at the next open for a trace whose id is the empty string', async () => {
    const filePath = tempFile();
    await (await open(filePath, 'b1')).close();
    brains.length = 0;
    const raw = await resolveStorageAdapter({ filePath, priority: ['better-sqlite3', 'sqljs'], quiet: true });
    await raw.run(
      `INSERT INTO memory_traces (brain_id, id, type, scope, content, created_at, metadata) VALUES ('b1', '', 'episodic', 'user', 'x', 1, ?)`,
      [JSON.stringify({ scopeId: 'cy' })],
    );
    await raw.close();
    const b1 = await open(filePath, 'b1');
    expect((await scopeIdsOf(b1))['']).toBe('cy');
  });

  it('is added, and filled for every brain, by an open that another connection beats to adding it', async () => {
    // A table another path made without the column, under a brain at schema version 3, so no migration runs.
    const filePath = tempFile();
    const raw = await resolveStorageAdapter({ filePath, priority: ['better-sqlite3'], quiet: true });
    await raw.exec(SCHEMA_2_DDL);
    await raw.run(`INSERT INTO brain_meta (brain_id, key, value) VALUES ('b1', 'schema_version', '3')`);
    for (const [brainId, id, scopeId] of [['b1', 't-1', 'cy'], ['b2', 't-2', 'bo']]) {
      await raw.run(
        `INSERT INTO memory_traces (brain_id, id, type, scope, content, created_at, metadata) VALUES (?, ?, 'episodic', 'user', 'x', 1, ?)`,
        [brainId, id, JSON.stringify({ scopeId })],
      );
    }
    // Another process adds the column once this open has looked for it, and stops before it fills the table.
    let beaten = false;
    const racing = new Proxy(raw, {
      get(target, prop) {
        if (prop === 'all') {
          return async (sql: string, params?: Parameters<StorageAdapter['all']>[1]) => {
            const rows = await target.all(sql, params);
            if (!beaten && sql === 'PRAGMA table_info(memory_traces)') {
              beaten = true;
              const other = await resolveStorageAdapter({ filePath, priority: ['better-sqlite3'], quiet: true });
              try {
                await other.exec(`ALTER TABLE memory_traces ADD COLUMN scope_id TEXT NOT NULL DEFAULT ''`);
              } finally {
                await other.close();
              }
            }
            return rows;
          };
        }
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    let brain: Brain | undefined;
    try {
      brain = await Brain.openWithAdapter(racing, { brainId: 'b1' });
      expect(beaten).toBe(true);
      // b2 is not opened: its trace is filed with the table.
      expect(await scopeIdsOf(brain)).toEqual({ 't-1': 'cy', 't-2': 'bo' });
    } finally {
      if (brain) await brain.close();
      else await raw.close();
    }
  });

  it('is neither read nor indexed by the migration of a brain whose table already has it', async () => {
    const filePath = await schema2File();
    // b1's migration adds the column and fills every brain; b2 is still at schema version 2.
    await (await open(filePath, 'b1')).close();
    brains.length = 0;
    const raw = await resolveStorageAdapter({ filePath, priority: ['better-sqlite3', 'sqljs'], quiet: true });
    const statements: string[] = [];
    const keeping = new Proxy(raw, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop, target);
        if (typeof value !== 'function') return value;
        if (prop === 'all' || prop === 'get' || prop === 'run' || prop === 'exec') {
          return (sql: string, ...rest: unknown[]) => {
            statements.push(sql);
            return (value as (...args: unknown[]) => unknown).apply(target, [sql, ...rest]);
          };
        }
        return value.bind(target);
      },
    });
    try {
      await v2ToV3.up(keeping, createStorageFeatures(raw), 'b2');
    } finally {
      await raw.close();
    }
    // A migration runs under BEGIN IMMEDIATE, or in a transaction on Postgres: a read of the brain's rows or an index
    // build there holds up every writer of the table. The open files the rows and makes the indexes after it commits.
    expect(statements.filter((sql) => sql.includes('memory_traces'))).toEqual(['PRAGMA table_info(memory_traces)']);
  });
});

describe("the facade's writers set scope_id", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (closers.length) await closers.pop()!();
  });
  async function facade(): Promise<Memory> {
    const memory = await Memory.createSqlite(tempFile(), { brainId: 'facade' });
    closers.push(() => memory.close());
    return memory;
  }
  // Ordered by content: two writes can share a millisecond, and the facade's trace ids are random.
  const rowsOf = (memory: Memory) =>
    (memory as unknown as { _brain: Brain })._brain.all<{ content: string; scope: string; scope_id: string }>(
      'SELECT content, scope, scope_id FROM memory_traces WHERE deleted = 0 ORDER BY content',
    );

  it('remember() files its scope id in the column, and a call that names none files under ""', async () => {
    const memory = await facade();
    await memory.remember('Ana likes tea.', { scope: 'user', scopeId: 'ana' });
    await memory.remember('The office closes at six.');
    expect(await rowsOf(memory)).toEqual([
      { content: 'Ana likes tea.', scope: 'user', scope_id: 'ana' },
      { content: 'The office closes at six.', scope: 'user', scope_id: '' },
    ]);
  });

  it("ingest() files its chunks under '', the scope id they carry", async () => {
    const memory = await facade();
    const dir = path.dirname(tempFile());
    const filePath = path.join(dir, 'notes.txt');
    await fsp.writeFile(filePath, 'The quick brown fox jumps over the lazy dog. '.repeat(30), 'utf8');
    expect((await memory.ingest(filePath)).tracesCreated).toBeGreaterThanOrEqual(1);
    const rows = await rowsOf(memory);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((row) => row.scope_id === '')).toBe(true);
  });

  it("memory_add files the scope id it resolves from the call's context", async () => {
    const memory = await facade();
    const brain = (memory as unknown as { _brain: Brain })._brain;
    const add = new MemoryAddTool(brain);
    const context = { gmiId: 'g', personaId: 'tutor', userContext: { userId: 'ana' } as never, sessionData: { sessionId: 's-1' } };
    expect((await add.execute({ content: 'Ana prefers mornings.', scope: 'user' }, context)).success).toBe(true);
    expect((await add.execute({ content: 'Thread note.', scope: 'thread' }, context)).success).toBe(true);
    expect((await add.execute({ content: 'Persona note.', scope: 'persona' }, context)).success).toBe(true);
    expect(await rowsOf(memory)).toEqual([
      { content: 'Ana prefers mornings.', scope: 'user', scope_id: 'ana' },
      { content: 'Persona note.', scope: 'persona', scope_id: 'ana::tutor' },
      { content: 'Thread note.', scope: 'thread', scope_id: 's-1' },
    ]);
  });
});

describe('the importers file by scope id and deduplicate inside one', () => {
  /** A JSON export holding one trace of `user:<scopeId>` with the given text, tags and creation time. */
  const exportOf = (scopeId: string, text: string, tags: string[], createdAt: number) =>
    JSON.stringify({
      meta: { schema_version: '3' },
      traces: [{
        id: `t-${scopeId}`, type: 'episodic', scope: 'user', content: text, strength: 1, created_at: createdAt,
        retrieval_count: 0, tags: JSON.stringify(tags), emotions: '{}', metadata: JSON.stringify({ scopeId }), deleted: 0,
      }],
    });
  const tracesOf = (brain: Brain) =>
    brain.all<{ scope_id: string; tags: string; created_at: number }>(
      'SELECT scope_id, tags, created_at FROM memory_traces WHERE deleted = 0 ORDER BY scope_id',
    );

  it('JSON: two tenants with one equal text keep two rows, and neither row changes', async () => {
    const brain = await open(tempFile(), 'json');
    const importer = new JsonImporter(brain);
    await importer.importFromString(exportOf('A%2F42', 'Same words.', ['a'], 100));
    const second = await importer.importFromString(exportOf('B%2F42', 'Same words.', ['b'], 200));
    expect(second.imported).toBe(1);
    expect(await tracesOf(brain)).toEqual([
      { scope_id: 'A%2F42', tags: '["a"]', created_at: 100 },
      { scope_id: 'B%2F42', tags: '["b"]', created_at: 200 },
    ]);
    // Inside one scope id the text is still a duplicate.
    expect((await importer.importFromString(exportOf('A%2F42', 'Same words.', ['c'], 300))).skipped).toBe(1);
  });

  it("SQLite: a record of another scope id is imported, and no other tenant's tags or time are merged", async () => {
    const target = await open(tempFile(), 'sqlite-target');
    await new JsonImporter(target).importFromString(exportOf('A%2F42', 'Same words.', ['a'], 100));
    const sourcePath = tempFile();
    const source = await open(sourcePath, 'sqlite-source');
    await new JsonImporter(source).importFromString(exportOf('B%2F42', 'Same words.', ['b'], 200));
    const result = await new SqliteImporter(target).import(sourcePath);
    expect(result.imported).toBe(1);
    expect(await tracesOf(target)).toEqual([
      { scope_id: 'A%2F42', tags: '["a"]', created_at: 100 },
      { scope_id: 'B%2F42', tags: '["b"]', created_at: 200 },
    ]);
  });

  /** A CSV holding one row of `user:<scopeId>` with the text 'Same words.'. */
  const csv = (scopeId: string) =>
    `content,scope,metadata\n"Same words.",user,"${JSON.stringify({ scopeId }).replace(/"/g, '""')}"\n`;

  it('CSV: the scope id comes from the metadata column, and dedup reads only that scope id', async () => {
    const brain = await open(tempFile(), 'csv');
    await new CsvImporter(brain).importFromString(csv('A%2F42'));
    expect((await new CsvImporter(brain).importFromString(csv('B%2F42'))).imported).toBe(1);
    expect((await tracesOf(brain)).map((row) => row.scope_id)).toEqual(['A%2F42', 'B%2F42']);
  });

  it("Markdown: a file whose text another scope id holds is imported under '', and dedup reads only ''", async () => {
    const brain = await open(tempFile(), 'markdown');
    await new JsonImporter(brain).importFromString(exportOf('A%2F42', 'Same words.', ['a'], 100));
    const dir = path.join(path.dirname(tempFile()), 'notes');
    await fsp.mkdir(dir);
    await fsp.writeFile(path.join(dir, 'same.md'), '---\nscope: user\n---\nSame words.\n', 'utf8');
    expect((await new MarkdownImporter(brain).import(dir)).imported).toBe(1);
    expect((await tracesOf(brain)).map((row) => row.scope_id)).toEqual(['', 'A%2F42']);
    // A second import finds the trace the first filed under ''.
    expect((await new MarkdownImporter(brain).import(dir)).skipped).toBe(1);
  });

  describe("a trace a release without scope_id wrote holds '', and is read under the scope id its metadata names", () => {
    /** A release without the column writes its default, '', whatever scope id the metadata names. */
    const asOlderRelease = (brain: Brain) => brain.run(`UPDATE memory_traces SET scope_id = ''`);

    it('JSON: a record of that scope id is its duplicate', async () => {
      const brain = await open(tempFile(), 'json-older');
      const importer = new JsonImporter(brain);
      await importer.importFromString(exportOf('A%2F42', 'Same words.', ['a'], 100));
      await asOlderRelease(brain);
      expect((await importer.importFromString(exportOf('A%2F42', 'Same words.', ['a'], 100))).skipped).toBe(1);
      expect(await tracesOf(brain)).toEqual([{ scope_id: 'A%2F42', tags: '["a"]', created_at: 100 }]);
    });

    it("SQLite: a record filed under '' is imported, and no tags or time are merged into that trace", async () => {
      const target = await open(tempFile(), 'sqlite-older-target');
      await new JsonImporter(target).importFromString(exportOf('A%2F42', 'Same words.', ['a'], 100));
      await asOlderRelease(target);
      const sourcePath = tempFile();
      const source = await open(sourcePath, 'sqlite-older-source');
      await new JsonImporter(source).importFromString(exportOf('', 'Same words.', ['b'], 200));
      expect((await new SqliteImporter(target).import(sourcePath)).imported).toBe(1);
      expect(await tracesOf(target)).toEqual([
        { scope_id: '', tags: '["b"]', created_at: 200 },
        { scope_id: 'A%2F42', tags: '["a"]', created_at: 100 },
      ]);
    });

    it('CSV: a row of that scope id is its duplicate', async () => {
      const brain = await open(tempFile(), 'csv-older');
      await new CsvImporter(brain).importFromString(csv('A%2F42'));
      await asOlderRelease(brain);
      expect((await new CsvImporter(brain).importFromString(csv('A%2F42'))).skipped).toBe(1);
      expect((await tracesOf(brain)).map((row) => row.scope_id)).toEqual(['A%2F42']);
    });

    it("Markdown: a file with that text is imported under ''", async () => {
      const brain = await open(tempFile(), 'markdown-older');
      await new JsonImporter(brain).importFromString(exportOf('A%2F42', 'Same words.', ['a'], 100));
      await asOlderRelease(brain);
      const dir = path.join(path.dirname(tempFile()), 'notes');
      await fsp.mkdir(dir);
      await fsp.writeFile(path.join(dir, 'same.md'), '---\nscope: user\n---\nSame words.\n', 'utf8');
      expect((await new MarkdownImporter(brain).import(dir)).imported).toBe(1);
      expect((await tracesOf(brain)).map((row) => row.scope_id)).toEqual(['', 'A%2F42']);
    });

    it("ChatGPT: a message with that text is imported under ''", async () => {
      const brain = await open(tempFile(), 'chatgpt-older');
      await new JsonImporter(brain).importFromString(exportOf('A%2F42', '[user]: Same words.', ['a'], 100));
      await asOlderRelease(brain);
      const filePath = path.join(path.dirname(tempFile()), 'conversations.json');
      const message = { author: { role: 'user' }, content: { parts: ['Same words.'] }, create_time: 1 };
      await fsp.writeFile(
        filePath,
        JSON.stringify([{ title: 'Same', create_time: 1, mapping: { m1: { id: 'm1', parent: null, children: [], message } } }]),
        'utf8',
      );
      expect((await new ChatGptImporter(brain).import(filePath)).imported).toBe(1);
      expect((await tracesOf(brain)).map((row) => row.scope_id)).toEqual(['', 'A%2F42']);
    });
  });
});
