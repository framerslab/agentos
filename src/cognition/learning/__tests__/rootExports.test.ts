/**
 * @file rootExports.test.ts
 * The learning layer at the package root as a host reaches it: the layer, its session and context types, the trait map
 * a learner context carries and a session answers (`HexacoTraitValues`), both learning stores, the host calls' inputs
 * and reports, and the tool context a host loop hands its tools. A host builds a layer over a SQL learning store on its
 * own adapter and carries a learner into an in-process store with nothing but root imports, and each value the root
 * exports is the one the `@framers/agentos/cognition/learning` subpath serves; the module's internals (the ledger, the
 * schema, the deferred session) stay on the subpath. The type checks run in `tsc --noEmit`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveStorageAdapter } from '@framers/sql-storage-adapter';
import * as root from '../../../index.js';
import type {
  ForgetReport,
  FreezeScope,
  HexacoTraitValues,
  ILearnerSession,
  ImportReport,
  LearnedStateDocument,
  LearnerContext,
  LearnerKey,
  LearningLayerHandle,
  LearningStore,
  LedgerEntry,
  OperatorSetInput,
  SqlLearningStoreOptions,
  ToolLearningContext,
  TurnScopes,
} from '../../../index.js';
import * as learning from '../index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const PERSONA: HexacoTraitValues = { honesty: 0.9, emotionality: 0.5, extraversion: 0.8, agreeableness: 0.5, conscientiousness: 0.5, openness: 0.5 };
const KEY: LearnerKey = { namespace: 'A', agentKey: 'tutor', userId: '42' };

describe('the learning surface at the package root', () => {
  it("types a learner context's traits and a session's answer with the root's trait map", async () => {
    // The layer logs its manifest once, at its first session.
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const authored: HexacoTraitValues = { honesty: 0.9, openness: 0.2 };
    const context: LearnerContext = { sessionId: 's-1', personaId: 'tutor', authoredTraits: authored };
    const session: ILearnerSession = await root.createLearningLayer().forLearner(null, context);
    const traits: HexacoTraitValues = session.currentTraits();
    expect(traits).toEqual(authored);
  });

  it('builds a layer over a SQL store on the host adapter and carries a learner into an in-process store', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const adapter = await resolveStorageAdapter({ filePath: ':memory:', priority: ['better-sqlite3', 'sqljs'], quiet: true });
    try {
      const options: SqlLearningStoreOptions = { adapter };
      const store: LearningStore = new root.SqlLearningStore(options);
      const source: LearningLayerHandle = root.createLearningLayer({ store });
      const context: LearnerContext = { sessionId: 's-1', personaId: 'tutor', authoredTraits: PERSONA };
      await source.forLearner(KEY, context);

      const frozen: FreezeScope = { learner: KEY };
      await source.freeze(frozen, 'ops');
      const input: OperatorSetInput = { learner: KEY, traits: { openness: 0.7 }, by: 'ops' };
      // An operator's change runs under a freeze.
      const entry: LedgerEntry = await source.operatorSet(input);
      expect(entry).toMatchObject({ kind: 'operator_set', actor: 'operator:ops', reason: 'set' });
      const doc: LearnedStateDocument = await source.exportLearnedState(KEY);
      expect(doc).toMatchObject({ version: 1, learner: KEY, personaId: 'tutor' });

      const target: LearningLayerHandle = root.createLearningLayer({ store: new root.InMemoryLearningStore() });
      const report: ImportReport = await target.importLearnedState(doc);
      expect(report.target).toEqual(KEY);
      expect(report.taken).toContainEqual({ item: 'trait:openness', detail: '0.7' });
      const carried = await target.forLearner(KEY, context);
      expect(carried.currentTraits()).toMatchObject({ openness: 0.7 });

      const forgotten: ForgetReport = await source.forgetUser('42', { namespace: 'A' });
      expect(forgotten).toMatchObject({ userId: '42', namespace: 'A' });
      expect(forgotten.stores).toContainEqual(expect.objectContaining({ store: 'learning store', reached: true }));
      await source.close();
      await target.close();
    } finally {
      await adapter.close();
    }
  });

  it("hands a host loop's tools the turn's scopes through the root's tool context", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const layer = root.createLearningLayer({ store: new root.InMemoryLearningStore() });
    const session = await layer.forLearner(KEY, { sessionId: 's-1', personaId: 'tutor', authoredTraits: PERSONA });
    const scopes: TurnScopes = session.scopesFor!({ userId: '42', namespace: 'A', workflowSeat: false });
    expect(scopes).toMatchObject({ learner: 'bound', namespace: 'A' });
    const { tools, writeTurn } = root.toolLearningContextFor(session, { learner: 'bound', mode: 'on', scopes });
    const context: ToolLearningContext = tools;
    expect(context).toMatchObject({ learner: 'bound', mode: 'on', scopes });
    // The turn's recorder and freeze read are the session's, bound to the turn.
    expect(typeof context.recordSelfChange).toBe('function');
    expect(context.frozen?.()).toBe(false);
    expect(writeTurn).toEqual({ learner: 'bound', namespace: 'A' });
    await layer.close();
  });

  it("exports the subpath's own values, and leaves the module's internals to the subpath", () => {
    expect(root.createLearningLayer).toBe(learning.createLearningLayer);
    expect(root.InMemoryLearningStore).toBe(learning.InMemoryLearningStore);
    expect(root.SqlLearningStore).toBe(learning.SqlLearningStore);
    expect(root.toolLearningContextFor).toBe(learning.toolLearningContextFor);
    for (const name of ['Ledger', 'deferLearnerSession', 'ensureLearningSchema', 'resolveLearning']) {
      expect(name in learning).toBe(true);
      expect(name in root).toBe(false);
    }
  });
});
