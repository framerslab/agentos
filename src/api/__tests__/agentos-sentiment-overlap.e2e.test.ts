/**
 * @file agentos-sentiment-overlap.e2e.test.ts
 * Boots the full runtime with a provider stub and checks how a turn's sentiment analysis runs beside its first
 * model call: the main request starts while the default LLMUtilityAI's sentiment reply is held, the first tool round
 * and the post-turn metaprompt check wait for it within one shared budget, a failed analysis writes one safe log
 * line, and a result that arrives late, after the turn forgot its input, or after a failure, an abort or a shutdown
 * changes no sentiment state. The provider is the only replaced boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const wire = vi.hoisted(() => ({
  main: 0,
  utility: 0,
  utilityReply: undefined as undefined | (() => Promise<string>),
  mainGate: undefined as undefined | Promise<void>,
  mainFailure: false,
  tool: false,
  seenSentiment: undefined as unknown,
  seen: [] as any[],
  visible: [] as any[],
  logs: [] as Array<{ event: string; fields: unknown }>,
  usage: undefined as undefined | Record<string, number>,
}));
vi.mock('../../core/logging/loggerFactory', async (original) => {
  const actual = await original<typeof import('../../core/logging/loggerFactory')>();
  return {
    ...actual,
    moduleLogger: (...args: Parameters<typeof actual.moduleLogger>) => {
      const log = actual.moduleLogger(...args);
      return {
        ...log,
        warn: (event: any, fields: any) => { wire.logs.push({ event, fields }); log.warn(event, fields); },
        info: (event: any, fields: any) => { wire.logs.push({ event, fields }); log.info(event, fields); },
      };
    },
  };
});
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', () => ({
  OpenAIProvider: class {
    readonly providerId = 'openai';
    isInitialized = false;
    async initialize() { this.isInitialized = true; }
    async generateCompletion(_model: string, messages: any[]) {
      const sentiment = JSON.stringify(messages).includes('Analyze the sentiment');
      if (sentiment) wire.utility += 1;
      const content = sentiment
        ? await wire.utilityReply!()
        : '{"adjustmentRationale":"Recovery applied","updatedGmiMood":"EMPATHETIC"}';
      return { choices: [{ index: 0, message: { role: 'assistant', content }, finishReason: 'stop' }], responseText: content };
    }
    async *generateCompletionStream(_model: string, messages: any[], options: any) {
      wire.main += 1;
      wire.seen.push({ messages, options });
      if (wire.mainGate) await wire.mainGate;
      if (wire.mainFailure) throw new Error('scripted main failure');
      if (options?.abortSignal?.aborted) {
        yield { isFinal: true, error: { message: 'Request aborted', type: 'abort' }, choices: [] };
        return;
      }
      if (wire.tool && wire.main === 1) {
        yield { isFinal: true, choices: [{ index: 0, message: {
          role: 'assistant', content: null,
          tool_calls: [{ id: 'sentiment-tool', type: 'function', function: { name: 'readSentiment', arguments: '{}' } }],
        }, finishReason: 'tool_calls' }] };
      } else {
        yield { responseTextDelta: 'Noted.' };
        yield { isFinal: true, choices: [{ index: 0, message: { role: 'assistant', content: 'Noted.' }, finishReason: 'stop' }],
          ...(wire.usage ? { usage: wire.usage } : {}) };
      }
    }
    async generateEmbeddings() { return { embeddings: [] }; }
    async listAvailableModels() { return []; }
    async getModelInfo() { return undefined; }
    async checkHealth() { return { isHealthy: true }; }
    async shutdown() {}
  },
}));

import { AgentOS } from '../AgentOS';
import { GMI } from '../../cognition/substrate/GMI';
import { GMIEventType } from '../../cognition/substrate/GMIEvent';
import { AgentOSResponseChunkType } from '../types/AgentOSResponse';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const negative = '{"score":-0.9,"polarity":"negative","intensity":0.9}';
let os: AgentOS | undefined;
let current: any;
let pending: Array<Promise<unknown>>;
let releases: Array<() => void>;
let seedErrors = false;

beforeEach(() => {
  wire.main = 0; wire.utility = 0; wire.tool = false; wire.mainFailure = false;
  wire.mainGate = undefined; wire.usage = undefined; wire.seenSentiment = undefined;
  wire.seen.length = 0; wire.logs.length = 0; wire.visible.length = 0;
  wire.utilityReply = async () => negative;
  pending = []; releases = []; current = undefined; seedErrors = false;
  const initialize = GMI.prototype.initialize;
  vi.spyOn(GMI.prototype, 'initialize').mockImplementation(async function (this: GMI, ...args) {
    await initialize.apply(this, args);
    current = this;
    if (seedErrors) {
      current.addTraceEntry('ERROR', 'First scripted error');
      current.addTraceEntry('ERROR', 'Second scripted error');
    }
  });
});
afterEach(async () => {
  for (const release of releases) release();
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(2100);
  await Promise.allSettled(pending);
  if (os) await os.shutdown();
  os = undefined;
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
});
function holdUtility() {
  const held = deferred<string>();
  releases.push(() => held.resolve(negative));
  wire.utilityReply = () => held.promise;
  return held;
}
async function boot() {
  vi.stubEnv('ENABLE_UTILITY_AI', 'false');
  os = await AgentOS.create({
    modelProviderManagerConfig: { providers: [{ providerId: 'openai', enabled: true, isDefault: true, config: { apiKey: 'test' } }] },
    turnPlanning: { enabled: false },
    orchestratorConfig: { enableConversationalPersistence: false, promptProfileConfig: null },
    tools: [{ id: 'read-sentiment', name: 'readSentiment', description: 'Read the turn sentiment.',
      inputSchema: { type: 'object', properties: {} },
      execute: async (_args: unknown, context: any) => {
        wire.seenSentiment = context.userContext.currentSentiment;
        return { success: true, output: 'read' };
      } }],
    personas: [{ id: 'sentiment', name: 'Sentiment', description: 'Sentiment test.', version: '1.0.0',
      baseSystemPrompt: 'Be helpful.', defaultProviderId: 'openai', defaultModelId: 'test-model',
      // The short preset name: personaNormalization.ts maps `frustration_recovery` to the metaprompt
      // `gmi_frustration_recovery` and drops a name it does not know, which would leave no metaprompt to fire.
      sentimentTracking: { enabled: true, presets: ['frustration_recovery'] } }],
  } as any);
}
function turn(textInput = 'This is terrible.', extra: Record<string, unknown> = {}) {
  const result = (async () => {
    const chunks: any[] = [];
    for await (const chunk of os!.processRequest({
      userId: 'user', sessionId: 'session', selectedPersonaId: 'sentiment', textInput, ...extra,
    } as any)) { chunks.push(chunk); wire.visible.push(chunk); }
    return chunks;
  })();
  pending.push(result);
  return result;
}
async function mainStarted(count = 1) {
  await vi.waitFor(() => expect(wire.main, 'main request must start before sentiment is released').toBe(count), { timeout: 500, interval: 10 });
}
async function snapshot() {
  return JSON.stringify({
    user: current.currentUserContext,
    history: await current.workingMemory.get('gmi_sentiment_history'),
    events: current.sentimentTracker.events,
    pending: [...current.sentimentTracker.pendingEvents],
    trace: current.reasoningTrace.entries,
  });
}

describe('full-runtime sentiment overlap', () => {
  it('starts the main request while LLM sentiment is unanswered', async () => {
    const held = holdUtility(); await boot();
    const done = turn();
    await mainStarted();
    expect(wire.utility).toBe(1);
    await vi.waitFor(() => expect(wire.visible.some((chunk) => chunk.type === 'text_delta')).toBe(true));
    held.resolve(negative); await done;
    expect(current.currentUserContext.currentSentiment).toBe('negative');
    expect(current.sentimentTracker.pendingEvents.size).toBe(0);
    expect(current.reasoningTrace.entries.some((entry: any) => entry.type === 'SELF_REFLECTION_TRIGGERED')).toBe(true);
  });

  it('settles before the first tool reader and keeps the starting error snapshot', async () => {
    seedErrors = true; wire.tool = true;
    const held = holdUtility(); await boot();
    const done = turn(); await mainStarted();
    for (let i = 0; i < 15; i += 1) current.addTraceEntry('DEBUG', 'Prompt work');
    held.resolve(negative); await done;
    expect(wire.seenSentiment).toBe('negative');
    expect(current.sentimentTracker.events.map((event: any) => event.eventType)).toContain(GMIEventType.ERROR_THRESHOLD_EXCEEDED);
  });

  it('logs one safe failure and still answers', async () => {
    const held = holdUtility(); await boot();
    const done = turn(); await mainStarted();
    await vi.waitFor(() => expect(wire.visible.some((chunk) => chunk.type === 'text_delta')).toBe(true));
    held.reject(new Error('scripted provider failure')); const chunks = await done;
    expect(chunks.some((chunk) => JSON.stringify(chunk).includes('Noted.'))).toBe(true);
    expect(wire.logs.filter((line) => line.event === 'gmi.sentiment_failed')).toHaveLength(1);
    expect(current.sentimentTracker.events).toEqual([]);
  });

  it('logs one failure after a sentiment reply and its repair do not parse', async () => {
    wire.utilityReply = async () => 'not json';
    await boot();
    await turn();
    expect(wire.logs.filter((line) => line.event === 'gmi.sentiment_failed')).toHaveLength(1);
    expect(current.sentimentTracker.events).toEqual([]);
    expect(wire.seen.length).toBeGreaterThan(0);
  });

  it('drops a late result without replacing the next turn context or writing any sentiment state', async () => {
    const held = holdUtility(); await boot(); vi.useFakeTimers();
    const done = turn(); await mainStarted();
    await vi.advanceTimersByTimeAsync(2000); await done;
    const late = wire.logs.filter((line) => line.event === 'gmi.sentiment_late');
    expect(late).toHaveLength(1);
    expect(Number.isInteger((late[0].fields as any).waitedMs)).toBe(true);
    current.activePersona.sentimentTracking.enabled = false;
    const next = current.processTurnStream({ interactionId: 't2', userId: 'user', type: 'text', content: 'Bonjour.',
      userContextOverride: { language: 'fr', preferences: { verbosity: 'detailed' } } });
    for await (const chunk of next) void chunk;
    const before = await snapshot();
    held.resolve(negative); await vi.advanceTimersByTimeAsync(0);
    expect(await snapshot()).toBe(before);
    expect(current.currentUserContext).toMatchObject({ language: 'fr', preferences: { verbosity: 'detailed' } });
    expect(await current.workingMemory.get('gmi_sentiment_history')).toBeUndefined();
  });

  it.each(['clearHistory', 'replaceHistory'] as const)('%s does not wait for a held analysis or restore its input', async (method) => {
    const held = holdUtility(); await boot(); vi.useFakeTimers();
    const first = turn("My PIN is 1234; I'm confused"); await mainStarted();
    await vi.advanceTimersByTimeAsync(2000); await first;
    if (method === 'clearHistory') current.clearHistory(); else current.replaceHistory([]);
    current.activePersona.sentimentTracking.enabled = false;
    const second = turn('Next question.'); await mainStarted(2); await second;
    const before = await snapshot(); held.resolve(negative); await vi.advanceTimersByTimeAsync(0);
    expect(await snapshot()).toBe(before);
    expect(await snapshot()).not.toContain('1234');
  });

  it('drops a forgotten result even before the turn reaches its post-turn reader', async () => {
    const held = holdUtility(); const main = deferred<void>();
    releases.push(() => main.resolve()); wire.mainGate = main.promise;
    await boot(); const done = turn("My PIN is 1234; I'm confused"); await mainStarted();
    current.clearHistory(); held.resolve(negative);
    await vi.waitFor(() => expect(current.sentimentTracker.events).toEqual([]));
    main.resolve(); await done;
    expect(await current.workingMemory.get('gmi_sentiment_history')).toBeUndefined();
    expect(await snapshot()).not.toContain('1234');
  });

  it.each(['failure', 'abort', 'shutdown'] as const)('abandons analysis on %s', async (ending) => {
    const held = holdUtility(); const main = deferred<void>();
    releases.push(() => main.resolve()); wire.mainGate = main.promise;
    await boot(); const abort = new AbortController();
    const done = turn('This is terrible.', { options: { abortSignal: abort.signal } });
    await mainStarted();
    if (ending === 'failure') wire.mainFailure = true;
    if (ending === 'abort') abort.abort();
    let shutdown: Promise<void> | undefined;
    if (ending === 'shutdown') shutdown = current.shutdown();
    main.resolve(); await done; await shutdown;
    const before = await snapshot(); held.resolve(negative);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await snapshot()).toBe(before);
  });

  it('uses one remaining budget across the first tool reader and the post-turn reader', async () => {
    holdUtility(); wire.tool = true;
    const main = deferred<void>(); releases.push(() => main.resolve()); wire.mainGate = main.promise;
    await boot(); vi.useFakeTimers();
    const started = Date.now(); const done = turn(); await mainStarted();
    await vi.advanceTimersByTimeAsync(500); main.resolve();
    await vi.advanceTimersByTimeAsync(1500); await done;
    expect(wire.main).toBe(2);
    expect(Date.now() - started).toBeLessThanOrEqual(2100);
    expect(wire.logs.filter((line) => line.event === 'gmi.sentiment_late')).toHaveLength(1);
    expect(current.currentUserContext.currentSentiment).toBeUndefined();
  });

  it('applies only sentiment to the user context held when the response arrives', async () => {
    const held = holdUtility(); const main = deferred<void>();
    releases.push(() => main.resolve()); wire.mainGate = main.promise;
    await boot(); const done = turn(); await mainStarted();
    current.currentUserContext = { ...current.currentUserContext, language: 'fr', preferences: { verbosity: 'detailed' } };
    held.resolve(negative); main.resolve(); await done;
    expect(current.currentUserContext).toMatchObject({ language: 'fr', preferences: { verbosity: 'detailed' }, currentSentiment: 'negative' });
  });
  it('preserves optional cache counters on FINAL_RESPONSE usage', async () => {
    wire.usage = { promptTokens: 3, completionTokens: 2, totalTokens: 5,
      cacheReadInputTokens: 11, cacheCreationInputTokens: 17, cacheCreationExtendedInputTokens: 0, inclusiveInputTokens: 31 };
    await boot();
    const chunks = await turn();
    const final = chunks.find((chunk) => chunk.type === AgentOSResponseChunkType.FINAL_RESPONSE);
    expect(final, 'the runtime must emit FINAL_RESPONSE').toBeDefined();
    expect(final.usage).toMatchObject({ cacheReadTokens: 11, cacheCreationTokens: 17,
      cacheCreationExtendedTokens: 0, inclusiveInputTokens: 31 });
  });
});
