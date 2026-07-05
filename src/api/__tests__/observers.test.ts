/**
 * Tests for the global LLM usage observer registration and dispatch.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  setGlobalLlmObserver,
  getGlobalLlmObserver,
  fireLlmUsageObserver,
} from '../observers.js';
import type { LlmUsageEvent } from '../observers.js';

function makeEvent(overrides?: Partial<LlmUsageEvent>): LlmUsageEvent {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    usage: {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      costUSD: 0.012,
    },
    source: 'unit-test',
    finishReason: 'stop',
    surface: 'generateText',
    ...overrides,
  };
}

beforeEach(() => {
  setGlobalLlmObserver(null);
});

afterEach(() => {
  setGlobalLlmObserver(null);
});

describe('setGlobalLlmObserver / getGlobalLlmObserver', () => {
  it('returns null when no observer is registered', () => {
    expect(getGlobalLlmObserver()).toBeNull();
  });

  it('registers and retrieves the observer', () => {
    const obs = vi.fn();
    setGlobalLlmObserver(obs);
    expect(getGlobalLlmObserver()).toBe(obs);
  });

  it('clears the observer when null is passed', () => {
    setGlobalLlmObserver(vi.fn());
    setGlobalLlmObserver(null);
    expect(getGlobalLlmObserver()).toBeNull();
  });

  it('replaces an existing observer (last writer wins)', () => {
    const first = vi.fn();
    const second = vi.fn();
    setGlobalLlmObserver(first);
    setGlobalLlmObserver(second);
    expect(getGlobalLlmObserver()).toBe(second);
  });
});

describe('fireLlmUsageObserver', () => {
  it('no-ops when no observer is registered (does not throw)', () => {
    expect(() => fireLlmUsageObserver(makeEvent())).not.toThrow();
  });

  it('passes the full event payload to the observer', () => {
    const obs = vi.fn();
    setGlobalLlmObserver(obs);
    const event = makeEvent({ source: 'narrator_turn' });
    fireLlmUsageObserver(event);
    expect(obs).toHaveBeenCalledTimes(1);
    expect(obs).toHaveBeenCalledWith(event);
  });

  it('swallows synchronous errors from the observer', () => {
    setGlobalLlmObserver(() => {
      throw new Error('observer crash');
    });
    expect(() => fireLlmUsageObserver(makeEvent())).not.toThrow();
  });

  it('swallows promise rejections from async observers', async () => {
    setGlobalLlmObserver(async () => {
      throw new Error('async observer crash');
    });
    expect(() => fireLlmUsageObserver(makeEvent())).not.toThrow();
    // Yield to the microtask queue so the rejection lands + gets swallowed.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('forwards source label and surface so hosts can route by meter', () => {
    const obs = vi.fn();
    setGlobalLlmObserver(obs);
    fireLlmUsageObserver(makeEvent({ source: 'companion_reply', surface: 'streamText' }));
    expect(obs.mock.calls[0][0].source).toBe('companion_reply');
    expect(obs.mock.calls[0][0].surface).toBe('streamText');
  });

  it('forwards latency + serving-host fields when present', () => {
    const obs = vi.fn();
    setGlobalLlmObserver(obs);
    fireLlmUsageObserver(
      makeEvent({
        surface: 'streamText',
        durationMs: 8421,
        ttfbMs: 612,
        servingProvider: 'Groq',
      }),
    );
    const seen = obs.mock.calls[0][0];
    expect(seen.durationMs).toBe(8421);
    expect(seen.ttfbMs).toBe(612);
    expect(seen.servingProvider).toBe('Groq');
  });

  it('leaves latency fields undefined when the surface did not measure them', () => {
    const obs = vi.fn();
    setGlobalLlmObserver(obs);
    fireLlmUsageObserver(makeEvent());
    const seen = obs.mock.calls[0][0];
    expect(seen.durationMs).toBeUndefined();
    expect(seen.ttfbMs).toBeUndefined();
    expect(seen.servingProvider).toBeUndefined();
  });

  it('forwards cache-token fields when present on usage', () => {
    const obs = vi.fn();
    setGlobalLlmObserver(obs);
    fireLlmUsageObserver(
      makeEvent({
        usage: {
          promptTokens: 1000,
          completionTokens: 50,
          totalTokens: 1050,
          costUSD: 0.005,
          cacheReadTokens: 800,
          cacheCreationTokens: 200,
        },
      }),
    );
    expect(obs.mock.calls[0][0].usage.cacheReadTokens).toBe(800);
    expect(obs.mock.calls[0][0].usage.cacheCreationTokens).toBe(200);
  });
});
