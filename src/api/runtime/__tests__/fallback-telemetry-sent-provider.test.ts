/**
 * @file fallback-telemetry-sent-provider.test.ts
 * What both failover walkers report about a fallback entry whose model id
 * carries another provider's prefix (`{ provider: 'anthropic', model:
 * 'openrouter:anthropic/claude-sonnet-4.5' }`): the leg is sent to OpenRouter,
 * so `onFallback`, the `llm.fallback_fired` line and the leg's hop in
 * `result.fallback.hops` name OpenRouter and the model id after the prefix,
 * not the provider the entry says. An entry without a prefix is reported as
 * written. The real model resolution runs; the provider resolution echoes and
 * only the provider transport is stubbed. A host logger factory set with
 * `setLoggerFactory` records every line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const generateCompletionStream = vi.fn();
  const generateCompletion = vi.fn();
  const getProvider = vi.fn(() => ({ generateCompletionStream, generateCompletion }));
  const createProviderManager = vi.fn(async () => ({ getProvider }));
  const lines: Array<{ level: string; message: unknown; meta: unknown }> = [];
  return { generateCompletionStream, generateCompletion, createProviderManager, lines };
});

vi.mock('../../model.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../model.js')>();
  return {
    resolveModelOption: actual.resolveModelOption,
    resolveProvider: vi.fn((providerId: string, modelId: string) => ({ providerId, modelId, apiKey: 'test-key' })),
    createProviderManager: hoisted.createProviderManager,
  };
});

import { setLoggerFactory, resetLoggerFactory } from '../../../core/logging/loggerFactory.js';
import { generateText } from '../../generateText.js';
import { streamText } from '../../streamText.js';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';

const PRIMARY_MODEL = 'gpt-4o-mini';
const PREFIXED = { provider: 'anthropic', model: 'openrouter:anthropic/claude-sonnet-4.5' };
const SENT_MODEL = 'anthropic/claude-sonnet-4.5';
const PLAIN = { provider: 'anthropic', model: 'claude-x' };
const RESCUE = { provider: 'gemini', model: 'gemini-x' };

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const status = (code: number, message = 'failed') => Object.assign(new Error(`[${code}] ${message}`), { httpStatus: code });
const reply = (modelId: string, content: string) => ({
  modelId,
  usage,
  choices: [{ message: { role: 'assistant', content }, finishReason: 'stop' }],
});
const textChunk = (modelId: string, text: string) => ({
  id: 'chunk',
  object: 'chat.completion.chunk',
  created: 1,
  modelId,
  choices: [{ index: 0, message: { role: 'assistant', content: text }, finishReason: 'stop' }],
  responseTextDelta: text,
  isFinal: true,
  usage,
});

/** Every line any logger writes, with its fields: an event handle writes `(event, fields)`. */
const makeLogger = (): unknown => {
  const write = (level: string) => (message: unknown, meta?: unknown) => {
    hoisted.lines.push({ level, message, meta });
  };
  return { info: write('info'), warn: write('warn'), error: write('error'), debug: write('debug'), child: () => makeLogger() };
};
/** The fields of every `llm.fallback_fired` line, in order. */
const firedLines = (): Array<Record<string, unknown>> =>
  hoisted.lines.filter((l) => l.message === 'llm.fallback_fired').map((l) => l.meta as Record<string, unknown>);

/** The primary answers 503; each model id in `legs` answers as given: a status code fails, a string serves. */
function completions(legs: Record<string, number | string>): void {
  hoisted.generateCompletion.mockImplementation(async (modelId: string) => {
    if (modelId === PRIMARY_MODEL) throw status(503);
    const leg = legs[modelId];
    if (typeof leg === 'number') throw status(leg, 'invalid_request_error: bad parameter');
    if (typeof leg === 'string') return reply(modelId, leg);
    throw new Error(`unexpected model ${modelId}`);
  });
}

function streams(legs: Record<string, number | string>): void {
  hoisted.generateCompletionStream.mockImplementation(async function* (modelId: string) {
    if (modelId === PRIMARY_MODEL) throw status(503);
    const leg = legs[modelId];
    if (typeof leg === 'number') throw status(leg, 'invalid_request_error: bad parameter');
    if (typeof leg === 'string') {
      yield textChunk(modelId, leg);
      return;
    }
    throw new Error(`unexpected model ${modelId}`);
  });
}

beforeEach(() => {
  hoisted.generateCompletion.mockReset();
  hoisted.generateCompletionStream.mockReset();
  hoisted.lines.length = 0;
  globalLLMProviderHealth.reset();
  setLoggerFactory(() => makeLogger() as never);
});

afterEach(() => {
  resetLoggerFactory();
});

describe('generateText reports a prefixed fallback entry as the provider and model it is sent to', () => {
  it('onFallback receives openrouter, and llm.fallback_fired names openrouter and the model id after the prefix', async () => {
    completions({ [SENT_MODEL]: 'served' });
    const onFallback = vi.fn();
    const result = await generateText({
      provider: 'openai',
      model: PRIMARY_MODEL,
      prompt: 'hi',
      fallbackProviders: [PREFIXED],
      onFallback,
    });

    expect(result.text).toBe('served');
    expect(hoisted.generateCompletion.mock.calls.map((c) => c[0])).toEqual([PRIMARY_MODEL, SENT_MODEL]);
    expect(onFallback.mock.calls.map(([, provider]) => provider)).toEqual(['openrouter']);
    expect(firedLines()).toEqual([
      expect.objectContaining({ primaryProvider: 'openai', fallbackProvider: 'openrouter', fallbackModel: SENT_MODEL }),
    ]);
  });

  it("names the failed leg's hop in result.fallback.hops by the provider and model it was sent as", async () => {
    completions({ [SENT_MODEL]: 400, [RESCUE.model]: 'rescued' });
    const result = await generateText({
      provider: 'openai',
      model: PRIMARY_MODEL,
      prompt: 'hi',
      fallbackProviders: [PREFIXED, RESCUE],
    });

    expect(result.text).toBe('rescued');
    expect(result.fallback?.hops).toEqual([
      { provider: 'openai', model: PRIMARY_MODEL, ok: false },
      { provider: 'openrouter', model: SENT_MODEL, ok: false },
      { provider: 'gemini', model: RESCUE.model, ok: true },
    ]);
  });

  it('reports an entry without a prefix as written', async () => {
    completions({ [PLAIN.model]: 400, [RESCUE.model]: 'rescued' });
    const onFallback = vi.fn();
    const result = await generateText({
      provider: 'openai',
      model: PRIMARY_MODEL,
      prompt: 'hi',
      fallbackProviders: [PLAIN, RESCUE],
      onFallback,
    });

    expect(result.text).toBe('rescued');
    expect(onFallback.mock.calls.map(([, provider]) => provider)).toEqual(['anthropic', 'gemini']);
    expect(firedLines()).toEqual([
      expect.objectContaining({ fallbackProvider: 'anthropic', fallbackModel: PLAIN.model }),
      expect.objectContaining({ fallbackProvider: 'gemini', fallbackModel: RESCUE.model }),
    ]);
    expect(result.fallback?.hops).toEqual([
      { provider: 'openai', model: PRIMARY_MODEL, ok: false },
      { provider: 'anthropic', model: PLAIN.model, ok: false },
      { provider: 'gemini', model: RESCUE.model, ok: true },
    ]);
  });
});

describe('streamText reports a prefixed fallback entry as the provider and model it is sent to', () => {
  it('onFallback receives openrouter, and llm.fallback_fired names openrouter and the model id after the prefix', async () => {
    streams({ [SENT_MODEL]: 'served' });
    const onFallback = vi.fn();
    const r = streamText({
      provider: 'openai',
      model: PRIMARY_MODEL,
      prompt: 'hi',
      fallbackProviders: [PREFIXED],
      onFallback,
    });
    for await (const _part of r.fullStream) { /* drain */ }

    expect(await r.text).toBe('served');
    expect(hoisted.generateCompletionStream.mock.calls.map((c) => c[0])).toEqual([PRIMARY_MODEL, SENT_MODEL]);
    expect(onFallback.mock.calls.map(([, provider]) => provider)).toEqual(['openrouter']);
    expect(firedLines()).toEqual([
      expect.objectContaining({ primaryProvider: 'openai', fallbackProvider: 'openrouter', fallbackModel: SENT_MODEL }),
    ]);
    expect((await r.fallback)?.hops).toEqual([
      { provider: 'openai', model: PRIMARY_MODEL, ok: false },
      { provider: 'openrouter', model: SENT_MODEL, ok: true },
    ]);
    expect(hoisted.lines.find((l) => l.message === 'llm.fallback_succeeded')?.meta).toMatchObject({ fallbackProvider: 'openrouter' });
  });

  it('reports an entry without a prefix as written', async () => {
    streams({ [PLAIN.model]: 'served' });
    const onFallback = vi.fn();
    const r = streamText({
      provider: 'openai',
      model: PRIMARY_MODEL,
      prompt: 'hi',
      fallbackProviders: [PLAIN],
      onFallback,
    });
    for await (const _part of r.fullStream) { /* drain */ }

    expect(await r.text).toBe('served');
    expect(onFallback.mock.calls.map(([, provider]) => provider)).toEqual(['anthropic']);
    expect(firedLines()).toEqual([
      expect.objectContaining({ fallbackProvider: 'anthropic', fallbackModel: PLAIN.model }),
    ]);
  });
});
