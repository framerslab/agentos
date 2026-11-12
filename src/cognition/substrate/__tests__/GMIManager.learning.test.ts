/**
 * @file GMIManager.learning.test.ts
 * What GMIManager gives each GMI of a runtime with a learning layer: a learner session bound to the user the GMI is
 * created for, under the turn's resolved organization when the caller passes it and under the organization of the
 * GMI's first prepared turn when it does not; a workflow seat's GMI with no learner, whose role overlay renders for
 * that session only, honesty excepted; a learner session ended once its GMI shuts down or fails to initialize, and the
 * GMI's memory manager let go of once the GMI has shut it down. A layer that fails never
 * fails the GMI. Without a layer GMIs are built as before. Real GMIManager and GMIs; the persona loader, the
 * conversation manager and the prompt engine are stubs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GMI } from '../GMI';
import { GMIManager, type GMIAgencyContextOptions, type GMIManagerConfig } from '../GMIManager';
import type { IPersonaDefinition } from '../personas/IPersonaDefinition';
import type { IPersonaLoader } from '../personas/IPersonaLoader';
import { renderPersonalitySection } from '../personas/personalityPrompt';
import type { IUtilityAI } from '../../nlp/ai_utilities/IUtilityAI';
import { createLearningLayer } from '../../learning/LearningLayer';
import type { ILearnerSession, ILearningLayer, TurnInputForLearning, TurnPreparation } from '../../learning/types';
import type { ICognitiveMemoryManager } from '../../memory/CognitiveMemoryManager';
import { ConversationContext } from '../../../core/conversation/ConversationContext';
import type { ConversationManager } from '../../../core/conversation/ConversationManager';
import type { IPromptEngine, PromptEngineConfig } from '../../../core/llm/IPromptEngine';
import type { AIModelProviderManager } from '../../../core/llm/providers/AIModelProviderManager';
import type { IToolOrchestrator } from '../../../core/tools/IToolOrchestrator';

const persona: IPersonaDefinition = {
  id: 'reviewer',
  name: 'Reviewer',
  description: 'Persona for the learning tests.',
  version: '1.0.0',
  baseSystemPrompt: 'You review pull requests.',
  personalityTraits: { honesty: 0.9, extraversion: 0.5 },
};
/** A persona with no traits. */
const traitless: IPersonaDefinition = {
  id: 'plain-reviewer',
  name: 'Plain reviewer',
  description: 'A persona without traits.',
  version: '1.0.0',
  baseSystemPrompt: 'You review pull requests.',
};
const turn = (over: Partial<TurnInputForLearning> = {}): TurnInputForLearning => ({
  turnId: 't',
  userId: 'user-1',
  namespace: '',
  text: 'Hi.',
  modelIds: [],
  workflowSeat: false,
  ...over,
});
const stateOf = (prepared: TurnPreparation) => (prepared.learner === 'bound' ? 'bound' : prepared.noLearnerReason);

const managers: GMIManager[] = [];
async function managerWith(learningLayer?: ILearningLayer, extra: Partial<GMIManagerConfig> = {}): Promise<GMIManager> {
  const personaLoader: IPersonaLoader = {
    initialize: async () => undefined,
    loadPersonaById: async (id: string) => [persona, traitless].find((known) => known.id === id),
    loadAllPersonaDefinitions: async () => [persona, traitless],
  };
  const conversationManager = {
    getOrCreateConversationContext: async () => new ConversationContext('conv-1'),
  } as unknown as ConversationManager;
  const manager = new GMIManager(
    { personaLoaderConfig: { personaSource: 'in-memory' }, ...(learningLayer ? { learningLayer } : {}), ...extra },
    undefined,
    undefined,
    conversationManager,
    { estimateTokenCount: async () => 10 } as unknown as IPromptEngine,
    {} as unknown as AIModelProviderManager,
    {} as unknown as IUtilityAI,
    { listAvailableTools: async () => [] } as unknown as IToolOrchestrator,
    undefined,
    personaLoader,
  );
  await manager.initialize();
  managers.push(manager);
  return manager;
}
/** A layer whose learner sessions record their end. */
function recordingLayer(forLearner: ILearningLayer['forLearner']): ILearningLayer {
  return { manifest: vi.fn(), forLearner: vi.fn(forLearner), close: vi.fn(async () => undefined) } as unknown as ILearningLayer;
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
  vi.restoreAllMocks();
});

describe('a runtime with a learning layer', () => {
  it("binds the GMI's learner session to its user, under the organization the caller passed", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const manager = await managerWith(createLearningLayer());
    const { gmi } = await manager.getOrCreateGMIForSession('user-1', 'session-1', persona.id, undefined, undefined, undefined, undefined, undefined, 'A');
    const session = gmi.getLearnerSession!()!;
    const first = await session.prepareTurn(turn({ namespace: 'A' }));
    expect(stateOf(first)).toBe('bound');
    expect(first.systemPrompts[0].content).toBe(renderPersonalitySection(persona.personalityTraits));
    expect(stateOf(await session.prepareTurn(turn({ namespace: 'B' })))).toBe('other_namespace');
    expect(stateOf(await session.prepareTurn(turn({ namespace: 'A' })))).toBe('other_namespace');
  });

  it("binds it under the organization of the GMI's first prepared turn when the caller passed none", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const manager = await managerWith(createLearningLayer());
    const { gmi } = await manager.getOrCreateGMIForSession('user-1', 'session-1', persona.id);
    const session = gmi.getLearnerSession!()!;
    expect(stateOf(await session.prepareTurn(turn({ namespace: 'A' })))).toBe('bound');
    expect(stateOf(await session.prepareTurn(turn({ namespace: '' })))).toBe('other_namespace');
  });

  it("gives a workflow seat's GMI no learner and renders the overlay's patch on the traits it may set, for that session only", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const manager = await managerWith(createLearningLayer());
    const seat: GMIAgencyContextOptions = {
      agencyId: 'agency-1',
      roleId: 'second-reader',
      evolutionRules: [{ id: 'sharper', trigger: 'always', patch: { personaTraits: { honesty: 0.2, extraversion: 0.9 } } }],
    };
    const { gmi } = await manager.getOrCreateGMIForSession('user-1', 'seat-session', persona.id, undefined, undefined, undefined, undefined, seat, 'A');
    const prepared = await gmi.getLearnerSession!()!.prepareTurn(turn({ namespace: 'A' }));
    expect(prepared).toMatchObject({ learner: 'none', noLearnerReason: 'workflow_seat' });
    expect(prepared.systemPrompts[0].content).toBe(renderPersonalitySection({ honesty: 0.9, extraversion: 0.9 }));
    expect(warn.mock.calls.some((call) => String(call[0]).includes("persona 'reviewer' sets honesty"))).toBe(true);

    const { gmi: plain } = await manager.getOrCreateGMIForSession('user-2', 'plain-session', persona.id, undefined, undefined, undefined, undefined, undefined, 'A');
    const plainTurn = await plain.getLearnerSession!()!.prepareTurn(turn({ userId: 'user-2', namespace: 'A' }));
    expect(plainTurn.systemPrompts[0].content).toBe(renderPersonalitySection(persona.personalityTraits));
  });

  it("reads a role overlay's patch written under an alias of a trait the persona sets by its canonical key", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const manager = await managerWith(createLearningLayer());
    const seat: GMIAgencyContextOptions = {
      agencyId: 'agency-1',
      roleId: 'second-reader',
      evolutionRules: [{ id: 'softer', trigger: 'always', patch: { personaTraits: { honestyHumility: 0.1, extraversion: 0.9 } } }],
    };
    const { gmi } = await manager.getOrCreateGMIForSession('user-1', 'seat-session', persona.id, undefined, undefined, undefined, undefined, seat, 'A');
    const prepared = await gmi.getLearnerSession!()!.prepareTurn(turn({ namespace: 'A' }));
    // The persona's honesty stays, and the patch that names it under its SOUL.md spelling is warned about.
    expect(prepared.systemPrompts[0].content).toBe(renderPersonalitySection({ honesty: 0.9, extraversion: 0.9 }));
    expect(warn.mock.calls.some((call) => String(call[0]).includes("persona 'reviewer' sets honesty"))).toBe(true);
  });

  it("opens a session whose first open failed under its first turn's organization, and keeps a hand-over made while it could not open", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const real = createLearningLayer();
    let failures = 2;
    const layer = recordingLayer(async (learnerKey, context) => {
      if (failures-- > 0) throw new Error('store offline');
      return real.forLearner(learnerKey, context);
    });
    const manager = await managerWith(layer);
    // No organization from the caller: the session opens at the GMI's first prepared turn.
    const { gmi } = await manager.getOrCreateGMIForSession('user-1', 'session-1', persona.id);
    const session = gmi.getLearnerSession!()!;
    await expect(session.prepareTurn(turn({ namespace: 'A' }))).rejects.toThrow('store offline');
    await expect(session.prepareTurn(turn({ namespace: 'B' }))).rejects.toThrow('store offline');
    expect(stateOf(await session.prepareTurn(turn({ namespace: 'A' })))).toBe('other_namespace');
    expect(stateOf(await session.prepareTurn(turn({ namespace: 'A' })))).toBe('other_namespace');
    expect(vi.mocked(layer.forLearner).mock.calls.map(([learnerKey]) => learnerKey?.namespace)).toEqual(['A', 'A', 'A']);
  });

  it("ends a GMI's learner session once the GMI shuts down", async () => {
    const endSession = vi.fn(async () => undefined);
    const layer = recordingLayer(async () => ({ prepareTurn: vi.fn(), endSession, currentTraits: () => ({}) }) as unknown as ILearnerSession);
    const manager = await managerWith(layer);
    await manager.getOrCreateGMIForSession('user-1', 'session-1', persona.id, undefined, undefined, undefined, undefined, undefined, '');
    expect(layer.forLearner).toHaveBeenCalledWith(
      { namespace: '', agentKey: 'reviewer', userId: 'user-1' },
      expect.objectContaining({ sessionId: 'session-1', personaId: 'reviewer', authoredTraits: { honesty: 0.9, extraversion: 0.5 } }),
    );
    await manager.deactivateGMIForSession('session-1');
    expect(endSession).toHaveBeenCalledTimes(1);
  });

  it('ends the learner session it made for a GMI that fails to initialize', async () => {
    const endSession = vi.fn(async () => undefined);
    const layer = recordingLayer(async () => ({ prepareTurn: vi.fn(), endSession, currentTraits: () => ({}) }) as unknown as ILearnerSession);
    const manager = await managerWith(layer);
    vi.spyOn(GMI.prototype, 'initialize').mockRejectedValueOnce(new Error('initialize failed'));
    await expect(
      manager.getOrCreateGMIForSession('user-1', 'session-1', persona.id, undefined, undefined, undefined, undefined, undefined, ''),
    ).rejects.toThrow(/Failed to initialize new GMI instance/);
    expect(endSession).toHaveBeenCalledTimes(1);
  });

  it('builds the GMI when the layer fails, with a learner session that asks again each turn and rejects until one opens', async () => {
    // A GMI with no session would tell its tools nothing, and they would act as on a host with no layer.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const layer = recordingLayer(async () => {
      throw new Error('layer down');
    });
    const manager = await managerWith(layer);
    const { gmi } = await manager.getOrCreateGMIForSession('user-1', 'session-1', persona.id, undefined, undefined, undefined, undefined, undefined, '');
    expect(warn.mock.calls.some((call) => String(call[0]).includes('no learner session'))).toBe(true);
    // A rejected preparation is a turn with no learner on the GMI, whose tools then refuse (GMI.learning.test.ts).
    await expect(gmi.getLearnerSession!()!.prepareTurn(turn())).rejects.toThrow('layer down');
    expect(layer.forLearner).toHaveBeenCalledTimes(2);
  });

  it('builds the GMI within the open budget when the layer does not answer, with a session the open answers when it comes', async () => {
    // A runtime turn waits on GMI acquisition; an open that never settles would hold the turn for good.
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let answer: ((session: ILearnerSession) => void) | undefined;
    const layer = recordingLayer(() => new Promise<ILearnerSession>((resolve) => {
      answer = resolve;
    }));
    // Long enough that the open is still the session's when it answers, past the acquisition's budget.
    const manager = await managerWith(layer, { shutdownTimeoutMs: 5_000 });
    const startedAt = Date.now();
    const { gmi } = await manager.getOrCreateGMIForSession('user-1', 'session-1', persona.id, undefined, undefined, undefined, undefined, undefined, 'A');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_900);
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    expect(warn.mock.calls.some((call) => String(call[0]).includes('no learner session'))).toBe(true);
    // The late answer is the session's: the GMI's first turn takes it, and the layer is not asked again.
    const session = gmi.getLearnerSession!()!;
    const prepared = session.prepareTurn(turn({ namespace: 'A' }));
    const late = await createLearningLayer().forLearner(
      { namespace: 'A', agentKey: 'reviewer', userId: 'user-1' },
      { sessionId: 'session-1', personaId: 'reviewer', authoredTraits: { honesty: 0.9, extraversion: 0.5 } },
    );
    answer!(late);
    expect(stateOf(await prepared)).toBe('bound');
    expect(layer.forLearner).toHaveBeenCalledTimes(1);
  }, 10_000);

  it("asks the layer again at the GMI's first turn when the open its build left running fails before that turn", async () => {
    // A failed open is no answer for a turn that comes after it: the turn asks the layer again.
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const real = createLearningLayer();
    let fail: ((error: Error) => void) | undefined;
    let opens = 0;
    const layer = recordingLayer((learnerKey, context) => {
      opens += 1;
      if (opens > 1) return real.forLearner(learnerKey, context);
      return new Promise<ILearnerSession>((_resolve, reject) => {
        fail = reject;
      });
    });
    // Long enough that the open is still the session's when it fails, past the acquisition's budget.
    const manager = await managerWith(layer, { shutdownTimeoutMs: 5_000 });
    const { gmi } = await manager.getOrCreateGMIForSession('user-1', 'session-1', persona.id, undefined, undefined, undefined, undefined, undefined, 'A');
    // The open fails after the GMI was built and before its first turn.
    fail!(new Error('layer down'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stateOf(await gmi.getLearnerSession!()!.prepareTurn(turn({ namespace: 'A' })))).toBe('bound');
    expect(layer.forLearner).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('ends the learner session of a GMI that fails to initialize within shutdownTimeoutMs, when the session does not end', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const endSession = vi.fn(() => new Promise<void>(() => undefined));
    const layer = recordingLayer(async () => ({ prepareTurn: vi.fn(), endSession, currentTraits: () => ({}) }) as unknown as ILearnerSession);
    const manager = await managerWith(layer, { shutdownTimeoutMs: 200 });
    vi.spyOn(GMI.prototype, 'initialize').mockRejectedValueOnce(new Error('initialize failed'));
    const startedAt = Date.now();
    await expect(
      manager.getOrCreateGMIForSession('user-1', 'session-1', persona.id, undefined, undefined, undefined, undefined, undefined, ''),
    ).rejects.toThrow(/Failed to initialize new GMI instance/);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(endSession).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.some((call) => String(call[0]).includes('did not end within 200 ms'))).toBe(true);
  }, 10_000);

  it('treats an answer of the layer that is not a learner session as a failed open, so each turn has no learner', async () => {
    // A GMI with no session would tell its tools nothing, and they would act as on a host with no layer.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const layer = recordingLayer(async () => undefined as unknown as ILearnerSession);
    const manager = await managerWith(layer);
    const { gmi } = await manager.getOrCreateGMIForSession('user-1', 'session-1', persona.id, undefined, undefined, undefined, undefined, undefined, 'A');
    expect(warn.mock.calls.some((call) => String(call[0]).includes('no learner session'))).toBe(true);
    const session = gmi.getLearnerSession!()!;
    expect(session).toBeDefined();
    await expect(session.prepareTurn(turn({ namespace: 'A' }))).rejects.toThrow(/no learner session/);
    expect(layer.forLearner).toHaveBeenCalledTimes(2);
  });

  it('treats an answer with only some of a learner session as a failed open', async () => {
    // A session that cannot end, or say its traits, would fail at the GMI's shutdown instead of at its open.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const layer = recordingLayer(async () => ({ prepareTurn: vi.fn() }) as unknown as ILearnerSession);
    const manager = await managerWith(layer);
    const { gmi } = await manager.getOrCreateGMIForSession('user-1', 'session-1', persona.id, undefined, undefined, undefined, undefined, undefined, 'A');
    expect(warn.mock.calls.some((call) => String(call[0]).includes('no learner session'))).toBe(true);
    await expect(gmi.getLearnerSession!()!.prepareTurn(turn({ namespace: 'A' }))).rejects.toThrow(/no learner session/);
  });

  it('asks the layer again for a session an open has not given within shutdownTimeoutMs, and ends one it gives later', async () => {
    // A stalled open would otherwise hold every later turn of the GMI to its preparation budget, with no new ask.
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const real = createLearningLayer();
    const lateEnd = vi.fn(async () => undefined);
    let opens = 0;
    const layer = recordingLayer(async (learnerKey, context) => {
      opens += 1;
      if (opens > 1) return real.forLearner(learnerKey, context);
      await new Promise((resolve) => setTimeout(resolve, 600));
      return { prepareTurn: vi.fn(), currentTraits: () => ({}), endSession: lateEnd } as unknown as ILearnerSession;
    });
    const manager = await managerWith(layer, { shutdownTimeoutMs: 200 });
    const { gmi } = await manager.getOrCreateGMIForSession('user-1', 'session-1', persona.id, undefined, undefined, undefined, undefined, undefined, 'A');
    expect(stateOf(await gmi.getLearnerSession!()!.prepareTurn(turn({ namespace: 'A' })))).toBe('bound');
    expect(layer.forLearner).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(lateEnd).toHaveBeenCalledTimes(1));
  }, 10_000);

  it("hands the learner session the GMI's memory manager, which the layer re-files, hydrates and reaches in forgetUser", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const memory = { getStore: () => undefined, shutdown: async () => undefined } as unknown as ICognitiveMemoryManager;
    const layer = recordingLayer(async () => ({ prepareTurn: vi.fn(), endSession: vi.fn(async () => undefined), currentTraits: () => ({}) }) as unknown as ILearnerSession);
    const manager = await managerWith(layer, { cognitiveMemoryFactory: async () => memory });
    // The GMI's own initialization is not what this case reads: what the manager hands the layer is.
    vi.spyOn(GMI.prototype, 'initialize').mockRejectedValueOnce(new Error('initialize failed'));
    await expect(
      manager.getOrCreateGMIForSession('user-1', 'session-1', persona.id, undefined, undefined, undefined, undefined, undefined, ''),
    ).rejects.toThrow(/Failed to initialize new GMI instance/);
    expect(layer.forLearner).toHaveBeenCalledWith(
      { namespace: '', agentKey: 'reviewer', userId: 'user-1' },
      expect.objectContaining({ sessionId: 'session-1', memory }),
    );
  });

  it("lets go of a GMI's memory manager once the GMI has shut it down, so forgetUser asks no manager that can no longer answer", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let shut = false;
    // A manager of the GMI's own, which the GMI's shutdown shuts down: from then on every call fails, as a real one does.
    const memory = {
      getStore: () => undefined,
      deleteScope: vi.fn(async () => {
        if (shut) throw new Error('CognitiveMemoryManager not initialized. Call initialize() first.');
        return { deleted: 0, graph: 'reached' };
      }),
      shutdown: async () => {
        shut = true;
      },
    } as unknown as ICognitiveMemoryManager;
    const layer = createLearningLayer();
    const manager = await managerWith(layer, { cognitiveMemoryFactory: async () => memory });
    await manager.getOrCreateGMIForSession('user-1', 'session-1', persona.id, undefined, undefined, undefined, undefined, undefined, 'A');
    await manager.deactivateGMIForSession('session-1');
    expect(shut).toBe(true);

    const report = await layer.forgetUser('user-1', { namespace: 'A' });
    expect(report.stores.filter((entry) => /memory manager/.test(entry.store) && !entry.reached)).toEqual([]);
    expect(report.stores).toContainEqual(expect.objectContaining({ store: 'learning store', reached: true }));
  });

  it("names a turn's scope ids by the session's own form, with no learner, before the GMI's first prepared turn opens its session", async () => {
    // The pipeline asks for the turn's scope ids before the GMI prepares the turn; a session with no answer would let
    // the retriever and the sink read and file under the ids a host with no layer uses.
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const manager = await managerWith(createLearningLayer());
    const { gmi } = await manager.getOrCreateGMIForSession('user-1', 'session-1', persona.id);
    const session = gmi.getLearnerSession!()!;
    expect(session.scopesFor!({ userId: 'user-1', namespace: 'A', workflowSeat: false })).toEqual({
      learner: 'none',
      mode: 'on',
      userScopeId: 'A//session-1',
      personaScopeId: 'A//session-1::reviewer',
      namespace: 'A',
    });
    expect(stateOf(await session.prepareTurn(turn({ namespace: 'A' })))).toBe('bound');
    expect(session.scopesFor!({ userId: 'user-1', namespace: 'A', workflowSeat: false })).toMatchObject({ learner: 'bound', userScopeId: 'A/user-1' });
  });

  it("answers a turn's scope ids, its recorder and its guard through the session an open past the 2,000 ms budget gives, and the session's own form before it", async () => {
    // A GMI whose open ran late would otherwise give its tools no recorder and the pipeline no scope ids for its life.
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let answer: ((session: ILearnerSession) => void) | undefined;
    const layer = recordingLayer(() => new Promise<ILearnerSession>((resolve) => {
      answer = resolve;
    }));
    const manager = await managerWith(layer, { shutdownTimeoutMs: 5_000 });
    const { gmi } = await manager.getOrCreateGMIForSession('user-1', 'session-1', persona.id, undefined, undefined, undefined, undefined, undefined, '');
    const session = gmi.getLearnerSession!()!;
    // Before it opens, the deferred session names the session's own form, with no learner.
    expect(session.scopesFor!({ userId: 'user-1', namespace: '', workflowSeat: false })).toMatchObject({
      learner: 'none',
      userScopeId: '/session-1',
      personaScopeId: '/session-1::reviewer',
    });
    const prepared = session.prepareTurn(turn());
    answer!(
      await createLearningLayer().forLearner(
        { namespace: '', agentKey: 'reviewer', userId: 'user-1' },
        { sessionId: 'session-1', personaId: 'reviewer', authoredTraits: { honesty: 0.9, extraversion: 0.5 } },
      ),
    );
    expect(stateOf(await prepared)).toBe('bound');
    expect(session.scopesFor!({ userId: 'user-1', namespace: '', workflowSeat: false })).toMatchObject({ learner: 'bound', userScopeId: 'user-1' });
    expect(typeof session.recordSelfChange).toBe('function');
    expect(session.isFrozen!()).toBe(false);
    expect(await session.guardMemoryWrite!({ apply: async () => 'filed', undo: async () => undefined }, { learner: 'bound', namespace: '' })).toEqual({
      status: 'written',
      result: 'filed',
    });
    expect(layer.forLearner).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('ends the learner session of a seat GMI that fails to initialize within shutdownTimeoutMs, when the session does not end', async () => {
    // A launch waits on the seat's creation; a session that never ends would hold the launch for good.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const endSession = vi.fn(() => new Promise<void>(() => undefined));
    const layer = recordingLayer(async () => ({ prepareTurn: vi.fn(), endSession, currentTraits: () => ({}) }) as unknown as ILearnerSession);
    const agencySeatPromptEngineConfig = {
      defaultTemplateName: 'openai_chat',
      availableTemplates: {},
      tokenCounting: { strategy: 'estimated', estimationModel: 'gpt-3.5-turbo' },
      historyManagement: { defaultMaxMessages: 100, maxTokensForHistory: 8_000, summarizationTriggerRatio: 0, preserveImportantMessages: true },
      contextManagement: { maxRAGContextTokens: 1_500, summarizationQualityTier: 'balanced', preserveSourceAttributionInSummary: true },
      contextualElementSelection: { maxElementsPerType: {}, defaultMaxElementsPerType: 3, priorityResolutionStrategy: 'highest_first', conflictResolutionStrategy: 'skip_conflicting' },
      performance: { enableCaching: false, cacheTimeoutSeconds: 60 },
    } as unknown as PromptEngineConfig;
    const manager = await managerWith(layer, { shutdownTimeoutMs: 200, agencySeatPromptEngineConfig });
    vi.spyOn(GMI.prototype, 'initialize').mockRejectedValueOnce(new Error('initialize failed'));
    const startedAt = Date.now();
    await expect(
      manager.createAgencySeat({ seatSessionId: 'seat:launch-1:writer', userId: 'user-1', persona: { personaId: persona.id }, toolView: (base) => base }),
    ).rejects.toThrow(/Failed to initialize the agency seat GMI/);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(endSession).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.some((call) => String(call[0]).includes('did not end within 200 ms'))).toBe(true);
  }, 10_000);
});

describe('a runtime without a learning layer', () => {
  it('builds GMIs with no learner session, as before', async () => {
    const manager = await managerWith();
    const { gmi } = await manager.getOrCreateGMIForSession('user-1', 'session-1', persona.id, undefined, undefined, undefined, undefined, undefined, 'A');
    expect(gmi.getLearnerSession!()).toBeUndefined();
  });

  it("gives a persona's GMI its traits, which the GMI renders itself, and a persona with none no traits", async () => {
    const initialize = vi.spyOn(GMI.prototype, 'initialize');
    const manager = await managerWith();
    await manager.getOrCreateGMIForSession('user-1', 'session-1', persona.id, undefined, undefined, undefined, undefined, undefined, 'A');
    await manager.getOrCreateGMIForSession('user-1', 'session-2', traitless.id, undefined, undefined, undefined, undefined, undefined, 'A');
    const [withTraits, without] = initialize.mock.calls.map(([, config]) => config);
    expect(withTraits.personaTraits).toEqual({ authored: { honesty: 0.9, extraversion: 0.5 } });
    expect(withTraits.learning).toBeUndefined();
    expect(without.personaTraits).toBeUndefined();
    expect(without.learning).toBeUndefined();
  });
});
