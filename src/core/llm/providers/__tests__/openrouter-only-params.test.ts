import { beforeEach, describe, expect, it, vi } from 'vitest';

// Provider initialize() may probe the vendor's models endpoint; these tests
// only exercise pure payload builders, so any network is stubbed benign.
vi.stubGlobal(
  'fetch',
  vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers(),
    json: async () => ({ data: [], models: [] }),
    text: async () => '{"data":[],"models":[]}',
  }) as unknown as Response),
);

import {
  OPENROUTER_ONLY_PARAM_KEYS,
  stripOpenRouterOnlyParams,
} from '../openrouter-only-params';
import { AnthropicProvider } from '../implementations/AnthropicProvider';
import { GeminiProvider } from '../implementations/GeminiProvider';
import { OpenAIProvider } from '../implementations/OpenAIProvider';
import type { ChatMessage } from '../IProvider';

/**
 * `customModelParams` is a single escape hatch shared by every provider, so a
 * fallback chain hands the SAME params object built for one host to the next
 * host's provider. OpenRouter's routing controls (`provider`, `models`,
 * `route`, `transforms`) are request-body fields only OpenRouter accepts —
 * blind-spread into a native vendor's REST body they 400 the call (the
 * 2026-07-09 production outage: `GeminiProviderError: Unknown name "provider"`
 * after an OpenRouter -> Gemini fallback dragged `{provider:{order:['Groq']}}`
 * along). Native providers must strip them; OpenRouterProvider keeps them.
 */

const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'hi' }];

const LEAKY_PARAMS = {
  provider: { order: ['Groq'], allow_fallbacks: true },
  models: ['meta-llama/llama-3.3-70b-instruct'],
  route: 'fallback',
  transforms: ['middle-out'],
  metadata: { user_id: 'u1' },
};

describe('stripOpenRouterOnlyParams', () => {
  it('drops exactly the OpenRouter routing controls and keeps everything else', () => {
    expect(stripOpenRouterOnlyParams(LEAKY_PARAMS)).toEqual({
      metadata: { user_id: 'u1' },
    });
  });

  it('returns undefined when nothing survives the strip', () => {
    expect(
      stripOpenRouterOnlyParams({ provider: { sort: 'throughput' }, route: 'fallback' }),
    ).toBeUndefined();
  });

  it('passes undefined through', () => {
    expect(stripOpenRouterOnlyParams(undefined)).toBeUndefined();
  });

  it('does not mutate the caller\'s object (fallback legs reuse it)', () => {
    const params = { ...LEAKY_PARAMS };
    void stripOpenRouterOnlyParams(params);
    expect(params).toEqual(LEAKY_PARAMS);
  });

  it('names the four documented OpenRouter-only keys', () => {
    expect([...OPENROUTER_ONLY_PARAM_KEYS].sort()).toEqual([
      'models',
      'provider',
      'route',
      'transforms',
    ]);
  });
});

describe('native providers strip OpenRouter-only params from their payloads', () => {
  let anthropic: AnthropicProvider;
  let gemini: GeminiProvider;
  let openai: OpenAIProvider;

  beforeEach(async () => {
    anthropic = new AnthropicProvider();
    await anthropic.initialize({ apiKey: 'test-key' });
    gemini = new GeminiProvider();
    await gemini.initialize({ apiKey: 'test-key' });
    openai = new OpenAIProvider();
    await openai.initialize({ apiKey: 'test-key' });
  });

  it('AnthropicProvider keeps custom params but never the routing controls', () => {
    const payload = (anthropic as any).buildRequestPayload(
      'claude-opus-4-8',
      MESSAGES,
      { customModelParams: { ...LEAKY_PARAMS } },
      false,
    ) as Record<string, unknown>;
    expect(payload.provider).toBeUndefined();
    expect(payload.models).toBeUndefined();
    expect(payload.route).toBeUndefined();
    expect(payload.transforms).toBeUndefined();
    expect(payload.metadata).toEqual({ user_id: 'u1' });
  });

  it('GeminiProvider keeps custom params but never the routing controls', () => {
    const payload = (gemini as any).buildRequestPayload('gemini-2.5-flash', MESSAGES, {
      customModelParams: { ...LEAKY_PARAMS },
    }) as Record<string, unknown>;
    expect(payload.provider).toBeUndefined();
    expect(payload.models).toBeUndefined();
    expect(payload.route).toBeUndefined();
    expect(payload.transforms).toBeUndefined();
    expect(payload.metadata).toEqual({ user_id: 'u1' });
  });

  it('OpenAIProvider keeps custom params but never the routing controls', () => {
    const payload = (openai as any).buildChatCompletionPayload(
      'gpt-4o-mini',
      MESSAGES,
      { customModelParams: { ...LEAKY_PARAMS } },
      false,
    ) as Record<string, unknown>;
    expect(payload.provider).toBeUndefined();
    expect(payload.models).toBeUndefined();
    expect(payload.route).toBeUndefined();
    expect(payload.transforms).toBeUndefined();
    expect(payload.metadata).toEqual({ user_id: 'u1' });
  });
});
