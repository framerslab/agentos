import { describe, it, expect, vi } from 'vitest';
import { LLMProviderHealthRegistry } from '../LLMProviderHealthRegistry';

/** classifyErrorStatus reads `.statusCode` off the error object. */
const err = (status: number) => ({ statusCode: status });

describe('LLMProviderHealthRegistry — client-error 4xx must not trip the breaker', () => {
  it('does not trip on repeated 400 bad-request errors (the provider is healthy)', () => {
    const reg = new LLMProviderHealthRegistry();
    for (let i = 0; i < 10; i++) reg.recordFailure('openai', err(400));
    expect(reg.isOpen('openai')).toBe(false);
  });

  it('does not trip on repeated 404 model-not-found errors', () => {
    const reg = new LLMProviderHealthRegistry();
    for (let i = 0; i < 10; i++) reg.recordFailure('openai', err(404));
    expect(reg.isOpen('openai')).toBe(false);
  });

  it('does not let client 4xx inflate the streak a transient 5xx then trips on', () => {
    const reg = new LLMProviderHealthRegistry();
    for (let i = 0; i < 4; i++) reg.recordFailure('openai', err(422)); // ignored
    reg.recordFailure('openai', err(500)); // one real transient failure, below threshold (5)
    expect(reg.isOpen('openai')).toBe(false);
  });

  // Regression guards — account-level + transient classes must STILL trip.
  it('still trips on account-level 402 after one failure', () => {
    const reg = new LLMProviderHealthRegistry();
    reg.recordFailure('openrouter', err(402));
    expect(reg.isOpen('openrouter')).toBe(true);
  });

  it('still trips on 401/403 after one failure', () => {
    const reg = new LLMProviderHealthRegistry();
    reg.recordFailure('openai', err(401));
    expect(reg.isOpen('openai')).toBe(true);
  });

  it('still trips on transient 5xx once the threshold is reached', () => {
    const reg = new LLMProviderHealthRegistry();
    for (let i = 0; i < 5; i++) reg.recordFailure('openai', err(503));
    expect(reg.isOpen('openai')).toBe(true);
  });
});

describe('LLMProviderHealthRegistry: content-policy declines are not provider failures', () => {
  /** The shape of a refusal error: a content_filter code and no HTTP status. */
  const decline = () => ({ code: 'content_filter', message: 'Claude declined the request.' });

  it('stays closed after repeated declines, which carry no HTTP status', () => {
    const reg = new LLMProviderHealthRegistry();
    for (let i = 0; i < 10; i++) reg.recordFailure('anthropic', decline());
    expect(reg.isOpen('anthropic')).toBe(false);
  });

  it('does not let declines inflate the streak a transient 5xx then trips on', () => {
    const reg = new LLMProviderHealthRegistry();
    for (let i = 0; i < 4; i++) reg.recordFailure('anthropic', decline());
    reg.recordFailure('anthropic', err(503)); // one real transient failure, below threshold (5)
    expect(reg.isOpen('anthropic')).toBe(false);
  });
});

describe('LLMProviderHealthRegistry — quota exhaustion rides the billing class', () => {
  /** OpenAI reports a dead account as HTTP 429 + insufficient_quota. */
  const quotaErr = () => ({
    statusCode: 429,
    code: 'insufficient_quota',
    message:
      'You exceeded your current quota, please check your plan and billing details.',
  });

  it('trips after a SINGLE quota-exhaustion failure (not the 429 streak threshold)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const reg = new LLMProviderHealthRegistry();
      reg.recordFailure('openai', quotaErr());
      expect(reg.isOpen('openai')).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('emits the error-level billing-class event naming quota exhaustion', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const reg = new LLMProviderHealthRegistry();
      reg.recordFailure('openai', quotaErr());
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [message, detail] = errorSpy.mock.calls[0] as [string, Record<string, unknown>];
      expect(message).toContain('quota exhausted');
      expect(detail).toMatchObject({ event: 'provider_breaker_open', providerId: 'openai' });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('trips on the real OpenAIProviderError shape (httpStatus + openaiErrorCode, no statusCode/prefix)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const reg = new LLMProviderHealthRegistry();
      // The provider's thrown shape during the 2026-07 outage: status in
      // httpStatus, code in openaiErrorCode, message without [NNN] prefix.
      reg.recordFailure('openai', {
        httpStatus: 429,
        openaiErrorCode: 'insufficient_quota',
        message:
          'You exceeded your current quota, please check your plan and billing details.',
      });
      expect(reg.isOpen('openai')).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('trips on a quota-shaped error even when no status field is classifiable', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const reg = new LLMProviderHealthRegistry();
      reg.recordFailure('openai', {
        message: 'You exceeded your current quota, please check your plan and billing details.',
      });
      expect(reg.isOpen('openai')).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('detects the nested OpenAI SDK body shape (error.error.code)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const reg = new LLMProviderHealthRegistry();
      reg.recordFailure('openai', {
        status: 429,
        error: { code: 'insufficient_quota' },
        message: 'Request failed',
      });
      expect(reg.isOpen('openai')).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('leaves a plain 429 rate limit in the transient class (no single-failure trip)', () => {
    const reg = new LLMProviderHealthRegistry();
    reg.recordFailure('openai', {
      statusCode: 429,
      message: 'Rate limit reached for requests. Please try again in 20s.',
    });
    expect(reg.isOpen('openai')).toBe(false);
  });
});

describe('LLMProviderHealthRegistry — loud breaker-open events', () => {
  it('emits an error-level structured event when a policy-class breaker opens', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const reg = new LLMProviderHealthRegistry();
      reg.recordFailure('anthropic', err(401));
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [message, detail] = errorSpy.mock.calls[0] as [string, Record<string, unknown>];
      expect(message).toContain("breaker OPEN for 'anthropic'");
      expect(message).toContain('diverts to fallbacks');
      expect(detail).toMatchObject({
        event: 'provider_breaker_open',
        providerId: 'anthropic',
        statusCode: 401,
      });
      // Failures while the breaker is ALREADY open must not re-emit —
      // one page per trip, not one per rejected call.
      reg.recordFailure('anthropic', err(401));
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('emits a warn-level event for availability trips (5xx streak)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const reg = new LLMProviderHealthRegistry();
      for (let i = 0; i < 5; i++) reg.recordFailure('openai', err(503));
      expect(errorSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [message, detail] = warnSpy.mock.calls[0] as [string, Record<string, unknown>];
      expect(message).toContain("breaker OPEN for 'openai'");
      expect(detail).toMatchObject({ event: 'provider_breaker_open', statusCode: 503 });
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

describe('LLMProviderHealthRegistry — quota exhaustion wearing client-error statuses', () => {
  /**
   * Anthropic reports credit exhaustion as HTTP 400 invalid_request_error.
   * AnthropicProviderError carries the status in `httpStatus`; there is no
   * [NNN] message prefix, no statusCode/status property, and none of the
   * OpenAI insufficient_quota marks — only the distinctive message.
   */
  const anthropicCreditErr = () => ({
    httpStatus: 400,
    type: 'invalid_request_error',
    message:
      'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
  });

  it('trips the billing breaker after a SINGLE Anthropic credit-exhaustion 400', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const reg = new LLMProviderHealthRegistry();
      reg.recordFailure('anthropic', anthropicCreditErr());
      expect(reg.isOpen('anthropic')).toBe(true);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect((errorSpy.mock.calls[0] as [string])[0]).toContain('quota exhausted');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("trips the billing breaker after a SINGLE Anthropic spend-limit 400, as after the credit-balance 400", () => {
    // A spend limit the operator set on the organization or a workspace (platform.claude.com/docs/en/api/rate-limits,
    // read 18 October 2026): HTTP 400 invalid_request_error, the account's outage until the limit is raised.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const message of [
        'You have reached your specified workspace API usage limits. You will regain access when the limit resets.',
        'You have reached your specified API usage limits. You will regain access when the limit resets.',
      ]) {
        const reg = new LLMProviderHealthRegistry();
        reg.recordFailure('anthropic', { httpStatus: 400, type: 'invalid_request_error', message });
        expect(reg.isOpen('anthropic')).toBe(true);
      }
      expect(errorSpy).toHaveBeenCalledTimes(2);
      expect((errorSpy.mock.calls[0] as [string])[0]).toContain('quota exhausted');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("leaves a request's own 400 that names usage limits to the caller: the spend-limit words are matched by their opening", () => {
    const reg = new LLMProviderHealthRegistry();
    for (let i = 0; i < 10; i++) {
      reg.recordFailure('anthropic', { httpStatus: 400, type: 'invalid_request_error', message: 'Invalid api usage limits parameter' });
    }
    expect(reg.isOpen('anthropic')).toBe(false);
  });

  it("trips the billing breaker on a single 429 for the tier's monthly spend cap instead of counting it toward the 429 streak", () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const reg = new LLMProviderHealthRegistry();
      reg.recordFailure('anthropic', {
        httpStatus: 429,
        anthropicErrorType: 'rate_limit_error',
        message: 'You have reached your API usage limits: your organization has crossed its monthly API usage threshold.',
      });
      const stats = reg.getStats('anthropic');
      expect(stats).toMatchObject({ state: 'open', totalTrips: 1 });
      // The billing class's window (5 minutes), not the 429 class's 30 seconds after a third failure.
      expect(stats!.cooldownRemainingMs).toBeGreaterThan(4 * 60_000);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('reads the error envelope a provider error carries, as the key pool does, whatever the message says', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // The answer body rides in `details` (AnthropicProviderError): a 429 whose error_code is the cap's is billing.
      const capped = new LLMProviderHealthRegistry();
      capped.recordFailure('anthropic', {
        httpStatus: 429,
        message: 'Request failed',
        details: { type: 'error', error: { type: 'rate_limit_error', message: 'Request failed', details: { error_code: 'enforced_spend_limit_reached' } } },
      });
      expect(capped.isOpen('anthropic')).toBe(true);
      // A throttle's 429 still counts toward the streak, and a request's own 400 is still the caller's.
      const throttled = new LLMProviderHealthRegistry();
      throttled.recordFailure('anthropic', {
        httpStatus: 429,
        message: 'Request failed',
        details: { type: 'error', error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your per-minute rate limit' } },
      });
      expect(throttled.isOpen('anthropic')).toBe(false);
      const badRequest = new LLMProviderHealthRegistry();
      for (let i = 0; i < 10; i++) {
        badRequest.recordFailure('anthropic', {
          httpStatus: 400,
          message: 'Request failed',
          details: { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: 200000 is greater than the model maximum' } },
        });
      }
      expect(badRequest.isOpen('anthropic')).toBe(false);
      // A details object that cannot be serialized is no billing evidence and no crash.
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const odd = new LLMProviderHealthRegistry();
      odd.recordFailure('anthropic', { httpStatus: 400, message: 'Request failed', details: circular });
      expect(odd.isOpen('anthropic')).toBe(false);
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('still ignores a plain 400 bad-request carried in httpStatus (no quota shape)', () => {
    const reg = new LLMProviderHealthRegistry();
    for (let i = 0; i < 10; i++) {
      reg.recordFailure('anthropic', {
        httpStatus: 400,
        type: 'invalid_request_error',
        message: 'max_tokens: 200000 is greater than the model maximum',
      });
    }
    expect(reg.isOpen('anthropic')).toBe(false);
  });

  it('recognizes the billing_error type mark regardless of transport status', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const reg = new LLMProviderHealthRegistry();
      reg.recordFailure('anthropic', {
        httpStatus: 403,
        type: 'billing_error',
        message: 'There is a billing issue with your account.',
      });
      expect(reg.isOpen('anthropic')).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('classifyErrorStatus — the httpStatus shape is load-bearing on its own', () => {
  it('classifies a bare-httpStatus 401 into the auth class (single-failure trip)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const reg = new LLMProviderHealthRegistry();
      // No [NNN] prefix, no statusCode/status, no quota marks: only the
      // httpStatus branch can classify this error. Deleting that branch
      // leaves status null -> transient class (threshold 5) and this
      // single-failure trip assertion fails.
      reg.recordFailure('openai', { httpStatus: 401, message: 'Unauthorized' });
      expect(reg.isOpen('openai')).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('LLMProviderHealthRegistry: a key pool whose recheck is due has no verdict yet', () => {
  /**
   * The ALL_KEYS_FAILED a provider throws before it sends anything once every key of its pool is out: the status of
   * the kind that took the keys out, the kinds, and the soonest a key may come back.
   */
  const allKeysFailed = (retryAfterMs: number) => ({
    code: 'ALL_KEYS_FAILED',
    httpStatus: 401,
    message: 'Every Anthropic API key is out of rotation (auth).',
    details: { kinds: ['auth'], retryAfterMs },
  });

  it('ignores one whose retryAfterMs is 0, since a probe of a key is due or running', () => {
    const reg = new LLMProviderHealthRegistry();
    for (let i = 0; i < 10; i++) reg.recordFailure('anthropic', allKeysFailed(0));
    expect(reg.isOpen('anthropic')).toBe(false);
    expect(reg.getStats('anthropic')).toBeNull();
  });

  it('trips on one whose keys come back later, as on the answer that took them out', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const reg = new LLMProviderHealthRegistry();
      reg.recordFailure('anthropic', allKeysFailed(30 * 60_000));
      expect(reg.isOpen('anthropic')).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
