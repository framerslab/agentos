/**
 * @fileoverview A generation helper's hold on a budget with a spend meter, at its edges, on SqlSpendMeter over SQLite:
 * what a call's `customModelParams` send counts in its bound (a Gemini `generationConfig`, which replaces the one the
 * provider builds; an output cap a field removes; a raw structured-output schema; context a field draws in; a model a
 * field names), an embedding's bound, how a held call settles when the provider retried it, reported only a total,
 * failed before sending anything, or ran past the meter's lease, when its signal fired before its stream was read and
 * when its reader held a chunk past the lease, how a held call settles at usage reported after it stopped, and how an
 * embedding settles when its answers leave out their tokens or a guard's cap function throws at its charge.
 *
 * The seat cases call a launched seat's provider (`meteredProviderManager`) with a provider object of the test's own;
 * the late-usage case runs the real completion gateway over such a provider; the embedding cases stub fetch.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveStorageAdapter } from '@framers/sql-storage-adapter';

import type { AIModelProviderManager } from '../../../core/llm/providers/AIModelProviderManager.js';
import type { ChatMessage, IProvider, ModelCompletionOptions, ModelCompletionResponse, ModelUsage } from '../../../core/llm/providers/IProvider.js';
import { CostGuard } from '../../../safety/runtime/CostGuard.js';
import { SqlSpendMeter, type SqlSpendMeterOptions } from '../../../safety/runtime/SqlSpendMeter.js';
import { toMicro } from '../../../safety/runtime/SpendReservations.js';
import { embedText } from '../../embedText.js';
import { meteredProviderManager } from '../agencyLaunch/meteredProviderManager.js';
import { createCompletionGateway, type CompletionResolution } from '../completionGateway.js';
import { heldAttempt } from '../heldAttempt.js';
import { MAX_COST_TOKENS_PER_MESSAGE, MAX_COST_TOOL_USE_TOKENS, estimateMaxCallCostUSD, maxInputTokens, registerModelPricing, utf8ByteLength } from '../modelPricing.js';
import { SpendBudget, UnpricedModelError, costOfUsageUSD, holdCall, maxCostRequestOf, type HelperCall } from '../spendBudget.js';

const ACCOUNT = 'acct-hold';
const PERIOD = '2026-11';
/** The chat model the OpenAI cases name, priced by the table this file registers. */
const MODEL = 'stub-model';
/** The Gemini model the Gemini cases name, priced by the table this file registers. */
const GEMINI_MODEL = 'stub-gemini';
/** The Gemini embedding model the embedding cases name: it counts no tokens, and a host's table prices it. */
const GEMINI_EMBED_MODEL = 'gemini-embedding-001';
/** The Mistral embedding model the embedding cases name, priced by the table this file registers. */
const MISTRAL_EMBED_MODEL = 'stub-mistral-embed';
/** The Ollama embedding model the embedding case names, priced by the table this file registers. */
const OLLAMA_EMBED_MODEL = 'stub-ollama-embed';
const MAX_TOKENS = 100;
const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'Say hello.' }];
/** The usage a finished seat call reports. */
const CHAT_USAGE: ModelUsage = { promptTokens: 12, completionTokens: 3, totalTokens: 15 };

interface MeterFixture {
  meter: SqlSpendMeter;
  figures(): Promise<{ used: number; reserved: number }>;
  close(): Promise<void>;
}

async function openMeter(extra: Partial<SqlSpendMeterOptions> = {}): Promise<MeterFixture> {
  const db = await resolveStorageAdapter({ filePath: ':memory:', priority: ['better-sqlite3', 'sqljs'], quiet: true });
  const meter = new SqlSpendMeter({
    db,
    allowanceFor: () => 1_000_000,
    periodOf: () => PERIOD,
    requireShared: false,
    resolveExpired: () => ({ outcome: 'deferred', retryAt: Date.now() + 1_000 }),
    ...extra,
  });
  return {
    meter,
    async figures() {
      const { used, reserved } = await meter.snapshot(ACCOUNT);
      return { used, reserved };
    },
    close: () => db.close(),
  };
}

/** A promise the test opens. */
function opening(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** A chat call to `providerId`, as a helper holds it. */
function chatCall(providerId: string, modelId: string, customModelParams?: Record<string, unknown>): HelperCall {
  return {
    what: 'test.call',
    route: { providerId, modelId },
    messages: MESSAGES,
    maxTokens: MAX_TOKENS,
    ...(customModelParams ? { options: { customModelParams } } : {}),
  };
}

/** A reply in the unstreamed shape, reporting `usage`. */
const completion = (usage: unknown = CHAT_USAGE): ModelCompletionResponse =>
  ({
    id: 'seat-1',
    object: 'chat.completion',
    created: 0,
    modelId: MODEL,
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }],
    usage,
  }) as unknown as ModelCompletionResponse;

/** A launched seat's provider on `budget`, over a provider whose unstreamed answer `answer` gives. */
function seat(budget: SpendBudget, answer: (options: ModelCompletionOptions) => Promise<ModelCompletionResponse>): IProvider {
  const provider = {
    providerId: 'openai',
    generateCompletion: (_modelId: string, _messages: ChatMessage[], options: ModelCompletionOptions) => answer(options),
  } as unknown as IProvider;
  const base = { getProvider: () => provider, getDefaultProvider: () => provider, getProviderForModel: () => provider } as unknown as AIModelProviderManager;
  return meteredProviderManager(base, budget).getProvider('openai') as IProvider;
}

beforeAll(() => {
  registerModelPricing('openai', (modelId) => (modelId === MODEL ? { inputPerMTokUSD: 1, outputPerMTokUSD: 10 } : undefined));
  registerModelPricing('gemini', (modelId) => (modelId === GEMINI_MODEL || modelId === GEMINI_EMBED_MODEL ? { inputPerMTokUSD: 1, outputPerMTokUSD: 10 } : undefined));
  registerModelPricing('mistral', (modelId) => (modelId === MISTRAL_EMBED_MODEL ? { inputPerMTokUSD: 1, outputPerMTokUSD: 0 } : undefined));
  registerModelPricing('ollama', (modelId) => (modelId === OLLAMA_EMBED_MODEL ? { inputPerMTokUSD: 1, outputPerMTokUSD: 0 } : undefined));
});

afterAll(() => {
  registerModelPricing('openai', () => undefined);
  registerModelPricing('gemini', () => undefined);
  registerModelPricing('mistral', () => undefined);
  registerModelPricing('ollama', () => undefined);
});

describe('what a call sends, as its bound counts it', () => {
  let fx: MeterFixture;
  beforeEach(async () => {
    fx = await openMeter();
  });
  afterEach(async () => {
    await fx.close();
  });

  it("has no bound for a Gemini call whose generationConfig, which replaces the provider's own, names no output cap, and holds nothing for it", async () => {
    const call = chatCall('gemini', GEMINI_MODEL, { generationConfig: { temperature: 0.2 } });
    expect(maxCostRequestOf(call).maxOutputTokens).toBeUndefined();
    const budget = new SpendBudget({ maxCostUSD: Number.POSITIVE_INFINITY, meter: fx.meter, accountId: ACCOUNT });
    await expect(holdCall(budget, call)).rejects.toBeInstanceOf(UnpricedModelError);
    expect(await fx.figures()).toEqual({ used: 0, reserved: 0 });
  });

  it("takes a Gemini generationConfig's output cap in place of the call's own", () => {
    expect(maxCostRequestOf(chatCall('gemini', GEMINI_MODEL, { generationConfig: { maxOutputTokens: 4_000 } })).maxOutputTokens).toBe(4_000);
  });

  it('counts the candidates a Gemini generationConfig asks for, so more than one has no bound', () => {
    const req = maxCostRequestOf(chatCall('gemini', GEMINI_MODEL, { generationConfig: { maxOutputTokens: MAX_TOKENS, candidateCount: 2 } }));
    expect(req.n).toBe(2);
    expect(estimateMaxCallCostUSD('gemini', GEMINI_MODEL, req)).toBeUndefined();
  });

  it("counts the call's own cap beside a Gemini generation_config, which leaves the provider's in the request", () => {
    expect(maxCostRequestOf(chatCall('gemini', GEMINI_MODEL, { generation_config: { maxOutputTokens: 50 } })).maxOutputTokens).toBe(MAX_TOKENS);
  });

  it.each([
    { generationConfig: { maxOutputTokens: MAX_TOKENS, responseModalities: ['IMAGE'] } },
    { generationConfig: { maxOutputTokens: MAX_TOKENS, responseModalities: ['TEXT', 'IMAGE'] } },
    { generationConfig: { maxOutputTokens: MAX_TOKENS, responseModalities: ['AUDIO'] } },
    { generationConfig: { maxOutputTokens: MAX_TOKENS, responseModalities: 'IMAGE' } },
    { generationConfig: { maxOutputTokens: MAX_TOKENS, response_modalities: ['IMAGE'] } },
    { generationConfig: { maxOutputTokens: MAX_TOKENS, speechConfig: { voiceConfig: {} } } },
    { generationConfig: { maxOutputTokens: MAX_TOKENS, speech_config: {} } },
    { generation_config: { responseModalities: ['IMAGE'] } },
    { generation_config: { speechConfig: {} } },
  ])('has no bound for a Gemini call that asks for output other than text: %j', (fields) => {
    const req = maxCostRequestOf(chatCall('gemini', GEMINI_MODEL, fields));
    expect(estimateMaxCallCostUSD('gemini', GEMINI_MODEL, req)).toBeUndefined();
  });

  it.each([{ responseModalities: ['TEXT'] }, { responseModalities: ['text'] }, { responseModalities: [] }])(
    'keeps the bound of a Gemini call that asks for text alone: %j',
    (fields) => {
      const req = maxCostRequestOf(chatCall('gemini', GEMINI_MODEL, { generationConfig: { maxOutputTokens: MAX_TOKENS, ...fields } }));
      expect(estimateMaxCallCostUSD('gemini', GEMINI_MODEL, req)).toBeGreaterThan(0);
    },
  );

  it('keeps the bound of a call to a provider that drops a generationConfig, whatever output it names', () => {
    const req = maxCostRequestOf(chatCall('openai', MODEL, { generationConfig: { responseModalities: ['IMAGE'], speechConfig: {} } }));
    expect(estimateMaxCallCostUSD('openai', MODEL, req)).toBeGreaterThan(0);
  });

  it('has no bound for a completion count that is not a number, which a provider may read as one', () => {
    const req = maxCostRequestOf(chatCall('gemini', GEMINI_MODEL, { generationConfig: { maxOutputTokens: MAX_TOKENS, candidateCount: '2' } }));
    expect(estimateMaxCallCostUSD('gemini', GEMINI_MODEL, req)).toBeUndefined();
  });

  it.each([{ model: 'a-dearer-model' }, { models: ['a-dearer-model'] }])('has no bound for a call whose fields name a model of their own: %j', (fields) => {
    const req = maxCostRequestOf(chatCall('openai', MODEL, fields));
    expect(estimateMaxCallCostUSD('openai', MODEL, req)).toBeUndefined();
  });

  it("keeps the call's own cap on a provider that drops a generationConfig", () => {
    expect(maxCostRequestOf(chatCall('openai', MODEL, { generationConfig: { temperature: 0.2 } })).maxOutputTokens).toBe(MAX_TOKENS);
  });

  it('has no bound for a call whose fields send an output cap that is not a number', () => {
    expect(maxCostRequestOf(chatCall('openai', MODEL, { max_completion_tokens: null })).maxOutputTokens).toBeUndefined();
  });

  it('counts a structured-output schema sent through customModelParams, with the tool-use prompt', () => {
    const schema = { type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object', description: 'd'.repeat(4_000) } } };
    const without = maxInputTokens(maxCostRequestOf(chatCall('openai', MODEL))) as number;
    const withSchema = maxInputTokens(maxCostRequestOf(chatCall('openai', MODEL, { response_format: schema }))) as number;
    expect(withSchema).toBeGreaterThanOrEqual(without + utf8ByteLength(JSON.stringify(schema)) + MAX_COST_TOOL_USE_TOKENS);
  });

  it('has no bound for a Gemini call that draws in cached content', () => {
    const req = maxCostRequestOf(chatCall('gemini', GEMINI_MODEL, { cachedContent: 'cachedContents/abc' }));
    expect(estimateMaxCallCostUSD('gemini', GEMINI_MODEL, req)).toBeUndefined();
  });

  it('prices an embedding at its input rate, never at a cache-write rate it does not ask for', () => {
    const call: HelperCall = { what: 'embed_text', route: { providerId: 'openai', modelId: MODEL }, messages: ['x'.repeat(100)], maxTokens: 0, embedding: true };
    expect(maxCostRequestOf(call).cacheMarkers).toBe(false);
  });
});

describe('how a held seat call settles', () => {
  let fx: MeterFixture;
  const metered = (meter: SqlSpendMeter = fx.meter): SpendBudget => new SpendBudget({ maxCostUSD: Number.POSITIVE_INFINITY, meter, accountId: ACCOUNT });
  afterEach(async () => {
    await fx.close();
  });

  it('keeps a call held when an earlier attempt of it got no answer, which the provider may have billed', async () => {
    fx = await openMeter();
    const provider = seat(metered(), async (options) => {
      options.onAttempt?.({ attempt: 1, status: null, ok: false });
      options.onAttempt?.({ attempt: 2, status: 200, ok: true });
      return completion();
    });
    await provider.generateCompletion(MODEL, MESSAGES, { maxTokens: MAX_TOKENS });
    const figures = await fx.figures();
    expect(figures.used).toBe(0);
    expect(figures.reserved).toBeGreaterThan(0);
  });

  it('settles at its usage when the earlier attempts were refused before any output', async () => {
    fx = await openMeter();
    const provider = seat(metered(), async (options) => {
      options.onAttempt?.({ attempt: 1, status: 429, ok: false });
      options.onAttempt?.({ attempt: 2, status: 200, ok: true });
      return completion();
    });
    await provider.generateCompletion(MODEL, MESSAGES, { maxTokens: MAX_TOKENS });
    expect(await fx.figures()).toEqual({ used: toMicro(costOfUsageUSD('openai', MODEL, CHAT_USAGE) as number), reserved: 0 });
  });

  it('keeps a call held when an earlier attempt of it was answered with a 5xx, which does not show what was billed', async () => {
    fx = await openMeter();
    const provider = seat(metered(), async (options) => {
      options.onAttempt?.({ attempt: 1, status: 503, ok: false });
      options.onAttempt?.({ attempt: 2, status: 200, ok: true });
      return completion();
    });
    await provider.generateCompletion(MODEL, MESSAGES, { maxTokens: MAX_TOKENS });
    const figures = await fx.figures();
    expect(figures.used).toBe(0);
    expect(figures.reserved).toBeGreaterThan(0);
  });

  it.each([500, 502, 503, 504, 529])('keeps a call held that the provider reported and threw as a %i with no usage', async (status) => {
    fx = await openMeter();
    const provider = seat(metered(), async (options) => {
      options.onAttempt?.({ attempt: 1, status, ok: false });
      throw Object.assign(new Error('bad gateway'), { httpStatus: status });
    });
    await expect(provider.generateCompletion(MODEL, MESSAGES, { maxTokens: MAX_TOKENS })).rejects.toThrow('bad gateway');
    const figures = await fx.figures();
    expect(figures.used).toBe(0);
    expect(figures.reserved).toBeGreaterThan(0);
  });

  it('keeps a call held that timed out with a 408, a status that says nothing of what ran', async () => {
    fx = await openMeter();
    const provider = seat(metered(), async (options) => {
      options.onAttempt?.({ attempt: 1, status: 408, ok: false });
      throw Object.assign(new Error('request timeout'), { httpStatus: 408 });
    });
    await expect(provider.generateCompletion(MODEL, MESSAGES, { maxTokens: MAX_TOKENS })).rejects.toThrow('request timeout');
    expect((await fx.figures()).reserved).toBeGreaterThan(0);
  });

  it('takes the whole reservation for an answer whose usage names only a total, which no rate prices', async () => {
    fx = await openMeter();
    const gate = opening();
    const provider = seat(metered(), async () => {
      await gate.promise;
      return completion({ totalTokens: 100 });
    });
    const pending = provider.generateCompletion(MODEL, MESSAGES, { maxTokens: MAX_TOKENS });
    let held = 0;
    for (let i = 0; i < 200 && held === 0; i++) {
      held = (await fx.figures()).reserved;
      if (held === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(held).toBeGreaterThan(0);
    gate.open();
    await pending;
    expect(await fx.figures()).toEqual({ used: held, reserved: 0 });
  });

  it('frees a call the provider refused before building its request, with no attempt reported', async () => {
    fx = await openMeter();
    const provider = seat(metered(), async () => {
      throw Object.assign(new Error('the provider is not initialized'), { code: 'PROVIDER_NOT_INITIALIZED' });
    });
    await expect(provider.generateCompletion(MODEL, MESSAGES, { maxTokens: MAX_TOKENS })).rejects.toThrow('not initialized');
    expect(await fx.figures()).toEqual({ used: 0, reserved: 0 });
  });

  it("renews the reservation's lease while the request runs, so a reconcile past the lease leaves it to the call", async () => {
    // A host whose resolver frees what it has no stored reply for: a lease that ran out mid-call would be freed.
    fx = await openMeter({ leaseMs: 300, resolveExpired: () => ({ outcome: 'released' }) });
    const gate = opening();
    const provider = seat(metered(), async () => {
      await gate.promise;
      return completion();
    });
    const pending = provider.generateCompletion(MODEL, MESSAGES, { maxTokens: MAX_TOKENS });
    await new Promise((resolve) => setTimeout(resolve, 600));
    await fx.meter.reconcile();
    expect((await fx.figures()).reserved).toBeGreaterThan(0);
    gate.open();
    await pending;
    expect(await fx.figures()).toEqual({ used: toMicro(costOfUsageUSD('openai', MODEL, CHAT_USAGE) as number), reserved: 0 });
  });
});

describe('a held stream whose signal fired before it was read', () => {
  let fx: MeterFixture;
  beforeEach(async () => {
    fx = await openMeter();
  });
  afterEach(async () => {
    await fx.close();
  });

  it('reads nothing from the provider, ends with the abort chunk and frees the reservation', async () => {
    const controller = new AbortController();
    const budget = new SpendBudget({ maxCostUSD: Number.POSITIVE_INFINITY, meter: fx.meter, accountId: ACCOUNT });
    const hold = await holdCall(budget, { ...chatCall('openai', MODEL), abortSignal: controller.signal });
    expect((await fx.figures()).reserved).toBeGreaterThan(0);
    controller.abort();
    let reads = 0;
    async function* source(): AsyncGenerator<ModelCompletionResponse, void, undefined> {
      reads += 1;
      yield completion();
    }
    const chunks: ModelCompletionResponse[] = [];
    for await (const chunk of hold.stream(source())) chunks.push(chunk);
    expect(reads).toBe(0);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].error?.type).toBe('abort');
    expect(await fx.figures()).toEqual({ used: 0, reserved: 0 });
  });

  it('renews its lease again once a reader that held one chunk past the lease reads on', async () => {
    const leased = await openMeter({ leaseMs: 300, resolveExpired: () => ({ outcome: 'released' }) });
    try {
      const budget = new SpendBudget({ maxCostUSD: Number.POSITIVE_INFINITY, meter: leased.meter, accountId: ACCOUNT });
      const hold = await holdCall(budget, chatCall('openai', MODEL));
      const gate = opening();
      async function* source(): AsyncGenerator<ModelCompletionResponse, void, undefined> {
        yield { ...completion(), usage: undefined };
        await gate.promise;
        yield completion();
      }
      const reader = hold.stream(source())[Symbol.asyncIterator]();
      await reader.next();
      await new Promise((resolve) => setTimeout(resolve, 400));
      const waiting = reader.next();
      await new Promise((resolve) => setTimeout(resolve, 600));
      await leased.meter.reconcile();
      expect((await leased.figures()).reserved).toBeGreaterThan(0);
      gate.open();
      await waiting;
      await reader.next();
      expect(await leased.figures()).toEqual({ used: toMicro(costOfUsageUSD('openai', MODEL, CHAT_USAGE) as number), reserved: 0 });
    } finally {
      await leased.close();
    }
  });
});

describe('usage reported after a held call stopped', () => {
  let fx: MeterFixture;
  const metered = (): SpendBudget => new SpendBudget({ maxCostUSD: Number.POSITIVE_INFINITY, meter: fx.meter, accountId: ACCOUNT });
  const answerMicro = (): number => toMicro(costOfUsageUSD('openai', MODEL, CHAT_USAGE) as number);

  beforeEach(async () => {
    fx = await openMeter();
  });
  afterEach(async () => {
    await fx.close();
  });

  it('settles a held reservation at that usage', async () => {
    const hold = await holdCall(metered(), chatCall('openai', MODEL));
    await hold.settle({ kind: 'left' });
    const held = await fx.figures();
    expect(held.used).toBe(0);
    expect(held.reserved).toBeGreaterThan(0);
    hold.lateUsage(CHAT_USAGE);
    await vi.waitFor(async () => expect(await fx.figures()).toEqual({ used: answerMicro(), reserved: 0 }));
  });

  it('settles at usage reported before the end of the call was settled', async () => {
    const hold = await holdCall(metered(), chatCall('openai', MODEL));
    hold.lateUsage(CHAT_USAGE);
    await hold.settle({ kind: 'left' });
    expect(await fx.figures()).toEqual({ used: answerMicro(), reserved: 0 });
  });

  it('leaves a reservation held when what came is not a usage report', async () => {
    const hold = await holdCall(metered(), chatCall('openai', MODEL));
    await hold.settle({ kind: 'left' });
    const held = await fx.figures();
    hold.lateUsage({ note: 'no counts' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await fx.figures()).toEqual(held);
  });

  it('settles an attempt the caller stopped when its provider reports the bill on the way out, through the real gateway', async () => {
    const opened = opening();
    const controller = new AbortController();
    const provider = {
      providerId: 'openai',
      // Reads the signal when its next event arrives: its abort chunk carries the request's bill.
      async *generateCompletionStream(_modelId: string, _messages: ChatMessage[], options: ModelCompletionOptions) {
        const chunk = { id: 'seat-1', object: 'chat.completion.chunk', created: 0, modelId: MODEL, choices: [] };
        yield { ...chunk, responseTextDelta: 'Partial' };
        await opened.promise;
        if (options.abortSignal?.aborted) yield { ...chunk, isFinal: true, usage: CHAT_USAGE, error: { message: 'Stream aborted by caller', type: 'abort' } };
      },
    };
    const resolution = {
      providerId: 'openai',
      modelId: MODEL,
      hop: 0,
      maxContextTokens: 128_000,
      capabilities: ['tool_use'],
      toolFormat: 'openai_functions',
      optionOverrides: {},
      chain: [{ provider: 'openai', model: MODEL }],
      providerManager: { getProvider: () => provider } as unknown as AIModelProviderManager,
    } as unknown as CompletionResolution;
    const gateway = createCompletionGateway();
    const onLateUsage = vi.fn();
    const attempt = heldAttempt(
      metered(),
      { ...chatCall('openai', MODEL), abortSignal: controller.signal },
      (held, onLate) =>
        gateway.stream(resolution, MESSAGES, { maxTokens: MAX_TOKENS, abortSignal: controller.signal, ...held }, undefined, undefined, false, onLate),
      onLateUsage,
    );
    for await (const _chunk of attempt) controller.abort();
    const held = await fx.figures();
    expect(held.used).toBe(0);
    expect(held.reserved).toBeGreaterThan(0);
    opened.open();
    await vi.waitFor(async () => expect(await fx.figures()).toEqual({ used: answerMicro(), reserved: 0 }));
    expect(onLateUsage).toHaveBeenCalledTimes(1);
  });
});

describe('how a held embedding settles when its answers leave out their tokens', () => {
  let fx: MeterFixture;
  const metered = (): SpendBudget => new SpendBudget({ maxCostUSD: Number.POSITIVE_INFINITY, meter: fx.meter, accountId: ACCOUNT });
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  /** What a Mistral answer with no usage is charged, at the bound of its one input. */
  const boundOf = (input: string): number =>
    toMicro(costOfUsageUSD('mistral', MISTRAL_EMBED_MODEL, { promptTokens: utf8ByteLength(input) + MAX_COST_TOKENS_PER_MESSAGE }, true) as number);
  const noUsage = { data: [{ index: 0, embedding: [0.1] }], model: MISTRAL_EMBED_MODEL };

  beforeEach(async () => {
    fx = await openMeter();
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await fx.close();
  });

  it("settles at the bound of its inputs on a host's price row when an answer omits its prompt tokens", async () => {
    const input = 'x'.repeat(1_000);
    vi.stubGlobal('fetch', vi.fn(async () => json(noUsage)));
    await embedText({ provider: 'mistral', model: MISTRAL_EMBED_MODEL, apiKey: 'mistral-omits-usage', input, budget: metered() });
    expect(await fx.figures()).toEqual({ used: boundOf(input), reserved: 0 });
  });

  it('settles a later batch the provider refused at the bound of the batch that answered with no count', async () => {
    const input = ['x'.repeat(1_000), 'y'.repeat(1_000)];
    const answers = [json(noUsage), json({ error: { message: 'bad request' } }, 400)];
    vi.stubGlobal('fetch', vi.fn(async () => answers.shift() as Response));
    await expect(
      embedText({ provider: 'mistral', model: MISTRAL_EMBED_MODEL, apiKey: 'mistral-later-refused', input, maxInputsPerRequest: 1, budget: metered() }),
    ).rejects.toThrow('Embedding request failed (400)');
    expect(await fx.figures()).toEqual({ used: boundOf(input[0]), reserved: 0 });
  });

  it("settles at its usage when a guard's cap function throws at the charge", async () => {
    const thrown = new Error('the cap function threw');
    const guard = new CostGuard({
      maxSingleOperationCostUsd: Number.POSITIVE_INFINITY,
      maxDailyCostUsd: Number.POSITIVE_INFINITY,
      onCapReached: () => {
        throw thrown;
      },
    });
    // Under 'warn' a call past the cap runs, so the charge is what reaches it.
    const budget = new SpendBudget({ maxCostUSD: 0.0001, guard, meter: fx.meter, accountId: ACCOUNT, onLimitReached: 'warn' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => json({ ...noUsage, usage: { prompt_tokens: 250, total_tokens: 250 } })),
      );
      await expect(embedText({ provider: 'mistral', model: MISTRAL_EMBED_MODEL, apiKey: 'mistral-guard-throws', input: 'x'.repeat(1_000), budget })).rejects.toBe(thrown);
    } finally {
      warn.mockRestore();
    }
    expect(await fx.figures()).toEqual({ used: toMicro(costOfUsageUSD('mistral', MISTRAL_EMBED_MODEL, { promptTokens: 250 }, true) as number), reserved: 0 });
  });

  it("renews an Ollama request's lease while it runs, so a reconcile past the lease leaves it to the call", async () => {
    const leased = await openMeter({ leaseMs: 300, resolveExpired: () => ({ outcome: 'released' }) });
    try {
      const gate = opening();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          await gate.promise;
          return json({ model: OLLAMA_EMBED_MODEL, embeddings: [[0.1]] });
        }),
      );
      const budget = new SpendBudget({ maxCostUSD: Number.POSITIVE_INFINITY, meter: leased.meter, accountId: ACCOUNT });
      const pending = embedText({ provider: 'ollama', model: OLLAMA_EMBED_MODEL, baseUrl: 'http://ollama.test', input: 'x'.repeat(1_000), budget });
      await new Promise((resolve) => setTimeout(resolve, 600));
      await leased.meter.reconcile();
      const held = (await leased.figures()).reserved;
      expect(held).toBeGreaterThan(0);
      gate.open();
      await pending;
      expect(await leased.figures()).toEqual({ used: held, reserved: 0 });
    } finally {
      await leased.close();
    }
  });

  it('takes the whole reservation for a Gemini request whose answers count no tokens', async () => {
    let held = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        held = (await fx.figures()).reserved;
        return json({ embeddings: [{ values: [0.1] }] });
      }),
    );
    await embedText({ provider: 'gemini', model: GEMINI_EMBED_MODEL, apiKey: 'gemini-counts-nothing', input: 'x'.repeat(1_000), budget: metered() });
    expect(held).toBeGreaterThan(0);
    expect(await fx.figures()).toEqual({ used: held, reserved: 0 });
  });

  it('takes the whole reservation for a Gemini request refused after a batch that counted no tokens', async () => {
    let held = 0;
    const input = Array.from({ length: 101 }, (_, i) => `text ${i}`);
    let sent = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        sent += 1;
        held = (await fx.figures()).reserved;
        return sent === 1 ? json({ embeddings: input.slice(0, 100).map(() => ({ values: [0.1] })) }) : json({ error: { message: 'bad request' } }, 400);
      }),
    );
    await expect(
      embedText({ provider: 'gemini', model: GEMINI_EMBED_MODEL, apiKey: 'gemini-later-refused', input, budget: metered() }),
    ).rejects.toThrow();
    expect(held).toBeGreaterThan(0);
    expect(await fx.figures()).toEqual({ used: held, reserved: 0 });
  });
});
