/**
 * @file AgentOSOrchestrator.learning-memory.spec.ts
 * The turn pipeline hands the standalone retriever and the rolling-summary sink the turn's scope ids and recorder from
 * the GMI's learner session (a real layer over an in-process store), asked once before the GMI prepares the turn: a
 * learner's turn reads and files under the learner's scope ids, with the compaction's contributors kept in the
 * conversation's metadata; a second user's turn on the session reads under the session's form, and the session's
 * later turns have no learner either, as the GMI then reads; and a GMI with no learner session hands both exactly
 * what it handed them before. The compaction phase is stubbed to report one compaction, as its model call would.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const compaction = vi.hoisted(() => ({
  next: undefined as { summaryText: string; summaryUptoTimestamp: number } | undefined,
}));

vi.mock('../../src/api/runtime/turn-phases/rolling-summary', () => ({
  executeRollingSummaryPhase: vi.fn(async () => {
    const next = compaction.next;
    compaction.next = undefined;
    if (!next) return { result: null, profileId: null, configForTurn: null, enabled: false, summaryText: '' };
    return {
      result: {
        enabled: true,
        didCompact: true,
        summaryText: next.summaryText,
        summaryJson: null,
        summaryUptoTimestamp: next.summaryUptoTimestamp,
        summaryUpdatedAt: 10,
      },
      profileId: null,
      configForTurn: null,
      enabled: true,
      summaryText: next.summaryText,
    };
  }),
}));

import { AgentOSOrchestrator } from '../../src/api/AgentOSOrchestrator';
import type { AgentOSInput } from '../../src/api/types/AgentOSInput';
import { createLearningLayer, InMemoryLearningStore, type ILearnerSession } from '../../src/cognition/learning/index';
import { GMIOutputChunkType, type GMIOutputChunk, type IGMI } from '../../src/cognition/substrate/IGMI.js';
import type { ConversationContext } from '../../src/core/conversation/ConversationContext';

/** A conversation context whose metadata is kept, as the conversation manager keeps it, over the given messages. */
function conversationOf(messages: Array<{ role: string; name?: string; content: string; timestamp: number }>): ConversationContext {
  const metadata = new Map<string, unknown>();
  return {
    sessionId: 'conv-1',
    createdAt: 1,
    userId: 'ana',
    messages: [],
    config: {},
    sessionMetadata: {},
    getHistory: vi.fn().mockReturnValue([]),
    getAllMessages: vi.fn(() => messages.map((message, index) => ({ id: `m-${index}`, ...message }))),
    addMessage: vi.fn(),
    addEntry: vi.fn(),
    getMetadata: vi.fn((key: string) => metadata.get(key)),
    setMetadata: vi.fn((key: string, value: unknown) => {
      metadata.set(key, value);
    }),
    getAllMetadata: vi.fn(() => Object.fromEntries(metadata)),
    clearHistory: vi.fn(),
    getTurnNumber: vi.fn().mockReturnValue(0),
    toJSON: vi.fn().mockReturnValue({}),
    currentLanguage: 'en-US',
  } as unknown as ConversationContext;
}

/** A GMI that answers each turn with one line, and hands the pipeline its learner session where it has one. */
function gmiWith(session: ILearnerSession | undefined): IGMI {
  return {
    getGMIId: () => 'gmi-1',
    getCurrentPrimaryPersonaId: () => 'persona-1',
    getPersona: () => ({ id: 'persona-1', name: 'Tutor', version: '1.0.0', baseSystemPrompt: 'You teach.' }),
    ...(session ? { getLearnerSession: () => session } : {}),
    processTurnStream: vi.fn(async function* () {
      yield {
        type: GMIOutputChunkType.FINAL_RESPONSE_MARKER,
        content: { finalResponseText: 'Hello' },
        interactionId: 'i-1',
        timestamp: new Date(),
        isFinal: true,
      } as GMIOutputChunk;
      return { isFinal: true, responseText: 'Hello' };
    }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as IGMI;
}

let streams = 0;
async function orchestratorWith(gmi: IGMI, context: ConversationContext, memory: { retriever: unknown; sink: unknown }) {
  const orchestrator = new AgentOSOrchestrator();
  await orchestrator.initialize(
    { maxToolCallIterations: 5, defaultAgentTurnTimeoutMs: 120000, enableConversationalPersistence: false },
    {
      gmiManager: {
        getOrCreateGMIForSession: vi.fn().mockResolvedValue({ gmi, conversationContext: context }),
        deactivateGMIForSession: vi.fn().mockResolvedValue(true),
      },
      toolOrchestrator: { orchestratorId: 'tools-1', listAvailableTools: vi.fn().mockResolvedValue([]) },
      conversationManager: {
        getOrCreateContext: vi.fn().mockResolvedValue(context),
        saveContext: vi.fn().mockResolvedValue(undefined),
        saveConversation: vi.fn().mockResolvedValue(undefined),
      },
      streamingManager: {
        createStream: vi.fn(() => `stream-${++streams}`),
        pushChunk: vi.fn().mockResolvedValue(undefined),
        endStream: vi.fn().mockResolvedValue(undefined),
        closeStream: vi.fn().mockResolvedValue(undefined),
      },
      modelProviderManager: {
        getProvider: vi.fn(),
        getProviderForModel: vi.fn(),
        getModelInfo: vi.fn(),
        listProviders: vi.fn().mockReturnValue([]),
        listModels: vi.fn().mockReturnValue([]),
      },
      longTermMemoryRetriever: memory.retriever,
      rollingSummaryMemorySink: memory.sink,
    } as never,
  );
  return orchestrator;
}

/** A turn of a user on session `s-1` in organization `A`, with the user and persona scopes on. */
const turn = (userId: string): AgentOSInput =>
  ({
    userId,
    sessionId: 's-1',
    organizationId: 'A',
    textInput: 'what about kites',
    selectedPersonaId: 'persona-1',
    memoryControl: { longTermMemory: { scopes: { user: true, persona: true } } },
  }) as AgentOSInput;

/** A learner session of user `ana` in organization `A` on session `s-1`, from a real layer. */
async function anasSession(): Promise<ILearnerSession> {
  const layer = createLearningLayer({ store: new InMemoryLearningStore() });
  return layer.forLearner({ namespace: 'A', agentKey: 'persona-1', userId: 'ana' }, { sessionId: 's-1', personaId: 'persona-1', authoredTraits: {} });
}

describe('the turn pipeline with a learning layer', () => {
  let retriever: { retrieveLongTermMemory: ReturnType<typeof vi.fn> };
  let sink: { upsertRollingSummaryMemory: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    retriever = { retrieveLongTermMemory: vi.fn().mockResolvedValue(null) };
    sink = { upsertRollingSummaryMemory: vi.fn().mockResolvedValue(undefined) };
  });

  afterEach(() => {
    compaction.next = undefined;
    vi.restoreAllMocks();
  });

  it("hands the retriever and the sink a learner's scope ids and recorder, and the compaction's contributors", async () => {
    const context = conversationOf([
      { role: 'user', name: 'ana', content: 'I fly kites.', timestamp: 1 },
      { role: 'user', name: 'guest', content: 'Hello.', timestamp: 2 },
      { role: 'user', name: 'bo', content: 'Later words.', timestamp: 9 },
    ]);
    const orchestrator = await orchestratorWith(gmiWith(await anasSession()), context, { retriever, sink });
    compaction.next = { summaryText: '- ana flies kites', summaryUptoTimestamp: 5 };

    await orchestrator.orchestrateTurn(turn('ana'));
    await vi.waitFor(() => expect(sink.upsertRollingSummaryMemory).toHaveBeenCalledTimes(1));

    const scopes = { learner: 'bound', mode: 'on', userScopeId: 'A/ana', personaScopeId: 'A/ana::persona-1', namespace: 'A' };
    expect(retriever.retrieveLongTermMemory.mock.calls[0]![0]).toMatchObject({ userId: 'ana', organizationId: 'A', turnScopes: scopes });
    const update = sink.upsertRollingSummaryMemory.mock.calls[0]![0];
    expect(update).toMatchObject({ turnScopes: scopes, contributorIds: ['ana'] });
    expect(typeof update.recordSelfChange).toBe('function');
    expect(context.getMetadata('rollingSummaryContributors')).toEqual(['ana']);
  });

  it("hands a second user's turn the session's form, and the session's turns after it have no learner either", async () => {
    const session = await anasSession();
    const orchestrator = await orchestratorWith(gmiWith(session), conversationOf([]), { retriever, sink });

    await orchestrator.orchestrateTurn(turn('bo'));
    await vi.waitFor(() => expect(retriever.retrieveLongTermMemory).toHaveBeenCalledTimes(1));

    expect(retriever.retrieveLongTermMemory.mock.calls[0]![0].turnScopes).toEqual({
      learner: 'none',
      mode: 'on',
      userScopeId: 'A//s-1',
      personaScopeId: 'A//s-1::persona-1',
      namespace: 'A',
    });
    // The GMI's own preparation of a later turn of the session's first user reads the same rule.
    const later = await session.prepareTurn({ turnId: 't-9', userId: 'ana', namespace: 'A', text: 'Hi again.', modelIds: ['m'], workflowSeat: false });
    expect(later.learner).toBe('none');
  });

  it('hands both exactly what it handed them before when the GMI has no learner session', async () => {
    const context = conversationOf([{ role: 'user', name: 'ana', content: 'I fly kites.', timestamp: 1 }]);
    const orchestrator = await orchestratorWith(gmiWith(undefined), context, { retriever, sink });
    compaction.next = { summaryText: '- ana flies kites', summaryUptoTimestamp: 5 };

    await orchestrator.orchestrateTurn(turn('ana'));
    await vi.waitFor(() => expect(sink.upsertRollingSummaryMemory).toHaveBeenCalledTimes(1));

    expect(Object.keys(retriever.retrieveLongTermMemory.mock.calls[0]![0]).sort()).toEqual([
      'conversationId', 'maxContextChars', 'memoryPolicy', 'mode', 'organizationId', 'personaId', 'queryText',
      'retrievalPolicy', 'topKByScope', 'userId',
    ]);
    expect(Object.keys(sink.upsertRollingSummaryMemory.mock.calls[0]![0]).sort()).toEqual([
      'conversationId', 'memoryPolicy', 'mode', 'organizationId', 'personaId', 'profileId', 'sessionId', 'summaryJson',
      'summaryText', 'summaryUpdatedAt', 'summaryUptoTimestamp', 'userId',
    ]);
    expect(context.setMetadata).not.toHaveBeenCalledWith('rollingSummaryContributors', expect.anything());
  });
});
