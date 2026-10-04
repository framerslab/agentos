/**
 * @file openrouter-declines.test.ts
 * An OpenRouter decline, in every shape OpenRouter sends it, reaches the
 * walkers as a typed content decline: the next leg answers, the openrouter
 * breaker stays closed, the refused call's usage is counted once. A 403
 * without a decline type still opens the breaker. Runs the real walkers,
 * the real provider over a stubbed HTTP client, and the real health
 * registry; only the provider manager is faked.
 */
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterProvider } from '../../../core/llm/providers/implementations/OpenRouterProvider.js';
import { ApiKeyPool } from '../../../core/providers/ApiKeyPool.js';

const MODEL = 'anthropic/claude-sonnet-5.5';
const USAGE = { prompt_tokens: 120, completion_tokens: 7, total_tokens: 127 };

const hoisted = vi.hoisted(() => {
  const state: { openrouterRequest: ReturnType<typeof vi.fn> | null; geminiCalls: number; buildOpenRouter: (() => unknown) | null } = {
    openrouterRequest: null,
    geminiCalls: 0,
    buildOpenRouter: null,
  };
  const createProviderManager = vi.fn(async (resolved: { providerId: string }) => ({
    getProvider: () => {
      if (resolved.providerId === 'openrouter') {
        return state.buildOpenRouter!();
      }
      return {
        generateCompletion: async (modelId: string) => {
          state.geminiCalls += 1;
          return {
            id: 'gemini-reply', object: 'chat.completion', created: 1, modelId,
            usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
            choices: [{ index: 0, message: { role: 'assistant', content: 'from gemini' }, finishReason: 'stop' }],
          };
        },
        generateCompletionStream: async function* (modelId: string) {
          state.geminiCalls += 1;
          yield { id: 'g1', object: 'chat.completion.chunk', created: 1, modelId, choices: [{ index: 0, message: { role: 'assistant', content: 'from gemini' }, finishReason: null }], responseTextDelta: 'from gemini', isFinal: false };
          yield { id: 'g2', object: 'chat.completion.chunk', created: 1, modelId, choices: [{ index: 0, message: { role: 'assistant', content: 'from gemini' }, finishReason: 'stop' }], isFinal: true, usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } };
        },
      };
    },
  }));
  return { state, createProviderManager };
});

vi.mock('../../model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../model.js')>()),
  createProviderManager: hoisted.createProviderManager,
}));

import { generateText } from '../../generateText.js';
import { streamText } from '../../streamText.js';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';

// The real provider with injected internals (initialize() hits the network),
// built per call so each test scripts its own HTTP responses.
hoisted.state.buildOpenRouter = () => {
  const provider = new OpenRouterProvider();
  Object.assign(provider as unknown as Record<string, unknown>, {
    isInitialized: true,
    ensureInitialized: () => {},
    config: { apiKey: 'sk-or-test', requestTimeout: 1000, streamRequestTimeout: 1000 },
    keyPool: new ApiKeyPool('sk-or-test'),
    client: { request: hoisted.state.openrouterRequest },
  });
  return provider;
};

const CHAIN = [{ provider: 'gemini', model: 'gemini-3.1-pro-preview' }];

function axiosError(status: number, body: unknown) {
  return { isAxiosError: true, message: `Request failed with status code ${status}`, response: { status, data: body, headers: {} } };
}
function sse(lines: string[]): NodeJS.ReadableStream {
  return Readable.from(lines.map((l) => Buffer.from(l + '\n\n')));
}
const chunk = (o: Record<string, unknown>) => 'data: ' + JSON.stringify({ id: 'gen-s', object: 'chat.completion.chunk', created: 1, model: MODEL, ...o });
const textChunk = (t: string) => chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: t }, finish_reason: null }] });
const filterChunk = chunk({ choices: [{ index: 0, delta: { content: '', refusal: 'no' }, finish_reason: 'content_filter' }] });
const usageChunk = chunk({ choices: [], usage: USAGE });
const refusalEvent = chunk({ error: { code: 403, message: 'refused', metadata: { error_type: 'refusal' } }, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }] });

beforeEach(() => {
  hoisted.state.geminiCalls = 0;
  hoisted.state.openrouterRequest = vi.fn();
  globalLLMProviderHealth.reset();
  vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
  vi.stubEnv('GEMINI_API_KEY', 'gemini-test');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const call = () => generateText({ provider: 'openrouter', model: MODEL, prompt: 'Hello?', fallbackProviders: CHAIN });
const stream = async () => {
  const r = streamText({ provider: 'openrouter', model: MODEL, prompt: 'Hello?', fallbackProviders: CHAIN });
  const parts: Array<{ type: string; text?: string }> = [];
  for await (const p of r.fullStream) parts.push(p as { type: string; text?: string });
  return { parts, text: await r.text, usage: await r.usage, finishReason: await r.finishReason };
};

describe('OpenRouter declines through generateText', () => {
  it('HTTP 403 refusal: the next leg answers and the breaker stays closed', async () => {
    hoisted.state.openrouterRequest!.mockRejectedValueOnce(axiosError(403, { error: { code: 403, message: 'refused', metadata: { error_type: 'refusal' } } }));
    const result = await call();
    expect(result.text).toBe('from gemini');
    expect(globalLLMProviderHealth.isOpen('openrouter')).toBe(false);
    // A second call still reaches OpenRouter.
    hoisted.state.openrouterRequest!.mockRejectedValueOnce(axiosError(403, { error: { code: 403, message: 'refused', metadata: { error_type: 'refusal' } } }));
    await call();
    expect(hoisted.state.openrouterRequest).toHaveBeenCalledTimes(2);
  });

  it('HTTP 403 with no decline type: the breaker opens (auth policy)', async () => {
    hoisted.state.openrouterRequest!.mockRejectedValueOnce(axiosError(403, { error: { code: 403, message: 'Request blocked', metadata: { patterns: ['x'] } } }));
    await call();
    expect(globalLLMProviderHealth.isOpen('openrouter')).toBe(true);
  });

  it('a 200 body holding only a refusal error: the next leg answers; the error, on a chainless call, is typed and status-free', async () => {
    const body = { id: 'gen-1', error: { code: 403, message: 'refused', metadata: { error_type: 'refusal' } } };
    hoisted.state.openrouterRequest!.mockResolvedValueOnce({ data: body });
    expect((await call()).text).toBe('from gemini');
    expect(globalLLMProviderHealth.isOpen('openrouter')).toBe(false);
    hoisted.state.openrouterRequest!.mockResolvedValueOnce({ data: body });
    await expect(generateText({ provider: 'openrouter', model: MODEL, prompt: 'Hello?', fallbackProviders: [] })).rejects.toMatchObject({
      code: 'content_filter',
      httpStatus: undefined,
      message: `OpenRouter declined the request on ${MODEL} (refusal).`,
      details: expect.objectContaining({ httpStatus: 403 }),
    });
  });

  it('a 200 body with code 403 and no error_type is a decline: breaker closed, next leg answers', async () => {
    hoisted.state.openrouterRequest!.mockResolvedValueOnce({ data: { id: 'gen-1', error: { code: 403, message: 'Forbidden' } } });
    expect((await call()).text).toBe('from gemini');
    expect(globalLLMProviderHealth.isOpen('openrouter')).toBe(false);
  });

  it('a choice-level refusal with usage: the next leg answers and the refused tokens are counted once', async () => {
    hoisted.state.openrouterRequest!.mockResolvedValueOnce({
      data: { id: 'gen-1', object: 'chat.completion', created: 1, model: MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content: 'par' }, finish_reason: 'error', error: { code: 403, message: 'refused', metadata: { error_type: 'refusal' } } }],
        usage: USAGE },
    });
    const result = await call();
    expect(result.text).toBe('from gemini');
    expect(result.usage.promptTokens).toBe(120 + 5);
  });

  it('a content_filter finish with usage: the next leg answers and the usage is counted once', async () => {
    hoisted.state.openrouterRequest!.mockResolvedValueOnce({
      data: { id: 'gen-1', object: 'chat.completion', created: 1, model: MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content: null, refusal: 'no' }, finish_reason: 'content_filter' }], usage: USAGE },
    });
    const result = await call();
    expect(result.text).toBe('from gemini');
    expect(result.usage.promptTokens).toBe(120 + 5);
    expect(result.usage.completionTokens).toBe(7 + 2);
  });

  it('an error-only 200 body with code 502: the next leg answers and the registry counts one transient failure', async () => {
    hoisted.state.openrouterRequest!.mockResolvedValueOnce({ data: { id: 'gen-1', error: { code: 502, message: 'down', metadata: { error_type: 'provider_unavailable' } } } });
    expect((await call()).text).toBe('from gemini');
    expect(globalLLMProviderHealth.isOpen('openrouter')).toBe(false);
    expect(globalLLMProviderHealth.getStats('openrouter')?.failureCount).toBe(1);
  });

  it('prompt-tool shim: a decline before any tool ran walks; a decline after a tool ran ends the call with the tools-ran mark', async () => {
    const tool = { name: 'ping', description: 'ping', parameters: { type: 'object', properties: {} }, execute: vi.fn(async () => ({ ok: true })) };
    const ok = (content: string) => ({ data: { id: 'gen-ok', object: 'chat.completion', created: 1, model: MODEL, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: USAGE } });
    const refused = { data: { id: 'gen-1', object: 'chat.completion', created: 1, model: MODEL, choices: [{ index: 0, message: { role: 'assistant', content: null, refusal: 'no' }, finish_reason: 'content_filter' }], usage: USAGE } };
    // Round 1 refuses, no tool ran: the walk reaches the next leg.
    hoisted.state.openrouterRequest!.mockResolvedValueOnce(refused);
    const walked = await generateText({ provider: 'openrouter', model: MODEL, prompt: 'go', tools: [tool], toolMode: 'prompt', fallbackProviders: CHAIN });
    expect(walked.text).toBe('from gemini');
    expect(tool.execute).not.toHaveBeenCalled();
    // Round 1 calls the tool, round 2 refuses: no walk, the tools-ran error.
    hoisted.state.geminiCalls = 0;
    hoisted.state.openrouterRequest!.mockResolvedValueOnce(ok('<tool_call>{"name":"ping","arguments":{}}</tool_call>')).mockResolvedValueOnce(refused);
    await expect(generateText({ provider: 'openrouter', model: MODEL, prompt: 'go', tools: [tool], toolMode: 'prompt', fallbackProviders: CHAIN })).rejects.toMatchObject({ code: 'content_filter' });
    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(hoisted.state.geminiCalls).toBe(0);
  });
});

describe('OpenRouter declines through streamText', () => {
  it('HTTP 403 refusal on the stream request: the next leg streams; breaker closed', async () => {
    const body = JSON.stringify({ error: { code: 403, message: 'refused', metadata: { error_type: 'refusal' } } });
    hoisted.state.openrouterRequest!.mockRejectedValueOnce(axiosError(403, Readable.from([Buffer.from(body)])));
    const r = await stream();
    expect(r.text).toBe('from gemini');
    expect(globalLLMProviderHealth.isOpen('openrouter')).toBe(false);
  });

  it('content_filter finish before text, then usage: the next leg streams and the usage is counted once', async () => {
    hoisted.state.openrouterRequest!.mockResolvedValueOnce({ data: sse([filterChunk, usageChunk, 'data: [DONE]']) });
    const r = await stream();
    expect(r.text).toBe('from gemini');
    expect(r.usage.promptTokens).toBe(120 + 5);
    expect(globalLLMProviderHealth.isOpen('openrouter')).toBe(false);
  });

  it('content_filter finish, then the stream errors before [DONE]: the decline still walks', async () => {
    const broken = new Readable({
      read() {
        this.push(Buffer.from(filterChunk + '\n\n'));
        this.push(Buffer.from(usageChunk + '\n\n'));
        this.destroy(new Error('read ECONNRESET'));
      },
    });
    hoisted.state.openrouterRequest!.mockResolvedValueOnce({ data: broken });
    const r = await stream();
    expect(r.text).toBe('from gemini');
    expect(r.usage.promptTokens).toBe(120 + 5);
    expect(globalLLMProviderHealth.getStats('openrouter')?.failureCount ?? 0).toBe(0);
  });

  it('content_filter finish after text: one error part, finish reason error, the next leg is never called', async () => {
    hoisted.state.openrouterRequest!.mockResolvedValueOnce({ data: sse([textChunk('Once '), filterChunk, usageChunk, 'data: [DONE]']) });
    const r = await stream();
    expect(r.parts.filter((p) => p.type === 'error')).toHaveLength(1);
    expect(r.finishReason).toBe('error');
    expect(hoisted.state.geminiCalls).toBe(0);
  });

  it('a refusal error event before text: the next leg streams', async () => {
    hoisted.state.openrouterRequest!.mockResolvedValueOnce({ data: sse([refusalEvent, 'data: [DONE]']) });
    const r = await stream();
    expect(r.text).toBe('from gemini');
  });

  it('a refusal error event after text: one error part, no replay', async () => {
    hoisted.state.openrouterRequest!.mockResolvedValueOnce({ data: sse([textChunk('a'), refusalEvent, 'data: [DONE]']) });
    const r = await stream();
    expect(r.parts.filter((p) => p.type === 'error')).toHaveLength(1);
    expect(r.parts.filter((p) => p.type === 'text').map((p) => p.text)).toEqual(['a']);
    expect(hoisted.state.geminiCalls).toBe(0);
  });
});
