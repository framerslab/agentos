/**
 * @file scopeIdForm.test.ts
 * The written form of a plain id in a `user` or `persona` scope id where a learning layer exists: an id that holds a
 * `/`, a `%` or a `:` is percent-encoded (a lone surrogate as `%u` and four hexadecimal digits), every other id keeps
 * its form; and the one-time re-file of a Brain's plain ids, with its `brain_meta` record. Real SQLite Brains, and the
 * real manager over one, as a layer opens them; and, where AGENTOS_TEST_POSTGRES_URL is set, two Postgres handles
 * that re-file one brain at once. A re-file keeps a write made meanwhile, takes the rows an older release filed since
 * the open and the knowledge graph's copies with it, and leaves no trace or document under the plain id that another
 * store, opener or process held: once the record is written, the plain id `team/ana` names user `ana` of namespace
 * `team`, and a delete of her scope through a store that has not followed the re-file leaves the plain user's traces.
 * An import takes its source's form from the source's own record (a JSON export's `meta`, a SQLite file's
 * `brain_meta`, the mark an encoded Brain's Markdown export puts on each note): a plain source (a CSV or Markdown file
 * included) is encoded as it is written into a re-filed Brain, a trace's knowledge-graph copy with it, and a source
 * with the record goes into a plain Brain only when that Brain holds no plain id the record would read as another,
 * in a trace or in a graph copy (a persona id read part by part, so the `::` between its two ids is not one). An import
 * reads the target's form inside the transaction it writes in, so two imports into one Brain at once, and, on
 * Postgres, an import and another process's re-file, follow one another. An export, and an import of a SQLite file,
 * read a record and the rows it describes in one form, whenever a re-file commits.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BetterSqliteAdapter, type StorageParameters } from '@framers/sql-storage-adapter';
import { Brain } from '../Brain.js';
import {
  encodePlainScopeId,
  encodeScopeIdPart,
  holdsReservedCharacter,
  refileBrainScopeIds,
  SCOPE_ID_FORM_KEY,
} from '../scopeIdForm.js';
import { SqlKnowledgeGraph } from '../SqlKnowledgeGraph.js';
import { JsonExporter } from '../../../io/JsonExporter.js';
import { JsonImporter } from '../../../io/JsonImporter.js';
import { SqliteImporter } from '../../../io/SqliteImporter.js';
import { MarkdownExporter } from '../../../io/MarkdownExporter.js';
import { MarkdownImporter } from '../../../io/MarkdownImporter.js';
import { CsvImporter } from '../../../io/CsvImporter.js';
import type { ImportResult } from '../../../io/facade/types.js';
import { readFrontMatter } from '../../../../../core/utils/frontMatter.js';
import { CognitiveMemoryManager } from '../../../CognitiveMemoryManager.js';
import { KnowledgeGraph } from '../../graph/knowledge/KnowledgeGraph.js';
import { InMemoryVectorStore } from '../../../../rag/vector_stores/InMemoryVectorStore.js';
import { InMemoryWorkingMemory } from '../../../../substrate/memory/InMemoryWorkingMemory.js';

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-id-form-'));
  dirs.push(dir);
  return path.join(dir, 'brain.sqlite');
}

async function brainAt(filePath: string, brainId = 'b'): Promise<Brain> {
  const brain = await Brain.openSqlite(filePath, { brainId });
  closers.push(() => brain.close());
  return brain;
}

/** Files a row as a release before the layer did: the scope id in the column and in the metadata JSON. */
async function plainRow(brain: Brain, id: string, scope: string, scopeId: string): Promise<void> {
  await brain.run(
    `INSERT INTO memory_traces (brain_id, id, type, scope, content, created_at, metadata, scope_id)
     VALUES (?, ?, 'episodic', ?, ?, 1, ?, ?)`,
    [brain.brainId, id, scope, `content of ${id}`, JSON.stringify({ scopeId }), scopeId],
  );
}

const filed = async (brain: Brain) =>
  (await brain.all<{ id: string; scope_id: string; metadata: string }>('SELECT id, scope_id, metadata FROM memory_traces ORDER BY id'))
    .map((row) => [row.id, row.scope_id, JSON.parse(row.metadata).scopeId]);

const MOOD = { valence: 0, arousal: 0, dominance: 0 };
const BEES = 'Ana keeps bees on the roof.';

async function newIndex(): Promise<InMemoryVectorStore> {
  const index = new InMemoryVectorStore();
  await index.initialize({ id: `refile-${Math.random()}`, type: 'in_memory' });
  return index;
}

/**
 * A manager over the brain `agent` of a file, as a layer opens one, with an in-memory knowledge graph, and an index of
 * its own unless one is given: an index handed to several managers stands for one a host keeps across restarts.
 */
async function openManager(
  filePath: string,
  index?: InMemoryVectorStore,
): Promise<{ manager: CognitiveMemoryManager; brain: Brain }> {
  const brain = await Brain.openSqlite(filePath, { brainId: 'agent' });
  const vectorStore = index ?? (await newIndex());
  const manager = new CognitiveMemoryManager();
  await manager.initialize({
    agentId: 'agent',
    traits: { openness: 0.5, conscientiousness: 0.5, extraversion: 0.5, agreeableness: 0.5, emotionality: 0.5, honesty: 0.5 },
    moodProvider: () => MOOD,
    featureDetectionStrategy: 'keyword',
    workingMemory: new InMemoryWorkingMemory(),
    knowledgeGraph: new KnowledgeGraph(),
    vectorStore,
    embeddingManager: {
      generateEmbeddings: async ({ texts }: { texts: string | string[] }) => ({
        embeddings: (Array.isArray(texts) ? texts : [texts]).map(() => [1, 0, 0, 0]),
      }),
    },
    encoding: { baseStrength: 0.5, flashbulbThreshold: 0.8, flashbulbStrengthMultiplier: 2, flashbulbStabilityMultiplier: 5, baseStabilityMs: 3_600_000 },
    brain,
  } as never);
  closers.push(async () => {
    await manager.shutdown();
    await brain.close();
  });
  return { manager, brain };
}

/** What a reader of one `user` scope id recalls. */
const recallUnder = async (manager: CognitiveMemoryManager, scopeId: string): Promise<string[]> =>
  (await manager.retrieve('bees on the roof', MOOD, { scopes: [{ scope: 'user', scopeId }] } as never)).retrieved.map(
    (trace) => trace.content,
  );

/** The texts an index holds in one collection: none when it holds no such collection. */
async function textsIn(index: InMemoryVectorStore, collection: string): Promise<string[]> {
  if (!(await index.collectionExists(collection))) return [];
  const scanned = await index.scanByMetadata(collection, { includeTextContent: true });
  return scanned.documents.map((document) => document.textContent ?? '');
}

/**
 * A trace an earlier process filed under the plain id `team/ana`, into the Brain and into an index this process keeps:
 * its row holds no vector (a release before rows kept their vectors wrote it), so no hydration loads it, and this
 * process holds it only as the index's document.
 */
async function fileUnheldTrace(filePath: string, index: InMemoryVectorStore): Promise<void> {
  const earlier = await openManager(filePath, index);
  await earlier.manager.encode(BEES, MOOD, 'neutral', { scope: 'user', scopeId: 'team/ana' });
  await closers.pop()!();
  const handle = await Brain.openSqlite(filePath, { brainId: 'agent' });
  await handle.run('UPDATE memory_traces SET embedding = NULL WHERE brain_id = ?', [handle.brainId]);
  await handle.close();
}

describe('the written form of a plain id', () => {
  it('percent-encodes an id that holds a slash, a percent sign or a colon, and keeps every other id', () => {
    expect(encodePlainScopeId('user', 'team/ana')).toBe('team%2Fana');
    expect(encodePlainScopeId('user', 'a%2Fb')).toBe('a%252Fb');
    expect(encodePlainScopeId('user', 'a:b')).toBe('a%3Ab');
    expect(encodePlainScopeId('user', 'ana')).toBe('ana');
    expect(encodePlainScopeId('user', 'ana maria')).toBe('ana maria');
    expect(encodePlainScopeId('thread', 'team/ana')).toBe('team/ana');
    expect(holdsReservedCharacter('ana')).toBe(false);
  });

  it('splits a persona composite at its last :: and encodes each part', () => {
    expect(encodePlainScopeId('persona', 'team/ana::tutor')).toBe('team%2Fana::tutor');
    expect(encodePlainScopeId('persona', 'a:::x')).toBe('a%3A::x');
    expect(encodePlainScopeId('persona', 'ana::tu/tor')).toBe('ana::tu%2Ftor');
  });

  it('writes a lone surrogate as %u and four hexadecimal digits, and never throws', () => {
    expect(encodeScopeIdPart('a\uD800b')).toBe('a%uD800b');
    expect(encodeScopeIdPart('\uDC0F')).toBe('%uDC0F');
    expect(encodeScopeIdPart('😀/')).toBe('%F0%9F%98%80%2F');
    expect(encodeScopeIdPart('%uD800')).toBe('%25uD800');
  });
});

describe('refileBrainScopeIds', () => {
  it('re-files the user and persona ids that hold a reserved character, once, and writes the record', async () => {
    const brain = await brainAt(tempFile());
    await plainRow(brain, 't-1', 'user', 'team/ana');
    await plainRow(brain, 't-2', 'persona', 'team/ana::tutor');
    await plainRow(brain, 't-3', 'user', 'ana');
    await plainRow(brain, 't-4', 'thread', 'conv/7');
    await plainRow(brain, 't-5', 'persona', 'a:b::x');

    const first = await refileBrainScopeIds(brain);

    expect(first.alreadyEncoded).toBe(false);
    expect(first.moved).toEqual([
      { scope: 'persona', from: 'a:b::x', to: 'a%3Ab::x', traces: 1 },
      { scope: 'persona', from: 'team/ana::tutor', to: 'team%2Fana::tutor', traces: 1 },
      { scope: 'user', from: 'team/ana', to: 'team%2Fana', traces: 1 },
    ]);
    expect(await filed(brain)).toEqual([
      ['t-1', 'team%2Fana', 'team%2Fana'],
      ['t-2', 'team%2Fana::tutor', 'team%2Fana::tutor'],
      ['t-3', 'ana', 'ana'],
      ['t-4', 'conv/7', 'conv/7'],
      ['t-5', 'a%3Ab::x', 'a%3Ab::x'],
    ]);
    expect(await brain.getMeta(SCOPE_ID_FORM_KEY)).toBe('encoded');
    expect(await refileBrainScopeIds(brain)).toEqual({ alreadyEncoded: true, moved: [] });
  });

  it('writes the record on a Brain that holds nothing, and keeps another brain of the file as it is', async () => {
    const filePath = tempFile();
    const other = await brainAt(filePath, 'other');
    await plainRow(other, 't-o', 'user', 'team/bo');
    const empty = await brainAt(filePath, 'empty');
    expect(await refileBrainScopeIds(empty)).toEqual({ alreadyEncoded: false, moved: [] });
    expect(await empty.getMeta(SCOPE_ID_FORM_KEY)).toBe('encoded');
    expect(await other.getMeta(SCOPE_ID_FORM_KEY)).toBeUndefined();
    expect(await filed(other)).toEqual([['t-o', 'team/bo', 'team/bo']]);
  });

  it('re-files a row a release older than the column filed since the open, which holds no scope_id yet', async () => {
    const brain = await brainAt(tempFile());
    await brain.run(
      `INSERT INTO memory_traces (brain_id, id, type, scope, content, created_at, metadata)
       VALUES (?, 't-old', 'episodic', 'user', 'content of t-old', 1, ?)`,
      [brain.brainId, JSON.stringify({ scopeId: 'team/ana' })],
    );

    expect(await refileBrainScopeIds(brain)).toEqual({
      alreadyEncoded: false,
      moved: [{ scope: 'user', from: 'team/ana', to: 'team%2Fana', traces: 1 }],
    });
    expect(await filed(brain)).toEqual([['t-old', 'team%2Fana', 'team%2Fana']]);
  });

  it('re-files a trace whose id is the empty string, as the JSON importer keeps one', async () => {
    const brain = await brainAt(tempFile());
    await plainRow(brain, '', 'user', 'team/ana');
    await plainRow(brain, 't-1', 'user', 'team/bo');

    await refileBrainScopeIds(brain);

    expect(await filed(brain)).toEqual([
      ['', 'team%2Fana', 'team%2Fana'],
      ['t-1', 'team%2Fbo', 'team%2Fbo'],
    ]);
  });

  it('re-files once, and fails neither, when two handles on one file in this process re-file it together', async () => {
    const filePath = tempFile();
    const one = await brainAt(filePath);
    const two = await brainAt(filePath);
    for (const i of [1, 2, 3]) await plainRow(one, `t-${i}`, 'user', `team/u${i}`);

    const results = await Promise.all([refileBrainScopeIds(one), refileBrainScopeIds(two)]);

    expect(results.map((result) => result.alreadyEncoded).sort()).toEqual([false, true]);
    expect((await filed(one)).map(([, scopeId]) => scopeId)).toEqual(['team%2Fu1', 'team%2Fu2', 'team%2Fu3']);
  });

  it("re-files the brain's knowledge-graph copies with its traces, a copy whose trace is gone included", async () => {
    const brain = await brainAt(tempFile());
    const graph = new SqlKnowledgeGraph(brain);
    await graph.initialize();
    const copy = (traceId: string, scopeId: string) =>
      graph.recordMemory({
        type: 'conversation',
        summary: `content of ${traceId}`,
        participants: [scopeId],
        importance: 0.5,
        entityIds: [],
        occurredAt: new Date(1).toISOString(),
        outcome: 'unknown',
        context: { memoryTraceId: traceId, scope: 'user', scopeId, type: 'episodic' },
      });
    await plainRow(brain, 't-1', 'user', 'team/ana');
    await copy('t-1', 'team/ana');
    // The copy of a trace a release before keyed copies deleted, which a delete of its scope takes.
    await copy('t-gone', 'team/ana');
    await copy('t-bo', 'bo');

    await refileBrainScopeIds(brain);

    const copies = await brain.all<{ id: string; properties: string }>(
      `SELECT id, properties FROM knowledge_nodes WHERE brain_id = ? AND type = 'memory' ORDER BY id`,
      [brain.brainId],
    );
    expect(
      copies.map(({ id, properties }) => {
        const stored = JSON.parse(properties);
        return [id, stored._context.scopeId, stored._participants];
      }),
    ).toEqual([
      ['trace:t-1', 'team%2Fana', ['team%2Fana']],
      ['trace:t-bo', 'bo', ['bo']],
      ['trace:t-gone', 'team%2Fana', ['team%2Fana']],
    ]);
    // A delete of user `ana` of namespace `team` takes none of them; a delete of the encoded id takes both.
    expect(await graph.deleteMemories({ scopes: [{ scope: 'user', scopeId: 'team/ana' }] })).toBe(0);
    expect(await graph.deleteMemories({ scopes: [{ scope: 'user', scopeId: 'team%2Fana' }] })).toBe(2);
  });
});

const POSTGRES_URL = process.env.AGENTOS_TEST_POSTGRES_URL;
const describeIfPostgres = POSTGRES_URL ? describe : describe.skip;

describeIfPostgres('refileBrainScopeIds on Postgres', () => {
  it('re-files a brain once when two processes first open it together', async () => {
    const brainId = `test-refile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const one = await Brain.openPostgres(POSTGRES_URL!, { brainId });
    const two = await Brain.openPostgres(POSTGRES_URL!, { brainId });
    closers.push(async () => {
      await one.run('DELETE FROM memory_traces WHERE brain_id = ?', [brainId]);
      await one.run('DELETE FROM brain_meta WHERE brain_id = ?', [brainId]);
      await two.close();
      await one.close();
    });
    // Three pages of plain ids that hold a slash.
    for (let i = 0; i < 1_200; i += 1) await plainRow(one, `t-${String(i).padStart(4, '0')}`, 'user', `team/u${i}`);

    const results = await Promise.all([refileBrainScopeIds(one), refileBrainScopeIds(two)]);

    expect(results.map((result) => result.alreadyEncoded).sort()).toEqual([false, true]);
    const ids = (await one.all<{ scope_id: string }>('SELECT scope_id FROM memory_traces WHERE brain_id = ?', [brainId])).map((row) => row.scope_id);
    expect(ids).toHaveLength(1_200);
    expect(ids.filter((id) => !/^team%2Fu\d+$/.test(id))).toEqual([]);
  });

  it('keeps a metadata write another process commits while the re-file waits on its row', async () => {
    const brainId = `test-refile-cas-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const one = await Brain.openPostgres(POSTGRES_URL!, { brainId });
    const two = await Brain.openPostgres(POSTGRES_URL!, { brainId });
    closers.push(async () => {
      await one.run('DELETE FROM memory_traces WHERE brain_id = ?', [brainId]);
      await one.run('DELETE FROM brain_meta WHERE brain_id = ?', [brainId]);
      await two.close();
      await one.close();
    });
    await plainRow(one, 't-1', 'user', 'team/ana');

    // Process two writes the row's metadata in a transaction it holds open until the re-file waits on the row.
    let commit!: () => void;
    const committing = new Promise<void>((resolve) => (commit = resolve));
    let writerStarted!: (pid: number) => void;
    const writerPid = new Promise<number>((resolve) => (writerStarted = resolve));
    const writer = two.transaction(async (trx) => {
      await trx.run('UPDATE memory_traces SET metadata = ? WHERE brain_id = ? AND id = ?', [
        JSON.stringify({ scopeId: 'team/ana', note: 'kept' }),
        brainId,
        't-1',
      ]);
      writerStarted((await trx.get<{ pid: number }>('SELECT pg_backend_pid() AS pid'))!.pid);
      await committing;
    });
    const pid = await writerPid;
    const refiling = refileBrainScopeIds(one);
    try {
      // The re-file read the row before the write committed, and its update waits on the writer's lock.
      await vi.waitFor(
        async () => {
          const blocked = await one.get<{ count: number }>(
            'SELECT count(*)::int AS count FROM pg_stat_activity WHERE ? = ANY(pg_blocking_pids(pid))',
            [pid],
          );
          expect(blocked?.count).toBe(1);
        },
        { timeout: 10_000, interval: 20 },
      );
    } finally {
      commit();
    }
    await writer;
    await refiling;

    const row = await one.get<{ scope_id: string; metadata: string }>(
      'SELECT scope_id, metadata FROM memory_traces WHERE brain_id = ? AND id = ?',
      [brainId, 't-1'],
    );
    expect(row?.scope_id).toBe('team%2Fana');
    expect(JSON.parse(row!.metadata)).toEqual({ scopeId: 'team%2Fana', note: 'kept' });
  });
});

describe("a manager's re-file", () => {
  it('moves a cached trace too, so the encoded id recalls it in this process and after a restart', async () => {
    const MOOD = { valence: 0, arousal: 0, dominance: 0 };
    const filePath = tempFile();
    const open = async () => {
      const brain = await Brain.openSqlite(filePath, { brainId: 'agent' });
      const vectorStore = new InMemoryVectorStore();
      await vectorStore.initialize({ id: `refile-${Math.random()}`, type: 'in_memory' });
      const manager = new CognitiveMemoryManager();
      await manager.initialize({
        agentId: 'agent',
        traits: { openness: 0.5, conscientiousness: 0.5, extraversion: 0.5, agreeableness: 0.5, emotionality: 0.5, honesty: 0.5 },
        moodProvider: () => MOOD,
        featureDetectionStrategy: 'keyword',
        workingMemory: new InMemoryWorkingMemory(),
        knowledgeGraph: new KnowledgeGraph(),
        vectorStore,
        embeddingManager: {
          generateEmbeddings: async ({ texts }: { texts: string | string[] }) => ({
            embeddings: (Array.isArray(texts) ? texts : [texts]).map(() => [1, 0, 0, 0]),
          }),
        },
        encoding: { baseStrength: 0.5, flashbulbThreshold: 0.8, flashbulbStrengthMultiplier: 2, flashbulbStabilityMultiplier: 5, baseStabilityMs: 3_600_000 },
        brain,
      } as never);
      closers.push(async () => {
        await manager.shutdown();
        await brain.close();
      });
      return manager;
    };
    const manager = await open();
    await manager.encode('Ana keeps bees on the roof.', MOOD, 'neutral', { scope: 'user', scopeId: 'team/ana' });

    expect(await manager.ensureEncodedScopeIds()).toBe(1);

    const recall = async (m: CognitiveMemoryManager, scopeId: string) =>
      (await m.retrieve('bees on the roof', MOOD, { scopes: [{ scope: 'user', scopeId }] } as never)).retrieved.map((t) => t.content);
    expect(await recall(manager, 'team%2Fana')).toEqual(['Ana keeps bees on the roof.']);
    expect(await recall(manager, 'team/ana')).toEqual([]);
    await closers.pop()!();
    const restarted = await open();
    expect(await restarted.ensureEncodedScopeIds()).toBe(0);
    expect(await recall(restarted, 'team%2Fana')).toEqual(['Ana keeps bees on the roof.']);
  });

  it('moves only the traces the re-file moved, never a row filed under the old id after it', async () => {
    const { manager, brain } = await openManager(tempFile());
    await manager.encode(BEES, MOOD, 'neutral', { scope: 'user', scopeId: 'team/ana' });
    // Another process's learner, user `ana` of namespace `team`, files under `team/ana` right after the re-file
    // commits, before this store moves what it holds.
    const runTransaction = brain.transaction.bind(brain);
    let learnerFiled = false;
    Object.assign(brain, {
      transaction: async (fn: Parameters<Brain['transaction']>[0]) => {
        const result = await runTransaction(fn);
        if (!learnerFiled) {
          learnerFiled = true;
          await plainRow(brain, 't-learner', 'user', 'team/ana');
        }
        return result;
      },
    });

    expect(await manager.ensureEncodedScopeIds()).toBe(1);

    expect((await filed(brain)).find(([id]) => id === 't-learner')).toEqual(['t-learner', 'team/ana', 'team/ana']);
    expect(await recallUnder(manager, 'team%2Fana')).toEqual([BEES]);
  });

  it('follows the Brain when another process re-filed it first, and reads nothing under the old id meanwhile', async () => {
    const filePath = tempFile();
    const { manager } = await openManager(filePath);
    const trace = await manager.encode(BEES, MOOD, 'neutral', { scope: 'user', scopeId: 'team/ana' });
    const otherProcess = await Brain.openSqlite(filePath, { brainId: 'agent', coordinationToken: {} });
    closers.push(() => otherProcess.close());
    expect((await refileBrainScopeIds(otherProcess)).moved).toEqual([
      { scope: 'user', from: 'team/ana', to: 'team%2Fana', traces: 1 },
    ]);

    // Before this process follows, what it holds under the old id is not read there: its row is filed elsewhere.
    expect(await recallUnder(manager, 'team/ana')).toEqual([]);
    expect(await manager.getStore().filterRecallableTraceIds([trace.id], [{ scope: 'user', scopeId: 'team/ana' }])).toEqual(
      new Set(),
    );

    expect(await manager.ensureEncodedScopeIds()).toBe(0);
    expect(await recallUnder(manager, 'team%2Fana')).toEqual([BEES]);
    expect(await recallUnder(manager, 'team/ana')).toEqual([]);
  });

  it("deletes none of the plain user's traces it holds under the old id when the namespaced user's scope is deleted", async () => {
    const filePath = tempFile();
    const { manager, brain } = await openManager(filePath);
    const plainUser = await manager.encode(BEES, MOOD, 'neutral', { scope: 'user', scopeId: 'team/ana' });
    // Another process re-files the Brain, and its learner, user `ana` of namespace `team`, files under `team/ana`.
    const otherProcess = await Brain.openSqlite(filePath, { brainId: 'agent', coordinationToken: {} });
    closers.push(() => otherProcess.close());
    await refileBrainScopeIds(otherProcess);
    await plainRow(otherProcess, 't-learner', 'user', 'team/ana');

    // Her account is deleted through this process's manager before it follows the re-file.
    expect((await manager.deleteScope('user', 'team/ana')).deleted).toBe(1);

    expect(await brain.all('SELECT id, scope_id FROM memory_traces WHERE brain_id = ?', [brain.brainId])).toEqual([
      { id: plainUser.id, scope_id: 'team%2Fana' },
    ]);
    expect(await manager.ensureEncodedScopeIds()).toBe(0);
    expect(await recallUnder(manager, 'team%2Fana')).toEqual([BEES]);
  });

  it('loads under the encoded id the rows a hydration read before the re-file', async () => {
    const filePath = tempFile();
    // Filed by an earlier process: this one holds none of it until it hydrates.
    const earlier = await openManager(filePath);
    await earlier.manager.encode(BEES, MOOD, 'neutral', { scope: 'user', scopeId: 'team/ana' });
    await closers.pop()!();
    const { manager, brain } = await openManager(filePath);
    // The first recall's hydration reads the Brain's rows, then waits for the re-file to commit before it loads them.
    let hydrationRead!: () => void;
    const read = new Promise<void>((resolve) => (hydrationRead = resolve));
    let releaseHydration!: () => void;
    const released = new Promise<void>((resolve) => (releaseHydration = resolve));
    const readAll = brain.all.bind(brain);
    Object.assign(brain, {
      all: async (sql: string, params?: Parameters<Brain['all']>[1]) => {
        const rows = await readAll(sql, params);
        if (/deleted = 0\s+ORDER BY created_at DESC/.test(sql) && !/scope_id = \?/.test(sql)) {
          hydrationRead();
          await released;
        }
        return rows;
      },
    });
    const firstRecall = recallUnder(manager, 'team%2Fana');
    await read;

    const refiled = manager.ensureEncodedScopeIds();
    try {
      await vi.waitFor(async () => expect(await brain.getMeta(SCOPE_ID_FORM_KEY)).toBe('encoded'), {
        timeout: 10_000,
        interval: 10,
      });
    } finally {
      releaseHydration();
    }
    expect(await refiled).toBe(1);
    await firstRecall;

    expect(await recallUnder(manager, 'team%2Fana')).toEqual([BEES]);
    expect(await recallUnder(manager, 'team/ana')).toEqual([]);
  });

  it('drops from the old collection the document of a trace it does not hold when another opener re-files the Brain', async () => {
    const filePath = tempFile();
    const index = await newIndex();
    await fileUnheldTrace(filePath, index);
    expect(await textsIn(index, 'cogmem_user_team/ana')).toEqual([BEES]);
    const facadeHandle = await brainAt(filePath, 'agent');
    const { manager } = await openManager(filePath, index);

    // The layer re-files the facade's handle on the Brain first; the manager's store follows what that moved.
    await refileBrainScopeIds(facadeHandle);

    expect(await textsIn(index, 'cogmem_user_team/ana')).toEqual([]);
    expect(await manager.ensureEncodedScopeIds()).toBe(0);
  });

  it('never recalls a document under a scope id its Brain row is no longer filed under', async () => {
    const filePath = tempFile();
    const index = await newIndex();
    await fileUnheldTrace(filePath, index);
    const { manager } = await openManager(filePath, index);
    const otherProcess = await Brain.openSqlite(filePath, { brainId: 'agent', coordinationToken: {} });
    closers.push(() => otherProcess.close());
    await refileBrainScopeIds(otherProcess);
    expect(await manager.ensureEncodedScopeIds()).toBe(0);

    // User `ana` of namespace `team` reads `team/ana`: the plain user's words are not hers.
    expect(await recallUnder(manager, 'team/ana')).toEqual([]);
    // The read deletes the stale document from the collection.
    expect(await textsIn(index, 'cogmem_user_team/ana')).toEqual([]);
  });

  it("lists none of a collection's documents whose Brain rows are filed under another scope id", async () => {
    const filePath = tempFile();
    const index = await newIndex();
    await fileUnheldTrace(filePath, index);
    const { manager } = await openManager(filePath, index);
    const otherProcess = await Brain.openSqlite(filePath, { brainId: 'agent', coordinationToken: {} });
    closers.push(() => otherProcess.close());
    await refileBrainScopeIds(otherProcess);

    expect(await manager.getStore().getByScope('user', 'team/ana')).toEqual([]);
    expect(await textsIn(index, 'cogmem_user_team/ana')).toEqual([]);
  });
});

const scopeIdsOf = async (brain: Brain) =>
  (await brain.all<{ scope: string; scope_id: string }>('SELECT scope, scope_id FROM memory_traces WHERE deleted = 0 ORDER BY scope, scope_id'))
    .map((row) => `${row.scope}:${row.scope_id}`);

async function encodedBrain(filePath: string, brainId: string): Promise<Brain> {
  const brain = await brainAt(filePath, brainId);
  await refileBrainScopeIds(brain);
  return brain;
}

describe('an import takes its source form from its record', () => {
  it('JSON: an export of an encoded Brain is taken into a fresh Brain with its record', async () => {
    const source = await encodedBrain(tempFile(), 'src');
    await plainRow(source, 't-a', 'user', 'A/42');
    const target = await brainAt(tempFile(), 'dst');
    const result = await new JsonImporter(target).importFromString(await new JsonExporter(source).exportToString());
    expect(result.errors).toEqual([]);
    expect(await scopeIdsOf(target)).toEqual(['user:A/42']);
    expect(await target.getMeta(SCOPE_ID_FORM_KEY)).toBe('encoded');
  });

  it('JSON: an export from before the layer is encoded as it is written into a re-filed Brain', async () => {
    const source = await brainAt(tempFile(), 'src');
    await plainRow(source, 't-a', 'user', 'team/ana');
    await plainRow(source, 't-p', 'persona', 'team/ana::tutor');
    const target = await encodedBrain(tempFile(), 'dst');
    const result = await new JsonImporter(target).importFromString(await new JsonExporter(source).exportToString());
    expect(result.errors).toEqual([]);
    expect(await scopeIdsOf(target)).toEqual(['persona:team%2Fana::tutor', 'user:team%2Fana']);
    const metadata = await target.all<{ metadata: string }>('SELECT metadata FROM memory_traces');
    expect(metadata.map((row) => JSON.parse(row.metadata).scopeId).sort()).toEqual(['team%2Fana', 'team%2Fana::tutor']);
  });

  it('JSON: an encoded export into a plain Brain holding a reserved id is refused, naming the record', async () => {
    const source = await encodedBrain(tempFile(), 'src');
    await plainRow(source, 't-a', 'user', 'A/42');
    const target = await brainAt(tempFile(), 'dst');
    await plainRow(target, 't-b', 'user', 'team/bo');
    const result = await new JsonImporter(target).importFromString(await new JsonExporter(source).exportToString());
    expect(result.imported).toBe(0);
    expect(result.errors.join('\n')).toMatch(/scope_id_form/);
    expect(await scopeIdsOf(target)).toEqual(['user:team/bo']);
    expect(await target.getMeta(SCOPE_ID_FORM_KEY)).toBeUndefined();
  });

  it('SQLite file: a plain source is encoded as it is written into a re-filed Brain', async () => {
    const sourcePath = tempFile();
    const source = await brainAt(sourcePath, 'src');
    await plainRow(source, 't-a', 'user', 'team/ana');
    await closers.pop()!();
    const target = await encodedBrain(tempFile(), 'dst');
    const result = await new SqliteImporter(target).import(sourcePath);
    expect(result.errors).toEqual([]);
    expect(await scopeIdsOf(target)).toEqual(['user:team%2Fana']);
  });

  it('Brain.importFromSqlite: encodes a plain source into a re-filed Brain, merged or replaced, and refuses an encoded one into a plain Brain with a reserved id', async () => {
    const plainPath = tempFile();
    const plain = await brainAt(plainPath, 'src');
    await plainRow(plain, 't-a', 'user', 'team/ana');
    await closers.pop()!();
    const encodedTarget = await encodedBrain(tempFile(), 'dst');
    await encodedTarget.importFromSqlite(plainPath);
    expect(await scopeIdsOf(encodedTarget)).toEqual(['user:team%2Fana']);

    // A replace empties the brain, its record among its brain_meta rows, and keeps the form a layer reads.
    const replaced = await encodedBrain(tempFile(), 'dst3');
    await plainRow(replaced, 't-r', 'user', 'bo');
    await replaced.importFromSqlite(plainPath, { strategy: 'replace' });
    expect(await scopeIdsOf(replaced)).toEqual(['user:team%2Fana']);
    expect(await replaced.getMeta(SCOPE_ID_FORM_KEY)).toBe('encoded');

    const encodedPath = tempFile();
    const encodedSource = await encodedBrain(encodedPath, 'src2');
    await plainRow(encodedSource, 't-e', 'user', 'A/42');
    await closers.pop()!();
    const plainTarget = await brainAt(tempFile(), 'dst2');
    await plainRow(plainTarget, 't-b', 'user', 'team/bo');
    await expect(plainTarget.importFromSqlite(encodedPath)).rejects.toThrow(/scope_id_form/);
    expect(await scopeIdsOf(plainTarget)).toEqual(['user:team/bo']);
  });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-id-form-notes-'));
  dirs.push(dir);
  return dir;
}

/** The scope ids the brain's rows name in their metadata, sorted. */
const metadataScopeIdsOf = async (brain: Brain) =>
  (await brain.all<{ metadata: string }>('SELECT metadata FROM memory_traces WHERE brain_id = ?', [brain.brainId]))
    .map((row) => JSON.parse(row.metadata).scopeId as string)
    .sort();

/** Records a trace's episodic copy into the brain's knowledge graph, as a store with an SQL graph does. */
async function recordCopy(brain: Brain, traceId: string, scopeId: string): Promise<void> {
  const graph = new SqlKnowledgeGraph(brain);
  await graph.initialize();
  await graph.recordMemory({
    type: 'conversation',
    summary: `content of ${traceId}`,
    participants: [scopeId],
    importance: 0.5,
    entityIds: [],
    occurredAt: new Date(1).toISOString(),
    outcome: 'unknown',
    context: { memoryTraceId: traceId, scope: 'user', scopeId, type: 'episodic' },
  });
}

describe("every import keeps a Brain's form", () => {
  it('Markdown: a plain note is encoded as it is written into a re-filed Brain', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'ana.md'), '---\nid: n-ana\nscope: user\nscopeId: team/ana\n---\nAna keeps bees.\n');
    fs.writeFileSync(path.join(dir, 'tutor.md'), '---\nid: n-tutor\nscope: persona\nscopeId: "team/ana::tutor"\n---\nThe tutor knows.\n');
    const target = await encodedBrain(tempFile(), 'dst');

    const result = await new MarkdownImporter(target).import(dir);

    expect(result.errors).toEqual([]);
    expect(await scopeIdsOf(target)).toEqual(['persona:team%2Fana::tutor', 'user:team%2Fana']);
    expect(await metadataScopeIdsOf(target)).toEqual(['team%2Fana', 'team%2Fana::tutor']);
  });

  it('CSV: a plain row is encoded as it is written into a re-filed Brain', async () => {
    const target = await encodedBrain(tempFile(), 'dst');
    const csv = 'content,scope,scope_id,metadata\n"Ana keeps bees.",user,team/ana,\n"Bo hikes.",user,,"{""scopeId"":""team/bo""}"\n';

    const result = await new CsvImporter(target).importFromString(csv);

    expect(result.errors).toEqual([]);
    expect(await scopeIdsOf(target)).toEqual(['user:team%2Fana', 'user:team%2Fbo']);
    expect(await metadataScopeIdsOf(target)).toEqual(['team%2Fana', 'team%2Fbo']);
  });

  it("Markdown: an encoded Brain's export marks its notes, which come back in as they were written", async () => {
    const source = await encodedBrain(tempFile(), 'src');
    // A namespaced id, and a plain id in the encoded form.
    await plainRow(source, 't-ns', 'user', 'A/42');
    await plainRow(source, 't-plain', 'user', 'team%2Fana');
    const dir = tempDir();
    await new MarkdownExporter(source).export(dir);

    // Into the Brain it came from it adds nothing.
    expect((await new MarkdownImporter(source).import(dir)).imported).toBe(0);
    // Into a re-filed Brain it comes in as it was written.
    const encoded = await encodedBrain(tempFile(), 'enc');
    expect((await new MarkdownImporter(encoded).import(dir)).errors).toEqual([]);
    expect(await scopeIdsOf(encoded)).toEqual(['user:A/42', 'user:team%2Fana']);
    // Into a fresh Brain it comes in as it was written, with the record.
    const fresh = await brainAt(tempFile(), 'fresh');
    expect((await new MarkdownImporter(fresh).import(dir)).errors).toEqual([]);
    expect(await scopeIdsOf(fresh)).toEqual(['user:A/42', 'user:team%2Fana']);
    expect(await fresh.getMeta(SCOPE_ID_FORM_KEY)).toBe('encoded');
    // Into a plain Brain holding a reserved id it is refused, naming the record.
    const plain = await brainAt(tempFile(), 'plain');
    await plainRow(plain, 't-b', 'user', 'team/bo');
    const refused = await new MarkdownImporter(plain).import(dir);
    expect(refused.imported).toBe(0);
    expect(refused.errors.join('\n')).toMatch(/scope_id_form/);
    expect(await scopeIdsOf(plain)).toEqual(['user:team/bo']);
    expect(await plain.getMeta(SCOPE_ID_FORM_KEY)).toBeUndefined();
  });

  it("JSON, a SQLite file and Brain.importFromSqlite encode a trace's knowledge-graph copy with the trace", async () => {
    const sourcePath = tempFile();
    const source = await brainAt(sourcePath, 'src');
    await plainRow(source, 't-a', 'user', 'team/ana');
    await recordCopy(source, 't-a', 'team/ana');
    const exported = await new JsonExporter(source).exportToString();
    await closers.pop()!();
    const copiesOf = async (brain: Brain) =>
      (await brain.all<{ properties: string }>(`SELECT properties FROM knowledge_nodes WHERE brain_id = ? AND type = 'memory'`, [brain.brainId]))
        .map((row) => {
          const stored = JSON.parse(row.properties);
          return [stored._context.scopeId, stored._participants];
        });
    const imports: Array<[string, (target: Brain) => Promise<unknown>]> = [
      ['JSON', (target) => new JsonImporter(target).importFromString(exported)],
      ['SQLite file', (target) => new SqliteImporter(target).import(sourcePath)],
      ['Brain.importFromSqlite', (target) => target.importFromSqlite(sourcePath)],
    ];

    for (const [name, importInto] of imports) {
      const target = await encodedBrain(tempFile(), 'dst');
      await importInto(target);

      expect({ name, copies: await copiesOf(target) }).toEqual({ name, copies: [['team%2Fana', ['team%2Fana']]] });
      const graph = new SqlKnowledgeGraph(target);
      await graph.initialize();
      // User `ana` of namespace `team` holds none of it; the plain user's encoded id holds it.
      expect({ name, deleted: await graph.deleteMemories({ scopes: [{ scope: 'user', scopeId: 'team/ana' }] }) }).toEqual({ name, deleted: 0 });
      expect({ name, deleted: await graph.deleteMemories({ scopes: [{ scope: 'user', scopeId: 'team%2Fana' }] }) }).toEqual({ name, deleted: 1 });
    }
  });

  it('refuses an encoded export into a plain Brain whose reserved id only a graph copy holds', async () => {
    const source = await encodedBrain(tempFile(), 'src');
    await plainRow(source, 't-a', 'user', 'A/42');
    const target = await brainAt(tempFile(), 'dst');
    // The copy of a trace a release before keyed copies deleted: the brain holds no trace under `team/bo`.
    await recordCopy(target, 't-gone', 'team/bo');

    const result = await new JsonImporter(target).importFromString(await new JsonExporter(source).exportToString());

    expect(result.imported).toBe(0);
    expect(result.errors.join('\n')).toMatch(/scope_id_form/);
    expect(await target.getMeta(SCOPE_ID_FORM_KEY)).toBeUndefined();
  });

  it('refuses an encoded export into a plain Brain whose reserved id a trace with the id "" holds', async () => {
    const source = await encodedBrain(tempFile(), 'src');
    await plainRow(source, 't-a', 'user', 'A/42');
    const target = await brainAt(tempFile(), 'dst');
    await plainRow(target, '', 'user', 'team/bo');

    const result = await new JsonImporter(target).importFromString(await new JsonExporter(source).exportToString());

    expect(result.imported).toBe(0);
    expect(result.errors.join('\n')).toMatch(/scope_id_form/);
    expect(await target.getMeta(SCOPE_ID_FORM_KEY)).toBeUndefined();
  });

  it('two imports into one Brain at once: the second reads the record the first wrote', async () => {
    const encodedSource = await encodedBrain(tempFile(), 'src');
    await plainRow(encodedSource, 't-a', 'user', 'A/42');
    const plainSource = await brainAt(tempFile(), 'src2');
    await plainRow(plainSource, 't-b', 'user', 'team/bo');
    const encodedExport = await new JsonExporter(encodedSource).exportToString();
    const plainExport = await new JsonExporter(plainSource).exportToString();
    const target = await brainAt(tempFile(), 'dst');

    const results = await Promise.all([
      new JsonImporter(target).importFromString(encodedExport),
      new JsonImporter(target).importFromString(plainExport),
    ]);

    expect(results.map((result) => result.errors)).toEqual([[], []]);
    expect(await target.getMeta(SCOPE_ID_FORM_KEY)).toBe('encoded');
    expect(await scopeIdsOf(target)).toEqual(['user:A/42', 'user:team%2Fbo']);
  });
});

describe('an encoded export into a plain Brain', () => {
  it('goes in, with its record, when the Brain holds persona ids whose parts hold no reserved character', async () => {
    const source = await encodedBrain(tempFile(), 'src');
    await plainRow(source, 't-a', 'user', 'A/42');
    const target = await brainAt(tempFile(), 'dst');
    // User `ana`'s persona `tutor`: the `::` between the two ids belongs to neither.
    await plainRow(target, 't-p', 'persona', 'ana::tutor');

    const result = await new JsonImporter(target).importFromString(await new JsonExporter(source).exportToString());

    expect(result.errors).toEqual([]);
    expect(await scopeIdsOf(target)).toEqual(['persona:ana::tutor', 'user:A/42']);
    expect(await target.getMeta(SCOPE_ID_FORM_KEY)).toBe('encoded');
  });
});

type ReadAll = Brain['all'];

/**
 * Re-files the Brain once, as another opener of it would, around the first read through `brain.all` whose statement
 * `matches`: before that read runs, or once it has returned.
 *
 * @returns Whether the re-file ran, and a function that removes the hook.
 */
function refileAroundRead(
  brain: Brain,
  matches: (sql: string) => boolean,
  when: 'before' | 'after',
): { refiled: () => boolean; restore: () => void } {
  const all = brain.all.bind(brain);
  let refiled = false;
  const spy = vi.spyOn(brain, 'all').mockImplementation((async (sql: string, params?: Parameters<ReadAll>[1]) => {
    const now = !refiled && matches(sql);
    if (now) refiled = true;
    if (now && when === 'before') await refileBrainScopeIds(brain);
    const rows = await all(sql, params);
    if (now && when === 'after') await refileBrainScopeIds(brain);
    return rows;
  }) as ReadAll);
  return { refiled: () => refiled, restore: () => spy.mockRestore() };
}

/** Runs `run`, then removes the hook, whether `run` settles or throws. */
async function hooked<T>(hook: { restore: () => void }, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } finally {
    hook.restore();
  }
}

describe('an export or an import that a re-file overtakes reads one form', () => {
  for (const when of ['before', 'after'] as const) {
    it(`JSON export: the record and the traces agree, when the re-file commits ${when} the traces are read`, async () => {
      const source = await brainAt(tempFile(), 'src');
      await plainRow(source, 't-a', 'user', 'team/ana');
      const hook = refileAroundRead(source, (sql) => sql.includes('FROM memory_traces'), when);
      const payload = JSON.parse(await hooked(hook, () => new JsonExporter(source).exportToString())) as {
        meta: Record<string, string>;
        traces: Array<{ scope_id: string }>;
      };

      expect(hook.refiled()).toBe(true);
      // Either the Brain before the re-file or the Brain after it, never its record of one with its ids of the other.
      const read = [payload.meta[SCOPE_ID_FORM_KEY] ?? 'plain', payload.traces.map((trace) => trace.scope_id)];
      expect([['plain', ['team/ana']], ['encoded', ['team%2Fana']]]).toContainEqual(read);
    });

    it(`Markdown export: a note's mark and its id agree, when the re-file commits ${when} the traces are read`, async () => {
      const source = await brainAt(tempFile(), 'src');
      await plainRow(source, 't-a', 'user', 'team/ana');
      const dir = tempDir();
      const hook = refileAroundRead(source, (sql) => sql.includes('FROM memory_traces'), when);
      await hooked(hook, () => new MarkdownExporter(source).export(dir));

      expect(hook.refiled()).toBe(true);
      const note = readFrontMatter(fs.readFileSync(path.join(dir, 'user', 'episodic', 't-a.md'), 'utf8'));
      // A note an encoded Brain wrote is marked, and the import takes its id as it is written; an unmarked note's id
      // is plain.
      const read = [note.data.scopeIdForm ?? 'plain', note.data.scopeId];
      expect([['plain', 'team/ana'], ['encoded', 'team%2Fana']]).toContainEqual(read);
    });
  }

  /**
   * Re-files `opener`'s Brain once, as another opener of the file would, before the first read through any
   * better-sqlite3 adapter's `all` whose statement is `sql`: the importer's own connection to the file reads it so.
   */
  function refileBeforeFileRead(opener: Brain, sql: string): { refiled: () => boolean; restore: () => void } {
    const all = BetterSqliteAdapter.prototype.all;
    let refiled = false;
    const spy = vi.spyOn(BetterSqliteAdapter.prototype, 'all').mockImplementation(async function (
      this: BetterSqliteAdapter,
      statement: string,
      params?: StorageParameters,
    ) {
      if (!refiled && statement === sql) {
        refiled = true;
        await refileBrainScopeIds(opener);
      }
      return all.call(this, statement, params);
    } as BetterSqliteAdapter['all']);
    return { refiled: () => refiled, restore: () => spy.mockRestore() };
  }

  it('SQLite file: a source re-filed between the read of its record and the read of its traces', async () => {
    const sourcePath = tempFile();
    const opener = await brainAt(sourcePath, 'src');
    await plainRow(opener, 't-a', 'user', 'team/ana');
    const target = await encodedBrain(tempFile(), 'dst');
    const hook = refileBeforeFileRead(opener, 'SELECT * FROM memory_traces WHERE brain_id = ?');
    const result: ImportResult = await hooked(hook, () => new SqliteImporter(target).import(sourcePath));

    expect(hook.refiled()).toBe(true);
    expect(result.errors).toEqual([]);
    expect(await scopeIdsOf(target)).toEqual(['user:team%2Fana']);
  });

  it('Brain.importFromSqlite: a source re-filed between the read of its record and the read of its traces', async () => {
    const sourcePath = tempFile();
    const opener = await brainAt(sourcePath, 'src');
    await plainRow(opener, 't-a', 'user', 'team/ana');
    const target = await encodedBrain(tempFile(), 'dst');
    const hook = refileBeforeFileRead(opener, 'SELECT * FROM memory_traces');
    await hooked(hook, () => target.importFromSqlite(sourcePath));

    expect(hook.refiled()).toBe(true);
    expect(await scopeIdsOf(target)).toEqual(['user:team%2Fana']);
    expect(await target.getMeta(SCOPE_ID_FORM_KEY)).toBe('encoded');
  });

  it('SQLite export: the record and the traces agree, when the re-file commits between the copies of brain_meta and of the traces', async () => {
    // A Brain on one connection (here in memory) reads no snapshot, so a re-file another flow makes can commit between
    // two of the export's reads.
    const source = await Brain.openSqlite(':memory:', { brainId: 'src' });
    closers.push(() => source.close());
    await plainRow(source, 't-a', 'user', 'team/ana');
    const internals = source as unknown as { _bulkCopy: (...args: unknown[]) => Promise<void> };
    const copy = internals._bulkCopy.bind(source);
    let refiled = false;
    internals._bulkCopy = async (...args: unknown[]) => {
      await copy(...args);
      if (args[1] === 'brain_meta' && !refiled) {
        refiled = true;
        await refileBrainScopeIds(source);
      }
    };
    const exportPath = path.join(tempDir(), 'export.sqlite');
    await source.exportToSqlite(exportPath);

    expect(refiled).toBe(true);
    const exported = await brainAt(exportPath, 'src');
    // Either the Brain before the re-file or the Brain after it, never its record of one with its ids of the other.
    const read = [(await exported.getMeta(SCOPE_ID_FORM_KEY)) ?? 'plain', await scopeIdsOf(exported)];
    expect([['plain', ['user:team/ana']], ['encoded', ['user:team%2Fana']]]).toContainEqual(read);
  });
});

describeIfPostgres('imports on Postgres', () => {
  it('wait for the lock a re-file holds, and read the record it wrote', async () => {
    const sourcePath = tempFile();
    const plainSource = await brainAt(sourcePath, 'src');
    await plainRow(plainSource, 't-b', 'user', 'team/bo');
    const plainExport = await new JsonExporter(plainSource).exportToString();
    await closers.pop()!();
    const notes = tempDir();
    fs.writeFileSync(path.join(notes, 'bo.md'), '---\nid: n-bo\nscope: user\nscopeId: team/bo\n---\nBo hikes.\n');
    const csv = 'content,scope,scope_id\n"Bo hikes.",user,team/bo\n';
    const imports: Array<[string, (target: Brain) => Promise<unknown>]> = [
      ['JSON', (target) => new JsonImporter(target).importFromString(plainExport)],
      ['CSV', (target) => new CsvImporter(target).importFromString(csv)],
      ['Markdown', (target) => new MarkdownImporter(target).import(notes)],
      ['SQLite file', (target) => new SqliteImporter(target).import(sourcePath)],
      ['Brain.importFromSqlite', (target) => target.importFromSqlite(sourcePath)],
    ];

    for (const [name, importInto] of imports) {
      const brainId = `test-import-form-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const target = await Brain.openPostgres(POSTGRES_URL!, { brainId });
      const refiler = await Brain.openPostgres(POSTGRES_URL!, { brainId });
      closers.push(async () => {
        for (const table of ['memory_traces', 'knowledge_nodes', 'brain_meta']) {
          await target.run(`DELETE FROM ${table} WHERE brain_id = ?`, [brainId]);
        }
        await refiler.close();
        await target.close();
      });
      // Another process re-files the Brain: it holds the brain's lock, and writes the record before it commits.
      let lockHeld!: () => void;
      const held = new Promise<void>((resolve) => (lockHeld = resolve));
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      const refile = refiler.transaction(async (trx) => {
        await trx.run('SELECT pg_advisory_xact_lock(hashtext($1))', [`agentos_brain_scope_id_form:${brainId}`]);
        lockHeld();
        await released;
        await trx.run(
          refiler.features.dialect.insertOrReplace('brain_meta', ['brain_id', 'key', 'value'], ['?', '?', '?'], 'brain_id, key'),
          [brainId, SCOPE_ID_FORM_KEY, 'encoded'],
        );
      });
      await held;

      const importing = importInto(target);
      // An import that waits for the lock is still waiting a second later; one that does not has finished by then.
      await Promise.race([importing, new Promise((resolve) => setTimeout(resolve, 1_000))]);
      release();
      await refile;
      await importing;

      const ids = (
        await target.all<{ scope: string; scope_id: string }>(
          'SELECT scope, scope_id FROM memory_traces WHERE brain_id = ? AND deleted = 0 ORDER BY scope, scope_id',
          [brainId],
        )
      ).map((row) => `${row.scope}:${row.scope_id}`);
      expect({ name, ids }).toEqual({ name, ids: ['user:team%2Fbo'] });
    }
  });
});
