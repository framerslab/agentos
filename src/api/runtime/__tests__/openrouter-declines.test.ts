/**
 * @file openrouter-declines.test.ts
 * An OpenRouter decline, in every shape OpenRouter sends it, reaches the
 * walkers as a typed content decline: the next leg answers, the openrouter
 * breaker stays closed, the refused call's usage is counted once. A 403
 * without a decline type still opens the breaker. Runs the real walkers,
 * the real provider over a stubbed HTTP client, and the real health
 * registry; only the provider manager is faked. The walkers' leg checks
 * (an excluded model, an open breaker) are exercised the same way.
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
const collect = async (r: ReturnType<typeof streamText>) => {
  const parts: Array<{ type: string; text?: string }> = [];
  for await (const p of r.fullStream) parts.push(p as { type: string; text?: string });
  return { parts, text: await r.text, usage: await r.usage, finishReason: await r.finishReason };
};
const stream = () => collect(streamText({ provider: 'openrouter', model: MODEL, prompt: 'Hello?', fallbackProviders: CHAIN }));

// Prompt-tool shim fixtures: a tool the shim can run, a round that calls it,
// and a round the model refuses as output.
const makePingTool = () => {
  const execute = vi.fn(async () => ({ success: true, output: { ok: true } }));
  const tool = Object.freeze({
    id: 'ping',
    name: 'ping',
    displayName: 'Ping',
    description: 'ping',
    inputSchema: { type: 'object', properties: {} },
    execute,
  });
  return { tool, execute };
};
const okBody = (content: string) => ({ data: { id: 'gen-ok', object: 'chat.completion', created: 1, model: MODEL, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: USAGE } });
const REFUSED_BODY = { data: { id: 'gen-1', object: 'chat.completion', created: 1, model: MODEL, choices: [{ index: 0, message: { role: 'assistant', content: null, refusal: 'no' }, finish_reason: 'content_filter' }], usage: USAGE } };
const PING_CALL = '<tool_call>{"name":"ping","arguments":{}}</tool_call>';
/** The mark generateText puts on an error once a tool has run (a walker reading it does not restart). */
const TOOLS_RAN = Symbol.for('agentos.generateText.toolsRan');

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
    // On a chainless call the error itself carries the partial text and the usage.
    hoisted.state.openrouterRequest!.mockResolvedValueOnce({
      data: { id: 'gen-1', object: 'chat.completion', created: 1, model: MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content: 'par' }, finish_reason: 'error', error: { code: 403, message: 'refused', metadata: { error_type: 'refusal' } } }],
        usage: USAGE },
    });
    await expect(generateText({ provider: 'openrouter', model: MODEL, prompt: 'Hello?', fallbackProviders: [] })).rejects.toMatchObject({
      code: 'content_filter',
      details: expect.objectContaining({ partialText: 'par', usage: expect.objectContaining({ promptTokens: 120 }) }),
    });
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

  it('an in-body 401 after the 200: the next leg answers and the breaker stays closed (one transient failure)', async () => {
    // The 200 proves the configured key was accepted, so the 401 describes an
    // upstream attempt. It must not open the breaker's auth policy (one
    // failure, 30 minutes) the way an HTTP 401 does.
    hoisted.state.openrouterRequest!.mockResolvedValueOnce({
      data: { id: 'gen-1', error: { code: 401, message: 'Invalid credentials', metadata: { error_type: 'authentication' } } },
    });
    expect((await call()).text).toBe('from gemini');
    expect(globalLLMProviderHealth.isOpen('openrouter')).toBe(false);
    expect(globalLLMProviderHealth.getStats('openrouter')?.failureCount).toBe(1);
  });

  it('a choice-level 403 with a non-decline type: the next leg answers and the breaker stays closed', async () => {
    hoisted.state.openrouterRequest!.mockResolvedValueOnce({
      data: { id: 'gen-1', object: 'chat.completion', created: 1, model: MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content: 'par' }, finish_reason: 'error', error: { code: 403, message: 'Blocked by a guardrail', metadata: { error_type: 'permission_denied' } } }],
        usage: USAGE },
    });
    expect((await call()).text).toBe('from gemini');
    expect(globalLLMProviderHealth.isOpen('openrouter')).toBe(false);
  });

  it('prompt-tool shim: a decline before any tool ran walks; a decline after a tool ran ends the call with the tools-ran mark', async () => {
    const { tool, execute } = makePingTool();
    // Round 1 refuses, no tool ran: the walk reaches the next leg.
    hoisted.state.openrouterRequest!.mockResolvedValueOnce(REFUSED_BODY);
    const walked = await generateText({ provider: 'openrouter', model: MODEL, prompt: 'go', tools: [tool], toolMode: 'prompt', fallbackProviders: CHAIN });
    expect(walked.text).toBe('from gemini');
    expect(execute).not.toHaveBeenCalled();
    // Round 1 calls the tool, round 2 refuses: no walk, the tools-ran error.
    hoisted.state.geminiCalls = 0;
    hoisted.state.openrouterRequest!.mockResolvedValueOnce(okBody(PING_CALL)).mockResolvedValueOnce(REFUSED_BODY);
    const err = await generateText({ provider: 'openrouter', model: MODEL, prompt: 'go', tools: [tool], toolMode: 'prompt', fallbackProviders: CHAIN }).then(
      () => {
        throw new Error('expected a throw');
      },
      (e: unknown) => e as Record<symbol, unknown> & { code?: string },
    );
    expect(err.code).toBe('content_filter');
    // toMatchObject skips symbol keys, so the mark is read directly.
    expect(err[TOOLS_RAN]).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(hoisted.state.geminiCalls).toBe(0);
  });

  it('a context-window rejection on the first model: the next leg answers and the breaker stays closed', async () => {
    hoisted.state.openrouterRequest!.mockRejectedValueOnce(axiosError(400, { error: { code: 400, message: 'This endpoint maximum context length is 32768 tokens', metadata: { error_type: 'context_length_exceeded' } } }));
    expect((await call()).text).toBe('from gemini');
    expect(globalLLMProviderHealth.isOpen('openrouter')).toBe(false);
    expect(globalLLMProviderHealth.getStats('openrouter')?.failureCount ?? 0).toBe(0);
  });

  it('the context-window rejection OpenRouter sends before routing (no error_type): the next leg answers', async () => {
    hoisted.state.openrouterRequest!.mockRejectedValueOnce(axiosError(400, { error: { message: "This endpoint's maximum context length is 16384 tokens. However, you requested about 33760 tokens (33750 of text input, 10 in the output). Please reduce the length of either one, or use the context-compression plugin to compress your prompt automatically.", code: 400, metadata: { provider_name: null } } }));
    expect((await call()).text).toBe('from gemini');
    expect(globalLLMProviderHealth.isOpen('openrouter')).toBe(false);
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

  it('prompt-tool shim: a decline before any tool ran walks to the next leg', async () => {
    const { tool, execute } = makePingTool();
    hoisted.state.openrouterRequest!.mockResolvedValueOnce(REFUSED_BODY);
    const r = await collect(streamText({ provider: 'openrouter', model: MODEL, prompt: 'go', tools: [tool] as never, toolMode: 'prompt', fallbackProviders: CHAIN }));
    expect(r.text).toBe('from gemini');
    expect(execute).not.toHaveBeenCalled();
    expect(globalLLMProviderHealth.isOpen('openrouter')).toBe(false);
  });

  it('prompt-tool shim: a decline after a tool ran ends the stream with one error part and no second leg', async () => {
    const { tool, execute } = makePingTool();
    hoisted.state.openrouterRequest!.mockResolvedValueOnce(okBody(PING_CALL)).mockResolvedValueOnce(REFUSED_BODY);
    const r = await collect(streamText({ provider: 'openrouter', model: MODEL, prompt: 'go', tools: [tool] as never, toolMode: 'prompt', fallbackProviders: CHAIN }));
    expect(r.parts.filter((p) => p.type === 'error')).toHaveLength(1);
    expect(r.finishReason).toBe('error');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(hoisted.state.geminiCalls).toBe(0);
    expect(globalLLMProviderHealth.isOpen('openrouter')).toBe(false);
  });

  it('a context-window rejection on the stream request: the next leg streams; breaker closed', async () => {
    const body = JSON.stringify({ error: { code: 400, message: 'This endpoint maximum context length is 32768 tokens', metadata: { error_type: 'context_length_exceeded' } } });
    hoisted.state.openrouterRequest!.mockRejectedValueOnce(axiosError(400, Readable.from([Buffer.from(body)])));
    const r = await stream();
    expect(r.text).toBe('from gemini');
    expect(globalLLMProviderHealth.isOpen('openrouter')).toBe(false);
    expect(globalLLMProviderHealth.getStats('openrouter')?.failureCount ?? 0).toBe(0);
  });

  it('the context-window rejection OpenRouter sends before a stream opens (no error_type): the next leg streams', async () => {
    const body = JSON.stringify({ "error": { "message": "This endpoint's maximum context length is 16384 tokens. However, you requested about 33760 tokens (33750 of text input, 10 in the output). Please reduce the length of either one, or use the context-compression plugin to compress your prompt automatically.", "code": 400, "metadata": { "provider_name": null } } });
    hoisted.state.openrouterRequest!.mockRejectedValueOnce(axiosError(400, Readable.from([Buffer.from(body)])));
    const r = await stream();
    expect(r.text).toBe('from gemini');
  });

  const errorEvent = (error: Record<string, unknown>) =>
    chunk({ error, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }] });

  it('an upstream error event before text: the next leg streams; the registry counts one transient failure', async () => {
    hoisted.state.openrouterRequest!.mockResolvedValueOnce({
      data: sse([errorEvent({ code: 502, message: 'Provider disconnected', metadata: { error_type: 'provider_unavailable' } }), 'data: [DONE]']),
    });
    const r = await stream();
    expect(r.text).toBe('from gemini');
    expect(r.parts.filter((p) => p.type === 'error')).toHaveLength(0);
    expect(globalLLMProviderHealth.getStats('openrouter')?.failureCount).toBe(1);
  });

  it('an in-stream 403 that is not a decline before text: the next leg streams; the breaker stays closed', async () => {
    hoisted.state.openrouterRequest!.mockResolvedValueOnce({
      data: sse([errorEvent({ code: 403, message: 'Blocked upstream', metadata: { error_type: 'permission_denied' } }), 'data: [DONE]']),
    });
    const r = await stream();
    expect(r.text).toBe('from gemini');
    expect(globalLLMProviderHealth.isOpen('openrouter')).toBe(false);
    expect(globalLLMProviderHealth.getStats('openrouter')?.failureCount).toBe(1);
  });

  it('a context-window error event before text: the next leg streams; the registry counts nothing', async () => {
    hoisted.state.openrouterRequest!.mockResolvedValueOnce({
      data: sse([errorEvent({ code: 400, message: 'too long', metadata: { error_type: 'context_length_exceeded' } }), 'data: [DONE]']),
    });
    const r = await stream();
    expect(r.text).toBe('from gemini');
    expect(globalLLMProviderHealth.getStats('openrouter')?.failureCount ?? 0).toBe(0);
  });

  it('an upstream error event that carries usage before text: the next leg streams and the failed attempt is counted once', async () => {
    hoisted.state.openrouterRequest!.mockResolvedValueOnce({
      data: sse([chunk({ error: { code: 502, message: 'Provider disconnected', metadata: { error_type: 'provider_unavailable' } }, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }], usage: USAGE }), 'data: [DONE]']),
    });
    const r = await stream();
    expect(r.text).toBe('from gemini');
    expect(r.parts.filter((p) => p.type === 'error')).toHaveLength(0);
    expect(r.usage.promptTokens).toBe(120 + 5);
    expect(r.usage.completionTokens).toBe(7 + 2);
    expect(globalLLMProviderHealth.getStats('openrouter')?.failureCount).toBe(1);
  });

  // The error on the choice a `finish_reason: 'error'` ended, with no error on the event.
  const choiceError = (error: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    chunk({ choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error', error }], ...extra });

  it('a choice-level upstream error before text: the next leg streams; the registry counts one transient failure', async () => {
    hoisted.state.openrouterRequest!.mockResolvedValueOnce({
      data: sse([choiceError({ code: 502, message: 'Provider disconnected', metadata: { error_type: 'provider_unavailable' } }, { usage: USAGE }), 'data: [DONE]']),
    });
    const r = await stream();
    expect(r.text).toBe('from gemini');
    expect(r.parts.filter((p) => p.type === 'error')).toHaveLength(0);
    expect(r.finishReason).toBe('stop');
    expect(r.usage.promptTokens).toBe(120 + 5);
    expect(globalLLMProviderHealth.getStats('openrouter')?.failureCount).toBe(1);
  });

  it('a choice-level refusal before text: the next leg streams and the breaker stays closed', async () => {
    hoisted.state.openrouterRequest!.mockResolvedValueOnce({
      data: sse([choiceError({ code: 403, message: 'refused', metadata: { error_type: 'refusal' } }), 'data: [DONE]']),
    });
    const r = await stream();
    expect(r.text).toBe('from gemini');
    expect(globalLLMProviderHealth.isOpen('openrouter')).toBe(false);
    expect(globalLLMProviderHealth.getStats('openrouter')?.failureCount ?? 0).toBe(0);
  });

  it('a choice-level upstream error after text: one error part, finish reason error, no second leg', async () => {
    hoisted.state.openrouterRequest!.mockResolvedValueOnce({
      data: sse([textChunk('a'), choiceError({ code: 502, message: 'Provider disconnected', metadata: { error_type: 'provider_unavailable' } }), 'data: [DONE]']),
    });
    const r = await stream();
    expect(r.parts.filter((p) => p.type === 'text').map((p) => p.text)).toEqual(['a']);
    expect(r.parts.filter((p) => p.type === 'error')).toHaveLength(1);
    expect(r.finishReason).toBe('error');
    expect(hoisted.state.geminiCalls).toBe(0);
  });

  it('a choice-level upstream error on a stream that stays open: the next leg streams within the bound', async () => {
    const open = new Readable({ read() {} });
    open.push(Buffer.from(choiceError({ code: 502, message: 'down', metadata: { error_type: 'provider_unavailable' } }) + '\n\n'));
    hoisted.state.openrouterRequest!.mockResolvedValueOnce({ data: open });
    const started = Date.now();
    const r = await stream();
    expect(r.text).toBe('from gemini');
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(open.destroyed).toBe(true);
  }, 10_000);

  it('a choice-level upstream error followed by the usage line: the next leg streams and the failed attempt is counted once', async () => {
    hoisted.state.openrouterRequest!.mockResolvedValueOnce({
      data: sse([choiceError({ code: 502, message: 'Provider disconnected', metadata: { error_type: 'provider_unavailable' } }), usageChunk, 'data: [DONE]']),
    });
    const r = await stream();
    expect(r.text).toBe('from gemini');
    expect(r.usage.promptTokens).toBe(120 + 5);
    expect(r.usage.completionTokens).toBe(7 + 2);
  });
});

describe('leg checks through the walkers', () => {
  const MAGNUM = 'anthracite-org/magnum-v4-72b';
  // A 200 body holding only a 502: retryable, and never retried by the HTTP client.
  const inBody502 = { data: { id: 'gen-1', error: { code: 502, message: 'down', metadata: { error_type: 'provider_unavailable' } } } };
  const upstreamEvent = chunk({ error: { code: 502, message: 'down', metadata: { error_type: 'provider_unavailable' } }, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }] });
  const stopChunk = chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  /** The model of every request the stubbed client saw, in order. */
  const sentModels = () => hoisted.state.openrouterRequest!.mock.calls.map((c) => (c[0] as { data?: { model?: string } }).data?.model);
  const openOpenAI = () => {
    globalLLMProviderHealth.recordFailure('openai', Object.assign(new Error('[402] insufficient credits'), { httpStatus: 402 }));
    expect(globalLLMProviderHealth.isOpen('openai')).toBe(true);
  };

  it('an excluded model named with its provider prefix is never sent as a leg', async () => {
    hoisted.state.openrouterRequest!.mockResolvedValueOnce(inBody502);
    const result = await generateText({
      provider: 'openrouter',
      model: MODEL,
      prompt: 'Hello?',
      routerParams: { excludedModelIds: [`openrouter:${MAGNUM}`] },
      fallbackProviders: [{ provider: 'openrouter', model: `openrouter:${MAGNUM}` }, ...CHAIN],
    });
    expect(result.text).toBe('from gemini');
    expect(sentModels()).toEqual([MODEL]);
  });

  it('the breaker read for a leg is the provider it is sent to: an openrouter: id under openai runs while openai is open', async () => {
    openOpenAI();
    hoisted.state.openrouterRequest!.mockResolvedValueOnce(inBody502).mockResolvedValueOnce(okBody('from the openrouter leg'));
    const result = await generateText({
      provider: 'openrouter',
      model: MODEL,
      prompt: 'Hello?',
      fallbackProviders: [{ provider: 'openai', model: 'openrouter:openai/gpt-5.6-sol' }, ...CHAIN],
    });
    expect(result.text).toBe('from the openrouter leg');
    expect(sentModels()).toEqual([MODEL, 'openai/gpt-5.6-sol']);
    expect(hoisted.state.geminiCalls).toBe(0);
  });

  it('the same leg streams while openai is open', async () => {
    openOpenAI();
    hoisted.state.openrouterRequest!
      .mockResolvedValueOnce({ data: sse([upstreamEvent, 'data: [DONE]']) })
      .mockResolvedValueOnce({ data: sse([textChunk('from the openrouter leg'), stopChunk, usageChunk, 'data: [DONE]']) });
    const r = await collect(
      streamText({
        provider: 'openrouter',
        model: MODEL,
        prompt: 'Hello?',
        fallbackProviders: [{ provider: 'openai', model: 'openrouter:openai/gpt-5.6-sol' }, ...CHAIN],
      }),
    );
    expect(r.text).toBe('from the openrouter leg');
    expect(sentModels()).toEqual([MODEL, 'openai/gpt-5.6-sol']);
    expect(hoisted.state.geminiCalls).toBe(0);
  });
});
