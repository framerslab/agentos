/**
 * @file GMI.learning-memory.test.ts
 * Where a GMI with a learning layer files and reads its memory, through the real layer, store and memory manager: a
 * learner's words and the replies to them under the learner's scope ids (namespaced when the turn has an organization);
 * a turn with no learner under its session's form, which no user id takes, with a second user's id on each trace
 * (tenant B's user of the learner's id, on the session the learner opened, among them); a
 * recall list holding the turn's own scopes, and neither the GMI id, the memory owner id among the users nor an
 * organization an earlier turn left in the user context; every
 * filing guarded by the user's tombstone, before the write and once it has committed; and what each tool call is
 * told: the turn's scopes, a recorder bound to the turn, its second user and the freeze. With no learner session the
 * GMI files and reads as it did before the layer existed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveStorageAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import type { ChatMessage } from '../../../core/llm/providers/IProvider';
import type { CognitiveMemoryManager } from '../../memory/CognitiveMemoryManager';
import { Brain } from '../../memory/retrieval/store/Brain';
import { closeMemory, liveContents, managerOnBrain, managerOver, tempFile } from '../../learning/__tests__/helpers/memoryFixtures';
import { createLearningLayer, InMemoryLearningStore, SqlLearningStore, type LearnerContext, type LearningStore, type SessionSelfChange } from '../../learning/index';
import { chainKeyOf } from '../../learning/ledger/Ledger';
import { createScriptedGmi, runTurn, scriptedProvider, textReply, textTurn, toolCallReply } from './helpers/scriptedGmi';

const PERSONA_ID = 'scripted-persona';
const KEY_A = { namespace: 'A', agentKey: 'tutor', userId: 'user-1' };
const lookupStep = () => toolCallReply([{ id: 'call_a', name: 'lookup', args: { q: 'a' } }]);
const context = (memory: CognitiveMemoryManager, sessionId = 'session-1'): LearnerContext => ({
  sessionId,
  personaId: PERSONA_ID,
  authoredTraits: {},
  memory,
});
/** The scope list one recall asked the memory manager for. */
const recallScopes = (spy: { mock: { calls: unknown[][] } }, call = 0) =>
  ((spy.mock.calls[call]?.[3] as { scopes?: Array<{ scope: string; scopeId: string }> } | undefined)?.scopes ?? []);
const textOf = (prompt: ChatMessage[] | undefined): string => JSON.stringify(prompt ?? []);

/** Adapters a test opened for the shared layout; closed once the fixtures have shut the managers down. */
const adapters: StorageAdapter[] = [];

afterEach(async () => {
  await closeMemory();
  while (adapters.length) await adapters.pop()!.close();
  vi.restoreAllMocks();
});

/**
 * The memory a GMI files into and the learning store, in the two layouts the spec names: a Brain on a SQLite file of
 * its own beside an in-process store, and a Brain on the learning store's own adapter (gmi()'s memory.store).
 */
async function bridgeLayoutOf(layout: 'own' | 'shared'): Promise<{ manager: CognitiveMemoryManager; brain: Brain; store: LearningStore }> {
  if (layout === 'own') {
    const { manager, brain } = await managerOver(tempFile(), 'brain-1');
    return { manager, brain, store: new InMemoryLearningStore() };
  }
  const adapter = await resolveStorageAdapter({ filePath: tempFile(), priority: ['better-sqlite3', 'sqljs'], quiet: true });
  adapters.push(adapter);
  // The Brain is never closed here: closing it would close the adapter the store shares, which afterEach closes.
  const brain = await Brain.openWithAdapter(adapter, { brainId: 'brain-1' });
  return { manager: await managerOnBrain(brain), brain, store: new SqlLearningStore({ adapter }) };
}

/** The live traces of a Brain: scope, scope id, text, and the second user a trace names. */
async function filed(brain: Brain): Promise<Array<{ scope: string; scopeId: string; content: string; turnUserId?: string }>> {
  const rows = await brain.all<{ scope: string; scope_id: string; content: string; metadata: string | null }>(
    'SELECT scope, scope_id, content, metadata FROM memory_traces WHERE deleted = 0',
  );
  return rows.map((row) => {
    const turnUserId = (JSON.parse(row.metadata || '{}') as { turnUserId?: string }).turnUserId;
    return { scope: row.scope, scopeId: row.scope_id, content: row.content, ...(turnUserId ? { turnUserId } : {}) };
  });
}

/** A memory write a tool would record, which writes nothing. */
const change = (subject: string): SessionSelfChange<string> => ({
  kind: 'memory_write',
  actor: 'tool:memory_add',
  subject,
  before: null,
  after: { created: [subject], changed: [], deleted: [] },
  brainId: 'brain-1',
  apply: async () => 'applied',
  undo: async () => undefined,
});

describe('a GMI with no learner session', () => {
  it('files the input under the user id and the reply under the session id, and recalls the lists it read before', async () => {
    const { manager, brain } = await managerOver(tempFile(), 'brain-1');
    const { provider } = scriptedProvider([textReply('Noted.')]);
    const { gmi } = await createScriptedGmi({ provider, config: { cognitiveMemory: manager } });
    const assemble = vi.spyOn(manager, 'assembleForPrompt');
    await runTurn(gmi, textTurn('t1', 'My canary is LARK-7.'));
    expect(await filed(brain)).toEqual(
      expect.arrayContaining([
        { scope: 'user', scopeId: 'user-1', content: 'My canary is LARK-7.' },
        { scope: 'user', scopeId: 'session-1', content: 'Noted.' },
      ]),
    );
    expect(recallScopes(assemble)).toEqual([
      { scope: 'user', scopeId: 'user-1' },
      { scope: 'user', scopeId: 'session-1' },
      { scope: 'user', scopeId: 'gmi-scripted' },
      { scope: 'thread', scopeId: 'session-1' },
      { scope: 'persona', scopeId: PERSONA_ID },
      { scope: 'persona', scopeId: `user-1::${PERSONA_ID}` },
      { scope: 'user', scopeId: 'brain-1' },
      { scope: 'thread', scopeId: 'brain-1' },
      { scope: 'persona', scopeId: 'brain-1' },
      { scope: 'organization', scopeId: 'brain-1' },
    ]);
  });
});

describe("a learner's turn", () => {
  it("files the user's words and the reply under the learner's namespaced scope, and recalls only the turn's own scopes", async () => {
    const { manager, brain } = await managerOver(tempFile(), 'brain-1');
    const layer = createLearningLayer({ store: new InMemoryLearningStore() });
    const session = await layer.forLearner(KEY_A, context(manager));
    const { provider } = scriptedProvider([textReply('Noted.')]);
    const { gmi } = await createScriptedGmi({ provider, config: { learning: session, cognitiveMemory: manager } });
    const assemble = vi.spyOn(manager, 'assembleForPrompt');

    await runTurn(gmi, textTurn('t1', 'My canary is LARK-7.', { organizationId: 'A' }));

    const rows = await filed(brain);
    expect(rows).toEqual(
      expect.arrayContaining([
        { scope: 'user', scopeId: 'A/user-1', content: 'My canary is LARK-7.' },
        { scope: 'user', scopeId: 'A/user-1', content: 'Noted.' },
      ]),
    );
    expect(rows.filter((row) => row.scopeId !== 'A/user-1')).toEqual([]);
    const scopes = recallScopes(assemble);
    // Neither the GMI id nor the memory owner id, which a user id can equal, is read as a user.
    expect(scopes.filter((entry) => entry.scope === 'user')).toEqual([{ scope: 'user', scopeId: 'A/user-1' }]);
    expect(scopes).toEqual(
      expect.arrayContaining([
        { scope: 'thread', scopeId: 'A//session-1' },
        { scope: 'thread', scopeId: 'brain-1' },
        { scope: 'persona', scopeId: `A/user-1::${PERSONA_ID}` },
        { scope: 'persona', scopeId: PERSONA_ID },
        { scope: 'organization', scopeId: 'A' },
      ]),
    );
    expect(scopes).not.toContainEqual({ scope: 'organization', scopeId: 'brain-1' });
    expect(scopes).not.toContainEqual({ scope: 'thread', scopeId: 'session-1' });
  });

  it("recalls the memory owner id's organization scope on a turn of the organization whose id it is", async () => {
    const { manager } = await managerOver(tempFile(), 'brain-1');
    const layer = createLearningLayer({ store: new InMemoryLearningStore() });
    const session = await layer.forLearner({ ...KEY_A, namespace: 'brain-1' }, context(manager));
    const { provider } = scriptedProvider([textReply('Noted.')]);
    const { gmi } = await createScriptedGmi({ provider, config: { learning: session, cognitiveMemory: manager } });
    const assemble = vi.spyOn(manager, 'assembleForPrompt');

    await runTurn(gmi, textTurn('t1', 'Hello.', { organizationId: 'brain-1' }));

    // The manager files an organization trace that names no id under the owner id; that organization's turns read it.
    expect(recallScopes(assemble)).toContainEqual({ scope: 'organization', scopeId: 'brain-1' });
  });

  it("recalls a learner's words in the learner's next session and never for tenant B's user of the same id", async () => {
    const { manager } = await managerOver(tempFile(), 'brain-1');
    const layer = createLearningLayer({ store: new InMemoryLearningStore() });
    const first = await createScriptedGmi({
      provider: scriptedProvider([textReply('Noted.')]).provider,
      config: { learning: await layer.forLearner(KEY_A, context(manager)), cognitiveMemory: manager },
    });
    await runTurn(first.gmi, textTurn('t1', 'My canary is LARK-7.', { organizationId: 'A' }));

    const again = scriptedProvider([textReply('LARK-7, you said.')]);
    const second = await createScriptedGmi({
      provider: again.provider,
      config: { learning: await layer.forLearner(KEY_A, context(manager, 'session-2')), cognitiveMemory: manager },
    });
    await runTurn(second.gmi, { ...textTurn('t2', 'What is my canary?', { organizationId: 'A' }), sessionId: 'session-2' });
    expect(textOf(again.received[0])).toContain('LARK-7');

    const tenantB = scriptedProvider([textReply('I do not know.')]);
    const third = await createScriptedGmi({
      provider: tenantB.provider,
      config: { learning: await layer.forLearner({ ...KEY_A, namespace: 'B' }, context(manager, 'session-3')), cognitiveMemory: manager },
    });
    await runTurn(third.gmi, { ...textTurn('t3', 'What is my canary?', { organizationId: 'B' }), sessionId: 'session-3' });
    expect(textOf(tenantB.received[0])).not.toContain('LARK-7');
  });

  it('recalls no organization a user-context override of an earlier turn left on the GMI', async () => {
    const { manager } = await managerOver(tempFile(), 'brain-1');
    const layer = createLearningLayer({ store: new InMemoryLearningStore() });
    const session = await layer.forLearner(KEY_A, context(manager));
    const { provider } = scriptedProvider([textReply('Noted.'), textReply('Hello.')]);
    const { gmi } = await createScriptedGmi({ provider, config: { learning: session, cognitiveMemory: manager } });
    const assemble = vi.spyOn(manager, 'assembleForPrompt');

    // The override's organization stays in the GMI's user context for every later turn.
    await runTurn(gmi, { ...textTurn('t1', 'My canary is LARK-7.', { organizationId: 'A' }), userContextOverride: { organizationId: 'A' } });
    expect(recallScopes(assemble)).toContainEqual({ scope: 'organization', scopeId: 'A' });
    assemble.mockClear();
    await runTurn(gmi, textTurn('t2', 'What is my canary?', { organizationId: 'B' }));

    const scopes = recallScopes(assemble);
    expect(scopes).toContainEqual({ scope: 'organization', scopeId: 'B' });
    expect(scopes).not.toContainEqual({ scope: 'organization', scopeId: 'A' });
  });
});

describe('a turn with no learner', () => {
  it("files a second user's words under the session's form with that user's id, and forgetUser for that user deletes them and leaves the session's other traces", async () => {
    const { manager, brain } = await managerOver(tempFile(), 'brain-1');
    const layer = createLearningLayer({ store: new InMemoryLearningStore() });
    const session = await layer.forLearner(KEY_A, context(manager));
    const { provider } = scriptedProvider([textReply('Hello, user one.'), textReply('Hello, visitor.')]);
    const { gmi } = await createScriptedGmi({ provider, config: { learning: session, cognitiveMemory: manager } });

    await runTurn(gmi, textTurn('t1', 'I am user one.', { organizationId: 'A' }));
    await runTurn(gmi, { ...textTurn('t2', 'I am the visitor.', { organizationId: 'A' }), userId: 'user-2' });

    expect(await filed(brain)).toEqual(
      expect.arrayContaining([
        { scope: 'user', scopeId: 'A/user-1', content: 'I am user one.' },
        { scope: 'user', scopeId: 'A//session-1', content: 'I am the visitor.', turnUserId: 'user-2' },
        { scope: 'user', scopeId: 'A//session-1', content: 'Hello, visitor.', turnUserId: 'user-2' },
      ]),
    );
    const report = await layer.forgetUser('user-2', { namespace: 'A' });
    expect(report.stores).toContainEqual(expect.objectContaining({ store: 'memory manager of brain brain-1', reached: true }));
    expect(await liveContents(brain)).toEqual(['Hello, user one.', 'I am user one.']);
  });

  it("gives tenant B's user of the learner's id no learner on the session the learner opened: B's words go under B's form of the session, and the turn recalls none of A's scopes", async () => {
    const { manager, brain } = await managerOver(tempFile(), 'brain-1');
    const layer = createLearningLayer({ store: new InMemoryLearningStore() });
    const session = await layer.forLearner(KEY_A, context(manager));
    const { provider } = scriptedProvider([textReply('Noted.'), textReply('Hello.')]);
    const { gmi } = await createScriptedGmi({ provider, config: { learning: session, cognitiveMemory: manager } });
    const assemble = vi.spyOn(manager, 'assembleForPrompt');

    await runTurn(gmi, textTurn('t1', 'My canary is LARK-7.', { organizationId: 'A' }));
    assemble.mockClear();
    await runTurn(gmi, textTurn('t2', 'What is my canary?', { organizationId: 'B' }));

    // The session's history still holds A's turn, so the check reads the recall list, not the request.
    const scopes = recallScopes(assemble);
    expect(scopes.filter((entry) => entry.scopeId.startsWith('A'))).toEqual([]);
    expect(scopes).toEqual(
      expect.arrayContaining([
        { scope: 'user', scopeId: 'B//session-1' },
        { scope: 'thread', scopeId: 'B//session-1' },
        { scope: 'organization', scopeId: 'B' },
      ]),
    );
    expect(await filed(brain)).toEqual(
      expect.arrayContaining([
        { scope: 'user', scopeId: 'A/user-1', content: 'My canary is LARK-7.' },
        { scope: 'user', scopeId: 'B//session-1', content: 'What is my canary?', turnUserId: 'user-1' },
      ]),
    );
  });

  it('files each anonymous session under its own form: two of them, and a learner whose id is a session id, recall nothing of each other', async () => {
    const { manager, brain } = await managerOver(tempFile(), 'brain-1');
    const layer = createLearningLayer({ store: new InMemoryLearningStore() });
    const anonymous = { namespace: '', agentKey: 'tutor', userId: 'anonymous_user' };
    const turnOf = async (key: typeof anonymous, sessionId: string, text: string, reply: string) => {
      const scripted = scriptedProvider([textReply(reply)]);
      const { gmi } = await createScriptedGmi({
        provider: scripted.provider,
        config: { learning: await layer.forLearner(key, context(manager, sessionId)), cognitiveMemory: manager },
      });
      const assemble = vi.spyOn(manager, 'assembleForPrompt');
      await runTurn(gmi, { ...textTurn('t', text), userId: key.userId, sessionId });
      const scopes = recallScopes(assemble);
      assemble.mockRestore();
      return { received: scripted.received, scopes };
    };

    await turnOf({ ...anonymous, userId: '42' }, 's-learner', 'Learner canary OWL-3.', 'Noted.');
    const session42 = await turnOf(anonymous, '42', 'Session canary FOX-9.', 'Noted.');
    const sessionB = await turnOf(anonymous, 's-b', 'What do you know?', 'Nothing yet.');

    expect(await filed(brain)).toEqual(
      expect.arrayContaining([
        { scope: 'user', scopeId: '42', content: 'Learner canary OWL-3.' },
        { scope: 'user', scopeId: '/42', content: 'Session canary FOX-9.' },
      ]),
    );
    expect(session42.scopes.filter((entry) => entry.scope === 'user')).toEqual([{ scope: 'user', scopeId: '/42' }]);
    expect(textOf(sessionB.received[0])).not.toContain('OWL-3');
    expect(textOf(sessionB.received[0])).not.toContain('FOX-9');
  });
});

describe("the user's tombstone", () => {
  it('files nothing on a turn of a user forgotten before it', async () => {
    const { manager, brain } = await managerOver(tempFile(), 'brain-1');
    const layer = createLearningLayer({ store: new InMemoryLearningStore() });
    const session = await layer.forLearner(KEY_A, context(manager));
    const { provider } = scriptedProvider([textReply('Noted.')]);
    const { gmi } = await createScriptedGmi({ provider, config: { learning: session, cognitiveMemory: manager } });
    await layer.forgetUser('user-1', { namespace: 'A' });

    await runTurn(gmi, textTurn('t1', 'My canary is LARK-7.', { organizationId: 'A' }));

    expect(await filed(brain)).toEqual([]);
    const notFiled = gmi.getReasoningTrace().entries.filter((entry) => String(entry.message).includes('did not file'));
    expect(notFiled.map((entry) => entry.details?.reason)).toEqual(['forgotten', 'forgotten']);
    expect(JSON.stringify(notFiled)).not.toContain('LARK-7');
  });
});

describe.each([
  ['on a SQLite file of its own', 'own'],
  ["on the learning store's adapter", 'shared'],
] as const)("the user's tombstone, with the GMI's Brain %s", (_name, layout) => {
  it('takes back a filing that commits after another process forgot its user, and leaves no learning row of the user', async () => {
    const { manager, brain, store } = await bridgeLayoutOf(layout);
    const layer = createLearningLayer({ store });
    // A second layer over the same store stands for another process: its write chains do not order this one's.
    const otherProcess = createLearningLayer({ store });
    const session = await layer.forLearner(KEY_A, context(manager));
    const { provider } = scriptedProvider([textReply('Noted.')]);
    const { gmi } = await createScriptedGmi({ provider, config: { learning: session, cognitiveMemory: manager } });
    const encode = manager.encode.bind(manager);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const atEncode = new Promise<void>((resolve) => (reached = resolve));
    vi.spyOn(manager, 'encode').mockImplementationOnce(async (...args: Parameters<typeof manager.encode>) => {
      reached();
      await held;
      return encode(...args);
    });

    const turn = runTurn(gmi, textTurn('t1', 'My canary is LARK-7.', { organizationId: 'A' }));
    await atEncode; // the filing was admitted: the tombstone was clear
    await otherProcess.forgetUser('user-1', { namespace: 'A' });
    release();
    await turn;

    expect(await filed(brain)).toEqual([]);
    expect(await store.sessionRowsOf('A', 'user-1')).toEqual([]);
    expect(await store.chainRows(chainKeyOf(KEY_A))).toEqual([]);
  });
});

describe('what a tool call is told', () => {
  it("gives a learner's calls the turn's scopes, a recorder bound to the turn and the freeze read at the call, and a visitor's calls its id", async () => {
    const { manager } = await managerOver(tempFile(), 'brain-1');
    const store = new InMemoryLearningStore();
    const layer = createLearningLayer({ store });
    const session = await layer.forLearner(KEY_A, context(manager));
    const { provider } = scriptedProvider([lookupStep(), textReply('Found.'), lookupStep(), textReply('Found too.')]);
    const { gmi, processToolCall } = await createScriptedGmi({ provider, config: { learning: session, cognitiveMemory: manager } });

    await runTurn(gmi, textTurn('t1', 'Look it up.', { organizationId: 'A' }));
    await runTurn(gmi, { ...textTurn('t2', 'Look it up for me.', { organizationId: 'A' }), userId: 'user-2' });

    const learner = processToolCall.mock.calls[0][0].sessionData?.learning;
    expect(learner).toMatchObject({
      learner: 'bound',
      mode: 'on',
      scopes: { learner: 'bound', mode: 'on', userScopeId: 'A/user-1', personaScopeId: `A/user-1::${PERSONA_ID}`, namespace: 'A' },
    });
    expect(learner.turnUserId).toBeUndefined();
    expect(learner.frozen()).toBe(false);
    await layer.freeze({ learner: KEY_A });
    expect(learner.frozen()).toBe(true);
    await layer.unfreeze({ learner: KEY_A });
    expect(await learner.recordSelfChange(change('t-1'))).toMatchObject({ status: 'kept', result: 'applied' });

    const visitor = processToolCall.mock.calls[1][0].sessionData?.learning;
    expect(visitor).toMatchObject({
      learner: 'none',
      turnUserId: 'user-2',
      scopes: { learner: 'none', userScopeId: 'A//session-1', personaScopeId: `A//session-1::${PERSONA_ID}`, namespace: 'A' },
    });
    expect(await visitor.recordSelfChange(change('t-2'))).toMatchObject({ status: 'kept' });

    // Each row sits where forgetUser reads: the learner's chain, and the visitor's under the agent with its id.
    const subjects = async (chainKey: string) =>
      (await store.chainRows(chainKey)).filter((row) => row.rowType === 'candidate').map((row) => JSON.parse(row.body).subject);
    expect(await subjects(chainKeyOf(KEY_A))).toContain('t-1');
    expect(await subjects(chainKeyOf({ namespace: 'A', agentKey: 'tutor', userId: null }, 'user-2'))).toEqual(['t-2']);
    const visits = await store.sessionRowsOf('A', 'user-2');
    expect(visits).toEqual([expect.objectContaining({ kind: 'visitor', sessionId: 'session-1', conversationIds: ['session-1'] })]);
  });
});
