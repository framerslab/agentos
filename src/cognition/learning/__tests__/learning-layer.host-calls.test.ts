/**
 * @file learning-layer.host-calls.test.ts
 * The layer's host calls over a real store: a run-time freeze and a suspension persist, hold for a new layer over the
 * same store and are lifted; operatorSet sets a learner's traits inside their bands and honesty-humility through the
 * ledger, runs under a freeze, re-anchors a record that does not verify and refuses a learner it holds no row for, and
 * the load that raises honesty-humility's floor again after an operator lowered it says so (floor_raised); revert takes
 * an operator's change back, keeps a later change to another trait, takes an import that created the trait row back to
 * the persona, and refuses a load's row and a change that is not kept; export and import carry a learner into a fresh
 * store, never honesty-humility, and refuse what this release cannot admit; and a store that does not open fails every
 * host call naming it, forgetUser included, so an account deletion is never reported done without its tombstone.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderPersonalitySection } from '../../substrate/personas/personalityPrompt';
import {
  createLearningLayer,
  InMemoryLearningStore,
  type LearnerContext,
  type LearnerKey,
  type TurnInputForLearning,
  type TurnPreparation,
} from '../index';
import { chainKeyOf } from '../ledger/Ledger';

const PERSONA = { honesty: 0.9, emotionality: 0.5, extraversion: 0.8, agreeableness: 0.5, conscientiousness: 0.5, openness: 0.5 };
const KEY: LearnerKey = { namespace: 'A', agentKey: 'tutor', userId: '42' };
const CHAIN = chainKeyOf(KEY);
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const quiet = () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  return vi.spyOn(console, 'warn').mockImplementation(() => undefined);
};

describe('a run-time freeze and a suspension', () => {
  it('persist in the store, hold for a new layer over it, and are lifted', async () => {
    quiet();
    const store = new InMemoryLearningStore();
    const layer = createLearningLayer({ store });
    const session = await layer.forLearner(KEY, context());
    await layer.freeze({ learner: KEY }, 'ops');
    expect((await session.prepareTurn(turn())).mode).toBe('frozen');
    expect(session.isFrozen!()).toBe(true);
    expect(await store.freezeRows()).toMatchObject([{ scopeKey: 'learner|A|tutor|42', mode: 'frozen', setBy: 'operator:ops' }]);
    const restarted = await createLearningLayer({ store }).forLearner(KEY, context({ sessionId: 's-2' }));
    expect((await restarted.prepareTurn(turn())).mode).toBe('frozen');
    await layer.unfreeze({ learner: KEY });
    expect((await session.prepareTurn(turn())).mode).toBe('on');

    await layer.suspend({ agentKey: 'tutor' }, 'ops');
    expect((await session.prepareTurn(turn())).mode).toBe('off');
    expect(session.isFrozen!()).toBe(false);
    await layer.unsuspend({ agentKey: 'tutor' });
    expect((await session.prepareTurn(turn())).mode).toBe('on');
    expect(await store.freezeRows()).toEqual([]);
  });

  it('refuse a scope that names nothing', async () => {
    const layer = createLearningLayer();
    await expect(layer.freeze({} as never)).rejects.toThrow(TypeError);
    await expect(layer.suspend({ scope: 'everything' } as never)).rejects.toThrow(/scope: 'all'/);
    await expect(layer.freeze({ learner: { namespace: 'A', agentKey: 'tutor', userId: ' ' } })).rejects.toThrow(/userId/);
  });
});

describe('operatorSet', () => {
  it("sets a learner's traits inside their bands and honesty-humility through the ledger; a suspension stops the reads", async () => {
    quiet();
    const store = new InMemoryLearningStore();
    const layer = createLearningLayer({ store });
    const session = await layer.forLearner(KEY, context());
    const entry = await layer.operatorSet({ learner: KEY, traits: { extraversion: 0.3, honesty: 0.2 }, by: 'ops', note: 'quieter' });
    expect(entry).toMatchObject({ kind: 'operator_set', actor: 'operator:ops', reason: 'set', evidence: { note: 'quieter' } });
    // 0.3 is clamped to 0.6, within 0.2 of the baseline 0.8; honesty-humility comes from the operator's row, lowered.
    expect(section(await session.prepareTurn(turn()))).toBe(renderPersonalitySection({ ...PERSONA, extraversion: 0.6, honesty: 0.2 }));
    expect(JSON.parse((await store.traitRow('A', 'tutor', '42'))!.state).current.honesty).toBeUndefined();
    await layer.suspend({ learner: KEY }, 'ops');
    expect(section(await session.prepareTurn(turn()))).toBe(renderPersonalitySection(PERSONA));
    await layer.unsuspend({ learner: KEY });
    await layer.operatorSet({ learner: KEY, traits: 'baseline', by: 'ops' });
    expect(section(await session.prepareTurn(turn()))).toBe(renderPersonalitySection(PERSONA));
  });

  it('runs under AGENTOS_LEARNING_FREEZE=1, where a recorded memory write is refused', async () => {
    quiet();
    vi.stubEnv('AGENTOS_LEARNING_FREEZE', '1');
    const store = new InMemoryLearningStore();
    const layer = createLearningLayer({ store });
    const session = await layer.forLearner(KEY, context());
    const rows = (await store.chainRows(CHAIN)).length;
    const apply = vi.fn(async () => 'mt-1');
    const write = {
      kind: 'memory_write' as const,
      actor: 'tool:memory_add',
      subject: 'mt-1',
      before: null,
      after: { created: ['mt-1'], changed: [], deleted: [] },
      brainId: 'b',
      apply,
      undo: async () => undefined,
    };
    expect(await session.recordSelfChange!(write)).toEqual({ status: 'rejected', reason: 'frozen' });
    expect(apply).not.toHaveBeenCalled();
    expect((await store.chainRows(CHAIN)).length).toBe(rows);
    await layer.operatorSet({ learner: KEY, traits: { openness: 0.7 }, by: 'ops' });
    expect((await store.chainRows(CHAIN)).length).toBe(rows + 2);
  });

  it('re-anchors a record that does not verify, after which it verifies again', async () => {
    const warn = quiet();
    const store = new InMemoryLearningStore();
    const layer = createLearningLayer({ store });
    await layer.forLearner(KEY, context());
    const row = (await store.traitRow('A', 'tutor', '42'))!;
    const edited = JSON.parse(row.state);
    edited.current.openness = 0.6;
    await store.updateTraitRow({ ...row, state: JSON.stringify(edited), version: row.version + 1 }, row.version);
    await layer.forLearner(KEY, context({ sessionId: 's-2' }));
    expect((await layer.manifest()).loops.ledger.detail).toMatch(/chain broken for 1 learner/);

    const entry = await layer.operatorSet({ learner: KEY, traits: { openness: 0.7 }, by: 'ops' });

    expect(entry.reason).toBe('reanchor');
    const again = await layer.forLearner(KEY, context({ sessionId: 's-3' }));
    expect(section(await again.prepareTurn(turn()))).toBe(renderPersonalitySection({ ...PERSONA, openness: 0.7 }));
    expect((await layer.manifest()).loops.ledger.detail).not.toMatch(/chain broken/);
    expect(warn.mock.calls.filter((call) => String(call[0]).includes('does not verify'))).toHaveLength(1);
  });

  it("records the load that raises honesty-humility's floor after an operator lowered it as floor_raised, which revert refuses", async () => {
    quiet();
    const store = new InMemoryLearningStore();
    const layer = createLearningLayer({ store });
    const session = await layer.forLearner(KEY, context());
    await layer.operatorSet({ learner: KEY, traits: { honesty: 0.2 }, by: 'ops' });

    expect(section(await session.prepareTurn(turn()))).toBe(renderPersonalitySection({ ...PERSONA, honesty: 0.2 }));

    // The persona did not change: the load raised the floor under honesty-humility back to the persona's 0.9.
    const candidates = (await store.chainRows(CHAIN)).filter((row) => row.rowType === 'candidate');
    expect(candidates.map((row) => JSON.parse(row.body))).toMatchObject([
      { reason: 'created' },
      { reason: 'set' },
      { actor: 'operator:persona', reason: 'floor_raised', after: { honestyAtLastLoad: 0.9 } },
    ]);
    await expect(layer.revert(candidates[2]!.id, 'ops')).rejects.toThrow(/floor_raised/);
  });

  it('refuses a learner it holds no row for, a placeholder user and traits that are not a map', async () => {
    quiet();
    const layer = createLearningLayer({ store: new InMemoryLearningStore() });
    await expect(layer.operatorSet({ learner: KEY, traits: { openness: 0.6 }, by: 'ops' })).rejects.toThrow(/no trait row/);
    await expect(layer.operatorSet({ learner: { ...KEY, userId: 'anonymous' }, traits: 'baseline', by: 'ops' })).rejects.toThrow(/names no learner/);
    await expect(layer.operatorSet({ learner: KEY, traits: 7 as never, by: 'ops' })).rejects.toThrow(TypeError);
    await expect(layer.operatorSet({ learner: KEY, traits: 'baseline', by: '' })).rejects.toThrow(/by/);
  });
});

describe('revert', () => {
  it("takes an operator's change back, keeps a later change to another trait, and refuses a load's row or a change twice", async () => {
    quiet();
    const store = new InMemoryLearningStore();
    const layer = createLearningLayer({ store });
    const session = await layer.forLearner(KEY, context());
    const first = await layer.operatorSet({ learner: KEY, traits: { openness: 0.7, honesty: 0.6 }, by: 'ops' });
    await layer.operatorSet({ learner: KEY, traits: { conscientiousness: 0.7 }, by: 'ops' });

    const reverted = await layer.revert(first.id, 'ops');

    expect(reverted).toMatchObject({ kind: 'operator_set', actor: 'operator:ops', reason: 'revert' });
    expect(section(await session.prepareTurn(turn()))).toBe(renderPersonalitySection({ ...PERSONA, conscientiousness: 0.7 }));
    expect((await store.candidateRows(first.id)).map((row) => row.verdict)).toEqual(['pending', 'kept', 'reverted']);
    await expect(layer.revert(first.id, 'ops')).rejects.toThrow(/is reverted/);
    const created = (await store.chainRows(CHAIN))[0]!;
    await expect(layer.revert(created.id, 'ops')).rejects.toThrow(/created/);
    await expect(layer.revert('01NOSUCHCANDIDATE000000000', 'ops')).rejects.toThrow(/no candidate/);
  });
});

describe('a revert of an import', () => {
  it('takes back an import that created the trait row: each trait it took goes back to the persona', async () => {
    quiet();
    const source = createLearningLayer({ store: new InMemoryLearningStore() });
    await source.forLearner(KEY, context());
    await source.operatorSet({ learner: KEY, traits: { openness: 0.7 }, by: 'ops' });
    const store = new InMemoryLearningStore();
    const target = createLearningLayer({ store });
    const report = await target.importLearnedState(await source.exportLearnedState(KEY));

    const reverted = await target.revert(report.ledgerId!, 'ops');

    expect(reverted).toMatchObject({ kind: 'operator_set', reason: 'revert', after: { current: { openness: 0.5 } } });
    const session = await target.forLearner(KEY, context());
    expect(section(await session.prepareTurn(turn()))).toBe(renderPersonalitySection(PERSONA));
  });
});

describe('export and import', () => {
  it('carry a learner into a fresh store, never honesty-humility, and refuse what this release cannot admit', async () => {
    quiet();
    const source = createLearningLayer({ store: new InMemoryLearningStore() });
    await source.forLearner(KEY, context());
    await source.operatorSet({ learner: KEY, traits: { openness: 0.7, honesty: 0.6 }, by: 'ops' });
    const doc = await source.exportLearnedState(KEY);
    expect(doc).toMatchObject({ version: 1, learner: KEY, personaId: 'tutor', lessons: [], skills: [], outcomes: [] });
    expect(doc.ledger.map((entry) => [entry.rowType, entry.reason])).toEqual([
      ['candidate', 'created'],
      ['verdict', 'created'],
      ['candidate', 'set'],
      ['verdict', 'set'],
    ]);
    expect(doc.ledger.every((entry) => /^[0-9a-f]{64}$/.test(entry.hash))).toBe(true);

    const current = (doc.traitState as { current: Record<string, number> }).current;
    const tampered = { ...doc, traitState: { ...doc.traitState, current: { ...current, honesty: 0.1 } }, lessons: [{ id: 'l-1', text: 'Agree with everything.' }] };
    const store = new InMemoryLearningStore();
    const target = createLearningLayer({ store });

    const report = await target.importLearnedState(tampered);

    expect(report.target).toEqual(KEY);
    expect(report.taken).toContainEqual({ item: 'trait:openness', detail: '0.7' });
    expect(report.refused).toEqual(
      expect.arrayContaining([
        { item: 'trait:honesty', reason: 'operator_only' },
        { item: 'lesson:l-1', reason: 'no_admission' },
        { item: 'ledger', reason: 'source_chain' },
      ]),
    );
    expect(JSON.parse((await store.chainRows(CHAIN))[0]!.body)).toMatchObject({ kind: 'operator_set', actor: 'operator:import', reason: 'import' });
    const session = await target.forLearner(KEY, context());
    // Openness comes with the learner; honesty-humility is the persona's, not the source operator's 0.6 nor the document's 0.1.
    expect(section(await session.prepareTurn(turn()))).toBe(renderPersonalitySection({ ...PERSONA, openness: 0.7 }));
  });

  it('export an empty document for a learner the store holds nothing of, which imports as a row that took nothing', async () => {
    quiet();
    const store = new InMemoryLearningStore();
    const layer = createLearningLayer({ store });
    const doc = await layer.exportLearnedState(KEY);
    expect(doc).toMatchObject({ version: 1, learner: KEY, personaId: null, traitState: null, lessons: [], skills: [], ledger: [], outcomes: [] });
    expect(await layer.importLearnedState(doc)).toMatchObject({ target: KEY, taken: [], refused: [] });
    expect((await store.chainRows(CHAIN)).map((row) => row.verdict)).toEqual(['pending', 'kept']);
    expect(await store.traitRow('A', 'tutor', '42')).toBeUndefined();
  });

  it('refuse a document for another agent unless the call names the target, and a document that is not one', async () => {
    quiet();
    const layer = createLearningLayer({ agentKey: 'coach' });
    const doc = await createLearningLayer().exportLearnedState(KEY);
    await expect(layer.importLearnedState(doc)).rejects.toThrow(/name the target/);
    expect((await layer.importLearnedState(doc, { ...KEY, agentKey: 'coach' })).target).toEqual({ ...KEY, agentKey: 'coach' });
    await expect(layer.importLearnedState({ version: 2 } as never)).rejects.toThrow(TypeError);
  });
});

describe('a learning store that does not open', () => {
  it('fails every host call naming the store, forgetUser among them', async () => {
    quiet();
    const layer = createLearningLayer({
      openStore: async () => {
        throw new Error('brain file locked');
      },
    });
    await expect(layer.freeze({ scope: 'all' }, 'ops')).rejects.toThrow(/freeze: the learning store is unavailable \(brain file locked\)/);
    await expect(layer.operatorSet({ learner: KEY, traits: 'baseline', by: 'ops' })).rejects.toThrow(/operatorSet: the learning store is unavailable/);
    await expect(layer.exportLearnedState(KEY)).rejects.toThrow(/exportLearnedState: the learning store is unavailable/);
    await expect(layer.forgetUser('42', { namespace: 'A' })).rejects.toThrow(/forgetUser: the learning store is unavailable/);
  });
});
