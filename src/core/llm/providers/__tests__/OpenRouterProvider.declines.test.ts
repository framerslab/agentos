/**
 * @file OpenRouterProvider.declines.test.ts
 * OpenRouter reports a refusal in five shapes (an HTTP 403 with a typed
 * error_type, a 200 body holding only an error, a choice-level error, a
 * content_filter finish, a mid-stream error event). Each must reach the
 * walkers as a typed content decline: code `content_filter` or
 * `content_policy_violation`, no HTTP status, the billed usage in
 * details.usage. A 403 that is NOT a decline keeps the auth policy.
 */
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OpenRouterProvider,
  classifyOpenRouterDecline,
} from '../implementations/OpenRouterProvider';
import { OpenRouterProviderError } from '../errors/OpenRouterProviderError';
import { ApiKeyPool } from '../../../providers/ApiKeyPool';
import type { ChatMessage } from '../IProvider';

const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
const MODEL = 'anthropic/claude-sonnet-5.5';

/** Bare provider with injected internals (initialize() hits the network). */
function makeProvider(clientRequest: ReturnType<typeof vi.fn>, keys = 'key-a,key-b') {
  const provider = new OpenRouterProvider();
  Object.assign(provider as unknown as Record<string, unknown>, {
    isInitialized: true,
    ensureInitialized: () => {},
    config: { apiKey: keys, requestTimeout: 1000, streamRequestTimeout: 1000 },
    keyPool: new ApiKeyPool(keys),
    client: { request: clientRequest },
  });
  return provider;
}

function axiosError(status: number | undefined, body: unknown) {
  return {
    isAxiosError: true,
    message: `Request failed with status code ${status}`,
    response: status === undefined ? undefined : { status, data: body, headers: {} },
  };
}

function sse(lines: string[]): NodeJS.ReadableStream {
  return Readable.from(lines.map((l) => Buffer.from(l + '\n\n')));
}

/**
 * A response body that runs a step between lines, so a test can act (abort)
 * after the provider has handled one line and before it reads the next.
 * `Readable.from` reads ahead, which would run the step too early.
 */
function gated(steps: Array<string | (() => void)>): NodeJS.ReadableStream {
  async function* body() {
    for (const step of steps) {
      if (typeof step === 'function') step();
      else yield Buffer.from(step + '\n\n');
    }
  }
  return body() as unknown as NodeJS.ReadableStream;
}

const USAGE = { prompt_tokens: 120, completion_tokens: 7, total_tokens: 127, cost: 0.0004 };

async function thrown(p: Promise<unknown>): Promise<OpenRouterProviderError> {
  try {
    await p;
  } catch (e) {
    return e as OpenRouterProviderError;
  }
  throw new Error('expected a throw');
}

async function drain(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

describe('classifyOpenRouterDecline', () => {
  it('maps error_type refusal to content_filter', () => {
    expect(classifyOpenRouterDecline({ code: 403, metadata: { error_type: 'refusal' } })).toEqual({
      code: 'content_filter',
      nativeType: 'refusal',
    });
  });
  it('maps error_type content_policy_violation to itself', () => {
    expect(classifyOpenRouterDecline({ code: 403, metadata: { error_type: 'content_policy_violation' } })).toEqual({
      code: 'content_policy_violation',
      nativeType: 'content_policy_violation',
    });
  });
  it('maps the moderation metadata shape without an error_type', () => {
    expect(
      classifyOpenRouterDecline({ code: 403, metadata: { reasons: ['sexual'], flagged_input: 'x', provider_name: 'P', model_slug: 'm' } }),
    ).toEqual({ code: 'content_policy_violation', nativeType: 'moderation' });
  });
  it('maps an in-body code 403 with no error_type only when told the error sits in a 200 body', () => {
    const err = { code: 403, message: 'Forbidden' };
    expect(classifyOpenRouterDecline(err, { inBody: true })).toEqual({ code: 'content_policy_violation', nativeType: 'in_body_403' });
    expect(classifyOpenRouterDecline(err)).toBeUndefined();
  });
  it('returns undefined for permission_denied, other types, and non-objects', () => {
    expect(classifyOpenRouterDecline({ code: 403, metadata: { error_type: 'permission_denied' } })).toBeUndefined();
    expect(classifyOpenRouterDecline({ code: 429, metadata: { error_type: 'rate_limit_exceeded' } })).toBeUndefined();
    expect(classifyOpenRouterDecline({ code: 403, metadata: { patterns: ['ignore all previous instructions'] } })).toBeUndefined();
    expect(classifyOpenRouterDecline(undefined)).toBeUndefined();
    expect(classifyOpenRouterDecline('nope')).toBeUndefined();
  });
});

describe('the decline error', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('carries no HTTP status, a fixed message, and bounded redacted details', async () => {
    const longMessage = 'declined key-a '.repeat(40); // 600 chars, contains a pool key
    const request = vi.fn().mockRejectedValueOnce(
      axiosError(403, { error: { code: 403, message: longMessage, metadata: { error_type: 'refusal', provider_name: 'Anthropic', provider_code: 'refusal' } } }),
    );
    const err = await thrown(makeProvider(request).generateCompletion(MODEL, messages, {}));
    expect(err).toBeInstanceOf(OpenRouterProviderError);
    expect(err.code).toBe('content_filter');
    expect(err.httpStatus).toBeUndefined();
    expect(err.openRouterErrorType).toBe('refusal');
    expect(err.message).toBe(`OpenRouter declined the request on ${MODEL} (refusal).`);
    expect(err.message).not.toMatch(/\b403\b/);
    const d = err.details as Record<string, unknown>;
    expect(d.httpStatus).toBe(403);
    expect(d.providerName).toBe('Anthropic');
    expect(d.providerCode).toBe('refusal');
    expect((d.upstreamMessage as string).length).toBeLessThanOrEqual(300);
    expect(d.upstreamMessage as string).not.toContain('key-a');
  });

  it('caps the refusal at 300 characters and the partial text at 2,000', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      data: {
        id: 'gen-1', object: 'chat.completion', created: 1, model: MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content: 'p'.repeat(2500), refusal: 'r'.repeat(400) }, finish_reason: 'content_filter' }],
        usage: USAGE,
      },
    });
    const err = await thrown(makeProvider(request).generateCompletion(MODEL, messages, {}));
    const d = err.details as { refusal?: string; partialText?: string };
    expect(d.refusal).toBe('r'.repeat(300));
    expect(d.partialText).toBe('p'.repeat(2000));
  });

  it('caps the partial text of an in-body error that is not a decline at 2,000 characters', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      data: {
        id: 'gen-1', object: 'chat.completion', created: 1, model: MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content: 'p'.repeat(2500) }, finish_reason: 'error',
          error: { code: 502, message: 'Provider disconnected', metadata: { error_type: 'provider_unavailable' } } }],
        usage: USAGE,
      },
    });
    const err = await thrown(makeProvider(request).generateCompletion(MODEL, messages, {}));
    expect(err.code).toBe('API_REQUEST_FAILED');
    expect((err.details as { partialText?: string }).partialText).toBe('p'.repeat(2000));
  });
});

function okResponse() {
  return {
    id: 'gen-ok',
    object: 'chat.completion',
    created: 1,
    model: MODEL,
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: USAGE,
  };
}

describe('HTTP error responses', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('does not retry a decline inside the provider and does not cool the pool key', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(axiosError(403, { error: { code: 403, message: 'refused', metadata: { error_type: 'refusal' } } }))
      .mockResolvedValueOnce({ data: okResponse() });
    const provider = makeProvider(request);
    const err = await thrown(provider.generateCompletion(MODEL, messages, {}));
    expect(err.code).toBe('content_filter');
    expect(request).toHaveBeenCalledTimes(1);
    // No key was cooled: every pool entry's cooldown is still unset. (The pool is a
    // weighted round-robin, so the next key drawn is not a usable signal.)
    const pool = (provider as unknown as { keyPool: { keys: Array<{ key: string; exhaustedUntil: number }> } }).keyPool;
    expect(pool.keys.map((k) => k.exhaustedUntil)).toEqual([0, 0]);
  });

  it('a decline body on a throttled status is thrown before the key cooldown and the retry', async () => {
    // A 429 is the status the provider both cools a key on and retries, so this
    // pins the order: the decline check runs first. (A 403 is neither cooled nor
    // retried, so the case above cannot tell the two orders apart.)
    const request = vi
      .fn()
      .mockRejectedValueOnce(axiosError(429, { error: { code: 429, message: 'refused', metadata: { error_type: 'refusal' } } }))
      .mockResolvedValueOnce({ data: okResponse() });
    const provider = makeProvider(request);
    const err = await thrown(provider.generateCompletion(MODEL, messages, {}));
    expect(err.code).toBe('content_filter');
    expect((err.details as { httpStatus?: number }).httpStatus).toBe(429);
    expect(request).toHaveBeenCalledTimes(1);
    const pool = (provider as unknown as { keyPool: { keys: Array<{ exhaustedUntil: number }> } }).keyPool;
    expect(pool.keys.map((k) => k.exhaustedUntil)).toEqual([0, 0]);
  });

  it('an HTTP error that is not a decline takes its error type from metadata.error_type', async () => {
    const request = vi.fn().mockRejectedValueOnce(
      axiosError(400, { error: { code: 400, message: 'Bad request', metadata: { error_type: 'invalid_request' } } }),
    );
    const err = await thrown(makeProvider(request).generateCompletion(MODEL, messages, {}));
    expect(err.code).toBe('API_REQUEST_FAILED');
    expect(err.httpStatus).toBe(400);
    expect(err.openRouterErrorType).toBe('invalid_request');
  });

  it('keeps a 403 with no decline type as the auth-class request failure', async () => {
    const request = vi.fn().mockRejectedValueOnce(
      axiosError(403, { error: { code: 403, message: 'Request blocked: prompt injection patterns detected', metadata: { patterns: ['ignore all previous instructions'] } } }),
    );
    const err = await thrown(makeProvider(request).generateCompletion(MODEL, messages, {}));
    expect(err.code).toBe('API_REQUEST_FAILED');
    expect(err.httpStatus).toBe(403);
  });

  it('classifies a 403 decline whose body arrives as a stream', async () => {
    const body = JSON.stringify({ error: { code: 403, message: 'refused', metadata: { error_type: 'refusal' } } });
    const request = vi.fn().mockRejectedValueOnce(axiosError(403, Readable.from([Buffer.from(body)])));
    const err = await thrown(drain(makeProvider(request).generateCompletionStream(MODEL, messages, {})));
    expect(err.code).toBe('content_filter');
    expect(err.httpStatus).toBeUndefined();
  });

  it('a 403 body cut at the 8 KiB read cap is not classified (the limit is pinned, not hidden)', async () => {
    const padding = 'x'.repeat(9000);
    const body = JSON.stringify({ error: { code: 403, message: padding, metadata: { error_type: 'refusal' } } });
    const request = vi.fn().mockRejectedValueOnce(axiosError(403, Readable.from([Buffer.from(body)])));
    const err = await thrown(drain(makeProvider(request).generateCompletionStream(MODEL, messages, {})));
    expect(err.code).toBe('API_REQUEST_FAILED');
    expect(err.httpStatus).toBe(403);
  });

  it('types a context-window rejection: code CONTEXT_WINDOW_EXCEEDED, one request', async () => {
    const request = vi.fn().mockRejectedValueOnce(
      axiosError(400, { error: { code: 400, message: 'This endpoint maximum context length is 32768 tokens', metadata: { error_type: 'context_length_exceeded' } } }),
    );
    const err = await thrown(makeProvider(request).generateCompletion(MODEL, messages, {}));
    expect(err.code).toBe('CONTEXT_WINDOW_EXCEEDED');
    expect(err.httpStatus).toBe(400);
    expect(err.openRouterErrorType).toBe('context_length_exceeded');
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('HTTP 200 bodies, non-stream', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('an error-only body that is a decline throws the decline error with details.httpStatus 403', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      data: { id: 'gen-1', error: { code: 403, message: 'refused', metadata: { error_type: 'refusal' } } },
    });
    const err = await thrown(makeProvider(request).generateCompletion(MODEL, messages, {}));
    expect(err.code).toBe('content_filter');
    expect(err.httpStatus).toBeUndefined();
    expect((err.details as { httpStatus?: number }).httpStatus).toBe(403);
  });

  it('an error-only body with code 403 and no error_type is a decline (the in-body row)', async () => {
    const request = vi.fn().mockResolvedValueOnce({ data: { id: 'gen-1', error: { code: 403, message: 'Forbidden' } } });
    const err = await thrown(makeProvider(request).generateCompletion(MODEL, messages, {}));
    expect(err.code).toBe('content_policy_violation');
    expect(err.openRouterErrorType).toBe('in_body_403');
  });

  it('an error-only body with code 502 throws a typed request failure with that status', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      data: { id: 'gen-1', error: { code: 502, message: 'Provider disconnected', metadata: { error_type: 'provider_unavailable' } } },
    });
    const err = await thrown(makeProvider(request).generateCompletion(MODEL, messages, {}));
    expect(err).toBeInstanceOf(OpenRouterProviderError);
    expect(err.code).toBe('API_REQUEST_FAILED');
    expect(err.httpStatus).toBe(502);
    expect(err.openRouterErrorType).toBe('provider_unavailable');
    expect(err.message).toMatch(/^\[502\] /);
  });

  it('a choice-level error keeps the partial text and the usage in details', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      data: {
        id: 'gen-1', object: 'chat.completion', created: 1, model: MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content: 'partial output...' }, finish_reason: 'error',
          error: { code: 502, message: 'Provider disconnected mid-stream', metadata: { error_type: 'provider_unavailable' } } }],
        usage: USAGE,
      },
    });
    const err = await thrown(makeProvider(request).generateCompletion(MODEL, messages, {}));
    expect(err.code).toBe('API_REQUEST_FAILED');
    expect(err.httpStatus).toBe(502);
    const d = err.details as { partialText?: string; usage?: { promptTokens: number } };
    expect(d.partialText).toBe('partial output...');
    expect(d.usage?.promptTokens).toBe(120);
  });

  it('a choice-level error that is a decline throws the decline error', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      data: {
        id: 'gen-1', object: 'chat.completion', created: 1, model: MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content: 'par' }, finish_reason: 'error',
          error: { code: 403, message: 'refused', metadata: { error_type: 'refusal' } } }],
        usage: USAGE,
      },
    });
    const err = await thrown(makeProvider(request).generateCompletion(MODEL, messages, {}));
    expect(err.code).toBe('content_filter');
    const d = err.details as { usage?: { promptTokens: number }; partialText?: string };
    expect(d.usage?.promptTokens).toBe(120);
    expect(d.partialText).toBe('par');
  });

  it('an in-body error whose message is not a string still throws the typed request failure', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      data: { id: 'gen-1', error: { code: 502, message: { detail: 'upstream reset' } } },
    });
    const err = await thrown(makeProvider(request).generateCompletion(MODEL, messages, {}));
    expect(err).toBeInstanceOf(OpenRouterProviderError);
    expect(err.code).toBe('API_REQUEST_FAILED');
    expect(err.httpStatus).toBe(502);
    expect(err.message).toMatch(/^\[502\] /);
  });

  it('an in-body error with a string code carries no status', async () => {
    const request = vi.fn().mockResolvedValueOnce({ data: { id: 'gen-1', error: { code: '502', message: 'down' } } });
    const err = await thrown(makeProvider(request).generateCompletion(MODEL, messages, {}));
    expect(err.code).toBe('API_REQUEST_FAILED');
    expect(err.httpStatus).toBeUndefined();
    expect(err.message).toBe('down');
  });

  it('an in-body 401 that is not a decline carries no status: the 200 proves the key was accepted', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      data: { id: 'gen-1', error: { code: 401, message: 'Invalid credentials', metadata: { error_type: 'authentication' } } },
    });
    const err = await thrown(makeProvider(request).generateCompletion(MODEL, messages, {}));
    expect(err.code).toBe('API_REQUEST_FAILED');
    expect(err.httpStatus).toBeUndefined();
    expect(err.openRouterErrorType).toBe('authentication');
    // The code stays in the message for the retry classifiers, but not as the
    // `[NNN]` prefix the breaker reads a status from.
    expect(err.message).toMatch(/\b401\b/);
    expect(err.message).not.toMatch(/^\[\d{3}\]/);
    expect((err.details as { httpStatus?: number }).httpStatus).toBe(401);
  });

  it('a choice-level 403 with a non-decline error type carries no status either', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      data: {
        id: 'gen-1', object: 'chat.completion', created: 1, model: MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content: 'par' }, finish_reason: 'error',
          error: { code: 403, message: 'Blocked by a guardrail', metadata: { error_type: 'permission_denied' } } }],
        usage: USAGE,
      },
    });
    const err = await thrown(makeProvider(request).generateCompletion(MODEL, messages, {}));
    expect(err.code).toBe('API_REQUEST_FAILED');
    expect(err.httpStatus).toBeUndefined();
    expect(err.openRouterErrorType).toBe('permission_denied');
    expect(err.message).toMatch(/\b403\b/);
    expect(err.message).not.toMatch(/^\[\d{3}\]/);
    const d = err.details as { httpStatus?: number; partialText?: string; usage?: { promptTokens: number } };
    expect(d.httpStatus).toBe(403);
    expect(d.partialText).toBe('par');
    expect(d.usage?.promptTokens).toBe(120);
  });

  it('a content_filter finish throws the decline error with the refusal text and the usage', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      data: {
        id: 'gen-1', object: 'chat.completion', created: 1, model: MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content: null, refusal: 'I cannot help with that.' }, finish_reason: 'content_filter' }],
        usage: USAGE,
      },
    });
    const err = await thrown(makeProvider(request).generateCompletion(MODEL, messages, {}));
    expect(err.code).toBe('content_filter');
    expect(err.openRouterErrorType).toBe('content_filter_finish');
    const d = err.details as { refusal?: string; usage?: { promptTokens: number }; httpStatus?: number };
    expect(d.refusal).toBe('I cannot help with that.');
    expect(d.usage?.promptTokens).toBe(120);
    expect(d.httpStatus).toBe(200);
  });

  it("a choice with finish_reason 'error' and no error object is returned as today", async () => {
    const request = vi.fn().mockResolvedValueOnce({
      data: {
        id: 'gen-1', object: 'chat.completion', created: 1, model: MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content: 'half' }, finish_reason: 'error' }],
        usage: USAGE,
      },
    });
    const res = await makeProvider(request).generateCompletion(MODEL, messages, {});
    expect(res.choices[0].message.content).toBe('half');
    expect(res.choices[0].finishReason).toBe('error');
  });

  it('types an in-body context-window rejection the same way', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      data: { id: 'gen-1', error: { code: 400, message: 'too long', metadata: { error_type: 'context_length_exceeded' } } },
    });
    const err = await thrown(makeProvider(request).generateCompletion(MODEL, messages, {}));
    expect(err.code).toBe('CONTEXT_WINDOW_EXCEEDED');
  });

  it('types an in-body context-window rejection named by the envelope type, as the HTTP path does', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      data: { id: 'gen-1', error: { code: 400, message: 'too long', type: 'context_length_exceeded' } },
    });
    const err = await thrown(makeProvider(request).generateCompletion(MODEL, messages, {}));
    expect(err.code).toBe('CONTEXT_WINDOW_EXCEEDED');
    expect(err.openRouterErrorType).toBe('context_length_exceeded');
  });
});

describe('streams', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  const chunk = (o: Record<string, unknown>) => 'data: ' + JSON.stringify({ id: 'gen-s', object: 'chat.completion.chunk', created: 1, model: MODEL, ...o });
  const textChunk = (t: string) => chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: t }, finish_reason: null }] });
  const filterChunk = chunk({ choices: [{ index: 0, delta: { content: '', refusal: 'I cannot help with that.' }, finish_reason: 'content_filter' }] });
  const usageChunk = chunk({ choices: [], usage: USAGE });
  const refusalEvent = chunk({ error: { code: 403, message: 'refused', metadata: { error_type: 'refusal' } }, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }] });
  const upstreamEvent = chunk({ error: { code: 502, message: 'Provider disconnected', metadata: { error_type: 'provider_unavailable' } }, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }] });

  it('a content_filter finish before any text throws the decline after the trailing usage chunk', async () => {
    const request = vi.fn().mockResolvedValueOnce({ data: sse([filterChunk, usageChunk, 'data: [DONE]']) });
    const err = await thrown(drain(makeProvider(request).generateCompletionStream(MODEL, messages, {})));
    expect(err.code).toBe('content_filter');
    const d = err.details as { usage?: { promptTokens: number }; refusal?: string; partialText?: string };
    expect(d.usage?.promptTokens).toBe(120);
    expect(d.refusal).toBe('I cannot help with that.');
    expect(d.partialText).toBeUndefined();
  });

  it('a content_filter finish after text throws with the partial text; the text chunks were yielded', async () => {
    const request = vi.fn().mockResolvedValueOnce({ data: sse([textChunk('Once '), textChunk('upon'), filterChunk, usageChunk, 'data: [DONE]']) });
    const gen = makeProvider(request).generateCompletionStream(MODEL, messages, {});
    const seen: string[] = [];
    let caught: OpenRouterProviderError | undefined;
    try {
      for await (const c of gen) seen.push((c as { responseTextDelta?: string }).responseTextDelta ?? '');
    } catch (e) {
      caught = e as OpenRouterProviderError;
    }
    expect(seen).toEqual(['Once ', 'upon']);
    expect(caught?.code).toBe('content_filter');
    expect((caught?.details as { partialText?: string }).partialText).toBe('Once upon');
  });

  it('a content_filter finish followed by a read error still throws the decline, with the usage held so far', async () => {
    const broken = new Readable({
      read() {
        this.push(Buffer.from(filterChunk + '\n\n'));
        this.push(Buffer.from(usageChunk + '\n\n'));
        this.destroy(new Error('read ECONNRESET'));
      },
    });
    const request = vi.fn().mockResolvedValueOnce({ data: broken });
    const err = await thrown(drain(makeProvider(request).generateCompletionStream(MODEL, messages, {})));
    expect(err.code).toBe('content_filter');
    expect((err.details as { usage?: { promptTokens: number } }).usage?.promptTokens).toBe(120);
    expect((err.details as { readError?: { message: string } }).readError?.message).toContain('ECONNRESET');
  });

  it('a refusal error event before text throws the decline', async () => {
    const request = vi.fn().mockResolvedValueOnce({ data: sse([refusalEvent, 'data: [DONE]']) });
    const err = await thrown(drain(makeProvider(request).generateCompletionStream(MODEL, messages, {})));
    expect(err.code).toBe('content_filter');
    expect((err.details as { httpStatus?: number }).httpStatus).toBe(403);
  });

  it('a refusal error event that carries usage keeps it on the decline', async () => {
    const withUsage = chunk({ error: { code: 403, message: 'refused', metadata: { error_type: 'refusal' } }, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }], usage: USAGE });
    const request = vi.fn().mockResolvedValueOnce({ data: sse([withUsage, 'data: [DONE]']) });
    const err = await thrown(drain(makeProvider(request).generateCompletionStream(MODEL, messages, {})));
    expect(err.code).toBe('content_filter');
    expect((err.details as { usage?: { promptTokens: number } }).usage?.promptTokens).toBe(120);
  });

  it('an error event with code 403 and no error_type is an in-body decline (the stream is a 200)', async () => {
    const bare403 = chunk({ error: { code: 403, message: 'Forbidden' }, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }] });
    const request = vi.fn().mockResolvedValueOnce({ data: sse([bare403, 'data: [DONE]']) });
    const err = await thrown(drain(makeProvider(request).generateCompletionStream(MODEL, messages, {})));
    expect(err.code).toBe('content_policy_violation');
    expect(err.openRouterErrorType).toBe('in_body_403');
  });

  it('a non-decline error event still yields the upstream_error chunk and ends the stream', async () => {
    const request = vi.fn().mockResolvedValueOnce({ data: sse([textChunk('a'), upstreamEvent, textChunk('never')]) });
    const out = (await drain(makeProvider(request).generateCompletionStream(MODEL, messages, {}))) as Array<{ error?: { type?: string }; responseTextDelta?: string }>;
    expect(out.map((c) => c.responseTextDelta ?? c.error?.type)).toEqual(['a', 'upstream_error']);
  });

  it('an unparseable chunk is still skipped', async () => {
    const request = vi.fn().mockResolvedValueOnce({ data: sse(['data: {not json', textChunk('ok'), chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }), usageChunk, 'data: [DONE]']) });
    const out = (await drain(makeProvider(request).generateCompletionStream(MODEL, messages, {}))) as Array<{ responseTextDelta?: string }>;
    expect(out.some((c) => c.responseTextDelta === 'ok')).toBe(true);
  });

  it('an abort during the usage wait yields the abort chunk and throws nothing, even when no further line arrives', async () => {
    // The filter line is handled (the decline is held), then the caller aborts
    // and the stream ends. Only a held decline can throw here, so a clean drain
    // proves the abort won.
    const controller = new AbortController();
    const request = vi.fn().mockResolvedValueOnce({ data: gated([filterChunk, () => controller.abort()]) });
    const out = (await drain(makeProvider(request).generateCompletionStream(MODEL, messages, { abortSignal: controller.signal }))) as Array<{ error?: { type?: string } }>;
    expect(out).toHaveLength(1);
    expect(out[0]?.error?.type).toBe('abort');
  });

  it('an abort after the usage chunk arrived keeps that usage on the abort chunk', async () => {
    const controller = new AbortController();
    const request = vi.fn().mockResolvedValueOnce({ data: gated([filterChunk, usageChunk, () => controller.abort(), 'data: [DONE]']) });
    const out = (await drain(makeProvider(request).generateCompletionStream(MODEL, messages, { abortSignal: controller.signal }))) as Array<{ error?: { type?: string }; isFinal?: boolean; usage?: { promptTokens: number } }>;
    expect(out).toHaveLength(1);
    expect(out[0]?.error?.type).toBe('abort');
    expect(out[0]?.isFinal).toBe(true);
    expect(out[0]?.usage?.promptTokens).toBe(120);
  });

  it('an abort that lands before the usage line still reports that line on the abort chunk', async () => {
    // The usual order: the finish is held, the caller aborts, and the usage
    // line is the next thing read. That line is what the wait was for.
    const controller = new AbortController();
    const request = vi.fn().mockResolvedValueOnce({ data: gated([filterChunk, () => controller.abort(), usageChunk, 'data: [DONE]']) });
    const out = (await drain(makeProvider(request).generateCompletionStream(MODEL, messages, { abortSignal: controller.signal }))) as Array<{ error?: { type?: string }; usage?: { promptTokens: number } }>;
    expect(out).toHaveLength(1);
    expect(out[0]?.error?.type).toBe('abort');
    expect(out[0]?.usage?.promptTokens).toBe(120);
  });

  it('an abort before the first chunk closes the response stream', async () => {
    const controller = new AbortController();
    controller.abort();
    const body = sse([textChunk('never')]) as Readable;
    const request = vi.fn().mockResolvedValueOnce({ data: body });
    const out = (await drain(makeProvider(request).generateCompletionStream(MODEL, messages, { abortSignal: controller.signal }))) as Array<{ error?: { type?: string } }>;
    expect(out).toHaveLength(1);
    expect(out[0]?.error?.type).toBe('abort');
    expect(body.destroyed).toBe(true);
  });

  it('a non-decline error event during the usage wait does not replace the held decline', async () => {
    const request = vi.fn().mockResolvedValueOnce({ data: sse([filterChunk, usageChunk, upstreamEvent, 'data: [DONE]']) });
    const gen = makeProvider(request).generateCompletionStream(MODEL, messages, {});
    const seen: Array<{ error?: { type?: string } }> = [];
    let caught: OpenRouterProviderError | undefined;
    try {
      for await (const c of gen) seen.push(c as { error?: { type?: string } });
    } catch (e) {
      caught = e as OpenRouterProviderError;
    }
    expect(seen).toEqual([]);
    expect(caught?.code).toBe('content_filter');
    const d = caught?.details as { usage?: { promptTokens: number }; readError?: { message: string } };
    expect(d.usage?.promptTokens).toBe(120);
    expect(d.readError?.message).toContain('Provider disconnected');
  });

  it('a line that parses but is not a completion chunk is skipped, as before', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      data: sse([
        'data: null',
        'data: {"id":"g","object":"chat.completion.chunk"}',
        textChunk('ok'),
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        usageChunk,
        'data: [DONE]',
      ]),
    });
    const out = (await drain(makeProvider(request).generateCompletionStream(MODEL, messages, {}))) as Array<{ responseTextDelta?: string; usage?: { promptTokens: number } }>;
    expect(out.some((c) => c.responseTextDelta === 'ok')).toBe(true);
    expect(out.at(-1)?.usage?.promptTokens).toBe(120);
  });

  it('a stream that delivered more than 2,000 characters carries at most 2,000 as partial text', async () => {
    const request = vi.fn().mockResolvedValueOnce({ data: sse([textChunk('x'.repeat(2500)), filterChunk, usageChunk, 'data: [DONE]']) });
    const err = await thrown(drain(makeProvider(request).generateCompletionStream(MODEL, messages, {})));
    expect(err.code).toBe('content_filter');
    expect((err.details as { partialText?: string }).partialText).toBe('x'.repeat(2000));
  });

  it('partial text is the first 2,000 characters delivered, in order, across many chunks', async () => {
    const deltas = ['a'.repeat(1500), 'b'.repeat(1500), 'c'.repeat(9000), 'd'.repeat(9000)];
    const request = vi.fn().mockResolvedValueOnce({ data: sse([...deltas.map(textChunk), filterChunk, usageChunk, 'data: [DONE]']) });
    const err = await thrown(drain(makeProvider(request).generateCompletionStream(MODEL, messages, {})));
    expect((err.details as { partialText?: string }).partialText).toBe('a'.repeat(1500) + 'b'.repeat(500));
  });

  const errorEvent = (error: Record<string, unknown>) =>
    chunk({ error, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }] });

  it('puts the context-window code on a stream error chunk', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      data: sse([errorEvent({ code: 400, message: 'too long', metadata: { error_type: 'context_length_exceeded' } })]),
    });
    const out = (await drain(makeProvider(request).generateCompletionStream(MODEL, messages, {}))) as Array<{ error?: { code?: unknown; type?: string } }>;
    expect(out.at(-1)?.error).toMatchObject({ type: 'upstream_error', code: 'CONTEXT_WINDOW_EXCEEDED' });
  });

  it('reports an in-stream 401 or 403 that is not a decline without the status prefix', async () => {
    // The 200 proves the configured key was accepted: the code describes an
    // upstream attempt, so the health registry must not read it as a status.
    for (const code of [401, 403]) {
      const request = vi.fn().mockResolvedValueOnce({
        data: sse([errorEvent({ code, message: 'Blocked upstream', metadata: { error_type: 'permission_denied' } })]),
      });
      const out = (await drain(makeProvider(request).generateCompletionStream(MODEL, messages, {}))) as Array<{ error?: { message?: string } }>;
      expect(out.at(-1)?.error?.message).toBe(`OpenRouter in-body error ${code}: Blocked upstream`);
    }
  });

  it('carries a string error code on a stream error chunk', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      data: sse([errorEvent({ code: 'server_error', message: 'Provider disconnected unexpectedly' })]),
    });
    const out = (await drain(makeProvider(request).generateCompletionStream(MODEL, messages, {}))) as Array<{ error?: { code?: unknown } }>;
    expect(out.at(-1)?.error?.code).toBe('server_error');
  });

  it('puts the context-window code on a stream error chunk when the envelope type names it', async () => {
    const request = vi.fn().mockResolvedValueOnce({
      data: sse([errorEvent({ code: 400, message: 'too long', type: 'context_length_exceeded' })]),
    });
    const out = (await drain(makeProvider(request).generateCompletionStream(MODEL, messages, {}))) as Array<{ error?: { code?: unknown } }>;
    expect(out.at(-1)?.error?.code).toBe('CONTEXT_WINDOW_EXCEEDED');
  });
});
