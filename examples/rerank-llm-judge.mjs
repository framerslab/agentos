#!/usr/bin/env node
// Example: reranking with an LLM as the judge (LlmJudgeReranker, provider id 'llm-judge').
//
// LlmJudgeReranker calls a function you give it, llmCallFn(system, user, model), and parses
// the text it answers. It names no model and calls no provider itself. Phase 1 sends one call
// per batch of 10 passages and asks for a 0-10 score each; phase 2 sends one call that orders
// the best 20. Each call carries the query and the first 200 characters of each passage.
// Docs: docs/text/RERANKING.md.
//
// This script demonstrates:
//   - LlmJudgeReranker registered with a RerankerService and picked per request by providerId
//   - rerankChunks() over retrieved chunks, with the metadata it records
//   - each llmCallFn call the judge makes, with the model it asks for
//
// With no environment variable set, llmCallFn is a stand-in written below: it counts the
// query's words in each passage, so the script runs with no API key and no network. Set
// RERANK_JUDGE_PROVIDER to a provider generateText() serves (gemini, openai, anthropic, groq,
// mistral, openrouter, ...) and that provider's key, and llmCallFn calls generateText() on the
// provider's cheap model from PROVIDER_DEFAULTS (for gemini, gemini-2.5-flash-lite), or on
// RERANK_JUDGE_MODEL when it is set.
//
// Usage (no API key):
//   pnpm install && pnpm run build
//   node examples/rerank-llm-judge.mjs
//
// Usage (a real model):
//   GEMINI_API_KEY=... RERANK_JUDGE_PROVIDER=gemini node examples/rerank-llm-judge.mjs

import { lexicalTokens } from '@framers/agentos/cognition/library';
import { LlmJudgeReranker, RerankerService } from '@framers/agentos/cognition/rag/reranking';

const provider = process.env.RERANK_JUDGE_PROVIDER;

/** The stand-in judge: scores and orders passages by how many of the query's words they hold. */
function standInJudge(system, user) {
  const query = /^Query: "(.*)"$/m.exec(user)?.[1] ?? '';
  const wanted = new Set(lexicalTokens(query));
  const passages = [...user.matchAll(/^\[([^\]]+)\] (.*)$/gm)].map(([, id, text]) => {
    const words = new Set(lexicalTokens(text));
    return { id, hits: [...wanted].filter((word) => words.has(word)).length };
  });
  if (system.startsWith('You are a relevance scorer')) {
    // Phase 1 numbers the passages [1], [2], ... and wants one integer 0-10 each, in order.
    return JSON.stringify(passages.map((p) => Math.round((10 * p.hits) / Math.max(1, wanted.size))));
  }
  // Phase 2 labels the passages with their ids and wants the ids, most relevant first.
  return JSON.stringify([...passages].sort((a, b) => b.hits - a.hits).map((p) => p.id));
}

let llmCallFn = async (system, user) => standInJudge(system, user);
let model;

if (provider) {
  const { generateText, PROVIDER_DEFAULTS } = await import('@framers/agentos');
  model = process.env.RERANK_JUDGE_MODEL ?? PROVIDER_DEFAULTS[provider]?.cheap;
  llmCallFn = async (system, prompt, callModel) => (await generateText({ provider, model: callModel, system, prompt })).text;
}

// Record each call the judge makes.
const calls = [];
const recordedCall = async (system, user, callModel) => {
  calls.push({ phase: system.startsWith('You are a relevance scorer') ? 'score' : 'rank', model: callModel });
  return llmCallFn(system, user, callModel);
};

const service = new RerankerService({
  config: { providers: [{ providerId: 'llm-judge' }], defaultProviderId: 'llm-judge' },
});
service.registerProvider(
  new LlmJudgeReranker({
    llmCallFn: recordedCall,
    // Passed to llmCallFn as its third argument; undefined (the stand-in's case) leaves the choice to llmCallFn.
    scoringModel: model,
    rankingModel: model,
  }),
);

// Chunks as a first search would hand them over, best vector score first.
const chunks = [
  { id: 'ship', originalDocumentId: 'handbook', content: 'Orders ship within two business days of payment.', relevanceScore: 0.82 },
  { id: 'reset', originalDocumentId: 'handbook', content: 'Reset a password from the sign-in page.', relevanceScore: 0.8 },
  { id: 'refund', originalDocumentId: 'handbook', content: 'A refund goes back to the card that paid and takes five to ten business days.', relevanceScore: 0.79 },
  { id: 'codes', originalDocumentId: 'handbook', content: 'Two-factor codes expire after ten minutes.', relevanceScore: 0.61 },
];

const query = 'how many days does a refund take';
console.log(`\nJudge: ${provider ? `${provider} through generateText(), model ${model ?? "the provider's default"}` : 'the stand-in (no API key)'}`);
console.log(`Query: ${query}\n`);

const reranked = await service.rerankChunks(query, chunks, { providerId: 'llm-judge', topN: 3 });
for (const chunk of reranked) {
  console.log(
    `${chunk.relevanceScore.toFixed(2)}  ${chunk.id.padEnd(6)}  was ${chunk.metadata._rerankerOriginalScore}  (${chunk.metadata._rerankerProviderId})`,
  );
}

console.log(`\n${calls.length} llmCallFn calls: ${calls.map((c) => `${c.phase}(${c.model ?? 'no model named'})`).join(', ')}`);
