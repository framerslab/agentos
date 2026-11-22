/**
 * @file Memory.filed-by.integration.test.ts
 * A store that holds both sides of a souled agent's memory under one conversation key: the traces the soul's own calls
 * file through the `Memory` facade, and the traces its mind files through a cognitive memory manager on the facade's
 * own Brain, each of which names the mind in its metadata (`filedBy: 'mind'`). A recall for the soul's side
 * (`filedBy: 'soul'`) leaves the mind's traces out on the hybrid path and on the full-text path; a recall with no
 * `filedBy` reads both. The facade's vector index holds the facade's own vectors: a deletion's rewrite of the index, an
 * open that brings a loaded index up to date and a remembered trace's add leave every mind-filed vector out.
 *
 * A real SQLite facade on a file in a folder of the case's own (and a Postgres one where `AGENTOS_TEST_POSTGRES_URL` is
 * set), the manager built by `createAgentCognitiveMemory` with `rows: 'mind'`, and `forgetUserMemory` itself.
 * hnswlib-node is a native addon whose build pnpm skips in CI, so the index the facade's sidecar loads is replaced by a
 * plain index with the same methods, written to and read from the index file as JSON.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { Memory } from '../Memory.js';
import { brainOf } from '../handedBrain.js';
import type { Brain } from '../../../retrieval/store/Brain.js';
import { HnswSidecar, hnswIndexPath } from '../../../retrieval/store/HnswSidecar.js';
import { PORTABLE_TABLES } from '../../../retrieval/store/portable-tables.js';
import { conversationScopeKey } from '../../../retrieval/store/conversationScopeKey.js';
import { openForgottenCopy } from '../../../suppression/forgottenCopy.js';
import { forgetUserMemory } from '../../forgetUserMemory.js';
import { createAgentCognitiveMemory, type AgentCognitiveMemory } from '../../../../../api/runtime/agentCognitiveMemory.js';

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

    markDelete(label: number): void {
      this.removed.add(label);
    }

    searchKnn(_query: number[], k: number): { neighbors: number[]; distances: number[] } {
      const labels = [...this.points.keys()].filter((label) => !this.removed.has(label)).slice(0, k);
      return { neighbors: labels, distances: labels.map(() => 0) };
    }

    async writeIndex(file: string): Promise<void> {
      writeFileSync(file, JSON.stringify([...this.points.entries()]));
    }

    readIndex(file: string): void {
      this.points = new Map(JSON.parse(readFileSync(file, 'utf8')) as Array<[number, number[]]>);
    }
  }

  return { HierarchicalNSW, default: { HierarchicalNSW } };
});

const POSTGRES_URL = process.env.AGENTOS_TEST_POSTGRES_URL;
const AGENT = 'aria-1';
const DIM = 8;
const MOOD = { valence: 0, arousal: 0, dominance: 0 };
const keyOf = (id: string): string => conversationScopeKey(AGENT, { kind: 'user', id });
const filingOf = (id: string) => ({ filedBy: 'mind' as const, speaker: 'user' as const, subject: { kind: 'user' as const, id } });

/** A bag-of-words vector of `dim` numbers: texts that share a word point the same way. */
function wordVector(text: string, dim: number = DIM): number[] {
  const vector = new Array<number>(dim).fill(0);
  for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    let h = 0;
    for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    vector[h % dim] += 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm + 0.001);
}

/** An embedding manager of the facade's vector size, for the mind's manager. */
const embeddingManager = {
  initialize: async () => undefined,
  generateEmbeddings: async (request: { texts: string | string[] }) => {
    const texts = Array.isArray(request.texts) ? request.texts : [request.texts];
    return {
      embeddings: texts.map((text) => wordVector(text)),
      modelId: `words-${DIM}`,
      providerId: 'test',
      usage: { totalTokens: 0 },
    };
  },
  getEmbeddingModelInfo: async () => ({ modelId: `words-${DIM}`, providerId: 'test', dimension: DIM }),
  getEmbeddingDimension: async () => DIM,
  checkHealth: async () => ({ isHealthy: true }),
  shutdown: async () => undefined,
};

type Store = 'sqlite' | 'postgres';
const facades: Memory[] = [];
const managers: AgentCognitiveMemory[] = [];
const adapters: StorageAdapter[] = [];
const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (managers.length) await managers.pop()!.close();
  while (facades.length) {
    const memory = facades.pop()!;
    const brain = brainOf(memory);
    if (brain.features.dialect.name === 'postgres') {
      // The database outlives the test: this brain's rows go, children before parents.
      for (const table of ['memory_legacy_owner', 'memory_pages', 'memory_scopes', ...[...PORTABLE_TABLES].reverse()]) {
        await brain.run(`DELETE FROM ${table} WHERE brain_id = ?`, [brain.brainId]).catch(() => undefined);
      }
    }
    await memory.close();
  }
  while (adapters.length) await adapters.pop()!.close().catch(() => undefined);
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

interface Facade {
  memory: Memory;
  brain: Brain;
  /** The database file; empty on Postgres. */
  file: string;
}

/** The facade's options: it embeds what it remembers, at the mind's vector size. */
const facadeOptions = {
  brainId: 'filed-by',
  graph: false,
  selfImprove: false,
  decay: false,
  embed: async (text: string) => wordVector(text),
  embeddings: { provider: 'test', dimensions: DIM },
};

/** A facade on a fresh store, or on `file` again; with `ledger`, it holds a forgotten-user ledger with its copy. */
async function openFacade(store: Store = 'sqlite', options: { file?: string; ledger?: boolean } = {}): Promise<Facade> {
  let memory: Memory;
  let file = '';
  if (store === 'postgres') {
    memory = await Memory.createPostgres(POSTGRES_URL!, {
      ...facadeOptions,
      brainId: `filed-by-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      poolSize: 2,
    });
  } else {
    file = options.file ?? path.join(newFolder(), 'brain.sqlite');
    let forgotten: { copy: StorageAdapter } | undefined;
    if (options.ledger) {
      const { adapter: copy } = await openForgottenCopy(path.join(path.dirname(file), 'forgotten.sqlite'));
      adapters.push(copy);
      forgotten = { copy };
    }
    memory = await Memory.createSqlite(file, { ...facadeOptions, ...(forgotten ? { forgotten } : {}) });
  }
  facades.push(memory);
  return { memory, brain: brainOf(memory), file };
}

/** A new folder of this case's own, removed after it. */
function newFolder(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filed-by-'));
  dirs.push(dir);
  return dir;
}

/** Closes a facade the case opened, so the next open starts from its files. */
async function closeFacade(memory: Memory): Promise<void> {
  await memory.close();
  facades.splice(facades.indexOf(memory), 1);
}

/** The manager a souled agent's mind runs on the facade's Brain. */
async function mindManager(brain: Brain): Promise<AgentCognitiveMemory> {
  const built = await createAgentCognitiveMemory({
    persona: {
      id: AGENT,
      name: 'Aria',
      description: 'd',
      version: '1.0.0',
      baseSystemPrompt: 'x',
      personalityTraits: {},
    } as never,
    memory: {},
    brain,
    embeddingManager: embeddingManager as never,
    rows: 'mind',
    hydration: 'scopes',
  });
  managers.push(built);
  return built;
}

/** Closes a manager the case built. */
async function closeManager(built: AgentCognitiveMemory): Promise<void> {
  await built.close();
  managers.splice(managers.indexOf(built), 1);
}

/** Files `text` as the mind files what `userId` said, under the person's key; answers the trace's id. */
async function fileAsMind(built: AgentCognitiveMemory, userId: string, text: string): Promise<string> {
  const trace = await built.manager.encode(text, MOOD, 'neutral', {
    scope: 'conversation',
    scopeId: keyOf(userId),
    filing: filingOf(userId),
    turnUserId: userId,
  });
  return trace.id;
}

const metadataOf = async (brain: Brain, id: string): Promise<Record<string, unknown>> => {
  const row = await brain.get<{ metadata: string }>('SELECT metadata FROM memory_traces WHERE brain_id = ? AND id = ?', [
    brain.brainId,
    id,
  ]);
  return JSON.parse(row!.metadata) as Record<string, unknown>;
};

/** Whether a trace's row holds a vector. */
const holdsVector = async (brain: Brain, id: string): Promise<boolean> => {
  const row = await brain.get<{ embedding: Uint8Array | string | null }>(
    'SELECT embedding FROM memory_traces WHERE brain_id = ? AND id = ?',
    [brain.brainId, id],
  );
  return Boolean(row?.embedding && row.embedding.length > 0);
};

/** The paths of the facade's vector index files. */
function indexFilesOf({ file, brain }: Facade): { indexFile: string; mapFile: string } {
  const indexFile = hnswIndexPath({ sqlitePath: file, brainId: brain.brainId });
  return { indexFile, mapFile: `${indexFile}.map.json` };
}

/** The trace ids the index's map file names. */
const idsIn = (mapFile: string): string[] =>
  (JSON.parse(fs.readFileSync(mapFile, 'utf8')) as { entries: Array<[number, string]> }).entries.map(([, id]) => id).sort();

/** The vectors the index file holds. */
const vectorsIn = (indexFile: string): number[][] =>
  (JSON.parse(fs.readFileSync(indexFile, 'utf8')) as Array<[number, number[]]>).map(([, vector]) => vector);

/** The facade's vector index, as it holds it in memory. */
const sidecarOf = (memory: Memory): HnswSidecar => (memory as unknown as { _hnswSidecar: HnswSidecar })._hnswSidecar;

/** A page store with no page, for a deletion. */
const noPages = { storeFor: () => ({ listPages: async () => [], deletePage: async () => undefined }) };

/** The ids a recall under `scopeId` answers, sorted. */
async function recalled(memory: Memory, query: string, scopeId: string, filedBy?: 'soul'): Promise<string[]> {
  const options = { scope: 'conversation', scopeId, ...(filedBy === undefined ? {} : { filedBy }) };
  return (await memory.recall(query, options)).map((scored) => scored.trace.id).sort();
}

/**
 * One key holding a trace of each side and a soul-filed trace whose metadata is not JSON: a recall for the soul's
 * side answers the soul's traces alone, a recall with no `filedBy` answers all three.
 */
async function bothSidesUnderOneKey(store: Store): Promise<{ facade: Facade; soul: string[]; mind: string; A: string }> {
  const facade = await openFacade(store);
  const { memory, brain } = facade;
  const A = keyOf('alice');
  const soul = await memory.remember('Alice keeps bees on the roof.', { scope: 'conversation', scopeId: A });
  const other = await memory.remember('Alice sells the bees honey at the market.', { scope: 'conversation', scopeId: A });
  // Another writer's metadata that is not JSON: the soul's side reads its row, and the read does not fail on it.
  await brain.run('UPDATE memory_traces SET metadata = ? WHERE brain_id = ? AND id = ?', ['{not json', brain.brainId, other.id]);
  const built = await mindManager(brain);
  const mind = await fileAsMind(built, 'alice', 'Alice keeps bees in the garden.');
  expect((await metadataOf(brain, mind)).filedBy).toBe('mind');
  return { facade, soul: [soul.id, other.id].sort(), mind, A };
}

describe("a recall for the soul's side", () => {
  it("leaves the mind's rows out", async () => {
    const { facade, soul, mind, A } = await bothSidesUnderOneKey('sqlite');
    const { memory } = facade;
    const query = vi.spyOn(HnswSidecar.prototype, 'query');

    // The full-text path: the facade's vector index is not built yet.
    expect(await recalled(memory, 'bees', A, 'soul')).toEqual(soul);
    expect(await recalled(memory, 'bees', A)).toEqual([...soul, mind].sort());
    expect(query).not.toHaveBeenCalled();

    // The hybrid path: the vector index's candidates are fused with the full-text ones.
    await memory.rebuildVectorIndex();
    expect(sidecarOf(memory).isActive).toBe(true);
    expect(await recalled(memory, 'bees', A, 'soul')).toEqual(soul);
    expect(query).toHaveBeenCalled();
    expect(await recalled(memory, 'bees', A)).toEqual([...soul, mind].sort());

    // A side the option does not name, as a caller without the types passes it, is refused, never read as no filter.
    const mindSide = { scope: 'conversation', scopeId: A, filedBy: 'mind' } as unknown as Parameters<Memory['recall']>[1];
    await expect(memory.recall('bees', mindSide)).rejects.toThrow(TypeError);
  });

  it.skipIf(!POSTGRES_URL)("leaves the mind's rows out, on PostgreSQL", async () => {
    const { facade, soul, mind, A } = await bothSidesUnderOneKey('postgres');
    expect(await recalled(facade.memory, 'bees', A, 'soul')).toEqual(soul);
    expect(await recalled(facade.memory, 'bees', A)).toEqual([...soul, mind].sort());
  });
});

describe("the facade's vector index", () => {
  it("never takes a mind-filed vector when a deletion writes it again", async () => {
    const facade = await openFacade('sqlite', { ledger: true });
    const { memory, brain } = facade;
    const { indexFile, mapFile } = indexFilesOf(facade);
    const alice = await memory.remember('Alice keeps bees.', { scope: 'conversation', scopeId: keyOf('alice') });
    const bobSoul = await memory.remember('Bob plays the cello.', { scope: 'conversation', scopeId: keyOf('bob') });
    const built = await mindManager(brain);
    const bobMind = [
      await fileAsMind(built, 'bob', 'Bob plays chess on Sundays.'),
      await fileAsMind(built, 'bob', 'Bob rows on the river.'),
    ];
    for (const id of bobMind) expect(await holdsVector(brain, id)).toBe(true);

    // Index files already in the store's folder that name Bob's mind-filed traces beside the facade's own.
    await sidecarOf(memory).rewrite([
      { id: alice.id, embedding: wordVector('Alice keeps bees.') },
      { id: bobSoul.id, embedding: wordVector('Bob plays the cello.') },
      { id: bobMind[0], embedding: wordVector('Bob plays chess on Sundays.') },
      { id: bobMind[1], embedding: wordVector('Bob rows on the river.') },
    ]);
    expect(idsIn(mapFile)).toEqual([alice.id, bobSoul.id, ...bobMind].sort());

    const report = await forgetUserMemory({ memory, agentId: AGENT, subject: { kind: 'user', id: 'alice' }, wiki: noPages });

    expect(report.stores).toContainEqual(expect.objectContaining({ store: 'vector index', reached: true }));
    // The index holds Bob's soul-filed vector alone; his mind-filed rows stand, outside it.
    expect(idsIn(mapFile)).toEqual([bobSoul.id]);
    expect(vectorsIn(indexFile)).toHaveLength(1);
    for (const id of bobMind) expect(await holdsVector(brain, id)).toBe(true);
  });

  it('an open leaves the mind-filed vectors out of the index it loads', async () => {
    const facade = await openFacade('sqlite');
    const { memory, brain, file } = facade;
    const { mapFile } = indexFilesOf(facade);
    const soul = await memory.remember('Bob plays the cello.', { scope: 'conversation', scopeId: keyOf('bob') });
    await memory.rebuildVectorIndex();
    expect(idsIn(mapFile)).toEqual([soul.id]);

    // A mind-filed row stored after the index was written: the open's check of the loaded index does not add it.
    const built = await mindManager(brain);
    const mind = await fileAsMind(built, 'bob', 'Bob plays chess on Sundays.');
    await closeManager(built);
    await closeFacade(memory);
    const reopened = await openFacade('sqlite', { file });
    await reopened.memory.recall('cello');
    expect(idsIn(mapFile)).toEqual([soul.id]);
    expect(sidecarOf(reopened.memory).ids()).toEqual([soul.id]);

    // Index files that name a mind-filed trace: the open writes the index again from the facade's own vectors.
    await sidecarOf(reopened.memory).rewrite([
      { id: soul.id, embedding: wordVector('Bob plays the cello.') },
      { id: mind, embedding: wordVector('Bob plays chess on Sundays.') },
    ]);
    expect(idsIn(mapFile)).toEqual([mind, soul.id].sort());
    await closeFacade(reopened.memory);
    const again = await openFacade('sqlite', { file });
    await again.memory.recall('cello');
    expect(idsIn(mapFile)).toEqual([soul.id]);
  });

  it('a remembered trace whose metadata names the mind is not added to the index', async () => {
    const facade = await openFacade('sqlite');
    const { memory } = facade;
    const soul = await memory.remember('Bob plays the cello.', { scope: 'conversation', scopeId: keyOf('bob') });
    await memory.rebuildVectorIndex();
    expect(sidecarOf(memory).isActive).toBe(true);

    const marked = await memory.remember('Bob plays chess on Sundays.', {
      scope: 'conversation',
      scopeId: keyOf('bob'),
      metadata: { filedBy: 'mind' },
    });
    const plain = await memory.remember('Bob rows on the river.', { scope: 'conversation', scopeId: keyOf('bob') });

    expect(sidecarOf(memory).ids().sort()).toEqual([plain.id, soul.id].sort());
    expect(sidecarOf(memory).ids()).not.toContain(marked.id);
  });
});
