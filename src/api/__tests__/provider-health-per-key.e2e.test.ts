/**
 * @file provider-health-per-key.e2e.test.ts
 * A call's own key has a health record of its own: one caller's revoked key
 * opens the breaker for the calls on that key, and not for every caller of
 * the provider on the key in the environment.
 *
 * Drives generateText and streamText through the real provider manager and
 * OpenAIProvider; only fetch is stubbed, answering by the key a request
 * carries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { generateText } from '../generateText.js';
import { streamText } from '../streamText.js';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry.js';
import { providerHealthKey } from '../runtime/providerHealthKey.js';

const GOOD = 'sk-env-good-key';
const REVOKED = 'sk-tenant-revoked-key';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** The key a request carried in its Authorization header. */
function keyOf(init?: RequestInit): string {
  return new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? '';
}

/** OpenAI's API, which takes GOOD and answers 401 for any other key. */
function openAI(): void {
  fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (keyOf(init) !== GOOD) {
      return jsonResponse({ error: { message: 'Incorrect API key provided.', type: 'invalid_request_error', code: 'invalid_api_key' } }, 401);
    }
    if (/\/v1\/models/.test(u)) return jsonResponse({ object: 'list', data: [{ id: 'gpt-4.1', object: 'model', created: 1, owned_by: 'openai' }] });
    if (/\/v1\/chat\/completions/.test(u)) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { stream?: boolean };
      if (body.stream) {
        const chunks = [
          { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'gpt-4.1', choices: [{ index: 0, delta: { role: 'assistant', content: 'Served.' }, finish_reason: null }] },
          { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'gpt-4.1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } },
        ];
        return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return jsonResponse({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-4.1',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Served.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      });
    }
    throw new Error(`unexpected request ${u}`);
  });
}

const requestsWith = (key: string) => fetchMock.mock.calls.filter(([, init]) => keyOf(init as RequestInit) === key).length;

beforeEach(() => {
  fetchMock.mockReset();
  globalLLMProviderHealth.reset();
  vi.stubEnv('OPENAI_API_KEY', GOOD);
  openAI();
});

afterEach(() => {
  vi.unstubAllEnvs();
  globalLLMProviderHealth.reset();
});

describe("a revoked key opens the breaker for its own calls, not for the provider's", () => {
  it('generateText on the environment key still runs after a caller key is refused', async () => {
    const call = (apiKey?: string) =>
      generateText({ provider: 'openai', model: 'gpt-4.1', prompt: 'Hello?', fallbackProviders: [], ...(apiKey ? { apiKey } : {}) });

    await expect(call(REVOKED)).rejects.toThrow();
    const revokedRequests = requestsWith(REVOKED);
    expect(revokedRequests).toBeGreaterThan(0);

    expect((await call()).text).toBe('Served.');
    // The revoked key's own breaker is open: its next call sends nothing.
    await expect(call(REVOKED)).rejects.toThrow(/circuit open/i);
    expect(requestsWith(REVOKED)).toBe(revokedRequests);
    expect(globalLLMProviderHealth.isOpen('openai')).toBe(false);
    expect(globalLLMProviderHealth.isOpen(providerHealthKey('openai', { apiKey: REVOKED }))).toBe(true);
  });

  it('streamText on the environment key still runs after a caller key is refused', async () => {
    const drain = async (apiKey?: string) => {
      const result = streamText({ provider: 'openai', model: 'gpt-4.1', prompt: 'Hello?', fallbackProviders: [], ...(apiKey ? { apiKey } : {}) });
      let text = '';
      for await (const delta of result.textStream) text += delta;
      return text;
    };

    await expect(drain(REVOKED)).rejects.toThrow();
    expect(await drain()).toBe('Served.');
    expect(globalLLMProviderHealth.isOpen('openai')).toBe(false);
  });
});

describe('providerHealthKey', () => {
  it('is the provider id for a call with no key or base URL of its own, and a digest of them otherwise', () => {
    expect(providerHealthKey('openai')).toBe('openai');
    expect(providerHealthKey('openai', {})).toBe('openai');
    const keyed = providerHealthKey('openai', { apiKey: REVOKED });
    expect(keyed).toMatch(/^openai@[0-9a-f]{12}$/);
    expect(keyed).not.toContain(REVOKED.slice(3, 10));
    expect(providerHealthKey('openai', { apiKey: REVOKED })).toBe(keyed);
    expect(providerHealthKey('openai', { apiKey: REVOKED, baseUrl: 'https://gw.example/v1' })).not.toBe(keyed);
    expect(providerHealthKey('openai', { baseUrl: 'https://gw.example/v1' })).toMatch(/^openai@/);
  });
});
