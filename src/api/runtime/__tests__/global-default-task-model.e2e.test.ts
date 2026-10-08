/**
 * @file global-default-task-model.e2e.test.ts
 * `setDefaultProvider({ provider, model })` names the text model. An
 * embedding or image call that inlines neither provider nor model must not
 * send a chat model to the embeddings or image endpoint; it uses the
 * provider's default model for the task instead. Any other model the default
 * names (an embedding or image model, a custom server's alias) is kept, and
 * Ollama keeps any model (it embeds with whatever model is pulled).
 *
 * Drives the public embedText and editImage entry points with only fetch
 * stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { embedText } from '../../embedText.js';
import { editImage } from '../../editImage.js';
import { generateImage } from '../../generateImage.js';
import { clearDefaultProvider, setDefaultProvider } from '../global-default.js';

type Json = Record<string, any>;

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function postedBody(): Json {
  const [, init] = vi.mocked(globalThis.fetch).mock.calls[0];
  return JSON.parse(String((init as { body?: unknown }).body)) as Json;
}

const openAiEmbedding = (model: string) =>
  jsonResponse({
    object: 'list',
    data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
    model,
    usage: { prompt_tokens: 2, total_tokens: 2 },
  });

// A base-URL env var marks a custom endpoint, which keeps the default's
// model; clear the ones these cases could read.
const BASE_URL_VARS = ['OPENAI_BASE_URL', 'OLLAMA_BASE_URL'] as const;
const savedBaseUrls: Record<string, string | undefined> = {};

beforeEach(() => {
  clearDefaultProvider();
  for (const key of BASE_URL_VARS) {
    savedBaseUrls[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  clearDefaultProvider();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const key of BASE_URL_VARS) {
    if (savedBaseUrls[key] === undefined) delete process.env[key];
    else process.env[key] = savedBaseUrls[key];
  }
});

describe('global default model and non-text tasks', () => {
  it('embedText uses the provider\'s embedding model instead of the default chat model', async () => {
    setDefaultProvider({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-global-chat-model' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(openAiEmbedding('text-embedding-3-small'));

    const result = await embedText({ input: 'hello' });

    const [url] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(String(url)).toBe('https://api.openai.com/v1/embeddings');
    expect(postedBody().model).toBe('text-embedding-3-small');
    expect(result.embeddings).toEqual([[0.1, 0.2]]);
  });

  it('embedText treats a provider-qualified chat default as the chat model it names', async () => {
    setDefaultProvider({ provider: 'openai', model: 'openai:gpt-4o', apiKey: 'sk-global-qualified' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(openAiEmbedding('text-embedding-3-small'));

    await embedText({ input: 'hello' });

    expect(postedBody().model).toBe('text-embedding-3-small');
  });

  it('embedText keeps an embedding model named by the global default', async () => {
    setDefaultProvider({ provider: 'openai', model: 'text-embedding-3-large', apiKey: 'sk-global-embed-model' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(openAiEmbedding('text-embedding-3-large'));

    await embedText({ input: 'hello' });

    expect(postedBody().model).toBe('text-embedding-3-large');
  });

  it('embedText keeps a default model served by the default\'s own endpoint', async () => {
    setDefaultProvider({
      provider: 'openai',
      model: 'bge-m3',
      apiKey: 'sk-global-compat',
      baseUrl: 'http://embed.test/v1',
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(openAiEmbedding('bge-m3'));

    await embedText({ input: 'hello' });

    const [url] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(String(url)).toBe('http://embed.test/v1/embeddings');
    expect(postedBody().model).toBe('bge-m3');
  });

  it('embedText keeps an Ollama default model, which Ollama can embed with', async () => {
    setDefaultProvider({ provider: 'ollama', model: 'llama3.2', baseUrl: 'http://ollama.test:11434' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ model: 'llama3.2', embeddings: [[0.3, 0.4]] }),
    );

    const result = await embedText({ input: 'hello' });

    const [url] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(String(url)).toBe('http://ollama.test:11434/api/embed');
    expect(postedBody().model).toBe('llama3.2');
    expect(result.embeddings).toEqual([[0.3, 0.4]]);
  });

  it('embedText keeps a chat-family model when the default points at a custom endpoint', async () => {
    // Ollama through its OpenAI-compatible API embeds with the pulled model.
    setDefaultProvider({
      provider: 'openai',
      model: 'llama3.2',
      apiKey: 'sk-global-ollama-compat',
      baseUrl: 'http://ollama.test:11434/v1',
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(openAiEmbedding('llama3.2'));

    await embedText({ input: 'hello' });

    const [url] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(String(url)).toBe('http://ollama.test:11434/v1/embeddings');
    expect(postedBody().model).toBe('llama3.2');
  });

  it('embedText keeps a model name it cannot classify, such as a custom server alias', async () => {
    setDefaultProvider({ provider: 'openai', model: 'my-vector-model', apiKey: 'sk-global-alias' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(openAiEmbedding('my-vector-model'));

    await embedText({ input: 'hello' });

    expect(postedBody().model).toBe('my-vector-model');
  });

  it('editImage keeps an image model named by the global default', async () => {
    setDefaultProvider({ provider: 'openai', model: 'dall-e-2', apiKey: 'sk-global-dalle' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ created: 100, data: [{ b64_json: 'ZWRpdGVk' }] }),
    );

    const result = await editImage({ image: TINY_PNG, prompt: 'Add a hat.' });

    expect(result.model).toBe('dall-e-2');
  });

  it('editImage uses the provider\'s image model instead of the default chat model', async () => {
    setDefaultProvider({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-global-image' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ created: 100, data: [{ b64_json: 'ZWRpdGVk' }] }),
    );

    const result = await editImage({ image: TINY_PNG, prompt: 'Add a hat.' });

    const [url] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(String(url)).toContain('/images/edits');
    expect(result.provider).toBe('openai');
    expect(result.model).toBe('gpt-image-1');
  });

  describe('generateImage without a provider or model', () => {
    const IMAGE_KEYS = [
      'REPLICATE_API_TOKEN',
      'FAL_API_KEY',
      'BFL_API_KEY',
      'OPENAI_API_KEY',
      'STABILITY_API_KEY',
      'OPENROUTER_API_KEY',
      'STABLE_DIFFUSION_LOCAL_BASE_URL',
    ];
    const generated = () => jsonResponse({ created: 100, data: [{ b64_json: 'aW1hZ2U=' }] });

    beforeEach(() => {
      for (const key of IMAGE_KEYS) vi.stubEnv(key, '');
    });

    it('uses the global default provider and its key when no image key is in the environment', async () => {
      setDefaultProvider({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-global-generate' });
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(generated());

      const result = await generateImage({ prompt: 'A red panda on a rooftop.' });

      const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(String(url)).toBe('https://api.openai.com/v1/images/generations');
      expect((init as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer sk-global-generate');
      expect(result.provider).toBe('openai');
      expect(result.model).toBe('gpt-image-1');
    });

    it.each(['openai/gpt-4o', 'openrouter:openai/gpt-4o'])(
      'passes over a default whose provider has no image model for it (%s)',
      async (model) => {
      // OpenRouter serves no default image model, so its chat default cannot
      // make images; the provider found in the environment does.
      vi.stubEnv('OPENAI_API_KEY', 'sk-env-images');
      setDefaultProvider({ provider: 'openrouter', model, apiKey: 'sk-or-chat' });
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(generated());

      const result = await generateImage({ prompt: 'A red panda on a rooftop.' });

      const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(String(url)).toBe('https://api.openai.com/v1/images/generations');
      expect((init as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer sk-env-images');
      expect(result.provider).toBe('openai');
      },
    );

    it('passes over a Fal default with no key for the provider in the environment', async () => {
      vi.stubEnv('OPENAI_API_KEY', 'sk-env-images');
      setDefaultProvider({ provider: 'fal' });
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(generated());

      const result = await generateImage({ prompt: 'A red panda on a rooftop.' });

      const [url] = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(String(url)).toBe('https://api.openai.com/v1/images/generations');
      expect(result.provider).toBe('openai');
    });

    it('uses a Fal default whose key is only in the environment, ahead of the other providers', async () => {
      vi.stubEnv('FAL_API_KEY', 'fal-env-key');
      vi.stubEnv('REPLICATE_API_TOKEN', 'r8-env-token');
      setDefaultProvider({ provider: 'fal' });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input);
        if (url.endsWith('/status')) return jsonResponse({ status: 'COMPLETED' });
        if (url.includes('/requests/')) {
          return jsonResponse({ images: [{ url: 'https://fal.test/panda.png', content_type: 'image/png' }] });
        }
        return jsonResponse({ request_id: 'req-panda' });
      });

      const result = await generateImage({ prompt: 'A red panda on a rooftop.' });

      const [url, init] = fetchSpy.mock.calls[0];
      expect(String(url)).toBe('https://queue.fal.run/fal-ai/flux/dev');
      expect((init as { headers: Record<string, string> }).headers.Authorization).toBe('Key fal-env-key');
      expect(result.provider).toBe('fal');
      expect(result.images[0]?.url).toBe('https://fal.test/panda.png');
    });

    it('keeps the default\'s model for an inline custom endpoint', async () => {
      setDefaultProvider({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-global-gateway' });
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(generated());

      const result = await generateImage({ prompt: 'A red panda on a rooftop.', baseUrl: 'http://img.test/v1' });

      const [url] = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(String(url)).toBe('http://img.test/v1/images/generations');
      expect(result.model).toBe('gpt-4o');
    });

    it('passes over a default whose provider has no key anywhere', async () => {
      setDefaultProvider({ provider: 'openai', model: 'dall-e-3' });
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      await expect(generateImage({ prompt: 'A red panda on a rooftop.' })).rejects.toThrow(
        /No image provider configured/,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('keeps an image model named by the global default', async () => {
      setDefaultProvider({ provider: 'openai', model: 'dall-e-3', apiKey: 'sk-global-dalle3' });
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(generated());

      const result = await generateImage({ prompt: 'A red panda on a rooftop.' });

      expect(result.model).toBe('dall-e-3');
    });
  });
});
