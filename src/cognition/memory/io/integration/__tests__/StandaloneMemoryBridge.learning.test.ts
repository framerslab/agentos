/**
 * @file StandaloneMemoryBridge.learning.test.ts
 * The standalone retriever and the rolling-summary sink where a learning layer runs: a real layer, a real learning
 * store and a real Memory facade on a SQLite file, each call carrying what the turn pipeline hands them (the GMI's
 * learner session asked for the turn's scope ids and its recorder before the GMI prepares the turn). A learner's
 * summary goes under the learner's scope ids as one recorded upsert, and the retriever reads it back for that learner
 * and for no other tenant's user of the same id; a text that did not change is kept with no row, and one that changed
 * is replaced, the kept verdict naming what the upsert wrote and forgot; a turn with no learner files under its
 * session's form; a second user's summary goes with forgetUser for that user; an upsert whose second write fails
 * takes back the first; a forget that fails is kept and made at the next upsert; a compaction that finishes after
 * forgetUser writes nothing back, with the facade on a file of its own and on the learning store's adapter; a freeze
 * stops the sink and mode off writes with no row; revert takes an upsert back; a crash's pending upsert is decided at
 * the learner's next session; an organization's shared summary is read on that organization's turns alone; scope ids
 * the sink cannot record under file nothing, and so does an upsert while the
 * learning store will not open; a scope delete for one user takes
 * the traces that name the user among their contributors; and with no learning layer both run as before.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveStorageAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import type { RollingSummaryMemoryUpdate } from '../../../../../core/conversation/IRollingSummaryMemorySink';
import {
  DEFAULT_LONG_TERM_MEMORY_POLICY,
  type ResolvedLongTermMemoryPolicy,
} from '../../../../../core/conversation/LongTermMemoryPolicy';
import {
  createLearningLayer,
  InMemoryLearningStore,
  turnLearningBeforePreparation,
  type ILearnerSession,
  type LearnerContext,
  type LearnerKey,
  type TurnLearningBeforePreparation,
} from '../../../../learning/index';
import { chainKeyOf, Ledger } from '../../../../learning/ledger/Ledger';
import type { LearningStore } from '../../../../learning/store/LearningStore';
import { SqlLearningStore } from '../../../../learning/store/SqlLearningStore';
import { closeMemory, facadeAt, liveContents, tempFile } from '../../../../learning/__tests__/helpers/memoryFixtures';
import type { Brain } from '../../../retrieval/store/Brain';
import { Memory } from '../../facade/Memory';
import { createStandaloneMemoryLongTermRetriever, createStandaloneMemoryRollingSummarySink } from '../StandaloneMemoryBridge';

const PERSONA_ID = 'tutor';
const LEARNER_A: LearnerKey = { namespace: 'A', agentKey: 'tutor', userId: '42' };
const LEARNER_B: LearnerKey = { namespace: 'B', agentKey: 'tutor', userId: '42' };
const ANONYMOUS: LearnerKey = { namespace: '', agentKey: 'tutor', userId: 'anonymous_user' };
const contextOf = (sessionId: string): LearnerContext => ({ sessionId, personaId: PERSONA_ID, authoredTraits: {} });
/** The conversation, user and persona scopes on, as a host's request turns them on. */
const POLICY: ResolvedLongTermMemoryPolicy = {
  ...DEFAULT_LONG_TERM_MEMORY_POLICY,
  scopes: { conversation: true, user: true, persona: true, organization: false },
};
/** The user scope alone, so each upsert writes one summary and its atomic documents. */
const USER_ONLY: ResolvedLongTermMemoryPolicy = {
  ...DEFAULT_LONG_TERM_MEMORY_POLICY,
  scopes: { conversation: false, user: true, persona: false, organization: false },
};

/** Adapters a test opened over a facade's file; closed before the fixtures remove the directories. */
const adapters: StorageAdapter[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  while (adapters.length) await adapters.pop()!.close();
  await closeMemory();
});

const quiet = () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
};

/** What the turn pipeline hands the retriever and the sink for one turn, asked before the GMI prepares it. */
function turnOf(
  session: ILearnerSession,
  turn: { userId: string; namespace: string; conversationId: string },
): TurnLearningBeforePreparation {
  const learning = turnLearningBeforePreparation(session, {
    userId: turn.userId,
    namespace: turn.namespace,
    workflowSeat: false,
    conversationId: turn.conversationId,
  });
  if (!learning) throw new Error('the learner session named no scope ids');
  return learning;
}

/** A compaction's update as the pipeline builds it: with a turn's learning where the GMI has a learner session. */
function updateOf(
  learning: TurnLearningBeforePreparation | undefined,
  turn: {
    userId: string;
    organizationId?: string;
    conversationId: string;
    summaryText: string;
    summaryJson?: unknown;
    policy?: ResolvedLongTermMemoryPolicy;
    contributorIds?: string[];
  },
): RollingSummaryMemoryUpdate {
  return {
    userId: turn.userId,
    ...(turn.organizationId ? { organizationId: turn.organizationId } : {}),
    sessionId: turn.conversationId,
    conversationId: turn.conversationId,
    personaId: PERSONA_ID,
    memoryPolicy: turn.policy ?? POLICY,
    summaryText: turn.summaryText,
    summaryJson: turn.summaryJson ?? null,
    ...(learning
      ? {
          turnScopes: learning.scopes,
          ...(learning.recordSelfChange ? { recordSelfChange: learning.recordSelfChange } : {}),
          contributorIds: turn.contributorIds ?? [turn.userId],
        }
      : {}),
  };
}

/** The live traces of a Brain: scope, scope id, text, and the contributors a trace records. */
async function filed(brain: Brain): Promise<Array<{ scope: string; scopeId: string; content: string; contributorIds?: string[] }>> {
  const rows = await brain.all<{ scope: string; scope_id: string; content: string; metadata: string | null }>(
    'SELECT scope, scope_id, content, metadata FROM memory_traces WHERE deleted = 0 ORDER BY scope, scope_id, content',
  );
  return rows.map((row) => {
    const contributorIds = (JSON.parse(row.metadata || '{}') as { contributorIds?: string[] }).contributorIds;
    return { scope: row.scope, scopeId: row.scope_id, content: row.content, ...(contributorIds ? { contributorIds } : {}) };
  });
}

/** The summary line of each live summary, in order. */
async function summaries(brain: Brain): Promise<string[]> {
  return (await filed(brain)).map((trace) => trace.content.split('\n\n')[1] ?? trace.content);
}

/** The sink's rows of one chain, oldest first. */
async function sinkRows(
  store: LearningStore,
  chainKey: string,
): Promise<Array<{ id: string; rowType: string; verdict: string; reason: string; after: { created?: string[]; deleted?: string[]; brainId?: string } | null }>> {
  return (await store.chainRows(chainKey))
    .filter((row) => row.kind === 'memory_write' && JSON.parse(row.body).actor === 'memory:rolling_summary')
    .map((row) => {
      const body = JSON.parse(row.body) as { reason: string; after: { created?: string[]; deleted?: string[]; brainId?: string } | null };
      return { id: row.id, rowType: row.rowType, verdict: row.verdict, reason: body.reason, after: body.after };
    });
}

/** A layer over an in-process store, the sink's facade on a SQLite file of its own, handed to the layer. */
async function setUp(options: { mode?: 'on' | 'off' } = {}) {
  const store = new InMemoryLearningStore();
  const { memory, brain } = await facadeAt(tempFile(), 'sink-brain');
  const layer = createLearningLayer({ store, memoryTools: memory, ...(options.mode ? { mode: options.mode } : {}) });
  return {
    store,
    memory,
    brain,
    layer,
    sink: createStandaloneMemoryRollingSummarySink(memory),
    retriever: createStandaloneMemoryLongTermRetriever(memory),
  };
}

describe("a learner's summary", () => {
  it("goes under the learner's scope ids as one recorded upsert, and the retriever reads it back for that learner and for no other tenant's user of the same id", async () => {
    quiet();
    const { store, brain, layer, sink, retriever } = await setUp();
    const ofA = turnOf(await layer.forLearner(LEARNER_A, contextOf('s-a')), { userId: '42', namespace: 'A', conversationId: 'c-a' });
    await sink.upsertRollingSummaryMemory(
      updateOf(ofA, { userId: '42', organizationId: 'A', conversationId: 'c-a', summaryText: '- Canary HERON-5: flies kites.' }),
    );

    const summary = 'Rolling summary for conversation c-a (persona tutor).\n\n- Canary HERON-5: flies kites.';
    expect(await filed(brain)).toEqual([
      { scope: 'persona', scopeId: 'A/42::tutor', content: summary, contributorIds: ['42'] },
      { scope: 'thread', scopeId: 'A//c-a', content: summary, contributorIds: ['42'] },
      { scope: 'user', scopeId: 'A/42', content: summary, contributorIds: ['42'] },
    ]);
    const rows = await sinkRows(store, chainKeyOf(LEARNER_A));
    expect(rows.map((row) => [row.rowType, row.verdict])).toEqual([
      ['candidate', 'pending'],
      ['verdict', 'kept'],
    ]);
    expect(rows[1]!.after).toEqual({ brainId: 'sink-brain', created: expect.any(Array), changed: [], deleted: [] });
    expect(rows[1]!.after!.created).toHaveLength(3);

    const query = { mode: 'chat', personaId: PERSONA_ID, memoryPolicy: POLICY, queryText: 'kites' };
    const nextA = turnOf(await layer.forLearner(LEARNER_A, contextOf('s-a2')), { userId: '42', namespace: 'A', conversationId: 'c-a2' });
    const ofB = turnOf(await layer.forLearner(LEARNER_B, contextOf('s-b')), { userId: '42', namespace: 'B', conversationId: 'c-b' });
    const readA = await retriever.retrieveLongTermMemory({ ...query, userId: '42', organizationId: 'A', conversationId: 'c-a2', turnScopes: nextA.scopes });
    const readB = await retriever.retrieveLongTermMemory({ ...query, userId: '42', organizationId: 'B', conversationId: 'c-b', turnScopes: ofB.scopes });

    expect(readA?.contextText).toContain('HERON-5');
    expect(readB).toBeNull();
  });

  it('keeps a text that did not change with no row, and replaces one that changed, its kept verdict naming what it wrote and forgot', async () => {
    quiet();
    const { store, brain, layer, sink } = await setUp();
    const session = await layer.forLearner(LEARNER_A, contextOf('s-a'));
    const upsert = (summaryText: string, fact: string) =>
      sink.upsertRollingSummaryMemory(
        updateOf(turnOf(session, { userId: '42', namespace: 'A', conversationId: 'c-a' }), {
          userId: '42',
          organizationId: 'A',
          conversationId: 'c-a',
          summaryText,
          summaryJson: { facts: [{ text: fact }] },
          policy: USER_ONLY,
        }),
      );

    await upsert('- likes tea', 'Ana likes tea.');
    await upsert('- likes tea', 'Ana likes tea.');
    expect((await sinkRows(store, chainKeyOf(LEARNER_A))).map((row) => row.rowType)).toEqual(['candidate', 'verdict']);

    await upsert('- likes green tea', 'Ana likes green tea.');
    const rows = await sinkRows(store, chainKeyOf(LEARNER_A));
    expect(rows.map((row) => [row.rowType, row.verdict])).toEqual([
      ['candidate', 'pending'],
      ['verdict', 'kept'],
      ['candidate', 'pending'],
      ['verdict', 'kept'],
    ]);
    const first = rows[1]!.after!;
    const second = rows[3]!.after!;
    expect(second.created).toHaveLength(2);
    expect([...second.deleted!].sort()).toEqual([...first.created!].sort());
    expect((await filed(brain)).map((trace) => trace.content)).toEqual([
      'Fact: Ana likes green tea.',
      'Rolling summary for conversation c-a (persona tutor).\n\n- likes green tea',
    ]);
  });
});

describe('a turn with no learner', () => {
  it("files under its session's form, with a row of no user on the agent's chain", async () => {
    quiet();
    const { store, brain, layer, sink } = await setUp();
    const anonymous = turnOf(await layer.forLearner(ANONYMOUS, contextOf('s-anon')), {
      userId: 'anonymous_user',
      namespace: '',
      conversationId: 'c-anon',
    });
    expect(anonymous.scopes).toMatchObject({ learner: 'none', userScopeId: '/s-anon', personaScopeId: '/s-anon::tutor' });
    expect(anonymous.turnUserId).toBeUndefined();

    await sink.upsertRollingSummaryMemory(
      updateOf(anonymous, { userId: 'anonymous_user', conversationId: 'c-anon', summaryText: '- asked about trains', contributorIds: [] }),
    );

    expect((await filed(brain)).map((trace) => [trace.scope, trace.scopeId, trace.contributorIds])).toEqual([
      ['persona', '/s-anon::tutor', undefined],
      ['thread', '/c-anon', undefined],
      ['user', '/s-anon', undefined],
    ]);
    const agentChain = chainKeyOf({ namespace: '', agentKey: 'tutor', userId: null });
    expect((await sinkRows(store, agentChain)).map((row) => row.verdict)).toEqual(['pending', 'kept']);
  });

  it("records a second user's summary on another user's session under that user, and forgetUser for that user takes it and leaves the learner's", async () => {
    quiet();
    const { store, brain, layer, sink } = await setUp();
    const session = await layer.forLearner(LEARNER_A, contextOf('s-1'));
    await sink.upsertRollingSummaryMemory(
      updateOf(turnOf(session, { userId: '42', namespace: 'A', conversationId: 'c-1' }), {
        userId: '42',
        organizationId: 'A',
        conversationId: 'c-1',
        summaryText: '- 42 keeps bees',
        policy: USER_ONLY,
      }),
    );
    const visitor = turnOf(session, { userId: 'bo', namespace: 'A', conversationId: 'c-1' });
    expect(visitor.scopes).toMatchObject({ learner: 'none', userScopeId: 'A//s-1' });
    expect(visitor.turnUserId).toBe('bo');

    await sink.upsertRollingSummaryMemory(
      updateOf(visitor, {
        userId: 'bo',
        organizationId: 'A',
        conversationId: 'c-1',
        summaryText: '- bo keeps goats',
        policy: USER_ONLY,
        contributorIds: ['42', 'bo'],
      }),
    );
    const visitorChain = chainKeyOf({ namespace: 'A', agentKey: 'tutor', userId: null }, 'bo');
    expect((await sinkRows(store, visitorChain)).map((row) => row.verdict)).toEqual(['pending', 'kept']);
    expect((await filed(brain)).map((trace) => [trace.scopeId, trace.contributorIds])).toEqual([
      ['A//s-1', ['42', 'bo']],
      ['A/42', ['42']],
    ]);

    await layer.forgetUser('bo', { namespace: 'A' });

    expect((await filed(brain)).map((trace) => trace.scopeId)).toEqual(['A/42']);
    expect(await store.chainRows(visitorChain)).toEqual([]);
    expect(await store.sessionRowsOf('A', 'bo')).toEqual([]);
  });
});

describe('a write that fails', () => {
  it('takes back an upsert whose second write fails, and records it rejected (write_failed) with nothing changed', async () => {
    quiet();
    const { store, brain, memory, layer, sink } = await setUp();
    const learning = turnOf(await layer.forLearner(LEARNER_A, contextOf('s-a')), { userId: '42', namespace: 'A', conversationId: 'c-a' });
    const remember = memory.remember.bind(memory);
    let calls = 0;
    vi.spyOn(memory, 'remember').mockImplementation(async (content, options) => {
      calls += 1;
      if (calls === 2) throw new Error('disk full');
      return remember(content, options);
    });

    await expect(
      sink.upsertRollingSummaryMemory(
        updateOf(learning, {
          userId: '42',
          organizationId: 'A',
          conversationId: 'c-a',
          summaryText: '- likes tea',
          summaryJson: { facts: [{ text: 'Ana likes tea.' }] },
          policy: USER_ONLY,
        }),
      ),
    ).rejects.toThrow(/write_failed/);

    expect(await filed(brain)).toEqual([]);
    expect((await sinkRows(store, chainKeyOf(LEARNER_A))).map((row) => [row.verdict, row.reason])).toEqual([
      ['pending', 'pending'],
      ['rejected', 'write_failed'],
    ]);
  });

  it('keeps an upsert whose forget fails with what it did forget, and makes the forget at the next upsert', async () => {
    quiet();
    const { store, brain, memory, layer, sink } = await setUp();
    const session = await layer.forLearner(LEARNER_A, contextOf('s-a'));
    const upsert = (summaryText: string) =>
      sink.upsertRollingSummaryMemory(
        updateOf(turnOf(session, { userId: '42', namespace: 'A', conversationId: 'c-a' }), {
          userId: '42',
          organizationId: 'A',
          conversationId: 'c-a',
          summaryText,
          policy: USER_ONLY,
        }),
      );
    await upsert('- first');
    vi.spyOn(memory, 'forget').mockRejectedValueOnce(new Error('locked'));
    await upsert('- second');

    const rows = await sinkRows(store, chainKeyOf(LEARNER_A));
    expect(rows.map((row) => row.verdict)).toEqual(['pending', 'kept', 'pending', 'kept']);
    expect(rows[3]!.after!.deleted).toEqual([]);
    expect(await summaries(brain)).toEqual(['- first', '- second']);

    await upsert('- second');
    expect(await summaries(brain)).toEqual(['- second']);
    const retried = (await sinkRows(store, chainKeyOf(LEARNER_A)))[5]!.after!;
    expect(retried.created).toEqual([]);
    expect(retried.deleted).toEqual(rows[1]!.after!.created);
  });
});

/**
 * The facade a test's sink runs over and the learning store, in the two layouts the spec names: the facade on a
 * SQLite file of its own beside an in-process store, and the facade on the learning store's own adapter.
 */
async function layoutOf(layout: 'own' | 'shared'): Promise<{ store: LearningStore; memory: Memory; brain: Brain }> {
  if (layout === 'own') {
    const { memory, brain } = await facadeAt(tempFile(), 'sink-brain');
    return { store: new InMemoryLearningStore(), memory, brain };
  }
  const adapter = await resolveStorageAdapter({ filePath: tempFile(), priority: ['better-sqlite3', 'sqljs'], quiet: true });
  adapters.push(adapter);
  // The facade is never closed: closing its Brain would close the adapter the store shares; afterEach closes it.
  const memory = await Memory.createWithAdapter(adapter, { brainId: 'sink-brain', selfImprove: false });
  return { store: new SqlLearningStore({ adapter }), memory, brain: (memory as unknown as { _brain: Brain })._brain };
}

describe.each([
  ['on a SQLite file of its own', 'own'],
  ["on the learning store's adapter", 'shared'],
] as const)('a compaction and forgetUser, with the facade %s', (_name, layout) => {
  it('writes nothing back for a compaction admitted before forgetUser ran to completion and written after it', async () => {
    quiet();
    const { store, memory, brain } = await layoutOf(layout);
    const layer = createLearningLayer({ store, memoryTools: memory });
    // A second layer over the same store stands for another process: its write chains do not order this one's.
    const otherProcess = createLearningLayer({ store, memoryTools: memory });
    const sink = createStandaloneMemoryRollingSummarySink(memory);
    const learning = turnOf(await layer.forLearner(LEARNER_A, contextOf('s-1')), { userId: '42', namespace: 'A', conversationId: 'c-1' });
    const remember = memory.remember.bind(memory);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const atWrite = new Promise<void>((resolve) => (reached = resolve));
    vi.spyOn(memory, 'remember').mockImplementationOnce(async (content, options) => {
      reached();
      await held;
      return remember(content, options);
    });

    const upserting = sink.upsertRollingSummaryMemory(
      updateOf(learning, { userId: '42', organizationId: 'A', conversationId: 'c-1', summaryText: '- Canary WREN-2' }),
    );
    await atWrite; // admitted: the tombstone was clear and the pending row is written
    await otherProcess.forgetUser('42', { namespace: 'A' });
    release();
    await upserting;

    expect(await brain.all('SELECT id FROM memory_traces')).toEqual([]);
    expect(await store.chainRows(chainKeyOf(LEARNER_A))).toEqual([]);
    expect(await store.sessionRowsOf('A', '42')).toEqual([]);
  });
});

describe('the freeze and the mode', () => {
  it('a freeze stops the sink: the process switch and a run-time freeze alike', async () => {
    quiet();
    const { store, brain, layer, sink } = await setUp();
    const session = await layer.forLearner(LEARNER_A, contextOf('s-a'));
    const upsert = () =>
      sink.upsertRollingSummaryMemory(
        updateOf(turnOf(session, { userId: '42', namespace: 'A', conversationId: 'c-a' }), {
          userId: '42',
          organizationId: 'A',
          conversationId: 'c-a',
          summaryText: '- frozen out',
        }),
      );

    vi.stubEnv('AGENTOS_LEARNING_FREEZE', '1');
    await upsert();
    vi.unstubAllEnvs();
    await layer.freeze({ learner: LEARNER_A }, 'ops');
    await upsert();

    expect(await filed(brain)).toEqual([]);
    expect(await sinkRows(store, chainKeyOf(LEARNER_A))).toEqual([]);
  });

  it('mode off writes as the host configured it, under the scope ids, with no row', async () => {
    quiet();
    const { store, brain, layer, sink } = await setUp({ mode: 'off' });
    const learning = turnOf(await layer.forLearner(LEARNER_A, contextOf('s-a')), { userId: '42', namespace: 'A', conversationId: 'c-a' });
    await sink.upsertRollingSummaryMemory(
      updateOf(learning, { userId: '42', organizationId: 'A', conversationId: 'c-a', summaryText: '- off the record', policy: USER_ONLY }),
    );

    expect((await filed(brain)).map((trace) => trace.scopeId)).toEqual(['A/42']);
    expect(await sinkRows(store, chainKeyOf(LEARNER_A))).toEqual([]);
  });
});

describe('revert', () => {
  it('takes a kept upsert back: what it wrote goes and what it forgot comes back', async () => {
    quiet();
    const { store, brain, layer, sink } = await setUp();
    const session = await layer.forLearner(LEARNER_A, contextOf('s-a'));
    const upsert = (summaryText: string) =>
      sink.upsertRollingSummaryMemory(
        updateOf(turnOf(session, { userId: '42', namespace: 'A', conversationId: 'c-a' }), {
          userId: '42',
          organizationId: 'A',
          conversationId: 'c-a',
          summaryText,
          policy: USER_ONLY,
        }),
      );
    await upsert('- first');
    await upsert('- second');
    const second = (await sinkRows(store, chainKeyOf(LEARNER_A))).filter((row) => row.rowType === 'candidate')[1]!;

    await layer.revert(second.id, 'ops');

    expect(await summaries(brain)).toEqual(['- first']);
  });

  it("after a forget that failed, restores only what the upsert forgot, never a trace it left that was forgotten since", async () => {
    quiet();
    const { store, brain, memory, layer, sink } = await setUp();
    const session = await layer.forLearner(LEARNER_A, contextOf('s-a'));
    const upsert = (summaryText: string) =>
      sink.upsertRollingSummaryMemory(
        updateOf(turnOf(session, { userId: '42', namespace: 'A', conversationId: 'c-a' }), {
          userId: '42',
          organizationId: 'A',
          conversationId: 'c-a',
          summaryText,
          policy: USER_ONLY,
        }),
      );
    await upsert('- first');
    const firstId = (await sinkRows(store, chainKeyOf(LEARNER_A)))[1]!.after!.created![0]!;
    vi.spyOn(memory, 'forget').mockRejectedValueOnce(new Error('locked'));
    await upsert('- second');
    // The host forgets the first summary itself; the upsert being reverted did not.
    await memory.forget(firstId);
    const second = (await sinkRows(store, chainKeyOf(LEARNER_A))).filter((row) => row.rowType === 'candidate')[1]!;

    await layer.revert(second.id, 'ops');

    expect(await summaries(brain)).toEqual([]);
  });
});

describe("a crash's pending upsert", () => {
  /** An upsert whose verdict never comes: the process stops between the write and its verdict. */
  async function crashedUpsert() {
    const store = new InMemoryLearningStore();
    const { memory, brain } = await facadeAt(tempFile(), 'sink-brain');
    const layer = createLearningLayer({ store, memoryTools: memory });
    const sink = createStandaloneMemoryRollingSummarySink(memory);
    const learning = turnOf(await layer.forLearner(LEARNER_A, contextOf('s-1')), { userId: '42', namespace: 'A', conversationId: 'c-1' });
    vi.spyOn(Ledger.prototype, 'decide').mockImplementationOnce(() => new Promise(() => undefined));
    void sink.upsertRollingSummaryMemory(
      updateOf(learning, { userId: '42', organizationId: 'A', conversationId: 'c-1', summaryText: '- written, then the crash', policy: USER_ONLY }),
    );
    await vi.waitFor(async () => expect(await filed(brain)).toHaveLength(1));
    return { store, memory, brain };
  }

  /** The learner's next session, in another process, sixteen minutes on. */
  const nextSession = async (store: LearningStore, memory: Memory) =>
    createLearningLayer({ store, memoryTools: memory, clock: () => Date.now() + 16 * 60_000 }).forLearner(LEARNER_A, contextOf('s-2'));

  it("is kept at the learner's next session when its traces hold what it planned", async () => {
    quiet();
    const { store, memory } = await crashedUpsert();
    await nextSession(store, memory);
    expect((await sinkRows(store, chainKeyOf(LEARNER_A))).map((row) => [row.verdict, row.reason])).toEqual([
      ['pending', 'pending'],
      ['kept', 'recovered'],
    ]);
  });

  it('is taken back and rejected when its traces do not', async () => {
    quiet();
    const { store, memory, brain } = await crashedUpsert();
    await brain.run('DELETE FROM memory_traces');
    await nextSession(store, memory);
    expect((await sinkRows(store, chainKeyOf(LEARNER_A))).map((row) => [row.verdict, row.reason])).toEqual([
      ['pending', 'pending'],
      ['rejected', 'write_failed'],
    ]);
  });
});

describe("an organization's shared summary", () => {
  it("goes under the organization's own id where the policy shares it, and is read on that organization's turns and on no other's, an organization named after the persona included", async () => {
    quiet();
    const { layer, sink, retriever } = await setUp();
    const SHARED: ResolvedLongTermMemoryPolicy = {
      ...DEFAULT_LONG_TERM_MEMORY_POLICY,
      scopes: { conversation: false, user: false, persona: false, organization: true },
      shareWithOrganization: true,
    };
    const learner: LearnerKey = { namespace: PERSONA_ID, agentKey: 'tutor', userId: '42' };
    const of42 = turnOf(await layer.forLearner(learner, contextOf('s-42')), { userId: '42', namespace: PERSONA_ID, conversationId: 'c-42' });
    await sink.upsertRollingSummaryMemory(
      updateOf(of42, { userId: '42', organizationId: PERSONA_ID, conversationId: 'c-42', summaryText: '- Canary WREN-4: the team ships on Fridays.', policy: SHARED }),
    );

    const query = { mode: 'chat', personaId: PERSONA_ID, memoryPolicy: SHARED, queryText: 'Fridays' };
    const colleague = turnOf(await layer.forLearner({ ...learner, userId: '7' }, contextOf('s-7')), { userId: '7', namespace: PERSONA_ID, conversationId: 'c-7' });
    const elsewhere = turnOf(await layer.forLearner({ ...learner, namespace: 'B', userId: '7' }, contextOf('s-b7')), { userId: '7', namespace: 'B', conversationId: 'c-b7' });
    const readOwn = await retriever.retrieveLongTermMemory({ ...query, userId: '7', organizationId: PERSONA_ID, conversationId: 'c-7', turnScopes: colleague.scopes });
    const readOther = await retriever.retrieveLongTermMemory({ ...query, userId: '7', organizationId: 'B', conversationId: 'c-b7', turnScopes: elsewhere.scopes });

    expect(readOwn?.contextText).toContain('WREN-4');
    expect(readOther).toBeNull();
  });
});

describe('scope ids the sink cannot record under', () => {
  it('file nothing: a turn with scope ids and no recorder, and a facade the sink cannot read back', async () => {
    quiet();
    const { brain, memory, layer, sink } = await setUp();
    const learning = turnOf(await layer.forLearner(LEARNER_A, contextOf('s-a')), { userId: '42', namespace: 'A', conversationId: 'c-a' });
    const update = updateOf(learning, { userId: '42', organizationId: 'A', conversationId: 'c-a', summaryText: '- not filed' });
    const { recordSelfChange: _dropped, ...noRecorder } = update;
    await expect(sink.upsertRollingSummaryMemory(noRecorder)).rejects.toThrow(/no recorder/);

    const bare = { remember: vi.fn(memory.remember.bind(memory)), forget: vi.fn(memory.forget.bind(memory)) };
    await expect(createStandaloneMemoryRollingSummarySink(bare).upsertRollingSummaryMemory(update)).rejects.toThrow(/cannot be read back/);
    expect(bare.remember).not.toHaveBeenCalled();
    expect(await filed(brain)).toEqual([]);
  });

  it('file nothing while the learning store will not open, and the upsert rejects naming store_unavailable', async () => {
    quiet();
    const { memory, brain } = await facadeAt(tempFile(), 'sink-brain');
    const layer = createLearningLayer({
      openStore: async () => {
        throw new Error('brain file locked');
      },
      memoryTools: memory,
    });
    const learning = turnOf(await layer.forLearner(LEARNER_A, contextOf('s-a')), { userId: '42', namespace: 'A', conversationId: 'c-a' });
    const remember = vi.spyOn(memory, 'remember');

    await expect(
      createStandaloneMemoryRollingSummarySink(memory).upsertRollingSummaryMemory(
        updateOf(learning, { userId: '42', organizationId: 'A', conversationId: 'c-a', summaryText: '- not filed while the store is down' }),
      ),
    ).rejects.toThrow(/not written \(store_unavailable\)/);
    expect(remember).not.toHaveBeenCalled();
    expect(await filed(brain)).toEqual([]);
  });
});

describe('a scope delete for one user', () => {
  it('takes the traces that name the user as their second user or among their contributors, and leaves the others', async () => {
    const { memory, brain } = await facadeAt(tempFile(), 'sink-brain');
    await memory.remember('Visitor note.', { scope: 'user', scopeId: 'A//s-1', metadata: { turnUserId: 'bo' } });
    await memory.remember('Summary with bo.', { scope: 'user', scopeId: 'A//s-1', metadata: { contributorIds: ['42', 'bo'] } });
    await memory.remember('Summary without bo.', { scope: 'user', scopeId: 'A//s-1', metadata: { contributorIds: ['42'] } });

    expect(await memory.deleteScope('user', 'A//s-1', { turnUserId: 'bo' })).toEqual({ deleted: 2 });
    expect(await liveContents(brain)).toEqual(['Summary without bo.']);
  });
});

describe('with no learning layer', () => {
  it('files and reads under the plain ids, as before', async () => {
    const { memory, brain } = await facadeAt(tempFile(), 'sink-brain');
    await createStandaloneMemoryRollingSummarySink(memory).upsertRollingSummaryMemory(
      updateOf(undefined, { userId: '42', organizationId: 'A', conversationId: 'c-1', summaryText: '- plain kites' }),
    );

    expect((await filed(brain)).map((trace) => [trace.scope, trace.scopeId, trace.contributorIds])).toEqual([
      ['persona', '42::tutor', undefined],
      ['thread', 'c-1', undefined],
      ['user', '42', undefined],
    ]);
    const read = await createStandaloneMemoryLongTermRetriever(memory).retrieveLongTermMemory({
      userId: '42',
      organizationId: 'A',
      conversationId: 'c-2',
      personaId: PERSONA_ID,
      mode: 'chat',
      queryText: 'kites',
      memoryPolicy: POLICY,
    });
    expect(read?.contextText).toContain('plain kites');
  });
});
