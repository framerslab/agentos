/**
 * @fileoverview GenAI semconv span-attribute tests (spec batch-1 C1).
 * Attribute names are pinned to semantic-conventions-genai commit
 * c26a2c21d1ee70d5231bd440c7b48d3c94ee506a (no upstream release tags) —
 * these tests assert the enumerated names, not a moving upstream.
 */
import { describe, it, expect } from 'vitest';
import { attachGenAiAttributes, toTurnMetricUsage } from '../observability.js';
import type { Span } from '@opentelemetry/api';

function fakeSpan() {
  const attrs: Record<string, unknown> = {};
  return {
    attrs,
    span: { setAttribute(k: string, v: unknown) { attrs[k] = v; } } as unknown as Span,
  };
}

describe('attachGenAiAttributes', () => {
  it('emits the pinned semconv attribute set', () => {
    const { attrs, span } = fakeSpan();
    attachGenAiAttributes(span, {
      providerName: 'openai',
      operationName: 'chat',
      requestModel: 'gpt-5.6',
      responseModel: 'gpt-5.6-2026-05-01',
      usage: {
        inclusiveInputTokens: 550,
        completionTokens: 20,
        cacheReadTokens: 400,
        cacheCreationTokens: 50,
      },
    });
    expect(attrs['gen_ai.provider.name']).toBe('openai');
    expect(attrs['gen_ai.operation.name']).toBe('chat');
    expect(attrs['gen_ai.request.model']).toBe('gpt-5.6');
    expect(attrs['gen_ai.response.model']).toBe('gpt-5.6-2026-05-01');
    expect(attrs['gen_ai.usage.input_tokens']).toBe(550);
    expect(attrs['gen_ai.usage.output_tokens']).toBe(20);
    expect(attrs['gen_ai.usage.cache_read.input_tokens']).toBe(400);
    expect(attrs['gen_ai.usage.cache_creation.input_tokens']).toBe(50);
  });

  it('preserves reported zeros and omits absent fields', () => {
    const { attrs, span } = fakeSpan();
    attachGenAiAttributes(span, {
      providerName: 'anthropic',
      operationName: 'chat',
      requestModel: 'claude-sonnet-5',
      usage: { cacheReadTokens: 0 },
    });
    expect(attrs['gen_ai.usage.cache_read.input_tokens']).toBe(0);
    expect('gen_ai.response.model' in attrs).toBe(false);
    expect('gen_ai.usage.input_tokens' in attrs).toBe(false);
    expect('gen_ai.usage.output_tokens' in attrs).toBe(false);
  });

  it('no-ops on a null span', () => {
    expect(() =>
      attachGenAiAttributes(null, {
        providerName: 'openai',
        operationName: 'chat',
        requestModel: 'gpt-5.6',
      }),
    ).not.toThrow();
  });
});

describe('toTurnMetricUsage cache passthrough', () => {
  it('forwards cache token fields for the turn metrics', () => {
    const mapped = toTurnMetricUsage({
      promptTokens: 100,
      completionTokens: 10,
      totalTokens: 110,
      cacheReadTokens: 64,
      cacheCreationTokens: 40,
    });
    expect(mapped?.cacheReadTokens).toBe(64);
    expect(mapped?.cacheCreationTokens).toBe(40);
  });

  it('preserves a reported zero cache count', () => {
    const mapped = toTurnMetricUsage({ cacheReadTokens: 0 });
    expect(mapped).toBeDefined();
    expect(mapped?.cacheReadTokens).toBe(0);
  });
});
