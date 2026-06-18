import { describe, it, expect } from 'vitest';
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
