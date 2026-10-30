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
 * `brain_meta`): a plain source is encoded as it is written into a re-filed Brain, and a source with the record goes
 * into a plain Brain only when that Brain holds no plain id the record would read as another.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

describe('an import takes its source form from its record', () => {
  const scopeIdsOf = async (brain: Brain) =>
    (await brain.all<{ scope: string; scope_id: string }>('SELECT scope, scope_id FROM memory_traces WHERE deleted = 0 ORDER BY scope, scope_id'))
      .map((row) => `${row.scope}:${row.scope_id}`);

  async function encodedBrain(filePath: string, brainId: string): Promise<Brain> {
    const brain = await brainAt(filePath, brainId);
    await refileBrainScopeIds(brain);
    return brain;
  }

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
