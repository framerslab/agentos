/**
 * @file GMIManager.shutdown.test.ts
 * AgentOS.shutdown() ends in GMIManager.shutdown(), which has to shut down
 * every active GMI before it drops them: a GMI's own shutdown drains its
 * metaprompt queue and closes its cognitive and working memory. These tests
 * drive a real GMIManager and real GMIs (persona loading, session creation)
 * with only the cognitive memory manager replaced by a recorder.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GMI } from '../GMI';
import { GMIManager } from '../GMIManager';
import {
  GMIInteractionType,
  GMIOutputChunkType,
  GMIPrimeState,
  type GMIOutput,
  type GMIOutputChunk,
  type IGMI,
} from '../IGMI';
import type { IPersonaDefinition } from '../personas/IPersonaDefinition';
import type { IPersonaLoader } from '../personas/IPersonaLoader';
import type { ICognitiveMemoryManager } from '../../memory/CognitiveMemoryManager.js';
import type { IUtilityAI } from '../../nlp/ai_utilities/IUtilityAI';
import { ConversationContext } from '../../../core/conversation/ConversationContext';
import type { ConversationManager } from '../../../core/conversation/ConversationManager';
import type { IPromptEngine, PromptEngineConfig } from '../../../core/llm/IPromptEngine';
import type { AIModelProviderManager } from '../../../core/llm/providers/AIModelProviderManager';
import type { ChatMessage, IProvider, ModelCompletionOptions } from '../../../core/llm/providers/IProvider';
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
  /** The provider every GMI's model calls go to; without one the GMIs run no turn. */
  provider?: IProvider;
  /** The prompt-engine config of the seats `createAgencySeat` builds; without one the manager builds no seat. */
  agencySeatPromptEngineConfig?: PromptEngineConfig;
}

/** A seat's prompt engine: truncation only, so it makes no model call. */
const SEAT_PROMPT_ENGINE_CONFIG = {
  defaultTemplateName: 'openai_chat',
  availableTemplates: {},
  tokenCounting: { strategy: 'estimated', estimationModel: 'gpt-3.5-turbo' },
  historyManagement: { defaultMaxMessages: 100, maxTokensForHistory: 8_000, summarizationTriggerRatio: 0, preserveImportantMessages: true },
  contextManagement: { maxRAGContextTokens: 1_500, summarizationQualityTier: 'balanced', preserveSourceAttributionInSummary: true },
  contextualElementSelection: { maxElementsPerType: {}, defaultMaxElementsPerType: 3, priorityResolutionStrategy: 'highest_first', conflictResolutionStrategy: 'skip_conflicting' },
  performance: { enableCaching: false, cacheTimeoutSeconds: 60 },
} as unknown as PromptEngineConfig;

/**
 * A provider that holds each model call open until the caller aborts it, when
 * it ends the call with the abort chunk as the providers do, or until `answer`
 * resolves, when it replies.
 */
function stallingProvider(answer: Promise<void>) {
  const base = { id: 'stalling', object: 'chat.completion.chunk', created: 0, modelId: 'stalling-model' };
  return {
    providerId: 'stalling',
    isInitialized: true,
    generateCompletionStream: vi.fn(async function* (
      _modelId: string,
      _messages: ChatMessage[],
      options: ModelCompletionOptions,
    ) {
      const signal = options.abortSignal;
      const aborted = await new Promise<boolean>((resolve) => {
        if (signal?.aborted) return resolve(true);
        signal?.addEventListener('abort', () => resolve(true), { once: true });
        void answer.then(() => resolve(false));
      });
      if (aborted) {
        yield { ...base, choices: [], isFinal: true, error: { message: 'Stream aborted by caller', type: 'abort' } };
        return;
      }
      yield {
        ...base,
        choices: [{ index: 0, message: { role: 'assistant', content: 'Too late.' }, finishReason: 'stop' }],
        responseTextDelta: 'Too late.',
        isFinal: true,
      };
    }),
  };
}

/** Runs a text turn on `gmi` for session-1 to its end: the chunks it streamed and its output. */
async function runTurn(gmi: IGMI, text: string): Promise<{ chunks: GMIOutputChunk[]; output: GMIOutput }> {
  const chunks: GMIOutputChunk[] = [];
  const stream = gmi.processTurnStream({
    interactionId: 'turn-1',
    userId: 'user-1',
    sessionId: 'session-1',
    type: GMIInteractionType.TEXT,
    content: text,
  });
  for (;;) {
    const next = await stream.next();
    if (next.done) return { chunks, output: next.value };
    chunks.push(next.value);
  }
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
    // No stored contexts, so the idle cleanup reads each GMI's creation time.
    listContextsForSession: async () => [],
  } as unknown as ConversationManager;
  const promptEngine = {
    estimateTokenCount: async () => 10,
    constructPrompt: async () => ({ prompt: [{ role: 'user', content: 'Hello?' }] }),
  } as unknown as IPromptEngine;
  const { provider } = options;
  const llmProviderManager = provider
    ? {
        getModelInfo: async (modelId: string) => ({ modelId, providerId: provider.providerId, contextWindowSize: 128_000, capabilities: ['chat'] }),
        getProvider: () => provider,
        getProviderForModel: () => provider,
      }
    : {};
  const toolOrchestrator = { listAvailableTools: async () => [] } as unknown as IToolOrchestrator;

  const manager = new GMIManager(
    {
      personaLoaderConfig: { personaSource: 'in-memory' },
      ...(options.shutdownTimeoutMs !== undefined ? { shutdownTimeoutMs: options.shutdownTimeoutMs } : {}),
      ...(options.agencySeatPromptEngineConfig ? { agencySeatPromptEngineConfig: options.agencySeatPromptEngineConfig } : {}),
      ...(provider
        ? { defaultGMIBaseConfigDefaults: { defaultLlmProviderId: provider.providerId, defaultLlmModelId: 'stalling-model' } }
        : {}),
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
    llmProviderManager as unknown as AIModelProviderManager,
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

  it("waits for a launched team's seat whose GMI is being built when shutdown begins, and fails that build", async () => {
    const { manager, gmis } = await createHarness({ agencySeatPromptEngineConfig: SEAT_PROMPT_ENGINE_CONFIG });
    // The seat's GMI waits in its initialization until the case lets it go on.
    let initializing!: () => void;
    const requested = new Promise<void>((resolve) => {
      initializing = resolve;
    });
    let releaseInitialize!: () => void;
    const initializeHeld = new Promise<void>((resolve) => {
      releaseInitialize = resolve;
    });
    const built: GMI[] = [];
    const initialize = GMI.prototype.initialize;
    vi.spyOn(GMI.prototype, 'initialize').mockImplementation(async function (this: GMI, ...args) {
      built.push(this);
      initializing();
      await initializeHeld;
      return initialize.call(this, ...args);
    });
    const outcome = manager
      .createAgencySeat({ seatSessionId: 'seat:launch-1:writer', userId: 'user-1', persona: { personaId: persona.id }, toolView: (base) => base })
      .then(
        () => 'registered',
        (error: { code?: string }) => error.code,
      );
    await requested;

    let finished = false;
    const shutdown = manager.shutdown().then(() => {
      finished = true;
    });
    // The sessions' GMIs have shut down (the precondition), and the manager still waits for the seat being built.
    await vi.waitFor(() => {
      for (const gmi of gmis) expect(gmi.getCurrentState()).toBe(GMIPrimeState.SHUTDOWN);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(finished).toBe(false);

    releaseInitialize();
    await shutdown;

    expect(await outcome).toBe(GMIErrorCode.NOT_INITIALIZED);
    // The seat's GMI was shut down before shutdown() resolved, and never registered.
    expect(built).toHaveLength(1);
    expect(built[0].getCurrentState()).toBe(GMIPrimeState.SHUTDOWN);
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

  it('shuts down a GMI that is in the active map with no session entry', async () => {
    const { manager, memoryShutdown } = await createHarness();
    // Two creations for one new session race: both build a GMI, and the later
    // registration takes the session entry from the earlier one.
    const created = await Promise.all([
      manager.getOrCreateGMIForSession('user-9', 'session-9', persona.id),
      manager.getOrCreateGMIForSession('user-9', 'session-9', persona.id),
    ]);
    const orphan = created.map(({ gmi }) => gmi).find((gmi) => manager.gmiSessionMap.get('session-9') !== gmi.gmiId);
    if (!orphan) throw new Error('the two creations did not race');
    expect(manager.activeGMIs.get(orphan.gmiId)).toBe(orphan);
    const orphanShutdown = vi.spyOn(orphan, 'shutdown');

    await manager.shutdown();

    expect(orphanShutdown).toHaveBeenCalledTimes(1);
    expect(orphan.getCurrentState()).toBe(GMIPrimeState.SHUTDOWN);
    // session-1, session-2, session-9 and the orphan each closed their memory.
    expect(memoryShutdown).toHaveBeenCalledTimes(4);
    expect(manager.activeGMIs.size).toBe(0);
    expect(manager.gmiSessionMap.size).toBe(0);
  });

  it('stops the turn a GMI is running, and the turn leaves the state SHUTDOWN', async () => {
    let releaseReply!: () => void;
    const replyHeld = new Promise<void>((resolve) => {
      releaseReply = resolve;
    });
    const provider = stallingProvider(replyHeld);
    // A turn that shutdown does not stop holds it no longer than this bound.
    const { manager, gmis } = await createHarness({ provider: provider as unknown as IProvider, shutdownTimeoutMs: 1_000 });
    const [gmi] = gmis;
    // The stopped turn logs its error.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const turn = runTurn(gmi, 'Hello?');
    // The turn waits on its model call.
    await vi.waitFor(() => expect(provider.generateCompletionStream).toHaveBeenCalledTimes(1));

    await manager.shutdown();
    // A model call still open answers now.
    releaseReply();
    const { chunks, output } = await turn;

    expect(String(output.error?.message)).toMatch(/aborted/i);
    expect(chunks.map((chunk) => chunk.type)).toContain(GMIOutputChunkType.ERROR);
    expect(gmi.getCurrentState()).toBe(GMIPrimeState.SHUTDOWN);
  });

  it('runs a GMI\'s shutdown once when calls overlap, and every caller waits for it', async () => {
    const { manager, gmis, memoryShutdown } = await createHarness();
    const [first, second] = gmis;

    // Two calls on one GMI at the same time.
    const calls = [first.shutdown(), first.shutdown()];
    await calls[1];
    expect(first.getCurrentState()).toBe(GMIPrimeState.SHUTDOWN);
    await calls[0];
    expect(memoryShutdown).toHaveBeenCalledTimes(1);

    // Two manager shutdowns at the same time, as SIGINT and then SIGTERM start
    // them: the GMI still running closes its memory once.
    await Promise.all([manager.shutdown(), manager.shutdown()]);
    expect(second.getCurrentState()).toBe(GMIPrimeState.SHUTDOWN);
    expect(memoryShutdown).toHaveBeenCalledTimes(2);
    expect(manager.activeGMIs.size).toBe(0);
    expect(manager.gmiSessionMap.size).toBe(0);
  });
});

describe('GMIManager session deactivation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('gives a session whose GMI it is deactivating a new GMI once that one has shut down, never the one shutting down', async () => {
    // The GMI's cognitive memory stays open until the case lets it close, so the GMI is SHUTTING_DOWN and still bound
    // to its session, as during an idle cleanup or a persona refresh.
    let releaseMemory!: () => void;
    const memoryHeld = new Promise<void>((resolve) => {
      releaseMemory = resolve;
    });
    const { manager, gmis } = await createHarness({ closeMemory: () => memoryHeld });
    const [retired] = gmis;

    const deactivation = manager.deactivateGMIForSession('session-1');
    expect(retired.getCurrentState()).toBe(GMIPrimeState.SHUTTING_DOWN);
    let settled = false;
    const acquisition = manager.getOrCreateGMIForSession('user-1', 'session-1', persona.id).finally(() => {
      settled = true;
    });
    // the acquisition waits while the deactivated GMI shuts down
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    releaseMemory();
    await expect(deactivation).resolves.toBe(true);
    const { gmi: acquired } = await acquisition;

    expect(acquired).not.toBe(retired);
    expect(acquired.getCurrentState()).toBe(GMIPrimeState.READY);
    expect(retired.getCurrentState()).toBe(GMIPrimeState.SHUTDOWN);
    expect(manager.gmiSessionMap.get('session-1')).toBe(acquired.gmiId);
    expect(manager.activeGMIs.has(retired.gmiId)).toBe(false);
    await manager.shutdown();
  });
});

describe('GMIManager agency seats', () => {
  const seatSessionId = 'seat:launch-1:writer';
  const seatSpec = { seatSessionId, userId: 'user-1', persona: { personaId: persona.id }, toolView: (base: IToolOrchestrator) => base };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses a request that names a seat's session whatever persona it names, an unknown one included", async () => {
    const { manager } = await createHarness({ agencySeatPromptEngineConfig: SEAT_PROMPT_ENGINE_CONFIG });
    const seat = await manager.createAgencySeat(seatSpec);
    // The precondition: a persona the manager does not hold is refused as unknown on any other session.
    await expect(manager.getOrCreateGMIForSession('user-3', 'session-3', 'no-such-persona')).rejects.toMatchObject({
      code: GMIErrorCode.PERSONA_NOT_FOUND,
    });

    await expect(manager.getOrCreateGMIForSession('user-3', seatSessionId, 'no-such-persona')).rejects.toMatchObject({
      code: GMIErrorCode.PERMISSION_DENIED,
    });
    expect(manager.gmiSessionMap.get(seatSessionId)).toBe(seat.gmi.gmiId);
    await seat.release();
    await manager.shutdown();
  });

  it('leaves a running seat to its launch when the idle cleanup runs', async () => {
    const { manager, gmis } = await createHarness({ agencySeatPromptEngineConfig: SEAT_PROMPT_ENGINE_CONFIG });
    const seat = await manager.createAgencySeat(seatSpec);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const cleaned = await manager.cleanupInactiveGMIs(0);

    // The cleanup ran: both sessions' GMIs were idle past the threshold and are gone.
    for (const gmi of gmis) expect(gmi.getCurrentState()).toBe(GMIPrimeState.SHUTDOWN);
    expect(cleaned).toBe(2);
    expect(seat.gmi.getCurrentState()).toBe(GMIPrimeState.READY);
    expect(manager.gmiSessionMap.get(seatSessionId)).toBe(seat.gmi.gmiId);
    expect(manager.activeGMIs.get(seat.gmi.gmiId)).toBe(seat.gmi);

    await seat.release();
    expect(seat.gmi.getCurrentState()).toBe(GMIPrimeState.SHUTDOWN);
    expect(manager.gmiSessionMap.has(seatSessionId)).toBe(false);
    await manager.shutdown();
  });

  it('refuses a request whose GMI was being built when a seat took its session, and keeps the seat', async () => {
    let memoryRequested!: () => void;
    const requested = new Promise<void>((resolve) => {
      memoryRequested = resolve;
    });
    let releaseMemory!: () => void;
    const memoryHeld = new Promise<void>((resolve) => {
      releaseMemory = resolve;
    });
    const { manager, memoryShutdown } = await createHarness({
      agencySeatPromptEngineConfig: SEAT_PROMPT_ENGINE_CONFIG,
      holdMemoryFor: (sessionId) => {
        if (sessionId !== seatSessionId) return undefined;
        memoryRequested();
        return memoryHeld;
      },
    });
    // The request has passed every check on the session and waits while its GMI is built.
    const outcome = manager.getOrCreateGMIForSession('user-3', seatSessionId, persona.id).then(
      () => 'registered',
      (error: { code?: string }) => error.code,
    );
    await requested;
    const seat = await manager.createAgencySeat(seatSpec);
    expect(manager.gmiSessionMap.get(seatSessionId)).toBe(seat.gmi.gmiId);

    releaseMemory();

    expect(await outcome).toBe(GMIErrorCode.PERMISSION_DENIED);
    // The GMI built for the request closed its memory (a seat's GMI has none) and was never registered.
    expect(memoryShutdown).toHaveBeenCalledTimes(1);
    expect(manager.gmiSessionMap.get(seatSessionId)).toBe(seat.gmi.gmiId);
    expect(manager.activeGMIs.size).toBe(3);
    expect(seat.gmi.getCurrentState()).toBe(GMIPrimeState.READY);

    await seat.release();
    expect(seat.gmi.getCurrentState()).toBe(GMIPrimeState.SHUTDOWN);
    expect(manager.activeGMIs.has(seat.gmi.gmiId)).toBe(false);
    await manager.shutdown();
  });

  it('releases only its own GMI: a seat handle released after the manager restarted leaves the new seat of its session alone', async () => {
    const { manager } = await createHarness({ agencySeatPromptEngineConfig: SEAT_PROMPT_ENGINE_CONFIG });
    const stale = await manager.createAgencySeat(seatSpec);
    await manager.shutdown();
    expect(stale.gmi.getCurrentState()).toBe(GMIPrimeState.SHUTDOWN);
    await manager.initialize();
    const current = await manager.createAgencySeat(seatSpec);

    await stale.release();

    expect(current.gmi.getCurrentState()).toBe(GMIPrimeState.READY);
    expect(manager.gmiSessionMap.get(seatSessionId)).toBe(current.gmi.gmiId);
    await expect(manager.getOrCreateGMIForSession('user-3', seatSessionId, persona.id)).rejects.toMatchObject({
      code: GMIErrorCode.PERMISSION_DENIED,
    });

    await current.release();
    expect(current.gmi.getCurrentState()).toBe(GMIPrimeState.SHUTDOWN);
    expect(manager.gmiSessionMap.has(seatSessionId)).toBe(false);
    await manager.shutdown();
  });
});
