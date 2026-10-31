/**
 * @file learning-layer.forget.test.ts
 * Account deletion and the memory writes a layer takes back, over real memory. forgetUser commits the tombstone, then
 * deletes the user's traces in every memory manager and facade the layer holds (a second user's traces on another
 * user's session by turnUserId), then the user's learning rows, and names the stores it did not reach; another
 * tenant's user of the same id keeps everything; a write in flight reaches its verdict first and is deleted with the
 * rest; with a namespace, the user's plain-form traces are counted and named in one WARNING. A memory write's revert
 * deletes what it created and restores what it deleted; a crash's pending write is decided at the learner's next
 * session by whether its traces hold it, and stays pending where the layer holds no facade of its brain; the agent's
 * chain is read off the open's path, at most once per fifteen minutes.
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
    expect(await store.chainRows(chainKeyOf({ namespace: 'A', agentKey: 'tutor', userId: null }))).toHaveLength(2);
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
    expect(lines[0]).toContain('user:42');
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

  it("reads the agent's chain off the open's path, at most once per fifteen minutes", async () => {
    quiet();
    let now = Date.UTC(2026, 9, 12, 12);
    const { memory: tools } = await facadeAt(tempFile(), 'tools-brain');
    const layer = createLearningLayer({ store: new InMemoryLearningStore(), memoryTools: tools, clock: () => now });
    const agentChain = chainKeyOf({ namespace: 'A', agentKey: 'tutor', userId: null });
    const read = Ledger.prototype.pendingCandidates;
    let agentReads = 0;
    vi.spyOn(Ledger.prototype, 'pendingCandidates').mockImplementation(function (this: Ledger, chainKey: string) {
      if (chainKey !== agentChain) return read.call(this, chainKey);
      agentReads += 1;
      // The agent's chain of a long-lived deployment: a read that has not finished when the learner's session opens.
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
