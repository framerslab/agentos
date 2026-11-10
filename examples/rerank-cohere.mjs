#!/usr/bin/env node
// Example: reranking with Cohere's rerank API (CohereReranker, provider id 'cohere').
//
// Each rerank() is one POST to https://api.cohere.ai/v1/rerank (or the baseUrl you set) that
// carries the query and the full text of every document. Cohere bills it, and the response
// reports its billed search units.
// Docs: docs/text/RERANKING.md.
//
// This script demonstrates:
//   - CohereReranker registered with a RerankerService, the key read from COHERE_API_KEY
//   - the default model rerank-v3.5, or COHERE_RERANK_MODEL (one of COHERE_RERANKER_MODELS)
//   - rerank() with the diagnostics the provider returns
//
// Usage:
//   pnpm install && pnpm run build
//   COHERE_API_KEY=... node examples/rerank-cohere.mjs

import { COHERE_RERANKER_MODELS, CohereReranker, RerankerService } from '@framers/agentos/cognition/rag/reranking';

const apiKey = process.env.COHERE_API_KEY;
if (!apiKey) {
  console.log('Set COHERE_API_KEY to run this example. examples/rerank-local-cross-encoder.mjs and examples/rerank-llm-judge.mjs need no Cohere key.');
  process.exit(0);
}

const service = new RerankerService({
  config: {
    // The settings entry: the model and timeout the service asks for when a request names none.
    providers: [{ providerId: 'cohere', defaultModelId: process.env.COHERE_RERANK_MODEL, defaultTimeoutMs: 10_000 }],
    defaultProviderId: 'cohere',
  },
});
service.registerProvider(new CohereReranker({ providerId: 'cohere', apiKey }));

console.log(`\nModels this provider lists: ${COHERE_RERANKER_MODELS.join(', ')}`);

const { results, diagnostics } = await service.rerank(
  {
    query: 'how many days does a refund take',
    documents: [
      { id: 'ship', content: 'Orders ship within two business days of payment.', originalScore: 0.82 },
      { id: 'reset', content: 'Reset a password from the sign-in page.', originalScore: 0.8 },
      { id: 'refund', content: 'A refund goes back to the card that paid and takes five to ten business days.', originalScore: 0.79 },
      { id: 'codes', content: 'Two-factor codes expire after ten minutes.', originalScore: 0.61 },
    ],
  },
  { topN: 3 },
);

for (const doc of results) {
  console.log(`${doc.relevanceScore.toFixed(3)}  ${doc.id.padEnd(6)}  was ${doc.originalScore}`);
}
console.log(
  `\nModel ${diagnostics.modelId}, ${diagnostics.documentsProcessed} documents in ${diagnostics.latencyMs} ms, ` +
    `search units ${diagnostics.tokensUsed ?? 'not reported'}, request ${diagnostics.providerMetrics?.cohereRequestId}`,
);
