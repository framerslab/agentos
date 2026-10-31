/**
 * @file learning-layer.test.ts
 * The learning layer as a host calls it: `createLearningLayer()`, a learner session per session of the host, and
 * `prepareTurn()` before each turn. Covers who is a learner, the turns that have none, the personality section a
 * turn is given, the mode a turn runs in, the manifest, and a session whose learner is named at its first turn.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderPersonalitySection } from '../../substrate/personas/personalityPrompt';
import {
  createLearningLayer,
  deferLearnerSession,
  HOST_LOOP_NAMES,
  LEARNING_LOOP_NAMES,
  type ILearnerSession,
  type LearnerContext,
  type LearnerKey,
  type LearningLayerOptions,
  type TurnInputForLearning,
  type TurnPreparation,
} from '../index';

const AUTHORED = { honesty: 0.9, extraversion: 0.8 };
const context = (over: Partial<LearnerContext> = {}): LearnerContext => ({ sessionId: 's-1', personaId: 'tutor', authoredTraits: AUTHORED, ...over });
const key = (over: Partial<LearnerKey> = {}): LearnerKey => ({ namespace: '', agentKey: 'tutor', userId: 'ana', ...over });
const turn = (over: Partial<TurnInputForLearning> = {}): TurnInputForLearning => ({
  turnId: 't-1',
  userId: 'ana',
  namespace: '',
  text: 'Hello.',
  modelIds: ['stub-model'],
  workflowSeat: false,
  ...over,
});
const stateOf = (prepared: TurnPreparation) => (prepared.learner === 'bound' ? 'bound' : prepared.noLearnerReason);
const quiet = () => vi.spyOn(console, 'log').mockImplementation(() => undefined);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('a learner session prepares each turn', () => {
  it("gives a learner's turn the personality section at priority 2, in mode on", async () => {
    quiet();
    const session = await createLearningLayer().forLearner(key(), context());
    expect(await session.prepareTurn(turn())).toEqual({
      systemPrompts: [{ content: renderPersonalitySection(AUTHORED), priority: 2, source: 'learning:personality' }],
      learner: 'bound',
      mode: 'on',
      scopes: { learner: 'bound', mode: 'on', userScopeId: 'ana', personaScopeId: 'ana::tutor', namespace: '' },
    });
    expect(session.currentTraits()).toEqual({ ...AUTHORED, emotionality: 0.5, agreeableness: 0.5, conscientiousness: 0.5, openness: 0.5 });
    await expect(session.endSession()).resolves.toBeUndefined();
    await expect(session.endSession()).resolves.toBeUndefined();
  });

  it('gives no system prompt for a persona whose traits are all moderate', async () => {
    quiet();
    const session = await createLearningLayer().forLearner(key(), context({ authoredTraits: { honesty: 0.5 } }));
    expect((await session.prepareTurn(turn())).systemPrompts).toEqual([]);
  });

  it('renders a role overlay on the four traits it may set and warns once about the two it may not', async () => {
    quiet();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const session = await createLearningLayer().forLearner(
      null,
      context({ overlayTraits: { honesty: 0.2, extraversion: 0.1 }, noLearnerReason: 'workflow_seat' }),
    );
    const first = await session.prepareTurn(turn());
    await session.prepareTurn(turn({ turnId: 't-2' }));
    expect(first.systemPrompts[0].content).toBe(renderPersonalitySection({ honesty: 0.9, extraversion: 0.1 }));
    expect(first).toMatchObject({ learner: 'none', noLearnerReason: 'workflow_seat' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("persona 'tutor' sets honesty");
  });
});

describe('who is a learner', () => {
  const reasonFor = async (learnerKey: LearnerKey | null, config: LearningLayerOptions = {}, ctx: Partial<LearnerContext> = {}) => {
    quiet();
    const session = await createLearningLayer(config).forLearner(learnerKey, context(ctx));
    return stateOf(await session.prepareTurn(turn({ userId: learnerKey?.userId ?? null })));
  };

  it('binds an explicit user of an agent that has a key', async () => {
    expect(await reasonFor(key())).toBe('bound');
  });

  it('has no learner without a key, and says why the caller gave none', async () => {
    expect(await reasonFor(null)).toBe('no_user_id');
    expect(await reasonFor(null, {}, { noLearnerReason: 'workflow_seat' })).toBe('workflow_seat');
  });

  it('has no learner for a blank or anonymous user id, and for the ids a host adds', async () => {
    for (const userId of ['', '   ', 'anonymous_user', 'anonymous', 'system', 'guest']) {
      expect(await reasonFor(key({ userId })), userId).toBe('placeholder_user');
    }
    const config = { anonymousUserIds: ['agentos-workbench-user'] };
    expect(await reasonFor(key({ userId: 'agentos-workbench-user' }), config)).toBe('placeholder_user');
    expect(await reasonFor(key({ userId: 'guest' }), config)).toBe('placeholder_user');
    expect(await reasonFor(key({ userId: 'ana' }), config)).toBe('bound');
  });

  it('has no learner for an agent with no key, unless the host names one', async () => {
    expect(await reasonFor(key({ agentKey: '' }))).toBe('no_agent_key');
    expect(await reasonFor(key({ agentKey: '' }), { agentKey: 'support-bot' })).toBe('bound');
  });
});

describe('a session belongs to the user of its first turn, in the namespace it was opened under', () => {
  const open = async (config: LearningLayerOptions = {}, learnerKey: LearnerKey = key()): Promise<ILearnerSession> => {
    quiet();
    return createLearningLayer(config).forLearner(learnerKey, context());
  };

  it('has no learner on a turn of another user, nor on any turn after it', async () => {
    const session = await open();
    expect(stateOf(await session.prepareTurn(turn()))).toBe('bound');
    expect(stateOf(await session.prepareTurn(turn({ userId: 'bob' })))).toBe('other_user');
    expect(stateOf(await session.prepareTurn(turn()))).toBe('other_user');
  });

  it("has no learner on a turn of another organization with the same user id, nor on any turn after it", async () => {
    const session = await open({}, key({ namespace: 'A', userId: '42' }));
    expect(stateOf(await session.prepareTurn(turn({ namespace: 'A', userId: '42' })))).toBe('bound');
    expect(stateOf(await session.prepareTurn(turn({ namespace: 'B', userId: '42' })))).toBe('other_namespace');
    expect(stateOf(await session.prepareTurn(turn({ namespace: 'A', userId: '42' })))).toBe('other_namespace');
  });

  it("reads a turn against the namespace the host opened the session under, not the agent's fixed namespace", async () => {
    // gmi() with learning.namespace: its sessions are opened under '' and its turns carry no organization.
    const session = await open({ namespace: 'acme' });
    expect(stateOf(await session.prepareTurn(turn()))).toBe('bound');
    expect(stateOf(await session.prepareTurn(turn({ turnId: 't-2' })))).toBe('bound');
  });

  it('has no learner on a workflow turn, and the next turn of its user has one again', async () => {
    const session = await open();
    expect(stateOf(await session.prepareTurn(turn({ workflowSeat: true })))).toBe('workflow_seat');
    expect(stateOf(await session.prepareTurn(turn()))).toBe('bound');
  });

  it('never reads a tool continuation as another user', async () => {
    const session = await open();
    expect(stateOf(await session.prepareTurn(turn({ userId: 'uninitialized-user', text: null, continuation: true })))).toBe('bound');
    expect(stateOf(await session.prepareTurn(turn()))).toBe('bound');
  });

  it('has no learner after a workflow turn of another user, nor on any turn after it', async () => {
    // The workflow exclusion never hides a hand-over to another user.
    const session = await open();
    expect(stateOf(await session.prepareTurn(turn()))).toBe('bound');
    expect(stateOf(await session.prepareTurn(turn({ userId: 'bob', workflowSeat: true })))).toBe('other_user');
    expect(stateOf(await session.prepareTurn(turn()))).toBe('other_user');
  });

  it('has no learner on a tool continuation under another organization, nor on any turn after it', async () => {
    // A tool-result resume under tenant B on the session tenant A's user opened.
    const session = await open({}, key({ namespace: 'A', userId: '42' }));
    expect(stateOf(await session.prepareTurn(turn({ namespace: 'A', userId: '42' })))).toBe('bound');
    expect(stateOf(await session.prepareTurn(turn({ namespace: 'B', userId: 'uninitialized-user', text: null, continuation: true })))).toBe('other_namespace');
    expect(stateOf(await session.prepareTurn(turn({ namespace: 'A', userId: '42' })))).toBe('other_namespace');
  });
});

describe('the mode a turn runs in', () => {
  const modeOf = async (config: LearningLayerOptions = {}) => {
    quiet();
    const session = await createLearningLayer(config).forLearner(key(), context());
    return (await session.prepareTurn(turn())).mode;
  };

  it('is the configured mode, and every mode renders the authored traits', async () => {
    expect(await modeOf()).toBe('on');
    expect(await modeOf({ mode: 'frozen' })).toBe('frozen');
    expect(await modeOf({ mode: 'off' })).toBe('off');
    const off = await createLearningLayer({ mode: 'off' }).forLearner(key(), context());
    expect((await off.prepareTurn(turn())).systemPrompts[0].content).toBe(renderPersonalitySection(AUTHORED));
  });

  it('is off under AGENTOS_LEARNING_OFF=1 and frozen under AGENTOS_LEARNING_FREEZE=1', async () => {
    vi.stubEnv('AGENTOS_LEARNING_FREEZE', '1');
    expect(await modeOf()).toBe('frozen');
    expect(await modeOf({ mode: 'off' })).toBe('off');
    vi.stubEnv('AGENTOS_LEARNING_OFF', '1');
    expect(await modeOf()).toBe('off');
  });
});

describe('the loop manifest', () => {
  it('names every loop, says why each learning kind is off, counts the turns, and is logged once', async () => {
    const log = quiet();
    const layer = createLearningLayer({ profile: 'full', surface: 'gmi', hostLoops: { memory: { live: true }, sentiment: { live: 'varies', detail: 'set per persona' } } });
    const bound = await layer.forLearner(key(), context());
    const none = await layer.forLearner(null, context({ sessionId: 's-2' }));
    await bound.prepareTurn(turn());
    await bound.prepareTurn(turn({ turnId: 't-2' }));
    await none.prepareTurn(turn({ userId: null }));
    const manifest = await layer.manifest();
    expect(Object.keys(manifest.loops).sort()).toEqual([...HOST_LOOP_NAMES, ...LEARNING_LOOP_NAMES].sort());
    expect(manifest).toMatchObject({ manifestVersion: 1, surface: 'gmi', profile: 'full', mode: 'on', modeSetBy: 'config' });
    expect(manifest.loops.memory).toEqual({ live: true });
    expect(manifest.loops.sentiment).toEqual({ live: 'varies', detail: 'set per persona' });
    expect(manifest.loops.rag).toEqual({ live: false, detail: 'not reported by the host' });
    expect(manifest.loops.personality_rendering).toEqual({ live: true });
    expect(manifest.loops.trait_changes).toEqual({ live: false, detail: 'asked for; this release changes no trait' });
    expect(manifest.loops.ledger).toEqual({ live: true, detail: 'in process: the ledger and the state it records end with the process; unkeyed' });
    expect(manifest.guardrails.complete).toBe(false);
    expect(manifest.turns).toEqual({ prepared: 3, bound: 2, none: { no_user_id: 1 } });
    expect(log.mock.calls.filter((call) => String(call[0]).startsWith('[agentos] learning layer manifest: '))).toHaveLength(1);
  });

  it('lists a kind the host did not ask for as switched off, and says which switch set the mode', async () => {
    vi.stubEnv('AGENTOS_LEARNING_OFF', '1');
    const manifest = await createLearningLayer({ profile: 'light' }).manifest();
    expect(manifest.loops.lessons).toEqual({ live: false, detail: 'switched off' });
    expect(manifest).toMatchObject({ surface: 'custom', profile: 'light', mode: 'off', modeSetBy: 'AGENTOS_LEARNING_OFF' });
  });

  it('refuses a session once the layer is closed, and names the field of a config that is not valid', async () => {
    const layer = createLearningLayer();
    await layer.close();
    await expect(layer.forLearner(key(), context())).rejects.toThrow('The learning layer is closed.');
    expect(() => createLearningLayer({ mode: 'sideways' as never })).toThrow(/learning\.mode/);
  });

  it('reads an option set to null as unset, as one read from JSON or YAML writes it, so each default stands', async () => {
    quiet();
    const nulls = { profile: null, surface: null, hostLoops: null, mode: null, agentKey: null, namespace: null, anonymousUserIds: null };
    const layer = createLearningLayer(nulls as never);
    const session = await layer.forLearner(key(), context());
    expect(stateOf(await session.prepareTurn(turn()))).toBe('bound');
    const manifest = await layer.manifest();
    expect(manifest).toMatchObject({ surface: 'custom', profile: 'custom', mode: 'on', modeSetBy: 'config' });
    expect(manifest.loops.rag).toEqual({ live: false, detail: 'not reported by the host' });
    expect(manifest.loops.trait_changes).toEqual({ live: false, detail: 'switched off' });
  });
});

describe('a learner session named at its first turn', () => {
  it("opens under the first turn's namespace and reads every later turn against it", async () => {
    quiet();
    const layer = createLearningLayer();
    const opened: string[] = [];
    const session = deferLearnerSession({
      traits: AUTHORED,
      open: (namespace) => {
        opened.push(namespace);
        return layer.forLearner(key({ namespace }), context());
      },
    });
    expect(session.currentTraits()).toEqual(AUTHORED);
    await expect(session.endSession()).resolves.toBeUndefined();
    expect(opened).toEqual([]);
    expect(stateOf(await session.prepareTurn(turn({ namespace: 'acme' })))).toBe('bound');
    expect(stateOf(await session.prepareTurn(turn({ namespace: 'acme' })))).toBe('bound');
    expect(opened).toEqual(['acme']);
    expect(stateOf(await session.prepareTurn(turn({ namespace: '' })))).toBe('other_namespace');
  });

  it('tries an open that failed again at the next turn, and ends the session it opened once', async () => {
    quiet();
    const layer = createLearningLayer();
    const opened: string[] = [];
    let failures = 1;
    const ended = vi.fn(async () => undefined);
    const session = deferLearnerSession({
      traits: AUTHORED,
      open: async (namespace) => {
        opened.push(namespace);
        if (failures-- > 0) throw new Error('store offline');
        const inner = await layer.forLearner(key({ namespace }), context());
        return { prepareTurn: (input: TurnInputForLearning) => inner.prepareTurn(input), currentTraits: () => inner.currentTraits(), endSession: ended };
      },
    });
    await expect(session.prepareTurn(turn())).rejects.toThrow('store offline');
    expect(stateOf(await session.prepareTurn(turn()))).toBe('bound');
    expect(opened).toEqual(['', '']);
    await session.endSession();
    expect(ended).toHaveBeenCalledTimes(1);
  });

  /** A deferred session over the layer whose first `failures` opens reject; `wrap` stands for a host's own session. */
  const failingOpens = (failures: number, wrap?: (inner: ILearnerSession) => ILearnerSession) => {
    quiet();
    const layer = createLearningLayer();
    const opened: string[] = [];
    let left = failures;
    const session = deferLearnerSession({
      traits: AUTHORED,
      open: async (namespace) => {
        opened.push(namespace);
        if (left-- > 0) throw new Error('store offline');
        const inner = await layer.forLearner(key({ namespace }), context());
        return wrap ? wrap(inner) : inner;
      },
    });
    return { session, opened };
  };

  it("opens under the first turn's namespace on every attempt", async () => {
    const { session, opened } = failingOpens(1);
    await expect(session.prepareTurn(turn({ namespace: 'A' }))).rejects.toThrow('store offline');
    expect(stateOf(await session.prepareTurn(turn({ namespace: 'B' })))).toBe('other_namespace');
    expect(opened).toEqual(['A', 'A']);
  });

  it('keeps a hand-over to another user or another organization made while it could not open', async () => {
    const byUser = failingOpens(2);
    await expect(byUser.session.prepareTurn(turn())).rejects.toThrow('store offline');
    await expect(byUser.session.prepareTurn(turn({ userId: 'bob' }))).rejects.toThrow('store offline');
    expect(stateOf(await byUser.session.prepareTurn(turn()))).toBe('other_user');
    expect(stateOf(await byUser.session.prepareTurn(turn()))).toBe('other_user');

    const byNamespace = failingOpens(2);
    await expect(byNamespace.session.prepareTurn(turn({ namespace: 'A' }))).rejects.toThrow('store offline');
    await expect(byNamespace.session.prepareTurn(turn({ namespace: 'B' }))).rejects.toThrow('store offline');
    expect(stateOf(await byNamespace.session.prepareTurn(turn({ namespace: 'A' })))).toBe('other_namespace');
  });

  it("keeps the hand-over for a host's own session, and reads no tool continuation as another user", async () => {
    // A host's layer answers with a session of its own, which nothing tells what happened before it opened.
    const hostSession = (inner: ILearnerSession): ILearnerSession => ({
      prepareTurn: (input) => inner.prepareTurn(input),
      currentTraits: () => inner.currentTraits(),
      endSession: () => inner.endSession(),
    });
    const { session } = failingOpens(2, hostSession);
    await expect(session.prepareTurn(turn())).rejects.toThrow('store offline');
    await expect(session.prepareTurn(turn({ userId: 'bob' }))).rejects.toThrow('store offline');
    const after = await session.prepareTurn(turn());
    expect(after).toMatchObject({ learner: 'none', noLearnerReason: 'other_user', mode: 'on' });
    expect(after.systemPrompts[0].content).toBe(renderPersonalitySection(AUTHORED));

    const continued = failingOpens(1);
    await expect(continued.session.prepareTurn(turn())).rejects.toThrow('store offline');
    const continuation = turn({ userId: 'uninitialized-user', text: null, continuation: true });
    expect(stateOf(await continued.session.prepareTurn(continuation))).toBe('bound');
    expect(stateOf(await continued.session.prepareTurn(turn()))).toBe('bound');
  });
});

describe('a learner session named at its first turn, before it opens', () => {
  it("answers the session's form with no learner, and refuses a write while it cannot open", async () => {
    quiet();
    const session = deferLearnerSession({
      traits: AUTHORED,
      sessionId: 's-1',
      personaId: 'tutor',
      open: async () => {
        throw new Error('store offline');
      },
    });
    expect(session.scopesFor!({ userId: 'ana', namespace: '', workflowSeat: false })).toEqual({
      learner: 'none',
      mode: 'on',
      userScopeId: '/s-1',
      personaScopeId: '/s-1::tutor',
      namespace: '',
    });
    const write = {
      kind: 'memory_write' as const,
      actor: 'tool:memory_add',
      subject: 'mt-1',
      before: null,
      after: { created: ['mt-1'], changed: [], deleted: [] },
      brainId: 'b',
      apply: async () => 'mt-1',
      undo: async () => undefined,
    };
    expect(await session.recordSelfChange!(write)).toMatchObject({ status: 'rejected', reason: 'store_unavailable' });
    expect(await session.guardMemoryWrite!({ apply: async () => 1, undo: async () => undefined })).toEqual({ status: 'rejected', reason: 'store_unavailable' });
    expect(session.isFrozen!()).toBe(false);
  });
});
