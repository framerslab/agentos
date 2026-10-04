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
