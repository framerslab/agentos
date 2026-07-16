import { describe, it, expect, vi } from 'vitest';
import {
  OpenRouterProvider,
  defaultOpenRouterProviderPrefs,
  mapOpenRouterUsage,
} from '../OpenRouterProvider';

describe('defaultOpenRouterProviderPrefs', () => {
  it('returns undefined when neither env is set (default routing stays byte-identical)', () => {
    expect(defaultOpenRouterProviderPrefs({})).toBeUndefined();
    expect(
      defaultOpenRouterProviderPrefs({
        OPENROUTER_PROVIDER_SORT: '',
        OPENROUTER_PROVIDER_ORDER: '  ',
      }),
    ).toBeUndefined();
  });

  it('returns a sort-only preference when only OPENROUTER_PROVIDER_SORT is set', () => {
    expect(
      defaultOpenRouterProviderPrefs({ OPENROUTER_PROVIDER_SORT: 'throughput' }),
    ).toEqual({ sort: 'throughput' });
  });

  it('pins an order with allow_fallbacks when OPENROUTER_PROVIDER_ORDER is set', () => {
    expect(
      defaultOpenRouterProviderPrefs({ OPENROUTER_PROVIDER_ORDER: 'Groq' }),
    ).toEqual({ order: ['Groq'], allow_fallbacks: true });
  });

  it('accepts each documented sort value', () => {
    for (const sort of ['price', 'throughput', 'latency']) {
      expect(defaultOpenRouterProviderPrefs({ OPENROUTER_PROVIDER_SORT: sort })).toEqual({
        sort,
      });
    }
  });

  it('ignores an unrecognized OPENROUTER_PROVIDER_SORT value', () => {
    expect(
      defaultOpenRouterProviderPrefs({ OPENROUTER_PROVIDER_SORT: 'cheapest' }),
    ).toBeUndefined();
  });

  it('keeps the order pin when the sort value is unrecognized', () => {
    expect(
      defaultOpenRouterProviderPrefs({
        OPENROUTER_PROVIDER_ORDER: 'Groq',
        OPENROUTER_PROVIDER_SORT: 'cheapest',
      }),
    ).toEqual({ order: ['Groq'], allow_fallbacks: true });
  });

  it('combines order and sort, trimming and dropping empty CSV entries', () => {
    expect(
      defaultOpenRouterProviderPrefs({
        OPENROUTER_PROVIDER_ORDER: ' Groq , DeepInfra ,, ',
        OPENROUTER_PROVIDER_SORT: 'throughput',
      }),
    ).toEqual({
      order: ['Groq', 'DeepInfra'],
      allow_fallbacks: true,
      sort: 'throughput',
    });
  });
});

describe('mapOpenRouterUsage', () => {
  it('returns undefined when the API response carries no usage', () => {
    expect(mapOpenRouterUsage(undefined)).toBeUndefined();
  });

  it('maps base token counts and cost without cache details', () => {
    expect(
      mapOpenRouterUsage({
        prompt_tokens: 1200,
        completion_tokens: 300,
        total_tokens: 1500,
        cost: 0.0042,
      }),
    ).toEqual({
      promptTokens: 1200,
      completionTokens: 300,
      totalTokens: 1500,
      costUSD: 0.0042,
    });
  });

  it('surfaces prompt_tokens_details.cached_tokens as cacheReadInputTokens', () => {
    const usage = mapOpenRouterUsage({
      prompt_tokens: 2000,
      completion_tokens: 150,
      total_tokens: 2150,
      cost: 0.003,
      prompt_tokens_details: { cached_tokens: 1800 },
    });
    expect(usage?.cacheReadInputTokens).toBe(1800);
    expect(usage?.promptTokens).toBe(2000);
  });

  it('omits cacheReadInputTokens when details are present but cached_tokens is absent', () => {
    const usage = mapOpenRouterUsage({
      prompt_tokens: 500,
      completion_tokens: 50,
      total_tokens: 550,
      prompt_tokens_details: {},
    });
    expect(usage).not.toHaveProperty('cacheReadInputTokens');
  });
});

describe('OpenRouterProvider session_id sticky routing', () => {
  it('forwards options.sessionId as session_id in the request body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'gen-1',
          object: 'chat.completion',
          created: 1,
          model: 'anthropic/claude-sonnet-4-6',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'hi' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    try {
      const provider = new OpenRouterProvider();
      await provider.initialize({ apiKey: 'sk-or-test' });
      await provider.generateCompletion(
        'anthropic/claude-sonnet-4-6',
        [{ role: 'user', content: 'hi' }],
        { sessionId: 'sess-abc123' },
      );
      const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      const init = calls[calls.length - 1]![1] as RequestInit;
      const body = JSON.parse(init.body as string);
      expect(body.session_id).toBe('sess-abc123');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('omits session_id when no sessionId option is passed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'gen-2',
          object: 'chat.completion',
          created: 1,
          model: 'anthropic/claude-sonnet-4-6',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'hi' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    try {
      const provider = new OpenRouterProvider();
      await provider.initialize({ apiKey: 'sk-or-test' });
      await provider.generateCompletion(
        'anthropic/claude-sonnet-4-6',
        [{ role: 'user', content: 'hi' }],
        {},
      );
      const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      const init = calls[calls.length - 1]![1] as RequestInit;
      const body = JSON.parse(init.body as string);
      expect('session_id' in body).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
