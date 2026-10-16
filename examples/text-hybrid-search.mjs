#!/usr/bin/env node
// Example: hybrid search: BM25 and vector search, fused by reciprocal rank fusion.
//
// HybridSearcher asks a vector store and a BM25 index for candidates and fuses the two
// rankings. Docs: docs/text/LEXICAL_AND_HYBRID_SEARCH.md.
//
// This script demonstrates:
//   - a short handbook cut into passages by SemanticChunker
//   - each passage written to an InMemoryVectorStore and a BM25Index under one id
//   - HybridSearcher with 'rrf' (the default), 'weighted-sum' and 'interleave'
//   - each result's fused score and its rank in the vector and BM25 lists
//   - reciprocalRankFusion() over two ranked lists of your own
//
// The embedder below is a stand-in, so the script runs with no API key: it hashes each
// word of a text into one of 256 buckets, and its vectors match words, not meanings. For
// real embeddings, pass an object whose generateEmbeddings({ texts }) answers
// { embeddings } from your provider, for example one that calls embedText() from
// '@framers/agentos'.
//
// Usage (no API key):
//   pnpm install && pnpm run build
//   node examples/text-hybrid-search.mjs

import { lexicalTokens } from '@framers/agentos/cognition/library';
import { reciprocalRankFusion } from '@framers/agentos/cognition/memory';
import { BM25Index, HybridSearcher, InMemoryVectorStore, SemanticChunker } from '@framers/agentos/cognition/rag';

const DIMENSIONS = 256;

/** The stand-in embedder: each word adds 1 to the bucket its hash selects. */
function embed(text) {
  const vector = new Array(DIMENSIONS).fill(0);
  for (const word of lexicalTokens(text)) {
    let hash = 0;
    for (const char of word) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
    vector[hash % DIMENSIONS] += 1;
  }
  return vector;
}

// HybridSearcher calls generateEmbeddings({ texts: [query] }) and reads embeddings[0].
const embeddings = {
  async generateEmbeddings({ texts }) {
    const list = Array.isArray(texts) ? texts : [texts];
    return { embeddings: list.map(embed), modelId: 'hashed-words', providerId: 'example', usage: { totalTokens: 0 } };
  },
};

const handbook = `# Refunds

A refund goes back to the card that paid. Refunds take five to ten business days to appear.

# Shipping

Orders ship within two business days. Tracking numbers arrive by email once the parcel leaves the warehouse.

# Accounts

Reset a password from the sign-in page. Passwords expire after ninety days.

# Security

Two-factor codes arrive by text message. Each code works once and expires after ten minutes.`;

// Each Markdown heading starts a chunk.
const passages = new SemanticChunker({ overlap: 0 }).chunk(handbook);
console.log(`\n${passages.length} passages: ${passages.map((passage) => passage.boundaryType).join(', ')}\n`);

const store = new InMemoryVectorStore();
await store.initialize({ id: 'handbook', type: 'in_memory' });
await store.createCollection('handbook', DIMENSIONS);

const documents = passages.map((passage) => ({ id: `handbook#${passage.index}`, text: passage.text.trim() }));
await store.upsert(
  'handbook',
  documents.map((doc) => ({ id: doc.id, embedding: embed(doc.text), textContent: doc.text })),
);
const bm25 = new BM25Index();
bm25.addDocuments(documents);

const query = 'when does my refund arrive';
console.log(`\nquery: ${query}`);

for (const fusionMethod of ['rrf', 'weighted-sum', 'interleave']) {
  const searcher = new HybridSearcher(store, embeddings, bm25, { fusionMethod });
  const results = await searcher.search(query, 'handbook', 3);
  console.log(`\n=== ${fusionMethod} ===\n`);
  for (const result of results) {
    // A result only BM25 found has no textContent: InMemoryVectorStore has no fetchByIds to fill it in.
    // 'weighted-sum' sets no ranks, and 'interleave' one rank for each result, from the list it came from.
    const heading = (result.textContent ?? '').split('\n')[0];
    console.log(
      `${result.id.padEnd(11)} score ${result.score.toFixed(4)}  vector rank ${result.denseRank ?? '-'}  ` +
        `BM25 rank ${result.sparseRank ?? '-'}  ${heading}`,
    );
  }
}

console.log('\n=== reciprocalRankFusion() over lists of your own ===\n');
console.log(
  reciprocalRankFusion(
    [{ id: 'a', rank: 1 }, { id: 'b', rank: 2 }],
    [{ id: 'b', rank: 1 }, { id: 'c', rank: 2 }],
  ),
);
