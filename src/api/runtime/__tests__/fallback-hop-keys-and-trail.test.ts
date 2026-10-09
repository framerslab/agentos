/**
 * @file fallback-hop-keys-and-trail.test.ts
 * What an agency seat's per-call internals do in both failover walkers, with
 * only the provider transport stubbed: each hop is sent with the key and URL
 * its own entry carries, never the primary's; `__strictCredentials` reaches
 * the resolution of every hop; under `__panelDeadline` a timeout is left out
 * of the provider's health while any other failure still counts;
 * `__maskError` masks a tool's error in the call record and in the turn the
 * next request carries, on the native tool loop and on the prompt shim; and a
 * stream's `fallback` names the run that answered, whichever way it ends.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const generateCompletionStream = vi.fn();
  const generateCompletion = vi.fn();
  const getProvider = vi.fn(() => ({ generateCompletionStream, generateCompletion }));
  const createProviderManager = vi.fn(async () => ({ getProvider }));
  const resolveModelOption = vi.fn((o: { provider?: string; model?: string }) => ({
    providerId: o?.provider ?? 'openai',
    modelId: o?.model ?? 'gpt-5.5',
  }));
  const resolveProvider = vi.fn((providerId: string, modelId: string, _overrides?: Record<string, unknown>) => ({
    providerId,
    modelId,
    apiKey: 'test-key',
  }));
  return { generateCompletionStream, generateCompletion, createProviderManager, resolveModelOption, resolveProvider };
});

vi.mock('../../model.js', () => ({
  resolveModelOption: hoisted.resolveModelOption,
  resolveProvider: hoisted.resolveProvider,
  createProviderManager: hoisted.createProviderManager,
}));

import { generateText } from '../../generateText.js';
import { streamText } from '../../streamText.js';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const status = (code: number, message = 'failed') => Object.assign(new Error(`[${code}] ${message}`), { httpStatus: code });
const timeout = () => Object.assign(new Error('Request timed out after 500ms.'), { code: 'REQUEST_TIMEOUT' });
const reply = (content: string) => ({
  modelId: 'm',
  usage,
  choices: [{ message: { role: 'assistant', content }, finishReason: 'stop' }],
});

function textChunk(text: string, final = true) {
  return {
    id: 'chunk',
    object: 'chat.completion.chunk',
    created: 1,
    modelId: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finishReason: final ? 'stop' : null }],
    responseTextDelta: text,
    ...(final ? { isFinal: true, usage } : {}),
  };
}

function errorChunk(error: Record<string, unknown>) {
  return { id: 'err', object: 'chat.completion.chunk', created: 1, modelId: 'm', choices: [], isFinal: true, error };
}

/** A step's final chunk asking for each named tool, with no arguments. */
function toolCallsChunk(names: string[]) {
  return {
    id: 'calls',
    object: 'chat.completion.chunk',
    created: 1,
    modelId: 'm',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: names.map((name, i) => ({ id: `c${i + 1}`, type: 'function', function: { name, arguments: '{}' } })),
      },
      finishReason: 'tool_calls',
    }],
    isFinal: true,
    usage,
  };
}

/** A non-streamed step asking for each named tool. */
function toolCallsReply(names: string[]) {
  return {
    modelId: 'm',
    usage,
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: names.map((name, i) => ({ id: `c${i + 1}`, type: 'function', function: { name, arguments: '{}' } })),
      },
      finishReason: 'tool_calls',
    }],
  };
}

const SECRET = 'sk-tool-secret-00000001';
/** A seat's mask as the tool loops call it: a string in, the redacted string out. */
const mask = (value: unknown): unknown => (typeof value === 'string' ? value.split(SECRET).join('[redacted]') : value);

function tool(name: string, execute: () => Promise<unknown>) {
  return { id: name, name, displayName: name, description: name, inputSchema: { type: 'object', properties: {} }, execute };
}
/** Returns a failure whose text holds the key. */
const SOFT = tool('soft', async () => ({ success: false, error: `soft saw ${SECRET}` }));
/** Throws an error whose message holds the key. */
const BOOM = tool('boom', async () => {
  throw new Error(`boom saw ${SECRET}`);
});

type Part = { type: string; [key: string]: unknown };
async function drain(r: ReturnType<typeof streamText>): Promise<Part[]> {
  const parts: Part[] = [];
  for await (const part of r.fullStream) parts.push(part as unknown as Part);
  return parts;
}

const HOPS = [
  { provider: 'anthropic', model: 'claude-x', apiKey: 'sk-hop-key-0002', baseUrl: 'https://hop.example/v1' },
  { provider: 'gemini', model: 'gemini-x' },
];
const PRIMARY = {
  provider: 'openai',
  model: 'gpt-5.5',
  prompt: 'hi',
  apiKey: 'sk-primary-key-0001',
  baseUrl: 'https://primary.example/v1',
  __strictCredentials: true,
  fallbackProviders: HOPS,
};
const RESOLVED = [
  ['openai', { apiKey: 'sk-primary-key-0001', baseUrl: 'https://primary.example/v1', strict: true }],
  ['anthropic', { apiKey: 'sk-hop-key-0002', baseUrl: 'https://hop.example/v1', strict: true }],
  ['gemini', { apiKey: undefined, baseUrl: undefined, strict: true }],
];

beforeEach(() => {
  hoisted.generateCompletion.mockReset();
  hoisted.generateCompletionStream.mockReset();
  hoisted.resolveProvider.mockClear();
  hoisted.resolveModelOption.mockClear();
  globalLLMProviderHealth.reset();
});

describe('a hop carries its own key and URL, and strict resolution rides every hop', () => {
  it('in generateText', async () => {
    hoisted.generateCompletion
      .mockRejectedValueOnce(status(503))
      .mockRejectedValueOnce(status(503))
      .mockResolvedValueOnce(reply('served'));
    const r = await generateText(PRIMARY);
    expect(r.text).toBe('served');
    expect(hoisted.resolveProvider.mock.calls.map((c) => [c[0], c[2]])).toEqual(RESOLVED);
    expect(r.fallback).toMatchObject({ fired: true, finalProvider: 'gemini', finalModel: 'gemini-x' });
  });

  it('in streamText, whose fallback carries the whole trail, each leg own walk included', async () => {
    hoisted.generateCompletionStream
      .mockImplementationOnce(async function* () { throw status(503); })
      .mockImplementationOnce(async function* () { throw status(503); })
      .mockImplementationOnce(async function* () { yield textChunk('served'); });
    const r = streamText(PRIMARY);
    await drain(r);
    expect(await r.text).toBe('served');
    expect(hoisted.resolveProvider.mock.calls.map((c) => [c[0], c[2]])).toEqual(RESOLVED);
    // The first leg walked on to gemini itself; its trail joins the stream's.
    expect(await r.fallback).toEqual({
      fired: true,
      finalProvider: 'gemini',
      finalModel: 'gemini-x',
      hops: [
        { provider: 'openai', model: 'gpt-5.5', ok: false },
        { provider: 'anthropic', model: 'claude-x', ok: false },
        { provider: 'gemini', model: 'gemini-x', ok: true },
      ],
    });
  });
});

describe('the panel deadline flag', () => {
  it('in generateText leaves a timeout out of the provider health and still records any other failure', async () => {
    const call = { provider: 'openai', model: 'gpt-5.5', prompt: 'hi', fallbackProviders: [] };
    hoisted.generateCompletion.mockRejectedValueOnce(timeout());
    await expect(generateText({ ...call, __panelDeadline: true })).rejects.toThrow(/timed out/);
    expect(globalLLMProviderHealth.getStats('openai')?.failureCount ?? 0).toBe(0);
    hoisted.generateCompletion.mockRejectedValueOnce(status(503));
    await expect(generateText({ ...call, __panelDeadline: true })).rejects.toThrow(/503/);
    expect(globalLLMProviderHealth.getStats('openai')?.failureCount).toBe(1);
    hoisted.generateCompletion.mockRejectedValueOnce(timeout());
    await expect(generateText(call)).rejects.toThrow(/timed out/);
    expect(globalLLMProviderHealth.getStats('openai')?.failureCount).toBe(2);
  });

  it('in streamText leaves a timeout out of the provider health, thrown before output or reported after it', async () => {
    const call = { provider: 'openai', model: 'gpt-5.5', prompt: 'hi', fallbackProviders: [] };
    hoisted.generateCompletionStream
      .mockImplementationOnce(async function* () { throw timeout(); })
      .mockImplementationOnce(async function* () {
        yield textChunk('half ', false);
        yield errorChunk({ message: 'Request timed out.', code: 'REQUEST_TIMEOUT' });
      });
    const before = streamText({ ...call, __panelDeadline: true });
    await drain(before);
    expect(await before.finishReason).toBe('error');
    const after = streamText({ ...call, __panelDeadline: true });
    await drain(after);
    expect(await after.text).toBe('half ');
    expect(globalLLMProviderHealth.getStats('openai')?.failureCount ?? 0).toBe(0);
    hoisted.generateCompletionStream.mockImplementationOnce(async function* () { throw timeout(); });
    await drain(streamText(call));
    expect(globalLLMProviderHealth.getStats('openai')?.failureCount).toBe(1);
  });
});

describe("a seat's mask reaches a tool's error before the next request carries it", () => {
  it('in generateText, on the native loop and on the prompt shim', async () => {
    hoisted.generateCompletion.mockResolvedValueOnce(toolCallsReply(['soft', 'boom'])).mockResolvedValueOnce(reply('done'));
    const native = await generateText({ provider: 'openai', model: 'gpt-5.5', prompt: 'go', tools: [SOFT, BOOM] as never, maxSteps: 3, __maskError: mask });
    expect(native.text).toBe('done');
    expect(native.toolCalls.map((c) => c.error)).toEqual(['soft saw [redacted]', 'boom saw [redacted]']);
    expect(JSON.stringify(native.transcriptDelta)).not.toContain(SECRET);
    expect(JSON.stringify(hoisted.generateCompletion.mock.calls[1])).not.toContain(SECRET);
    expect(JSON.stringify(hoisted.generateCompletion.mock.calls[1])).toContain('[redacted]');

    hoisted.generateCompletion.mockReset();
    hoisted.generateCompletion
      .mockResolvedValueOnce(reply('<tool_call>{"name":"soft","arguments":{}}</tool_call>'))
      .mockResolvedValueOnce(reply('<tool_call>{"name":"boom","arguments":{}}</tool_call>'))
      .mockResolvedValueOnce(reply('done'));
    const shim = await generateText({ provider: 'openai', model: 'gpt-5.5', prompt: 'go', tools: [SOFT, BOOM] as never, toolMode: 'prompt', __maskError: mask });
    expect(shim.text).toBe('done');
    expect(shim.toolCalls.map((c) => c.error)).toEqual(['soft saw [redacted]', 'Error: boom saw [redacted]']);
    expect(hoisted.generateCompletion).toHaveBeenCalledTimes(3);
    for (const sent of hoisted.generateCompletion.mock.calls.slice(1)) expect(JSON.stringify(sent)).not.toContain(SECRET);
  });

  it('in streamText, on the native loop (record, tool-result part, next request) and on the prompt shim', async () => {
    hoisted.generateCompletionStream
      .mockImplementationOnce(async function* () { yield toolCallsChunk(['soft', 'boom']); })
      .mockImplementationOnce(async function* () { yield textChunk('done'); });
    const native = streamText({ provider: 'openai', model: 'gpt-5.5', prompt: 'go', tools: [SOFT, BOOM] as never, maxSteps: 3, __maskError: mask });
    const parts = await drain(native);
    expect(await native.text).toBe('done');
    expect((await native.toolCalls).map((c) => c.error)).toEqual(['soft saw [redacted]', 'boom saw [redacted]']);
    expect(JSON.stringify(parts)).not.toContain(SECRET);
    expect(JSON.stringify(parts)).toContain('[redacted]');
    expect(JSON.stringify(hoisted.generateCompletionStream.mock.calls[1])).not.toContain(SECRET);

    hoisted.generateCompletion
      .mockResolvedValueOnce(reply('<tool_call>{"name":"soft","arguments":{}}</tool_call>'))
      .mockResolvedValueOnce(reply('<tool_call>{"name":"boom","arguments":{}}</tool_call>'))
      .mockResolvedValueOnce(reply('done'));
    const shim = streamText({ provider: 'openai', model: 'gpt-5.5', prompt: 'go', tools: [SOFT, BOOM] as never, toolMode: 'prompt', __maskError: mask });
    await drain(shim);
    expect(await shim.text).toBe('done');
    expect((await shim.toolCalls).map((c) => c.error)).toEqual(['soft saw [redacted]', 'Error: boom saw [redacted]']);
    for (const sent of hoisted.generateCompletion.mock.calls.slice(1)) expect(JSON.stringify(sent)).not.toContain(SECRET);
  });
});

describe("a stream's fallback names who answered, whichever way the stream ends", () => {
  const served = (ok: boolean) => ({
    fired: false,
    finalProvider: 'openai',
    finalModel: 'gpt-5.5',
    hops: [{ provider: 'openai', model: 'gpt-5.5', ok }],
  });

  it('served by its primary, by the prompt shim, and at the step cap', async () => {
    hoisted.generateCompletionStream.mockImplementationOnce(async function* () { yield textChunk('hello'); });
    const plain = streamText({ provider: 'openai', model: 'gpt-5.5', prompt: 'hi' });
    await drain(plain);
    expect(await plain.fallback).toEqual(served(true));

    hoisted.generateCompletion.mockResolvedValueOnce(reply('no tools needed'));
    const shim = streamText({ provider: 'openai', model: 'gpt-5.5', prompt: 'hi', tools: [SOFT] as never, toolMode: 'prompt' });
    await drain(shim);
    expect(await shim.text).toBe('no tools needed');
    expect(await shim.fallback).toEqual(served(true));

    hoisted.generateCompletionStream.mockImplementationOnce(async function* () { yield toolCallsChunk(['soft']); });
    const capped = streamText({ provider: 'openai', model: 'gpt-5.5', prompt: 'hi', tools: [SOFT] as never, maxSteps: 1 });
    await drain(capped);
    expect(await capped.finishReason).toBe('tool-calls');
    expect(await capped.fallback).toEqual(served(true));
  });

  it('names the leg whose output reached the consumer before it failed', async () => {
    hoisted.generateCompletionStream
      .mockImplementationOnce(async function* () { throw status(503); })
      .mockImplementationOnce(async function* () {
        yield textChunk('partial ', false);
        throw Object.assign(new Error('read ECONNRESET'), { code: 'STREAM_PARSING_ERROR' });
      });
    const r = streamText({ provider: 'openai', model: 'gpt-5.5', prompt: 'hi', fallbackProviders: [{ provider: 'anthropic', model: 'claude-x' }] });
    await drain(r);
    expect(await r.finishReason).toBe('error');
    expect(await r.fallback).toEqual({
      fired: true,
      finalProvider: 'anthropic',
      finalModel: 'claude-x',
      hops: [
        { provider: 'openai', model: 'gpt-5.5', ok: false },
        { provider: 'anthropic', model: 'claude-x', ok: false },
      ],
    });
  });

  it('names the provider that was streaming when the consumer leaves, and is undefined only before routing', async () => {
    hoisted.generateCompletionStream.mockImplementationOnce(async function* () {
      yield textChunk('first ', false);
      yield textChunk('second');
    });
    const left = streamText({ provider: 'openai', model: 'gpt-5.5', prompt: 'hi' });
    for await (const part of left.fullStream) {
      if (part.type === 'text') break;
    }
    expect(await left.fallback).toEqual(served(true));

    hoisted.resolveModelOption.mockImplementationOnce(() => {
      throw new Error('No provider configured.');
    });
    const unrouted = streamText({ prompt: 'hi', fallbackProviders: [] });
    await drain(unrouted);
    expect(await unrouted.finishReason).toBe('error');
    expect(await unrouted.fallback).toBeUndefined();
  });
});
