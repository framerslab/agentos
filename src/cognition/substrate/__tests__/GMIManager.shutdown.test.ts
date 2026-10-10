/**
 * @file GMIManager.shutdown.test.ts
 * AgentOS.shutdown() ends in GMIManager.shutdown(), which has to shut down
 * every active GMI before it drops them: a GMI's own shutdown drains its
 * metaprompt queue and closes its cognitive and working memory. These tests
 * drive a real GMIManager and real GMIs (persona loading, session creation)
 * with only the cognitive memory manager replaced by a recorder.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GMIManager } from '../GMIManager';
import { GMIPrimeState } from '../IGMI';
import type { IPersonaDefinition } from '../personas/IPersonaDefinition';
import type { IPersonaLoader } from '../personas/IPersonaLoader';
import type { ICognitiveMemoryManager } from '../../memory/CognitiveMemoryManager.js';
import type { IUtilityAI } from '../../nlp/ai_utilities/IUtilityAI';
import { ConversationContext } from '../../../core/conversation/ConversationContext';
import type { ConversationManager } from '../../../core/conversation/ConversationManager';
import type { IPromptEngine } from '../../../core/llm/IPromptEngine';
import type { AIModelProviderManager } from '../../../core/llm/providers/AIModelProviderManager';
import type { IToolOrchestrator } from '../../../core/tools/IToolOrchestrator';
import { GMIErrorCode } from '../../../core/utils/errors';

const persona: IPersonaDefinition = {
  id: 'shutdown-persona',
  name: 'Shutdown Persona',
  description: 'Persona for the manager shutdown tests.',
  version: '1.0.0',
  baseSystemPrompt: 'You are a helpful assistant.',
};

interface HarnessOptions {
  /**
   * Waited on before the cognitive memory of a session is built, so a case can
   * hold a GMI's creation in flight.
   */
  holdMemoryFor?: (sessionId: string) => Promise<void> | undefined;
  /** Closes a GMI's cognitive memory; by default it takes one macrotask. */
  closeMemory?: () => Promise<void>;
  /** The manager's bound on each GMI's shutdown. */
  shutdownTimeoutMs?: number;
}

/** Builds a real GMIManager with an active GMI for session-1 and one for session-2. */
async function createHarness(options: HarnessOptions = {}) {
  // Closing a GMI's cognitive memory takes a macrotask, so a GMI is in the
  // SHUTDOWN state when shutdown() resolves only if shutdown() awaited it.
  const memoryShutdown = vi.fn(
    options.closeMemory ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 5))),
  );

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
      ...(options.shutdownTimeoutMs !== undefined ? { shutdownTimeoutMs: options.shutdownTimeoutMs } : {}),
      cognitiveMemoryFactory: async ({ sessionId }) => {
        await options.holdMemoryFor?.(sessionId);
        return {
          encode: vi.fn(async () => ({})),
          observe: vi.fn(async () => null),
          shutdown: memoryShutdown,
        } as unknown as ICognitiveMemoryManager;
      },
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
  const first = await manager.getOrCreateGMIForSession('user-1', 'session-1', persona.id);
  const second = await manager.getOrCreateGMIForSession('user-2', 'session-2', persona.id);
  return { manager, gmis: [first.gmi, second.gmi], memoryShutdown };
}

describe('GMIManager.shutdown', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shuts down every active GMI, waits for each, and empties both maps', async () => {
    const { manager, gmis, memoryShutdown } = await createHarness();
    const gmiShutdowns = gmis.map((gmi) => vi.spyOn(gmi, 'shutdown'));
    const consoleError = vi.spyOn(console, 'error');

    await manager.shutdown();

    for (const gmiShutdown of gmiShutdowns) expect(gmiShutdown).toHaveBeenCalledTimes(1);
    for (const gmi of gmis) expect(gmi.getCurrentState()).toBe(GMIPrimeState.SHUTDOWN);
    expect(memoryShutdown).toHaveBeenCalledTimes(2);
    expect(manager.activeGMIs.size).toBe(0);
    expect(manager.gmiSessionMap.size).toBe(0);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('logs a GMI whose own shutdown throws and still shuts down the others', async () => {
    const { manager, gmis } = await createHarness();
    const [failing, healthy] = gmis;
    const failure = new Error('close failed');
    vi.spyOn(failing, 'shutdown').mockRejectedValueOnce(failure);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await manager.shutdown();

    expect(healthy.getCurrentState()).toBe(GMIPrimeState.SHUTDOWN);
    expect(manager.activeGMIs.size).toBe(0);
    expect(manager.gmiSessionMap.size).toBe(0);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining(`Error during gmi.shutdown() for GMI ${failing.gmiId}: close failed`),
      failure,
    );
  });

  it('refuses new calls from the moment shutdown starts', async () => {
    const { manager } = await createHarness();

    const shutdown = manager.shutdown();
    await expect(manager.getOrCreateGMIForSession('user-3', 'session-3', persona.id)).rejects.toMatchObject({
      code: GMIErrorCode.NOT_INITIALIZED,
    });
    await shutdown;

    expect(manager.activeGMIs.size).toBe(0);
    await expect(manager.deactivateGMIForSession('session-1')).rejects.toMatchObject({
      code: GMIErrorCode.NOT_INITIALIZED,
    });
  });

  it('shuts down a GMI whose creation was in flight when shutdown began, and fails that call', async () => {
    let memoryRequested!: () => void;
    const requested = new Promise<void>((resolve) => {
      memoryRequested = resolve;
    });
    let releaseMemory!: () => void;
    const memoryHeld = new Promise<void>((resolve) => {
      releaseMemory = resolve;
    });
    const { manager, memoryShutdown } = await createHarness({
      holdMemoryFor: (sessionId) => {
        if (sessionId !== 'session-3') return undefined;
        memoryRequested();
        return memoryHeld;
      },
    });

    // The call has passed the initialization check and waits for its cognitive memory.
    const outcome = manager
      .getOrCreateGMIForSession('user-3', 'session-3', persona.id)
      .then(
        () => 'registered',
        (error: { code?: string }) => error.code,
      );
    await requested;

    const shutdown = manager.shutdown();
    releaseMemory();
    await shutdown;

    expect(await outcome).toBe(GMIErrorCode.NOT_INITIALIZED);
    // session-1, session-2 and the GMI built for session-3 each closed their memory.
    expect(memoryShutdown).toHaveBeenCalledTimes(3);
    expect(manager.activeGMIs.size).toBe(0);
    expect(manager.gmiSessionMap.size).toBe(0);
  });

  it('shuts the GMIs down at once, each within shutdownTimeoutMs, and goes on without one that does not finish', async () => {
    // Every GMI's cognitive memory stays open until the case lets it close, as a
    // consolidation cycle waiting on its model call keeps it open.
    let releaseMemories!: () => void;
    const memoriesHeld = new Promise<void>((resolve) => {
      releaseMemories = resolve;
    });
    const { manager, memoryShutdown } = await createHarness({
      shutdownTimeoutMs: 50,
      closeMemory: () => memoriesHeld,
    });
    await manager.getOrCreateGMIForSession('user-3', 'session-3', persona.id);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let finished = false;
    const shutdown = manager.shutdown().then(() => {
      finished = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(50);

      // All three GMIs began closing at once, and shutdown() resolved after one bound.
      expect(memoryShutdown).toHaveBeenCalledTimes(3);
      expect(finished).toBe(true);
      const warnings = consoleWarn.mock.calls
        .map(([message]) => String(message))
        .filter((message) => message.includes('did not finish shutting down'));
      expect(warnings).toHaveLength(3);
      for (const sessionId of ['session-1', 'session-2', 'session-3']) {
        expect(warnings.filter((message) => message.includes(`session ${sessionId}`))).toHaveLength(1);
      }
      expect(manager.activeGMIs.size).toBe(0);
      expect(manager.gmiSessionMap.size).toBe(0);
    } finally {
      vi.useRealTimers();
      releaseMemories();
      await shutdown;
    }
  });
});
