/**
 * @file agentos-spend-meter.e2e.test.ts
 * The spend meter on the real runtime with an OpenAI provider stub: a turn reserves before the provider is called,
 * a refusal or a meter that cannot answer ends the request with no provider call, the turn settles its reservation
 * when it ends (consumed, released on an error before any output, consumed after output even when the caller stopped
 * reading), a retry with the same operation id charges once, and a reply an output guardrail blocks is refunded.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const provider = vi.hoisted(() => ({
  calls: 0,
  // a promise in a reply holds the provider's stream there until it resolves
  replies: [] as Array<Array<Record<string, unknown> | Promise<void>>>,
}));

vi.mock('../../core/llm/providers/implementations/OpenAIProvider', () => {
  class OpenAIProvider {
    readonly providerId = 'openai';
    isInitialized = false;
    async initialize() { this.isInitialized = true; }
    async generateCompletion() { return { choices: [{ message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }], responseText: 'ok' }; }
    async *generateCompletionStream() {
      provider.calls += 1;
      for (const part of provider.replies.shift() ?? []) {
        if (part instanceof Promise) await part;
        else yield part;
      }
    }
    async generateEmbeddings() { return { embeddings: [] }; }
    async listAvailableModels() { return []; }
    async getModelInfo() { return undefined; }
    async checkHealth() { return { isHealthy: true }; }
    async shutdown() {}
  }
  return { OpenAIProvider };
});

import { metrics } from '@opentelemetry/api';
import { resolveStorageAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { AgentOS } from '../AgentOS';
import { AgentOSResponseChunkType } from '../types/AgentOSResponse';
import type { IPersonaDefinition } from '../../cognition/substrate/personas/IPersonaDefinition';
import { GMIErrorCode } from '../../core/utils/errors.js';
import { GuardrailAction, type IGuardrailService } from '../../safety/guardrails/IGuardrailService';
import { StreamingManager } from '../../core/streaming/StreamingManager';
import { SqlSpendMeter } from '../../safety/runtime/SqlSpendMeter';
import { SpendMeterUnavailableError, type ISpendMeter } from '../../safety/runtime/SpendMeter';

const persona = {
  id: 'metered', name: 'Metered', description: 'A persona whose turns are metered.',
  version: '1.0.0', baseSystemPrompt: 'You are terse.',
} as unknown as IPersonaDefinition;

const reply = (text: string) => [
  { responseTextDelta: text },
  { isFinal: true, choices: [{ message: { role: 'assistant', content: text }, finishReason: 'stop' }], usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } },
];

async function boot(spendMeter: { meter: ISpendMeter }, extra: Record<string, unknown> = {}): Promise<AgentOS> {
  return AgentOS.create({
    modelProviderManagerConfig: { providers: [{ providerId: 'openai', enabled: true, isDefault: true, config: { apiKey: 'test' } }] },
    turnPlanning: { enabled: false },
    personas: [persona],
    spendMeter,
    ...extra,
  } as any);
}

async function collect(agentos: AgentOS, input: { operationId?: string; sessionId?: string }, stopAfterFirstDelta = false): Promise<any[]> {
  const chunks: any[] = [];
  for await (const chunk of agentos.processRequest({ userId: 'person-1', sessionId: input.sessionId ?? 's-metered', selectedPersonaId: 'metered', textInput: 'Plan my week.', operationId: input.operationId } as any)) {
    chunks.push(chunk);
    if (stopAfterFirstDelta && chunk.type === AgentOSResponseChunkType.TEXT_DELTA) break;
  }
  return chunks;
}

const errorOf = (chunks: any[]) => chunks.find((c) => c.type === AgentOSResponseChunkType.ERROR);

describe('the spend meter on processRequest', () => {
  let booted: AgentOS | undefined;
  let db: StorageAdapter | undefined;
  afterEach(async () => {
    if (booted) await booted.shutdown();
    booted = undefined;
    await db?.close();
    db = undefined;
    provider.replies.length = 0;
    provider.calls = 0;
    vi.restoreAllMocks();
  });

  async function sqlMeter(allowance: number): Promise<SqlSpendMeter> {
    db = await resolveStorageAdapter({ filePath: ':memory:', priority: ['better-sqlite3', 'sqljs'], quiet: true });
    return new SqlSpendMeter({ db, allowanceFor: () => allowance, periodOf: (now) => new Date(now).toISOString().slice(0, 7), requireShared: false });
  }

  it('settles before the public stream ends, with repeated reads, charges and refunds applied once', async () => {
    const meter = await sqlMeter(5);
    const settle = meter.settle.bind(meter);
    // Model an asynchronous store: completion must wait for its write, not just start it.
    vi.spyOn(meter, 'settle').mockImplementation(async (request) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      return settle(request);
    });
    booted = await boot({ meter });
    provider.replies.push(reply('Done.'));
    const chunks = await collect(booted, { operationId: 'op-completion' });
    expect(chunks.some((c) => c.type === AgentOSResponseChunkType.FINAL_RESPONSE)).toBe(true);
    expect(await meter.snapshot('person-1')).toMatchObject({ used: 1, reserved: 0, remaining: 4 });
    expect(await meter.snapshot('person-1')).toMatchObject({ used: 1, reserved: 0, remaining: 4 });
    expect(await meter.settle({ operationId: 'op-completion', outcome: 'consumed' })).toMatchObject({ status: 'already_settled' });
    expect(await meter.snapshot('person-1')).toMatchObject({ used: 1, reserved: 0 });
    await meter.settle({ operationId: 'op-completion', outcome: 'replaced' });
    expect(await meter.snapshot('person-1')).toMatchObject({ used: 0, reserved: 0, remaining: 5 });
    expect(await meter.settle({ operationId: 'op-completion', outcome: 'replaced' })).toMatchObject({ status: 'already_settled' });
    expect(await meter.snapshot('person-1')).toMatchObject({ used: 0, reserved: 0, remaining: 5 });
  });

  it('counts a finished turn, then refuses the next with ALLOWANCE_EXHAUSTED before any provider call', async () => {
    const meter = await sqlMeter(1);
    booted = await boot({ meter });
    provider.replies.push(reply('Monday: chapter 2.'));
    const first = await collect(booted, { operationId: 'op-1' });
    expect(first.some((c) => c.type === AgentOSResponseChunkType.FINAL_RESPONSE)).toBe(true);
    expect(await meter.snapshot('person-1')).toMatchObject({ used: 1, reserved: 0 });
    const second = await collect(booted, { operationId: 'op-2', sessionId: 's-metered-2' });
    expect(errorOf(second)?.code).toBe(GMIErrorCode.ALLOWANCE_EXHAUSTED);
    expect(errorOf(second)?.details).toMatchObject({ reason: 'allowance_exhausted', remaining: 0 });
    expect(provider.calls).toBe(1);
  });

  it('charges a retry with the same operation id once', async () => {
    const meter = await sqlMeter(5);
    booted = await boot({ meter });
    provider.replies.push(reply('Done.'));
    await collect(booted, { operationId: 'op-same' });
    expect(await meter.snapshot('person-1')).toMatchObject({ used: 1, reserved: 0 });
    const again = await collect(booted, { operationId: 'op-same', sessionId: 's-metered-retry' });
    expect(errorOf(again)?.code).toBe(GMIErrorCode.ALREADY_EXISTS);
    expect(provider.calls).toBe(1);
    expect(await meter.snapshot('person-1')).toMatchObject({ used: 1, reserved: 0 });
  });

  it('refuses a request without an operation id, and fails closed when the meter cannot answer', async () => {
    const meter = await sqlMeter(5);
    booted = await boot({ meter });
    expect(errorOf(await collect(booted, {}))?.code).toBe(GMIErrorCode.VALIDATION_ERROR);
    await booted.shutdown();
    const down: ISpendMeter = {
      reserve: () => Promise.reject(new SpendMeterUnavailableError('the store did not answer')),
      settle: () => Promise.reject(new Error('unused')),
      heartbeat: async () => undefined,
      reconcile: async () => ({ consumed: 0, released: 0, pending: 0 }),
      snapshot: () => Promise.reject(new Error('unused')),
      setAllowance: async () => undefined,
    };
    booted = await boot({ meter: down });
    const refused = await collect(booted, { operationId: 'op-down' });
    expect(errorOf(refused)?.code).toBe(GMIErrorCode.SPEND_METER_UNAVAILABLE);
    expect(provider.calls).toBe(0);
  });

  it('releases a turn that failed before any output', async () => {
    const meter = await sqlMeter(5);
    booted = await boot({ meter });
    provider.replies.push([{ isFinal: true, choices: [], error: { message: 'rate limited', type: 'rate_limit' } }]);
    const chunks = await collect(booted, { operationId: 'op-error' });
    expect(errorOf(chunks)?.code).toBe(GMIErrorCode.LLM_PROVIDER_ERROR);
    const row = await db!.get<{ state: string }>('SELECT state FROM agentos_spend_reservations WHERE operation_id = ?', ['op-error']);
    expect(row?.state).toBe('released');
    expect(await meter.snapshot('person-1')).toMatchObject({ used: 0, reserved: 0 });
  });

  it('ends a failed turn with its own error alone when the host meter provider cannot record the turn', async () => {
    const meter = await sqlMeter(5);
    vi.spyOn(metrics, 'getMeter').mockImplementation(() => {
      throw new Error('the host meter provider failed');
    });
    // every client of the stream receives what the runtime pushes to it, a host's own stream client as well as this one
    const pushed = vi.spyOn(StreamingManager.prototype, 'pushChunk');
    booted = await boot({ meter }, { observability: { metrics: { enabled: true, meterName: 'agentos-spend-meter-e2e' } } });
    provider.replies.push([{ isFinal: true, choices: [], error: { message: 'rate limited', type: 'rate_limit' } }]);
    const chunks = await collect(booted, { operationId: 'op-metrics-down' });
    expect(errorOf(chunks)?.code).toBe(GMIErrorCode.LLM_PROVIDER_ERROR);
    const internalErrors = (list: any[]) => list.filter((c) => c.type === AgentOSResponseChunkType.ERROR && c.code === GMIErrorCode.INTERNAL_SERVER_ERROR);
    expect(internalErrors(chunks)).toEqual([]);
    expect(internalErrors(pushed.mock.calls.map(([, chunk]) => chunk))).toEqual([]);
    expect(await meter.snapshot('person-1')).toMatchObject({ used: 0, reserved: 0 });
  });

  it('settles a turn whose caller stopped reading after the first words', async () => {
    const meter = await sqlMeter(5);
    booted = await boot({ meter });
    provider.replies.push([
      { responseTextDelta: 'Mon' },
      { responseTextDelta: 'day.' },
      { isFinal: true, choices: [{ message: { role: 'assistant', content: 'Monday.' }, finishReason: 'stop' }] },
    ]);
    const chunks = await collect(booted, { operationId: 'op-abandoned' }, true);
    expect(chunks.at(-1)?.type).toBe(AgentOSResponseChunkType.TEXT_DELTA);
    await vi.waitFor(async () => expect(await meter.snapshot('person-1')).toMatchObject({ used: 1, reserved: 0 }));
  });

  it('refunds a reply an output guardrail blocked', async () => {
    const meter = await sqlMeter(5);
    const gate: IGuardrailService = {
      config: { evaluateStreamingChunks: false },
      evaluateOutput: async ({ chunk }) =>
        chunk.type === AgentOSResponseChunkType.FINAL_RESPONSE ? { action: GuardrailAction.BLOCK, reason: 'the reply crossed a rule', reasonCode: 'NEVER_DO' } : null,
    };
    booted = await boot({ meter }, { guardrailService: gate });
    provider.replies.push(reply('You will pass for sure.'));
    const chunks = await collect(booted, { operationId: 'op-blocked' });
    expect(errorOf(chunks)?.code).toBe('NEVER_DO');
    const row = await db!.get<{ state: string; outcome: string }>('SELECT state, outcome FROM agentos_spend_reservations WHERE operation_id = ?', ['op-blocked']);
    expect(row).toMatchObject({ state: 'released', outcome: 'replaced' });
    expect(await meter.snapshot('person-1')).toMatchObject({ used: 0, reserved: 0, remaining: 5 });
    await meter.settle({ operationId: 'op-blocked', outcome: 'replaced' });
    expect(await meter.snapshot('person-1')).toMatchObject({ used: 0, reserved: 0, remaining: 5 });
  });

  it('ends the stream at a block on a streamed reply, refunded, while the turn still runs', async () => {
    const meter = await sqlMeter(5);
    const settle = vi.spyOn(meter, 'settle');
    const gate: IGuardrailService = {
      config: { evaluateStreamingChunks: true },
      evaluateOutput: async ({ chunk }) =>
        chunk.type === AgentOSResponseChunkType.TEXT_DELTA ? { action: GuardrailAction.BLOCK, reason: 'the reply crossed a rule', reasonCode: 'NEVER_DO' } : null,
    };
    booted = await boot({ meter }, { guardrailService: gate });
    let finishReply!: () => void;
    const rest = new Promise<void>((resolve) => { finishReply = resolve; });
    provider.replies.push([{ responseTextDelta: 'You will' }, rest, ...reply(' pass for sure.')]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let chunks: any[] = [];
    try {
      chunks = await Promise.race([
        collect(booted, { operationId: 'op-streamed-block' }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('the stream waited for the rest of the turn the guardrail blocked')), 2_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    expect(errorOf(chunks)?.code).toBe('NEVER_DO');
    expect(await meter.snapshot('person-1')).toMatchObject({ used: 0, reserved: 0, remaining: 5 });
    // the turn goes on inside the runtime: its own settle, when it ends, finds the refund in place
    finishReply();
    await vi.waitFor(() => expect(settle.mock.calls.some(([request]) => request.outcome === 'consumed')).toBe(true));
    const turnSettle = settle.mock.results[settle.mock.calls.findIndex(([request]) => request.outcome === 'consumed')];
    await expect(turnSettle?.value).resolves.toMatchObject({ status: 'already_settled', state: 'released' });
    expect(await meter.snapshot('person-1')).toMatchObject({ used: 0, reserved: 0, remaining: 5 });
  });

  it('refunds a blocked reply again when the turn counted it between the refund read and its write', async () => {
    const meter = await sqlMeter(5);
    const settle = meter.settle.bind(meter);
    let raced = false;
    // a store with concurrent writers: the turn's own consumed settle commits after the refund read the row reserved
    vi.spyOn(meter, 'settle').mockImplementation(async (request) => {
      if (request.outcome === 'replaced' && !raced) {
        raced = true;
        await settle({ operationId: request.operationId, outcome: 'consumed' });
        return { status: 'already_settled', state: 'consumed' };
      }
      return settle(request);
    });
    const gate: IGuardrailService = {
      config: { evaluateStreamingChunks: false },
      evaluateOutput: async ({ chunk }) =>
        chunk.type === AgentOSResponseChunkType.FINAL_RESPONSE ? { action: GuardrailAction.BLOCK, reason: 'the reply crossed a rule', reasonCode: 'NEVER_DO' } : null,
    };
    booted = await boot({ meter }, { guardrailService: gate });
    provider.replies.push(reply('You will pass for sure.'));
    const chunks = await collect(booted, { operationId: 'op-blocked-race' });
    expect(errorOf(chunks)?.code).toBe('NEVER_DO');
    expect(raced).toBe(true);
    const row = await db!.get<{ state: string; outcome: string }>('SELECT state, outcome FROM agentos_spend_reservations WHERE operation_id = ?', ['op-blocked-race']);
    expect(row).toMatchObject({ state: 'released', outcome: 'replaced' });
    expect(await meter.snapshot('person-1')).toMatchObject({ used: 0, reserved: 0, remaining: 5 });
  });
});
