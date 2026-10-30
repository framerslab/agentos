/**
 * @fileoverview PersonalityMutationStore.decayForAgent on PostgreSQL, run when
 * `AGENTOS_TEST_POSTGRES_URL` names a database (CI's Test & Lint job sets it).
 * The store is the one the runtime builds over its storage adapter
 * (SelfImprovementSessionManager.buildToolDeps), here a PostgreSQL adapter of
 * @framers/sql-storage-adapter. Each test's tables go in a schema of their own
 * (the storage library's `segment`), dropped when the suite ends.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createPostgresAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { SelfImprovementSessionManager } from '../../../api/runtime/SelfImprovementSessionManager.js';
import type { ILogger } from '../../../core/logging/ILogger.js';
import type { PersonalityMutationStore } from '../PersonalityMutationStore.js';

const url = process.env.AGENTOS_TEST_POSTGRES_URL;
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const silentLogger: ILogger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The guard table as earlier releases made it, without the owner_token column. */
const EARLIER_GUARD_TABLE = `
  CREATE TABLE personality_decay_cycles (
    agent_id TEXT NOT NULL,
    cycle_id TEXT NOT NULL,
    applied_at BIGINT NOT NULL,
    PRIMARY KEY (agent_id, cycle_id)
  )
`;

describe.skipIf(!url)('PersonalityMutationStore.decayForAgent on PostgreSQL', () => {
  const segments: string[] = [];
  const databases: StorageAdapter[] = [];

  /** An open PostgreSQL adapter whose tables go in a new schema of their own. */
  async function openSegment(): Promise<StorageAdapter> {
    const segment = `agentos_decay_${run}_${segments.length}`;
    segments.push(segment);
    const db = createPostgresAdapter({ connectionString: url!, segment });
    await db.open();
    databases.push(db);
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

  /**
   * `db`, with each transaction's guard-row claim held, once it has been
   * sent, until `calls` claims have been sent: the claims of that many
   * concurrent decays reach PostgreSQL while all of their transactions are
   * open, so a later claim meets an earlier one's uncommitted row. A held
   * claim fails after 10 s when fewer claims arrive.
   */
  function claimsSentTogether(db: StorageAdapter, calls: number): StorageAdapter {
    let sent = 0;
    let release!: () => void;
    const allSent = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waitForAll = async (): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`fewer than ${calls} guard claims were sent while their transactions were open`)),
          10_000,
        );
      });
      try {
        await Promise.race([allSent, late]);
      } finally {
        clearTimeout(timer);
      }
    };
    const bound = (target: object, prop: string | symbol): unknown => {
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    };
    const holding = (trx: StorageAdapter): StorageAdapter =>
      new Proxy(trx, {
        get(target, prop) {
          if (prop !== 'run') return bound(target, prop);
          return async (...args: Parameters<StorageAdapter['run']>) => {
            const claim = target.run(...args);
            if (args[0].includes('INSERT INTO personality_decay_cycles')) {
              // Handled here too, so a claim that fails while it is held is not reported as unhandled.
              claim.catch(() => undefined);
              sent += 1;
              if (sent === calls) release();
              await waitForAll();
            }
            return claim;
          };
        },
      });
    return new Proxy(db, {
      get(target, prop) {
        if (prop !== 'transaction') return bound(target, prop);
        return <T>(fn: (trx: StorageAdapter) => Promise<T>): Promise<T> =>
          target.transaction((trx) => fn(holding(trx)));
      },
    });
  }

  /** The data type of the guard table's owner_token column, or undefined when the table has none. */
  async function ownerTokenType(db: StorageAdapter): Promise<string | undefined> {
    const column = await db.get<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'personality_decay_cycles' AND column_name = 'owner_token'`,
    );
    return column?.data_type;
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const db of databases.splice(0)) await db.close();
  });

  afterAll(async () => {
    const admin = createPostgresAdapter({ connectionString: url! });
    await admin.open();
    try {
      for (const segment of segments) await admin.exec(`DROP SCHEMA IF EXISTS "${segment}" CASCADE`);
    } finally {
      await admin.close();
    }
  });

  it('decays the agent once for a cycle: the replay is skipped, the next cycle decays again', async () => {
    const store = await storeWithOneMutation(await openSegment());

    expect(await store.decayForAgent('a1', 0.05, 'day:2026-10-28')).toEqual({ decayed: 1, pruned: 0 });
    expect(await strengthOf(store)).toBeCloseTo(0.95);
    expect(await store.decayForAgent('a1', 0.05, 'day:2026-10-28')).toEqual({ decayed: 0, pruned: 0, skipped: true });
    expect(await strengthOf(store)).toBeCloseTo(0.95);
    expect(await store.decayForAgent('a1', 0.05, 'day:2026-10-29')).toEqual({ decayed: 1, pruned: 0 });
    expect(await strengthOf(store)).toBeCloseTo(0.9);
  });

  it('a replay in the same millisecond is refused: Date.now() 1793194099407 with the Math.random() draws 0.5 and 0.50006103515625', async () => {
    const store = await storeWithOneMutation(await openSegment());
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

  it('two calls for one cycle at once, each in a transaction on its own connection, the second claim sent while the first is uncommitted: one decays, the other is skipped', async () => {
    const store = await storeWithOneMutation(claimsSentTogether(await openSegment(), 2));

    const results = await Promise.all([
      store.decayForAgent('a1', 0.05, 'day:2026-10-28'),
      store.decayForAgent('a1', 0.05, 'day:2026-10-28'),
    ]);

    expect(results.sort((a, b) => a.decayed - b.decayed)).toEqual([
      { decayed: 0, pruned: 0, skipped: true },
      { decayed: 1, pruned: 0 },
    ]);
    expect(await strengthOf(store)).toBeCloseTo(0.95);
  });

  it('a guard table an earlier release made: its cycle at the stamp 1793194099407 stays applied, and the table gains owner_token at the first decay', async () => {
    const db = await openSegment();
    await db.exec(EARLIER_GUARD_TABLE);
    await db.run('INSERT INTO personality_decay_cycles (agent_id, cycle_id, applied_at) VALUES (?, ?, ?)', [
      'a1',
      'day:2026-10-28',
      1_793_194_099_407,
    ]);
    const store = await storeWithOneMutation(db);
    // Recording and loading a mutation leave the guard table as it is.
    expect(await strengthOf(store)).toBe(1);
    expect(await ownerTokenType(db)).toBeUndefined();

    expect(await store.decayForAgent('a1', 0.05, 'day:2026-10-28')).toEqual({ decayed: 0, pruned: 0, skipped: true });
    expect(await strengthOf(store)).toBe(1);

    expect(await ownerTokenType(db)).toBe('text');

    // The next cycle's guard row holds its owner's token in owner_token and the time in applied_at.
    const before = Date.now();
    expect(await store.decayForAgent('a1', 0.05, 'day:2026-10-29')).toEqual({ decayed: 1, pruned: 0 });
    const after = Date.now();
    expect(await strengthOf(store)).toBeCloseTo(0.95);
    const owned = await db.get<{ applied_at: unknown; owner_token: unknown }>(
      'SELECT applied_at, owner_token FROM personality_decay_cycles WHERE agent_id = ? AND cycle_id = ?',
      ['a1', 'day:2026-10-29'],
    );
    // pg reads a BIGINT as a string.
    const appliedAt = Number(owned?.applied_at);
    expect(Number.isSafeInteger(appliedAt)).toBe(true);
    expect(appliedAt).toBeGreaterThanOrEqual(before);
    expect(appliedAt).toBeLessThanOrEqual(after);
    expect(owned?.owner_token).toMatch(UUID);
  });
});
