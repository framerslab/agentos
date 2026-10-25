/**
 * @file embedText.provider-endpoints.e2e.test.ts
 * Where embedText sends a provider's key. A provider whose own documentation
 * names an OpenAI-compatible embeddings endpoint gets its key posted to that
 * endpoint, or to the base URL the caller set (the call's `baseUrl`, the
 * global default's, or the provider's base-URL variable); a provider with no
 * embeddings is refused before any request is built; a provider agentos does
 * not know goes only to the base URL the caller set. No key goes to another
 * provider's host.
 *
 * Drives the public embedText entry point with only fetch stubbed: the
 * provider, its key and its base URL resolve from the call, the global
 * default and the environment as they do for a caller.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { embedText, type EmbedTextOptions } from '../../embedText.js';
import { clearDefaultProvider, setDefaultProvider } from '../global-default.js';

/** Every key and base-URL variable a case could read; each case sets the ones it needs. */
const PROVIDER_VARIABLES = [
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

/** The options a case passes to embedText besides its input. */
type Target = Pick<EmbedTextOptions, 'provider' | 'model' | 'apiKey' | 'baseUrl'>;

/** A call and where its one request must go. */
interface SentTo {
  /** What the case shows, for its title. */
  label: string;
  /** The call's options. */
  target: Target;
  /** The variables set for the call. */
  env: Record<string, string>;
  /** The URL the request must be posted to. */
  url: string;
  /** The key its Authorization header must carry. */
  key: string;
}

/** A call embedText must refuse before it builds any request. */
interface Refused {
  /** What the case shows, for its title. */
  label: string;
  /** The call's options. */
  target: Target;
  /** The variables set for the call. */
  env: Record<string, string>;
  /** Part of the error the call must reject with. */
  error: string;
}

/** An OpenAI-shaped embeddings answer for the model the request named. */
function embeddingAnswer(init: RequestInit | undefined): Response {
  const { model } = JSON.parse(String(init?.body)) as { model: string };
  return new Response(
    JSON.stringify({
      object: 'list',
      data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
      model,
      usage: { prompt_tokens: 1, total_tokens: 1 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

/** The URL and the Authorization header of each request embedText sent. */
function requestsSent(): Array<{ url: string; authorization: string | undefined }> {
  return vi.mocked(globalThis.fetch).mock.calls.map(([url, init]) => ({
    url: String(url),
    authorization: (init?.headers as Record<string, string> | undefined)?.Authorization,
  }));
}

function setEnv(env: Record<string, string>): void {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
}

beforeEach(() => {
  clearDefaultProvider();
  for (const name of PROVIDER_VARIABLES) {
    // Recorded by the stub, so unstubAllEnvs restores it; then unset.
    vi.stubEnv(name, '');
    delete process.env[name];
  }
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => embeddingAnswer(init));
});

afterEach(() => {
  clearDefaultProvider();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("embedText posts a key to its provider's own embeddings endpoint", () => {
  it("embeds on OpenAI with OpenAI's key at OpenAI's endpoint", async () => {
    setEnv({ OPENAI_API_KEY: 'openai-test-key' });

    const result = await embedText({ provider: 'openai', input: 'hello' });

    expect(requestsSent()).toEqual([
      { url: 'https://api.openai.com/v1/embeddings', authorization: 'Bearer openai-test-key' },
    ]);
    expect(result.provider).toBe('openai');
    expect(result.model).toBe('text-embedding-3-small');
    expect(result.embeddings).toEqual([[0.1, 0.2, 0.3]]);
    expect(result.usage.promptTokens).toBe(1);
  });

  it.each<SentTo>([
    {
      label: "OpenRouter's key to OpenRouter",
      target: { provider: 'openrouter', model: 'openai/text-embedding-3-small' },
      env: { OPENROUTER_API_KEY: 'openrouter-test-key' },
      url: 'https://openrouter.ai/api/v1/embeddings',
      key: 'openrouter-test-key',
    },
    {
      label: "Mistral's key to Mistral",
      target: { provider: 'mistral', model: 'mistral-embed' },
      env: { MISTRAL_API_KEY: 'mistral-test-key' },
      url: 'https://api.mistral.ai/v1/embeddings',
      key: 'mistral-test-key',
    },
    {
      label: "Mistral's key to Mistral for a mistral: model id",
      target: { model: 'mistral:mistral-embed' },
      env: { MISTRAL_API_KEY: 'mistral-test-key' },
      url: 'https://api.mistral.ai/v1/embeddings',
      key: 'mistral-test-key',
    },
    {
      label: "Requesty's key to Requesty",
      target: { provider: 'requesty', model: 'openai/text-embedding-3-small' },
      env: { REQUESTY_API_KEY: 'requesty-test-key' },
      url: 'https://router.requesty.ai/v1/embeddings',
      key: 'requesty-test-key',
    },
    {
      label: "OpenAI's key to OPENAI_BASE_URL",
      target: { provider: 'openai' },
      env: { OPENAI_API_KEY: 'openai-test-key', OPENAI_BASE_URL: 'https://openai-proxy.example/v1' },
      url: 'https://openai-proxy.example/v1/embeddings',
      key: 'openai-test-key',
    },
    {
      label: "Requesty's key to REQUESTY_BASE_URL",
      target: { provider: 'requesty', model: 'openai/text-embedding-3-small' },
      env: { REQUESTY_API_KEY: 'requesty-test-key', REQUESTY_BASE_URL: 'https://router.eu.requesty.ai/v1' },
      url: 'https://router.eu.requesty.ai/v1/embeddings',
      key: 'requesty-test-key',
    },
    {
      label: "Mistral's key to the base URL the call sets",
      target: { provider: 'mistral', model: 'mistral-embed', baseUrl: 'https://mistral-proxy.example/v1' },
      env: { MISTRAL_API_KEY: 'mistral-test-key' },
      url: 'https://mistral-proxy.example/v1/embeddings',
      key: 'mistral-test-key',
    },
  ])('posts $label', async ({ target, env, url, key }) => {
    setEnv(env);

    await embedText({ ...target, input: 'hello' });

    expect(requestsSent()).toEqual([{ url, authorization: `Bearer ${key}` }]);
  });
});

describe('embedText refuses a provider with no embeddings before any request', () => {
  it.each<Refused>([
    {
      label: 'Anthropic with its key set',
      target: { provider: 'anthropic', model: 'embedding-model' },
      env: { ANTHROPIC_API_KEY: 'anthropic-test-key' },
      error: 'Anthropic publishes no embedding model',
    },
    {
      // With no model, resolution has no default embedding model to give it.
      label: 'Anthropic named without a model',
      target: { provider: 'anthropic' },
      env: { ANTHROPIC_API_KEY: 'anthropic-test-key' },
      error: 'Anthropic publishes no embedding model',
    },
    {
      // Text calls on Anthropic fall back to OpenRouter without an Anthropic key.
      label: 'Anthropic when only an OpenRouter key is set',
      target: { provider: 'anthropic', model: 'embedding-model' },
      env: { OPENROUTER_API_KEY: 'openrouter-test-key' },
      error: 'Anthropic publishes no embedding model',
    },
    {
      label: 'Groq',
      target: { provider: 'groq', model: 'embedding-model' },
      env: { GROQ_API_KEY: 'groq-test-key' },
      error: 'Groq publishes no embeddings endpoint',
    },
    {
      label: 'Groq at the base URL the call sets',
      target: { provider: 'groq', model: 'embedding-model', baseUrl: 'https://api.groq.com/openai/v1' },
      env: { GROQ_API_KEY: 'groq-test-key' },
      error: 'Groq publishes no embeddings endpoint',
    },
    {
      label: 'Together AI',
      target: { provider: 'together', model: 'embedding-model' },
      env: { TOGETHER_API_KEY: 'together-test-key' },
      error: 'Together AI serves no embedding model',
    },
    {
      label: 'xAI',
      target: { provider: 'xai', model: 'embedding-model' },
      env: { XAI_API_KEY: 'xai-test-key' },
      error: 'xAI publishes no embeddings endpoint',
    },
    {
      label: 'MiniMax',
      target: { provider: 'minimax', model: 'embedding-model' },
      env: { MINIMAX_API_KEY: 'minimax-test-key' },
      error: 'MiniMax publishes no embedding model',
    },
    {
      label: 'a minimax: model id',
      target: { model: 'minimax:embedding-model' },
      env: { MINIMAX_API_KEY: 'minimax-test-key' },
      error: 'MiniMax publishes no embedding model',
    },
    {
      label: 'Stability AI',
      target: { provider: 'stability', model: 'embedding-model' },
      env: { STABILITY_API_KEY: 'stability-test-key' },
      error: 'agentos knows no embeddings endpoint for provider "stability"',
    },
    {
      label: 'Replicate',
      target: { provider: 'replicate', model: 'embedding-model' },
      env: { REPLICATE_API_TOKEN: 'replicate-test-token' },
      error: 'agentos knows no embeddings endpoint for provider "replicate"',
    },
    {
      label: 'fal',
      target: { provider: 'fal', model: 'embedding-model' },
      env: { FAL_API_KEY: 'fal-test-key' },
      error: 'agentos knows no embeddings endpoint for provider "fal"',
    },
    {
      label: 'Black Forest Labs',
      target: { provider: 'bfl', model: 'embedding-model' },
      env: { BFL_API_KEY: 'bfl-test-key' },
      error: 'agentos knows no embeddings endpoint for provider "bfl"',
    },
    {
      label: 'a local Stable Diffusion server, given a key',
      target: { provider: 'stable-diffusion-local', model: 'embedding-model', apiKey: 'sd-local-test-key' },
      env: {},
      error: 'agentos knows no embeddings endpoint for provider "stable-diffusion-local"',
    },
    {
      label: 'the Claude Code CLI',
      target: { provider: 'claude-code-cli', model: 'embedding-model' },
      env: {},
      error: 'agentos knows no embeddings endpoint for provider "claude-code-cli"',
    },
    {
      label: 'the Gemini CLI',
      target: { provider: 'gemini-cli', model: 'embedding-model' },
      env: {},
      error: 'agentos knows no embeddings endpoint for provider "gemini-cli"',
    },
  ])('refuses $label', async ({ target, env, error }) => {
    setEnv(env);

    await expect(embedText({ ...target, input: 'hello' })).rejects.toThrow(error);

    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a global default that names a provider with no embeddings', async () => {
    setDefaultProvider({ provider: 'together', model: 'embedding-model', apiKey: 'together-default-key' });

    await expect(embedText({ input: 'hello' })).rejects.toThrow('Together AI serves no embedding model');

    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a global default whose chat model an embedding call drops', async () => {
    // The chat model is dropped for the embedding call, which leaves no model.
    setDefaultProvider({ provider: 'groq', model: 'llama-3.3-70b-versatile', apiKey: 'groq-default-key' });

    await expect(embedText({ input: 'hello' })).rejects.toThrow('Groq publishes no embeddings endpoint');

    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('embedText sends a provider agentos does not know only to the base URL the caller set', () => {
  it('refuses it with no base URL, before any request', async () => {
    await expect(
      embedText({ provider: 'embedding-gateway', model: 'embedding-model', apiKey: 'gateway-test-key', input: 'hello' }),
    ).rejects.toThrow('No embeddings endpoint is known for provider "embedding-gateway"');

    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses it with no base URL when the key is a global default for every provider', async () => {
    setDefaultProvider({ apiKey: 'default-test-key' });

    await expect(embedText({ provider: 'embedding-gateway', model: 'embedding-model', input: 'hello' })).rejects.toThrow(
      'No embeddings endpoint is known for provider "embedding-gateway"',
    );

    expect(fetch).not.toHaveBeenCalled();
  });

  it('posts its key to the base URL the call sets', async () => {
    await embedText({
      provider: 'embedding-gateway',
      model: 'embedding-model',
      apiKey: 'gateway-test-key',
      baseUrl: 'https://gateway.example/v1',
      input: 'hello',
    });

    expect(requestsSent()).toEqual([
      { url: 'https://gateway.example/v1/embeddings', authorization: 'Bearer gateway-test-key' },
    ]);
  });

  it("posts the global default's key to the global default's base URL", async () => {
    setDefaultProvider({
      provider: 'embedding-gateway',
      model: 'embedding-model',
      apiKey: 'gateway-default-key',
      baseUrl: 'https://gateway.example/v1',
    });

    await embedText({ input: 'hello' });

    expect(requestsSent()).toEqual([
      { url: 'https://gateway.example/v1/embeddings', authorization: 'Bearer gateway-default-key' },
    ]);
  });
});
