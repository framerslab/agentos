/**
 * @fileoverview PersonalityMutationStore.decayForAgent on a real SQLite
 * database: the store the runtime builds over its storage adapter
 * (SelfImprovementSessionManager.buildToolDeps), on an in-memory database
 * opened through @framers/sql-storage-adapter with each of its SQLite engines,
 * better-sqlite3 and sql.js.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveStorageAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { SelfImprovementSessionManager } from '../../../api/runtime/SelfImprovementSessionManager.js';
import type { ILogger } from '../../../core/logging/ILogger.js';
import type { PersonalityMutationStore } from '../PersonalityMutationStore.js';

const silentLogger: ILogger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const databases: StorageAdapter[] = [];

/** The guard table as earlier releases made it, without the owner_token column. */
const EARLIER_GUARD_TABLE = `
  CREATE TABLE personality_decay_cycles (
    agent_id TEXT NOT NULL,
    cycle_id TEXT NOT NULL,
    applied_at BIGINT NOT NULL,
    PRIMARY KEY (agent_id, cycle_id)
  )
`;

/** A new in-memory database on `engine`. */
async function openDatabase(engine: 'better-sqlite3' | 'sqljs'): Promise<StorageAdapter> {
  const db = await resolveStorageAdapter({ filePath: ':memory:', priority: [engine], quiet: true });
  databases.push(db);
  expect(db.kind).toBe(engine);
  return db;
}

/** The store the runtime builds over `db`, holding one mutation of agent a1 at strength 1. */
async function storeWithOneMutation(db: StorageAdapter): Promise<PersonalityMutationStore> {
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
  return store;
}

async function strengthOf(store: PersonalityMutationStore): Promise<number | undefined> {
  return (await store.loadForAgent('a1'))[0]?.strength;
}

/** The declared type of the guard table's owner_token column, or undefined when the table has none. */
async function ownerTokenType(db: StorageAdapter): Promise<string | undefined> {
  const column = await db.get<{ type: string }>(
    "SELECT type FROM pragma_table_info('personality_decay_cycles') WHERE name = 'owner_token'",
  );
  return column?.type;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) await db.close();
});

describe.each(['better-sqlite3', 'sqljs'] as const)('PersonalityMutationStore.decayForAgent on SQLite (%s)', (engine) => {
  it('a replay in the same millisecond is refused: Date.now() 1793194099407 with the Math.random() draws 0.5 and 0.50006103515625', async () => {
    const store = await storeWithOneMutation(await openDatabase(engine));
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

  it('a cycle an earlier release applied stays applied: its guard row holds the stamp 1793194099407.37, which no token equals', async () => {
    const db = await openDatabase(engine);
    const store = await storeWithOneMutation(db);
    await db.run('INSERT INTO personality_decay_cycles (agent_id, cycle_id, applied_at) VALUES (?, ?, ?)', [
      'a1',
      'day:2026-10-28',
      1_793_194_099_407.37,
    ]);
    const earlier = await db.get<{ applied_at: unknown }>(
      'SELECT applied_at FROM personality_decay_cycles WHERE agent_id = ? AND cycle_id = ?',
      ['a1', 'day:2026-10-28'],
    );
    expect(earlier?.applied_at).toBe(1_793_194_099_407.37);

    expect(await store.decayForAgent('a1', 0.05, 'day:2026-10-28')).toEqual({ decayed: 0, pruned: 0, skipped: true });
    expect(await strengthOf(store)).toBe(1);

    // The next cycle's guard row holds its owner's token in owner_token and the time in applied_at.
    const before = Date.now();
    expect(await store.decayForAgent('a1', 0.05, 'day:2026-10-29')).toEqual({ decayed: 1, pruned: 0 });
    const after = Date.now();
    expect(await strengthOf(store)).toBeCloseTo(0.95);
    const owned = await db.get<{ kind: string; applied_at: number; owner_token: unknown }>(
      'SELECT typeof(applied_at) AS kind, applied_at, owner_token FROM personality_decay_cycles WHERE agent_id = ? AND cycle_id = ?',
      ['a1', 'day:2026-10-29'],
    );
    expect(owned?.kind).toBe('integer');
    expect(owned?.applied_at).toBeGreaterThanOrEqual(before);
    expect(owned?.applied_at).toBeLessThanOrEqual(after);
    expect(owned?.owner_token).toMatch(UUID);
  });

  it('a guard table an earlier release made keeps its cycles applied, a stamp or a token in applied_at alike, and gains owner_token at the first decay', async () => {
    const db = await openDatabase(engine);
    await db.exec(EARLIER_GUARD_TABLE);
    // Releases through 0.15.32 wrote a millisecond stamp; from 0.15.33 a token went into applied_at.
    await db.run('INSERT INTO personality_decay_cycles (agent_id, cycle_id, applied_at) VALUES (?, ?, ?)', [
      'a1',
      'day:2026-10-27',
      1_793_194_099_407.37,
    ]);
    await db.run('INSERT INTO personality_decay_cycles (agent_id, cycle_id, applied_at) VALUES (?, ?, ?)', [
      'a1',
      'day:2026-10-28',
      '3f2a1c9e-4b7d-4e2a-9c1f-6d8b5a7e0c21',
    ]);
    const store = await storeWithOneMutation(db);
    // Recording and loading a mutation leave the guard table as it is.
    expect(await strengthOf(store)).toBe(1);
    expect(await ownerTokenType(db)).toBeUndefined();

    expect(await store.decayForAgent('a1', 0.05, 'day:2026-10-27')).toEqual({ decayed: 0, pruned: 0, skipped: true });
    expect(await store.decayForAgent('a1', 0.05, 'day:2026-10-28')).toEqual({ decayed: 0, pruned: 0, skipped: true });
    expect(await strengthOf(store)).toBe(1);

    expect(await ownerTokenType(db)).toBe('TEXT');
    expect(await store.decayForAgent('a1', 0.05, 'day:2026-10-29')).toEqual({ decayed: 1, pruned: 0 });
    expect(await strengthOf(store)).toBeCloseTo(0.95);
  });
});
