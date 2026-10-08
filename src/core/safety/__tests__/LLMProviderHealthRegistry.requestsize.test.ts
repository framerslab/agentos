import { describe, it, expect } from 'vitest';
import { LLMProviderHealthRegistry } from '../LLMProviderHealthRegistry';

/** A request larger than the model's context window, with and without a status. */
const tooLarge = (status?: number) => ({
  code: 'CONTEXT_WINDOW_EXCEEDED',
  message: status ? `[${status}] too long` : 'too long',
  ...(status ? { httpStatus: status } : {}),
});

describe('LLMProviderHealthRegistry: a context-window rejection is not provider health', () => {
  it('never opens the breaker on repeated rejections, with or without a status', () => {
    const reg = new LLMProviderHealthRegistry();
    for (let i = 0; i < 10; i++) {
      reg.recordFailure('openrouter', tooLarge());
      reg.recordFailure('openrouter', tooLarge(503));
    }
    expect(reg.isOpen('openrouter')).toBe(false);
    expect(reg.getStats('openrouter')?.failureCount ?? 0).toBe(0);
  });

  it('does not add to the streak a later transient failure trips on', () => {
    const reg = new LLMProviderHealthRegistry();
    for (let i = 0; i < 4; i++) reg.recordFailure('openrouter', tooLarge(503));
    reg.recordFailure('openrouter', { statusCode: 500 });
    expect(reg.isOpen('openrouter')).toBe(false);
    expect(reg.getStats('openrouter')?.failureCount).toBe(1);
  });
});
