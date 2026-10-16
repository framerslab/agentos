#!/usr/bin/env node
// Example: keyword search with BM25: any or all words, prefixes, and an index saved as JSON.
//
// Docs: docs/text/LEXICAL_AND_HYBRID_SEARCH.md.
//
// This script demonstrates:
//   - BM25Index with its built-in tokenizer, searched with any word, every word and by prefix
//   - toJSON() and BM25Index.fromJSON(): the index saved as a string and restored
//   - BM25Index with createRagPipeline(), which stems, so "run" finds "running"
//   - LexicalIndex with lexicalTokens from the browser entry, which a page imports and
//     Node runs too, and a snippet around each hit
//
// Usage (no API key):
//   pnpm install && pnpm run build
//   node examples/text-search-bm25.mjs

import { createRagPipeline } from '@framers/agentos/cognition/nlp';
import { BM25Index } from '@framers/agentos/cognition/rag';
import { LexicalIndex, lexicalTokens, snippetAround } from '@framers/agentos/cognition/library/browser';

const docs = [
  { id: 'faq-1', text: 'Reset a password from the sign-in page.', metadata: { section: 'account' } },
  { id: 'faq-2', text: 'Passwords expire after ninety days.', metadata: { section: 'account' } },
  { id: 'faq-3', text: 'Two-factor codes arrive by text message.', metadata: { section: 'security' } },
  { id: 'faq-4', text: 'The developers are running a migration tonight.', metadata: { section: 'status' } },
  { id: 'faq-5', text: 'She runs the nightly backup at two.', metadata: { section: 'status' } },
];

function show(label, hits) {
  const list = hits.map((hit) => `${hit.id} (${hit.score.toFixed(3)})`).join(', ');
  console.log(`${label.padEnd(48)} ${list || 'no hits'}`);
}

console.log('\n=== BM25Index with its built-in tokenizer ===\n');
const index = new BM25Index();
index.addDocuments(docs);
console.log(index.getStats());
show("search('password reset')", index.search('password reset'));
show("search('pass', 10, { prefix: true })", index.search('pass', 10, { prefix: true }));
show("search('password expire', 10, { match: 'all' })", index.search('password expire', 10, { match: 'all' }));
show("  the same with prefix: true", index.search('password expire', 10, { match: 'all', prefix: true }));
show("search('run'): the built-in tokenizer does not stem", index.search('run'));

console.log('\n=== saved as JSON and restored ===\n');
const saved = JSON.stringify(index.toJSON());
console.log(`saved index: ${saved.length} characters`);
const restored = BM25Index.fromJSON(JSON.parse(saved));
show("restored.search('password reset')", restored.search('password reset'));
console.log("restored.removeDocument('faq-1'):", restored.removeDocument('faq-1'));
show("restored.search('password reset')", restored.search('password reset'));

console.log('\n=== BM25Index with createRagPipeline(), which stems ===\n');
const stemmed = new BM25Index({ pipeline: createRagPipeline() });
stemmed.addDocuments(docs);
show("search('run')", stemmed.search('run'));
show("search('password')", stemmed.search('password'));

console.log('\n=== LexicalIndex with lexicalTokens, and a snippet for each hit ===\n');
const lexical = new LexicalIndex({ tokenize: lexicalTokens });
lexical.addDocuments(docs);
const query = 'nightly back';
for (const hit of lexical.search(query, 5, { prefix: true })) {
  // The index keeps no text: the caller keeps the passages and places the snippet.
  const text = docs.find((doc) => doc.id === hit.id).text;
  const snippet = snippetAround(text, lexicalTokens(query), { before: 20, after: 40 });
  console.log(`${hit.id} ${hit.score.toFixed(3)} [${hit.metadata.section}] at ${snippet.at}: ${snippet.text}`);
}
const restoredLexical = LexicalIndex.fromJSON(JSON.parse(JSON.stringify(lexical.toJSON())), {
  tokenize: lexicalTokens,
});
console.log('restored LexicalIndex:', restoredLexical.getStats());
