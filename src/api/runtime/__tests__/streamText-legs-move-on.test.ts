/**
 * @file streamText-legs-move-on.test.ts
 * streamText's fallback walk matches generateText's: a leg that fails before
 * it delivered anything hands the walk to the next entry, whatever the error;
 * a leg that delivered output and then failed ends the stream; a leg whose
 * prompt-emulated tools ran, or that walked every entry after it, ends the
 * walk; the consumer sees one terminal error at most; a provider error chunk
 * before any output is a failure of the attempt, not the end of the stream;
 * each attempt meters its own usage once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const generateCompletionStream = vi.fn();
  const generateCompletion = vi.fn();
  const getProvider = vi.fn(() => ({ generateCompletionStream, generateCompletion }));
  const createProviderManager = vi.fn(async () => ({ getProvider }));
  const logEvents: string[] = [];
  return { generateCompletionStream, generateCompletion, createProviderManager, logEvents };
});

vi.mock('../../model.js', () => ({
  parseModelString: vi.fn(() => ({ providerId: 'openai', modelId: 'gpt-5.5' })),
  resolveModelOption: vi.fn((o: { provider?: string; model?: string }) => ({
    providerId: o?.provider ?? 'openai',
    modelId: o?.model ?? 'gpt-5.5',
  })),
  resolveProvider: vi.fn((providerId?: string, modelId?: string) => ({
    providerId: providerId ?? 'openai',
    modelId: modelId ?? 'gpt-5.5',
    apiKey: 'test-key',
  })),
  createProviderManager: hoisted.createProviderManager,
}));

// The walker logs through pino. A captured logger lets a test read which
// fallback events fired.
vi.mock('../../../core/logging/loggerFactory.js', () => {
  const makeLogger = (): unknown =>
    new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === 'then') return undefined;
          if (prop === 'child') return () => makeLogger();
          return (_message: unknown, meta?: unknown) => {
            const event = (meta as { event?: unknown } | undefined)?.event;
            if (typeof event === 'string') hoisted.logEvents.push(event);
          };
        },
      },
    );
  return { createLogger: () => makeLogger(), setLoggerFactory: () => {}, resetLoggerFactory: () => {} };
});

import { streamText } from '../streamText.js';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';
import { setGlobalLlmObserver, type LlmUsageEvent } from '../../observers.js';

const LEGS = [
  { provider: 'anthropic', model: 'claude-x' },
  { provider: 'gemini', model: 'gemini-x' },
  { provider: 'mistral', model: 'mistral-x' },
];
/** The mark a walker reads to stop instead of running the tools again. */
const TOOLS_RAN = Symbol.for('agentos.generateText.toolsRan');

type Usage = { promptTokens: number; completionTokens: number; totalTokens: number };
const used = (promptTokens: number, completionTokens = 0): Usage => ({
  promptTokens,
  completionTokens,
  totalTokens: promptTokens + completionTokens,
});

function textChunk(text: string, usage?: Usage) {
  return {
    id: 'chunk',
    object: 'chat.completion.chunk',
    created: 1,
    modelId: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finishReason: usage ? 'stop' : null }],
    responseTextDelta: text,
    ...(usage ? { isFinal: true, usage } : {}),
  };
}

function errorChunk(error: Record<string, unknown>, usage?: Usage) {
  return { id: 'err', object: 'chat.completion.chunk', created: 1, modelId: 'm', choices: [], isFinal: true, error, ...(usage ? { usage } : {}) };
}

const status = (code: number, message = 'failed') => Object.assign(new Error(`[${code}] ${message}`), { httpStatus: code });

type Part = { type: string; text?: string; error?: unknown };

async function collect(r: ReturnType<typeof streamText>) {
  const parts: Part[] = [];
  for await (const part of r.fullStream) parts.push(part as Part);
  return {
    parts,
    text: parts.filter((p) => p.type === 'text').map((p) => p.text).join(''),
    errors: parts.filter((p) => p.type === 'error'),
    finishReason: await r.finishReason,
    usage: await r.usage,
  };
}

const count = (event: string) => hoisted.logEvents.filter((e) => e === event).length;

beforeEach(() => {
  hoisted.generateCompletionStream.mockReset();
  hoisted.generateCompletion.mockReset();
  hoisted.logEvents.length = 0;
  globalLLMProviderHealth.reset();
});

afterEach(() => {
  setGlobalLlmObserver(null);
});

describe('a leg that fails before output', () => {
  it('hands the walk to the next leg even when its error is not retryable', async () => {
    hoisted.generateCompletionStream
      .mockImplementationOnce(async function* () { throw status(503); })
      .mockImplementationOnce(async function* () { throw status(400, 'request too long for this model'); })
      .mockImplementationOnce(async function* () { yield textChunk('from the third', used(1, 1)); });
    const r = await collect(streamText({ provider: 'openai', model: 'gpt-5.5', prompt: 'hi', fallbackProviders: LEGS }));
    expect(r.text).toBe('from the third');
    expect(r.errors).toHaveLength(0);
    expect(r.finishReason).toBe('stop');
    expect(hoisted.generateCompletionStream).toHaveBeenCalledTimes(3);
    expect(count('fallback_succeeded')).toBe(1);
  });

  it('runs each leg once on a full outage, shows one terminal error and logs no success', async () => {
    for (let i = 0; i < 4; i++) {
      hoisted.generateCompletionStream.mockImplementationOnce(async function* () { throw status(503); });
    }
    const r = await collect(streamText({ provider: 'openai', model: 'gpt-5.5', prompt: 'hi', fallbackProviders: LEGS }));
    expect(hoisted.generateCompletionStream).toHaveBeenCalledTimes(4);
    expect(r.errors).toHaveLength(1);
    expect(r.finishReason).toBe('error');
    expect(count('fallback_succeeded')).toBe(0);
    expect(count('fallback_exhausted')).toBeGreaterThan(0);
  });

  it('stops the walk when a leg ran a prompt-emulated tool before it failed, and marks the error', async () => {
    const execute = vi.fn(async () => ({ success: true, output: { ok: true } }));
    const tool = Object.freeze({
      id: 'ping',
      name: 'ping',
      displayName: 'Ping',
      description: 'ping',
      inputSchema: { type: 'object', properties: {} },
      execute,
    });
    const reply = (content: string) => ({
      modelId: 'm',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      choices: [{ message: { role: 'assistant', content }, finishReason: 'stop' }],
    });
    hoisted.generateCompletion
      .mockRejectedValueOnce(status(503)) // the primary, before any tool
      .mockResolvedValueOnce(reply('<tool_call>{"name":"ping","arguments":{}}</tool_call>')) // leg 1, round 1
      .mockRejectedValueOnce(status(503)); // leg 1, round 2
    const r = await collect(
      streamText({ provider: 'openai', model: 'gpt-5.5', prompt: 'go', tools: [tool] as never, toolMode: 'prompt', fallbackProviders: LEGS }),
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(hoisted.generateCompletion).toHaveBeenCalledTimes(3);
    expect(r.errors).toHaveLength(1);
    expect((r.errors[0]!.error as Record<symbol, unknown>)[TOOLS_RAN]).toBe(true);
  });
});

describe('a leg that fails after output', () => {
  it('ends the stream with one error part, does not walk on, and logs no success', async () => {
    hoisted.generateCompletionStream
      .mockImplementationOnce(async function* () { throw status(503); })
      .mockImplementationOnce(async function* () {
        yield textChunk('partial ');
        throw Object.assign(new Error('read ECONNRESET'), { code: 'STREAM_PARSING_ERROR' });
      });
    const r = await collect(streamText({ provider: 'openai', model: 'gpt-5.5', prompt: 'hi', fallbackProviders: LEGS }));
    expect(r.text).toBe('partial ');
    expect(r.errors).toHaveLength(1);
    expect(r.finishReason).toBe('error');
    expect(hoisted.generateCompletionStream).toHaveBeenCalledTimes(2);
    expect(count('fallback_succeeded')).toBe(0);
    expect(count('fallback_failed_after_output')).toBe(1);
  });
});

describe('a provider error chunk', () => {
  it('before any output, walks like a thrown error and is recorded once', async () => {
    hoisted.generateCompletionStream
      .mockImplementationOnce(async function* () { yield errorChunk({ message: '[502] Provider disconnected', type: 'upstream_error' }); })
      .mockImplementationOnce(async function* () { yield textChunk('rescued', used(1, 1)); });
    const r = await collect(streamText({ provider: 'openrouter', model: 'x', prompt: 'hi', fallbackProviders: LEGS }));
    expect(r.text).toBe('rescued');
    expect(r.errors).toHaveLength(0);
    expect(globalLLMProviderHealth.getStats('openrouter')?.failureCount).toBe(1);
  });

  it('walks on an Anthropic api_error and an OpenRouter server_error code', async () => {
    hoisted.generateCompletionStream
      .mockImplementationOnce(async function* () { yield errorChunk({ message: 'Internal server error', type: 'api_error' }); })
      .mockImplementationOnce(async function* () { yield textChunk('rescued', used(1, 1)); });
    const a = await collect(streamText({ provider: 'anthropic', model: 'x', prompt: 'hi', fallbackProviders: LEGS.slice(1) }));
    expect(a.text).toBe('rescued');

    hoisted.generateCompletionStream
      .mockImplementationOnce(async function* () {
        yield errorChunk({ message: 'Provider disconnected unexpectedly', type: 'upstream_error', code: 'server_error' });
      })
      .mockImplementationOnce(async function* () { yield textChunk('rescued too', used(1, 1)); });
    const b = await collect(streamText({ provider: 'openrouter', model: 'x', prompt: 'hi', fallbackProviders: LEGS }));
    expect(b.text).toBe('rescued too');
  });

  it('after output, ends the stream and is recorded', async () => {
    hoisted.generateCompletionStream.mockImplementationOnce(async function* () {
      yield textChunk('half ');
      yield errorChunk({ message: '[502] Provider disconnected', type: 'upstream_error' });
    });
    const r = await collect(streamText({ provider: 'openrouter', model: 'x', prompt: 'hi', fallbackProviders: LEGS }));
    expect(r.text).toBe('half ');
    expect(r.errors).toHaveLength(1);
    expect(r.finishReason).toBe('error');
    expect(hoisted.generateCompletionStream).toHaveBeenCalledTimes(1);
    expect(globalLLMProviderHealth.getStats('openrouter')?.failureCount).toBe(1);
  });

  it('never walks or records an abort', async () => {
    hoisted.generateCompletionStream.mockImplementationOnce(async function* () {
      yield errorChunk({ message: 'Stream aborted by caller', type: 'abort' });
    });
    const r = await collect(streamText({ provider: 'openrouter', model: 'x', prompt: 'hi', fallbackProviders: LEGS }));
    expect(r.errors).toHaveLength(1);
    expect(hoisted.generateCompletionStream).toHaveBeenCalledTimes(1);
    expect(globalLLMProviderHealth.getStats('openrouter')?.failureCount ?? 0).toBe(0);
  });
});

describe('usage', () => {
  it('sums every attempt into the result and meters each attempt once', async () => {
    const events: LlmUsageEvent[] = [];
    setGlobalLlmObserver((e) => {
      events.push(e);
    });
    hoisted.generateCompletionStream
      .mockImplementationOnce(async function* () { yield errorChunk({ message: '[503] busy', type: 'upstream_error' }, used(10)); })
      .mockImplementationOnce(async function* () { yield errorChunk({ message: '[400] too long' }, used(20)); })
      .mockImplementationOnce(async function* () { yield textChunk('served', used(5, 1)); });
    const r = await collect(streamText({ provider: 'openai', model: 'gpt-5.5', prompt: 'hi', fallbackProviders: LEGS }));
    expect(r.text).toBe('served');
    expect(r.usage.totalTokens).toBe(36);
    const metered = events.filter((e) => e.surface === 'streamText').map((e) => e.usage.totalTokens);
    expect(metered.sort((x, y) => x - y)).toEqual([6, 10, 20]);
  });

  it('folds every attempt into the result even when the consumer abandons a leg mid-stream', async () => {
    hoisted.generateCompletionStream
      // The primary fails before output, as does the first leg; the first
      // leg walks to the second, which streams two text parts.
      .mockImplementationOnce(async function* () { yield errorChunk({ message: '[503] busy', type: 'upstream_error' }, used(10)); })
      .mockImplementationOnce(async function* () { yield errorChunk({ message: '[503] busy', type: 'upstream_error' }, used(20)); })
      .mockImplementationOnce(async function* () {
        yield textChunk('first ');
        yield textChunk('second', used(5, 1));
      });
    const r = streamText({ provider: 'openai', model: 'gpt-5.5', prompt: 'hi', fallbackProviders: LEGS });
    for await (const part of r.fullStream) {
      if (part.type === 'text') break;
    }
    // The second leg had reported no usage when the consumer left; the
    // primary and the first leg had.
    expect((await r.usage).totalTokens).toBe(30);
  });
});
