/**
 * @file learning-layer.store.test.ts
 * The learning layer over its store. A learner's first session writes the trait row with its operator_set row; a load
 * checks the learner's chain and the row's digest, so a row edited outside the layer, the newest rows deleted with the
 * head set back, and, with learning.ledgerKey, a chain computed without the key are caught and the persona's authored
 * traits render; a persona that moves a learnable trait clamps the kept value into the new band, and one that lowers
 * honesty-humility keeps the higher value rendering. Mode off reads and writes no learned state and keeps the scopes
 * and the deletion index; a run-time freeze or suspension in the store sets the turn's mode. A memory write is
 * recorded pending, written, then kept, or rejected with write_failed, with no row in mode off; a forgotten user's
 * writes are refused, and one that finds the tombstone after it committed is undone; a turn with no learner records
 * under the agent with a second user's id; a store that will not open degrades the layer. A write into a learner's own
 * session on a turn with no learner is the learner's to delete; a write whose verdict does not land because its user
 * was forgotten meanwhile is taken back for good; a suspension another process set holds from a session's open; and
 * two processes that note one session row at once both stay in it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveStorageAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { renderPersonalitySection } from '../../substrate/personas/personalityPrompt';
import {
  createLearningLayer,
  InMemoryLearningStore,
  SqlLearningStore,
  type LearnerContext,
  type LearnerKey,
  type LearningStore,
  type LearningStoreTx,
  type SessionSelfChange,
  type TurnInputForLearning,
  type TurnPreparation,
} from '../index';
import { chainKeyOf, tombstoneHash } from '../ledger/Ledger';
import { parseTraitState, traitDigest } from '../traitState';

const NOW = '2026-10-12T12:00:00.000Z';
const PERSONA = { honesty: 0.9, emotionality: 0.5, extraversion: 0.8, agreeableness: 0.5, conscientiousness: 0.5, openness: 0.5 };
const KEY: LearnerKey = { namespace: 'A', agentKey: 'tutor', userId: '42' };
const CHAIN = chainKeyOf({ namespace: 'A', agentKey: 'tutor', userId: '42' });
const IN_PROCESS = 'in process: the ledger and the state it records end with the process';
const context = (over: Partial<LearnerContext> = {}): LearnerContext => ({ sessionId: 's-1', personaId: 'tutor', authoredTraits: PERSONA, ...over });
const turn = (over: Partial<TurnInputForLearning> = {}): TurnInputForLearning => ({
  turnId: 't-1',
  userId: '42',
  namespace: 'A',
  text: 'Hello.',
  modelIds: ['stub-model'],
  workflowSeat: false,
  ...over,
});
const section = (prepared: TurnPreparation) => prepared.systemPrompts[0]?.content ?? null;
const openSqlite = () => resolveStorageAdapter({ filePath: ':memory:', priority: ['better-sqlite3', 'sqljs'], quiet: true });

/** A memory write the test watches: what it applied and what it undid. */
function memoryWrite(options: { fail?: boolean; onApply?: () => Promise<unknown> } = {}) {
  const applied: string[] = [];
  const undone: string[] = [];
  const input: SessionSelfChange<string> = {
    kind: 'memory_write',
    actor: 'tool:memory_add',
    subject: 'mt-1',
    before: null,
    after: { created: ['mt-1'], changed: [], deleted: [] },
    brainId: 'brain-1',
    apply: async () => {
      if (options.fail) throw new Error('disk full');
      applied.push('mt-1');
      await options.onApply?.();
      return 'mt-1';
    },
    undo: async (id) => {
      undone.push(id);
    },
  };
  return { input, applied, undone };
}

const adapters: StorageAdapter[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  while (adapters.length) await adapters.pop()!.close();
});
const quiet = () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  return vi.spyOn(console, 'warn').mockImplementation(() => undefined);
};

describe("a learner's trait row", () => {
  it('is written at the first session with an operator_set row that carries its digest, and read at the next', async () => {
    quiet();
    const store = new InMemoryLearningStore();
    const layer = createLearningLayer({ store });
    const first = await layer.forLearner(KEY, context());
    const prepared = await first.prepareTurn(turn());
    expect(section(prepared)).toBe(renderPersonalitySection(PERSONA));
    expect(prepared.scopes).toEqual({ learner: 'bound', mode: 'on', userScopeId: 'A/42', personaScopeId: 'A/42::tutor', namespace: 'A' });
    const row = await store.traitRow('A', 'tutor', '42');
    expect(row).toMatchObject({ personaId: 'tutor', version: 1 });
    const rows = await store.chainRows(CHAIN);
    expect(rows.map((r) => [r.rowType, r.kind, r.verdict])).toEqual([
      ['candidate', 'operator_set', 'pending'],
      ['verdict', 'operator_set', 'kept'],
    ]);
    expect(JSON.parse(rows[0].body)).toMatchObject({ actor: 'operator:persona', subject: 'traits', reason: 'created' });
    expect(rows[1].stateDigest).toBe(await traitDigest(parseTraitState(row!.state)));
    await layer.forLearner(KEY, context({ sessionId: 's-2' }));
    expect(await store.chainRows(CHAIN)).toHaveLength(2);
    expect((await store.sessionRowsOf('A', '42')).map((r) => [r.sessionId, r.kind, r.personaId])).toEqual([
      ['s-1', 'learner', 'tutor'],
      ['s-2', 'learner', 'tutor'],
    ]);
    expect((await layer.manifest()).loops.ledger).toEqual({ live: true, detail: `${IN_PROCESS}; unkeyed` });
  });

  it('moves its baseline with the persona, clamps the kept value into the new band and records the move', async () => {
    quiet();
    const store = new InMemoryLearningStore();
    const layer = createLearningLayer({ store });
    await layer.forLearner(KEY, context());
    const moved = await layer.forLearner(KEY, context({ sessionId: 's-2', authoredTraits: { ...PERSONA, extraversion: 0.3 } }));
    // The kept 0.8 is clamped to 0.5, within 0.2 of the new baseline: moderate, where the persona alone renders low.
    expect(section(await moved.prepareTurn(turn()))).toBe(renderPersonalitySection({ ...PERSONA, extraversion: 0.5 }));
    const rows = await store.chainRows(CHAIN);
    expect(rows.map((r) => r.verdict)).toEqual(['pending', 'kept', 'pending', 'kept']);
    expect(JSON.parse(rows[2].body)).toMatchObject({
      actor: 'operator:persona',
      reason: 'persona_changed',
      before: { baseline: { extraversion: 0.8 } },
      after: { baseline: { extraversion: 0.3 }, current: { extraversion: 0.5 } },
    });
  });

  it('keeps rendering honesty-humility when the persona lowers it', async () => {
    quiet();
    const layer = createLearningLayer({ store: new InMemoryLearningStore() });
    await layer.forLearner(KEY, context());
    const lowered = await layer.forLearner(KEY, context({ sessionId: 's-2', authoredTraits: { ...PERSONA, honesty: 0.2 } }));
    expect(section(await lowered.prepareTurn(turn()))).toBe(renderPersonalitySection(PERSONA));
  });

  it('is caught when edited outside the layer, and the authored traits render', async () => {
    const warn = quiet();
    const store = new InMemoryLearningStore();
    const layer = createLearningLayer({ store });
    await layer.forLearner(KEY, context());
    const row = (await store.traitRow('A', 'tutor', '42'))!;
    const edited = JSON.parse(row.state);
    // Inside the lifetime band, so the clamp alone would let it render: extraversion would drop to moderate.
    edited.current.extraversion = 0.6;
    edited.bands.extraversion = 'moderate';
    await store.updateTraitRow({ ...row, state: JSON.stringify(edited), version: row.version + 1 }, row.version);
    const again = await layer.forLearner(KEY, context({ sessionId: 's-2' }));
    expect(section(await again.prepareTurn(turn()))).toBe(renderPersonalitySection(PERSONA));
    expect((await layer.manifest()).loops.ledger).toEqual({ live: true, detail: `${IN_PROCESS}; unkeyed; chain broken for 1 learner` });
    expect(warn.mock.calls.some((call) => String(call[0]).includes('does not verify'))).toBe(true);
  });

  it('is caught when the newest rows that changed it are deleted and the head is set back, on SQLite', async () => {
    quiet();
    const adapter = await openSqlite();
    adapters.push(adapter);
    const layer = createLearningLayer({ storageAdapter: adapter });
    const moved = { ...PERSONA, extraversion: 0.3 };
    await layer.forLearner(KEY, context());
    await layer.forLearner(KEY, context({ sessionId: 's-2', authoredTraits: moved }));
    const rows = await adapter.all<{ id: string; hash: string }>(
      'SELECT id, hash FROM agentos_learning_ledger WHERE chain_key = ? ORDER BY seq',
      [CHAIN],
    );
    expect(rows).toHaveLength(4);
    await adapter.run('DELETE FROM agentos_learning_ledger WHERE chain_key = ? AND seq > 2', [CHAIN]);
    await adapter.run('UPDATE agentos_learning_heads SET last_id = ?, last_hash = ?, seq = 2 WHERE chain_key = ?', [rows[1].id, rows[1].hash, CHAIN]);
    const after = await layer.forLearner(KEY, context({ sessionId: 's-3', authoredTraits: moved }));
    // Every remaining row verifies, but the row holds the moved state, which no remaining row's digest names.
    expect(section(await after.prepareTurn(turn()))).toBe(renderPersonalitySection(moved));
    expect((await layer.manifest()).loops.ledger).toEqual({
      live: true,
      detail: "sql store over the host's storage adapter; unkeyed; chain broken for 1 learner",
    });
  });

  it('with learning.ledgerKey, is caught when the chain was computed without the key, and the manifest says keyed', async () => {
    quiet();
    const store = new InMemoryLearningStore();
    await createLearningLayer({ store }).forLearner(KEY, context());
    const keyed = createLearningLayer({ store, ledgerKey: 'k-secret' });
    const moved = { ...PERSONA, extraversion: 0.3 };
    const session = await keyed.forLearner(KEY, context({ sessionId: 's-2', authoredTraits: moved }));
    expect(section(await session.prepareTurn(turn()))).toBe(renderPersonalitySection(moved));
    expect((await keyed.manifest()).loops.ledger).toEqual({ live: true, detail: `${IN_PROCESS}; keyed; chain broken for 1 learner` });
  });
});

describe('mode off', () => {
  it('reads and writes no learned state, and keeps the scopes and the deletion index', async () => {
    quiet();
    const store = new InMemoryLearningStore();
    const session = await createLearningLayer({ store, mode: 'off' }).forLearner(KEY, context());
    const prepared = await session.prepareTurn(turn());
    expect(prepared).toMatchObject({ learner: 'bound', mode: 'off', scopes: { learner: 'bound', mode: 'off', userScopeId: 'A/42' } });
    expect(await store.traitRow('A', 'tutor', '42')).toBeUndefined();
    expect((await store.sessionRowsOf('A', '42')).map((row) => row.kind)).toEqual(['learner']);
    const { input, applied } = memoryWrite();
    expect(await session.recordSelfChange!(input, { learner: 'bound', namespace: 'A' })).toEqual({ status: 'written', result: 'mt-1' });
    expect(applied).toEqual(['mt-1']);
    expect(await store.chainRows(CHAIN)).toEqual([]);
  });
});

describe('a run-time freeze or suspension in the store', () => {
  it("sets the turn's mode at each turn, and the freeze is read at the call", async () => {
    quiet();
    const store = new InMemoryLearningStore();
    const session = await createLearningLayer({ store }).forLearner(KEY, context());
    expect((await session.prepareTurn(turn())).mode).toBe('on');
    expect(session.isFrozen!()).toBe(false);
    const row = { setBy: 'operator:ops', createdAt: NOW };
    await store.insertFreeze({ ...row, scopeKey: 'learner|A|tutor|42', mode: 'frozen', namespace: 'A', agentKey: 'tutor', userId: '42' });
    expect((await session.prepareTurn(turn())).mode).toBe('frozen');
    expect(session.isFrozen!()).toBe(true);
    expect(session.isFrozen!({ learner: 'none', namespace: 'A' })).toBe(false);
    await store.insertFreeze({ ...row, scopeKey: 'agent|tutor', mode: 'off', namespace: '', agentKey: 'tutor', userId: null });
    const suspended = await session.prepareTurn(turn());
    expect(suspended.mode).toBe('off');
    expect(section(suspended)).toBe(renderPersonalitySection(PERSONA));
    // The freeze on the suspended scope still stops a memory write.
    const { input, applied } = memoryWrite();
    expect(await session.recordSelfChange!(input, { learner: 'bound', namespace: 'A' })).toEqual({ status: 'rejected', reason: 'frozen' });
    expect(applied).toEqual([]);
    await store.deleteFreeze('learner|A|tutor|42', 'frozen');
    await store.deleteFreeze('agent|tutor', 'off');
    await store.insertFreeze({ ...row, scopeKey: 'all', mode: 'frozen', namespace: '', agentKey: null, userId: null });
    expect((await session.prepareTurn(turn())).mode).toBe('frozen');
  });
});

describe('a recorded memory write', () => {
  it('is pending while it writes, then kept, keyed to the learner, and its session row collects it', async () => {
    quiet();
    const store = new InMemoryLearningStore();
    const session = await createLearningLayer({ store }).forLearner(KEY, context());
    const seen: string[] = [];
    const { input, applied } = memoryWrite({
      onApply: async () => {
        const rows = await store.chainRows(CHAIN);
        seen.push(rows[rows.length - 1].verdict);
      },
    });
    const result = await session.recordSelfChange!(input, { learner: 'bound', namespace: 'A', conversationId: 'conv-1' });
    expect(result).toMatchObject({ status: 'kept', result: 'mt-1' });
    expect(seen).toEqual(['pending']);
    expect(applied).toEqual(['mt-1']);
    const rows = (await store.chainRows(CHAIN)).slice(2);
    expect(rows.map((r) => [r.rowType, r.kind, r.verdict])).toEqual([
      ['candidate', 'memory_write', 'pending'],
      ['verdict', 'memory_write', 'kept'],
    ]);
    expect(JSON.parse(rows[0].body)).toMatchObject({
      actor: 'tool:memory_add',
      after: { brainId: 'brain-1', created: ['mt-1'], changed: [], deleted: [] },
      sessionId: 's-1',
    });
    expect((await store.sessionRowsOf('A', '42'))[0]).toMatchObject({ conversationIds: ['conv-1'], brainIds: ['brain-1'] });
  });

  it('is rejected with write_failed when the write fails, and leaves no kept row, on SQLite', async () => {
    quiet();
    const adapter = await openSqlite();
    adapters.push(adapter);
    const store = new SqlLearningStore({ adapter });
    const session = await createLearningLayer({ store }).forLearner(KEY, context());
    const { input } = memoryWrite({ fail: true });
    expect(await session.recordSelfChange!(input, { learner: 'bound', namespace: 'A' })).toMatchObject({ status: 'rejected', reason: 'write_failed' });
    const rows = (await store.chainRows(CHAIN)).filter((r) => r.kind === 'memory_write');
    expect(rows.map((r) => [r.rowType, r.verdict])).toEqual([
      ['candidate', 'pending'],
      ['verdict', 'rejected'],
    ]);
    expect(JSON.parse(rows[1].body).reason).toBe('write_failed');
  });

  it('is refused for a forgotten user, and undone when the tombstone lands while it writes', async () => {
    quiet();
    const store = new InMemoryLearningStore();
    const session = await createLearningLayer({ store }).forLearner(KEY, context());
    const hash = await tombstoneHash('A', '42');
    const racing = memoryWrite({ onApply: () => store.insertForgotten(hash, NOW) });
    expect(await session.recordSelfChange!(racing.input, { learner: 'bound', namespace: 'A' })).toEqual({ status: 'rejected', reason: 'forgotten' });
    expect(racing.undone).toEqual(['mt-1']);
    const late = memoryWrite();
    expect(await session.recordSelfChange!(late.input, { learner: 'bound', namespace: 'A' })).toEqual({ status: 'rejected', reason: 'forgotten' });
    expect(late.applied).toEqual([]);
  });
});

describe("the bridge's guarded encode", () => {
  it('writes between two tombstone reads, and is undone when the tombstone lands while it writes', async () => {
    quiet();
    const store = new InMemoryLearningStore();
    const session = await createLearningLayer({ store }).forLearner(KEY, context());
    expect(await session.guardMemoryWrite!({ apply: async () => 'trace-1', undo: async () => undefined })).toEqual({ status: 'written', result: 'trace-1' });
    const undone: string[] = [];
    const hash = await tombstoneHash('A', '42');
    const result = await session.guardMemoryWrite!({
      apply: async () => {
        await store.insertForgotten(hash, NOW);
        return 'trace-2';
      },
      undo: async (id) => {
        undone.push(id);
      },
    });
    expect(result).toEqual({ status: 'rejected', reason: 'forgotten' });
    expect(undone).toEqual(['trace-2']);
    const never = vi.fn(async () => 'trace-3');
    expect(await session.guardMemoryWrite!({ apply: never, undo: async () => undefined })).toEqual({ status: 'rejected', reason: 'forgotten' });
    expect(never).not.toHaveBeenCalled();
  });
});

describe('a turn with no learner', () => {
  it("records under the agent and the session with a second user's id, and writes that user's visitor row", async () => {
    quiet();
    const store = new InMemoryLearningStore();
    const session = await createLearningLayer({ store }).forLearner(KEY, context());
    await session.prepareTurn(turn());
    const second = await session.prepareTurn(turn({ userId: 'bo' }));
    expect(second).toMatchObject({
      learner: 'none',
      noLearnerReason: 'other_user',
      turnUserId: 'bo',
      scopes: { learner: 'none', userScopeId: 'A//s-1', personaScopeId: 'A//s-1::tutor', namespace: 'A' },
    });
    const { input } = memoryWrite();
    expect(await session.recordSelfChange!(input, { learner: 'none', namespace: 'A', turnUserId: 'bo', conversationId: 'conv-9' })).toMatchObject({
      status: 'kept',
    });
    const rows = await store.chainRows(chainKeyOf({ namespace: 'A', agentKey: 'tutor', userId: null }, 'bo'));
    expect(rows.map((r) => [r.userId, r.turnUserId, r.sessionId, r.verdict])).toEqual([
      [null, 'bo', 's-1', 'pending'],
      [null, 'bo', 's-1', 'kept'],
    ]);
    expect(await store.sessionRowsOf('A', 'bo')).toMatchObject([{ sessionId: 's-1', kind: 'visitor', conversationIds: ['conv-9'], brainIds: ['brain-1'] }]);
    const back = await session.prepareTurn(turn());
    expect(back).toMatchObject({ learner: 'none', noLearnerReason: 'other_user' });
    expect(back.turnUserId).toBeUndefined();
  });

  it("files a placeholder's session under the session's form, and records an explicit user's turn there", async () => {
    quiet();
    const store = new InMemoryLearningStore();
    const session = await createLearningLayer({ store }).forLearner({ ...KEY, userId: 'anonymous' }, context());
    const prepared = await session.prepareTurn(turn({ userId: 'anonymous', namespace: '' }));
    expect(prepared).toMatchObject({ learner: 'none', noLearnerReason: 'placeholder_user', scopes: { userScopeId: '/s-1', personaScopeId: '/s-1::tutor', namespace: '' } });
    expect(prepared.turnUserId).toBeUndefined();
    expect((await session.prepareTurn(turn({ userId: 'ana', namespace: '' }))).turnUserId).toBe('ana');
    // The placeholder's own write records under the agent; the explicit user's under her id, with her visitor row.
    expect(await session.recordSelfChange!(memoryWrite().input, { learner: 'none', namespace: '' })).toMatchObject({ status: 'kept' });
    expect((await store.chainRows(chainKeyOf({ namespace: '', agentKey: 'tutor', userId: null }))).map((r) => r.verdict)).toEqual(['pending', 'kept']);
    expect(await session.recordSelfChange!(memoryWrite().input, { learner: 'none', namespace: '', turnUserId: 'ana' })).toMatchObject({ status: 'kept' });
    expect((await store.chainRows(chainKeyOf({ namespace: '', agentKey: 'tutor', userId: null }, 'ana'))).map((r) => [r.turnUserId, r.verdict])).toEqual([
      ['ana', 'pending'],
      ['ana', 'kept'],
    ]);
    expect(await store.sessionRowsOf('', 'ana')).toMatchObject([{ sessionId: 's-1', kind: 'visitor', brainIds: ['brain-1'] }]);
    expect(session.scopesFor!({ userId: 'ana', namespace: '', workflowSeat: false })).toMatchObject({ learner: 'none', userScopeId: '/s-1' });
  });
});

describe('where the store lives', () => {
  it("is SQL over the host's adapter, and in process for an adapter without transactions", async () => {
    quiet();
    const adapter = await openSqlite();
    adapters.push(adapter);
    expect((await createLearningLayer({ storageAdapter: adapter }).manifest()).loops.ledger.detail).toBe(
      "sql store over the host's storage adapter; unkeyed",
    );
    const noTransactions = { kind: 'kv', capabilities: new Set<string>() } as unknown as StorageAdapter;
    expect((await createLearningLayer({ storageAdapter: noTransactions }).manifest()).loops.ledger.detail).toBe(
      'in process: the storage adapter has no transactions; the ledger and the state it records end with the process; unkeyed',
    );
  });

  it('degrades when it does not open: the authored traits render, writes are refused, the manifest says why', async () => {
    quiet();
    let opens = 0;
    const layer = createLearningLayer({
      openStore: async () => {
        opens += 1;
        throw new Error('brain file locked');
      },
    });
    const session = await layer.forLearner(KEY, context());
    const prepared = await session.prepareTurn(turn());
    expect(section(prepared)).toBe(renderPersonalitySection(PERSONA));
    expect(prepared.scopes).toMatchObject({ learner: 'bound', userScopeId: 'A/42' });
    const { input, applied } = memoryWrite();
    expect(await session.recordSelfChange!(input)).toMatchObject({ status: 'rejected', reason: 'store_unavailable' });
    expect(await session.guardMemoryWrite!({ apply: async () => 1, undo: async () => undefined })).toEqual({ status: 'rejected', reason: 'store_unavailable' });
    expect(applied).toEqual([]);
    const manifest = await layer.manifest();
    expect(manifest.loops.ledger).toEqual({ live: false, detail: 'store unavailable: brain file locked' });
    expect(manifest.loops.personality_rendering).toEqual({ live: true, detail: 'traits: degraded (brain file locked)' });
    expect(opens).toBeGreaterThan(1);
  });
});

/**
 * The store as processes that share it on Postgres at Read Committed meet it: each call a transaction makes commits on
 * its own, so two transactions' reads and writes interleave. `holdNextSessionWrite` stops the next session-row write
 * until `release`; `forgetAfterNextTombstoneRead` commits a user's tombstone and deletes the user's rows right after the
 * next read of a tombstone, as another process's `forgetUser` would.
 */
function readCommitted(base: InMemoryLearningStore) {
  let hold = false;
  let release: () => void = () => undefined;
  let reached: () => void = () => undefined;
  let forget: { namespace: string; userId: string } | undefined;
  const store: LearningStore = new Proxy(base, {
    get(target, prop) {
      if (prop === 'transaction') return <T>(fn: (tx: LearningStoreTx) => Promise<T>): Promise<T> => fn(store);
      if (prop === 'putSessionRow') {
        return async (...args: unknown[]): Promise<void> => {
          if (hold) {
            hold = false;
            await new Promise<void>((resolve) => {
              release = resolve;
              reached();
            });
          }
          return (target.putSessionRow as (...rest: unknown[]) => Promise<void>).apply(target, args);
        };
      }
      if (prop === 'isForgotten') {
        return async (hash: string): Promise<boolean> => {
          const found = await target.isForgotten(hash);
          if (forget) {
            const { namespace, userId } = forget;
            forget = undefined;
            await target.insertForgotten(hash, NOW);
            await target.deleteUserRows(namespace, userId);
          }
          return found;
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...rest: unknown[]) => unknown).bind(target) : value;
    },
  });
  return {
    store,
    holdNextSessionWrite: (): Promise<void> => {
      hold = true;
      return new Promise<void>((resolve) => {
        reached = resolve;
      });
    },
    release: () => release(),
    forgetAfterNextTombstoneRead: (namespace: string, userId: string) => {
      forget = { namespace, userId };
    },
  };
}

/** A memory update the test watches: each reason its undo was given. */
function memoryUpdate(apply: () => Promise<void>, onUndo?: (reason: string) => Promise<void>) {
  const reasons: string[] = [];
  const input: SessionSelfChange<string> = {
    kind: 'memory_write',
    actor: 'tool:memory_update',
    subject: 'mt-1',
    before: { traces: [] },
    after: { created: [], changed: [{ id: 'mt-1', content: 'the new words' }], deleted: [] },
    brainId: 'brain-1',
    apply: async () => {
      await apply();
      return 'mt-1';
    },
    undo: async (_id, reason) => {
      reasons.push(reason);
      await onUndo?.(reason);
    },
  };
  return { input, reasons };
}

describe("a write of a learner's own session on a turn with no learner", () => {
  const own = { learner: 'none' as const, namespace: 'A' };
  const learnerTurns = chainKeyOf({ namespace: 'A', agentKey: 'tutor', userId: null }, '42');

  it("is recorded under the learner's id, so that user's deletion takes its row, and its session row collects it", async () => {
    quiet();
    const store = new InMemoryLearningStore();
    const session = await createLearningLayer({ store }).forLearner(KEY, context());
    // A workflow turn of the learner has no learner and files under the session's own form, which the learner's
    // deletion takes with the learner's sessions.
    expect(await session.prepareTurn(turn({ workflowSeat: true }))).toMatchObject({
      learner: 'none',
      noLearnerReason: 'workflow_seat',
      scopes: { learner: 'none', userScopeId: 'A//s-1' },
    });
    expect(await session.recordSelfChange!(memoryWrite().input, { ...own, conversationId: 'conv-w' })).toMatchObject({ status: 'kept' });
    expect((await store.chainRows(learnerTurns)).map((r) => [r.userId, r.turnUserId, r.sessionId, r.verdict])).toEqual([
      [null, '42', 's-1', 'pending'],
      [null, '42', 's-1', 'kept'],
    ]);
    expect((await store.sessionRowsOf('A', '42')).map((r) => [r.kind, r.conversationIds, r.brainIds])).toEqual([
      ['learner', ['conv-w'], ['brain-1']],
    ]);
    await store.deleteUserRows('A', '42');
    expect(await store.chainRows(learnerTurns)).toEqual([]);
    expect(await store.chainRows(chainKeyOf({ namespace: 'A', agentKey: 'tutor', userId: null }))).toEqual([]);
  });

  it("is filed by the bridge between two reads of the learner's tombstone, and taken back when it lands", async () => {
    quiet();
    const store = new InMemoryLearningStore();
    const session = await createLearningLayer({ store }).forLearner(KEY, context());
    await session.prepareTurn(turn({ workflowSeat: true }));
    const hash = await tombstoneHash('A', '42');
    const undone: string[] = [];
    const filed = await session.guardMemoryWrite!(
      {
        apply: async () => {
          await store.insertForgotten(hash, NOW);
          return 'trace-w';
        },
        undo: async (id) => {
          undone.push(id);
        },
      },
      own,
    );
    expect(filed).toEqual({ status: 'rejected', reason: 'forgotten' });
    expect(undone).toEqual(['trace-w']);
  });

  it("is refused once the learner is forgotten, also on the learner's turn after another user's", async () => {
    quiet();
    const store = new InMemoryLearningStore();
    const session = await createLearningLayer({ store }).forLearner(KEY, context());
    await session.prepareTurn(turn());
    await session.prepareTurn(turn({ userId: 'bo' }));
    expect(await session.prepareTurn(turn())).toMatchObject({ learner: 'none', noLearnerReason: 'other_user' });
    await store.insertForgotten(await tombstoneHash('A', '42'), NOW);
    const late = memoryWrite();
    expect(await session.recordSelfChange!(late.input, own)).toEqual({ status: 'rejected', reason: 'forgotten' });
    expect(late.applied).toEqual([]);
  });
});

describe('a recorded memory write whose verdict does not land', () => {
  const bound = { learner: 'bound' as const, namespace: 'A' };

  it('is taken back for good when another process forgot its user after its tombstone read, never to its before-state', async () => {
    quiet();
    /** A store on which another process's forgetUser commits right after the write's second read of the tombstone. */
    class ForgottenAfterRead extends InMemoryLearningStore {
      armed = false;
      override async isForgotten(hash: string): Promise<boolean> {
        const found = await super.isForgotten(hash);
        if (this.armed) {
          this.armed = false;
          await this.insertForgotten(hash, NOW);
          await this.deleteUserRows('A', '42');
        }
        return found;
      }
    }
    const store = new ForgottenAfterRead();
    const session = await createLearningLayer({ store }).forLearner(KEY, context());
    const update = memoryUpdate(async () => {
      store.armed = true;
    });
    // The deletion took the candidate's rows, so its verdict finds no candidate to decide.
    expect(await session.recordSelfChange!(update.input, bound)).toEqual({ status: 'rejected', reason: 'forgotten' });
    expect(update.reasons).toEqual(['forgotten']);
  });

  it('is taken back for good when its user is forgotten while its before-state is restored', async () => {
    quiet();
    /** A store whose read of the candidate, the verdict's first read, fails once. */
    class VerdictFails extends InMemoryLearningStore {
      armed = false;
      override async ledgerRow(id: string) {
        if (this.armed) {
          this.armed = false;
          throw new Error('connection reset');
        }
        return super.ledgerRow(id);
      }
    }
    const store = new VerdictFails();
    const session = await createLearningLayer({ store }).forLearner(KEY, context());
    const hash = await tombstoneHash('A', '42');
    const update = memoryUpdate(
      async () => {
        store.armed = true;
      },
      async (reason) => {
        // Another process's forgetUser commits while the restore runs.
        if (reason === 'unrecorded') await store.insertForgotten(hash, NOW);
      },
    );
    expect(await session.recordSelfChange!(update.input, bound)).toEqual({ status: 'rejected', reason: 'forgotten' });
    expect(update.reasons).toEqual(['unrecorded', 'forgotten']);
    expect(await store.sessionRowsOf('A', '42')).toEqual([]);
  });

  it("names what a forgotten user's write that could not be taken back left, and where, and promises no second call", async () => {
    const warn = quiet();
    const store = new InMemoryLearningStore();
    const session = await createLearningLayer({ store }).forLearner(KEY, context());
    const hash = await tombstoneHash('A', '42');
    const update = memoryUpdate(
      () => store.insertForgotten(hash, NOW),
      async () => {
        throw new Error('brain file locked');
      },
    );
    expect(await session.recordSelfChange!(update.input, bound)).toEqual({ status: 'rejected', reason: 'forgotten' });
    const lines = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('was not taken back'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('brain brain-1');
    expect(lines[0]).toContain('mt-1');
    expect(lines[0]).not.toContain('42');
    expect(lines[0]).not.toContain('second forgetUser');
  });
});

describe("a forgetUser of another process that commits while a write notes the user's session", () => {
  it("leaves no row of the user's: the write is refused and the row it noted is deleted again", async () => {
    quiet();
    const base = new InMemoryLearningStore();
    const shared = readCommitted(base);
    const session = await createLearningLayer({ store: shared.store }).forLearner(KEY, context());
    shared.forgetAfterNextTombstoneRead('A', '42');
    const { input, applied } = memoryWrite();
    expect(await session.recordSelfChange!(input, { learner: 'bound', namespace: 'A', conversationId: 'conv-1' })).toEqual({
      status: 'rejected',
      reason: 'forgotten',
    });
    expect(applied).toEqual([]);
    expect(await base.sessionRowsOf('A', '42')).toEqual([]);
  });
});

describe('a suspension another process set before a session opens', () => {
  it('holds from the open: the session reads and writes no learned state', async () => {
    quiet();
    const store = new InMemoryLearningStore();
    const layer = createLearningLayer({ store });
    // The layer's store is open, and it has read the freezes once.
    await layer.forLearner(KEY, context());
    await store.insertFreeze({
      scopeKey: 'learner|A|tutor|7',
      mode: 'off',
      namespace: 'A',
      agentKey: 'tutor',
      userId: '7',
      setBy: 'operator:ops',
      createdAt: NOW,
    });
    const session = await layer.forLearner({ ...KEY, userId: '7' }, context({ sessionId: 's-7' }));
    expect(await store.traitRow('A', 'tutor', '7')).toBeUndefined();
    expect(await store.chainRows(chainKeyOf({ namespace: 'A', agentKey: 'tutor', userId: '7' }))).toEqual([]);
    expect((await session.prepareTurn(turn({ userId: '7' }))).mode).toBe('off');
  });
});

describe('a learner whose record does not verify', () => {
  it('stays counted in the manifest while a later read of its record fails', async () => {
    quiet();
    /** A store whose read of a chain, the load check's first read, fails once. */
    class ReadFails extends InMemoryLearningStore {
      armed = false;
      override async chainWithHead(chainKey: string) {
        if (this.armed) {
          this.armed = false;
          throw new Error('connection reset');
        }
        return super.chainWithHead(chainKey);
      }
    }
    const store = new ReadFails();
    const layer = createLearningLayer({ store });
    await layer.forLearner(KEY, context());
    const row = (await store.traitRow('A', 'tutor', '42'))!;
    const edited = JSON.parse(row.state);
    edited.current.extraversion = 0.6;
    await store.updateTraitRow({ ...row, state: JSON.stringify(edited), version: row.version + 1 }, row.version);
    await layer.forLearner(KEY, context({ sessionId: 's-2' }));
    expect((await layer.manifest()).loops.ledger.detail).toBe(`${IN_PROCESS}; unkeyed; chain broken for 1 learner`);
    store.armed = true;
    await layer.forLearner(KEY, context({ sessionId: 's-3' }));
    expect((await layer.manifest()).loops.ledger.detail).toBe(`${IN_PROCESS}; unkeyed; chain broken for 1 learner`);
  });
});

describe('two processes that note one session row at once', () => {
  it("keeps both writes' brains in the learner's row, which the learner's deletion reads", async () => {
    quiet();
    const base = new InMemoryLearningStore();
    const shared = readCommitted(base);
    const first = await createLearningLayer({ store: shared.store }).forLearner(KEY, context());
    const second = await createLearningLayer({ store: shared.store }).forLearner(KEY, context());
    const writeTo = (brainId: string): SessionSelfChange<string> => ({ ...memoryWrite().input, brainId });
    const bound = { learner: 'bound' as const, namespace: 'A' };
    // The second process reads the row, and its write of the row waits while the first process notes the row whole.
    const held = shared.holdNextSessionWrite();
    const late = second.recordSelfChange!(writeTo('brain-2'), bound);
    await held;
    expect(await first.recordSelfChange!(writeTo('brain-1'), bound)).toMatchObject({ status: 'kept' });
    shared.release();
    expect(await late).toMatchObject({ status: 'kept' });
    const [row] = await base.sessionRowsOf('A', '42');
    expect([...row!.brainIds].sort()).toEqual(['brain-1', 'brain-2']);
  });
});
