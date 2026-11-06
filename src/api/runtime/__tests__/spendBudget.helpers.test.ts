/**
 * @fileoverview The generation helpers on a budget with a spend meter, end to end on SqlSpendMeter over SQLite: each
 * provider call reserves its largest cost in the meter before it is sent and settles the reservation after it. On
 * `generateText()`, `streamText()`, `generateObject()`, `embedText()`, `agent()`, `gmi()` and a launched team's seat:
 * a second call whose largest cost the allowance cannot hold beside the first's is refused before its provider is
 * asked; a finished call settles at what its usage cost and frees the rest; a provider's refusal before any output
 * frees the whole reservation; a call whose request went out and brought no usage back (a timeout, a stream aborted
 * after it was sent, a 5xx, which does not show what the provider billed) stays reserved and counted until a reconcile
 * with evidence settles it; each provider call carries the operation id its reservation is under; and a budget with no
 * meter holds nothing.
 *
 * Only the provider is stubbed: the OpenAI provider class at its module boundary (helpers/stubProviders.ts), fetch for
 * the embeddings endpoint, and a provider object for the seat's provider manager.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// The stub replaces the provider class alone: embedText also reads the module's other exports (its base URL).
vi.mock('../../../core/llm/providers/implementations/OpenAIProvider', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  OpenAIProvider: (await import('../../__tests__/helpers/stubProviders')).stubProviderClass('openai'),
}));
import { resolveStorageAdapter } from '@framers/sql-storage-adapter';

import type { AIModelProviderManager } from '../../../core/llm/providers/AIModelProviderManager.js';
import type { ChatMessage, IProvider, ModelCompletionOptions, ModelCompletionResponse } from '../../../core/llm/providers/IProvider.js';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';
import { SqlSpendMeter } from '../../../safety/runtime/SqlSpendMeter.js';
import {
  SpendMeterUnavailableError,
  type ISpendMeter,
  type SpendExpiryDecision,
  type SpendReserveRequest,
} from '../../../safety/runtime/SpendMeter.js';
import { toMicro } from '../../../safety/runtime/SpendReservations.js';
import { reply, script } from '../../__tests__/helpers/stubProviders.js';
import { agent } from '../../agent.js';
import { embedText } from '../../embedText.js';
import { generateObject } from '../../generateObject.js';
import { generateText } from '../../generateText.js';
import { gmi } from '../../gmi.js';
import { streamText } from '../../streamText.js';
import { meteredProviderManager } from '../agencyLaunch/meteredProviderManager.js';
import { registerModelPricing } from '../modelPricing.js';
import { SpendBudget, costOfUsageUSD } from '../spendBudget.js';
import { z } from 'zod';

const ACCOUNT = 'acct-helpers';
const PERIOD = '2026-11';
/** The chat model every call names, priced by the table this file registers for OpenAI. */
const MODEL = 'stub-model';
/** An embedding model OpenAI's own table prices. */
const EMBED_MODEL = 'text-embedding-3-small';
const PROMPT = 'Say hello.';
/** The output cap every chat call names, which bounds what it can cost. */
const MAX_TOKENS = 100;
/** The answer every reply carries: JSON, so generateObject parses it too. */
const ANSWER = '{"a":"x"}';
/** The usage every chat reply reports, the stub providers' default. */
const CHAT_USAGE = { promptTokens: 12, completionTokens: 3, totalTokens: 15 };
/** The usage the embeddings endpoint reports. */
const EMBED_USAGE = { prompt_tokens: 1_000, total_tokens: 1_000 };
/** The embedding input: long enough that its bound holds the usage the endpoint reports for it. */
const EMBED_INPUT = 'x'.repeat(4_000);
/** What the host's evidence shows a deferred call used, in micro-dollars. */
const EVIDENCE_UNITS = 30;

/** A promise the test opens. */
function opening(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

let keys = 0;
/** A key of its own for each test: the provider manager cache is keyed by provider and key. */
const key = (): string => `sk-helpers-${++keys}`;

/** How the provider answers one call. */
type Reply =
  /** Answers at once, reporting its usage. */
  | { kind: 'answer' }
  /** Answers once `gate` opens. */
  | { kind: 'held'; gate: Promise<void> }
  /** Refuses the request before any output, with HTTP `status`, 400 unless it names one. */
  | { kind: 'refused'; status?: number }
  /** Fails the request with a 5xx and no usage. */
  | { kind: 'server_error'; status: number }
  /** Sends no answer back after the request went out: a timeout. */
  | { kind: 'timed_out' }
  /** Streams one delta, then keeps the request open until the caller aborts it. */
  | { kind: 'cut' };

/** What a call does beyond being sent. */
interface CallOptions {
  /** Aborts the call's signal once its first text has arrived (a streamed call). */
  abortAfterFirstText?: boolean;
}

/** One helper, with its provider stubbed for a test. */
interface Prepared {
  /** How many requests reached the provider. */
  sent(): number;
  /** The operation id each provider call was handed, in order. */
  operationIds(): unknown[];
  /** One call through the helper: resolves once it answered, rejects with what it failed with. */
  call(budget: SpendBudget, options?: CallOptions): Promise<unknown>;
}

interface Surface {
  name: string;
  /** Whether the helper streams, so a call can be aborted after its first output. */
  streams: boolean;
  /** What the usage an answer reports cost, in micro-dollars. */
  answerMicro(): number;
  /** Stubs the provider: `replies` answer the calls in order. */
  prepare(replies: Reply[]): Prepared;
}

const refusal = (status = 400): Error => Object.assign(new Error('the provider refused the request'), { httpStatus: status });
const serverError = (status: number): Error => Object.assign(new Error('bad gateway'), { httpStatus: status });
const timeout = (): Error => Object.assign(new Error('the request timed out'), { code: 'REQUEST_TIMEOUT' });
const delta = { id: 'stub', object: 'chat.completion.chunk', created: 0, modelId: MODEL, choices: [], responseTextDelta: 'part ' };
/** A gate nothing opens: a request held on it ends only when it is aborted. */
const never = new Promise<void>(() => undefined);

/** The stub providers' replies for `replies`, as a streamed or an unstreamed call takes them. */
function stubReplies(replies: Reply[], streamed: boolean): Array<Array<Record<string, unknown> | Error> | Error> {
  return replies.map((r) => {
    if (r.kind === 'answer') return reply.text(ANSWER);
    if (r.kind === 'held') return streamed ? reply.hold([], r.gate, reply.text(ANSWER)) : reply.hold(reply.text(ANSWER), r.gate);
    if (r.kind === 'refused') return refusal(r.status);
    if (r.kind === 'server_error') return serverError(r.status);
    if (r.kind === 'timed_out') return timeout();
    return reply.hold([delta], never);
  });
}

/** Reads a stream of parts to its end, throwing the error its error part carries; aborts its signal at its first text when asked. */
async function readParts(parts: AsyncIterable<{ type: string; error?: unknown }>, controller: AbortController, options?: CallOptions): Promise<void> {
  for await (const part of parts) {
    if (part.type === 'text' && options?.abortAfterFirstText) controller.abort();
    if (part.type === 'error') throw part.error;
  }
}

/**
 * A helper whose calls reach the stubbed OpenAI provider class. `whole` when an ordinary call to it is unstreamed, as a
 * helper that does not stream makes it; a helper that does both streams only the call that aborts.
 */
function stubbed(name: string, streams: boolean, run: (k: string, budget: SpendBudget, options?: CallOptions) => Promise<unknown>, whole = !streams): Surface {
  return {
    name,
    streams,
    answerMicro: () => toMicro(costOfUsageUSD('openai', MODEL, CHAT_USAGE) as number),
    prepare(replies) {
      const k = key();
      const s = script('openai', k, { replies: stubReplies(replies, !whole), whole });
      return { sent: () => s.seen.length, operationIds: () => s.seen.map(({ options }) => options.operationId), call: (budget, options) => run(k, budget, options) };
    },
  };
}

let sessions = 0;

const generateTextSurface = stubbed('generateText', false, (k, budget) =>
  generateText({ provider: 'openai', model: MODEL, apiKey: k, prompt: PROMPT, maxTokens: MAX_TOKENS, budget, fallbackProviders: [] }),
);

const generateObjectSurface = stubbed('generateObject', false, (k, budget) =>
  generateObject({ provider: 'openai', model: MODEL, apiKey: k, schema: z.object({ a: z.string() }), prompt: PROMPT, maxTokens: MAX_TOKENS, budget, fallbackProviders: [] }),
);

const agentSurface = stubbed(
  'agent()',
  true,
  (k, budget, options) => {
    const session = agent({ provider: 'openai', model: MODEL, apiKey: k, maxTokens: MAX_TOKENS, fallbackProviders: [] }).session(`s-${++sessions}`);
    if (!options?.abortAfterFirstText) return session.send(PROMPT, { budget });
    const controller = new AbortController();
    return readParts(session.stream(PROMPT, { abortSignal: controller.signal, budget }).fullStream, controller, options);
  },
  true,
);

const streamTextSurface = stubbed('streamText', true, (k, budget, options) => {
  const controller = new AbortController();
  const result = streamText({ provider: 'openai', model: MODEL, apiKey: k, prompt: PROMPT, maxTokens: MAX_TOKENS, budget, fallbackProviders: [], abortSignal: controller.signal });
  return readParts(result.fullStream, controller, options);
});

const gmiSurface = stubbed('gmi()', true, (k, budget, options) => {
  const session = gmi({ provider: 'openai', model: MODEL, apiKey: k, instructions: 'Answer.', maxTokens: MAX_TOKENS, fallbackProviders: [] }).session(`s-${++sessions}`);
  if (!options?.abortAfterFirstText) return session.send(PROMPT, { budget });
  const controller = new AbortController();
  return readParts(session.stream(PROMPT, { abortSignal: controller.signal, budget }).fullStream, controller, options);
});

/** The header embedText's own requests carry the operation id in, which the embedText case names. */
const OPERATION_ID_HEADER = 'x-op';

const embedTextSurface: Surface = {
  name: 'embedText',
  streams: false,
  answerMicro: () => toMicro(costOfUsageUSD('openai', EMBED_MODEL, { promptTokens: EMBED_USAGE.prompt_tokens }, true) as number),
  prepare(replies) {
    const k = key();
    const queue = [...replies];
    let sent = 0;
    // embedText sends its requests itself, so the operation id is read off the wire, in the header the variable names.
    vi.stubEnv('AGENTOS_OPERATION_ID_HEADER', OPERATION_ID_HEADER);
    const operationIds: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        sent += 1;
        operationIds.push(new Headers(init?.headers).get(OPERATION_ID_HEADER));
        const next = queue.shift();
        if (!next) throw new Error('an embedding request the test did not script');
        if (next.kind === 'timed_out') throw Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
        if (next.kind === 'refused') return new Response(JSON.stringify({ error: { message: 'bad request' } }), { status: next.status ?? 400 });
        if (next.kind === 'server_error') return new Response(JSON.stringify({ error: { message: 'bad gateway' } }), { status: next.status });
        if (next.kind === 'held') await next.gate;
        return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2] }], model: EMBED_MODEL, usage: EMBED_USAGE }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    return { sent: () => sent, operationIds: () => operationIds, call: (budget) => embedText({ provider: 'openai', model: EMBED_MODEL, apiKey: k, input: EMBED_INPUT, budget }) };
  },
};

/** A reply in the unstreamed shape, reporting the chat usage. */
const completion = (): ModelCompletionResponse => ({
  id: 'seat-1',
  object: 'chat.completion',
  created: 0,
  modelId: MODEL,
  choices: [{ index: 0, message: { role: 'assistant', content: ANSWER }, finishReason: 'stop' }],
  usage: { ...CHAT_USAGE },
});

/** The abort chunk the provider contract ends an aborted stream with. */
const abortChunk = (): ModelCompletionResponse => ({
  id: 'seat-abort',
  object: 'chat.completion.chunk',
  created: 0,
  modelId: MODEL,
  choices: [],
  isFinal: true,
  error: { message: 'Request aborted', type: 'abort' },
});

/** Resolves once `signal` aborts. */
const abortOf = (signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    signal?.addEventListener('abort', () => resolve(), { once: true });
  });

const seatSurface: Surface = {
  name: 'a launched seat',
  streams: true,
  answerMicro: () => toMicro(costOfUsageUSD('openai', MODEL, CHAT_USAGE) as number),
  prepare(replies) {
    const queue = [...replies];
    let sent = 0;
    const operationIds: unknown[] = [];
    const next = (options: ModelCompletionOptions): Reply => {
      sent += 1;
      operationIds.push(options.operationId);
      const r = queue.shift();
      if (!r) throw new Error('a model call the test did not script');
      return r;
    };
    const provider = {
      providerId: 'openai',
      async generateCompletion(_modelId: string, _messages: ChatMessage[], options: ModelCompletionOptions): Promise<ModelCompletionResponse> {
        const r = next(options);
        if (r.kind === 'refused') throw refusal(r.status);
        if (r.kind === 'server_error') throw serverError(r.status);
        if (r.kind === 'timed_out') throw timeout();
        if (r.kind === 'held') await r.gate;
        return completion();
      },
      async *generateCompletionStream(_modelId: string, _messages: ChatMessage[], options: ModelCompletionOptions): AsyncGenerator<ModelCompletionResponse, void, undefined> {
        const r = next(options);
        if (r.kind === 'refused') throw refusal(r.status);
        if (r.kind === 'server_error') throw serverError(r.status);
        if (r.kind === 'timed_out') throw timeout();
        if (r.kind === 'cut') {
          yield { ...delta } as ModelCompletionResponse;
          await abortOf(options.abortSignal);
          yield abortChunk();
          return;
        }
        if (r.kind === 'held') await r.gate;
        yield { ...completion(), object: 'chat.completion.chunk', isFinal: true, responseTextDelta: ANSWER };
      },
    } as unknown as IProvider;
    const base = { getProvider: () => provider, getDefaultProvider: () => provider, getProviderForModel: () => provider } as unknown as AIModelProviderManager;
    const messages: ChatMessage[] = [{ role: 'user', content: PROMPT }];
    return {
      sent: () => sent,
      operationIds: () => operationIds,
      async call(budget, options) {
        const seat = meteredProviderManager(base, budget).getProvider('openai') as IProvider;
        if (!options?.abortAfterFirstText) return seat.generateCompletion(MODEL, messages, { maxTokens: MAX_TOKENS });
        const controller = new AbortController();
        for await (const chunk of seat.generateCompletionStream(MODEL, messages, { maxTokens: MAX_TOKENS, abortSignal: controller.signal })) {
          if (chunk.responseTextDelta) controller.abort();
          if (chunk.error) throw new Error(chunk.error.message);
        }
        return undefined;
      },
    };
  },
};

const SURFACES: Surface[] = [generateTextSurface, streamTextSurface, generateObjectSurface, embedTextSurface, agentSurface, gmiSurface, seatSurface];

/** SqlSpendMeter over SQLite, with an allowance a test can change and a resolver that defers until a test gives it evidence. */
interface MeterFixture {
  meter: SqlSpendMeter;
  /** The allowance, read at every reservation. */
  allowance: { units: number };
  /** What `resolveExpired` decides for an expired reservation: deferred until a test sets a decision here. */
  evidence: { decision?: SpendExpiryDecision };
  /** The account's units used and reserved this period. */
  figures(): Promise<{ used: number; reserved: number }>;
  close(): Promise<void>;
}

async function openMeter(): Promise<MeterFixture> {
  const db = await resolveStorageAdapter({ filePath: ':memory:', priority: ['better-sqlite3', 'sqljs'], quiet: true });
  const allowance = { units: 1_000_000 };
  const evidence: { decision?: SpendExpiryDecision } = {};
  const meter = new SqlSpendMeter({
    db,
    allowanceFor: () => allowance.units,
    periodOf: () => PERIOD,
    requireShared: false,
    resolveExpired: () => evidence.decision ?? { outcome: 'deferred', retryAt: Date.now() + 1_000 },
  });
  return {
    meter,
    allowance,
    evidence,
    async figures() {
      const { used, reserved } = await meter.snapshot(ACCOUNT);
      return { used, reserved };
    },
    close: () => db.close(),
  };
}

/**
 * A call whose outcome is not known stays reserved and counted, past its lease too, until the host's evidence settles
 * it: a reconcile with no evidence defers it, and one with the provider's usage for it consumes that.
 */
async function expectHeldUntilEvidence(fx: MeterFixture): Promise<void> {
  const held = await fx.figures();
  expect(held.reserved).toBeGreaterThan(EVIDENCE_UNITS);
  expect(held.used).toBe(0);
  const pastLease = Date.now() + 60_000;
  await fx.meter.reconcile({ now: pastLease });
  expect(await fx.figures()).toEqual(held);
  fx.evidence.decision = { outcome: 'consumed', units: EVIDENCE_UNITS };
  await fx.meter.reconcile({ now: pastLease + 60_000 });
  expect(await fx.figures()).toEqual({ used: EVIDENCE_UNITS, reserved: 0 });
}

beforeAll(() => {
  registerModelPricing('openai', (modelId) => (modelId === MODEL ? { inputPerMTokUSD: 1, outputPerMTokUSD: 10 } : undefined));
});

afterAll(() => {
  registerModelPricing('openai', () => undefined);
});

describe.each(SURFACES)('$name on a budget with a spend meter', (surface) => {
  let fx: MeterFixture;
  beforeEach(async () => {
    globalLLMProviderHealth.reset();
    fx = await openMeter();
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await fx.close();
  });
  const metered = (): SpendBudget => new SpendBudget({ maxCostUSD: Number.POSITIVE_INFINITY, meter: fx.meter, accountId: ACCOUNT });

  it('refuses a second call whose largest cost the allowance cannot hold beside the first in flight, before its provider is asked', async () => {
    const gate = opening();
    const { sent, call } = surface.prepare([{ kind: 'held', gate: gate.promise }, { kind: 'answer' }]);
    const budget = metered();
    const first = call(budget);
    first.catch(() => undefined);
    await vi.waitFor(async () => expect((await fx.figures()).reserved).toBeGreaterThan(0));
    const held = (await fx.figures()).reserved;
    // Room for the first call's reservation and half of another.
    fx.allowance.units = held + Math.floor(held / 2);
    await expect(call(budget)).rejects.toThrow(/allowance_exhausted/);
    expect(sent()).toBe(1);
    gate.open();
    await first;
    expect(await fx.figures()).toEqual({ used: surface.answerMicro(), reserved: 0 });
  });

  it('settles a finished call at what its usage cost and frees the rest of its reservation', async () => {
    const { sent, call } = surface.prepare([{ kind: 'answer' }]);
    await call(metered());
    expect(sent()).toBe(1);
    expect(surface.answerMicro()).toBeGreaterThan(0);
    expect(await fx.figures()).toEqual({ used: surface.answerMicro(), reserved: 0 });
  });

  it('frees the whole reservation when the provider refuses the request before any output', async () => {
    const { sent, call } = surface.prepare([{ kind: 'refused' }]);
    await expect(call(metered())).rejects.toBeDefined();
    expect(sent()).toBe(1);
    expect(await fx.figures()).toEqual({ used: 0, reserved: 0 });
  });

  // A rate limit and a refused model: the provider itself answered, so nothing ran.
  it.each([429, 403, 404])('frees the whole reservation when the provider answers %i before any output', async (status) => {
    const { sent, call } = surface.prepare([{ kind: 'refused', status }]);
    await expect(call(metered())).rejects.toBeDefined();
    expect(sent()).toBe(1);
    expect(await fx.figures()).toEqual({ used: 0, reserved: 0 });
  });

  // A 5xx does not show that nothing ran.
  it.each([500, 502, 503])('keeps a call the provider answered with a %i reserved and counted until a reconcile with evidence settles it', async (status) => {
    const { sent, call } = surface.prepare([{ kind: 'server_error', status }]);
    await expect(call(metered())).rejects.toBeDefined();
    expect(sent()).toBe(1);
    await expectHeldUntilEvidence(fx);
  });

  it('keeps a call that timed out after its request was sent reserved and counted until a reconcile with evidence settles it', async () => {
    const { sent, call } = surface.prepare([{ kind: 'timed_out' }]);
    await expect(call(metered())).rejects.toBeDefined();
    expect(sent()).toBe(1);
    await expectHeldUntilEvidence(fx);
  });

  it.runIf(surface.streams)('keeps a stream aborted after its request was sent reserved and counted until a reconcile with evidence settles it', async () => {
    const { sent, call } = surface.prepare([{ kind: 'cut' }]);
    await call(metered(), { abortAfterFirstText: true }).catch(() => undefined);
    expect(sent()).toBe(1);
    await expectHeldUntilEvidence(fx);
  });

  // embedText sends its own requests: its case reads the id from the header they carry.
  it('hands the provider the operation id its reservation is under', async () => {
    const { operationIds, call } = surface.prepare([{ kind: 'answer' }]);
    const reserve = vi.spyOn(fx.meter, 'reserve');
    await call(metered());
    const reserved = reserve.mock.calls.map(([request]) => request.operationId);
    expect(reserved).toHaveLength(1);
    expect(operationIds()).toEqual(reserved);
  });

  it('holds nothing for a budget without a meter, which checks and charges the call as before', async () => {
    const { sent, call } = surface.prepare([{ kind: 'answer' }]);
    const budget = new SpendBudget({ maxCostUSD: 1 });
    await call(budget);
    expect(sent()).toBe(1);
    expect(budget.spentUSD()).toBeCloseTo(surface.answerMicro() / 1_000_000, 9);
    expect(await fx.figures()).toEqual({ used: 0, reserved: 0 });
  });
});

/** `inner` with its `reserve` held until `gate` opens, so a test can act while a reservation is being made. */
function pausedMeter(inner: ISpendMeter, gate: Promise<void>, reserving: () => void): ISpendMeter {
  return {
    reserve: async (req: SpendReserveRequest) => {
      reserving();
      const answer = await inner.reserve(req);
      await gate;
      return answer;
    },
    settle: (req) => inner.settle(req),
    heartbeat: (operationId, now) => inner.heartbeat(operationId, now),
    reconcile: (opts) => inner.reconcile(opts),
    snapshot: (accountId, now) => inner.snapshot(accountId, now),
    setAllowance: (accountId, allowance, now) => inner.setAllowance(accountId, allowance, now),
  };
}

describe('a metered call around its reservation', () => {
  let fx: MeterFixture;
  beforeEach(async () => {
    globalLLMProviderHealth.reset();
    fx = await openMeter();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fx.close();
  });

  it('sends nothing when its signal aborts while its reservation is made, and frees the reservation', async () => {
    const k = key();
    const s = script('openai', k, { replies: stubReplies([{ kind: 'answer' }], false), whole: true });
    const gate = opening();
    const reserving = opening();
    let reservations = 0;
    const meter = pausedMeter(fx.meter, gate.promise, () => {
      reservations += 1;
      reserving.open();
    });
    const controller = new AbortController();
    const budget = new SpendBudget({ maxCostUSD: Number.POSITIVE_INFINITY, meter, accountId: ACCOUNT });
    const pending = generateText({
      provider: 'openai', model: MODEL, apiKey: k, prompt: PROMPT, maxTokens: MAX_TOKENS, budget, fallbackProviders: [], abortSignal: controller.signal,
    });
    await Promise.race([reserving.promise, pending.catch(() => undefined)]);
    controller.abort();
    gate.open();
    await expect(pending).rejects.toBeDefined();
    expect(reservations).toBe(1);
    expect(s.seen).toHaveLength(0);
    expect(await fx.figures()).toEqual({ used: 0, reserved: 0 });
  });

  it("refuses a call whose meter cannot answer without sending it, counting it against the provider's health or walking to a fallback", async () => {
    const k = key();
    const s = script('openai', k, { replies: stubReplies([{ kind: 'answer' }, { kind: 'answer' }], false), whole: true });
    const unavailable = new SpendMeterUnavailableError('the store did not answer');
    const meter: ISpendMeter = { ...pausedMeter(fx.meter, Promise.resolve(), () => undefined), reserve: async () => Promise.reject(unavailable) };
    const recordFailure = vi.spyOn(globalLLMProviderHealth, 'recordFailure');
    const onFallback = vi.fn();
    const budget = new SpendBudget({ maxCostUSD: Number.POSITIVE_INFINITY, meter, accountId: ACCOUNT });
    await expect(
      generateText({ provider: 'openai', model: MODEL, apiKey: k, prompt: PROMPT, maxTokens: MAX_TOKENS, budget, fallbackProviders: [{ provider: 'openai', model: MODEL }], onFallback }),
    ).rejects.toBe(unavailable);
    expect(s.seen).toHaveLength(0);
    expect(recordFailure).not.toHaveBeenCalled();
    expect(onFallback).not.toHaveBeenCalled();
  });
});
