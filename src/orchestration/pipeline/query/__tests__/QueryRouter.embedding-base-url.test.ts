/**
 * @fileoverview The router's corpus embeddings go to the base URL it was given.
 *
 * The router builds its own embedding provider, so it has to hand that provider
 * the URL under the name the provider reads. These cases run the real provider
 * manager and the real providers against a stubbed `fetch`: the model listing and
 * the embeddings requests all go to the gateway, and the key never reaches the
 * provider's own endpoint.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { QueryRouter } from '../QueryRouter.js';

const GATEWAY = 'https://gateway.example.test/v1';

/** Stubs `fetch` with a provider that answers the model listing and embeddings; returns the URLs it saw. */
function stubProvider(): string[] {
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    if (url.endsWith('/embeddings')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { input: string | string[]; model?: string };
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return new Response(
        JSON.stringify({
          object: 'list',
          model: body.model,
          data: inputs.map((_, index) => ({ object: 'embedding', index, embedding: new Array(1536).fill(0.1) })),
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify({
        object: 'list',
        data: ['text-embedding-3-small', 'openai/text-embedding-3-small'].map((id) => ({
          id,
          object: 'model',
          created: 0,
          owned_by: 'test',
          name: id,
          description: id,
          pricing: { prompt: '0', completion: '0' },
          context_length: 8192,
        })),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  return urls;
}

describe('QueryRouter: the corpus embeddings base URL', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ['openai', 'text-embedding-3-small'],
    ['openrouter', 'openai/text-embedding-3-small'],
  ])('an %s embedding provider sends to embeddingBaseUrl', async (embeddingProvider, embeddingModel) => {
    const urls = stubProvider();
    const corpusDir = await fs.mkdtemp(path.join(os.tmpdir(), 'query-router-base-url-'));
    await fs.writeFile(path.join(corpusDir, 'notes.md'), '# Notes\n\nA short note about gateways.\n');
    const router = new QueryRouter({
      knowledgeCorpus: [corpusDir],
      includePlatformKnowledge: false,
      embeddingProvider,
      embeddingModel,
      embeddingApiKey: 'test-key',
      embeddingBaseUrl: GATEWAY,
      apiKey: 'test-key',
      graphEnabled: false,
      deepResearchEnabled: false,
    } as ConstructorParameters<typeof QueryRouter>[0]);

    try {
      await router.init();
    } finally {
      await router.close();
      await fs.rm(corpusDir, { recursive: true, force: true });
    }

    expect(urls.filter((url) => url === `${GATEWAY}/embeddings`).length).toBeGreaterThanOrEqual(1);
    expect(urls.filter((url) => !url.startsWith(GATEWAY))).toEqual([]);
  });
});
