/**
 * @file anthropic-spend-limit-fallback.e2e.test.ts
 * A single Anthropic key whose spend limit is reached answers HTTP 400
 * invalid_request_error "You have reached your specified workspace API usage
 * limits" (platform.claude.com/docs/en/api/rate-limits, read 18 October 2026).
 * generateText must treat it as it treats the credit-balance 400: move the
 * call to the next provider and open the provider health breaker's billing
 * class, so the calls after it skip Anthropic until the window ends instead of
 * failing on it one by one.
 *
 * Drives generateText through the real resolver, provider manager,
 * AnthropicProvider, OpenAIProvider and health registry; only fetch is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { generateText } from '../generateText.js';
import { shutdownProviderManagers } from '../model.js';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** The documented message's opening words; the sentence after them is this test's. */
const spendLimit = () =>
  json(
    {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'You have reached your specified workspace API usage limits. You will regain access when the limit resets.',
      },
    },
    400,
  );

const openAiModels = () => json({ object: 'list', data: [{ id: 'gpt-4.1', object: 'model', created: 1, owned_by: 'openai' }] });

const openAiAnswer = () =>
  json({
    id: 'chatcmpl-spend',
    object: 'chat.completion',
    created: 1,
    model: 'gpt-4.1',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Served by OpenAI.' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  });

const requestsTo = (pattern: RegExp) => fetchMock.mock.calls.filter(([url]) => pattern.test(String(url))).length;

const ask = () =>
  generateText({
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    prompt: 'Hello?',
    fallbackProviders: [{ provider: 'openai', model: 'gpt-4.1' }],
  });

const savedOpenRouterKey = process.env.OPENROUTER_API_KEY;

describe("Anthropic's spend-limit 400 on a single key", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    globalLLMProviderHealth.reset();
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-spend-limit-0001');
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai-spend-fallback-0002');
    // Without this the resolver could reroute the Anthropic call to OpenRouter.
    delete process.env.OPENROUTER_API_KEY;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    fetchMock.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (/api\.anthropic\.com\/v1\/messages/.test(u)) return spendLimit();
      if (/api\.openai\.com\/v1\/models/.test(u)) return openAiModels();
      if (/api\.openai\.com\/v1\/chat\/completions/.test(u)) return openAiAnswer();
      throw new Error(`unexpected request ${u}`);
    });
  });

  afterEach(async () => {
    await shutdownProviderManagers();
    globalLLMProviderHealth.reset();
    vi.unstubAllEnvs();
    if (savedOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedOpenRouterKey;
    vi.restoreAllMocks();
  });

  it('moves the call to the next provider and opens the billing breaker, so the next call skips Anthropic', async () => {
    const first = await ask();
    expect(first.text).toBe('Served by OpenAI.');
    expect(first.provider).toBe('openai');
    expect(requestsTo(/api\.anthropic\.com\/v1\/messages/)).toBe(1);
    // The billing class: one failure opens it, for the billing window.
    const stats = globalLLMProviderHealth.getStats('anthropic');
    expect(stats).toMatchObject({ state: 'open', totalTrips: 1 });
    expect(stats!.cooldownRemainingMs).toBeGreaterThan(4 * 60_000);

    const second = await ask();
    expect(second.text).toBe('Served by OpenAI.');
    // No request to Anthropic while its breaker is open.
    expect(requestsTo(/api\.anthropic\.com\/v1\/messages/)).toBe(1);
  });
});
