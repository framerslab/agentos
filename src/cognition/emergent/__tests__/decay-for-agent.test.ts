/**
 * @fileoverview Tests for PersonalityMutationStore.decayForAgent
 * (spec batch-1 C6): agent scoping, cycle-id idempotency via the
 * guard-first transaction, pre-existing sub-threshold pruning, post-decay
 * pruning, atomicity on mid-transaction failure, and the
 * transaction-required error.
 *
 * The fake adapter emulates exactly the SQL statements the store issues
 * (two tables, verb + WHERE pattern matched) with snapshot-rollback
 * transactions, so the decay unit's all-or-nothing behavior is observable
 * without a native sqlite dependency.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { PersonalityMutationStore } from '../PersonalityMutationStore.js';

interface Row { id: string; agentId: string; strength: number }

class FakeAdapter {
  rows = new Map<string, Row>();
  cycles = new Map<string, number>();
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
    if (sql.includes('INSERT OR IGNORE INTO personality_decay_cycles')) {
      this.bump();
      const key = `${params[0]}|${params[1]}`;
      if (!this.cycles.has(key)) this.cycles.set(key, Number(params[2]));
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
      return this.cycles.has(key) ? { applied_at: this.cycles.get(key) } : undefined;
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
