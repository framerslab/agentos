/**
 * @file listed-error-fields.fallback.integration.spec.ts
 * An error whose name, code and message are a person's words fails every leg of a fallback chain, in `generateText`
 * and in `streamText`. The `llm.fallback_fired` and `llm.fallback_exhausted` lines, which the library wrote before it
 * had a closed list of error types and codes, write it as `unknown` and keep no word of it. The real model resolution
 * runs; the provider resolution echoes and only the provider transport is stubbed. A host logger factory set with
 * `setLoggerFactory` records every line.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const generateCompletionStream = vi.fn();
  const generateCompletion = vi.fn();
  const getProvider = vi.fn(() => ({ generateCompletionStream, generateCompletion }));
  const createProviderManager = vi.fn(async () => ({ getProvider }));
  const lines: Array<{ level: string; message: unknown; meta: unknown }> = [];
  return { generateCompletionStream, generateCompletion, createProviderManager, lines };
});

vi.mock('../../src/api/model.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/api/model.js')>();
  return {
    resolveModelOption: actual.resolveModelOption,
    resolveProvider: vi.fn((providerId: string, modelId: string) => ({ providerId, modelId, apiKey: 'test-key' })),
    createProviderManager: hoisted.createProviderManager,
  };
});

import { setLoggerFactory, resetLoggerFactory } from '../../src/core/logging/loggerFactory.js';
import { generateText } from '../../src/api/generateText.js';
import { streamText } from '../../src/api/streamText.js';
import { globalLLMProviderHealth } from '../../src/core/safety/LLMProviderHealthRegistry.js';

/** Every line any logger writes, with its fields: an event handle writes `(event, fields)`. */
const makeLogger = (): unknown => {
  const write = (level: string) => (message: unknown, meta?: unknown) => {
    hoisted.lines.push({ level, message, meta });
  };
  return { info: write('info'), warn: write('warn'), error: write('error'), debug: write('debug'), child: () => makeLogger() };
};

/** A person's message as an error's message, name and code, with a status that makes the leg move on. */
const planted = (): Error => Object.assign(new Error('PERSONAL_DATA'), { name: 'MeetMeAtBakerStreetError', code: 'PERSONAL_DATA', httpStatus: 503 });
const fields = (event: string): Array<Record<string, unknown>> =>
  hoisted.lines.filter((l) => l.message === event).map((l) => l.meta as Record<string, unknown>);
const CHAIN = { provider: 'openai', model: 'gpt-4o-mini', prompt: 'hello', fallbackProviders: [{ provider: 'anthropic', model: 'claude-x' }] };

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

it('(c) generateText: every leg fails with it, and neither fallback line keeps a word of it', async () => {
  hoisted.generateCompletion.mockImplementation(async () => { throw planted(); });
  await expect(generateText(CHAIN)).rejects.toBeDefined();
  expect(fields('llm.fallback_fired')).toEqual([expect.objectContaining({ api: 'generateText', type: 'unknown', code: 'unknown' })]);
  expect(fields('llm.fallback_exhausted')).toEqual([expect.objectContaining({ api: 'generateText', type: 'unknown', code: 'unknown' })]);
  expect(JSON.stringify(hoisted.lines).toLowerCase()).not.toMatch(/personal_data|meetmeat/);
});

it('(c) streamText: the same on the streamed path', async () => {
  hoisted.generateCompletionStream.mockImplementation(async function* () { throw planted(); });
  const result = streamText(CHAIN);
  for await (const part of result.fullStream) void part;
  expect(fields('llm.fallback_fired')).toEqual([expect.objectContaining({ api: 'streamText', type: 'unknown', code: 'unknown' })]);
  expect(fields('llm.fallback_exhausted')).toEqual([expect.objectContaining({ api: 'streamText', type: 'unknown', code: 'unknown' })]);
  expect(JSON.stringify(hoisted.lines).toLowerCase()).not.toMatch(/personal_data|meetmeat/);
});
