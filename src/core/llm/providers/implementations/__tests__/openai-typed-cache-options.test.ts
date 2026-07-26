/**
 * @fileoverview Request-shape tests for the typed OpenAI prompt-cache /
 * service-tier policy (spec batch-1 C2): promptCacheKey quad-mode,
 * fail-closed retention table emission, service_tier passthrough,
 * customModelParams last-write precedence, response service-tier capture,
 * and cache_write_tokens normalization on non-streaming responses.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { OpenAIProvider } from '../../implementations/OpenAIProvider.js';

function chatResponseBody(extra: Record<string, unknown> = {}) {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1234567890,
    model: 'gpt-5.5',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'ok' },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 120,
      completion_tokens: 5,
      total_tokens: 125,
      prompt_tokens_details: { cached_tokens: 64, cache_write_tokens: 40 },
    },
    ...extra,
  };
}

describe('OpenAIProvider typed cache/tier options', () => {
  let provider: OpenAIProvider;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'gpt-5.5', object: 'model', created: 1, owned_by: 'openai' },
            { id: 'gpt-5.6', object: 'model', created: 1, owned_by: 'openai' },
            { id: 'gpt-4o', object: 'model', created: 1, owned_by: 'openai' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    provider = new OpenAIProvider();
    await provider.initialize({ apiKey: 'sk-test', maxRetries: 1 });
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(chatResponseBody()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as ReturnType<typeof vi.spyOn>;
    fetchSpy.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const messages = [{ role: 'user' as const, content: 'hi' }];

  async function requestBody(options: Record<string, unknown>): Promise<Record<string, unknown>> {
    await provider.generateCompletion('gpt-5.5', messages, options);
    const call = fetchSpy.mock.calls.at(-1)!;
    return JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>;
  }

  it('omits prompt_cache_key when the option is absent (zero-change default)', async () => {
    const body = await requestBody({ sessionId: 's-1' });
    expect(body).not.toHaveProperty('prompt_cache_key');
  });

  it('omits prompt_cache_key on explicit false', async () => {
    const body = await requestBody({ sessionId: 's-1', promptCacheKey: false });
    expect(body).not.toHaveProperty('prompt_cache_key');
  });

  it('sends an explicit key verbatim (trimmed)', async () => {
    const body = await requestBody({ promptCacheKey: '  k-explicit  ' });
    expect(body.prompt_cache_key).toBe('k-explicit');
  });

  it('omits an empty-after-trim explicit key', async () => {
    const body = await requestBody({ promptCacheKey: '   ' });
    expect(body).not.toHaveProperty('prompt_cache_key');
  });

  it('auto derives a hashed key from sessionId and never sends the raw id', async () => {
    const body = await requestBody({ sessionId: 's-1', promptCacheKey: 'auto' });
    const expected = 'agentos:' + createHash('sha256').update('s-1').digest('hex').slice(0, 16);
    expect(body.prompt_cache_key).toBe(expected);
    expect(JSON.stringify(body)).not.toContain('"s-1"');
  });

  it('auto without a session id omits the key', async () => {
    const body = await requestBody({ promptCacheKey: 'auto' });
    expect(body).not.toHaveProperty('prompt_cache_key');
  });

  it('emits prompt_cache_retention 24h on gpt-5.5', async () => {
    const body = await requestBody({ promptCacheRetention: '24h' });
    expect(body.prompt_cache_retention).toBe('24h');
    expect(body).not.toHaveProperty('prompt_cache_options');
  });

  it('emits prompt_cache_options.ttl 30m on gpt-5.6', async () => {
    await provider.generateCompletion('gpt-5.6', messages, { promptCacheRetention: '30m' });
    const body = JSON.parse((fetchSpy.mock.calls.at(-1)![1] as RequestInit).body as string);
    expect(body.prompt_cache_options).toEqual({ ttl: '30m' });
    expect(body).not.toHaveProperty('prompt_cache_retention');
  });

  it('fails closed on unsupported models (gpt-4o + 24h)', async () => {
    await provider.generateCompletion('gpt-4o', messages, { promptCacheRetention: '24h' });
    const body = JSON.parse((fetchSpy.mock.calls.at(-1)![1] as RequestInit).body as string);
    expect(body).not.toHaveProperty('prompt_cache_retention');
    expect(body).not.toHaveProperty('prompt_cache_options');
  });

  it('emits service_tier verbatim', async () => {
    const body = await requestBody({ serviceTier: 'flex' });
    expect(body.service_tier).toBe('flex');
  });

  it('customModelParams keeps last-write precedence over typed fields', async () => {
    const body = await requestBody({
      serviceTier: 'flex',
      customModelParams: { service_tier: 'priority' },
    });
    expect(body.service_tier).toBe('priority');
  });

  it('captures the response service_tier into the normalized response', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(chatResponseBody({ service_tier: 'default' })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const res = await provider.generateCompletion('gpt-5.5', messages, {});
    expect(res.serviceTier).toBe('default');
  });

  it('normalizes cached_tokens and cache_write_tokens with inclusive input', async () => {
    const res = await provider.generateCompletion('gpt-5.5', messages, {});
    expect(res.usage?.cacheReadInputTokens).toBe(64);
    expect(res.usage?.cacheCreationInputTokens).toBe(40);
    expect(res.usage?.inclusiveInputTokens).toBe(120);
    expect(res.usage?.promptTokens).toBe(120);
  });
});

describe('promptCacheSessionId derivation source (spec review fold)', () => {
  it('auto derives from the cache-only session field when the affinity sessionId is absent', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'gpt-5.5', object: 'model', created: 1, owned_by: 'openai' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const provider2 = new OpenAIProvider();
    await provider2.initialize({ apiKey: 'sk-test', maxRetries: 1 });
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(chatResponseBody()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    spy.mockClear();

    await provider2.generateCompletion('gpt-5.5', [{ role: 'user', content: 'hi' }], {
      promptCacheKey: 'auto',
      promptCacheSessionId: 'ledger-1',
    });
    const body = JSON.parse((spy.mock.calls.at(-1)![1] as RequestInit).body as string);
    const expected = 'agentos:' + createHash('sha256').update('ledger-1').digest('hex').slice(0, 16);
    expect(body.prompt_cache_key).toBe(expected);
    expect(JSON.stringify(body)).not.toContain('ledger-1');
    expect(body).not.toHaveProperty('session_id');
  });
});
