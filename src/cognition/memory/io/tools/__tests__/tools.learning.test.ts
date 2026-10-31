/**
 * @file tools.learning.test.ts
 * The memory tools where a learning layer runs, over a real layer, a real learning store and a real Memory facade on
 * a SQLite file, each call carrying the session data a GMI puts on it (the turn's own preparation, through
 * `toolLearningContextFor`). A learner's writes go under the learner's scope ids, each with a pending row and then its
 * verdict; a turn with no learner writes under its session's form with rows of no user, and a second user's traces
 * and rows carry that user's id; a call reaches by id only its own turn's traces of its own user, and writes one only
 * while it holds what the call read; memory_search reads the turn's own scopes and the unscoped traces, and no
 * organization a user context kept from an earlier turn; mode off and a suspension write with no row; only a freeze
 * stops a write; memory_reflect is withdrawn; a write that commits after its user was forgotten is taken back, with
 * the facade on a SQLite file of its own and on the learning store's adapter; and a trace the tools or the facade
 * delete takes its knowledge-graph copy with it, where a GMI's memory manager files into the facade's Brain. Behind the
 * tool orchestrator's approval gate, a write the tools refuse whatever a human answers is refused before anyone is asked.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveStorageAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import type { ITool, ToolExecutionContext } from '../../../../../core/tools/ITool';
import type { ToolCallResult, UserContext } from '../../../../substrate/IGMI';
import { AdaptPersonalityTool } from '../../../../emergent/AdaptPersonalityTool';
import { approvingHitl, makeForgeHost, type ForgeHost } from '../../../../emergent/__tests__/helpers/forge-host';
import {
  createLearningLayer,
  InMemoryLearningStore,
  toolLearningContextFor,
  type ILearnerSession,
  type LearnerContext,
  type LearnerKey,
} from '../../../../learning/index';
import { chainKeyOf, Ledger } from '../../../../learning/ledger/Ledger';
import type { LearningStore } from '../../../../learning/store/LearningStore';
import { SqlLearningStore } from '../../../../learning/store/SqlLearningStore';
import { closeMemory, facadeAt, liveContents, managerOnBrain, MOOD, tempFile } from '../../../../learning/__tests__/helpers/memoryFixtures';
import type { ConsolidationLoop } from '../../../pipeline/consolidation/ConsolidationLoop';
import { copyKey } from '../../../retrieval/graph/knowledge/memoryCopies';
import type { Brain } from '../../../retrieval/store/Brain';
import { Memory } from '../../facade/Memory';
import { MemoryReflectTool } from '../MemoryReflectTool';

const PERSONA_ID = 'tutor';
const LEARNER_A: LearnerKey = { namespace: 'A', agentKey: 'tutor', userId: '42' };
const LEARNER_B: LearnerKey = { namespace: 'B', agentKey: 'tutor', userId: '42' };
const ANONYMOUS: LearnerKey = { namespace: '', agentKey: 'tutor', userId: 'anonymous_user' };
const contextOf = (sessionId: string): LearnerContext => ({ sessionId, personaId: PERSONA_ID, authoredTraits: {} });
const NO_LAYER: ToolExecutionContext = {
  gmiId: 'gmi-1',
  personaId: PERSONA_ID,
  userContext: { userId: '42' } as UserContext,
  sessionData: { sessionId: 's-1' },
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

/** A facade's memory tools by name. */
const toolsOf = (memory: Memory): Record<string, ITool> =>
  Object.fromEntries(memory.createTools().map((tool) => [tool.name, tool]));

let turnCount = 0;
/**
 * The context a GMI gives a tool call of one turn: the session prepares the turn, and the call carries the turn's
 * learning (`toolLearningContextFor`) with its session, conversation and organization, as `GMI.buildToolSessionData`
 * builds it.
 */
async function turnOf(
  session: ILearnerSession,
  turn: { userId: string; namespace: string; sessionId: string; conversationId?: string },
): Promise<ToolExecutionContext> {
  turnCount += 1;
  const prepared = await session.prepareTurn({
    turnId: `t-${turnCount}`,
    userId: turn.userId,
    namespace: turn.namespace,
    text: 'Remember this.',
    modelIds: ['stub-model'],
    workflowSeat: false,
  });
  const { tools } = toolLearningContextFor(session, {
    learner: prepared.learner === 'bound' ? 'bound' : 'none',
    mode: prepared.mode,
    ...(prepared.scopes ? { scopes: prepared.scopes } : {}),
    ...(prepared.turnUserId ? { turnUserId: prepared.turnUserId } : {}),
    conversationId: turn.conversationId ?? turn.sessionId,
  });
  return {
    gmiId: 'gmi-1',
    personaId: PERSONA_ID,
    userContext: { userId: turn.userId } as UserContext,
    sessionData: {
      sessionId: turn.sessionId,
      ...(turn.conversationId ? { conversationId: turn.conversationId } : {}),
      ...(turn.namespace ? { organizationId: turn.namespace } : {}),
      learning: tools,
    },
  };
}

/** The live traces of a Brain by content: scope, scope id, text, and the second user a trace names. */
async function rowsOf(brain: Brain): Promise<Array<{ scope: string; scopeId: string; content: string; turnUserId?: string }>> {
  const rows = await brain.all<{ scope: string; scope_id: string; content: string; metadata: string | null }>(
    'SELECT scope, scope_id, content, metadata FROM memory_traces WHERE deleted = 0 ORDER BY content',
  );
  return rows.map((row) => {
    const turnUserId = (JSON.parse(row.metadata || '{}') as { turnUserId?: string }).turnUserId;
    return { scope: row.scope, scopeId: row.scope_id, content: row.content, ...(turnUserId ? { turnUserId } : {}) };
  });
}

/** The `memory_write` rows of one chain: row type and verdict. */
async function memoryWrites(store: LearningStore, chainKey: string): Promise<Array<[string, string]>> {
  return (await store.chainRows(chainKey))
    .filter((row) => row.kind === 'memory_write')
    .map((row): [string, string] => [row.rowType, row.verdict]);
}

/** A trace id a write answered with. */
const traceIdOf = (result: { output?: unknown }): string => (result.output as { traceId: string }).traceId;

/** The contents a memory_search on a call finds. */
async function found(tools: Record<string, ITool>, query: string, call: ToolExecutionContext): Promise<string[]> {
  const output = (await tools.memory_search!.execute({ query }, call)).output as { results: Array<{ content: string }> };
  return output.results.map((result) => result.content).sort();
}

/** Runs `before` ahead of the Brain's next transaction, and then that transaction. */
function beforeNextTransaction(brain: Brain, before: () => Promise<void>): void {
  const transaction = brain.transaction.bind(brain);
  vi.spyOn(brain, 'transaction').mockImplementationOnce(async <T>(fn: (trx: StorageAdapter) => Promise<T>): Promise<T> => {
    await before();
    return transaction(fn);
  });
}

/** A layer over an in-process store, its facade on a SQLite file of its own. */
async function setUp() {
  const store = new InMemoryLearningStore();
  const { memory, brain } = await facadeAt(tempFile(), 'tools-brain');
  const layer = createLearningLayer({ store, memoryTools: memory });
  return { store, memory, brain, layer, tools: toolsOf(memory) };
}

describe("a learner's write", () => {
  it("goes under the learner's namespaced scope with a pending row and then its kept verdict, and tenant B's user of the same id finds none of it", async () => {
    quiet();
    const { store, brain, layer, tools } = await setUp();
    const ofA = await turnOf(await layer.forLearner(LEARNER_A, contextOf('s-a')), { userId: '42', namespace: 'A', sessionId: 's-a' });
    // The chain as the write starts: its candidate is pending before the trace exists.
    let whileWriting: Array<[string, string]> = [];
    beforeNextTransaction(brain, async () => {
      whileWriting = await memoryWrites(store, chainKeyOf(LEARNER_A));
    });

    const added = await tools.memory_add!.execute({ content: 'A42 keeps bees.' }, ofA);

    expect(added).toMatchObject({ success: true, details: { status: 'kept' } });
    expect(whileWriting).toEqual([['candidate', 'pending']]);
    expect(await memoryWrites(store, chainKeyOf(LEARNER_A))).toEqual([['candidate', 'pending'], ['verdict', 'kept']]);
    expect(await rowsOf(brain)).toEqual([{ scope: 'user', scopeId: 'A/42', content: 'A42 keeps bees.' }]);

    const ofB = await turnOf(await layer.forLearner(LEARNER_B, contextOf('s-b')), { userId: '42', namespace: 'B', sessionId: 's-b' });
    expect((await tools.memory_search!.execute({ query: 'bees' }, ofB)).output).toEqual({ results: [] });
    // The learner's own next session finds it: the search works, so its absence on B's turn is the scopes' doing.
    const againA = await turnOf(await layer.forLearner(LEARNER_A, contextOf('s-c')), { userId: '42', namespace: 'A', sessionId: 's-c' });
    expect((await tools.memory_search!.execute({ query: 'bees' }, againA)).output).toMatchObject({ results: [{ content: 'A42 keeps bees.' }] });
  });

  it('leaves a write that fails rejected (write_failed), with no kept row and no trace', async () => {
    quiet();
    const { store, brain, layer, tools } = await setUp();
    const ofA = await turnOf(await layer.forLearner(LEARNER_A, contextOf('s-a')), { userId: '42', namespace: 'A', sessionId: 's-a' });
    vi.spyOn(brain, 'transaction').mockRejectedValueOnce(new Error('disk full'));

    const failed = await tools.memory_add!.execute({ content: 'A42 keeps bees.' }, ofA);

    expect(failed).toMatchObject({ success: false, details: { status: 'rejected', reason: 'write_failed' } });
    expect(failed.error).toContain('disk full');
    expect(await memoryWrites(store, chainKeyOf(LEARNER_A))).toEqual([['candidate', 'pending'], ['verdict', 'rejected']]);
    expect(await liveContents(brain)).toEqual([]);
  });

  it('writes nothing when the store fails before the write, and takes the write back when its verdict cannot be written', async () => {
    quiet();
    const { store, brain, layer, tools } = await setUp();
    const ofA = await turnOf(await layer.forLearner(LEARNER_A, contextOf('s-a')), { userId: '42', namespace: 'A', sessionId: 's-a' });

    vi.spyOn(store, 'transaction').mockRejectedValueOnce(new Error('store down'));
    expect(await tools.memory_add!.execute({ content: 'First.' }, ofA)).toMatchObject({ success: false, details: { reason: 'store_unavailable' } });
    expect(await liveContents(brain)).toEqual([]);

    vi.spyOn(Ledger.prototype, 'decide').mockRejectedValueOnce(new Error('store down'));
    expect(await tools.memory_add!.execute({ content: 'Second.' }, ofA)).toMatchObject({ success: false, details: { reason: 'store_unavailable' } });
    expect(await liveContents(brain)).toEqual([]);
    // Its candidate stays pending, for the learner's next session to decide.
    expect(await memoryWrites(store, chainKeyOf(LEARNER_A))).toEqual([['candidate', 'pending']]);
  });

  it('refuses an organization trace and files a thread trace under the session form, which another learner does not find', async () => {
    quiet();
    const { brain, layer, tools } = await setUp();
    // The conversation id is the persona id: the thread trace must not land where the persona scope reads.
    const ofA = await turnOf(await layer.forLearner(LEARNER_A, contextOf('s-a')), { userId: '42', namespace: 'A', sessionId: 's-a', conversationId: PERSONA_ID });
    expect(await tools.memory_add!.execute({ content: 'Shared note.', scope: 'organization' }, ofA)).toMatchObject({
      success: false,
      details: { reason: 'organization_scope' },
    });
    expect((await tools.memory_add!.execute({ content: 'Thread canary WREN-2.', scope: 'thread' }, ofA)).success).toBe(true);
    expect(await rowsOf(brain)).toEqual([{ scope: 'thread', scopeId: 'A//tutor', content: 'Thread canary WREN-2.' }]);

    const other = await turnOf(await layer.forLearner({ ...LEARNER_A, userId: '7' }, contextOf('s-7')), { userId: '7', namespace: 'A', sessionId: 's-7' });
    expect((await tools.memory_search!.execute({ query: 'canary' }, other)).output).toEqual({ results: [] });
  });

  it('refuses a thread trace on a call that names neither a conversation nor a session, and every write of a turn whose session records none', async () => {
    quiet();
    const { brain, layer, tools } = await setUp();
    const ofA = await turnOf(await layer.forLearner(LEARNER_A, contextOf('s-a')), { userId: '42', namespace: 'A', sessionId: 's-a' });
    const learning = ofA.sessionData!.learning as { learner: string; mode: string; scopes: unknown };
    const noThread: ToolExecutionContext = { ...ofA, sessionData: { learning } };
    expect(await tools.memory_add!.execute({ content: 'Nowhere to file.', scope: 'thread' }, noThread)).toMatchObject({
      success: false,
      details: { reason: 'no_thread' },
    });

    const kept = traceIdOf(await tools.memory_add!.execute({ content: 'Kept by the recorder.' }, ofA));
    // A host's own session that gives the turn's scope ids and records no writes.
    const noRecorder: ToolExecutionContext = {
      ...ofA,
      sessionData: { ...ofA.sessionData, learning: { learner: learning.learner, mode: learning.mode, scopes: learning.scopes } },
    };
    const writes: Array<[string, Record<string, unknown>]> = [
      ['memory_add', { content: 'Not recorded.' }],
      ['memory_update', { traceId: kept, content: 'Not recorded.' }],
      ['memory_delete', { traceId: kept }],
      ['memory_merge', { traceIds: [kept, kept] }],
    ];
    for (const [name, args] of writes) {
      expect(await tools[name]!.execute(args, noRecorder), name).toMatchObject({ success: false, details: { reason: 'no_recorder' } });
    }
    expect(await liveContents(brain)).toEqual(['Kept by the recorder.']);
  });
});

describe('a turn with no learner', () => {
  it("files each tool's write under the session's form and writes one row of no user for each", async () => {
    quiet();
    const { store, brain, layer, tools } = await setUp();
    const call = await turnOf(await layer.forLearner(ANONYMOUS, contextOf('s-9')), { userId: 'anonymous_user', namespace: '', sessionId: 's-9' });

    const one = traceIdOf(await tools.memory_add!.execute({ content: 'Session note one.' }, call));
    const two = traceIdOf(await tools.memory_add!.execute({ content: 'Session note two.', scope: 'thread' }, call));
    const three = traceIdOf(await tools.memory_add!.execute({ content: 'Session note three.' }, call));
    expect((await tools.memory_update!.execute({ traceId: one, content: 'Session note one, edited.' }, call)).output).toEqual({ updated: true });
    expect((await tools.memory_merge!.execute({ traceIds: [one, three] }, call)).output).toEqual({ survivorId: one, deletedIds: [three] });
    expect((await tools.memory_delete!.execute({ traceId: two }, call)).output).toEqual({ deleted: true });

    expect(await rowsOf(brain)).toEqual([{ scope: 'user', scopeId: '/s-9', content: 'Session note one, edited. | Session note three.' }]);
    const rows = await store.chainRows(chainKeyOf({ namespace: '', agentKey: 'tutor', userId: null }));
    expect(rows.filter((row) => row.rowType === 'candidate').map((row) => JSON.parse(row.body).actor)).toEqual([
      'tool:memory_add',
      'tool:memory_add',
      'tool:memory_add',
      'tool:memory_update',
      'tool:memory_merge',
      'tool:memory_delete',
    ]);
    expect(rows.filter((row) => row.rowType === 'verdict').map((row) => row.verdict)).toEqual(['kept', 'kept', 'kept', 'kept', 'kept', 'kept']);
    expect(rows.every((row) => row.userId === null && row.turnUserId === null)).toBe(true);
  });

  it("names a second user on another user's session in each trace and row, and forgetUser for that user deletes them and leaves the session's others", async () => {
    quiet();
    const { store, brain, layer, tools } = await setUp();
    const session = await layer.forLearner(LEARNER_A, contextOf('s-1'));
    await tools.memory_add!.execute({ content: 'A42 keeps bees.' }, await turnOf(session, { userId: '42', namespace: 'A', sessionId: 's-1' }));
    const visitor = await turnOf(session, { userId: 'bo', namespace: 'A', sessionId: 's-1' });
    await tools.memory_add!.execute({ content: 'Bo keeps snakes.' }, visitor);
    await tools.memory_add!.execute({ content: 'Bo thread note.', scope: 'thread' }, visitor);
    await tools.memory_add!.execute({ content: 'A session note.' }, await turnOf(session, { userId: 'anonymous_user', namespace: 'A', sessionId: 's-1' }));

    expect(await rowsOf(brain)).toEqual([
      { scope: 'user', scopeId: 'A//s-1', content: 'A session note.' },
      { scope: 'user', scopeId: 'A/42', content: 'A42 keeps bees.' },
      { scope: 'user', scopeId: 'A//s-1', content: 'Bo keeps snakes.', turnUserId: 'bo' },
      { scope: 'thread', scopeId: 'A//s-1', content: 'Bo thread note.', turnUserId: 'bo' },
    ]);
    const visitorChain = chainKeyOf({ namespace: 'A', agentKey: 'tutor', userId: null }, 'bo');
    const visits = await store.chainRows(visitorChain);
    expect(visits).toHaveLength(4);
    expect(visits.filter((row) => row.rowType === 'candidate').map((row) => [row.userId, row.turnUserId])).toEqual([
      [null, 'bo'],
      [null, 'bo'],
    ]);

    await layer.forgetUser('bo', { namespace: 'A' });

    expect(await liveContents(brain)).toEqual(['A session note.', 'A42 keeps bees.']);
    expect(await store.chainRows(visitorChain)).toEqual([]);
    expect(await store.sessionRowsOf('A', 'bo')).toEqual([]);
  });
});

describe('what a call reaches by id', () => {
  it("changes no trace of another tenant's learner, nor of learner 42 from a session whose id is 42, and that session finds none of them", async () => {
    quiet();
    const { brain, layer, tools } = await setUp();
    const learner42 = await turnOf(await layer.forLearner({ namespace: '', agentKey: 'tutor', userId: '42' }, contextOf('s-l')), {
      userId: '42',
      namespace: '',
      sessionId: 's-l',
    });
    const ofB = await turnOf(await layer.forLearner(LEARNER_B, contextOf('s-b')), { userId: '42', namespace: 'B', sessionId: 's-b' });
    const session42 = await turnOf(await layer.forLearner(ANONYMOUS, contextOf('42')), { userId: 'anonymous_user', namespace: '', sessionId: '42' });
    const own = traceIdOf(await tools.memory_add!.execute({ content: 'Learner 42 keeps bees.' }, learner42));
    const tenantB = traceIdOf(await tools.memory_add!.execute({ content: 'B42 keeps goats.' }, ofB));

    for (const [call, traceId] of [
      [session42, own],
      [learner42, tenantB],
    ] as const) {
      expect((await tools.memory_update!.execute({ traceId, content: 'Overwritten.' }, call)).output).toEqual({ updated: false });
      expect((await tools.memory_delete!.execute({ traceId }, call)).output).toEqual({ deleted: false });
      expect((await tools.memory_merge!.execute({ traceIds: [traceId, own] }, call)).success).toBe(false);
    }
    expect((await tools.memory_search!.execute({ query: 'bees' }, session42)).output).toEqual({ results: [] });
    expect(await liveContents(brain)).toEqual(['B42 keeps goats.', 'Learner 42 keeps bees.']);
  });

  it('refuses to change a trace another user filed in a scope the turn shares (other_user), which it can still find', async () => {
    quiet();
    const { brain, layer, tools } = await setUp();
    const session = await layer.forLearner(LEARNER_A, contextOf('s-1'));
    const note = traceIdOf(
      await tools.memory_add!.execute({ content: 'Thread note of 42.', scope: 'thread' }, await turnOf(session, { userId: '42', namespace: 'A', sessionId: 's-1' })),
    );
    const visitor = await turnOf(session, { userId: 'bo', namespace: 'A', sessionId: 's-1' });

    expect((await tools.memory_search!.execute({ query: 'thread note' }, visitor)).output).toMatchObject({ results: [{ id: note }] });
    expect(await tools.memory_update!.execute({ traceId: note, content: 'Bo was here.' }, visitor)).toMatchObject({
      success: false,
      details: { reason: 'other_user' },
    });
    expect((await tools.memory_delete!.execute({ traceId: note }, visitor)).details?.reason).toBe('other_user');
    expect(await liveContents(brain)).toEqual(['Thread note of 42.']);
  });

  it('keeps a user id holding a / apart from a namespaced learner, and two session ids that differ only by their encoding apart', async () => {
    quiet();
    const { brain, layer, tools } = await setUp();
    const slashed = await turnOf(await layer.forLearner({ namespace: '', agentKey: 'tutor', userId: 'A/42' }, contextOf('s-1')), {
      userId: 'A/42',
      namespace: '',
      sessionId: 's-1',
    });
    const ofA = await turnOf(await layer.forLearner(LEARNER_A, contextOf('s-2')), { userId: '42', namespace: 'A', sessionId: 's-2' });
    const sessionSlash = await turnOf(await layer.forLearner(ANONYMOUS, contextOf('a/b')), { userId: 'anonymous_user', namespace: '', sessionId: 'a/b' });
    const sessionEncoded = await turnOf(await layer.forLearner(ANONYMOUS, contextOf('a%2Fb')), {
      userId: 'anonymous_user',
      namespace: '',
      sessionId: 'a%2Fb',
    });
    await tools.memory_add!.execute({ content: 'Slashed canary one.' }, slashed);
    await tools.memory_add!.execute({ content: 'Namespaced canary two.' }, ofA);
    await tools.memory_add!.execute({ content: 'Session canary three.' }, sessionSlash);
    await tools.memory_add!.execute({ content: 'Session canary four.' }, sessionEncoded);

    expect(await rowsOf(brain)).toEqual([
      { scope: 'user', scopeId: 'A/42', content: 'Namespaced canary two.' },
      { scope: 'user', scopeId: '/a%252Fb', content: 'Session canary four.' },
      { scope: 'user', scopeId: '/a%2Fb', content: 'Session canary three.' },
      { scope: 'user', scopeId: 'A%2F42', content: 'Slashed canary one.' },
    ]);
    expect(await found(tools, 'canary', slashed)).toEqual(['Slashed canary one.']);
    expect(await found(tools, 'canary', ofA)).toEqual(['Namespaced canary two.']);
    expect(await found(tools, 'canary', sessionSlash)).toEqual(['Session canary three.']);
    expect(await found(tools, 'canary', sessionEncoded)).toEqual(['Session canary four.']);
  });
});

describe('a write that reads its trace first', () => {
  it('changes nothing and answers conflict when the trace changed after the call read it, with a rejected row', async () => {
    quiet();
    const { store, brain, layer, tools } = await setUp();
    const ofA = await turnOf(await layer.forLearner(LEARNER_A, contextOf('s-a')), { userId: '42', namespace: 'A', sessionId: 's-a' });
    const id = traceIdOf(await tools.memory_add!.execute({ content: 'A42 keeps bees.' }, ofA));
    // Another writer changes the trace between the tool's read of it and its write.
    beforeNextTransaction(brain, async () => {
      await brain.run('UPDATE memory_traces SET content = ? WHERE id = ?', ['A42 keeps wasps.', id]);
    });

    expect(await tools.memory_update!.execute({ traceId: id, content: 'A42 keeps hornets.' }, ofA)).toMatchObject({
      success: false,
      details: { status: 'rejected', reason: 'conflict' },
    });
    expect(await liveContents(brain)).toEqual(['A42 keeps wasps.']);
    expect((await memoryWrites(store, chainKeyOf(LEARNER_A))).slice(2)).toEqual([['candidate', 'pending'], ['verdict', 'rejected']]);
  });
});

describe('memory_search where a learning layer runs', () => {
  it('finds an ingested document and, for a learner with no namespace, a trace filed before the layer; a namespaced learner finds the document only', async () => {
    quiet();
    const { memory, layer, tools } = await setUp();
    const filePath = path.join(path.dirname(tempFile()), 'notes.txt');
    await fsp.writeFile(filePath, 'The quick brown fox jumps over the lazy dog. '.repeat(30), 'utf8');
    expect((await memory.ingest(filePath)).tracesCreated).toBeGreaterThanOrEqual(1);
    // memory_add with no layer: the trace is filed under the plain user id, as before the layer existed.
    expect((await tools.memory_add!.execute({ content: 'Ana prefers mornings.' }, NO_LAYER)).success).toBe(true);

    const plain = await turnOf(await layer.forLearner({ namespace: '', agentKey: 'tutor', userId: '42' }, contextOf('s-1')), {
      userId: '42',
      namespace: '',
      sessionId: 's-1',
    });
    const namespaced = await turnOf(await layer.forLearner(LEARNER_A, contextOf('s-2')), { userId: '42', namespace: 'A', sessionId: 's-2' });
    const count = async (query: string, call: ToolExecutionContext) =>
      ((await tools.memory_search!.execute({ query }, call)).output as { results: unknown[] }).results.length;

    expect(await count('fox', plain)).toBeGreaterThanOrEqual(1);
    expect(await count('mornings', plain)).toBe(1);
    expect(await count('fox', namespaced)).toBeGreaterThanOrEqual(1);
    expect(await count('mornings', namespaced)).toBe(0);
  });

  it("reads its turn's organization, and no organization the user context kept from an earlier turn on a turn that names none", async () => {
    quiet();
    const { layer, tools } = await setUp();
    // An organization trace filed with no layer, under organization A.
    const orgA: ToolExecutionContext = { ...NO_LAYER, sessionData: { sessionId: 's-0', organizationId: 'A' } };
    expect((await tools.memory_add!.execute({ content: 'Organization canary HERON-4.', scope: 'organization' }, orgA)).success).toBe(true);

    const ofA = await turnOf(await layer.forLearner(LEARNER_A, contextOf('s-a')), { userId: '42', namespace: 'A', sessionId: 's-a' });
    expect(await found(tools, 'canary', ofA)).toEqual(['Organization canary HERON-4.']);
    // A turn with no organization on a GMI whose user context an earlier turn's override left naming A.
    const plain = await turnOf(await layer.forLearner({ namespace: '', agentKey: 'tutor', userId: '42' }, contextOf('s-1')), {
      userId: '42',
      namespace: '',
      sessionId: 's-1',
    });
    const stale: ToolExecutionContext = { ...plain, userContext: { userId: '42', organizationId: 'A' } as UserContext };
    expect(await found(tools, 'canary', stale)).toEqual([]);
  });
});

/**
 * The four writes on one call: three adds, an update, a merge of two of the adds, and a delete of the third.
 *
 * @returns Each write's `details.status`.
 */
async function everyWrite(tools: Record<string, ITool>, call: ToolExecutionContext, label: string): Promise<unknown[]> {
  const first = await tools.memory_add!.execute({ content: `${label} one.` }, call);
  const second = await tools.memory_add!.execute({ content: `${label} two.` }, call);
  const third = await tools.memory_add!.execute({ content: `${label} three.` }, call);
  const updated = await tools.memory_update!.execute({ traceId: traceIdOf(first), content: `${label} one, edited.` }, call);
  const merged = await tools.memory_merge!.execute({ traceIds: [traceIdOf(first), traceIdOf(second)], mergedContent: `${label} merged.` }, call);
  const deleted = await tools.memory_delete!.execute({ traceId: traceIdOf(third) }, call);
  return [first, second, third, updated, merged, deleted].map((result) => result.details?.status);
}

describe('the mode, a suspension and the freeze', () => {
  it("make every write with no row in mode off and under a suspension, while adapt_personality refuses (off) on a learner's turn and changes nothing", async () => {
    quiet();
    const store = new InMemoryLearningStore();
    const { memory, brain } = await facadeAt(tempFile(), 'tools-brain');
    const tools = toolsOf(memory);
    const off = createLearningLayer({ store, memoryTools: memory, mode: 'off' });
    const offTurn = await turnOf(await off.forLearner(LEARNER_A, contextOf('s-1')), { userId: '42', namespace: 'A', sessionId: 's-1' });
    expect((offTurn.sessionData!.learning as { learner: string }).learner).toBe('bound');
    expect(await everyWrite(tools, offTurn, 'Off')).toEqual(['written', 'written', 'written', 'written', 'written', 'written']);

    const layer = createLearningLayer({ store, memoryTools: memory });
    await layer.suspend({ learner: LEARNER_A }, 'ops');
    const suspended = await turnOf(await layer.forLearner(LEARNER_A, contextOf('s-2')), { userId: '42', namespace: 'A', sessionId: 's-2' });
    expect(await everyWrite(tools, suspended, 'Suspended')).toEqual(['written', 'written', 'written', 'written', 'written', 'written']);

    expect(await rowsOf(brain)).toEqual([
      { scope: 'user', scopeId: 'A/42', content: 'Off merged.' },
      { scope: 'user', scopeId: 'A/42', content: 'Suspended merged.' },
    ]);
    expect(await memoryWrites(store, chainKeyOf(LEARNER_A))).toEqual([]);

    const traits: Record<string, number> = { openness: 0.5, conscientiousness: 0.5, emotionality: 0.5, extraversion: 0.5, agreeableness: 0.5, honesty: 0.5 };
    const adapt = new AdaptPersonalityTool({
      config: { maxDeltaPerSession: 0.3 },
      getPersonality: () => traits,
      setPersonality: (trait, value) => {
        traits[trait] = value;
      },
    });
    expect(await adapt.execute({ trait: 'openness', delta: 0.02, reasoning: 'Livelier.' }, offTurn)).toMatchObject({
      success: false,
      details: { reason: 'off' },
    });
    expect(traits.openness).toBe(0.5);
  });

  it('refuse every write under AGENTOS_LEARNING_FREEZE=1 with a layer and without one, and under a run-time freeze of the learner', async () => {
    quiet();
    const { store, brain, layer, tools } = await setUp();
    const session = await layer.forLearner(LEARNER_A, contextOf('s-1'));
    const before = await turnOf(session, { userId: '42', namespace: 'A', sessionId: 's-1' });
    const kept = traceIdOf(await tools.memory_add!.execute({ content: 'Kept before the freeze.' }, before));
    const writes: Array<[string, Record<string, unknown>]> = [
      ['memory_add', { content: 'Not written.' }],
      ['memory_update', { traceId: kept, content: 'Not written.' }],
      ['memory_delete', { traceId: kept }],
      ['memory_merge', { traceIds: [kept, kept] }],
    ];

    vi.stubEnv('AGENTOS_LEARNING_FREEZE', '1');
    for (const [name, args] of writes) {
      for (const call of [before, NO_LAYER]) {
        expect(await tools[name]!.execute(args, call), name).toMatchObject({ success: false, details: { reason: 'frozen' } });
      }
    }
    vi.unstubAllEnvs();
    await layer.freeze({ learner: LEARNER_A }, 'ops');
    const frozen = await turnOf(session, { userId: '42', namespace: 'A', sessionId: 's-1' });
    for (const [name, args] of writes) {
      expect((await tools[name]!.execute(args, frozen)).details?.reason, name).toBe('frozen');
    }

    expect(await liveContents(brain)).toEqual(['Kept before the freeze.']);
    expect((await memoryWrites(store, chainKeyOf(LEARNER_A))).filter(([rowType]) => rowType === 'candidate')).toHaveLength(1);
  });
});

describe('memory_reflect', () => {
  it('is refused wherever a learning layer runs, after the freeze, and runs without one', async () => {
    quiet();
    const { brain, layer } = await setUp();
    const result = { pruned: 0, merged: 0, derived: 0, compacted: 0, durationMs: 1 };
    const run = vi.fn(async () => result);
    const reflect = new MemoryReflectTool(brain, { run, isRunning: false } as unknown as ConsolidationLoop);
    const learnerTurn = await turnOf(await layer.forLearner(LEARNER_A, contextOf('s-1')), { userId: '42', namespace: 'A', sessionId: 's-1' });
    const offTurn: ToolExecutionContext = { ...NO_LAYER, sessionData: { sessionId: 's-1', learning: { learner: 'none', mode: 'off' } } };

    for (const call of [learnerTurn, offTurn]) {
      expect(await reflect.execute({}, call)).toMatchObject({ success: false, details: { reason: 'withdrawn' } });
    }
    expect(run).not.toHaveBeenCalled();
    expect(await reflect.execute({}, NO_LAYER)).toEqual({ success: true, output: result });

    vi.stubEnv('AGENTOS_LEARNING_FREEZE', '1');
    expect((await reflect.execute({}, NO_LAYER)).details?.reason).toBe('frozen');
    expect((await reflect.execute({}, learnerTurn)).details?.reason).toBe('frozen');
    expect(run).toHaveBeenCalledTimes(1);
  });
});

/**
 * The facade a test's tools run over and the learning store, in the two layouts the spec names: the facade on a
 * SQLite file of its own beside an in-process store, and the facade on the learning store's own adapter.
 */
async function layoutOf(layout: 'own' | 'shared'): Promise<{ store: LearningStore; memory: Memory; brain: Brain }> {
  if (layout === 'own') {
    const { memory, brain } = await facadeAt(tempFile(), 'tools-brain');
    return { store: new InMemoryLearningStore(), memory, brain };
  }
  const adapter = await resolveStorageAdapter({ filePath: tempFile(), priority: ['better-sqlite3', 'sqljs'], quiet: true });
  adapters.push(adapter);
  // The facade is never closed: closing its Brain would close the adapter the store shares; afterEach closes it.
  const memory = await Memory.createWithAdapter(adapter, { brainId: 'tools-brain', selfImprove: false });
  return { store: new SqlLearningStore({ adapter }), memory, brain: (memory as unknown as { _brain: Brain })._brain };
}

describe.each([
  ['on a SQLite file of its own', 'own'],
  ["on the learning store's adapter", 'shared'],
] as const)('a write and forgetUser, with the facade %s', (_name, layout) => {
  it('takes back a write admitted before forgetUser ran to completion and committed after it, and leaves nothing of the user', async () => {
    quiet();
    const { store, memory, brain } = await layoutOf(layout);
    const layer = createLearningLayer({ store, memoryTools: memory });
    // A second layer over the same store stands for another process: its write chains do not order this one's.
    const otherProcess = createLearningLayer({ store, memoryTools: memory });
    const tools = toolsOf(memory);
    const call = await turnOf(await layer.forLearner(LEARNER_A, contextOf('s-1')), { userId: '42', namespace: 'A', sessionId: 's-1' });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const atWrite = new Promise<void>((resolve) => (reached = resolve));
    beforeNextTransaction(brain, async () => {
      reached();
      await held;
    });

    const adding = tools.memory_add!.execute({ content: 'A42 canary OWL-3.' }, call);
    await atWrite; // admitted: the tombstone was clear and the pending row is written
    await otherProcess.forgetUser('42', { namespace: 'A' });
    release();

    expect(await adding).toMatchObject({ success: false, details: { reason: 'forgotten' } });
    expect(await brain.all('SELECT id FROM memory_traces')).toEqual([]);
    expect(await store.chainRows(chainKeyOf(LEARNER_A))).toEqual([]);
    expect(await store.sessionRowsOf('A', '42')).toEqual([]);
    expect(await store.traitRow('A', 'tutor', '42')).toBeUndefined();
  });

  it('writes nothing for a user forgotten before the write', async () => {
    quiet();
    const { store, memory, brain } = await layoutOf(layout);
    const layer = createLearningLayer({ store, memoryTools: memory });
    const tools = toolsOf(memory);
    const call = await turnOf(await layer.forLearner(LEARNER_A, contextOf('s-1')), { userId: '42', namespace: 'A', sessionId: 's-1' });
    await layer.forgetUser('42', { namespace: 'A' });

    expect(await tools.memory_add!.execute({ content: 'After the tombstone.' }, call)).toMatchObject({ success: false, details: { reason: 'forgotten' } });
    expect(await brain.all('SELECT id FROM memory_traces')).toEqual([]);
    expect(await store.chainRows(chainKeyOf(LEARNER_A))).toEqual([]);
  });
});

describe("a deleted trace's knowledge-graph copy, where a GMI's memory manager files into the facade's Brain", () => {
  /** Whether the graph holds the episodic copy of a trace. */
  const hasCopy = async (brain: Brain, traceId: string): Promise<boolean> =>
    Boolean(await brain.get('SELECT id FROM knowledge_nodes WHERE brain_id = ? AND id = ?', [brain.brainId, copyKey(traceId)]));

  it('goes with each trace memory_delete, memory_merge and Memory.forget delete with no layer, while a kept trace keeps its own', async () => {
    quiet();
    const { memory, brain } = await facadeAt(tempFile(), 'tools-brain');
    const tools = toolsOf(memory);
    const manager = await managerOnBrain(brain);
    const encode = async (text: string): Promise<string> => (await manager.encode(text, MOOD, 'neutral', { type: 'episodic', scope: 'user', scopeId: '42' })).id;
    const deleted = await encode('Copy canary one.');
    const survivor = await encode('Copy canary two.');
    const merged = await encode('Copy canary three.');
    const forgotten = await encode('Copy canary four.');
    for (const id of [deleted, survivor, merged, forgotten]) expect(await hasCopy(brain, id)).toBe(true);

    expect((await tools.memory_delete!.execute({ traceId: deleted }, NO_LAYER)).output).toEqual({ deleted: true });
    expect((await tools.memory_merge!.execute({ traceIds: [survivor, merged], mergedContent: 'Copy canary, merged.' }, NO_LAYER)).output).toEqual({
      survivorId: survivor,
      deletedIds: [merged],
    });
    await memory.forget(forgotten);

    expect(await hasCopy(brain, deleted)).toBe(false);
    expect(await hasCopy(brain, merged)).toBe(false);
    expect(await hasCopy(brain, forgotten)).toBe(false);
    expect(await hasCopy(brain, survivor)).toBe(true);
  });

  it("goes with each trace a learner's memory_delete and memory_merge delete", async () => {
    quiet();
    const { brain, layer, tools } = await setUp();
    const manager = await managerOnBrain(brain);
    const ofA = await turnOf(await layer.forLearner(LEARNER_A, contextOf('s-a')), { userId: '42', namespace: 'A', sessionId: 's-a' });
    const encode = async (text: string): Promise<string> =>
      (await manager.encode(text, MOOD, 'neutral', { type: 'episodic', scope: 'user', scopeId: 'A/42' })).id;
    const deleted = await encode('Learner copy one.');
    const survivor = await encode('Learner copy two.');
    const merged = await encode('Learner copy three.');

    expect(await tools.memory_delete!.execute({ traceId: deleted }, ofA)).toMatchObject({ success: true, details: { status: 'kept' } });
    expect(await tools.memory_merge!.execute({ traceIds: [survivor, merged], mergedContent: 'Learner copy, merged.' }, ofA)).toMatchObject({
      success: true,
      output: { survivorId: survivor, deletedIds: [merged] },
    });

    expect(await hasCopy(brain, deleted)).toBe(false);
    expect(await hasCopy(brain, merged)).toBe(false);
    expect(await hasCopy(brain, survivor)).toBe(true);
  });
});

describe("the memory tools behind the tool orchestrator's approval gate", () => {
  let gateCalls = 0;
  /** Calls a tool the way a model's tool call reaches it: through the orchestrator, with the call's context. */
  const viaOrchestrator = (host: ForgeHost, name: string, args: Record<string, unknown>, call: ToolExecutionContext): Promise<ToolCallResult> => {
    gateCalls += 1;
    return host.orchestrator.processToolCall({
      toolCallRequest: { id: `gate-${gateCalls}`, name, arguments: args },
      gmiId: call.gmiId,
      personaId: call.personaId,
      personaCapabilities: [],
      userContext: call.userContext as UserContext,
      ...(call.sessionData ? { sessionData: call.sessionData } : {}),
    });
  };
  /** The reason a refusal names (`errorDetails.details.reason`), or undefined for any other result. */
  const reasonOf = (result: ToolCallResult): string | undefined =>
    (result.errorDetails as { details?: { reason?: string } } | undefined)?.details?.reason;

  /** A learner's session and turn, the same turn with no recorder and with no thread to file under, and a trace it kept. */
  async function turns(layer: ReturnType<typeof createLearningLayer>, tools: Record<string, ITool>) {
    const session = await layer.forLearner(LEARNER_A, contextOf('s-a'));
    const ofA = await turnOf(session, { userId: '42', namespace: 'A', sessionId: 's-a' });
    const kept = traceIdOf(await tools.memory_add!.execute({ content: 'Kept before the gate.' }, ofA));
    const learning = ofA.sessionData!.learning as { learner: string; mode: string; scopes: unknown };
    const noRecorder: ToolExecutionContext = {
      ...ofA,
      sessionData: { ...ofA.sessionData, learning: { learner: learning.learner, mode: learning.mode, scopes: learning.scopes } },
    };
    const noThread: ToolExecutionContext = { ...ofA, sessionData: { learning } };
    return { session, ofA, kept, noRecorder, noThread };
  }

  it('answer a write they refuse whatever a human answers with its refusal and ask no one, and ask about a write that may act', async () => {
    quiet();
    const { brain, memory, layer, tools } = await setUp();
    const reflect = new MemoryReflectTool(brain, { run: vi.fn(), isRunning: false } as unknown as ConsolidationLoop);
    const { manager, requestApproval } = approvingHitl();
    const host = await makeForgeHost({
      tools: [...memory.createTools({ includeReflect: false }), reflect],
      hitlManager: manager,
      orchestratorConfig: { hitl: { enabled: true } },
    });
    const { session, ofA, kept, noRecorder, noThread } = await turns(layer, tools);
    const refused: Array<[string, Record<string, unknown>, ToolExecutionContext, string]> = [
      ['memory_add', { content: 'Shared note.', scope: 'organization' }, ofA, 'organization_scope'],
      ['memory_add', { content: 'Nowhere to file.', scope: 'thread' }, noThread, 'no_thread'],
      ['memory_add', { content: 'Not recorded.' }, noRecorder, 'no_recorder'],
      ['memory_update', { traceId: kept, content: 'Not recorded.' }, noRecorder, 'no_recorder'],
      ['memory_delete', { traceId: kept }, noRecorder, 'no_recorder'],
      ['memory_merge', { traceIds: [kept, kept] }, noRecorder, 'no_recorder'],
      ['memory_reflect', {}, ofA, 'withdrawn'],
    ];
    for (const [name, args, call, reason] of refused) {
      expect(reasonOf(await viaOrchestrator(host, name, args, call)), name).toBe(reason);
    }
    vi.stubEnv('AGENTOS_LEARNING_FREEZE', '1');
    const frozen: Array<[string, Record<string, unknown>]> = [
      ['memory_add', { content: 'Not written.' }],
      ['memory_update', { traceId: kept, content: 'Not written.' }],
      ['memory_delete', { traceId: kept }],
      ['memory_merge', { traceIds: [kept, kept] }],
      ['memory_reflect', {}],
    ];
    for (const [name, args] of frozen) {
      for (const call of [ofA, NO_LAYER]) {
        expect(reasonOf(await viaOrchestrator(host, name, args, call)), name).toBe('frozen');
      }
    }
    vi.unstubAllEnvs();
    expect(requestApproval).not.toHaveBeenCalled();
    expect(await liveContents(brain)).toEqual(['Kept before the gate.']);

    // A write the layer lets act is asked about, as before, and then runs.
    expect((await viaOrchestrator(host, 'memory_add', { content: 'Asked about.' }, ofA)).isError).toBe(false);
    expect(requestApproval).toHaveBeenCalledTimes(1);
    // A run-time freeze of the learner, read on the next turn, is answered before the gate too.
    await layer.freeze({ learner: LEARNER_A }, 'ops');
    const frozenTurn = await turnOf(session, { userId: '42', namespace: 'A', sessionId: 's-a' });
    expect(reasonOf(await viaOrchestrator(host, 'memory_delete', { traceId: kept }, frozenTurn))).toBe('frozen');
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(await liveContents(brain)).toEqual(['Asked about.', 'Kept before the gate.']);
  });

  it('name the refusal, not the missing approval manager, with the gate on and no manager', async () => {
    quiet();
    const { memory, layer, tools } = await setUp();
    const host = await makeForgeHost({ tools: memory.createTools({ includeReflect: false }), orchestratorConfig: { hitl: { enabled: true } } });
    const { kept, noRecorder } = await turns(layer, tools);
    expect(reasonOf(await viaOrchestrator(host, 'memory_delete', { traceId: kept }, noRecorder))).toBe('no_recorder');
    vi.stubEnv('AGENTOS_LEARNING_FREEZE', '1');
    expect(reasonOf(await viaOrchestrator(host, 'memory_add', { content: 'Not written.' }, NO_LAYER))).toBe('frozen');
  });
});
