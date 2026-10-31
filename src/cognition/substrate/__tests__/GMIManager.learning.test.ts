/**
 * @file GMIManager.learning.test.ts
 * What GMIManager gives each GMI of a runtime with a learning layer: a learner session bound to the user the GMI is
 * created for, under the turn's resolved organization when the caller passes it and under the organization of the
 * GMI's first prepared turn when it does not; a workflow seat's GMI with no learner, whose role overlay renders for
 * that session only, honesty excepted; and a learner session ended once its GMI shuts down or fails to initialize. A layer that fails never
 * fails the GMI. Without a layer GMIs are built as before. Real GMIManager and GMIs; the persona loader, the
 * conversation manager and the prompt engine are stubs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GMI } from '../GMI';
import { GMIManager, type GMIAgencyContextOptions } from '../GMIManager';
import type { IPersonaDefinition } from '../personas/IPersonaDefinition';
import type { IPersonaLoader } from '../personas/IPersonaLoader';
import { renderPersonalitySection } from '../personas/personalityPrompt';
import type { IUtilityAI } from '../../nlp/ai_utilities/IUtilityAI';
import { createLearningLayer } from '../../learning/LearningLayer';
import type { ILearnerSession, ILearningLayer, TurnInputForLearning, TurnPreparation } from '../../learning/types';
import { ConversationContext } from '../../../core/conversation/ConversationContext';
import type { ConversationManager } from '../../../core/conversation/ConversationManager';
import type { IPromptEngine } from '../../../core/llm/IPromptEngine';
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
async function managerWith(learningLayer?: ILearningLayer): Promise<GMIManager> {
  const personaLoader: IPersonaLoader = {
    initialize: async () => undefined,
    loadPersonaById: async (id: string) => (id === persona.id ? persona : undefined),
    loadAllPersonaDefinitions: async () => [persona],
  };
  const conversationManager = {
    getOrCreateConversationContext: async () => new ConversationContext('conv-1'),
  } as unknown as ConversationManager;
  const manager = new GMIManager(
    { personaLoaderConfig: { personaSource: 'in-memory' }, ...(learningLayer ? { learningLayer } : {}) },
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
});

describe('a runtime without a learning layer', () => {
  it('builds GMIs with no learner session, as before', async () => {
    const manager = await managerWith();
    const { gmi } = await manager.getOrCreateGMIForSession('user-1', 'session-1', persona.id, undefined, undefined, undefined, undefined, undefined, 'A');
    expect(gmi.getLearnerSession!()).toBeUndefined();
  });
});
