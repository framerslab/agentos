import { describe, expect, it } from 'vitest';
import { classifyKeyFailure, isQuotaError, retryAfterMs } from '../quotaErrors.js';

const anthropic = (type: string, message = 'x') => JSON.stringify({ type: 'error', error: { type, message } });
const openai = (type: string, code?: string) => JSON.stringify({ error: { message: 'x', type, code: code ?? null } });

describe('classifyKeyFailure', () => {
  it('reads 401 as auth whatever the body', () => {
    expect(classifyKeyFailure(401, '')).toBe('auth');
    expect(classifyKeyFailure(401, 'not json')).toBe('auth');
    expect(classifyKeyFailure(401, anthropic('authentication_error'))).toBe('auth');
  });

  it('reads 403 as auth only for a key-scoped envelope', () => {
    expect(classifyKeyFailure(403, anthropic('authentication_error'))).toBe('auth');
    expect(classifyKeyFailure(403, openai('invalid_request_error', 'invalid_api_key'))).toBe('auth');
    // A resource-scoped denial (a model or a feature the key may not use) is not the key's fault.
    expect(classifyKeyFailure(403, anthropic('permission_error', 'Your API key does not have permission to use the specified resource.'))).toBeNull();
    expect(classifyKeyFailure(403, openai('invalid_request_error', 'insufficient_permissions'))).toBeNull();
    expect(classifyKeyFailure(403, anthropic('invalid_request_error', 'model not available in your region'))).toBeNull();
    expect(classifyKeyFailure(403, '')).toBeNull();
  });

  it('reads 402 as billing and 429 as quota unless the envelope says insufficient_quota', () => {
    expect(classifyKeyFailure(402, '')).toBe('billing');
    expect(classifyKeyFailure(429, anthropic('rate_limit_error'))).toBe('quota');
    expect(classifyKeyFailure(429, '')).toBe('quota');
    expect(classifyKeyFailure(429, openai('insufficient_quota', 'insufficient_quota'))).toBe('billing');
    expect(classifyKeyFailure(429, openai('insufficient_quota'))).toBe('billing');
    expect(classifyKeyFailure(456, '')).toBe('quota');
  });

  it("reads Anthropic's credit-balance 400 as billing and every other 400 as not the key's fault", () => {
    const credit = anthropic(
      'invalid_request_error',
      'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
    );
    expect(classifyKeyFailure(400, credit)).toBe('billing');
    expect(classifyKeyFailure(400, anthropic('invalid_request_error', 'max_tokens: must be positive'))).toBeNull();
    expect(classifyKeyFailure(400, 'Your credit balance is too low (plain text, not an envelope)')).toBeNull();
    expect(classifyKeyFailure(400, '')).toBeNull();
  });

  it("reads Google's invalid-key 400 and Requesty's bad-token 403 as auth, and leaves another Google 400 alone", () => {
    // The envelopes as the APIs answered a bogus key on 17 Oct 2026.
    const geminiInvalidKey = JSON.stringify({
      error: {
        code: 400,
        message: 'API key not valid. Please pass a valid API key.',
        status: 'INVALID_ARGUMENT',
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }],
      },
    });
    expect(classifyKeyFailure(400, geminiInvalidKey)).toBe('auth');
    const geminiBadRequest = JSON.stringify({ error: { code: 400, message: 'Invalid JSON payload received.', status: 'INVALID_ARGUMENT' } });
    expect(classifyKeyFailure(400, geminiBadRequest)).toBeNull();
    expect(classifyKeyFailure(403, JSON.stringify({ error: { origin: 'router', message: 'Invalid authorization token' } }))).toBe('auth');
    expect(classifyKeyFailure(401, JSON.stringify({ error: { message: 'Missing Authentication header', code: 401 } }))).toBe('auth');
  });

  it('never classifies 404, 5xx or a success', () => {
    expect(classifyKeyFailure(404, anthropic('not_found_error'))).toBeNull();
    expect(classifyKeyFailure(500, anthropic('api_error'))).toBeNull();
    expect(classifyKeyFailure(529, anthropic('overloaded_error'))).toBeNull();
    expect(classifyKeyFailure(200, '')).toBeNull();
  });

  it('keeps isQuotaError unchanged for the broad rotation path', () => {
    expect(isQuotaError(429, '')).toBe(true);
    expect(isQuotaError(402, '')).toBe(true);
    expect(isQuotaError(401, '{"detail":{"status":"quota_exceeded"}}')).toBe(true);
    expect(isQuotaError(400, '')).toBe(false);
  });
});

describe('retryAfterMs', () => {
  const now = Date.UTC(2026, 9, 17, 12, 0, 0);

  it('reads delta-seconds and bounds them', () => {
    expect(retryAfterMs('2', now)).toBe(2000);
    expect(retryAfterMs(' 30 ', now)).toBe(30_000);
    expect(retryAfterMs('86400', now)).toBe(60 * 60_000);
    expect(retryAfterMs('86400', now, 5000)).toBe(5000);
  });

  it('reads an HTTP-date as the delta from now, never negative', () => {
    expect(retryAfterMs(new Date(now + 90_000).toUTCString(), now)).toBe(90_000);
    expect(retryAfterMs(new Date(now - 90_000).toUTCString(), now)).toBe(0);
  });

  it('rejects a missing or malformed header so the caller falls back to its own backoff', () => {
    expect(retryAfterMs(null, now)).toBeNull();
    expect(retryAfterMs(undefined, now)).toBeNull();
    expect(retryAfterMs('', now)).toBeNull();
    expect(retryAfterMs('soon', now)).toBeNull();
    expect(retryAfterMs('12abc', now)).toBeNull();
    expect(retryAfterMs('-5', now)).toBeNull();
  });
});
