/**
 * @fileoverview GMI metaprompt tests: lifecycle state, one-at-a-time batches,
 * shutdown, turn_interval cadence, and the metaprompts of the shipped voice
 * assistant persona.
 *
 * Each case drives a real GMI, MetapromptExecutor, PromptEngine and
 * InMemoryWorkingMemory. Only the LLM provider is stubbed, along with the tool
 * orchestrator and the IUtilityAI dependency, which these turns use for
 * nothing beyond an empty tool list and JSON parsing. Metaprompt completions
 * are either answered at once or held open and settled by hand, so each case
 * controls when a background batch finishes relative to the turns around it.
 */
import { beforeAll, describe, expect, it, vi, type Mock } from 'vitest';

import { GMI } from '../GMI';
import {
  GMIBaseConfig,
  GMIInteractionType,
  GMIMood,
  GMIOutputChunk,
  GMIOutputChunkType,
  GMIPrimeState,
  GMITurnInput,
  ReasoningEntryType,
  ReasoningTraceEntry,
} from '../IGMI';
import type { IPersonaDefinition, MetaPromptDefinition } from '../personas/IPersonaDefinition';
import { GMIEventType } from '../GMIEvent';
import { getBuiltInPersona } from '../personas/definitions';
import { InMemoryWorkingMemory } from '../memory/InMemoryWorkingMemory';
import { PromptEngine } from '../../../core/llm/PromptEngine';
import type { AIModelProviderManager } from '../../../core/llm/providers/AIModelProviderManager';
import type {
  ChatMessage,
  IProvider,
  ModelCompletionOptions,
  ModelCompletionResponse,
} from '../../../core/llm/providers/IProvider';
import type { IUtilityAI } from '../../nlp/ai_utilities/IUtilityAI';
import type { IToolOrchestrator } from '../../../core/tools/IToolOrchestrator';

const PROVIDER_ID = 'mock-llm-provider';
const MODEL_ID = 'mock-model';
const REPLY_TEXT = 'Hello.';

type CompletionFn = (
  modelId: string,
  messages: ChatMessage[],
  options: ModelCompletionOptions,
) => Promise<ModelCompletionResponse>;

/** A metaprompt LLM call held open until the test settles it. */
interface PendingCompletion {
  resolve: (content: string) => void;
  reject: (error: Error) => void;
}

interface Harness {
  gmi: GMI;
  workingMemory: InMemoryWorkingMemory;
  /** The metaprompt LLM call (`IProvider.generateCompletion`). */
  generateCompletion: Mock<CompletionFn>;
  /** Metaprompt calls waiting for a result, in call order. Stays empty when auto-replying. */
  pending: PendingCompletion[];
  /** The utility AI's JSON parser; in production it repairs bad JSON with an LLM call. */
  parseJsonSafe: Mock<(text: string) => Promise<unknown>>;
}

/** A manual metaprompt, served by the executor's generic handler. */
const MANUAL_REFLECTION: MetaPromptDefinition = {
  id: 'reflect_now',
  promptTemplate: 'Reflect on {{recent_conversation}} and reply with JSON.',
  trigger: { type: 'manual' },
  modelId: MODEL_ID,
  providerId: PROVIDER_ID,
};

/** The self-reflection metaprompt, with a manual trigger so it never fires on its own. */
const TRAIT_ADJUSTMENT: MetaPromptDefinition = {
  id: 'gmi_self_trait_adjustment',
  promptTemplate: 'Evidence: {{evidence}}. Mood: {{current_mood}}. Reply with JSON.',
  trigger: { type: 'manual' },
  modelId: MODEL_ID,
  providerId: PROVIDER_ID,
};

let promptEngine: PromptEngine;

beforeAll(async () => {
  promptEngine = new PromptEngine();
  await promptEngine.initialize({
    defaultTemplateName: 'openai_chat',
    availableTemplates: {},
    tokenCounting: { strategy: 'estimated' },
    historyManagement: {
      defaultMaxMessages: 20,
      maxTokensForHistory: 4096,
      summarizationTriggerRatio: 0.8,
      preserveImportantMessages: true,
    },
    contextManagement: {
      maxRAGContextTokens: 2048,
      summarizationQualityTier: 'balanced',
      preserveSourceAttributionInSummary: true,
    },
    contextualElementSelection: {
      maxElementsPerType: {},
      defaultMaxElementsPerType: 3,
      priorityResolutionStrategy: 'highest_first',
      conflictResolutionStrategy: 'skip_conflicting',
    },
    // Caching would start an eviction interval that outlives the suite.
    performance: { enableCaching: false, cacheTimeoutSeconds: 60 },
  });
});

/** A non-streaming completion carrying `content`, as a metaprompt call returns it. */
function completion(content: string): ModelCompletionResponse {
  return {
    id: 'cmp-metaprompt',
    object: 'chat.completion',
    created: 0,
    modelId: MODEL_ID,
    choices: [{ index: 0, message: { role: 'assistant', content }, finishReason: 'stop' }],
    usage: { totalTokens: 1 },
  };
}

/** The reply every turn streams: one text delta, then the final chunk. */
async function* streamReply(): AsyncGenerator<ModelCompletionResponse, void, undefined> {
  yield {
    id: 'cmp-turn',
    object: 'chat.completion.chunk',
    created: 0,
    modelId: MODEL_ID,
    choices: [],
    responseTextDelta: REPLY_TEXT,
    isFinal: false,
  };
  yield {
    id: 'cmp-turn',
    object: 'chat.completion.chunk',
    created: 0,
    modelId: MODEL_ID,
    choices: [{ index: 0, message: { role: 'assistant', content: REPLY_TEXT }, finishReason: 'stop' }],
    usage: { totalTokens: 2, promptTokens: 1, completionTokens: 1 },
    isFinal: true,
  };
}

/**
 * Builds an initialized GMI for `persona` whose provider is registered as
 * `mock-llm-provider` and is also the GMI's default provider and model.
 *
 * @param persona - The persona to run.
 * @param autoReply - When set, every metaprompt call answers with this content
 *   at once. Otherwise each call waits in `pending` until the test settles it.
 */
async function createHarness(
  persona: IPersonaDefinition,
  autoReply?: string,
  options: { providerId?: string; defaultLlmModelId?: string; defaultLlmProviderId?: string } = {},
): Promise<Harness> {
  const providerId = options.providerId ?? PROVIDER_ID;
  const pending: PendingCompletion[] = [];
  const generateCompletion = vi.fn<CompletionFn>(
    (): Promise<ModelCompletionResponse> =>
      autoReply !== undefined
        ? Promise.resolve(completion(autoReply))
        : new Promise<ModelCompletionResponse>((resolve, reject) => {
            pending.push({ resolve: (content) => resolve(completion(content)), reject });
          }),
  );
  const provider = {
    providerId,
    isInitialized: true,
    generateCompletion,
    generateCompletionStream: () => streamReply(),
  } as unknown as IProvider;

  const llmProviderManager = {
    getProvider: (id: string) => (id === providerId ? provider : undefined),
    getProviderForModel: () => provider,
    getDefaultProvider: () => provider,
    getModelInfo: async () => ({
      modelId: MODEL_ID,
      providerId,
      contextWindowSize: 128000,
      capabilities: ['chat'],
    }),
  } as unknown as AIModelProviderManager;

  const parseJsonSafe = vi.fn(async (text: string): Promise<unknown> => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  });
  const utilityAI = { parseJsonSafe } as unknown as IUtilityAI;

  const toolOrchestrator = {
    listAvailableTools: async () => [],
    processToolCall: vi.fn(),
  } as unknown as IToolOrchestrator;

  const workingMemory = new InMemoryWorkingMemory();
  const config: GMIBaseConfig = {
    workingMemory,
    promptEngine,
    llmProviderManager,
    utilityAI,
    toolOrchestrator,
    defaultLlmModelId: options.defaultLlmModelId ?? MODEL_ID,
    defaultLlmProviderId: 'defaultLlmProviderId' in options ? options.defaultLlmProviderId : PROVIDER_ID,
  };

  const gmi = new GMI();
  await gmi.initialize(persona, config);
  return { gmi, workingMemory, generateCompletion, pending, parseJsonSafe };
}

function createPersona(metaPrompts: MetaPromptDefinition[]): IPersonaDefinition {
  return {
    id: 'metaprompt-lifecycle-persona',
    name: 'Metaprompt Lifecycle Persona',
    description: 'Persona for metaprompt lifecycle tests.',
    version: '1.0.0',
    baseSystemPrompt: 'You are a concise test assistant.',
    defaultModelId: MODEL_ID,
    defaultProviderId: PROVIDER_ID,
    metaPrompts,
  };
}

function userTurn(interactionId: string, overrides: Partial<GMITurnInput> = {}): GMITurnInput {
  return {
    interactionId,
    userId: 'user-1',
    type: GMIInteractionType.TEXT,
    content: `Message for ${interactionId}`,
    ...overrides,
  };
}

/** Consumes the rest of a turn's stream and returns the chunks it yielded. */
async function drainTurn(stream: AsyncIterable<GMIOutputChunk>): Promise<GMIOutputChunk[]> {
  const chunks: GMIOutputChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

async function runTurn(
  gmi: GMI,
  interactionId: string,
  overrides: Partial<GMITurnInput> = {},
): Promise<GMIOutputChunk[]> {
  return drainTurn(gmi.processTurnStream(userTurn(interactionId, overrides)));
}

function textOf(chunks: GMIOutputChunk[]): string {
  return chunks
    .filter((chunk) => chunk.type === GMIOutputChunkType.TEXT_DELTA)
    .map((chunk) => String(chunk.content))
    .join('');
}

function traceOf(gmi: GMI, type: ReasoningEntryType): ReasoningTraceEntry[] {
  return gmi.getReasoningTrace().entries.filter((entry) => entry.type === type);
}

/** Lets queued promise callbacks and zero-delay timers run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForTrace(gmi: GMI, type: ReasoningEntryType, count: number): Promise<void> {
  await vi.waitFor(() => expect(traceOf(gmi, type)).toHaveLength(count));
  // The queue releases its slot a few callbacks after the trace entry lands.
  await settle();
}

async function currentMood(harness: Harness): Promise<unknown> {
  return (await harness.gmi.getWorkingMemorySnapshot()).currentGmiMood;
}

/** Sets the working-memory flag that fires a manual metaprompt on the next turn. */
async function arm(harness: Harness, metapromptId: string = MANUAL_REFLECTION.id): Promise<void> {
  await harness.workingMemory.set(`manual_trigger_${metapromptId}`, true);
}

/** A `turn_interval` metaprompt, served by the executor's generic handler. */
function intervalMetaprompt(intervalTurns: number): MetaPromptDefinition {
  return {
    id: 'cadence_probe',
    promptTemplate: 'Review {{recent_conversation}} and reply with JSON.',
    trigger: { type: 'turn_interval', intervalTurns },
    modelId: MODEL_ID,
    providerId: PROVIDER_ID,
  };
}

/** Ids of the turns whose metaprompt check fired, in order. */
function triggeredTurnIds(gmi: GMI): string[] {
  return traceOf(gmi, ReasoningEntryType.SELF_REFLECTION_TRIGGERED).map((entry) =>
    String(entry.details?.turnId),
  );
}

function warningsMentioning(gmi: GMI, text: string): ReasoningTraceEntry[] {
  return traceOf(gmi, ReasoningEntryType.WARNING).filter((entry) => entry.message.includes(text));
}

describe('GMI metaprompt lifecycle', () => {
  it('a finished metaprompt batch leaves the GMI ready for the next turn', async () => {
    const h = await createHarness(createPersona([MANUAL_REFLECTION]));
    await arm(h);

    await runTurn(h.gmi, 'turn-1');
    expect(h.gmi.getCurrentState()).toBe(GMIPrimeState.READY);
    await vi.waitFor(() => expect(h.pending).toHaveLength(1));

    h.pending[0].resolve(JSON.stringify({ updatedGmiMood: GMIMood.FOCUSED }));
    await waitForTrace(h.gmi, ReasoningEntryType.SELF_REFLECTION_COMPLETE, 1);

    expect(h.gmi.getCurrentState()).toBe(GMIPrimeState.READY);
    expect(await currentMood(h)).toBe(GMIMood.FOCUSED);
    expect(textOf(await runTurn(h.gmi, 'turn-2'))).toBe(REPLY_TEXT);
    expect(h.gmi.getCurrentState()).toBe(GMIPrimeState.READY);
  });

  it('a metaprompt that settles during a turn leaves that turn running', async () => {
    const h = await createHarness(createPersona([MANUAL_REFLECTION, TRAIT_ADJUSTMENT]));

    // turn-1's background batch settles while turn-2 is streaming.
    await arm(h);
    await runTurn(h.gmi, 'turn-1');
    await vi.waitFor(() => expect(h.pending).toHaveLength(1));
    const turn2 = h.gmi.processTurnStream(userTurn('turn-2'));
    expect((await turn2.next()).done).toBe(false);
    h.pending[0].resolve('not json');
    await waitForTrace(h.gmi, ReasoningEntryType.SELF_REFLECTION_COMPLETE, 1);
    expect(h.gmi.getCurrentState()).toBe(GMIPrimeState.PROCESSING);
    await drainTurn(turn2);
    expect(h.gmi.getCurrentState()).toBe(GMIPrimeState.READY);

    // A manual self-reflection is in flight when turn-3 starts, and settles mid-turn.
    const reflection = h.gmi._triggerAndProcessSelfReflection();
    await vi.waitFor(() => expect(h.pending).toHaveLength(2));
    const turn3 = h.gmi.processTurnStream(userTurn('turn-3'));
    expect((await turn3.next()).done).toBe(false);
    h.pending[1].resolve('{}');
    await reflection;
    expect(h.gmi.getCurrentState()).toBe(GMIPrimeState.PROCESSING);
    await drainTurn(turn3);
    expect(h.gmi.getCurrentState()).toBe(GMIPrimeState.READY);
  });

  it('runs one batch at a time and keeps going after a failed batch', async () => {
    const h = await createHarness(createPersona([MANUAL_REFLECTION]));

    await arm(h);
    await runTurn(h.gmi, 'turn-1');
    await vi.waitFor(() => expect(h.pending).toHaveLength(1));
    await arm(h);
    await runTurn(h.gmi, 'turn-2');
    await settle();
    // turn-2's batch waits behind turn-1's, whose call is still open.
    expect(h.generateCompletion).toHaveBeenCalledTimes(1);

    h.pending[0].reject(new Error('provider unavailable'));
    await vi.waitFor(() => expect(h.pending).toHaveLength(2));
    h.pending[1].resolve(JSON.stringify({ updatedGmiMood: GMIMood.CURIOUS }));
    await waitForTrace(h.gmi, ReasoningEntryType.SELF_REFLECTION_COMPLETE, 2);

    const batchEvents = h.gmi
      .getReasoningTrace()
      .entries.filter(
        (entry) =>
          entry.type === ReasoningEntryType.SELF_REFLECTION_START ||
          entry.type === ReasoningEntryType.SELF_REFLECTION_COMPLETE,
      )
      .map((entry) => entry.type);
    expect(batchEvents).toEqual([
      ReasoningEntryType.SELF_REFLECTION_START,
      ReasoningEntryType.SELF_REFLECTION_COMPLETE,
      ReasoningEntryType.SELF_REFLECTION_START,
      ReasoningEntryType.SELF_REFLECTION_COMPLETE,
    ]);
    const failures = traceOf(h.gmi, ReasoningEntryType.ERROR).filter((entry) =>
      entry.message.includes("Metaprompt 'reflect_now' failed"),
    );
    expect(failures).toHaveLength(1);
    expect(await currentMood(h)).toBe(GMIMood.CURIOUS);
    expect(h.gmi.getCurrentState()).toBe(GMIPrimeState.READY);
  });

  it('skips a manual self-reflection while metaprompt work runs, and never changes lifecycle state', async () => {
    const h = await createHarness(createPersona([MANUAL_REFLECTION, TRAIT_ADJUSTMENT]));
    await arm(h);
    await runTurn(h.gmi, 'turn-1');
    await vi.waitFor(() => expect(h.pending).toHaveLength(1));

    const skipped = h.gmi._triggerAndProcessSelfReflection();
    await settle();
    expect(traceOf(h.gmi, ReasoningEntryType.SELF_REFLECTION_SKIPPED).map((entry) => entry.message)).toEqual([
      'Self-reflection already in progress.',
    ]);
    expect(h.generateCompletion).toHaveBeenCalledTimes(1);
    expect(h.gmi.getCurrentState()).toBe(GMIPrimeState.READY);
    await skipped;

    h.pending[0].resolve('not json');
    await waitForTrace(h.gmi, ReasoningEntryType.SELF_REFLECTION_COMPLETE, 1);

    // With the queue idle, the same request runs.
    const reflection = h.gmi._triggerAndProcessSelfReflection();
    await vi.waitFor(() => expect(h.pending).toHaveLength(2));
    expect(h.gmi.getCurrentState()).toBe(GMIPrimeState.READY);
    h.pending[1].resolve(JSON.stringify({ updatedGmiMood: GMIMood.ANALYTICAL }));
    await reflection;
    expect(h.gmi.getCurrentState()).toBe(GMIPrimeState.READY);
    expect(await currentMood(h)).toBe(GMIMood.ANALYTICAL);
  });
});

describe('GMI shutdown with metaprompt work in flight', () => {
  it('waits for a running batch to store its updates before closing working memory', async () => {
    const h = await createHarness(createPersona([MANUAL_REFLECTION]));
    const setSpy = vi.spyOn(h.workingMemory, 'set');
    const closeSpy = vi.spyOn(h.workingMemory, 'close');
    await arm(h);
    await runTurn(h.gmi, 'turn-1');
    await vi.waitFor(() => expect(h.pending).toHaveLength(1));

    const shuttingDown = h.gmi.shutdown();
    await settle();
    expect(closeSpy).not.toHaveBeenCalled();

    h.pending[0].resolve(JSON.stringify({ updatedGmiMood: GMIMood.FOCUSED }));
    await shuttingDown;

    const moodWrite = setSpy.mock.calls.findIndex(
      ([key, value]) => key === 'currentGmiMood' && value === GMIMood.FOCUSED,
    );
    expect(moodWrite).toBeGreaterThanOrEqual(0);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(setSpy.mock.invocationCallOrder[moodWrite]).toBeLessThan(closeSpy.mock.invocationCallOrder[0]);
    expect(h.gmi.getCurrentState()).toBe(GMIPrimeState.SHUTDOWN);
  });

  it('stops waiting for a metaprompt call that never settles', async () => {
    const h = await createHarness(createPersona([MANUAL_REFLECTION]));
    const closeSpy = vi.spyOn(h.workingMemory, 'close');
    await arm(h);
    await runTurn(h.gmi, 'turn-1');
    await vi.waitFor(() => expect(h.pending).toHaveLength(1));

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const shuttingDown = h.gmi.shutdown();
      await vi.advanceTimersByTimeAsync(5000);
      await shuttingDown;
    } finally {
      vi.useRealTimers();
    }

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(h.gmi.getCurrentState()).toBe(GMIPrimeState.SHUTDOWN);
  });
});

describe('metaprompt work that runs late', () => {
  /** The executor behind a harness, to shorten its per-run deadline. */
  function executorOf(h: Harness): { runTimeoutMs: number } {
    return (h.gmi as unknown as { metapromptExecutor: { runTimeoutMs: number } }).metapromptExecutor;
  }

  it('moves on from a metaprompt call that never answers and discards its late result', async () => {
    const h = await createHarness(createPersona([MANUAL_REFLECTION]));
    executorOf(h).runTimeoutMs = 20;
    await arm(h);
    await runTurn(h.gmi, 'turn-1');
    await vi.waitFor(() => expect(h.pending).toHaveLength(1));
    // The running batch keeps its 20 ms deadline; later batches get enough
    // time to be answered between waitFor's polls.
    executorOf(h).runTimeoutMs = 60_000;

    // The first call stalls; past its deadline the queue runs the next batch.
    await arm(h);
    await runTurn(h.gmi, 'turn-2');
    await vi.waitFor(() => expect(h.pending).toHaveLength(2));
    h.pending[1].resolve(JSON.stringify({ updatedGmiMood: GMIMood.FOCUSED }));
    await vi.waitFor(async () => expect(await currentMood(h)).toBe(GMIMood.FOCUSED));

    // The stalled call answers at last; its result must not land.
    h.pending[0].resolve(JSON.stringify({ updatedGmiMood: GMIMood.CREATIVE }));
    await vi.waitFor(() => expect(warningsMentioning(h.gmi, 'Discarded late results')).toHaveLength(1));
    expect(await currentMood(h)).toBe(GMIMood.FOCUSED);
  });

  /** The executor's update step, called directly with a controllable run. */
  function applyUpdatesOf(h: Harness) {
    return (h.gmi as unknown as {
      metapromptExecutor: {
        applyMetapromptUpdates(updates: unknown, id: string, run?: { isStale(): boolean }): Promise<string[]>;
      };
    }).metapromptExecutor;
  }

  it('stops writing memory imprints once its run goes stale mid-write', async () => {
    const h = await createHarness(createPersona([MANUAL_REFLECTION]));
    let stale = false;
    const setSpy = vi.spyOn(h.workingMemory, 'set').mockImplementation(async (key: string) => {
      // The run's deadline passes while this write is pending.
      if (key === 'first_imprint') stale = true;
    });

    const stored = await applyUpdatesOf(h).applyMetapromptUpdates(
      { newMemoryImprints: [{ key: 'first_imprint', value: 1 }, { key: 'second_imprint', value: 2 }] },
      MANUAL_REFLECTION.id,
      { isStale: () => stale },
    );

    expect(setSpy.mock.calls.map(([key]) => key)).toEqual(['first_imprint']);
    expect(stored).toEqual(['first_imprint']);
    expect(warningsMentioning(h.gmi, 'Discarded late results')).toHaveLength(1);
  });

  it('lets a stale unit\'s write already underway finish before a later unit writes', async () => {
    const h = await createHarness(createPersona([MANUAL_REFLECTION]));
    const executor = applyUpdatesOf(h);
    const write = h.workingMemory.set.bind(h.workingMemory);
    let releaseOldWrite!: () => void;
    const oldWriteHeld = new Promise<void>((resolve) => {
      releaseOldWrite = resolve;
    });
    const setSpy = vi.spyOn(h.workingMemory, 'set').mockImplementation(async (key: string, value: unknown) => {
      if (value === 'old') await oldWriteHeld;
      return write(key, value);
    });
    let firstStale = false;

    const first = executor.applyMetapromptUpdates(
      { newMemoryImprints: [{ key: 'topic', value: 'old' }] },
      MANUAL_REFLECTION.id,
      { isStale: () => firstStale },
    );
    await vi.waitFor(() => expect(setSpy).toHaveBeenCalledWith('topic', 'old'));
    // The first unit passes its deadline mid-write and the queue runs the next.
    firstStale = true;
    const second = executor.applyMetapromptUpdates(
      { newMemoryImprints: [{ key: 'topic', value: 'new' }] },
      MANUAL_REFLECTION.id,
      { isStale: () => false },
    );
    releaseOldWrite();
    await Promise.all([first, second]);

    expect(await h.workingMemory.get('topic')).toBe('new');
  });

  it('does not hold back writes to other keys behind a stalled write', async () => {
    const h = await createHarness(createPersona([MANUAL_REFLECTION]));
    const executor = applyUpdatesOf(h);
    const write = h.workingMemory.set.bind(h.workingMemory);
    vi.spyOn(h.workingMemory, 'set').mockImplementation(async (key: string, value: unknown) => {
      if (key === 'stuck') return new Promise<void>(() => {});
      return write(key, value);
    });

    void executor.applyMetapromptUpdates(
      { newMemoryImprints: [{ key: 'stuck', value: 1 }] },
      MANUAL_REFLECTION.id,
      { isStale: () => false },
    );
    const stored = await executor.applyMetapromptUpdates(
      { newMemoryImprints: [{ key: 'topic', value: 'new' }] },
      MANUAL_REFLECTION.id,
      { isStale: () => false },
    );

    expect(stored).toEqual(['topic']);
    expect(await h.workingMemory.get('topic')).toBe('new');
  });

  it('makes no JSON repair call for a result that arrives after its deadline', async () => {
    const h = await createHarness(createPersona([MANUAL_REFLECTION]));
    executorOf(h).runTimeoutMs = 20;
    await arm(h);
    await runTurn(h.gmi, 'turn-1');
    await vi.waitFor(() => expect(h.pending).toHaveLength(1));
    await vi.waitFor(() => expect(warningsMentioning(h.gmi, 'did not finish within')).toHaveLength(1));

    h.pending[0].resolve('{"updatedGmiMood": "creative"');
    await vi.waitFor(() => expect(warningsMentioning(h.gmi, 'Discarded late results')).toHaveLength(1));

    expect(h.parseJsonSafe).not.toHaveBeenCalled();
  });

  it('starts no provider call for a run that went stale while reading memory', async () => {
    const h = await createHarness(createPersona([MANUAL_REFLECTION]));
    const executor = (h.gmi as unknown as {
      metapromptExecutor: {
        executeMetapromptWithVariables(
          metaPrompt: unknown,
          variables: Record<string, string>,
          run?: { isStale(): boolean },
        ): Promise<unknown>;
      };
    }).metapromptExecutor;

    const result = await executor.executeMetapromptWithVariables(MANUAL_REFLECTION, {}, { isStale: () => true });

    expect(result).toBeNull();
    expect(h.generateCompletion).not.toHaveBeenCalled();
    expect(warningsMentioning(h.gmi, 'Discarded late results')).toHaveLength(1);
  });

  it('counts a memory write still running as work that shutdown waits for', async () => {
    const h = await createHarness(createPersona([MANUAL_REFLECTION]));
    const executor = (h.gmi as unknown as {
      metapromptExecutor: {
        applyMetapromptUpdates(updates: unknown, id: string, run?: { isStale(): boolean }): Promise<string[]>;
        drain(timeoutMs?: number): Promise<boolean>;
      };
    }).metapromptExecutor;
    const write = h.workingMemory.set.bind(h.workingMemory);
    let releaseWrite!: () => void;
    const writeHeld = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const setSpy = vi.spyOn(h.workingMemory, 'set').mockImplementation(async (key: string, value: unknown) => {
      if (key === 'slow_fact') await writeHeld;
      return write(key, value);
    });

    void executor.applyMetapromptUpdates(
      { newMemoryImprints: [{ key: 'slow_fact', value: 1 }] },
      MANUAL_REFLECTION.id,
      { isStale: () => false },
    );
    await vi.waitFor(() => expect(setSpy).toHaveBeenCalledWith('slow_fact', 1));

    expect(await executor.drain(20)).toBe(false);
    releaseWrite();
    expect(await executor.drain(1000)).toBe(true);
    expect(await h.workingMemory.get('slow_fact')).toBe(1);
  });

  it('keeps imprints away from the keys that hold GMI state', async () => {
    const h = await createHarness(createPersona([MANUAL_REFLECTION]));
    const moodBefore = await currentMood(h);

    const stored = await applyUpdatesOf(h).applyMetapromptUpdates(
      {
        newMemoryImprints: [
          { key: 'currentGmiMood', value: 'creative' },
          { key: `manual_trigger_${MANUAL_REFLECTION.id}`, value: true },
          { key: 'favorite_topic', value: 'astronomy' },
        ],
      },
      MANUAL_REFLECTION.id,
      { isStale: () => false },
    );

    expect(stored).toEqual(['favorite_topic']);
    expect(await currentMood(h)).toBe(moodBefore);
    expect(await h.workingMemory.get(`manual_trigger_${MANUAL_REFLECTION.id}`)).toBeUndefined();
    expect(warningsMentioning(h.gmi, 'the key holds GMI state')).toHaveLength(2);
  });

  it('shutdown skips a batch still waiting in the queue and drops the running one\'s late result', async () => {
    const h = await createHarness(createPersona([MANUAL_REFLECTION]));
    const setSpy = vi.spyOn(h.workingMemory, 'set');
    await arm(h);
    await runTurn(h.gmi, 'turn-1');
    await vi.waitFor(() => expect(h.pending).toHaveLength(1));
    await arm(h);
    await runTurn(h.gmi, 'turn-2'); // queued behind turn-1's batch

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const shuttingDown = h.gmi.shutdown();
      await vi.advanceTimersByTimeAsync(5000);
      await shuttingDown;
    } finally {
      vi.useRealTimers();
    }

    h.pending[0].resolve(JSON.stringify({ updatedGmiMood: GMIMood.FOCUSED }));
    await settle();
    await settle();
    expect(h.generateCompletion).toHaveBeenCalledTimes(1);
    expect(setSpy.mock.calls.some(([key]) => key === 'currentGmiMood')).toBe(false);
  });

  it('drops a queued event-based metaprompt once a newer user turn has passed', async () => {
    const FRUSTRATION_PROBE: MetaPromptDefinition = {
      id: 'frustration_probe',
      promptTemplate: 'Recover from {{recent_conversation}} and reply with JSON.',
      trigger: { type: 'event_based', eventName: GMIEventType.USER_FRUSTRATED },
      modelId: MODEL_ID,
      providerId: PROVIDER_ID,
    };
    const h = await createHarness(createPersona([MANUAL_REFLECTION, FRUSTRATION_PROBE]));
    await arm(h);
    await runTurn(h.gmi, 'turn-1'); // a slow batch holds the queue
    await vi.waitFor(() => expect(h.pending).toHaveLength(1));

    (h.gmi as unknown as { sentimentTracker: { pendingEvents: Set<string> } }).sentimentTracker.pendingEvents.add(
      GMIEventType.USER_FRUSTRATED,
    );
    await runTurn(h.gmi, 'turn-2'); // raises the frustration batch behind it
    await runTurn(h.gmi, 'turn-3'); // the user has moved on before it starts

    h.pending[0].resolve('{}');
    await vi.waitFor(() =>
      expect(
        traceOf(h.gmi, ReasoningEntryType.DEBUG).filter((e) => e.message.includes('triggering turn has passed')),
      ).toHaveLength(1),
    );
    expect(h.generateCompletion).toHaveBeenCalledTimes(1);
  });
});

describe('metaprompt model resolution on OpenRouter', () => {
  it('finds the registered router for a namespaced default model instead of guessing its prefix', async () => {
    // Only OpenRouter is registered; the GMI default model is OpenRouter's
    // namespaced id and no default provider is configured.
    const persona = { ...createPersona([MANUAL_REFLECTION]), defaultModelId: undefined, defaultProviderId: undefined };
    const unpinned = { ...MANUAL_REFLECTION, modelId: undefined, providerId: undefined };
    const h = await createHarness(
      { ...persona, metaPrompts: [unpinned] } as unknown as IPersonaDefinition,
      '{}',
      { providerId: 'openrouter', defaultLlmModelId: 'openai/gpt-4o-mini', defaultLlmProviderId: undefined },
    );
    await arm(h);
    await runTurn(h.gmi, 'turn-1');

    await vi.waitFor(() => expect(h.generateCompletion).toHaveBeenCalledTimes(1));
    expect(h.generateCompletion.mock.calls[0][0]).toBe('openai/gpt-4o-mini');
  });

  it.each([
    { configured: 'openrouter/auto', sent: 'openrouter/auto' },
    { configured: 'openrouter/openai/gpt-4o-mini', sent: 'openai/gpt-4o-mini' },
    { configured: 'openai/gpt-4o-mini', sent: 'openai/gpt-4o-mini' },
  ])('sends $configured to OpenRouter as $sent', async ({ configured, sent }) => {
    // No provider is named anywhere, so the model id alone decides.
    const routed = { ...MANUAL_REFLECTION, modelId: configured, providerId: undefined };
    const persona = { ...createPersona([routed]), defaultModelId: undefined, defaultProviderId: undefined };
    const h = await createHarness(persona as unknown as IPersonaDefinition, '{}', {
      providerId: 'openrouter',
      defaultLlmProviderId: undefined,
    });
    await arm(h);
    await runTurn(h.gmi, 'turn-1');

    await vi.waitFor(() => expect(h.generateCompletion).toHaveBeenCalledTimes(1));
    expect(h.generateCompletion.mock.calls[0][0]).toBe(sent);
  });
});

describe('turn_interval cadence', () => {
  it.each([
    { intervalTurns: 1, turns: 3, fired: ['turn-1', 'turn-2', 'turn-3'] },
    { intervalTurns: 3, turns: 6, fired: ['turn-3', 'turn-6'] },
  ])(
    'intervalTurns $intervalTurns fires on every Nth user turn',
    async ({ intervalTurns, turns, fired }) => {
      const h = await createHarness(createPersona([intervalMetaprompt(intervalTurns)]), 'not json');
      for (let turn = 1; turn <= turns; turn += 1) {
        await runTurn(h.gmi, `turn-${turn}`);
      }
      expect(triggeredTurnIds(h.gmi)).toEqual(fired);
    },
  );

  const nonUserTurns: Array<[string, (gmi: GMI) => Promise<unknown>]> = [
    [
      'a tool continuation',
      (gmi) =>
        gmi.handleToolResults(
          [{ toolCallId: 'external-1', toolName: 'lookup', output: { ok: true } }],
          'user-1',
        ),
    ],
    [
      'a system message turn',
      (gmi) =>
        runTurn(gmi, 'system-1', { type: GMIInteractionType.SYSTEM_MESSAGE, content: 'Session resumed.' }),
    ],
    [
      'a tool response turn',
      (gmi) =>
        runTurn(gmi, 'tool-response-1', {
          type: GMIInteractionType.TOOL_RESPONSE,
          content: [{ toolCallId: 'external-2', toolName: 'lookup', output: { ok: true } }],
        }),
    ],
  ];

  it.each(nonUserTurns)(
    '%s neither counts toward nor fires a turn_interval metaprompt',
    async (_label, runNonUserTurn) => {
      const h = await createHarness(createPersona([intervalMetaprompt(2)]), 'not json');

      await runTurn(h.gmi, 'turn-1');
      await runNonUserTurn(h.gmi);
      for (const turnId of ['turn-2', 'turn-3', 'turn-4']) {
        await runTurn(h.gmi, turnId);
      }

      expect(triggeredTurnIds(h.gmi)).toEqual(['turn-2', 'turn-4']);
    },
  );

  it.each([[0], [Number.NaN], [undefined]])(
    'intervalTurns %s never fires and is reported once',
    async (intervalTurns) => {
      const h = await createHarness(
        createPersona([intervalMetaprompt(intervalTurns as number)]),
        'not json',
      );

      await runTurn(h.gmi, 'turn-1');
      await runTurn(h.gmi, 'turn-2');

      expect(triggeredTurnIds(h.gmi)).toEqual([]);
      expect(h.generateCompletion).not.toHaveBeenCalled();
      expect(warningsMentioning(h.gmi, 'intervalTurns')).toHaveLength(1);
    },
  );
});

describe('metaprompts the executor cannot run', () => {
  it('reports an unsupported trigger type once and never fires it', async () => {
    // Persona JSON is cast, not type-checked, so this shape reaches the executor.
    const preResponse = {
      id: 'voice_polish',
      promptTemplate: 'Polish {{recent_conversation}} and reply with JSON.',
      trigger: { type: 'pre_response' },
      modelId: MODEL_ID,
      providerId: PROVIDER_ID,
    } as unknown as MetaPromptDefinition;
    const h = await createHarness(createPersona([preResponse]), 'not json');

    await runTurn(h.gmi, 'turn-1');
    await runTurn(h.gmi, 'turn-2');

    expect(triggeredTurnIds(h.gmi)).toEqual([]);
    expect(h.generateCompletion).not.toHaveBeenCalled();
    expect(warningsMentioning(h.gmi, "'voice_polish'").map((entry) => entry.message)).toEqual([
      "Metaprompt 'voice_polish' will not run: trigger type 'pre_response' is not supported (expected turn_interval, event_based or manual).",
    ]);
  });
});

describe('shipped voice assistant persona', () => {
  it('runs its trait adjustment every 7 user turns on the GMI default model and applies the result', async () => {
    const persona = getBuiltInPersona('voice_assistant_persona');
    if (!persona) throw new Error('voice_assistant_persona is not a built-in persona');
    const h = await createHarness(
      persona,
      JSON.stringify({ updatedGmiMood: GMIMood.FOCUSED, adjustmentRationale: 'The user wants short spoken answers.' }),
    );

    for (let turn = 1; turn <= 7; turn += 1) {
      await runTurn(h.gmi, `turn-${turn}`);
    }
    expect(triggeredTurnIds(h.gmi)).toEqual(['turn-7']);
    await waitForTrace(h.gmi, ReasoningEntryType.SELF_REFLECTION_COMPLETE, 1);

    // The persona pins no model, so the reflection runs on the GMI's configured default.
    expect(h.generateCompletion).toHaveBeenCalledTimes(1);
    const [modelId, messages, options] = h.generateCompletion.mock.calls[0];
    expect(modelId).toBe(MODEL_ID);
    expect(options).toMatchObject({ maxTokens: 400, responseFormat: { type: 'json_object' } });
    const prompt = String(messages[0]?.content);
    expect(prompt).toContain('Current mood: helpful_engaged.');
    expect(prompt).not.toMatch(/\{\{\s*\w+\s*\}\}/);

    expect(await currentMood(h)).toBe(GMIMood.FOCUSED);
    expect(warningsMentioning(h.gmi, 'will not run')).toEqual([]);
  });
});
