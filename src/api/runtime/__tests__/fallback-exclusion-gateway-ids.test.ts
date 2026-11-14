/**
 * @file fallback-exclusion-gateway-ids.test.ts
 * An excluded model (`routerParams.excludedModelIds`) skips every fallback
 * leg sent as that model, whatever the leg's entry looks like and whichever
 * key decides where it goes, in `generateText()`, `streamText()` and the
 * completion gateway alike:
 *
 * - a leg sent to a gateway that names models `vendor/model` (OpenRouter's
 *   `anthropic/claude-sonnet-4-6`, its default `openai/gpt-4o-mini`, the
 *   auto-built chain's `openai/gpt-5.6-sol`) is matched by the bare id and by
 *   the `provider:model` id;
 * - an exclusion written `anthropic/<model>` names Anthropic's model whether
 *   the leg goes to Anthropic or to OpenRouter;
 * - a dated Anthropic entry sent to OpenRouter under its dateless slug is
 *   matched by the dateless id, as the same entry sent to Anthropic is.
 *
 * And the completion gateway sends a fallback leg with the entry's own key
 * and base URL, as both walkers do, so the route an exclusion judged, the
 * route a skip report names and the route the hop is sent on are one.
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
  const sentWith: Array<{ providerId: string; modelId: string; apiKey?: string; baseUrl?: string }> = [];
  const createProviderManager = vi.fn(async (resolved: { providerId: string; modelId: string; apiKey?: string; baseUrl?: string }) => {
    sentWith.push({ providerId: resolved.providerId, modelId: resolved.modelId, apiKey: resolved.apiKey, baseUrl: resolved.baseUrl });
    return {
      getProvider,
      getModelInfo: async () => ({ modelId: resolved.modelId, providerId: resolved.providerId, contextWindowSize: 128_000, capabilities: ['chat'] }),
    };
  });
  const lines: Array<{ level: string; message: unknown; meta: unknown }> = [];
  return { generateCompletionStream, generateCompletion, createProviderManager, sentWith, lines };
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

type Entry = { provider: string; model?: string; apiKey?: string; baseUrl?: string };

const PRIMARY = { provider: 'openai', model: 'gpt-4o-mini' };
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

const makeLogger = (): unknown => {
  const write = (level: string) => (message: unknown, meta?: unknown) => {
    hoisted.lines.push({ level, message, meta });
  };
  return { info: write('info'), warn: write('warn'), error: write('error'), debug: write('debug'), child: () => makeLogger() };
};
const linesOf = (event: string): Array<Record<string, unknown>> =>
  hoisted.lines.filter((l) => l.message === event).map((l) => l.meta as Record<string, unknown>);

/** The primary answers 503; every other model serves with its own id as the text. */
function transport(): void {
  hoisted.generateCompletion.mockImplementation(async (modelId: string) => {
    if (modelId === PRIMARY.model) throw status(503);
    return reply(modelId, `served by ${modelId}`);
  });
  hoisted.generateCompletionStream.mockImplementation(async function* (modelId: string) {
    if (modelId === PRIMARY.model) throw status(503);
    yield textChunk(modelId, `served by ${modelId}`);
  });
}

/** One walk per walker: the models each fallback attempt was sent as, the skip lines, and the text. */
interface Walk {
  sent: string[];
  skipped: Array<Record<string, unknown>>;
  text: string;
}

async function walkGenerate(fallbackProviders: Entry[] | undefined, excludedModelIds: string[]): Promise<Walk> {
  const result = await generateText({ ...PRIMARY, prompt: 'hi', fallbackProviders, routerParams: { excludedModelIds } });
  return {
    sent: hoisted.generateCompletion.mock.calls.map((c) => c[0] as string).slice(1),
    skipped: linesOf('llm.fallback_skipped'),
    text: result.text,
  };
}

async function walkStream(fallbackProviders: Entry[] | undefined, excludedModelIds: string[]): Promise<Walk> {
  const r = streamText({ ...PRIMARY, prompt: 'hi', fallbackProviders, routerParams: { excludedModelIds } });
  for await (const _part of r.fullStream) { /* drain */ }
  return {
    sent: hoisted.generateCompletionStream.mock.calls.map((c) => c[0] as string).slice(1),
    skipped: linesOf('llm.fallback_skipped'),
    text: await r.text,
  };
}

/** The gateway's walk past a primary that failed with a 503: the hop it resolves to, and the skips it reported. */
async function walkGateway(fallbackProviders: Entry[] | undefined, excludedModelIds: string[]) {
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
  hoisted.sentWith.length = 0;
  const next = await gateway.resolve(route, first!, status(503));
  return { next, skipped, sentWith: [...hoisted.sentWith] };
}

let consoleSpies: Array<{ mockRestore: () => void }> = [];

beforeEach(() => {
  hoisted.generateCompletion.mockReset();
  hoisted.generateCompletionStream.mockReset();
  hoisted.createProviderManager.mockClear();
  hoisted.sentWith.length = 0;
  hoisted.lines.length = 0;
  globalLLMProviderHealth.reset();
  clearDefaultProvider();
  vi.stubEnv('OPENAI_API_KEY', 'sk-openai-exclusion-test');
  vi.stubEnv('GEMINI_API_KEY', 'gemini-exclusion-test');
  vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-exclusion-test');
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
  transport();
});

afterEach(() => {
  resetLoggerFactory();
  vi.unstubAllEnvs();
  for (const spy of consoleSpies) spy.mockRestore();
  clearDefaultProvider();
  globalLLMProviderHealth.reset();
});

/**
 * Each case: an entry, the exclusions that must skip it, the provider and
 * model it is sent as, and whether an Anthropic key is set.
 */
const SKIPPED: Array<{ name: string; entry: Entry; exclusions: string[]; sentAs: [string, string]; anthropicKey?: boolean }> = [
  {
    name: "an Anthropic entry with an openrouter: model, by the model's bare id",
    entry: { provider: 'anthropic', model: 'openrouter:anthropic/claude-sonnet-4-5' },
    exclusions: ['claude-sonnet-4-5'],
    sentAs: ['openrouter', 'anthropic/claude-sonnet-4-5'],
  },
  {
    name: 'an OpenRouter entry naming a vendor slug, by the bare id and the provider:model id',
    entry: { provider: 'openrouter', model: 'anthropic/claude-sonnet-4-6' },
    exclusions: ['claude-sonnet-4-6', 'anthropic:claude-sonnet-4-6'],
    sentAs: ['openrouter', 'anthropic/claude-sonnet-4-6'],
  },
  {
    name: "an OpenRouter entry with no model, by its default's bare id",
    entry: { provider: 'openrouter' },
    exclusions: ['gpt-4o-mini'],
    sentAs: ['openrouter', 'openai/gpt-4o-mini'],
  },
  {
    name: 'a rerouted Anthropic entry, by an anthropic/ exclusion',
    entry: { provider: 'anthropic' },
    exclusions: ['anthropic/claude-sonnet-4-6'],
    sentAs: ['openrouter', 'anthropic/claude-sonnet-4-6'],
  },
  {
    name: 'an Anthropic entry sent to Anthropic, by an anthropic/ exclusion',
    entry: { provider: 'anthropic' },
    exclusions: ['anthropic/claude-sonnet-4-6'],
    sentAs: ['anthropic', 'claude-sonnet-4-6'],
    anthropicKey: true,
  },
  {
    name: 'a dated Anthropic entry sent to OpenRouter dateless, by the dateless id',
    entry: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    exclusions: ['claude-haiku-4-5', 'anthropic:claude-haiku-4-5'],
    sentAs: ['openrouter', 'anthropic/claude-haiku-4-5'],
  },
  {
    name: 'a dated Anthropic entry sent to Anthropic, by the dateless id',
    entry: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    exclusions: ['claude-haiku-4-5'],
    sentAs: ['anthropic', 'claude-haiku-4-5-20251001'],
    anthropicKey: true,
  },
];

describe('an exclusion skips a leg sent as the model it names, in every walker', () => {
  for (const c of SKIPPED) {
    for (const exclusion of c.exclusions) {
      const label = `${c.name} (${exclusion})`;

      it(`generateText: ${label}`, async () => {
        if (c.anthropicKey) vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-exclusion-test');
        const walk = await walkGenerate([c.entry, RESCUE], [exclusion]);
        expect(walk.sent).toEqual([RESCUE.model]);
        expect(walk.text).toBe(`served by ${RESCUE.model}`);
        expect(walk.skipped).toEqual([
          expect.objectContaining({ fallbackProvider: c.sentAs[0], fallbackModel: c.sentAs[1], reason: 'excluded' }),
        ]);
      });

      it(`streamText: ${label}`, async () => {
        if (c.anthropicKey) vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-exclusion-test');
        const walk = await walkStream([c.entry, RESCUE], [exclusion]);
        expect(walk.sent).toEqual([RESCUE.model]);
        expect(walk.text).toBe(`served by ${RESCUE.model}`);
        expect(walk.skipped).toEqual([
          expect.objectContaining({ fallbackProvider: c.sentAs[0], fallbackModel: c.sentAs[1], reason: 'excluded' }),
        ]);
      });

      it(`completion gateway: ${label}`, async () => {
        if (c.anthropicKey) vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-exclusion-test');
        const { next, skipped } = await walkGateway([c.entry, RESCUE], [exclusion]);
        expect(next).toMatchObject({ providerId: RESCUE.provider, modelId: RESCUE.model, hop: 1 });
        expect(skipped).toEqual([
          { provider: c.entry.provider, model: c.entry.model, reason: 'excluded_model', sentAsProvider: c.sentAs[0], sentAsModel: c.sentAs[1] },
        ]);
      });
    }
  }

  it("all three skip the auto-built chain's OpenRouter leg by the bare id of the model it sends", async () => {
    // With OPENAI_API_KEY, OPENROUTER_API_KEY and GEMINI_API_KEY set and an
    // OpenAI primary, the chain is OpenRouter's openai/gpt-5.6-sol, then Gemini.
    const generated = await walkGenerate(undefined, ['gpt-5.6-sol']);
    expect(generated.sent).toEqual(['gemini-3.1-pro-preview']);
    expect(generated.skipped).toEqual([
      expect.objectContaining({ fallbackProvider: 'openrouter', fallbackModel: 'openai/gpt-5.6-sol', reason: 'excluded' }),
    ]);

    hoisted.lines.length = 0;
    globalLLMProviderHealth.reset();
    const streamed = await walkStream(undefined, ['gpt-5.6-sol']);
    expect(streamed.sent).toEqual(['gemini-3.1-pro-preview']);
    expect(streamed.skipped).toEqual([
      expect.objectContaining({ fallbackProvider: 'openrouter', fallbackModel: 'openai/gpt-5.6-sol', reason: 'excluded' }),
    ]);

    globalLLMProviderHealth.reset();
    const { next, skipped } = await walkGateway(undefined, ['gpt-5.6-sol']);
    expect(next).toMatchObject({ providerId: 'gemini', modelId: 'gemini-3.1-pro-preview', hop: 1 });
    expect(skipped).toEqual([
      expect.objectContaining({ provider: 'openrouter', model: 'openai/gpt-5.6-sol', reason: 'excluded_model' }),
    ]);
  });

  it('all three keep a leg the exclusion does not name', async () => {
    const kept: Array<{ entry: Entry; exclusion: string; sent: string }> = [
      // Another model on the same gateway.
      { entry: { provider: 'openrouter', model: 'anthropic/claude-sonnet-4-6' }, exclusion: 'claude-sonnet-4-5', sent: 'anthropic/claude-sonnet-4-6' },
      // An exclusion of OpenRouter's slug does not name Anthropic's own API.
      { entry: { provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'sk-ant-own' }, exclusion: 'openrouter:anthropic/claude-sonnet-4-5', sent: 'claude-sonnet-4-5' },
    ];
    for (const k of kept) {
      hoisted.generateCompletion.mockClear();
      hoisted.generateCompletionStream.mockClear();
      hoisted.lines.length = 0;
      globalLLMProviderHealth.reset();
      const generated = await walkGenerate([k.entry, RESCUE], [k.exclusion]);
      expect(generated.sent).toEqual([k.sent]);
      expect(generated.skipped).toEqual([]);

      hoisted.lines.length = 0;
      globalLLMProviderHealth.reset();
      const streamed = await walkStream([k.entry, RESCUE], [k.exclusion]);
      expect(streamed.sent).toEqual([k.sent]);
      expect(streamed.skipped).toEqual([]);

      globalLLMProviderHealth.reset();
      const { next, skipped } = await walkGateway([k.entry, RESCUE], [k.exclusion]);
      expect(next).toMatchObject({ modelId: k.sent, hop: 1 });
      expect(skipped).toEqual([]);
    }
  });
});

describe("a fallback leg is sent with its entry's own key and base URL, in every walker", () => {
  const OWN_KEY_ENTRY: Entry = { provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'sk-ant-own' };
  const PROXY_ENTRY: Entry = { provider: 'openai', model: 'gpt-4o', baseUrl: 'http://proxy.local/v1', apiKey: 'proxy-key' };

  it("generateText sends an Anthropic entry with its own key to Anthropic, and a proxy entry to its proxy", async () => {
    const own = await walkGenerate([OWN_KEY_ENTRY], ['openrouter:anthropic/claude-sonnet-4-5']);
    expect(own.sent).toEqual(['claude-sonnet-4-5']);
    expect(hoisted.sentWith.at(-1)).toEqual({ providerId: 'anthropic', modelId: 'claude-sonnet-4-5', apiKey: 'sk-ant-own', baseUrl: undefined });

    hoisted.lines.length = 0;
    await walkGenerate([PROXY_ENTRY], []);
    expect(hoisted.sentWith.at(-1)).toMatchObject({ providerId: 'openai', modelId: 'gpt-4o', apiKey: 'proxy-key', baseUrl: 'http://proxy.local/v1' });
  });

  it("streamText sends an Anthropic entry with its own key to Anthropic, and a proxy entry to its proxy", async () => {
    const own = await walkStream([OWN_KEY_ENTRY], ['openrouter:anthropic/claude-sonnet-4-5']);
    expect(own.sent).toEqual(['claude-sonnet-4-5']);
    expect(hoisted.sentWith.at(-1)).toEqual({ providerId: 'anthropic', modelId: 'claude-sonnet-4-5', apiKey: 'sk-ant-own', baseUrl: undefined });

    hoisted.lines.length = 0;
    await walkStream([PROXY_ENTRY], []);
    expect(hoisted.sentWith.at(-1)).toMatchObject({ providerId: 'openai', modelId: 'gpt-4o', apiKey: 'proxy-key', baseUrl: 'http://proxy.local/v1' });
  });

  it('the completion gateway sends an Anthropic entry with its own key to Anthropic, not to OpenRouter on the environment key', async () => {
    const fallbacks: Array<{ to: string; hop: number }> = [];
    const gateway = createCompletionGateway();
    const route = {
      providerId: PRIMARY.provider,
      modelId: PRIMARY.model,
      messages: [],
      fallbackProviders: [OWN_KEY_ENTRY],
      routerParams: { excludedModelIds: ['openrouter:anthropic/claude-sonnet-4-5'] },
      onFallback: ({ to, hop }: { to: string; hop: number }) => fallbacks.push({ to, hop }),
    };
    const first = await gateway.resolve(route);
    hoisted.sentWith.length = 0;
    const next = await gateway.resolve(route, first!, status(503));
    expect(next).toMatchObject({ providerId: 'anthropic', modelId: 'claude-sonnet-4-5', hop: 1 });
    expect(hoisted.sentWith).toEqual([{ providerId: 'anthropic', modelId: 'claude-sonnet-4-5', apiKey: 'sk-ant-own', baseUrl: undefined }]);
    expect(fallbacks).toEqual([{ to: 'anthropic', hop: 1 }]);
    // Its own key keeps a health record of its own.
    expect(next?.healthId).toMatch(/^anthropic@[0-9a-f]{12}$/);
  });

  it('the completion gateway sends a proxy entry to its base URL with its key', async () => {
    const { next, sentWith } = await walkGateway([PROXY_ENTRY], []);
    expect(next).toMatchObject({ providerId: 'openai', modelId: 'gpt-4o', hop: 1 });
    expect(sentWith).toEqual([{ providerId: 'openai', modelId: 'gpt-4o', apiKey: 'proxy-key', baseUrl: 'http://proxy.local/v1' }]);
    expect(next?.healthId).toMatch(/^openai@[0-9a-f]{12}$/);
  });

  // An entry whose model prefix names another provider than its own: its key
  // is Anthropic's, and the prefix would send the leg to OpenRouter.
  const MISDIRECTED_ENTRY: Entry = { provider: 'anthropic', model: 'openrouter:anthropic/claude-sonnet-4-5', apiKey: 'sk-ant-own' };
  const keySentElsewhere = () => hoisted.sentWith.filter((s) => s.apiKey === 'sk-ant-own' && s.providerId !== 'anthropic');

  it("generateText refuses an entry whose model prefix would send its key to another provider, and walks on", async () => {
    const walk = await walkGenerate([MISDIRECTED_ENTRY, RESCUE], []);
    expect(walk.sent).toEqual([RESCUE.model]);
    expect(walk.text).toBe(`served by ${RESCUE.model}`);
    expect(keySentElsewhere()).toEqual([]);
  });

  it("streamText refuses an entry whose model prefix would send its key to another provider, and walks on", async () => {
    const walk = await walkStream([MISDIRECTED_ENTRY, RESCUE], []);
    expect(walk.sent).toEqual([RESCUE.model]);
    expect(walk.text).toBe(`served by ${RESCUE.model}`);
    expect(keySentElsewhere()).toEqual([]);
  });

  it("the completion gateway refuses an entry whose model prefix would send its key to another provider, and walks on", async () => {
    const failures: Array<{ providerId: string; hop: number; message: string }> = [];
    const gateway = createCompletionGateway();
    const route = {
      providerId: PRIMARY.provider,
      modelId: PRIMARY.model,
      messages: [],
      fallbackProviders: [MISDIRECTED_ENTRY, RESCUE],
      onHopFailure: ({ providerId, hop, error }: { providerId: string; hop: number; error: Error }) =>
        failures.push({ providerId, hop, message: error.message }),
    };
    const first = await gateway.resolve(route);
    hoisted.sentWith.length = 0;
    const next = await gateway.resolve(route, first!, status(503));
    expect(next).toMatchObject({ providerId: RESCUE.provider, modelId: RESCUE.model, hop: 2 });
    expect(keySentElsewhere()).toEqual([]);
    expect(hoisted.sentWith.map((s) => s.providerId)).toEqual([RESCUE.provider]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ providerId: 'anthropic', hop: 1 });
    expect(failures[0].message).toMatch(/names provider 'openrouter', not 'anthropic'/);
  });

  it("the completion gateway's skip report names the route the entry's own key sends it on", async () => {
    const { next, skipped } = await walkGateway([OWN_KEY_ENTRY, RESCUE], ['claude-sonnet-4-5']);
    expect(next).toMatchObject({ providerId: RESCUE.provider, hop: 1 });
    expect(skipped).toEqual([
      { provider: 'anthropic', model: 'claude-sonnet-4-5', reason: 'excluded_model', sentAsProvider: 'anthropic', sentAsModel: 'claude-sonnet-4-5' },
    ]);
  });
});
