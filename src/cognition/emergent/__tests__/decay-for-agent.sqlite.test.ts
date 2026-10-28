/**
 * @fileoverview PersonalityMutationStore.decayForAgent on a real SQLite
 * database: the store the runtime builds over its storage adapter
 * (SelfImprovementSessionManager.buildToolDeps), on an in-memory database
 * opened through @framers/sql-storage-adapter.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveStorageAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { SelfImprovementSessionManager } from '../../../api/runtime/SelfImprovementSessionManager.js';
import type { ILogger } from '../../../core/logging/ILogger.js';
import type { PersonalityMutationStore } from '../PersonalityMutationStore.js';

const silentLogger: ILogger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const databases: StorageAdapter[] = [];

/** The store the runtime builds over a new in-memory database, holding one mutation of agent a1 at strength 1. */
async function storeWithOneMutation(): Promise<{ db: StorageAdapter; store: PersonalityMutationStore }> {
  const db = await resolveStorageAdapter({ filePath: ':memory:', priority: ['better-sqlite3', 'sqljs'], quiet: true });
  databases.push(db);
  const deps = new SelfImprovementSessionManager(silentLogger).buildToolDeps(db, {
    getGMIForContext: () => undefined,
    getToolOrchestrator: () => {
      throw new Error('a decay never reaches the tool orchestrator');
    },
  });
  const store = deps.mutationStore;
  if (!store) throw new Error('the runtime built no mutation store over the adapter');
  await store.record({
    agentId: 'a1',
    trait: 'openness',
    delta: 0.1,
    reasoning: 'seed',
    baselineValue: 0.5,
    mutatedValue: 0.6,
  });
  return { db, store };
}

async function strengthOf(store: PersonalityMutationStore): Promise<number | undefined> {
  return (await store.loadForAgent('a1'))[0]?.strength;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) await db.close();
});

describe('PersonalityMutationStore.decayForAgent on SQLite', () => {
  it('a replay in the same millisecond is refused: Date.now() 1793194099407 with the Math.random() draws 0.5 and 0.50006103515625', async () => {
    const { store } = await storeWithOneMutation();
    // The two draws added to one millisecond give one number.
    const now = 1_793_194_099_407;
    const draws = [0.5, 0.5 + 2 ** -14];
    expect(now + draws[0]!).toBe(now + draws[1]!);
    let draw = 0;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    vi.spyOn(Math, 'random').mockImplementation(() => draws[draw++ % 2]!);

    const first = await store.decayForAgent('a1', 0.05, 'day:2026-10-28');
    const replay = await store.decayForAgent('a1', 0.05, 'day:2026-10-28');

    expect(first).toEqual({ decayed: 1, pruned: 0 });
    expect(replay).toEqual({ decayed: 0, pruned: 0, skipped: true });
    expect(await strengthOf(store)).toBeCloseTo(0.95);
  });
});
