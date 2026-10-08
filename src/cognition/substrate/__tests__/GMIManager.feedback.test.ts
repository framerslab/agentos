/**
 * @file GMIManager.feedback.test.ts
 * AgentOS.receiveFeedback hands a UserFeedbackPayload to
 * GMIManager.processUserFeedback. These tests drive a real GMIManager and GMI
 * (persona loading, session creation, the cognitive memory bridge) with only
 * the cognitive memory manager replaced by a recorder, and check the polarity
 * that gets recorded, the reasoning-trace entry, and the memories written.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GMIManager } from '../GMIManager';
import { ReasoningEntryType, type IGMI, type ReasoningTraceEntry } from '../IGMI';
import type { IPersonaDefinition } from '../personas/IPersonaDefinition';
import type { IPersonaLoader } from '../personas/IPersonaLoader';
import type { ICognitiveMemoryManager } from '../../memory/CognitiveMemoryManager.js';
import type { IUtilityAI } from '../../nlp/ai_utilities/IUtilityAI';
import { ConversationContext } from '../../../core/conversation/ConversationContext';
import type { ConversationManager } from '../../../core/conversation/ConversationManager';
import type { IPromptEngine } from '../../../core/llm/IPromptEngine';
import type { AIModelProviderManager } from '../../../core/llm/providers/AIModelProviderManager';
import type { IToolOrchestrator } from '../../../core/tools/IToolOrchestrator';

const persona: IPersonaDefinition = {
  id: 'feedback-persona',
  name: 'Feedback Persona',
  description: 'Persona for the feedback tests.',
  version: '1.0.0',
  baseSystemPrompt: 'You are a helpful assistant.',
};

/** Builds a real GMIManager with one active session for user-1. */
async function createHarness() {
  // Records what the cognitive memory bridge writes; the rest of the stack is real.
  const encode = vi.fn(async (..._args: unknown[]) => ({}));
  const cognitiveMemory = {
    encode,
    observe: vi.fn(async () => null),
    shutdown: vi.fn(async () => undefined),
  } as unknown as ICognitiveMemoryManager;

  const personaLoader: IPersonaLoader = {
    initialize: async () => undefined,
    loadPersonaById: async (id: string) => (id === persona.id ? persona : undefined),
    loadAllPersonaDefinitions: async () => [persona],
  };
  const conversationManager = {
    getOrCreateConversationContext: async () => new ConversationContext('conv-1'),
  } as unknown as ConversationManager;
  const promptEngine = { estimateTokenCount: async () => 10 } as unknown as IPromptEngine;
  const toolOrchestrator = { listAvailableTools: async () => [] } as unknown as IToolOrchestrator;

  const manager = new GMIManager(
    {
      personaLoaderConfig: { personaSource: 'in-memory' },
      cognitiveMemoryFactory: () => cognitiveMemory,
    },
    undefined,
    undefined,
    conversationManager,
    promptEngine,
    {} as unknown as AIModelProviderManager,
    {} as unknown as IUtilityAI,
    toolOrchestrator,
    undefined,
    personaLoader,
  );
  await manager.initialize();
  const { gmi } = await manager.getOrCreateGMIForSession('user-1', 'session-1', persona.id);
  return { manager, gmi, encode };
}

/** Trace entries written for recorded feedback. */
function feedbackEntries(gmi: IGMI): ReasoningTraceEntry[] {
  return gmi.getReasoningTrace().entries.filter((entry) => entry.message.includes('feedback recorded'));
}

describe('GMIManager.processUserFeedback', () => {
  let harness: Awaited<ReturnType<typeof createHarness>>;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.gmi.shutdown();
  });

  it.each([
    {
      label: 'a positive rating label',
      payload: { rating: 'positive', text: 'Great answer' },
      polarity: 'positive',
      entryType: ReasoningEntryType.DEBUG,
      message: 'Positive feedback recorded.',
    },
    {
      label: 'a neutral rating label',
      payload: { rating: 'neutral' },
      polarity: 'neutral',
      entryType: ReasoningEntryType.DEBUG,
      message: 'Neutral feedback recorded.',
    },
    {
      label: 'a negative rating label',
      payload: { rating: 'negative' },
      polarity: 'negative',
      entryType: ReasoningEntryType.WARNING,
      message: 'Negative feedback recorded, flagged for review.',
    },
    {
      label: 'a score of 5',
      payload: { score: 5 },
      polarity: 'positive',
      entryType: ReasoningEntryType.DEBUG,
      message: 'Positive feedback recorded.',
    },
    {
      label: 'a score of 1',
      payload: { score: 1 },
      polarity: 'negative',
      entryType: ReasoningEntryType.WARNING,
      message: 'Negative feedback recorded, flagged for review.',
    },
    {
      label: 'the legacy type field',
      payload: { type: 'positive' },
      polarity: 'positive',
      entryType: ReasoningEntryType.DEBUG,
      message: 'Positive feedback recorded.',
    },
  ])('records $label as $polarity feedback', async ({ payload, polarity, entryType, message }) => {
    await harness.manager.processUserFeedback('user-1', 'session-1', persona.id, payload);

    const entries = feedbackEntries(harness.gmi);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe(entryType);
    expect(entries[0].message).toBe(message);
    expect(entries[0].details).toMatchObject({ userId: 'user-1', polarity });

    // The feedback itself becomes an episodic memory scoped to the user.
    expect(harness.encode).toHaveBeenCalledWith(
      expect.stringContaining(`User feedback (${polarity}`),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        type: 'episodic',
        scope: 'user',
        scopeId: 'user-1',
        sourceType: 'user_statement',
        tags: expect.arrayContaining(['user_feedback', `feedback_${polarity}`]),
      }),
    );
  });

  it('stores a correction as a semantic memory of the user', async () => {
    await harness.manager.processUserFeedback('user-1', 'session-1', persona.id, {
      rating: 'negative',
      correctedContent: 'Use pnpm, not npm.',
      targetMessageId: 'msg-7',
    });

    expect(harness.encode).toHaveBeenCalledWith(
      'User correction for message msg-7: Use pnpm, not npm.',
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        type: 'semantic',
        scope: 'user',
        scopeId: 'user-1',
        sourceType: 'user_statement',
        tags: expect.arrayContaining(['user_correction']),
      }),
    );
    expect(feedbackEntries(harness.gmi)[0].details).toMatchObject({
      correctedContent: 'Use pnpm, not npm.',
      targetMessageId: 'msg-7',
    });
  });

  it('does nothing for a session that has no GMI', async () => {
    await expect(
      harness.manager.processUserFeedback('user-1', 'unknown-session', persona.id, { rating: 'negative' }),
    ).resolves.toBeUndefined();

    expect(feedbackEntries(harness.gmi)).toHaveLength(0);
    expect(harness.encode).not.toHaveBeenCalled();
  });
});
