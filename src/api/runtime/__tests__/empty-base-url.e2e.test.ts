/**
 * @file empty-base-url.e2e.test.ts
 * A base URL that is an empty or whitespace-only string is unset, wherever a
 * call decides the endpoint a provider's key is sent to. The call's `baseUrl`,
 * the global default's and the provider's base-URL variable are each read as
 * absent, the next source applies, and with none the request goes to the
 * provider's own endpoint. No request is built on an empty base: its relative
 * URL (`/embeddings`, `/chat/completions`) is one Node's fetch rejects and a
 * browser's resolves against the page's own origin, with the key in the
 * request.
 *
 * Drives the public embedText, generateText, generateImage and importAgent
 * entry points with only fetch stubbed: the provider, its key and its base URL
 * resolve from the call, the global default and the environment as they do
 * for a caller.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { agent } from '../../agent.js';
import { exportAgentConfig, importAgent } from '../../agentExport.js';
import { embedText } from '../../embedText.js';
import { generateImage } from '../../generateImage.js';
import { generateText } from '../../generateText.js';
import { clearDefaultProvider, setDefaultProvider } from '../global-default.js';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';

/**
 * Every key and base-URL variable a case could read, each case setting the ones
 * it needs, and the usage-ledger paths, so the calls these cases make record
 * nothing in a ledger the environment names.
 */
const PROVIDER_VARIABLES = [
  'AGENTOS_USAGE_LEDGER_PATH',
  'WUNDERLAND_USAGE_LEDGER_PATH',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENROUTER_API_KEY',
  'OPENROUTER_BASE_URL',
  'REQUESTY_API_KEY',
  'REQUESTY_BASE_URL',
  'MISTRAL_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GROQ_API_KEY',
  'TOGETHER_API_KEY',
  'XAI_API_KEY',
  'MINIMAX_API_KEY',
  'MINIMAX_BASE_URL',
  'STABILITY_API_KEY',
  'STABILITY_BASE_URL',
  'REPLICATE_API_TOKEN',
  'REPLICATE_BASE_URL',
  'FAL_API_KEY',
  'FAL_BASE_URL',
  'BFL_API_KEY',
  'OLLAMA_BASE_URL',
  'STABLE_DIFFUSION_LOCAL_BASE_URL',
];

/** The base URLs these cases pass as unset: empty, and whitespace alone. */
const BLANK_BASE_URLS = ['', ' \t\n '];

/** Each provider with an OpenAI-compatible embeddings endpoint of its own, a model it embeds with, its key variable and that endpoint. */
const OWN_EMBEDDINGS_ENDPOINTS = [
  { provider: 'openai', model: 'text-embedding-3-small', keyVar: 'OPENAI_API_KEY', url: 'https://api.openai.com/v1/embeddings' },
  { provider: 'openrouter', model: 'openai/text-embedding-3-small', keyVar: 'OPENROUTER_API_KEY', url: 'https://openrouter.ai/api/v1/embeddings' },
  { provider: 'mistral', model: 'mistral-embed', keyVar: 'MISTRAL_API_KEY', url: 'https://api.mistral.ai/v1/embeddings' },
  { provider: 'requesty', model: 'openai/text-embedding-3-small', keyVar: 'REQUESTY_API_KEY', url: 'https://router.requesty.ai/v1/embeddings' },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** An answer in the shape of whatever endpoint the request went to, whatever host it went to. */
function answer(url: string, init: RequestInit | undefined): Response {
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  if (url.includes(':batchEmbedContents')) {
    const requests = body.requests as unknown[];
    return jsonResponse({
      embeddings: requests.map((_, i) => ({ values: [i, i + 0.5] })),
      usageMetadata: { promptTokenCount: requests.length },
    });
  }
  if (/\/embeddings$/.test(url)) {
    return jsonResponse({
      object: 'list',
      data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
      model: body.model,
      usage: { prompt_tokens: 1, total_tokens: 1 },
    });
  }
  if (/\/models(\?|$)/.test(url)) {
    return jsonResponse({ object: 'list', data: [{ id: 'gpt-4.1', object: 'model', created: 1, owned_by: 'openai' }] });
  }
  if (/\/chat\/completions$/.test(url)) {
    return jsonResponse({
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-4.1',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    });
  }
  if (/\/images\/generations$/.test(url)) {
    return jsonResponse({ created: 100, data: [{ b64_json: 'aW1hZ2U=' }] });
  }
  return jsonResponse({ error: `unexpected request ${url}` }, 404);
}

/** The URL and the key headers of each request sent. */
function requestsSent(): Array<{ url: string; authorization: string | undefined; googleKey: string | undefined }> {
  return vi.mocked(globalThis.fetch).mock.calls.map(([url, init]) => {
    const headers = (init?.headers as Record<string, string> | undefined) ?? {};
    return { url: String(url), authorization: headers.Authorization ?? headers.authorization, googleKey: headers['x-goog-api-key'] };
  });
}

/** The JSON body of each request sent. */
function bodiesSent(): Array<Record<string, unknown>> {
  return vi.mocked(globalThis.fetch).mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
}

/** The POST requests sent to `pattern`, with their Authorization header. */
function postsTo(pattern: RegExp): Array<{ url: string; authorization: string | undefined }> {
  return vi
    .mocked(globalThis.fetch)
    .mock.calls.filter(([url, init]) => pattern.test(String(url)) && (init as { method?: string } | undefined)?.method === 'POST')
    .map(([url, init]) => ({
      url: String(url),
      authorization: ((init?.headers as Record<string, string> | undefined) ?? {}).Authorization,
    }));
}

function setEnv(env: Record<string, string>): void {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
}

beforeEach(() => {
  clearDefaultProvider();
  globalLLMProviderHealth.reset();
  for (const name of PROVIDER_VARIABLES) {
    // Recorded by the stub, so unstubAllEnvs restores it; then unset.
    vi.stubEnv(name, '');
    delete process.env[name];
  }
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => answer(String(url), init));
});

afterEach(() => {
  clearDefaultProvider();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("embedText reads an empty or whitespace-only baseUrl as unset and posts the key to the provider's own endpoint", () => {
  it.each(
    OWN_EMBEDDINGS_ENDPOINTS.flatMap((endpoint) =>
      BLANK_BASE_URLS.map((baseUrl) => ({ ...endpoint, baseUrl, label: JSON.stringify(baseUrl) })),
    ),
  )("posts $provider's key to $url for baseUrl $label", async ({ provider, model, keyVar, url, baseUrl }) => {
    setEnv({ [keyVar]: `${provider}-test-key` });

    const result = await embedText({ provider, model, baseUrl, input: 'hello' });

    expect(requestsSent()).toEqual([{ url, authorization: `Bearer ${provider}-test-key`, googleKey: undefined }]);
    expect(result.provider).toBe(provider);
    expect(result.embeddings).toEqual([[0.1, 0.2, 0.3]]);
  });

  it.each(BLANK_BASE_URLS)("posts Gemini's key to Gemini's own batchEmbedContents endpoint for baseUrl %j", async (baseUrl) => {
    setEnv({ GEMINI_API_KEY: 'gemini-test-key' });

    const result = await embedText({ provider: 'gemini', baseUrl, input: 'hello' });

    expect(requestsSent()).toEqual([
      {
        url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:batchEmbedContents',
        authorization: undefined,
        googleKey: 'gemini-test-key',
      },
    ]);
    expect(result.provider).toBe('gemini');
    expect(result.embeddings).toEqual([[0, 0.5]]);
  });

  it("posts OpenAI's key to OPENAI_BASE_URL when the call's baseUrl is empty", async () => {
    setEnv({ OPENAI_API_KEY: 'openai-test-key', OPENAI_BASE_URL: 'https://openai-proxy.example/v1' });

    await embedText({ provider: 'openai', baseUrl: '', input: 'hello' });

    expect(requestsSent()).toEqual([
      { url: 'https://openai-proxy.example/v1/embeddings', authorization: 'Bearer openai-test-key', googleKey: undefined },
    ]);
  });

  it("posts the global default's key to the global default's base URL when the call's baseUrl is whitespace", async () => {
    setDefaultProvider({ provider: 'openai', apiKey: 'openai-default-key', baseUrl: 'https://openai-default.example/v1' });

    await embedText({ provider: 'openai', baseUrl: '  ', input: 'hello' });

    expect(requestsSent()).toEqual([
      { url: 'https://openai-default.example/v1/embeddings', authorization: 'Bearer openai-default-key', googleKey: undefined },
    ]);
  });

  it("posts the global default's key to OPENAI_BASE_URL when the global default's baseUrl is empty", async () => {
    setEnv({ OPENAI_BASE_URL: 'https://openai-proxy.example/v1' });
    setDefaultProvider({ provider: 'openai', apiKey: 'openai-default-key', baseUrl: '' });

    await embedText({ provider: 'openai', input: 'hello' });

    expect(requestsSent()).toEqual([
      { url: 'https://openai-proxy.example/v1/embeddings', authorization: 'Bearer openai-default-key', googleKey: undefined },
    ]);
  });

  it.each(BLANK_BASE_URLS)("posts OpenAI's key to OpenAI's own endpoint when OPENAI_BASE_URL is %j", async (baseUrl) => {
    setEnv({ OPENAI_API_KEY: 'openai-test-key', OPENAI_BASE_URL: baseUrl });

    await embedText({ provider: 'openai', input: 'hello' });

    expect(requestsSent()).toEqual([
      { url: 'https://api.openai.com/v1/embeddings', authorization: 'Bearer openai-test-key', googleKey: undefined },
    ]);
  });

  it("posts OpenAI's key to OpenAI's own endpoint when the call's, the default's and the variable's base URLs are all blank", async () => {
    setEnv({ OPENAI_BASE_URL: ' ' });
    setDefaultProvider({ provider: 'openai', apiKey: 'openai-default-key', baseUrl: '\t' });

    await embedText({ provider: 'openai', baseUrl: '', input: 'hello' });

    expect(requestsSent()).toEqual([
      { url: 'https://api.openai.com/v1/embeddings', authorization: 'Bearer openai-default-key', googleKey: undefined },
    ]);
  });

  it("sends the provider's embedding model to its own endpoint when the global default's baseUrl is whitespace", async () => {
    // A whitespace-only default URL names no custom endpoint, so the default's
    // chat model is not sent to the embeddings endpoint.
    setDefaultProvider({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'openai-default-key', baseUrl: '  ' });

    await embedText({ input: 'hello' });

    expect(requestsSent()).toEqual([
      { url: 'https://api.openai.com/v1/embeddings', authorization: 'Bearer openai-default-key', googleKey: undefined },
    ]);
    expect(bodiesSent()[0].model).toBe('text-embedding-3-small');
  });

  it("keeps the global default's model at the global default's custom endpoint when the call's baseUrl is empty", async () => {
    // The empty inline URL is unset, so the call goes to the default's endpoint,
    // which may serve the default's model under that name.
    setDefaultProvider({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'openai-default-key', baseUrl: 'https://openai-default.example/v1' });

    await embedText({ baseUrl: '', input: 'hello' });

    expect(requestsSent()).toEqual([
      { url: 'https://openai-default.example/v1/embeddings', authorization: 'Bearer openai-default-key', googleKey: undefined },
    ]);
    expect(bodiesSent()[0].model).toBe('gpt-4o-mini');
  });
});

describe('embedText refuses a provider with no endpoint of its own when every base URL is blank, before any request', () => {
  it.each(BLANK_BASE_URLS)('refuses Ollama for baseUrl %j', async (baseUrl) => {
    await expect(embedText({ provider: 'ollama', model: 'nomic-embed-text', baseUrl, input: 'hello' })).rejects.toThrow(
      'No base URL for ollama',
    );

    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(BLANK_BASE_URLS)('refuses a provider agentos does not know for baseUrl %j', async (baseUrl) => {
    await expect(
      embedText({ provider: 'embedding-gateway', model: 'embedding-model', apiKey: 'gateway-test-key', baseUrl, input: 'hello' }),
    ).rejects.toThrow('No embeddings endpoint is known for provider "embedding-gateway"');

    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts a provider agentos does not know to the global default's base URL when the call's baseUrl is empty", async () => {
    setDefaultProvider({ provider: 'embedding-gateway', apiKey: 'gateway-default-key', baseUrl: 'https://gateway.example/v1' });

    await embedText({ provider: 'embedding-gateway', model: 'embedding-model', baseUrl: '', input: 'hello' });

    expect(requestsSent()).toEqual([
      { url: 'https://gateway.example/v1/embeddings', authorization: 'Bearer gateway-default-key', googleKey: undefined },
    ]);
  });
});

describe("generateText reads an empty or whitespace-only baseUrl as unset and sends the key to the provider's own endpoint", () => {
  it("sends OpenAI's key to OpenAI's own endpoint for a whitespace-only baseUrl", async () => {
    const result = await generateText({ provider: 'openai', model: 'gpt-4.1', apiKey: 'openai-test-key', baseUrl: ' \t', prompt: 'hi' });

    expect(result.text).toBe('ok');
    const sent = requestsSent();
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every(({ url }) => url.startsWith('https://api.openai.com/v1/'))).toBe(true);
    expect(postsTo(/\/chat\/completions$/)).toEqual([
      { url: 'https://api.openai.com/v1/chat/completions', authorization: 'Bearer openai-test-key' },
    ]);
  });

  it("sends OpenAI's key to OPENAI_BASE_URL for an empty baseUrl", async () => {
    setEnv({ OPENAI_API_KEY: 'openai-env-key', OPENAI_BASE_URL: 'https://openai-proxy.example/v1' });

    const result = await generateText({ provider: 'openai', model: 'gpt-4.1', baseUrl: '', prompt: 'hi' });

    expect(result.text).toBe('ok');
    const sent = requestsSent();
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every(({ url }) => url.startsWith('https://openai-proxy.example/v1/'))).toBe(true);
    expect(postsTo(/\/chat\/completions$/)).toEqual([
      { url: 'https://openai-proxy.example/v1/chat/completions', authorization: 'Bearer openai-env-key' },
    ]);
  });

  it("sends MiniMax's key to MiniMax's own endpoint for a whitespace-only baseUrl", async () => {
    // MiniMax's text provider runs on OpenAI's transport, whose request URL a
    // whitespace-only base left relative; the key goes to MiniMax's own root.
    const result = await generateText({
      provider: 'minimax',
      model: 'MiniMax-M3.1-Flash',
      apiKey: 'minimax-test-key',
      baseUrl: ' \t',
      prompt: 'hi',
    });

    expect(result.text).toBe('ok');
    const sent = requestsSent();
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every(({ url }) => url.startsWith('https://api.minimax.io/v1/'))).toBe(true);
    expect(postsTo(/\/chat\/completions$/)).toEqual([
      { url: 'https://api.minimax.io/v1/chat/completions', authorization: 'Bearer minimax-test-key' },
    ]);
  });

  it("sends MiniMax's key to MINIMAX_BASE_URL for an empty baseUrl", async () => {
    setEnv({ MINIMAX_API_KEY: 'minimax-env-key', MINIMAX_BASE_URL: 'https://minimax-proxy.example/v1' });

    const result = await generateText({ provider: 'minimax', model: 'MiniMax-M3.1-Flash', baseUrl: '', prompt: 'hi' });

    expect(result.text).toBe('ok');
    const sent = requestsSent();
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every(({ url }) => url.startsWith('https://minimax-proxy.example/v1/'))).toBe(true);
    expect(postsTo(/\/chat\/completions$/)).toEqual([
      { url: 'https://minimax-proxy.example/v1/chat/completions', authorization: 'Bearer minimax-env-key' },
    ]);
  });
});

describe('generateImage reads an empty or whitespace-only baseUrl as unset', () => {
  it("sends the global default's key to OpenAI's own endpoint with its image model for a whitespace-only baseUrl", async () => {
    setDefaultProvider({ provider: 'openai', model: 'gpt-4o', apiKey: 'openai-default-key' });

    const result = await generateImage({ prompt: 'A red panda on a rooftop.', baseUrl: '  ' });

    expect(postsTo(/\/images\/generations$/)).toEqual([
      { url: 'https://api.openai.com/v1/images/generations', authorization: 'Bearer openai-default-key' },
    ]);
    expect(result.provider).toBe('openai');
    // No custom endpoint: the default's chat model is not sent to the image endpoint.
    expect(result.model).toBe('gpt-image-2.5-flare');
  });

  it("sends the global default's key to the global default's custom endpoint, with its model, for an empty baseUrl", async () => {
    setDefaultProvider({ provider: 'openai', model: 'gpt-4o', apiKey: 'openai-default-key', baseUrl: 'https://images-default.example/v1' });

    const result = await generateImage({ prompt: 'A red panda on a rooftop.', baseUrl: '' });

    expect(postsTo(/\/images\/generations$/)).toEqual([
      { url: 'https://images-default.example/v1/images/generations', authorization: 'Bearer openai-default-key' },
    ]);
    expect(result.model).toBe('gpt-4o');
  });
});

describe('generateImage refuses no call for a blank baseUrl that it makes with none', () => {
  it.each(BLANK_BASE_URLS)(
    "sends OpenAI's key from the environment to OpenAI's own endpoint for baseUrl %j, with no provider named and no global default",
    async (baseUrl) => {
      setEnv({ OPENAI_API_KEY: 'openai-env-key' });

      const result = await generateImage({ prompt: 'A red panda on a rooftop.', baseUrl });

      expect(postsTo(/\/images\/generations$/)).toEqual([
        { url: 'https://api.openai.com/v1/images/generations', authorization: 'Bearer openai-env-key' },
      ]);
      expect(result.provider).toBe('openai');
      expect(result.model).toBe('gpt-image-2.5-flare');
    },
  );

  it.each(BLANK_BASE_URLS)('still refuses an apiKey beside baseUrl %j with no provider named, before any request', async (baseUrl) => {
    setEnv({ OPENAI_API_KEY: 'openai-env-key' });

    await expect(generateImage({ prompt: 'A red panda on a rooftop.', apiKey: 'caller-key', baseUrl })).rejects.toThrow(
      'an apiKey or baseUrl needs provider',
    );

    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("importAgent drops a redacted baseUrl only for a base URL the importing process sets, read as the call reads it", () => {
  /** An export whose `baseUrl` lost its credentials and whose key is redacted. */
  function exportedAgent() {
    return exportAgentConfig(
      agent({ provider: 'openai', model: 'gpt-4.1', apiKey: 'sk-export-key', baseUrl: 'https://user:pw-export@proxy.local/v1', fallbackProviders: [] }),
    );
  }

  it("drops it under a default whose baseUrl is empty when OPENAI_BASE_URL is set, and the agent's calls go to OPENAI_BASE_URL", async () => {
    setEnv({ OPENAI_API_KEY: 'openai-env-key', OPENAI_BASE_URL: 'https://openai-proxy.example/v1' });
    setDefaultProvider({ provider: 'openai', baseUrl: '' });

    const restored = importAgent(exportedAgent());
    await restored.generate('hi');

    expect(postsTo(/\/chat\/completions$/)).toEqual([
      { url: 'https://openai-proxy.example/v1/chat/completions', authorization: 'Bearer openai-env-key' },
    ]);
    expect(requestsSent().every(({ url }) => url.startsWith('https://openai-proxy.example/v1/'))).toBe(true);
  });

  it('lists it under a default whose baseUrl is whitespace when no URL variable is set, before any request', () => {
    setDefaultProvider({ provider: 'openai', baseUrl: '  ' });

    expect(() => importAgent(exportedAgent())).toThrow(/\/config\/baseUrl/);

    expect(fetch).not.toHaveBeenCalled();
  });
});
