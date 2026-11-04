/**
 * @fileoverview The router's corpus embeddings go to the base URL it was given.
 *
 * The router builds its own embedding provider, so it has to hand that provider
 * the URL under the name the provider reads. These cases run the real provider
 * manager and the real providers against a provider server on 127.0.0.1, which
 * OpenAI's provider reaches with `fetch` and OpenRouter's with axios. A stubbed
 * `fetch` records any request for another origin instead of sending it.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { QueryRouter } from '../QueryRouter.js';

/** The paths the provider server received. */
const seen: string[] = [];
/** Requests `fetch` was asked to send anywhere but the provider server. */
const elsewhere: string[] = [];

let server: Server;
let gateway = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const url = req.url ?? '/';
      seen.push(url);
      let answer: unknown;
      if (url.endsWith('/embeddings')) {
        const body = JSON.parse(raw || '{}') as { input: string | string[]; model?: string };
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        answer = {
          object: 'list',
          model: body.model,
          data: inputs.map((_, index) => ({ object: 'embedding', index, embedding: new Array(1536).fill(0.1) })),
          usage: { prompt_tokens: 1, total_tokens: 1 },
        };
      } else {
        answer = {
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
        };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  gateway = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('QueryRouter: the corpus embeddings base URL', () => {
  it.each([
    ['openai', 'text-embedding-3-small'],
    ['openrouter', 'openai/text-embedding-3-small'],
  ])('an %s embedding provider sends to embeddingBaseUrl', async (embeddingProvider, embeddingModel) => {
    seen.length = 0;
    elsewhere.length = 0;
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(gateway)) return realFetch(input as RequestInfo, init);
      elsewhere.push(url);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const corpusDir = await fs.mkdtemp(path.join(os.tmpdir(), 'query-router-base-url-'));
    await fs.writeFile(path.join(corpusDir, 'notes.md'), '# Notes\n\nA short note about gateways.\n');
    const router = new QueryRouter({
      knowledgeCorpus: [corpusDir],
      includePlatformKnowledge: false,
      embeddingProvider,
      embeddingModel,
      embeddingApiKey: 'test-key',
      embeddingBaseUrl: gateway,
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

    expect(seen).toContain('/v1/embeddings');
    expect(elsewhere).toEqual([]);
  });
});
