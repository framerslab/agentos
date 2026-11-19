/**
 * @file fallback-exclusion-model-spellings.test.ts
 * An exclusion names a model, not one spelling of it. Anthropic's API names
 * Claude Sonnet 5.5 `claude-sonnet-5-5`; OpenRouter names it
 * `anthropic/claude-sonnet-5.5`. Either spelling in
 * `routerParams.excludedModelIds` skips the same fallback legs in
 * `generateText()`, `streamText()` and the completion gateway, so with
 * ANTHROPIC_API_KEY set the direct Anthropic leg is skipped by OpenRouter's
 * spelling, and an OpenRouter leg is skipped by Anthropic's.
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
  const createProviderManager = vi.fn(async (resolved: { providerId: string; modelId: string }) => ({
    getProvider,
    getModelInfo: async () => ({ modelId: resolved.modelId, providerId: resolved.providerId, contextWindowSize: 128_000, capabilities: ['chat'] }),
  }));
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
import { createCompletionGateway, type CompletionHopSkip } from '../completionGateway.js';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';
import { clearDefaultProvider } from '../global-default.js';

type Entry = { provider: string; model?: string; apiKey?: string };

const PRIMARY = { provider: 'openai', model: 'gpt-4o-mini' };
const RESCUE = { provider: 'gemini', model: 'gemini-x' };

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const status = (code: number) => Object.assign(new Error(`[${code}] failed`), { httpStatus: code });

const makeLogger = (): unknown => {
  const write = (level: string) => (message: unknown, meta?: unknown) => {
    hoisted.lines.push({ level, message, meta });
  };
  return { info: write('info'), warn: write('warn'), error: write('error'), debug: write('debug'), child: () => makeLogger() };
};
const skippedLines = (): Array<Record<string, unknown>> =>
  hoisted.lines.filter((l) => l.message === 'llm.fallback_skipped').map((l) => l.meta as Record<string, unknown>);

/** The primary answers 503; every other model serves with its own id as the text. */
function transport(): void {
  hoisted.generateCompletion.mockImplementation(async (modelId: string) => {
    if (modelId === PRIMARY.model) throw status(503);
    return { modelId, usage, choices: [{ message: { role: 'assistant', content: `served by ${modelId}` }, finishReason: 'stop' }] };
  });
  hoisted.generateCompletionStream.mockImplementation(async function* (modelId: string) {
    if (modelId === PRIMARY.model) throw status(503);
    yield {
      id: 'chunk',
      object: 'chat.completion.chunk',
      created: 1,
      modelId,
      choices: [{ index: 0, message: { role: 'assistant', content: `served by ${modelId}` }, finishReason: 'stop' }],
      responseTextDelta: `served by ${modelId}`,
      isFinal: true,
      usage,
    };
  });
}

async function walkGenerate(fallbackProviders: Entry[], excludedModelIds: string[]) {
  const result = await generateText({ ...PRIMARY, prompt: 'hi', fallbackProviders, routerParams: { excludedModelIds } });
  return { sent: hoisted.generateCompletion.mock.calls.map((c) => c[0] as string).slice(1), skipped: skippedLines(), text: result.text };
}

async function walkStream(fallbackProviders: Entry[], excludedModelIds: string[]) {
  const r = streamText({ ...PRIMARY, prompt: 'hi', fallbackProviders, routerParams: { excludedModelIds } });
  for await (const _part of r.fullStream) { /* drain */ }
  return { sent: hoisted.generateCompletionStream.mock.calls.map((c) => c[0] as string).slice(1), skipped: skippedLines(), text: await r.text };
}

async function walkGateway(fallbackProviders: Entry[], excludedModelIds: string[]) {
  const skipped: CompletionHopSkip[] = [];
  const gateway = createCompletionGateway();
  const route = {
    providerId: PRIMARY.provider,
    modelId: PRIMARY.model,
    messages: [],
    fallbackProviders,
    routerParams: { excludedModelIds },
    onHopSkipped: (skip: CompletionHopSkip) => skipped.push(skip),
  };
  const first = await gateway.resolve(route);
  expect(first).toMatchObject({ providerId: PRIMARY.provider, hop: 0 });
  const next = await gateway.resolve(route, first!, status(503));
  return { next, skipped };
}

let consoleSpies: Array<{ mockRestore: () => void }> = [];

beforeEach(() => {
  hoisted.generateCompletion.mockReset();
  hoisted.generateCompletionStream.mockReset();
  hoisted.createProviderManager.mockClear();
  hoisted.lines.length = 0;
  globalLLMProviderHealth.reset();
  clearDefaultProvider();
  vi.stubEnv('OPENAI_API_KEY', 'sk-openai-spelling-test');
  vi.stubEnv('GEMINI_API_KEY', 'gemini-spelling-test');
  vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-spelling-test');
  // Anthropic's own key is set: an Anthropic leg goes to Anthropic's API, not to OpenRouter.
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-spelling-test');
  vi.stubEnv('ANTHROPIC_BASE_URL', '');
  vi.stubEnv('OPENAI_BASE_URL', '');
  vi.stubEnv('OPENROUTER_BASE_URL', '');
  consoleSpies = [
    vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    vi.spyOn(console, 'error').mockImplementation(() => undefined),
  ];
  setLoggerFactory(() => makeLogger() as never);
  transport();
});

afterEach(() => {
  resetLoggerFactory();
  vi.unstubAllEnvs();
  for (const spy of consoleSpies) spy.mockRestore();
  clearDefaultProvider();
  globalLLMProviderHealth.reset();
});

/** Each case: an entry, the exclusions that must skip it, and the provider and model it is sent as. */
const SKIPPED: Array<{ name: string; entry: Entry; exclusions: string[]; sentAs: [string, string] }> = [
  {
    name: "the direct Anthropic leg, by OpenRouter's spelling",
    entry: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
    exclusions: ['claude-sonnet-5.5', 'anthropic/claude-sonnet-5.5'],
    sentAs: ['anthropic', 'claude-sonnet-5-5'],
  },
  {
    name: "an OpenRouter leg, by Anthropic's spelling",
    entry: { provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5' },
    exclusions: ['claude-sonnet-5-5', 'anthropic:claude-sonnet-5-5'],
    sentAs: ['openrouter', 'anthropic/claude-sonnet-5.5'],
  },
];

describe("an exclusion skips a model's legs by either spelling of it, in every walker", () => {
  for (const c of SKIPPED) {
    for (const exclusion of c.exclusions) {
      const label = `${c.name} (${exclusion})`;

      it(`generateText: ${label}`, async () => {
        const walk = await walkGenerate([c.entry, RESCUE], [exclusion]);
        expect(walk.sent).toEqual([RESCUE.model]);
        expect(walk.text).toBe(`served by ${RESCUE.model}`);
        expect(walk.skipped).toEqual([
          expect.objectContaining({ fallbackProvider: c.sentAs[0], fallbackModel: c.sentAs[1], reason: 'excluded' }),
        ]);
      });

      it(`streamText: ${label}`, async () => {
        const walk = await walkStream([c.entry, RESCUE], [exclusion]);
        expect(walk.sent).toEqual([RESCUE.model]);
        expect(walk.text).toBe(`served by ${RESCUE.model}`);
        expect(walk.skipped).toEqual([
          expect.objectContaining({ fallbackProvider: c.sentAs[0], fallbackModel: c.sentAs[1], reason: 'excluded' }),
        ]);
      });

      it(`completion gateway: ${label}`, async () => {
        const { next, skipped } = await walkGateway([c.entry, RESCUE], [exclusion]);
        expect(next).toMatchObject({ providerId: RESCUE.provider, modelId: RESCUE.model, hop: 1 });
        expect(skipped).toEqual([
          { provider: c.entry.provider, model: c.entry.model, reason: 'excluded_model', sentAsProvider: c.sentAs[0], sentAsModel: c.sentAs[1] },
        ]);
      });
    }
  }

  it('all three keep the direct Anthropic leg for an exclusion of another model or of the OpenRouter slug alone', async () => {
    const entry: Entry = { provider: 'anthropic', model: 'claude-sonnet-5-5' };
    // Another version, and the colon form, which names OpenRouter's slug and not Anthropic's own API.
    for (const exclusion of ['claude-sonnet-4.5', 'openrouter:anthropic/claude-sonnet-5.5']) {
      hoisted.generateCompletion.mockClear();
      hoisted.generateCompletionStream.mockClear();
      hoisted.lines.length = 0;
      globalLLMProviderHealth.reset();
      const generated = await walkGenerate([entry, RESCUE], [exclusion]);
      expect(generated.sent).toEqual(['claude-sonnet-5-5']);
      expect(generated.skipped).toEqual([]);

      hoisted.lines.length = 0;
      globalLLMProviderHealth.reset();
      const streamed = await walkStream([entry, RESCUE], [exclusion]);
      expect(streamed.sent).toEqual(['claude-sonnet-5-5']);
      expect(streamed.skipped).toEqual([]);

      globalLLMProviderHealth.reset();
      const { next, skipped } = await walkGateway([entry, RESCUE], [exclusion]);
      expect(next).toMatchObject({ providerId: 'anthropic', modelId: 'claude-sonnet-5-5', hop: 1 });
      expect(skipped).toEqual([]);
    }
  });
});
