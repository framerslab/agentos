#!/usr/bin/env node
// Example: agent({ verifyCitations }) — citation verification on generate().
//
// Configure the agent with an embedder + a retriever, and every call to
// agent.generate() returns its response with a `grounding` field
// containing per-claim verdicts. No separate verifier.verify(text, sources)
// step required. The sources are fetched after the model answers and are
// used only to score the answer; they are not added to the prompt.
//
// Usage:
//   export OPENAI_API_KEY="sk-..."   # the model call is real; the embedder and retriever are mocks
//   node examples/citation-verification-agent.mjs

import { agent, formatVerifiedResponse } from '../dist/index.js';

// --- Mock embedder + retriever for the example ---
function mockEmbed(texts) {
  return Promise.resolve(
    texts.map((t) => {
      const vec = new Array(64).fill(0);
      for (let i = 0; i < t.length; i++) vec[i % 64] += t.charCodeAt(i) / 1000;
      const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
      return mag > 0 ? vec.map((v) => v / mag) : vec;
    }),
  );
}

const FACTS = [
  { content: 'Tokyo is the capital and seat of government of Japan.', url: 'https://example.com/japan' },
  { content: 'The population of Tokyo proper is approximately 14 million.', url: 'https://example.com/tokyo' },
];

async function mockRetrieve(query) {
  // In a real flow you'd hit your vector store or RAG pipeline here.
  return FACTS;
}

// --- Build an agent with citation verification wired in ---
const docsAgent = agent({
  provider: process.env.AGENTOS_PROVIDER || 'openai',
  verifyCitations: {
    embedFn: mockEmbed,
    retrieve: mockRetrieve,
    supportThreshold: 0.6,
    unverifiableThreshold: 0.3,
  },
});

// --- Generate and inspect the grounding result ---
const result = await docsAgent.generate('Tell me about Tokyo.');

console.log('=== Generated text ===');
console.log(result.text);
console.log();

if (result.grounding) {
  console.log('=== Grounding ===');
  console.log(formatVerifiedResponse(result.grounding));
  console.log(`overallGrounded: ${result.grounding.overallGrounded}`);
  for (const claim of result.grounding.claims) {
    const icon =
      claim.verdict === 'supported' ? '✓' :
      claim.verdict === 'weak' ? '~' :
      claim.verdict === 'contradicted' ? '✗' : '?';
    console.log(`  ${icon} [${claim.verdict}] (${(claim.confidence * 100).toFixed(0)}%) ${claim.text}`);
  }
}
