/**
 * @file Brain.scope-id.test.ts
 * `memory_traces.scope_id`: the scope id of a trace as a column of its own. A Brain at schema version 2 gains the
 * column on open, filled from each row's metadata JSON (a malformed row stays ''), for every brain the file holds; a
 * row a release without the column writes to a brain already at version 3 is filled at the next open; a
 * fresh Brain has it; the index a per-scope read uses exists; every writer this file reaches sets it; and the importers
 * file by it and deduplicate inside one scope id. Real SQLite files through `@framers/sql-storage-adapter`, as the store
 * opens them in production.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveStorageAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { Brain } from '../Brain.js';
import { MemoryStore } from '../MemoryStore.js';
import { Memory } from '../../../io/facade/Memory.js';
import { MemoryAddTool } from '../../../io/tools/MemoryAddTool.js';
import { JsonImporter } from '../../../io/JsonImporter.js';
import { SqliteImporter } from '../../../io/SqliteImporter.js';
import { CsvImporter } from '../../../io/CsvImporter.js';
import { MarkdownImporter } from '../../../io/MarkdownImporter.js';
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

  it('CSV: the scope id comes from the metadata column, and dedup reads only that scope id', async () => {
    const brain = await open(tempFile(), 'csv');
    const csv = (scopeId: string) =>
      `content,scope,metadata\n"Same words.",user,"${JSON.stringify({ scopeId }).replace(/"/g, '""')}"\n`;
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
});
