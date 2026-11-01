/**
 * @file learning-layer.forget.test.ts
 * Account deletion and the memory writes a layer takes back, over real memory. forgetUser commits the tombstone, then
 * deletes the user's traces in every memory manager and facade the layer holds (a second user's traces on another
 * user's session by turnUserId), then the user's learning rows, and names the stores it did not reach; another tenant's
 * user of the same id keeps everything; a write in flight reaches its verdict first and is deleted with the rest; with
 * a namespace, the user's plain-form traces are counted and named in one WARNING that names the tombstone, never the
 * user; a session another process holds stops rendering the forgotten learner's kept traits at its next turn; while a
 * memory store fails, the user's learning rows stay as the index a second call deletes the rest by. A memory write's
 * revert deletes what it created and restores what it deleted, can itself be reverted, and gives a user another process
 * forgets meanwhile nothing back; a crash's pending write is decided at the learner's next session by whether its traces
 * hold it, its undo leaving what a later write changed, and stays pending where the layer holds no facade of its brain;
 * the agent's chains with no learner, a second user's included, are read off the open's path, at most once per fifteen
 * minutes; and a write whose writer decides it while the recovery reads its traces stays as its writer decided it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Memory } from '../../memory/io/facade/Memory';
import { readTraceSnapshot } from '../../memory/retrieval/store/tracePersistence';
import { renderPersonalitySection } from '../../substrate/personas/personalityPrompt';
import {
  createLearningLayer,
  InMemoryLearningStore,
  type LearnerContext,
  type LearnerKey,
  type ProposalResult,
  type SessionSelfChange,
  type TurnInputForLearning,
} from '../index';
import { chainKeyOf, Ledger, tombstoneHash } from '../ledger/Ledger';
import { learnerScopeIds, taggedScopeId } from '../scopes';
import { closeMemory, facadeAt, liveContents, managerOver, MOOD, tempFile } from './helpers/memoryFixtures';

const PERSONA = { honesty: 0.9, extraversion: 0.8 };
const KEY: LearnerKey = { namespace: 'A', agentKey: 'tutor', userId: '42' };
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

afterEach(async () => {
  vi.restoreAllMocks();
  await closeMemory();
});
const quiet = () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  return vi.spyOn(console, 'warn').mockImplementation(() => undefined);
};

/** A memory_add as the tool makes it: the trace's id named first, the write made through the session's recorder. */
function addThrough(
  memory: Memory,
  content: string,
  scope: 'user' | 'persona' | 'thread',
  scopeId: string,
  metadata?: Record<string, unknown>,
): SessionSelfChange<string> {
  const id = `mt-${Math.random().toString(36).slice(2, 10)}`;
  return {
    kind: 'memory_write',
    actor: 'tool:memory_add',
    subject: id,
    before: null,
    after: { created: [id], changed: [], deleted: [] },
    brainId: memory.brainId,
    apply: async () => (await memory.remember(content, { id, scope, scopeId, ...(metadata ? { metadata } : {}) })).id,
    undo: async (traceId) => {
      await memory.deleteTraces([traceId]);
    },
  };
}

/** A memory_update as the tool makes it: the trace's before-state read first, its new content set through the recorder. */
async function changeThrough(memory: Memory, traceId: string, content: string): Promise<SessionSelfChange<string>> {
  const before = (await memory.readTrace(traceId))!;
  return {
    kind: 'memory_write',
    actor: 'tool:memory_update',
    subject: traceId,
    before: { traces: [before] },
    after: { created: [], changed: [{ id: traceId, content }], deleted: [] },
    brainId: memory.brainId,
    apply: async () => {
      await memory.restoreTrace(traceId, { ...before, content });
      return traceId;
    },
    undo: async () => memory.restoreTrace(traceId, before),
  };
}

/** A memory_delete as the tool makes it: the trace's before-state read first, the trace forgotten through the recorder. */
async function deleteThrough(memory: Memory, traceId: string): Promise<SessionSelfChange<string>> {
  const before = (await memory.readTrace(traceId))!;
  return {
    kind: 'memory_write',
    actor: 'tool:memory_delete',
    subject: traceId,
    before: { traces: [before] },
    after: { created: [], changed: [], deleted: [traceId] },
    brainId: memory.brainId,
    apply: async () => {
      await memory.forget(traceId);
      return traceId;
    },
    undo: async () => memory.restoreTrace(traceId, before),
  };
}

const ledgerIdOf = (result: ProposalResult): string => {
  if (result.status !== 'kept') throw new Error(`the write was ${result.status}`);
  return result.ledgerId;
};

describe('forgetUser', () => {
  it("deletes the user's traces in every manager and facade, then the user's learning rows, and keeps another tenant's", async () => {
    quiet();
    const { manager, brain: managerBrain } = await managerOver(tempFile(), 'agent-1');
    const { memory: tools, brain: toolsBrain } = await facadeAt(tempFile(), 'tools-brain');
    const store = new InMemoryLearningStore();
    const layer = createLearningLayer({ store, memoryTools: tools });
    const a = await layer.forLearner(KEY, context({ memory: manager }));
    const b = await layer.forLearner({ ...KEY, namespace: 'B' }, context({ sessionId: 's-9', memory: manager }));
    const ofA = learnerScopeIds(KEY, 'tutor');
    const ofB = learnerScopeIds({ namespace: 'B', userId: '42' }, 'tutor');
    // The bridge's own filing of a turn, guarded by the tombstone.
    const encode = (text: string, scopeId: string) => ({
      apply: () => manager.encode(text, MOOD, 'neutral', { scope: 'user', scopeId }),
      undo: async (trace: { id: string }) => {
        await manager.deleteTraces([trace.id]);
      },
    });
    await a.guardMemoryWrite!(encode('A42 keeps bees.', ofA.userScopeId));
    await a.recordSelfChange!(addThrough(tools, 'A42 likes tea.', 'user', ofA.userScopeId), { learner: 'bound', namespace: 'A', conversationId: 'conv-1' });
    await a.recordSelfChange!(addThrough(tools, 'A42 thread note.', 'thread', taggedScopeId('conv-1', 'A')), {
      learner: 'bound',
      namespace: 'A',
      conversationId: 'conv-1',
    });
    await b.guardMemoryWrite!(encode('B42 keeps goats.', ofB.userScopeId));
    await b.recordSelfChange!(addThrough(tools, 'B42 likes coffee.', 'user', ofB.userScopeId), { learner: 'bound', namespace: 'B' });

    const report = await layer.forgetUser('42', { namespace: 'A' });

    expect(await liveContents(toolsBrain)).toEqual(['B42 likes coffee.']);
    expect(await manager.getStore().getByScope('user', ofA.userScopeId)).toEqual([]);
    expect((await manager.getStore().getByScope('user', ofB.userScopeId)).map((trace) => trace.content)).toEqual(['B42 keeps goats.']);
    // The knowledge graph's episodic copy of A's words went with the trace; B's stays.
    const copies = (await managerBrain.all<{ properties: string }>("SELECT properties FROM knowledge_nodes WHERE type = 'memory'")).map((row) => row.properties);
    expect(copies.some((text) => text.includes('A42 keeps bees.'))).toBe(false);
    expect(copies.some((text) => text.includes('B42 keeps goats.'))).toBe(true);
    expect(await store.traitRow('A', 'tutor', '42')).toBeUndefined();
    expect(await store.chainRows(chainKeyOf(KEY))).toEqual([]);
    expect(await store.sessionRowsOf('A', '42')).toEqual([]);
    expect(await store.traitRow('B', 'tutor', '42')).toBeDefined();
    expect(await store.isForgotten(await tombstoneHash('A', '42'))).toBe(true);
    expect(report).toMatchObject({ userId: '42', namespace: 'A', plainFormLeft: 0 });
    expect(report.stores).toEqual(
      expect.arrayContaining([
        { store: 'memory manager of brain agent-1', reached: true, deleted: 1 },
        { store: 'memory tools facade of brain tools-brain', reached: true, deleted: 2 },
        expect.objectContaining({ store: 'learning store', reached: true }),
        expect.objectContaining({ store: 'the memory archive', reached: false }),
      ]),
    );
    expect(await a.recordSelfChange!(addThrough(tools, 'A42 again.', 'user', ofA.userScopeId))).toEqual({ status: 'rejected', reason: 'forgotten' });
    expect(await liveContents(toolsBrain)).toEqual(['B42 likes coffee.']);
    expect((await a.prepareTurn(turn())).systemPrompts[0]?.content).toBe(renderPersonalitySection(PERSONA));
    await expect(layer.operatorSet({ learner: KEY, traits: 'baseline', by: 'ops' })).rejects.toThrow(/forgotten/);
  });

  it("deletes a second user's traces on another user's session by turnUserId, and keeps the session's own", async () => {
    quiet();
    const { memory: tools, brain } = await facadeAt(tempFile(), 'tools-brain');
    const store = new InMemoryLearningStore();
    const layer = createLearningLayer({ store, memoryTools: tools });
    const session = await layer.forLearner(KEY, context());
    await session.prepareTurn(turn());
    const visitor = await session.prepareTurn(turn({ userId: 'bo' }));
    const form = visitor.scopes!.userScopeId;
    await session.recordSelfChange!(addThrough(tools, 'Bo keeps snakes.', 'user', form, { turnUserId: 'bo' }), {
      learner: 'none',
      namespace: 'A',
      turnUserId: 'bo',
    });
    await session.recordSelfChange!(addThrough(tools, 'A session note.', 'user', form), { learner: 'none', namespace: 'A' });

    const report = await layer.forgetUser('bo', { namespace: 'A' });

    expect(await liveContents(brain)).toEqual(['A session note.']);
    expect(await store.chainRows(chainKeyOf({ namespace: 'A', agentKey: 'tutor', userId: null }, 'bo'))).toEqual([]);
    // The note names no other user on 42's session, so it is 42's: bo's deletion leaves its rows, which 42's would take.
    expect(await store.chainRows(chainKeyOf({ namespace: 'A', agentKey: 'tutor', userId: null }, '42'))).toHaveLength(2);
    expect(await store.chainRows(chainKeyOf({ namespace: 'A', agentKey: 'tutor', userId: null }))).toEqual([]);
    expect(await store.traitRow('A', 'tutor', '42')).toBeDefined();
    expect(report.stores).toContainEqual({ store: 'memory tools facade of brain tools-brain', reached: true, deleted: 1 });
  });

  it('lets a write in flight reach its verdict first, then deletes what it wrote', async () => {
    quiet();
    const { memory: tools, brain } = await facadeAt(tempFile(), 'tools-brain');
    const store = new InMemoryLearningStore();
    const layer = createLearningLayer({ store, memoryTools: tools });
    const session = await layer.forLearner(KEY, context());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = addThrough(tools, 'A42 says hi.', 'user', learnerScopeIds(KEY, 'tutor').userScopeId);
    const writing = session.recordSelfChange!({
      ...write,
      apply: async () => {
        await gate;
        return write.apply();
      },
    });
    const forgetting = layer.forgetUser('42', { namespace: 'A' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await store.isForgotten(await tombstoneHash('A', '42'))).toBe(false);
    release();
    expect((await writing).status).toBe('kept');
    await forgetting;
    expect(await liveContents(brain)).toEqual([]);
    expect(await store.chainRows(chainKeyOf(KEY))).toEqual([]);
  });

  it("with a namespace, counts the user's plain-form traces it leaves and names them in one WARNING", async () => {
    const warn = quiet();
    const { memory: tools } = await facadeAt(tempFile(), 'tools-brain');
    await tools.remember('Filed before the namespace.', { scope: 'user', scopeId: '42' });
    const layer = createLearningLayer({ store: new InMemoryLearningStore(), memoryTools: tools });
    await layer.forLearner(KEY, context());

    const report = await layer.forgetUser('42', { namespace: 'A' });

    expect(report.plainFormLeft).toBe(1);
    const lines = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('refileScope'));
    expect(lines).toHaveLength(1);
    // A line about a forgotten user names the tombstone, never the user: the caller holds the id it deleted.
    expect(lines[0]).toContain(`tombstone ${(await tombstoneHash('A', '42')).slice(0, 16)}`);
    expect(lines[0]).toContain("the user's plain id in its user scope");
    expect(lines[0]).not.toContain('user:42');
  });

  it("stops rendering a forgotten learner's kept traits at the next turn of a session another process holds", async () => {
    quiet();
    const store = new InMemoryLearningStore();
    // Two processes over one store: one serves the learner's session, the other deletes the user.
    const serving = createLearningLayer({ store });
    const deleting = createLearningLayer({ store });
    const session = await serving.forLearner(KEY, context());
    await serving.operatorSet({ learner: KEY, traits: { extraversion: 0.6 }, by: 'ops' });
    expect((await session.prepareTurn(turn())).systemPrompts[0]?.content).toBe(renderPersonalitySection({ ...PERSONA, extraversion: 0.6 }));

    await deleting.forgetUser('42', { namespace: 'A' });

    expect((await session.prepareTurn(turn())).systemPrompts[0]?.content).toBe(renderPersonalitySection(PERSONA));
    expect(session.currentTraits()).toMatchObject({ extraversion: 0.8 });
  });

  it("keeps the user's learning rows while a memory store fails, so a second call deletes what the first could not", async () => {
    quiet();
    const { memory: tools, brain } = await facadeAt(tempFile(), 'tools-brain');
    const store = new InMemoryLearningStore();
    const layer = createLearningLayer({ store, memoryTools: tools });
    const session = await layer.forLearner(KEY, context());
    // The learner's own words on a turn with no learner (a workflow turn) are filed under the session's form, which
    // only the learner's session row names.
    await session.recordSelfChange!(addThrough(tools, 'A42 said this on a workflow turn.', 'user', taggedScopeId('s-1', 'A')), {
      learner: 'none',
      namespace: 'A',
    });
    await session.recordSelfChange!(addThrough(tools, 'A42 likes tea.', 'user', learnerScopeIds(KEY, 'tutor').userScopeId), {
      learner: 'bound',
      namespace: 'A',
    });
    vi.spyOn(tools, 'deleteScope').mockRejectedValueOnce(new Error('database is locked'));

    const first = await layer.forgetUser('42', { namespace: 'A' });

    expect(first.stores).toEqual(
      expect.arrayContaining([
        { store: 'memory tools facade of brain tools-brain', reached: false, reason: 'database is locked' },
        expect.objectContaining({ store: 'learning store', reached: false }),
      ]),
    );
    expect(first.stores.filter((entry) => entry.store.includes('tools-brain'))).toHaveLength(1);
    expect(await store.sessionRowsOf('A', '42')).not.toEqual([]);
    // What stays of a forgotten user is never handed out again.
    expect(await layer.exportLearnedState(KEY)).toMatchObject({ personaId: null, traitState: null, ledger: [] });

    const second = await layer.forgetUser('42', { namespace: 'A' });

    expect(await liveContents(brain)).toEqual([]);
    expect(await store.sessionRowsOf('A', '42')).toEqual([]);
    expect(await store.traitRow('A', 'tutor', '42')).toBeUndefined();
    expect(second.stores).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ store: 'memory tools facade of brain tools-brain', reached: true }),
        expect.objectContaining({ store: 'learning store', reached: true }),
      ]),
    );
  });

  it('refuses a blank user id', async () => {
    await expect(createLearningLayer().forgetUser(' ')).rejects.toThrow(TypeError);
  });
});

describe('a memory write, taken back', () => {
  it('by revert: what it created is deleted, what it deleted comes back, and the original reads reverted', async () => {
    quiet();
    const { memory: tools, brain } = await facadeAt(tempFile(), 'tools-brain');
    const store = new InMemoryLearningStore();
    const layer = createLearningLayer({ store, memoryTools: tools });
    const session = await layer.forLearner(KEY, context());
    const userScopeId = learnerScopeIds(KEY, 'tutor').userScopeId;
    const kept = await tools.remember('Ana keeps bees.', { scope: 'user', scopeId: userScopeId });
    const added = ledgerIdOf(await session.recordSelfChange!(addThrough(tools, 'Ana likes tea.', 'user', userScopeId)));
    const snapshot = (await readTraceSnapshot(brain, brain.brainId, kept.id))!;
    const deleted = ledgerIdOf(
      await session.recordSelfChange!({
        kind: 'memory_write',
        actor: 'tool:memory_delete',
        subject: kept.id,
        before: { traces: [snapshot] },
        after: { created: [], changed: [], deleted: [kept.id] },
        brainId: tools.brainId,
        apply: async () => {
          await tools.forget(kept.id);
          return kept.id;
        },
        undo: async () => tools.restoreTrace(kept.id, snapshot),
      }),
    );
    expect(await liveContents(brain)).toEqual(['Ana likes tea.']);

    const undoAdd = await layer.revert(added, 'ops');
    const undoDelete = await layer.revert(deleted, 'ops');

    expect([undoAdd.kind, undoAdd.actor, undoDelete.actor]).toEqual(['memory_write', 'operator:ops', 'operator:ops']);
    expect(await liveContents(brain)).toEqual(['Ana keeps bees.']);
    expect((await store.candidateRows(added)).map((row) => row.verdict)).toEqual(['pending', 'kept', 'reverted']);
    expect((await store.candidateRows(undoAdd.id)).map((row) => row.verdict)).toEqual(['pending', 'kept']);
    await expect(layer.revert(added, 'ops')).rejects.toThrow(/is reverted/);
  });

  it('by revert of its revert: the change comes back, for a trace it changed and for one it deleted', async () => {
    quiet();
    const { memory: tools, brain } = await facadeAt(tempFile(), 'tools-brain');
    const layer = createLearningLayer({ store: new InMemoryLearningStore(), memoryTools: tools });
    const session = await layer.forLearner(KEY, context());
    const color = await tools.remember('Ana likes red.', { scope: 'user', scopeId: 'A/42' });
    const bees = await tools.remember('Ana keeps bees.', { scope: 'user', scopeId: 'A/42' });
    const changed = ledgerIdOf(await session.recordSelfChange!(await changeThrough(tools, color.id, 'Ana likes blue.')));
    const deleted = ledgerIdOf(await session.recordSelfChange!(await deleteThrough(tools, bees.id)));
    const undoChange = await layer.revert(changed, 'ops');
    const undoDelete = await layer.revert(deleted, 'ops');
    expect(await liveContents(brain)).toEqual(['Ana keeps bees.', 'Ana likes red.']);

    await layer.revert(undoChange.id, 'ops');
    await layer.revert(undoDelete.id, 'ops');

    expect(await liveContents(brain)).toEqual(['Ana likes blue.']);
  });

  it('by revert: a user another process forgets before the revert records its verdict gets nothing back', async () => {
    quiet();
    const { memory: tools, brain } = await facadeAt(tempFile(), 'tools-brain');
    const store = new InMemoryLearningStore();
    const layer = createLearningLayer({ store, memoryTools: tools });
    // Another process over the same store, which holds none of this process's memory.
    const other = createLearningLayer({ store });
    const session = await layer.forLearner(KEY, context());
    const bees = await tools.remember('Ana keeps bees.', { scope: 'user', scopeId: 'A/42' });
    const deleted = ledgerIdOf(await session.recordSelfChange!(await deleteThrough(tools, bees.id)));
    const decide = Ledger.prototype.decide;
    vi.spyOn(Ledger.prototype, 'decide').mockImplementation(async function (this: Ledger, ...args: Parameters<Ledger['decide']>) {
      // The other process's forgetUser commits after the revert last read the tombstone, before its verdict.
      if (args[1] === 'kept' && args[2] === 'reverted') await other.forgetUser('42', { namespace: 'A' });
      return decide.apply(this, args);
    });

    await expect(layer.revert(deleted, 'ops')).rejects.toThrow(/forgotten/);
    expect(await liveContents(brain)).toEqual([]);
  });

  it("by a learner's next session when a crash left it pending: kept where its traces hold it, else taken back", async () => {
    quiet();
    let now = Date.UTC(2026, 9, 12, 12);
    const { memory: tools } = await facadeAt(tempFile(), 'tools-brain');
    const store = new InMemoryLearningStore();
    const layer = createLearningLayer({ store, memoryTools: tools, clock: () => now });
    await layer.forLearner(KEY, context());
    // Another process's writes that stopped between the write and its verdict.
    const crashed = new Ledger({ store, clock: () => now });
    const pending = async (created: string, brainId = 'tools-brain') => {
      const result = await crashed.propose({
        learner: KEY,
        kind: 'memory_write',
        actor: 'tool:memory_add',
        subject: created,
        before: null,
        after: { brainId, created: [created], changed: [], deleted: [] },
        sessionId: 's-0',
      });
      if (!('candidate' in result)) throw new Error(result.status);
      return result.candidate.id;
    };
    const held = await pending('mt-held');
    await tools.remember('Written before the crash.', { id: 'mt-held', scope: 'user', scopeId: 'A/42' });
    const lost = await pending('mt-lost');
    const elsewhere = await pending('mt-x', 'brain-not-here');
    const young = await pending('mt-young');

    now += 16 * 60_000;
    const late = await pending('mt-late');
    await layer.forLearner(KEY, context({ sessionId: 's-2' }));

    const verdict = (id: string) => crashed.latestVerdict(id);
    expect(await verdict(held)).toBe('kept');
    expect(await verdict(lost)).toBe('rejected');
    expect(await verdict(elsewhere)).toBe('pending');
    expect(await verdict(young)).toBe('rejected');
    expect(await verdict(late)).toBe('pending');
  });

  it("by a learner's next session leaves a trace a later write changed as that write left it", async () => {
    quiet();
    let now = Date.UTC(2026, 9, 12, 12);
    const { memory: tools, brain } = await facadeAt(tempFile(), 'tools-brain');
    const store = new InMemoryLearningStore();
    const layer = createLearningLayer({ store, memoryTools: tools, clock: () => now });
    const session = await layer.forLearner(KEY, context());
    const color = await tools.remember('Ana likes red.', { scope: 'user', scopeId: 'A/42' });
    // Another process's update that stopped after its pending row, before it wrote.
    const crashed = new Ledger({ store, clock: () => now });
    const update = await changeThrough(tools, color.id, 'Ana likes blue.');
    const proposed = await crashed.propose({
      learner: KEY,
      kind: 'memory_write',
      actor: update.actor,
      subject: update.subject,
      before: update.before,
      after: { brainId: 'tools-brain', ...update.after },
      sessionId: 's-0',
    });
    if (!('candidate' in proposed)) throw new Error(proposed.status);
    // The learner changes the same trace again, and that change is kept.
    ledgerIdOf(await session.recordSelfChange!(await changeThrough(tools, color.id, 'Ana likes green.')));
    now += 16 * 60_000;

    await layer.forLearner(KEY, context({ sessionId: 's-2' }));

    expect(await crashed.latestVerdict(proposed.candidate.id)).toBe('rejected');
    expect(await liveContents(brain)).toEqual(['Ana likes green.']);
  });

  it("by a learner's next session leaves a trace a later write deleted, deleted", async () => {
    quiet();
    let now = Date.UTC(2026, 9, 12, 12);
    const { memory: tools, brain } = await facadeAt(tempFile(), 'tools-brain');
    const store = new InMemoryLearningStore();
    const layer = createLearningLayer({ store, memoryTools: tools, clock: () => now });
    const session = await layer.forLearner(KEY, context());
    const bees = await tools.remember('Ana keeps bees.', { scope: 'user', scopeId: 'A/42' });
    const hives = await tools.remember('Ana keeps hives.', { scope: 'user', scopeId: 'A/42' });
    // Another process's merge of the two into a new trace that stopped after its pending row, before it wrote.
    const crashed = new Ledger({ store, clock: () => now });
    const proposed = await crashed.propose({
      learner: KEY,
      kind: 'memory_write',
      actor: 'tool:memory_merge',
      subject: 'mt-merged',
      before: { traces: [(await tools.readTrace(bees.id))!, (await tools.readTrace(hives.id))!] },
      after: { brainId: 'tools-brain', created: ['mt-merged'], changed: [], deleted: [bees.id, hives.id] },
      sessionId: 's-0',
    });
    if (!('candidate' in proposed)) throw new Error(proposed.status);
    // The learner deletes one of them, and that delete is kept.
    ledgerIdOf(await session.recordSelfChange!(await deleteThrough(tools, bees.id)));
    now += 16 * 60_000;

    await layer.forLearner(KEY, context({ sessionId: 's-2' }));

    expect(await crashed.latestVerdict(proposed.candidate.id)).toBe('rejected');
    expect(await liveContents(brain)).toEqual(['Ana keeps hives.']);
  });

  it("decides a crash's pending write of a second user's turn and of a turn with no user, off the open's path", async () => {
    quiet();
    let now = Date.UTC(2026, 9, 12, 12);
    const { memory: tools } = await facadeAt(tempFile(), 'tools-brain');
    const store = new InMemoryLearningStore();
    const layer = createLearningLayer({ store, memoryTools: tools, clock: () => now });
    const crashed = new Ledger({ store, clock: () => now });
    const pending = async (created: string, turnUserId?: string) => {
      const result = await crashed.propose({
        learner: { namespace: 'A', agentKey: 'tutor', userId: null },
        kind: 'memory_write',
        actor: 'tool:memory_add',
        subject: created,
        before: null,
        after: { brainId: 'tools-brain', created: [created], changed: [], deleted: [] },
        sessionId: 's-0',
        ...(turnUserId ? { turnUserId } : {}),
      });
      if (!('candidate' in result)) throw new Error(result.status);
      return result.candidate.id;
    };
    // Bo spoke on another user's session (its own chain of a second user); the other write had no user.
    const visitor = await pending('mt-bo', 'bo');
    await tools.remember('Bo keeps snakes.', { id: 'mt-bo', scope: 'user', scopeId: 'A//s-0', metadata: { turnUserId: 'bo' } });
    const anonymous = await pending('mt-lost');
    now += 16 * 60_000;

    await layer.forLearner(KEY, context());

    await vi.waitFor(async () => {
      expect(await crashed.latestVerdict(visitor)).toBe('kept');
      expect(await crashed.latestVerdict(anonymous)).toBe('rejected');
    });
  });

  it('leaves a pending write to its writer when the writer decides it while the recovery reads its traces', async () => {
    quiet();
    let now = Date.UTC(2026, 9, 12, 12);
    const { memory: tools, brain } = await facadeAt(tempFile(), 'tools-brain');
    const store = new InMemoryLearningStore();
    const layer = createLearningLayer({ store, memoryTools: tools, clock: () => now });
    await layer.forLearner(KEY, context());
    // Another process's write that has run for 16 minutes on this layer's clock: a slow write, or a clock behind.
    const writer = new Ledger({ store, clock: () => now });
    const proposed = await writer.propose({
      learner: KEY,
      kind: 'memory_write',
      actor: 'tool:memory_add',
      subject: 'mt-slow',
      before: null,
      after: { brainId: 'tools-brain', created: ['mt-slow'], changed: [], deleted: [] },
      sessionId: 's-0',
    });
    if (!('candidate' in proposed)) throw new Error(proposed.status);
    const id = proposed.candidate.id;
    now += 16 * 60_000;
    const read = tools.readTrace.bind(tools);
    vi.spyOn(tools, 'readTrace').mockImplementationOnce(async (traceId: string) => {
      const seen = await read(traceId);
      // The write and its verdict land while the recovery reads the trace the write names.
      await tools.remember('Written late.', { id: 'mt-slow', scope: 'user', scopeId: 'A/42' });
      await writer.decide(id, 'kept', 'written');
      return seen;
    });

    await layer.forLearner(KEY, context({ sessionId: 's-2' }));

    expect(await writer.latestVerdict(id)).toBe('kept');
    expect(await liveContents(brain)).toEqual(['Written late.']);
  });

  it("reads the agent's chains off the open's path, at most once per fifteen minutes", async () => {
    quiet();
    let now = Date.UTC(2026, 9, 12, 12);
    const { memory: tools } = await facadeAt(tempFile(), 'tools-brain');
    const layer = createLearningLayer({ store: new InMemoryLearningStore(), memoryTools: tools, clock: () => now });
    let agentReads = 0;
    vi.spyOn(Ledger.prototype, 'agentPending').mockImplementation(() => {
      agentReads += 1;
      // The agent's chains of a long-lived deployment: a read that has not finished when the learner's session opens.
      return new Promise<never>(() => undefined);
    });

    await layer.forLearner(KEY, context());
    await layer.forLearner({ ...KEY, userId: '7' }, context({ sessionId: 's-2' }));
    expect(agentReads).toBe(1);

    now += 16 * 60_000;
    await layer.forLearner(KEY, context({ sessionId: 's-3' }));
    expect(agentReads).toBe(2);
  });
});
