#!/usr/bin/env node
// Example: reranking with a local cross-encoder (LocalCrossEncoderReranker, provider id 'local').
//
// The cross-encoder runs in this process through Transformers.js: `@huggingface/transformers`,
// an optional dependency of the package, else `@xenova/transformers`. Scoring sends nothing
// over the network. The first run downloads the model from Hugging Face Hub into Transformers.js's
// cache (or RERANK_LOCAL_CACHE_DIR), and later runs read it from there.
// Docs: docs/text/RERANKING.md.
//
// This script demonstrates:
//   - isAvailable(), which answers whether Transformers.js can be imported
//   - LocalCrossEncoderReranker registered with a RerankerService, default model
//     cross-encoder/ms-marco-MiniLM-L6-v2, or RERANK_LOCAL_MODEL (one of LOCAL_RERANKER_MODELS)
//   - rerank() with the diagnostics the provider returns
//
// Usage (no API key; the first run needs the network once, for the model):
//   pnpm install && pnpm run build
//   node examples/rerank-local-cross-encoder.mjs

import { LOCAL_RERANKER_MODELS, LocalCrossEncoderReranker, RerankerService } from '@framers/agentos/cognition/rag/reranking';

const local = new LocalCrossEncoderReranker({
  providerId: 'local',
  defaultModelId: process.env.RERANK_LOCAL_MODEL, // undefined: cross-encoder/ms-marco-MiniLM-L6-v2
  cacheDir: process.env.RERANK_LOCAL_CACHE_DIR,
});

if (!(await local.isAvailable())) {
  console.log('Transformers.js is not installed. Install it with: pnpm add @huggingface/transformers');
  process.exit(0);
}

const service = new RerankerService({ config: { providers: [{ providerId: 'local' }], defaultProviderId: 'local' } });
service.registerProvider(local);

console.log(`\nModels this provider lists: ${LOCAL_RERANKER_MODELS.join(', ')}`);

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
console.log(`\nModel ${diagnostics.modelId}, ${diagnostics.documentsProcessed} documents in ${diagnostics.latencyMs} ms (the first run includes loading the model)`);

await local.dispose();
