/**
 * Citation Verification Example
 *
 * Demonstrates how to verify claims in text against sources
 * using cosine similarity with the CitationVerifier.
 *
 * Run: node examples/citation-verification.mjs
 * Needs no API key: the embedding function below is a mock. Pass a real
 * one (for example a wrapper around embedText()) for meaningful scores.
 */

import { CitationVerifier, formatVerifiedResponse } from '@framers/agentos';

// --- Mock embedding function (replace with real embeddings in production) ---
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

// --- Create verifier ---
const verifier = new CitationVerifier({
  embedFn: mockEmbed,
  supportThreshold: 0.6,     // cosine >= 0.6 = supported
  unverifiableThreshold: 0.3, // cosine < 0.3 = unverifiable
});

const sources = [
  {
    content: 'Tokyo is the capital and seat of government of Japan.',
    title: 'Japan Overview',
    url: 'https://example.com/japan',
  },
  {
    content: 'The population of Tokyo proper is approximately 14 million.',
    title: 'Tokyo Demographics',
    url: 'https://example.com/tokyo',
  },
];

// --- Pattern A: pass raw text, let the verifier decompose ---
// Use this shape when the input is one block of LLM-generated prose.
// The built-in sentence splitter (or a configured `extractClaims`
// callback) breaks the text into atomic claims before scoring.
const result = await verifier.verify(
  'Tokyo is the capital of Japan. ' +
  'Tokyo proper has roughly 14 million residents. ' +
  'Tokyo hosted the 2020 Summer Olympics in 1457.',
  sources,
);

// --- Pattern B: pass a pre-decomposed claim array ---
// Use this shape when you already broke the prose into structured
// claims yourself — your own parser, an NER step, a curated subset,
// a user-edited list. The verifier preserves caller-provided order
// in result.claims.
//
// const claims = [
//   'Tokyo is the capital of Japan.',
//   'Tokyo proper has roughly 14 million residents.',
//   'Tokyo hosted the 2020 Summer Olympics in 1457.',
// ];
// const result = await verifier.verify(claims, sources);

// --- Or extract first, filter, then verify ---
// extractClaims() exposes the same decomposition Pattern A uses
// internally, so you can inspect or filter before scoring:
//
// const claims = await verifier.extractClaims(llmText);
// const filtered = claims.filter((c) => c.length > 20);
// const result = await verifier.verify(filtered, sources);

// --- Print results ---
console.log('=== Citation Verification Results ===\n');
console.log(`Summary: ${formatVerifiedResponse(result)}`);
console.log(`Overall grounded: ${result.overallGrounded}`);
console.log(`Supported: ${result.supportedCount}/${result.totalClaims}`);
console.log(`Weak: ${result.weakCount}/${result.totalClaims}`);
console.log(`Unverifiable: ${result.unverifiableCount}/${result.totalClaims}`);
console.log();

for (const claim of result.claims) {
  const icon =
    claim.verdict === 'supported' ? '✓' :
    claim.verdict === 'weak' ? '~' :
    claim.verdict === 'contradicted' ? '✗' : '?';
  console.log(`  ${icon} [${claim.verdict}] (${(claim.confidence * 100).toFixed(0)}%) ${claim.text}`);
  if (claim.sourceSnippet) {
    console.log(`    └─ Source: ${claim.sourceSnippet.slice(0, 80)}...`);
  }
}
