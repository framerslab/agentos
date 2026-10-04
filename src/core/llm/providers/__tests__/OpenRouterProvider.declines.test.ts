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

describe('classifyOpenRouterDecline (R1)', () => {
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

describe('the decline error (R2)', () => {
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

describe('HTTP error responses (R3)', () => {
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
});

describe('HTTP 200 bodies, non-stream (R4)', () => {
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
        choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'error',
          error: { code: 403, message: 'refused', metadata: { error_type: 'refusal' } } }],
        usage: USAGE,
      },
    });
    const err = await thrown(makeProvider(request).generateCompletion(MODEL, messages, {}));
    expect(err.code).toBe('content_filter');
    expect((err.details as { usage?: { promptTokens: number } }).usage?.promptTokens).toBe(120);
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
});
