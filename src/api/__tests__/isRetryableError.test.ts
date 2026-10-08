import { describe, it, expect } from 'vitest';
import { isRetryableError } from '../generateText';
import { AnthropicProviderError } from '../../core/llm/providers/errors/AnthropicProviderError';

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

  it('matches request-level network and timeout failures by provider error code', () => {
    // OpenAIProvider rewrites an exhausted network failure as
    // "Network error: unable to reach <baseURL>", which carries no status.
    const network = Object.assign(new Error('unreachable'), { code: 'NETWORK_ERROR' });
    const timeout = Object.assign(new Error('Request timed out after 60000ms.'), { code: 'REQUEST_TIMEOUT' });
    expect(isRetryableError(network)).toBe(true);
    expect(isRetryableError(timeout)).toBe(true);
    expect(isRetryableError(new Error('Network error: unable to reach https://api.openai.com/v1.'))).toBe(true);
    expect(isRetryableError(new Error('read ECONNRESET'))).toBe(true);
  });

  it('does not restart a stream that failed after delivering text', () => {
    const idle = Object.assign(new Error('stream went quiet'), { code: 'STREAM_IDLE_TIMEOUT' });
    const incomplete = Object.assign(new Error('response incomplete'), { code: 'STREAM_INCOMPLETE' });
    expect(isRetryableError(idle)).toBe(false);
    expect(isRetryableError(incomplete)).toBe(false);
  });

  it('matches a provider that failed to initialize, whatever its cause', () => {
    const err = new Error("Provider 'openai' failed to initialize: OpenAIProvider initialization failed: boom");
    err.name = 'ProviderInitializationError';
    expect(isRetryableError(err)).toBe(true);
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

  it('matches an overloaded provider (HTTP 529), typed, grepped or reported mid-stream', () => {
    // Anthropic answers 529 `overloaded_error` when it has no capacity: the
    // request is fine and another provider may serve it. Not retryable, an
    // overloaded primary never reached its fallback legs.
    expect(isRetryableError(Object.assign(new Error('Overloaded'), { httpStatus: 529 }))).toBe(true);
    expect(isRetryableError(new Error('HTTP 529: Overloaded'))).toBe(true);
    expect(isRetryableError(new Error('overloaded_error: Overloaded'))).toBe(true);
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

  it('treats a context-window rejection as retryable, so a model with a larger window can serve it', () => {
    const err = Object.assign(new Error('[400] This endpoint maximum context length is 32768 tokens'), {
      httpStatus: 400,
      code: 'CONTEXT_WINDOW_EXCEEDED',
    });
    expect(isRetryableError(err)).toBe(true);
  });

  it('treats the stream error classes that report a server failure as retryable', () => {
    // A stream error event names its class, not an HTTP status: Anthropic's
    // api_error (500) and overloaded_error (529), OpenRouter's server_error.
    expect(isRetryableError(Object.assign(new Error('Internal server error'), { type: 'api_error' }))).toBe(true);
    expect(isRetryableError(Object.assign(new Error('busy'), { type: 'overloaded_error' }))).toBe(true);
    expect(isRetryableError(Object.assign(new Error('Provider disconnected unexpectedly'), { code: 'server_error' }))).toBe(true);
    expect(isRetryableError(Object.assign(new Error('bad field'), { type: 'invalid_request_error' }))).toBe(false);
  });

  it('reads the server-failure class AnthropicProviderError keeps for an SSE error event', () => {
    // The provider throws the event as an AnthropicProviderError with no
    // status; its class sits in anthropicErrorType, not in type.
    expect(isRetryableError(new AnthropicProviderError('Internal server error', 'STREAM_ERROR_EVENT', undefined, 'api_error'))).toBe(true);
    expect(isRetryableError(new AnthropicProviderError('busy', 'STREAM_ERROR_EVENT', undefined, 'overloaded_error'))).toBe(true);
    expect(isRetryableError(new AnthropicProviderError('bad field', 'STREAM_ERROR_EVENT', undefined, 'invalid_request_error'))).toBe(false);
  });
});
