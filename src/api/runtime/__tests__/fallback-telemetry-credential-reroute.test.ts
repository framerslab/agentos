/**
 * @file fallback-telemetry-credential-reroute.test.ts
 * What both failover walkers report about a fallback entry the credential
 * layer sends to another provider: `{ provider: 'anthropic', model:
 * 'claude-sonnet-4-5' }` with no Anthropic key or base URL and
 * `OPENROUTER_API_KEY` set goes to OpenRouter as `anthropic/claude-sonnet-4-5`
 * (`resolveProvider()`). `onFallback`, the `llm.fallback_fired`,
 * `llm.fallback_succeeded`, `llm.fallback_failed_after_output` and
 * `llm.fallback_skipped` lines, the leg's hop and the walker's breaker read
 * all name OpenRouter and that model id. An entry the credential layer does
 * not move (an Anthropic key set, or the entry's own key) is reported as
 * written, and a skipped entry names the provider and model it would have
 * been sent as.
 *
 * The real model and credential resolution run against a stubbed
 * environment; only the provider transport is stubbed. A host logger factory
 * set with `setLoggerFactory` records every line.
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
  return { ...actual, createProviderManager: hoisted.createProviderManager };
});

import { setLoggerFactory, resetLoggerFactory } from '../../../core/logging/loggerFactory.js';
import { generateText } from '../../generateText.js';
import { streamText } from '../../streamText.js';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';
import { clearDefaultProvider } from '../global-default.js';
import { PROVIDER_DEFAULTS } from '../provider-defaults.js';

const PRIMARY_MODEL = 'gpt-4o-mini';
const REROUTED = { provider: 'anthropic', model: 'claude-sonnet-4-5' };
const SENT_MODEL = 'anthropic/claude-sonnet-4-5';
const RESCUE = { provider: 'gemini', model: 'gemini-x' };

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const status = (code: number, message = 'failed') => Object.assign(new Error(`[${code}] ${message}`), { httpStatus: code });
const reply = (modelId: string, content: string) => ({
  modelId,
  usage,
  choices: [{ message: { role: 'assistant', content }, finishReason: 'stop' }],
});
const textChunk = (modelId: string, text: string, final = true) => ({
  id: 'chunk',
  object: 'chat.completion.chunk',
  created: 1,
  modelId,
  choices: [{ index: 0, message: { role: 'assistant', content: text }, finishReason: final ? 'stop' : null }],
  responseTextDelta: text,
  ...(final ? { isFinal: true, usage } : {}),
});

/** Every line any logger writes, with its fields: an event handle writes `(event, fields)`. */
const makeLogger = (): unknown => {
  const write = (level: string) => (message: unknown, meta?: unknown) => {
    hoisted.lines.push({ level, message, meta });
  };
  return { info: write('info'), warn: write('warn'), error: write('error'), debug: write('debug'), child: () => makeLogger() };
};
/** The fields of every line with this event name, in order. */
const linesOf = (event: string): Array<Record<string, unknown>> =>
  hoisted.lines.filter((l) => l.message === event).map((l) => l.meta as Record<string, unknown>);

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

let consoleSpies: Array<{ mockRestore: () => void }> = [];

beforeEach(() => {
  hoisted.generateCompletion.mockReset();
  hoisted.generateCompletionStream.mockReset();
  hoisted.lines.length = 0;
  globalLLMProviderHealth.reset();
  clearDefaultProvider();
  vi.stubEnv('OPENAI_API_KEY', 'sk-openai-reroute-test');
  vi.stubEnv('GEMINI_API_KEY', 'gemini-reroute-test');
  vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-reroute-test');
  // No Anthropic key or base URL: the credential layer sends Anthropic legs to OpenRouter.
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('ANTHROPIC_BASE_URL', '');
  vi.stubEnv('OPENAI_BASE_URL', '');
  vi.stubEnv('OPENROUTER_BASE_URL', '');
  consoleSpies = [
    vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    vi.spyOn(console, 'error').mockImplementation(() => undefined),
  ];
  setLoggerFactory(() => makeLogger() as never);
});

afterEach(() => {
  resetLoggerFactory();
  vi.unstubAllEnvs();
  for (const spy of consoleSpies) spy.mockRestore();
  clearDefaultProvider();
  globalLLMProviderHealth.reset();
});

describe('generateText reports an Anthropic entry the credential layer sends to OpenRouter as OpenRouter', () => {
  it('names the failed rerouted leg openrouter in onFallback, the fired line and its hop', async () => {
    completions({ [SENT_MODEL]: 400, [RESCUE.model]: 'rescued' });
    const onFallback = vi.fn();
    const result = await generateText({
      provider: 'openai',
      model: PRIMARY_MODEL,
      prompt: 'hi',
      fallbackProviders: [REROUTED, RESCUE],
      onFallback,
    });

    expect(result.text).toBe('rescued');
    expect(hoisted.generateCompletion.mock.calls.map((c) => c[0])).toEqual([PRIMARY_MODEL, SENT_MODEL, RESCUE.model]);
    expect(onFallback.mock.calls.map(([, provider]) => provider)).toEqual(['openrouter', 'gemini']);
    expect(linesOf('llm.fallback_fired')).toEqual([
      expect.objectContaining({ primaryProvider: 'openai', fallbackProvider: 'openrouter', fallbackModel: SENT_MODEL }),
      expect.objectContaining({ fallbackProvider: 'gemini', fallbackModel: RESCUE.model }),
    ]);
    expect(result.fallback?.hops).toEqual([
      { provider: 'openai', model: PRIMARY_MODEL, ok: false },
      { provider: 'openrouter', model: SENT_MODEL, ok: false },
      { provider: 'gemini', model: RESCUE.model, ok: true },
    ]);
  });

  it('names the serving rerouted leg openrouter in the fired and succeeded lines and its hop', async () => {
    completions({ [SENT_MODEL]: 'served' });
    const onFallback = vi.fn();
    const result = await generateText({
      provider: 'openai',
      model: PRIMARY_MODEL,
      prompt: 'hi',
      fallbackProviders: [REROUTED],
      onFallback,
    });

    expect(result.text).toBe('served');
    expect(onFallback.mock.calls.map(([, provider]) => provider)).toEqual(['openrouter']);
    expect(linesOf('llm.fallback_fired')).toEqual([
      expect.objectContaining({ fallbackProvider: 'openrouter', fallbackModel: SENT_MODEL }),
    ]);
    expect(linesOf('llm.fallback_succeeded')).toEqual([expect.objectContaining({ fallbackProvider: 'openrouter' })]);
    expect(result.fallback?.hops).toEqual([
      { provider: 'openai', model: PRIMARY_MODEL, ok: false },
      { provider: 'openrouter', model: SENT_MODEL, ok: true },
    ]);
  });

  it("reads OpenRouter's breaker for the rerouted leg, not Anthropic's", async () => {
    completions({ [SENT_MODEL]: 'served', [RESCUE.model]: 'rescued' });
    globalLLMProviderHealth.recordFailure('openrouter', status(401));
    const skipped = await generateText({
      provider: 'openai',
      model: PRIMARY_MODEL,
      prompt: 'hi',
      fallbackProviders: [REROUTED, RESCUE],
    });
    expect(skipped.text).toBe('rescued');
    expect(hoisted.generateCompletion.mock.calls.map((c) => c[0])).toEqual([PRIMARY_MODEL, RESCUE.model]);
    expect(linesOf('llm.fallback_circuit_open')).toEqual([expect.objectContaining({ fallbackProvider: 'openrouter' })]);
    expect(linesOf('llm.fallback_fired')).toEqual([expect.objectContaining({ fallbackProvider: 'gemini' })]);

    // An open Anthropic breaker does not stop a leg that never reaches Anthropic.
    globalLLMProviderHealth.reset();
    hoisted.generateCompletion.mockClear();
    hoisted.lines.length = 0;
    globalLLMProviderHealth.recordFailure('anthropic', status(401));
    const served = await generateText({
      provider: 'openai',
      model: PRIMARY_MODEL,
      prompt: 'hi',
      fallbackProviders: [REROUTED, RESCUE],
    });
    expect(served.text).toBe('served');
    expect(hoisted.generateCompletion.mock.calls.map((c) => c[0])).toEqual([PRIMARY_MODEL, SENT_MODEL]);
    expect(linesOf('llm.fallback_circuit_open')).toEqual([]);
  });

  it('checks the rerouted leg against an exclusion of the model id it is sent as, and names the skip openrouter', async () => {
    completions({ [SENT_MODEL]: 'served', [RESCUE.model]: 'rescued' });
    const result = await generateText({
      provider: 'openai',
      model: PRIMARY_MODEL,
      prompt: 'hi',
      fallbackProviders: [REROUTED, RESCUE],
      routerParams: { excludedModelIds: [SENT_MODEL] },
    });

    expect(result.text).toBe('rescued');
    expect(hoisted.generateCompletion.mock.calls.map((c) => c[0])).toEqual([PRIMARY_MODEL, RESCUE.model]);
    expect(linesOf('llm.fallback_skipped')).toEqual([
      expect.objectContaining({ primaryProvider: 'openai', fallbackProvider: 'openrouter', fallbackModel: SENT_MODEL, reason: 'excluded' }),
    ]);
  });

  it('names a prefixed entry passed over by an exclusion by the provider and model it would be sent as', async () => {
    const prefixed = { provider: 'anthropic', model: 'openrouter:anthropic/claude-sonnet-4.5' };
    completions({});
    await expect(
      generateText({
        provider: 'openai',
        model: PRIMARY_MODEL,
        prompt: 'hi',
        fallbackProviders: [prefixed],
        routerParams: { excludedModelIds: ['anthropic/claude-sonnet-4.5'] },
      }),
    ).rejects.toThrow();
    expect(linesOf('llm.fallback_skipped')).toEqual([
      expect.objectContaining({ fallbackProvider: 'openrouter', fallbackModel: 'anthropic/claude-sonnet-4.5', reason: 'excluded' }),
    ]);
  });

  it('reports an Anthropic entry as written when an Anthropic key is set, or when the entry carries its own key', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-reroute-test');
    completions({ [REROUTED.model]: 400, [RESCUE.model]: 'rescued' });
    const onFallback = vi.fn();
    const direct = await generateText({
      provider: 'openai',
      model: PRIMARY_MODEL,
      prompt: 'hi',
      fallbackProviders: [REROUTED, RESCUE],
      onFallback,
    });
    expect(direct.text).toBe('rescued');
    expect(onFallback.mock.calls.map(([, provider]) => provider)).toEqual(['anthropic', 'gemini']);
    expect(direct.fallback?.hops?.[1]).toEqual({ provider: 'anthropic', model: REROUTED.model, ok: false });

    vi.stubEnv('ANTHROPIC_API_KEY', '');
    hoisted.lines.length = 0;
    const ownKey = await generateText({
      provider: 'openai',
      model: PRIMARY_MODEL,
      prompt: 'hi',
      fallbackProviders: [{ ...REROUTED, apiKey: 'sk-ant-entry-own-key' }, RESCUE],
    });
    expect(ownKey.text).toBe('rescued');
    expect(linesOf('llm.fallback_fired')[0]).toMatchObject({ fallbackProvider: 'anthropic', fallbackModel: REROUTED.model });
    expect(ownKey.fallback?.hops?.[1]).toEqual({ provider: 'anthropic', model: REROUTED.model, ok: false });
  });
});

describe('streamText reports an Anthropic entry the credential layer sends to OpenRouter as OpenRouter', () => {
  it('names the failed rerouted leg openrouter in onFallback, the fired line and its hop', async () => {
    streams({ [SENT_MODEL]: 400, [RESCUE.model]: 'rescued' });
    const onFallback = vi.fn();
    const r = streamText({
      provider: 'openai',
      model: PRIMARY_MODEL,
      prompt: 'hi',
      fallbackProviders: [REROUTED, RESCUE],
      onFallback,
    });
    for await (const _part of r.fullStream) { /* drain */ }

    expect(await r.text).toBe('rescued');
    expect(onFallback.mock.calls.map(([, provider]) => provider)).toEqual(['openrouter', 'gemini']);
    expect(linesOf('llm.fallback_fired')).toEqual([
      expect.objectContaining({ fallbackProvider: 'openrouter', fallbackModel: SENT_MODEL }),
      expect.objectContaining({ fallbackProvider: 'gemini', fallbackModel: RESCUE.model }),
    ]);
    expect((await r.fallback)?.hops).toEqual([
      { provider: 'openai', model: PRIMARY_MODEL, ok: false },
      { provider: 'openrouter', model: SENT_MODEL, ok: false },
      { provider: 'gemini', model: RESCUE.model, ok: true },
    ]);
  });

  it('names the serving rerouted leg openrouter in the succeeded line', async () => {
    streams({ [SENT_MODEL]: 'served' });
    const onFallback = vi.fn();
    const r = streamText({
      provider: 'openai',
      model: PRIMARY_MODEL,
      prompt: 'hi',
      fallbackProviders: [REROUTED],
      onFallback,
    });
    for await (const _part of r.fullStream) { /* drain */ }

    expect(await r.text).toBe('served');
    expect(onFallback.mock.calls.map(([, provider]) => provider)).toEqual(['openrouter']);
    expect(linesOf('llm.fallback_succeeded')).toEqual([expect.objectContaining({ fallbackProvider: 'openrouter' })]);
  });

  it('names a rerouted leg that fails after output openrouter in the failed-after-output line', async () => {
    hoisted.generateCompletionStream.mockImplementation(async function* (modelId: string) {
      if (modelId === PRIMARY_MODEL) throw status(503);
      if (modelId === SENT_MODEL) {
        yield textChunk(modelId, 'partial ', false);
        throw Object.assign(new Error('read ECONNRESET'), { code: 'STREAM_PARSING_ERROR' });
      }
      throw new Error(`unexpected model ${modelId}`);
    });
    const r = streamText({
      provider: 'openai',
      model: PRIMARY_MODEL,
      prompt: 'hi',
      fallbackProviders: [REROUTED, RESCUE],
    });
    for await (const _part of r.fullStream) { /* drain */ }

    expect(await r.text).toBe('partial ');
    expect(linesOf('llm.fallback_failed_after_output')).toEqual([expect.objectContaining({ fallbackProvider: 'openrouter' })]);
    expect(linesOf('llm.fallback_succeeded')).toEqual([]);
  });

  it("reads OpenRouter's breaker for the rerouted leg, not Anthropic's", async () => {
    streams({ [SENT_MODEL]: 'served', [RESCUE.model]: 'rescued' });
    globalLLMProviderHealth.recordFailure('openrouter', status(401));
    const skipped = streamText({ provider: 'openai', model: PRIMARY_MODEL, prompt: 'hi', fallbackProviders: [REROUTED, RESCUE] });
    for await (const _part of skipped.fullStream) { /* drain */ }
    expect(await skipped.text).toBe('rescued');
    expect(hoisted.generateCompletionStream.mock.calls.map((c) => c[0])).toEqual([PRIMARY_MODEL, RESCUE.model]);
    expect(linesOf('llm.fallback_circuit_open')).toEqual([expect.objectContaining({ fallbackProvider: 'openrouter' })]);

    globalLLMProviderHealth.reset();
    hoisted.generateCompletionStream.mockClear();
    hoisted.lines.length = 0;
    globalLLMProviderHealth.recordFailure('anthropic', status(401));
    const served = streamText({ provider: 'openai', model: PRIMARY_MODEL, prompt: 'hi', fallbackProviders: [REROUTED, RESCUE] });
    for await (const _part of served.fullStream) { /* drain */ }
    expect(await served.text).toBe('served');
    expect(hoisted.generateCompletionStream.mock.calls.map((c) => c[0])).toEqual([PRIMARY_MODEL, SENT_MODEL]);
    expect(linesOf('llm.fallback_circuit_open')).toEqual([]);
  });

  it('names a skipped rerouted entry openrouter and the model id it is sent as', async () => {
    streams({ [SENT_MODEL]: 'served', [RESCUE.model]: 'rescued' });
    const r = streamText({
      provider: 'openai',
      model: PRIMARY_MODEL,
      prompt: 'hi',
      fallbackProviders: [REROUTED, RESCUE],
      routerParams: { excludedModelIds: [SENT_MODEL] },
    });
    for await (const _part of r.fullStream) { /* drain */ }

    expect(await r.text).toBe('rescued');
    expect(linesOf('llm.fallback_skipped')).toEqual([
      expect.objectContaining({ primaryProvider: 'openai', fallbackProvider: 'openrouter', fallbackModel: SENT_MODEL, reason: 'excluded' }),
    ]);
  });

  it('reports an Anthropic entry as written when an Anthropic key is set', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-reroute-test');
    streams({ [REROUTED.model]: 'served' });
    const onFallback = vi.fn();
    const r = streamText({ provider: 'openai', model: PRIMARY_MODEL, prompt: 'hi', fallbackProviders: [REROUTED], onFallback });
    for await (const _part of r.fullStream) { /* drain */ }

    expect(await r.text).toBe('served');
    expect(onFallback.mock.calls.map(([, provider]) => provider)).toEqual(['anthropic']);
    expect(linesOf('llm.fallback_fired')).toEqual([
      expect.objectContaining({ fallbackProvider: 'anthropic', fallbackModel: REROUTED.model }),
    ]);
  });
});

/**
 * An exclusion names a model by its bare id or a `provider:model` id. A
 * rerouted Anthropic entry is matched by its model as written, as the model
 * resolution names it (the provider's default when the entry names none, the
 * id after an `anthropic:` or `anthropic/` prefix) and as it is sent
 * (`anthropic/<model>` on OpenRouter), so an excluded model is never sent
 * through OpenRouter.
 */
describe('both walkers skip a rerouted Anthropic entry whose model an exclusion names in any spelling', () => {
  // An entry with no model is sent as the provider's default.
  const DEFAULT_MODEL = PROVIDER_DEFAULTS.anthropic!.text!;
  const cases: Array<{ name: string; entry: { provider: string; model?: string }; exclusion: string; sentModel: string }> = [
    { name: 'no model, bare exclusion', entry: { provider: 'anthropic' }, exclusion: DEFAULT_MODEL, sentModel: `anthropic/${DEFAULT_MODEL}` },
    { name: 'no model, prefixed exclusion', entry: { provider: 'anthropic' }, exclusion: `anthropic:${DEFAULT_MODEL}`, sentModel: `anthropic/${DEFAULT_MODEL}` },
    { name: 'colon-prefixed model', entry: { provider: 'anthropic', model: 'anthropic:claude-sonnet-4-5' }, exclusion: 'claude-sonnet-4-5', sentModel: SENT_MODEL },
    { name: 'slash-prefixed model', entry: { provider: 'anthropic', model: 'anthropic/claude-sonnet-4-5' }, exclusion: 'claude-sonnet-4-5', sentModel: SENT_MODEL },
  ];

  for (const c of cases) {
    it(`generateText: ${c.name}`, async () => {
      completions({ [c.sentModel]: 'served', [RESCUE.model]: 'rescued' });
      const result = await generateText({
        provider: 'openai',
        model: PRIMARY_MODEL,
        prompt: 'hi',
        fallbackProviders: [c.entry, RESCUE],
        routerParams: { excludedModelIds: [c.exclusion] },
      });

      expect(result.text).toBe('rescued');
      expect(hoisted.generateCompletion.mock.calls.map((call) => call[0])).toEqual([PRIMARY_MODEL, RESCUE.model]);
      expect(linesOf('llm.fallback_skipped')).toEqual([
        expect.objectContaining({ fallbackProvider: 'openrouter', fallbackModel: c.sentModel, reason: 'excluded' }),
      ]);
    });

    it(`streamText: ${c.name}`, async () => {
      streams({ [c.sentModel]: 'served', [RESCUE.model]: 'rescued' });
      const r = streamText({
        provider: 'openai',
        model: PRIMARY_MODEL,
        prompt: 'hi',
        fallbackProviders: [c.entry, RESCUE],
        routerParams: { excludedModelIds: [c.exclusion] },
      });
      for await (const _part of r.fullStream) { /* drain */ }

      expect(await r.text).toBe('rescued');
      expect(hoisted.generateCompletionStream.mock.calls.map((call) => call[0])).toEqual([PRIMARY_MODEL, RESCUE.model]);
      expect(linesOf('llm.fallback_skipped')).toEqual([
        expect.objectContaining({ fallbackProvider: 'openrouter', fallbackModel: c.sentModel, reason: 'excluded' }),
      ]);
    });
  }

  it('both walkers run a rerouted entry the exclusion does not name, and judge an unrerouted entry as before', async () => {
    completions({ [SENT_MODEL]: 'served' });
    const kept = await generateText({
      provider: 'openai',
      model: PRIMARY_MODEL,
      prompt: 'hi',
      fallbackProviders: [REROUTED],
      routerParams: { excludedModelIds: [DEFAULT_MODEL] },
    });
    expect(kept.text).toBe('served');
    expect(linesOf('llm.fallback_skipped')).toEqual([]);

    globalLLMProviderHealth.reset();
    streams({ [SENT_MODEL]: 'served' });
    const keptStream = streamText({
      provider: 'openai',
      model: PRIMARY_MODEL,
      prompt: 'hi',
      fallbackProviders: [REROUTED],
      routerParams: { excludedModelIds: [DEFAULT_MODEL] },
    });
    for await (const _part of keptStream.fullStream) { /* drain */ }
    expect(await keptStream.text).toBe('served');
    expect(linesOf('llm.fallback_skipped')).toEqual([]);

    // With an Anthropic key the entry goes to Anthropic as written; the exclusion still skips it.
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-reroute-test');
    hoisted.lines.length = 0;
    globalLLMProviderHealth.reset();
    hoisted.generateCompletion.mockClear();
    completions({ [DEFAULT_MODEL]: 'served', [RESCUE.model]: 'rescued' });
    const direct = await generateText({
      provider: 'openai',
      model: PRIMARY_MODEL,
      prompt: 'hi',
      fallbackProviders: [{ provider: 'anthropic' }, RESCUE],
      routerParams: { excludedModelIds: [DEFAULT_MODEL] },
    });
    expect(direct.text).toBe('rescued');
    expect(hoisted.generateCompletion.mock.calls.map((call) => call[0])).toEqual([PRIMARY_MODEL, RESCUE.model]);
    expect(linesOf('llm.fallback_skipped')).toEqual([
      expect.objectContaining({ fallbackProvider: 'anthropic', fallbackModel: DEFAULT_MODEL, reason: 'excluded' }),
    ]);
  });
});

/**
 * A leg whose own walk serves on a later entry: the outer walk's succeeded
 * and failed-after-output lines name the provider that served, in both
 * walkers, as the hops and `finalProvider` do.
 */
describe("both walkers' outer lines name the provider a leg's own walk served on", () => {
  const unavailable = () => status(503, 'overloaded');
  /** The fields of the outer walk's lines: the leg's own lines name the leg's provider as their primary. */
  const outerLines = (event: string) => linesOf(event).filter((l) => l.primaryProvider === 'openai');

  it('generateText names the provider that served in the outer succeeded line', async () => {
    hoisted.generateCompletion.mockImplementation(async (modelId: string) => {
      if (modelId === PRIMARY_MODEL || modelId === SENT_MODEL) throw unavailable();
      if (modelId === RESCUE.model) return reply(modelId, 'rescued');
      throw new Error(`unexpected model ${modelId}`);
    });
    const result = await generateText({ provider: 'openai', model: PRIMARY_MODEL, prompt: 'hi', fallbackProviders: [REROUTED, RESCUE] });

    expect(result.text).toBe('rescued');
    expect(result.fallback?.finalProvider).toBe('gemini');
    expect(outerLines('llm.fallback_succeeded')).toEqual([expect.objectContaining({ fallbackProvider: 'gemini' })]);
  });

  it('streamText names the provider that served in the outer succeeded line', async () => {
    hoisted.generateCompletionStream.mockImplementation(async function* (modelId: string) {
      if (modelId === PRIMARY_MODEL || modelId === SENT_MODEL) throw unavailable();
      if (modelId === RESCUE.model) {
        yield textChunk(modelId, 'rescued');
        return;
      }
      throw new Error(`unexpected model ${modelId}`);
    });
    const r = streamText({ provider: 'openai', model: PRIMARY_MODEL, prompt: 'hi', fallbackProviders: [REROUTED, RESCUE] });
    for await (const _part of r.fullStream) { /* drain */ }

    expect(await r.text).toBe('rescued');
    expect((await r.fallback)?.finalProvider).toBe('gemini');
    expect(outerLines('llm.fallback_succeeded')).toEqual([expect.objectContaining({ fallbackProvider: 'gemini' })]);
  });

  it('streamText names the provider that failed after output in the outer failed-after-output line', async () => {
    hoisted.generateCompletionStream.mockImplementation(async function* (modelId: string) {
      if (modelId === PRIMARY_MODEL || modelId === SENT_MODEL) throw unavailable();
      if (modelId === RESCUE.model) {
        yield textChunk(modelId, 'partial ', false);
        throw Object.assign(new Error('read ECONNRESET'), { code: 'STREAM_PARSING_ERROR' });
      }
      throw new Error(`unexpected model ${modelId}`);
    });
    const r = streamText({ provider: 'openai', model: PRIMARY_MODEL, prompt: 'hi', fallbackProviders: [REROUTED, RESCUE] });
    for await (const _part of r.fullStream) { /* drain */ }

    expect(await r.text).toBe('partial ');
    expect(outerLines('llm.fallback_failed_after_output')).toEqual([expect.objectContaining({ fallbackProvider: 'gemini' })]);
    expect(outerLines('llm.fallback_succeeded')).toEqual([]);
  });
});
