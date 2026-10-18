/**
 * @fileoverview RerankerService.rerankChain over the real CohereReranker and fetch, against a local server
 * that answers as Cohere's rerank API. Each case reads the model a stage asked for.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { RerankerService } from '../RerankerService';
import { CohereReranker } from '../providers/CohereReranker';
import type { RerankerServiceConfig } from '../IRerankerService';

/** The body of each rerank request the server received in the current case. */
const bodies: Array<{ model: string; query: string; documents: string[]; top_n: number }> = [];

let server: http.Server;
let origin: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/v1/rerank') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"message":"no such route"}');
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      bodies.push(body);
      // The documents in the order given, each scored a little lower than the one before.
      const results = body.documents.map((_: string, index: number) => ({ index, relevance_score: 1 - index / 10 }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: `rerank-${bodies.length}`, results, meta: { api_version: { version: '1' } } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  bodies.length = 0;
});

const chunks = [
  { id: 'refund', content: 'A refund takes five to ten business days.', relevanceScore: 0.4, heading: '', sourcePath: '', originalDocumentId: 'faq', metadata: {} },
  { id: 'ship', content: 'Orders ship within two days of payment.', relevanceScore: 0.3, heading: '', sourcePath: '', originalDocumentId: 'faq', metadata: {} },
];

function serviceWith(config: RerankerServiceConfig): RerankerService {
  const service = new RerankerService({ config });
  // The provider's own default model differs from every one the settings give.
  service.registerProvider(new CohereReranker({ providerId: 'cohere', apiKey: 'test-key', baseUrl: origin, defaultModelId: 'rerank-v3.5' }));
  return service;
}

describe('rerankChain with CohereReranker', () => {
  it("asks for the provider's defaultModelId from the settings for a stage without a model", async () => {
    const service = serviceWith({ providers: [{ providerId: 'cohere', defaultModelId: 'rerank-english-v3.0' }] });
    const reranked = await service.rerankChain('refund days', chunks, [{ provider: 'cohere', topK: 2 }]);
    expect(bodies.map((body) => body.model)).toEqual(['rerank-english-v3.0']);
    expect(reranked.map((chunk) => chunk.metadata?._rerankerChainStages)).toEqual(['cohere', 'cohere']);
  });

  it("asks for the service's defaultModelId when the provider's settings name none", async () => {
    const service = serviceWith({ providers: [{ providerId: 'cohere' }], defaultModelId: 'rerank-multilingual-v3.0' });
    await service.rerankChain('refund days', chunks, [{ provider: 'cohere', topK: 1 }]);
    expect(bodies.map((body) => [body.model, body.top_n])).toEqual([['rerank-multilingual-v3.0', 1]]);
  });

  it("asks for a stage's own model before any default", async () => {
    const service = serviceWith({ providers: [{ providerId: 'cohere', defaultModelId: 'rerank-english-v3.0' }] });
    await service.rerankChain('refund days', chunks, [{ provider: 'cohere', topK: 2, model: 'rerank-v3.5' }]);
    expect(bodies.map((body) => body.model)).toEqual(['rerank-v3.5']);
  });
});
