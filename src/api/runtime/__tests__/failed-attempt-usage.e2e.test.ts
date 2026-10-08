/**
 * @file failed-attempt-usage.e2e.test.ts
 * A refused Claude turn is billed. Its usage rides on the content-policy
 * error the provider throws, and it must be metered once: in the call's
 * usage, as its own usage event and as its own usage-ledger row, beside the
 * fallback leg's. The outer call must not write the leg's usage to the ledger
 * a second time. A GMI turn through the completion gateway counts it once in
 * the turn's usage and reports it on its own USAGE_UPDATE.
 *
 * Runs generateText, streamText and a GMI turn against the real
 * AnthropicProvider with only fetch stubbed; the stub answers per model, so
 * the fallback hop gets its own reply.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { generateText } from '../../generateText.js';
import { streamText } from '../../streamText.js';
import { setGlobalLlmObserver, type LlmUsageEvent } from '../../observers.js';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';
import { createCompletionGateway } from '../completionGateway.js';
import { GMIOutputChunkType } from '../../../cognition/substrate/IGMI.js';
import { createScriptedGmi, runTurn, textTurn as userTurn } from '../../../cognition/substrate/__tests__/helpers/scriptedGmi.js';

type Json = Record<string, any>;
type Reply = () => Response;

function sse(events: unknown[]): Response {
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function messageStart(model: string, inputTokens: number): Json {
  return {
    type: 'message_start',
    message: {
      id: `msg_${model}`, type: 'message', role: 'assistant', content: [], model,
      stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 1 },
    },
  };
}

function textTurn(model: string, text: string): Reply {
  return () =>
    sse([
      messageStart(model, 10),
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ]);
}

/** A turn Claude refuses before writing anything: 12 input and 4 output tokens billed. */
function refusalTurn(model: string): Reply {
  return () =>
    sse([
      messageStart(model, 12),
      {
        type: 'message_delta',
        delta: { stop_reason: 'refusal', stop_sequence: null, stop_details: { type: 'refusal', category: 'example' } },
        usage: { output_tokens: 4 },
      },
      { type: 'message_stop' },
    ]);
}

/**
 * A turn that reports usage in an interim message_delta (12 in, 2 out) and
 * then refuses, reporting the request's cumulative 12 in, 4 out.
 */
function refusalAfterInterimUsage(model: string): Reply {
  return () =>
    sse([
      messageStart(model, 12),
      { type: 'message_delta', delta: { stop_reason: null, stop_sequence: null }, usage: { output_tokens: 2 } },
      {
        type: 'message_delta',
        delta: { stop_reason: 'refusal', stop_sequence: null, stop_details: { type: 'refusal', category: 'example' } },
        usage: { output_tokens: 4 },
      },
      { type: 'message_stop' },
    ]);
}

function route(replies: Record<string, Reply[]>): void {
  fetchMock.mockImplementation(async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as Json;
    const next = replies[String(body.model)]?.shift();
    if (!next) throw new Error(`unexpected request for model ${String(body.model)}`);
    return next();
  });
}

const savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
const savedOpenRouterKey = process.env.OPENROUTER_API_KEY;
let ledgerDir: string;
let ledgerPath: string;
let events: LlmUsageEvent[];

beforeAll(() => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-usage-test';
  delete process.env.OPENROUTER_API_KEY;
});

afterAll(() => {
  if (savedAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
  if (savedOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = savedOpenRouterKey;
});

beforeEach(() => {
  fetchMock.mockReset();
  globalLLMProviderHealth.reset();
  ledgerDir = mkdtempSync(join(tmpdir(), 'agentos-usage-'));
  ledgerPath = join(ledgerDir, 'ledger.jsonl');
  events = [];
  setGlobalLlmObserver((event) => {
    events.push(event);
  });
});

afterEach(() => {
  setGlobalLlmObserver(null);
  rmSync(ledgerDir, { recursive: true, force: true });
});

/** Ledger rows as [model, promptTokens, completionTokens], sorted by model. */
function ledgerRows(): Array<[string, number, number]> {
  return readFileSync(ledgerPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Json)
    .map((row): [string, number, number] => [row.modelId, row.promptTokens, row.completionTokens])
    .sort((a, b) => a[0].localeCompare(b[0]));
}

describe('usage of a refused attempt', () => {
  it('generateText meters the refusal once and the fallback leg once', async () => {
    route({
      'claude-opus-5-5': [refusalTurn('claude-opus-5-5')],
      'claude-opus-4-8': [textTurn('claude-opus-4-8', 'Recovered.')],
    });

    const result = await generateText({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      prompt: 'Hello?',
      usageLedger: { path: ledgerPath },
      fallbackProviders: [{ provider: 'anthropic', model: 'claude-opus-4-8' }],
    });

    expect(result.text).toBe('Recovered.');
    expect(result.usage).toMatchObject({ promptTokens: 22, completionTokens: 7 });
    expect(events.map((e) => [e.model, e.finishReason, e.usage.promptTokens])).toEqual([
      ['claude-opus-5-5', 'error', 12],
      ['claude-opus-4-8', 'stop', 10],
    ]);
    expect(ledgerRows()).toEqual([
      ['claude-opus-4-8', 10, 3],
      ['claude-opus-5-5', 12, 4],
    ]);
  });

  it('generateText meters a refusal that ends the call', async () => {
    route({ 'claude-opus-5-5': [refusalTurn('claude-opus-5-5')] });

    await expect(
      generateText({
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        prompt: 'Hello?',
        usageLedger: { path: ledgerPath },
        fallbackProviders: [],
      }),
    ).rejects.toThrow();

    expect(events.map((e) => [e.model, e.finishReason, e.usage.completionTokens])).toEqual([
      ['claude-opus-5-5', 'error', 4],
    ]);
    expect(ledgerRows()).toEqual([['claude-opus-5-5', 12, 4]]);
  });

  it('streamText counts a refusal once when the step already reported part of its usage', async () => {
    route({ 'claude-opus-5-5': [refusalAfterInterimUsage('claude-opus-5-5')] });

    const result = streamText({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      prompt: 'Hello?',
      usageLedger: { path: ledgerPath },
      fallbackProviders: [],
    });
    for await (const _part of result.fullStream) {
      // drain
    }

    expect(await result.usage).toMatchObject({ promptTokens: 12, completionTokens: 4 });
    expect(ledgerRows()).toEqual([['claude-opus-5-5', 12, 4]]);
  });

  it('streamText meters the refusal once and the fallback leg once', async () => {
    route({
      'claude-opus-5-5': [refusalTurn('claude-opus-5-5')],
      'claude-opus-4-8': [textTurn('claude-opus-4-8', 'Recovered.')],
    });

    const result = streamText({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      prompt: 'Hello?',
      usageLedger: { path: ledgerPath },
      fallbackProviders: [{ provider: 'anthropic', model: 'claude-opus-4-8' }],
    });
    for await (const _part of result.fullStream) {
      // drain
    }

    expect(await result.text).toBe('Recovered.');
    expect(await result.usage).toMatchObject({ promptTokens: 22, completionTokens: 7 });
    expect(events.map((e) => [e.model, e.finishReason, e.usage.promptTokens]).sort()).toEqual([
      ['claude-opus-4-8', 'stop', 10],
      ['claude-opus-5-5', 'error', 12],
    ]);
    expect(ledgerRows()).toEqual([
      ['claude-opus-4-8', 10, 3],
      ['claude-opus-5-5', 12, 4],
    ]);
  });
});

describe('usage of a refused attempt in a GMI turn', () => {
  it('a GMI turn through the completion gateway counts the refusal once and reports it on its own USAGE_UPDATE', async () => {
    route({
      'claude-opus-5-5': [refusalTurn('claude-opus-5-5')],
      'claude-opus-4-8': [textTurn('claude-opus-4-8', 'Recovered.')],
    });
    const gateway = createCompletionGateway({ fallbackProviders: [{ provider: 'anthropic', model: 'claude-opus-4-8' }] });
    const { gmi } = await createScriptedGmi({ gateway, persona: { defaultProviderId: 'anthropic', defaultModelId: 'claude-opus-5-5' } });

    const { chunks, output } = await runTurn(gmi, userTurn('t1', 'Hello?'));

    expect(chunks.filter((c) => c.type === GMIOutputChunkType.TEXT_DELTA).map((c) => c.content)).toEqual(['Recovered.']);
    expect(chunks.find((c) => c.type === GMIOutputChunkType.STEP_FINISHED)?.content).toMatchObject({
      hop: 1,
      providerId: 'anthropic',
      modelId: 'claude-opus-4-8',
      usage: { promptTokens: 10, completionTokens: 3 },
    });
    const refused = chunks.filter((c) => c.type === GMIOutputChunkType.USAGE_UPDATE && c.metadata?.attemptFailed === true);
    expect(refused.map((c) => [c.content.promptTokens, c.content.completionTokens, c.metadata])).toEqual([
      [12, 4, { attemptFailed: true, hop: 0, providerId: 'anthropic', modelId: 'claude-opus-5-5' }],
    ]);
    expect(output.usage).toMatchObject({ promptTokens: 22, completionTokens: 7, totalTokens: 29 });
  });
});
