import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Brain } from '../Brain.js';
import { MemoryStore } from '../MemoryStore.js';
import { MemorySearchTool } from '../../../io/tools/MemorySearchTool.js';
import type { ToolExecutionContext } from '../../../../../core/tools/ITool.js';
import { InMemoryVectorStore } from '../../../../rag/vector_stores/InMemoryVectorStore.js';
import type { IKnowledgeGraph } from '../../graph/knowledge/IKnowledgeGraph.js';
import type { IEmbeddingManager } from '../../../../../core/embeddings/IEmbeddingManager.js';
import type { MemoryTrace } from '../../../core/types.js';
import type { VectorStoreProviderConfig } from '../../../../../core/vector-store/IVectorStore.js';

// Full-text index coverage for traces written through MemoryStore.
//
// `memory_traces_fts` is an EXTERNAL-CONTENT FTS5 table with no triggers: it
// only indexes rows that a writer explicitly syncs. The Memory facade and
// MemoryAddTool sync every insert; `MemoryStore.store()` did not, so every
// brain written through the cognitive pipeline carried an empty full-text
// index. Lexical recall and MemorySearchTool then found nothing on those
// brains — a 2026-09-28 long-horizon companion probe missed a stored fact
// that ranks in the top four once the index is rebuilt.

class FixedEmbedder {
  async generateEmbeddings(input: { texts: string | string[] }) {
    const texts = Array.isArray(input.texts) ? input.texts : [input.texts];
    const vec = new Array(16).fill(0).map((_, i) => (i === 0 ? 1 : 0));
    return {
      embeddings: texts.map(() => vec.slice()),
      model: 'fixed',
      usage: { promptTokens: 0, totalTokens: 0 },
    };
  }
}

class NoopKG {
  async recordMemory() { return 'noop'; }
  async findRelatedMemories() { return []; }
  async findEntityRelationships() { return []; }
  async linkMemories() { /* no-op */ }
  async getEntityContext() { return { entities: [], memories: [], relationships: [] }; }
  async getMemoryById() { return null; }
  async updateMemory() { /* no-op */ }
  async removeMemory() { /* no-op */ }
}

function mkTrace(id: string, content: string): MemoryTrace {
  return {
    id, type: 'semantic', scope: 'user', scopeId: 'u1',
    content, entities: [], tags: ['stated-fact'],
    provenance: { sourceType: 'user_statement', sourceTimestamp: Date.now(), confidence: 1, verificationCount: 0 },
    emotionalContext: { valence: 0, arousal: 0, dominance: 0, intensity: 0, gmiMood: '' },
    encodingStrength: 0.5, stability: 0.5, retrievalCount: 0,
    lastAccessedAt: Date.now(), accessCount: 0, reinforcementInterval: 0,
    associatedTraceIds: [], createdAt: Date.now(), updatedAt: Date.now(), isActive: true,
  } as MemoryTrace;
}

async function mkStore(): Promise<MemoryStore> {
  const vectorStore = new InMemoryVectorStore();
  await vectorStore.initialize({
    id: 'brainfts-test', type: 'in_memory',
    defaultEmbeddingDimension: 16, similarityMetric: 'cosine',
  } as VectorStoreProviderConfig);
  return new MemoryStore({
    vectorStore,
    embeddingManager: new FixedEmbedder() as unknown as IEmbeddingManager,
    knowledgeGraph: new NoopKG() as unknown as IKnowledgeGraph,
    collectionPrefix: 'cogmem',
  });
}

/** SQL.js builds may ship without FTS5; the index is then absent by design. */
async function ftsAvailable(brain: Brain): Promise<boolean> {
  const row = await brain.get<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_traces_fts'",
  );
  return Boolean(row);
}

/** Ids of live traces whose indexed text matches `term`. */
async function ftsIds(brain: Brain, term: string): Promise<string[]> {
  const rows = await brain.all<{ id: string }>(
    `SELECT mt.id AS id
       FROM memory_traces_fts
       JOIN memory_traces mt ON mt.rowid = memory_traces_fts.rowid
      WHERE memory_traces_fts MATCH ? AND mt.deleted = 0`,
    [`"${term}"`],
  );
  return rows.map((row) => row.id);
}

/** A row written the way pre-fix brains were: durable, never FTS-synced. */
async function insertUnsyncedTrace(brain: Brain, id: string, content: string): Promise<void> {
  await brain.run(
    `INSERT INTO memory_traces
       (brain_id, id, type, scope, content, embedding, strength, created_at,
        last_accessed, retrieval_count, tags, emotions, metadata, deleted)
     VALUES (?, ?, 'semantic', 'user', ?, NULL, 0.5, ?, NULL, 0, '[]', '{}', '{}', 0)`,
    [brain.brainId, id, content, Date.now()],
  );
}

function tmpBrainPath(): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brainfts-'));
  return { dir, dbPath: path.join(dir, 'brain.sqlite') };
}

/** Index entries whose content row no longer exists (revival leftovers). */
async function orphanedIndexEntries(brain: Brain): Promise<number> {
  const row = await brain.get<{ n: number }>(
    'SELECT count(*) AS n FROM memory_traces_fts_docsize WHERE id NOT IN (SELECT rowid FROM memory_traces)',
  );
  return Number(row?.n ?? 0);
}

const toolContext: ToolExecutionContext = {
  gmiId: 'test-gmi',
  personaId: 'test-persona',
  userContext: { userId: 'default-user' } as any,
};

describe('MemoryStore — full-text index stays in step with durable writes', () => {
  it('a trace stored through MemoryStore is findable in the Brain full-text index', async (ctx) => {
    const { dir, dbPath } = tmpBrainPath();
    const brain = await Brain.openSqlite(dbPath);
    try {
      if (!(await ftsAvailable(brain))) ctx.skip();
      const store = await mkStore();
      store.setBrain(brain);
      await store.store(mkTrace('t-parakeet', 'When I was seven I had a parakeet named Silverpip.'));

      expect(await ftsIds(brain, 'parakeet')).toEqual(['t-parakeet']);
      expect(await ftsIds(brain, 'Silverpip')).toEqual(['t-parakeet']);
    } finally {
      await brain.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('store() inside a caller\'s brain transaction completes and indexes the trace', async (ctx) => {
    const { dir, dbPath } = tmpBrainPath();
    const brain = await Brain.openSqlite(dbPath);
    try {
      if (!(await ftsAvailable(brain))) ctx.skip();
      const store = await mkStore();
      store.setBrain(brain);
      // A nested brain.transaction() inside store() would queue behind this
      // outer transaction and never run; the test's timeout is the tripwire.
      await brain.transaction(async () => {
        await store.store(mkTrace('t-nested', 'The lighthouse lamp was called Emberwick.'));
      });
      expect(await ftsIds(brain, 'Emberwick')).toEqual(['t-nested']);
    } finally {
      await brain.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a revival with new content is findable by the new text only, and the next open clears the stale entry', async (ctx) => {
    const { dir, dbPath } = tmpBrainPath();
    let brain = await Brain.openSqlite(dbPath);
    try {
      if (!(await ftsAvailable(brain))) ctx.skip();
      const store = await mkStore();
      store.setBrain(brain);
      await store.store(mkTrace('t-revived', 'The street I grew up on was Thornquay Lane.'));
      await store.store(mkTrace('t-revived', 'My childhood parakeet was named Silverpip.'));

      expect(await ftsIds(brain, 'Silverpip')).toEqual(['t-revived']);
      expect(await ftsIds(brain, 'Thornquay')).toEqual([]);
      // INSERT OR REPLACE moved the row to a fresh rowid; the old rowid's
      // entry is left behind until the next open repairs it.
      expect(await orphanedIndexEntries(brain)).toBeGreaterThan(0);
      await brain.close();

      brain = await Brain.openSqlite(dbPath);
      expect(await orphanedIndexEntries(brain)).toBe(0);
      expect(await ftsIds(brain, 'Silverpip')).toEqual(['t-revived']);
    } finally {
      await brain.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('syncs the storing brain\'s own row when another brain shares the database and the trace id', async (ctx) => {
    const { dir, dbPath } = tmpBrainPath();
    const brain = await Brain.openSqlite(dbPath);
    try {
      if (!(await ftsAvailable(brain))) ctx.skip();
      // Another brain's row with the SAME trace id. It is written first (lower
      // rowid) AND its brain_id sorts before this brain's, so an id-only rowid
      // lookup picks it whether SQLite scans by rowid or by the
      // (brain_id, id) primary-key index.
      await brain.run(
        `INSERT INTO memory_traces
           (brain_id, id, type, scope, content, embedding, strength, created_at,
            last_accessed, retrieval_count, tags, emotions, metadata, deleted)
         VALUES ('aaa-other-brain', 'shared', 'semantic', 'user', 'bananas', NULL, 0.5, ?, NULL, 0, '[]', '{}', '{}', 0)`,
        [Date.now()],
      );
      const store = await mkStore();
      store.setBrain(brain);
      await store.store(mkTrace('shared', 'apples from the orchard'));

      const owners = await brain.all<{ brain_id: string }>(
        `SELECT mt.brain_id AS brain_id
           FROM memory_traces_fts
           JOIN memory_traces mt ON mt.rowid = memory_traces_fts.rowid
          WHERE memory_traces_fts MATCH ? AND mt.deleted = 0`,
        ['"apples"'],
      );
      expect(owners.map((row) => row.brain_id)).toEqual([brain.brainId]);
    } finally {
      await brain.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Brain — full-text index repair on open and after import', () => {
  it('reopening a brain rebuilds rows the index never saw, on every open that finds a gap', async (ctx) => {
    const { dir, dbPath } = tmpBrainPath();
    let brain = await Brain.openSqlite(dbPath);
    try {
      if (!(await ftsAvailable(brain))) ctx.skip();
      // A row written the way pre-fix brains were: durable, never indexed.
      await insertUnsyncedTrace(brain, 'legacy-1', 'The street I grew up on was Thornquay Lane.');
      expect(await ftsIds(brain, 'Thornquay')).toEqual([]);
      await brain.close();

      brain = await Brain.openSqlite(dbPath);
      expect(await ftsIds(brain, 'Thornquay')).toEqual(['legacy-1']);

      // Not a one-shot: a later gap is found and repaired on the next open.
      await insertUnsyncedTrace(brain, 'legacy-2', 'I had a parakeet named Silverpip.');
      await brain.close();
      brain = await Brain.openSqlite(dbPath);
      expect(await ftsIds(brain, 'Silverpip')).toEqual(['legacy-2']);
    } finally {
      await brain.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rowid sets that agree in count and in total are still compared exactly and repaired', async (ctx) => {
    const { dir, dbPath } = tmpBrainPath();
    let brain = await Brain.openSqlite(dbPath);
    try {
      if (!(await ftsAvailable(brain))) ctx.skip();
      const store = await mkStore();
      store.setBrain(brain);
      // Fresh table, so rowids follow insertion order.
      await store.store(mkTrace('t1', 'firstword appears here')); // rowid 1, indexed
      await insertUnsyncedTrace(brain, 't2', 'lostword appears here'); // rowid 2, missed
      await insertUnsyncedTrace(brain, 't3', 'strayword appears here'); // rowid 3, missed
      await store.store(mkTrace('t4', 'fourthword appears here')); // rowid 4, indexed
      await store.store(mkTrace('t1', 'firstword revived here')); // -> rowid 5; entry 1 left behind
      await store.store(mkTrace('t4', 'fourthword revived here')); // -> rowid 6; entry 4 left behind
      // Content rowids {2,3,5,6} vs index ids {1,4,5,6}: equal count (4) and
      // equal total (16), different sets.
      const sets = await brain.get<{ trace_rows: number; indexed_docs: number; rowid_total: number; id_total: number }>(
        `SELECT (SELECT count(*) FROM memory_traces) AS trace_rows,
                (SELECT count(*) FROM memory_traces_fts_docsize) AS indexed_docs,
                (SELECT total(rowid) FROM memory_traces) AS rowid_total,
                (SELECT total(id) FROM memory_traces_fts_docsize) AS id_total`,
      );
      expect(Number(sets?.trace_rows)).toBe(Number(sets?.indexed_docs));
      expect(Number(sets?.rowid_total)).toBe(Number(sets?.id_total));
      await brain.close();

      brain = await Brain.openSqlite(dbPath);
      expect(await ftsIds(brain, 'lostword')).toEqual(['t2']);
      expect(await ftsIds(brain, 'strayword')).toEqual(['t3']);
      expect(await orphanedIndexEntries(brain)).toBe(0);
    } finally {
      await brain.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a trace stored while the index was unavailable is indexed on the next open', async (ctx) => {
    const { dir, dbPath } = tmpBrainPath();
    let brain = await Brain.openSqlite(dbPath);
    try {
      if (!(await ftsAvailable(brain))) ctx.skip();
      // Take the index away: the sync inside store() is skipped, the durable
      // write still lands.
      await brain.exec('DROP TABLE memory_traces_fts');
      const store = await mkStore();
      store.setBrain(brain);
      await store.store(mkTrace('t-missed', 'The ferry I take is called the Vastrelle.'));
      await brain.close();

      // Open recreates the (empty) index and repairs the gap.
      brain = await Brain.openSqlite(dbPath);
      expect(await ftsIds(brain, 'Vastrelle')).toEqual(['t-missed']);
    } finally {
      await brain.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Brain.importFromSqlite — the imported traces are searchable', () => {
  it('a replace import leaves the index matching the imported traces, with no stale postings', async (ctx) => {
    const src = tmpBrainPath();
    const dst = tmpBrainPath();
    const source = await Brain.openSqlite(src.dbPath);
    let sourceOpen = true;
    let target: Brain | null = null;
    try {
      if (!(await ftsAvailable(source))) ctx.skip();
      const sourceStore = await mkStore();
      sourceStore.setBrain(source);
      await sourceStore.store(mkTrace('t-imported', 'My childhood parakeet was named Silverpip.'));
      await source.close();
      sourceOpen = false;

      target = await Brain.openSqlite(dst.dbPath);
      const targetStore = await mkStore();
      targetStore.setBrain(target);
      await targetStore.store(mkTrace('t-local', 'The street I grew up on was Thornquay Lane.'));

      await target.importFromSqlite(src.dbPath, { strategy: 'replace' });

      // Searchable right after the import, without a reopen.
      expect(await ftsIds(target, 'Silverpip')).toEqual(['t-imported']);
      expect(await ftsIds(target, 'Thornquay')).toEqual([]);
      expect(await orphanedIndexEntries(target)).toBe(0);
    } finally {
      if (sourceOpen) await source.close();
      await target?.close();
      fs.rmSync(src.dir, { recursive: true, force: true });
      fs.rmSync(dst.dir, { recursive: true, force: true });
    }
  });
});

describe('MemorySearchTool — reads only its own brain when brains share a database', () => {
  it('a brain cannot find another brain\'s trace through the shared full-text index', async (ctx) => {
    const { dir, dbPath } = tmpBrainPath();
    const brainA = await Brain.openSqlite(dbPath, { brainId: 'brain-a' });
    const brainB = await Brain.openSqlite(dbPath, { brainId: 'brain-b' });
    try {
      if (!(await ftsAvailable(brainA))) ctx.skip();
      const storeA = await mkStore();
      storeA.setBrain(brainA);
      await storeA.store(mkTrace('t-private', 'The ferry I take is called the Vastrelle.'));

      const fromA = await new MemorySearchTool(brainA).execute({ query: 'Vastrelle' }, toolContext);
      const fromB = await new MemorySearchTool(brainB).execute({ query: 'Vastrelle' }, toolContext);
      const ids = (result: typeof fromA) =>
        ((result.output as { results?: Array<{ id: string }> } | undefined)?.results ?? []).map((row) => row.id);
      expect(ids(fromA)).toEqual(['t-private']);
      expect(ids(fromB)).toEqual([]);
    } finally {
      await brainA.close();
      await brainB.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
