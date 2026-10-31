/**
 * @fileoverview Tests for PersonalityMutationStore.decayForAgent
 * (spec batch-1 C6): agent scoping, cycle-id idempotency via the
 * guard-first transaction (a replay in the same millisecond included),
 * pre-existing sub-threshold pruning, post-decay pruning, atomicity on
 * mid-transaction failure, the transaction-required error, the schema step
 * that adds the guard table's owner_token column (run by a decay alone), and
 * a failed schema step that the next call runs again.
 *
 * The fake adapter emulates exactly the SQL statements the store issues
 * (two tables, verb + WHERE pattern matched) with snapshot-rollback
 * transactions, so the decay unit's all-or-nothing behavior is observable
 * without a native sqlite dependency.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PersonalityMutationStore } from '../PersonalityMutationStore.js';
import type { IStorageAdapter } from '../EmergentToolRegistry.js';

interface Row { id: string; agentId: string; strength: number }

class FakeAdapter {
  rows = new Map<string, Row>();
  /** Each guard row's owner_token as written. */
  cycles = new Map<string, unknown>();
  /** When set, the Nth write inside a transaction throws (1-based). */
  failOnWrite = 0;
  private writes = 0;

  seed(id: string, agentId: string, strength: number): void {
    this.rows.set(id, { id, agentId, strength });
  }

  async exec(_sql: string): Promise<void> {}

  private bump(): void {
    this.writes++;
    if (this.failOnWrite > 0 && this.writes >= this.failOnWrite) {
      throw new Error('injected write failure');
    }
  }

  async run(sql: string, params: unknown[] = []): Promise<unknown> {
    if (
      sql.includes('INSERT INTO personality_decay_cycles') &&
      sql.includes('ON CONFLICT (agent_id, cycle_id) DO NOTHING')
    ) {
      this.bump();
      const key = `${params[0]}|${params[1]}`;
      if (!this.cycles.has(key)) this.cycles.set(key, params[3]);
      return {};
    }
    if (sql.includes('DELETE FROM personality_mutations WHERE id = ?')) {
      this.bump();
      this.rows.delete(String(params[0]));
      return {};
    }
    if (sql.includes('UPDATE personality_mutations SET strength = ?')) {
      this.bump();
      const row = this.rows.get(String(params[1]));
      if (row) row.strength = Number(params[0]);
      return {};
    }
    return {};
  }

  async get(sql: string, params: unknown[] = []): Promise<unknown> {
    if (sql.includes('FROM personality_decay_cycles')) {
      const key = `${params[0]}|${params[1]}`;
      return this.cycles.has(key) ? { owner_token: this.cycles.get(key) } : undefined;
    }
    return undefined;
  }

  async all(sql: string, params: unknown[] = []): Promise<unknown[]> {
    const agentId = String(params[0]);
    const mine = [...this.rows.values()].filter((r) => r.agentId === agentId);
    if (sql.includes('strength <= 0.1')) {
      return mine.filter((r) => r.strength <= 0.1).map((r) => ({ id: r.id }));
    }
    return mine.map((r) => ({ id: r.id, strength: r.strength }));
  }

  async transaction<T>(
    fn: (tx: { run: FakeAdapter['run']; get: FakeAdapter['get']; all: FakeAdapter['all'] }) => Promise<T>,
  ): Promise<T> {
    const rowsSnapshot = new Map([...this.rows.entries()].map(([k, v]) => [k, { ...v }]));
    const cyclesSnapshot = new Map(this.cycles);
    this.writes = 0;
    try {
      return await fn({
        run: this.run.bind(this),
        get: this.get.bind(this),
        all: this.all.bind(this),
      });
    } catch (err) {
      this.rows = rowsSnapshot;
      this.cycles = cyclesSnapshot;
      throw err;
    }
  }
}

describe('PersonalityMutationStore.decayForAgent', () => {
  let adapter: FakeAdapter;
  let store: PersonalityMutationStore;

  beforeEach(() => {
    adapter = new FakeAdapter();
    store = new PersonalityMutationStore(adapter);
  });

  it('decays only the named agent and leaves others untouched', async () => {
    adapter.seed('m1', 'a1', 1.0);
    adapter.seed('m2', 'a2', 1.0);

    const result = await store.decayForAgent('a1', 0.05, 'day:2026-07-20');

    expect(result).toEqual({ decayed: 1, pruned: 0 });
    expect(adapter.rows.get('m1')!.strength).toBeCloseTo(0.95);
    expect(adapter.rows.get('m2')!.strength).toBe(1.0);
  });

  it('replaying the same (agent, cycle) is a no-op via the guard', async () => {
    adapter.seed('m1', 'a1', 1.0);

    await store.decayForAgent('a1', 0.05, 'day:2026-07-20');
    const replay = await store.decayForAgent('a1', 0.05, 'day:2026-07-20');

    expect(replay).toEqual({ decayed: 0, pruned: 0, skipped: true });
    expect(adapter.rows.get('m1')!.strength).toBeCloseTo(0.95);
  });

  it('a replay in the same millisecond is refused: Date.now() 1793194099407 with the Math.random() draws 0.5 and 0.50006103515625', async () => {
    // Near 1.8e12 adjacent doubles are 2^-12 apart: these two draws added to
    // one millisecond give one number, and any two draws do about 1 time in
    // 4096.
    const now = 1_793_194_099_407;
    const draws = [0.5, 0.5 + 2 ** -14];
    expect(draws[0]).not.toBe(draws[1]);
    expect(now + draws[0]!).toBe(now + draws[1]!);
    adapter.seed('m1', 'a1', 1.0);
    let draw = 0;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    vi.spyOn(Math, 'random').mockImplementation(() => draws[draw++ % 2]!);
    try {
      const first = await store.decayForAgent('a1', 0.05, 'day:2026-07-20');
      const replay = await store.decayForAgent('a1', 0.05, 'day:2026-07-20');

      expect(first).toEqual({ decayed: 1, pruned: 0 });
      expect(replay).toEqual({ decayed: 0, pruned: 0, skipped: true });
      expect(adapter.rows.get('m1')!.strength).toBeCloseTo(0.95);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('a new cycle id decays again; another agent has independent cycles', async () => {
    adapter.seed('m1', 'a1', 1.0);
    adapter.seed('m2', 'a2', 1.0);

    await store.decayForAgent('a1', 0.05, 'day:2026-07-20');
    await store.decayForAgent('a1', 0.05, 'day:2026-07-21');
    await store.decayForAgent('a2', 0.05, 'day:2026-07-20');

    expect(adapter.rows.get('m1')!.strength).toBeCloseTo(0.9);
    expect(adapter.rows.get('m2')!.strength).toBeCloseTo(0.95);
  });

  it('deletes pre-existing sub-threshold rows and prunes post-decay crossings', async () => {
    adapter.seed('stale', 'a1', 0.09);
    adapter.seed('edge', 'a1', 0.14);
    adapter.seed('healthy', 'a1', 0.5);

    const result = await store.decayForAgent('a1', 0.05, 'day:2026-07-20');

    expect(result).toEqual({ decayed: 1, pruned: 2 });
    expect(adapter.rows.has('stale')).toBe(false);
    expect(adapter.rows.has('edge')).toBe(false);
    expect(adapter.rows.get('healthy')!.strength).toBeCloseTo(0.45);
  });

  it('a mid-transaction failure leaves guard and rows unchanged (atomicity)', async () => {
    adapter.seed('m1', 'a1', 1.0);
    adapter.seed('m2', 'a1', 0.5);
    adapter.failOnWrite = 3; // guard insert + first row write succeed, second row write throws

    await expect(store.decayForAgent('a1', 0.05, 'day:2026-07-20')).rejects.toThrow(
      'injected write failure',
    );

    expect(adapter.cycles.size).toBe(0);
    expect(adapter.rows.get('m1')!.strength).toBe(1.0);
    expect(adapter.rows.get('m2')!.strength).toBe(0.5);

    adapter.failOnWrite = 0;
    const retry = await store.decayForAgent('a1', 0.05, 'day:2026-07-20');
    expect(retry.skipped).toBeUndefined();
    expect(adapter.rows.get('m1')!.strength).toBeCloseTo(0.95);
  });

  it('throws a descriptive error when the adapter lacks transaction support', async () => {
    const bare = new FakeAdapter();
    const noTx = {
      run: bare.run.bind(bare),
      get: bare.get.bind(bare),
      all: bare.all.bind(bare),
      exec: bare.exec.bind(bare),
    };
    const bareStore = new PersonalityMutationStore(noTx);

    await expect(bareStore.decayForAgent('a1', 0.05, 'day:2026-07-20')).rejects.toThrow(
      /transaction-capable/,
    );
  });
});

describe('rate validation', () => {
  it('rejects negative and non-finite rates without touching any state', async () => {
    const adapter = new FakeAdapter();
    adapter.seed('m1', 'a1', 1.0);
    const store = new PersonalityMutationStore(adapter);

    await expect(store.decayForAgent('a1', -0.05, 'day:2026-07-20')).rejects.toThrow(/non-negative/);
    await expect(store.decayForAgent('a1', Number.NaN, 'day:2026-07-20')).rejects.toThrow(/finite/);
    await expect(store.decayForAgent('a1', Infinity, 'day:2026-07-20')).rejects.toThrow(/finite/);

    expect(adapter.rows.get('m1')!.strength).toBe(1.0);
    expect(adapter.cycles.size).toBe(0);
  });
});

/** A mutation for agent a1, as adapt_personality records one. */
const SEED = {
  agentId: 'a1',
  trait: 'openness',
  delta: 0.1,
  reasoning: 'seed',
  baselineValue: 0.5,
  mutatedValue: 0.6,
};

describe('the guard table schema step', () => {
  /**
   * An adapter whose guard table has owner_token when `state.hasColumn` is
   * set: reading the column fails until then, and `onAlter` decides what the
   * ALTER that adds it does. A guard row keeps the first token written to it;
   * the adapter holds no mutations.
   */
  function scriptedAdapter(
    hasColumn: boolean,
    onAlter: (state: { hasColumn: boolean; alters: number }) => void,
  ) {
    const state = { hasColumn, alters: 0 };
    const guards = new Map<string, unknown>();
    const run = async (sql: string, params: unknown[] = []): Promise<unknown> => {
      if (sql.includes('ALTER TABLE personality_decay_cycles ADD COLUMN owner_token TEXT')) {
        state.alters++;
        onAlter(state);
      } else if (sql.includes('INSERT INTO personality_decay_cycles')) {
        const key = `${params[0]}|${params[1]}`;
        if (!guards.has(key)) guards.set(key, params[3]);
      }
      return {};
    };
    const get = async (sql: string, params: unknown[] = []): Promise<unknown> => {
      if (sql.includes('SELECT owner_token FROM personality_decay_cycles')) {
        if (!state.hasColumn) throw new Error('no such column: owner_token');
        const key = `${params[0]}|${params[1]}`;
        return guards.has(key) ? { owner_token: guards.get(key) } : undefined;
      }
      return undefined;
    };
    const all = async (_sql: string, _params: unknown[] = []): Promise<unknown[]> => [];
    const adapter: IStorageAdapter = {
      exec: async (_sql: string): Promise<void> => undefined,
      run,
      get,
      all,
      transaction: async <T>(
        fn: (tx: Pick<IStorageAdapter, 'run' | 'get' | 'all'>) => Promise<T>,
      ): Promise<T> => fn({ run, get, all }),
    };
    return { adapter, state };
  }

  it('recording and loading leave the guard table as it is; a decay reads owner_token first and adds it only when it is missing', async () => {
    const current = scriptedAdapter(true, () => {
      throw new Error('the column is there: no ALTER should run');
    });
    await expect(
      new PersonalityMutationStore(current.adapter).decayForAgent('a1', 0.05, 'day:2026-10-30'),
    ).resolves.toEqual({ decayed: 0, pruned: 0 });
    expect(current.state.alters).toBe(0);

    const earlier = scriptedAdapter(false, (state) => {
      state.hasColumn = true;
    });
    const store = new PersonalityMutationStore(earlier.adapter);
    await store.record(SEED);
    await store.loadForAgent('a1');
    expect(earlier.state.alters).toBe(0);
    await expect(store.decayForAgent('a1', 0.05, 'day:2026-10-30')).resolves.toEqual({ decayed: 0, pruned: 0 });
    expect(earlier.state.alters).toBe(1);
    expect(earlier.state.hasColumn).toBe(true);
  });

  it('a failed ALTER reads the column again: one another process added is kept, any other failure is thrown', async () => {
    const raced = scriptedAdapter(false, (state) => {
      // The other process's ALTER landed between this one's read and its ALTER.
      state.hasColumn = true;
      throw new Error('duplicate column name: owner_token');
    });
    await expect(
      new PersonalityMutationStore(raced.adapter).decayForAgent('a1', 0.05, 'day:2026-10-30'),
    ).resolves.toEqual({ decayed: 0, pruned: 0 });

    const locked = scriptedAdapter(false, () => {
      throw new Error('database is locked');
    });
    await expect(
      new PersonalityMutationStore(locked.adapter).decayForAgent('a1', 0.05, 'day:2026-10-30'),
    ).rejects.toThrow('database is locked');
  });

  it('an ALTER that fails once ("database is locked") fails that decay alone: recording and loading go on, and the next decay runs the ALTER again', async () => {
    const flaky = scriptedAdapter(false, (state) => {
      if (state.alters === 1) throw new Error('database is locked');
      state.hasColumn = true;
    });
    const store = new PersonalityMutationStore(flaky.adapter);

    await expect(store.record(SEED)).resolves.toMatch(/^pm_/);
    await expect(store.decayForAgent('a1', 0.05, 'day:2026-10-30')).rejects.toThrow('database is locked');
    await expect(store.record(SEED)).resolves.toMatch(/^pm_/);
    await expect(store.loadForAgent('a1')).resolves.toEqual([]);
    expect(flaky.state.alters).toBe(1);

    await expect(store.decayForAgent('a1', 0.05, 'day:2026-10-30')).resolves.toEqual({ decayed: 0, pruned: 0 });
    expect(flaky.state.alters).toBe(2);
    expect(flaky.state.hasColumn).toBe(true);
  });
});

describe('the schema step', () => {
  it('a CREATE that fails once ("database is locked") is run again by the next call', async () => {
    const adapter = new FakeAdapter();
    let execs = 0;
    adapter.exec = async (_sql: string): Promise<void> => {
      execs++;
      if (execs === 1) throw new Error('database is locked');
    };
    const store = new PersonalityMutationStore(adapter);

    await expect(store.record(SEED)).rejects.toThrow('database is locked');
    await expect(store.record(SEED)).resolves.toMatch(/^pm_/);
    expect(execs).toBe(2);
  });
});
