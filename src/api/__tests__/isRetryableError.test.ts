import { describe, it, expect } from 'vitest';
import { isRetryableError } from '../generateText';

describe('isRetryableError', () => {
  it('matches a typed provider error via numeric httpStatus 402', () => {
    const err = Object.assign(new Error('Payment required'), { httpStatus: 402 });
    expect(isRetryableError(err)).toBe(true);
  });

  it('matches HTTP status codes grepped from the message', () => {
    expect(isRetryableError(new Error('HTTP 429: rate limited'))).toBe(true);
    expect(isRetryableError(new Error('HTTP 503: Service Unavailable'))).toBe(true);
  });

  it('matches network-level failures', () => {
    expect(isRetryableError(new Error('fetch failed'))).toBe(true);
    expect(isRetryableError(new Error('connect ECONNREFUSED 127.0.0.1:443'))).toBe(true);
  });

  it('matches the existing credit / quota phrases', () => {
    expect(isRetryableError(new Error('This request requires more credits'))).toBe(true);
    expect(isRetryableError(new Error('Insufficient credits on your account'))).toBe(true);
    expect(isRetryableError(new Error('You exceeded your current quota'))).toBe(true);
  });

  it("matches Anthropic's 'credit balance is too low' billing message without an httpStatus field", () => {
    // Regression guard. Production audit 2026-05-20 (session
    // 3l-63NAZOz1- / redacted-world) caught AnthropicProviderError
    // "Your credit balance is too low to access the Anthropic API.
    // Please go to Plans & Billing to upgrade or purchase credits."
    // The typed AnthropicProviderError carries httpStatus 402 so the
    // numeric branch catches it — but any wrapped / re-thrown error
    // that loses the typed field falls through to message-grepping,
    // and none of the prior phrases ("requires more credits",
    // "insufficient credits", "quota") match Anthropic's exact
    // wording. Without this the fallback chain never fires and the
    // billing error escapes as a hard failure.
    const err = new Error(
      'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
    );
    expect(isRetryableError(err)).toBe(true);
  });

  it("matches a bare 'credit balance' phrase regardless of provider", () => {
    expect(isRetryableError(new Error('credit balance exhausted'))).toBe(true);
  });

  it('does not match a generic non-retryable error', () => {
    expect(isRetryableError(new Error('Invalid request: missing required field "model"'))).toBe(
      false,
    );
  });

  it('returns false for non-Error values', () => {
    expect(isRetryableError('a string')).toBe(false);
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
  });
});
