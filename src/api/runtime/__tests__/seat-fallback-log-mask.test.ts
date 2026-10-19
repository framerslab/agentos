/**
 * @file seat-fallback-log-mask.test.ts
 * What both failover walkers write about a failed attempt of an agency seat's
 * call: the `fallback` logger's `fallback_fired` and `fallback_exhausted`
 * lines and the error `onFallback` receives carry the provider's message
 * through the seat's mask, so a key the provider echoed reaches no log line
 * and no callback. Only the provider transport and the logger factory are
 * stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const generateCompletionStream = vi.fn();
  const generateCompletion = vi.fn();
  const getProvider = vi.fn(() => ({ generateCompletionStream, generateCompletion }));
  const createProviderManager = vi.fn(async () => ({ getProvider }));
  const lines: Array<{ level: string; message: unknown; meta: unknown }> = [];
  return { generateCompletionStream, generateCompletion, createProviderManager, lines };
});

vi.mock('../../model.js', () => ({
  resolveModelOption: vi.fn((o: { provider?: string; model?: string }) => ({
    providerId: o?.provider ?? 'openai',
    modelId: o?.model ?? 'gpt-5.5',
  })),
  resolveProvider: vi.fn((providerId: string, modelId: string) => ({ providerId, modelId, apiKey: 'test-key' })),
  createProviderManager: hoisted.createProviderManager,
}));

// Every line any logger writes, with its fields.
vi.mock('../../../core/logging/loggerFactory.js', () => {
  const makeLogger = (): unknown => {
    const write = (level: string) => (message: unknown, meta?: unknown) => {
      hoisted.lines.push({ level, message, meta });
    };
    return { info: write('info'), warn: write('warn'), error: write('error'), debug: write('debug'), child: () => makeLogger() };
  };
  return { createLogger: () => makeLogger(), setLoggerFactory: () => {}, resetLoggerFactory: () => {} };
});

import { generateText } from '../../generateText.js';
import { streamText } from '../../streamText.js';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';

const SECRET = 'sk-echoed-key-00000001';
/** A seat's mask, as the walkers call it on a string and on an error. */
const mask = (value: unknown): unknown => {
  if (typeof value === 'string') return value.split(SECRET).join('[redacted]');
  if (value instanceof Error) value.message = value.message.split(SECRET).join('[redacted]');
  return value;
};
const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
/** A provider failure whose message echoes the key, as an upstream error body can. */
const echo = (code: number) => Object.assign(new Error(`[${code}] upstream rejected ${SECRET}`), { httpStatus: code });
const reply = (content: string) => ({ modelId: 'm', usage, choices: [{ message: { role: 'assistant', content }, finishReason: 'stop' }] });
const textChunk = (text: string) => ({
  id: 'chunk',
  object: 'chat.completion.chunk',
  created: 1,
  modelId: 'm',
  choices: [{ index: 0, message: { role: 'assistant', content: text }, finishReason: 'stop' }],
  responseTextDelta: text,
  isFinal: true,
  usage,
});
const CALL = {
  provider: 'openai',
  model: 'gpt-5.5',
  prompt: 'hi',
  __maskError: mask,
  fallbackProviders: [{ provider: 'anthropic', model: 'claude-x' }],
};
const events = (): unknown[] => hoisted.lines.map((l) => (l.meta as { event?: unknown } | undefined)?.event);
const logged = (): string => JSON.stringify(hoisted.lines);

beforeEach(() => {
  hoisted.generateCompletion.mockReset();
  hoisted.generateCompletionStream.mockReset();
  hoisted.lines.length = 0;
  globalLLMProviderHealth.reset();
});

describe("a seat's failover writes no echoed key to the fallback logger or to onFallback", () => {
  it('in generateText: fallback_fired, fallback_exhausted and the onFallback error are masked', async () => {
    const onFallback = vi.fn();
    hoisted.generateCompletion.mockRejectedValueOnce(echo(503)).mockResolvedValueOnce(reply('served'));
    const served = await generateText({ ...CALL, onFallback });
    expect(served.text).toBe('served');
    expect(events()).toContain('fallback_fired');
    expect(logged()).not.toContain(SECRET);
    expect(logged()).toContain('upstream rejected [redacted]');
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect((onFallback.mock.calls[0][0] as Error).message).toBe('[503] upstream rejected [redacted]');

    hoisted.lines.length = 0;
    globalLLMProviderHealth.reset();
    hoisted.generateCompletion.mockRejectedValueOnce(echo(503)).mockRejectedValueOnce(echo(529));
    await expect(generateText(CALL)).rejects.toThrow();
    expect(events()).toContain('fallback_exhausted');
    expect(logged()).not.toContain(SECRET);
  });

  it('in streamText: fallback_fired, fallback_exhausted and the onFallback error are masked', async () => {
    const onFallback = vi.fn();
    hoisted.generateCompletionStream
      .mockImplementationOnce(async function* () { throw echo(503); })
      .mockImplementationOnce(async function* () { yield textChunk('served'); });
    const served = streamText({ ...CALL, onFallback });
    for await (const _part of served.fullStream) { /* drain */ }
    expect(await served.text).toBe('served');
    expect(events()).toContain('fallback_fired');
    expect(logged()).not.toContain(SECRET);
    expect(logged()).toContain('upstream rejected [redacted]');
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect((onFallback.mock.calls[0][0] as Error).message).toBe('[503] upstream rejected [redacted]');

    hoisted.lines.length = 0;
    globalLLMProviderHealth.reset();
    hoisted.generateCompletionStream
      .mockImplementationOnce(async function* () { throw echo(503); })
      .mockImplementationOnce(async function* () { throw echo(529); });
    const exhausted = streamText(CALL);
    for await (const _part of exhausted.fullStream) { /* drain */ }
    expect(await exhausted.finishReason).toBe('error');
    expect(events()).toContain('fallback_exhausted');
    expect(logged()).not.toContain(SECRET);
  });
});
